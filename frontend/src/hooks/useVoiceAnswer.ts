import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceCapture, voiceCaptureSupported, VOICE_CHUNK_MS, type VoiceCapture } from "../features/chat/voiceCapture";
import type { VoiceInputService, VoiceInputSession, VoiceTranscript } from "../features/chat/voiceInput";

type VoiceStatus = "idle" | "preparing" | "starting" | "listening" | "finishing";
const MAX_RECORDING_MS = 10 * 60_000;
const MAX_QUEUED_AUDIO_MS = 8000;
const MAX_PREPARING_AUDIO_MS = 60_000;
const FINISH_TIMEOUT_MS = 25_000;

export function useVoiceAnswer(onFinalTranscript: (update: VoiceTranscript) => void, service?: VoiceInputService, onAudioLevel?: (level: number) => void) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState("");
  const sessionRef = useRef<{ cancel: () => void; finish: () => Promise<boolean> } | null>(null);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  onFinalTranscriptRef.current = onFinalTranscript;
  const onAudioLevelRef = useRef(onAudioLevel);
  onAudioLevelRef.current = onAudioLevel;
  const serviceRef = useRef(service);
  serviceRef.current = service;

  useEffect(() => () => { sessionRef.current?.cancel(); }, []);

  const startListening = useCallback(async () => {
    if (sessionRef.current) return;
    setError("");
    onAudioLevelRef.current?.(0);
    if (window.isSecureContext === false) {
      setError("麦克风需要安全连接，请通过 HTTPS 或本机 localhost 地址打开团团。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !voiceCaptureSupported()) {
      setError("当前浏览器不支持录音。请使用支持麦克风录音的浏览器，或点击输入框使用系统听写。");
      return;
    }
    const currentService = serviceRef.current;
    if (!currentService) {
      setError("离线语音服务尚未连接，请刷新页面后重试。");
      return;
    }

    const controller = new AbortController();
    let capture: VoiceCapture | undefined;
    let inputSession: VoiceInputSession | undefined;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending: Blob[] = [];
    let draining: Promise<void> | undefined;
    let finishing: Promise<boolean> | undefined;
    let releaseReady!: () => void;
    const ready = new Promise<void>(resolve => { releaseReady = resolve; });
    let preparationBacklog = 0;
    const releaseMic = () => {
      stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      stream = undefined;
    };
    const cancel = () => {
      controller.abort();
      clearTimeout(timer);
      pending.length = 0;
      preparationBacklog = 0;
      capture?.close();
      void inputSession?.close();
      releaseMic();
      releaseReady();
      onAudioLevelRef.current?.(0);
      sessionRef.current = null;
    };
    const fail = (message: string) => {
      if (controller.signal.aborted) return;
      cancel();
      setStatus("idle");
      setError(message);
    };
    const deliver = (updates: VoiceTranscript[]) => {
      for (const update of updates) {
        if (controller.signal.aborted) return;
        onFinalTranscriptRef.current(update);
      }
    };
    const drain = () => {
      const session = inputSession;
      if (!session || !pending.length || controller.signal.aborted) return draining;
      if (!draining) {
        draining = (async () => {
          try {
            while (pending.length && !controller.signal.aborted) {
              const audio = pending.shift()!;
              if (preparationBacklog > 0) preparationBacklog -= 1;
              deliver(await session.accept(audio, controller.signal));
            }
          } catch (reason) {
            fail(reason instanceof Error ? reason.message : "离线识别未能完成，请重试。");
          }
        })().finally(() => {
          draining = undefined;
          void drain();
        });
      }
      return draining;
    };
    const finish = () => {
      if (finishing) return finishing;
      if (!stream) {
        // Permission may still be pending. No audio has been captured yet.
        cancel();
        setStatus("idle");
        return Promise.resolve(true);
      }
      setStatus("finishing");
      clearTimeout(timer);
      releaseMic();
      timer = setTimeout(() => fail("语音收尾超时，已显示的文字已保留。请检查后继续。"), FINISH_TIMEOUT_MS);
      finishing = (async () => {
        try {
          await capture?.finish();
          await ready;
          const session = inputSession;
          if (!session || controller.signal.aborted) return false;
          while (!controller.signal.aborted && (draining || pending.length)) await drain();
          if (controller.signal.aborted) return false;
          deliver(await session.finish(controller.signal));
          if (controller.signal.aborted) return false;
          cancel();
          setStatus("idle");
          return true;
        } catch (reason) {
          fail(reason instanceof Error ? reason.message : "语音收尾失败，已显示的文字已保留。");
          return false;
        }
      })();
      return finishing;
    };
    sessionRef.current = { cancel, finish };
    setStatus("preparing");
    try {
      capture = createVoiceCapture(audio => {
        if (controller.signal.aborted) return;
        if ((pending.length - preparationBacklog) * VOICE_CHUNK_MS >= (inputSession ? MAX_QUEUED_AUDIO_MS : MAX_PREPARING_AUDIO_MS)) {
          fail(inputSession ? "当前设备处理语音较慢，已暂停以避免文字持续延迟。已显示的文字已保留，请稍后重试。" : "语音模型准备时间较长，已停止录音。模型准备完成后请重新打开语音。");
          return;
        }
        pending.push(audio);
        void drain();
      }, fail, level => {
        if (!controller.signal.aborted) onAudioLevelRef.current?.(level);
      });
      // Capture immediately so model loading cannot discard the first words.
      // Attach rejection handling now, including while permission is pending.
      const preparation = currentService.prepare(controller.signal).catch(reason => {
        fail(reason instanceof Error ? reason.message : "语音模型准备失败，请重试。");
      });
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (controller.signal.aborted) { releaseMic(); return; }
      for (const track of stream.getTracks()) track.onended = () => fail("麦克风已断开，请重新打开语音输入。");
      await capture.start(stream);
      if (controller.signal.aborted) return;
      if (!finishing) timer = setTimeout(() => fail("已完成 10 分钟连续语音输入，文字已保留。点击语音可以继续。"), MAX_RECORDING_MS);
      await preparation;
      if (controller.signal.aborted) return;
      if (!finishing) setStatus("starting");
      // Create the short-idle server session after permission and preparation.
      inputSession = await currentService.open(controller.signal);
      if (controller.signal.aborted) { void inputSession.close(); return; }
      preparationBacklog = pending.length;
      releaseReady();
      void drain();
      if (controller.signal.aborted) return;
      if (!finishing) setStatus("listening");
    } catch (reason) {
      if (reason instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(reason.name)) {
        fail("无法使用麦克风。请在浏览器和系统设置中允许麦克风权限后重试。");
      } else if (reason instanceof DOMException && ["NotFoundError", "NotReadableError"].includes(reason.name)) {
        fail("无法获取麦克风声音，请检查麦克风是否已连接或被占用。");
      } else {
        fail(reason instanceof Error ? reason.message : "无法启动录音，请重试。");
      }
    }
  }, []);

  const cancelListening = useCallback(() => {
    sessionRef.current?.cancel();
    setStatus("idle");
    setError("");
  }, []);

  const finishListening = useCallback(() => sessionRef.current?.finish() ?? Promise.resolve(true), []);

  return { status, listening: status !== "idle", error, startListening, stopListening: cancelListening, cancelListening, finishListening };
}
