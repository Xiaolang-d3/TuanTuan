import type { createApiClient } from "../../api/client";

export type VoiceTranscript = { segmentId: number; revision: number; text: string; final: boolean };
export type VoiceInputSession = {
  accept: (audio: Blob, signal: AbortSignal) => Promise<VoiceTranscript[]>;
  finish: (signal: AbortSignal) => Promise<VoiceTranscript[]>;
  close: () => Promise<void>;
};
export type VoiceInputService = {
  prepare: (signal: AbortSignal, onProgress?: (progress: number) => void) => Promise<void>;
  open: (signal: AbortSignal) => Promise<VoiceInputSession>;
};

type SpeechStatus = { state: "idle" | "preparing" | "ready" | "error"; error: string; progress?: number };

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createVoiceInputService(client: ReturnType<typeof createApiClient>): VoiceInputService {
  return {
    async prepare(signal, onProgress) {
      let status = await client<SpeechStatus>("/speech/prepare", { method: "POST", signal });
      onProgress?.(status.progress ?? 0);
      const deadline = Date.now() + 30 * 60_000;
      while (status.state === "preparing" && Date.now() < deadline) {
        await pause(signal);
        status = await client<SpeechStatus>("/speech/status", { signal });
        if (!signal.aborted) onProgress?.(status.progress ?? 0);
      }
      if (status.state !== "ready") throw new Error(status.error || "语音模型仍在准备，请稍后再次点击语音按钮。");
    },
    async open(signal) {
      const { id } = await client<{ id: string }>("/speech/sessions", { method: "POST", signal });
      let sequence = 0;
      let closed = false;
      const session: VoiceInputSession = {
        async accept(audio, audioSignal) {
          if (closed || audioSignal.aborted) throw new DOMException("Aborted", "AbortError");
          const body = new FormData();
          body.append("file", audio, "dictation.wav");
          const result = await client<{ updates: VoiceTranscript[] }>(`/speech/sessions/${id}/audio?sequence=${sequence}`, { method: "POST", body, signal: audioSignal }, 10_000);
          sequence += 1;
          return result.updates;
        },
        async finish(finishSignal) {
          if (closed || finishSignal.aborted) throw new DOMException("Aborted", "AbortError");
          const result = await client<{ updates: VoiceTranscript[] }>(`/speech/sessions/${id}/finish?sequence=${sequence}`, { method: "POST", signal: finishSignal }, 10_000);
          closed = true;
          return result.updates;
        },
        async close() {
          if (closed) return;
          closed = true;
          // The audio controller is already aborted when the user closes.
          await client(`/speech/sessions/${id}`, { method: "DELETE" }, 3000).catch(() => undefined);
        },
      };
      if (signal.aborted) { await session.close(); throw new DOMException("Aborted", "AbortError"); }
      return session;
    },
  };
}
