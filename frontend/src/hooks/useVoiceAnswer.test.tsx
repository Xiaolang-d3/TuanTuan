import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceAnswer } from "./useVoiceAnswer";

const audio = vi.hoisted(() => ({ supported: vi.fn(), create: vi.fn() }));
vi.mock("../features/chat/voiceCapture", () => ({ voiceCaptureSupported: audio.supported, createVoiceCapture: audio.create, VOICE_CHUNK_MS: 400 }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function segment() { return new Blob(["PCM audio"], { type: "audio/wav" }); }

describe("continuous offline voice input", () => {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn();
  const inputSession = { accept: vi.fn(), finish: vi.fn(), close: vi.fn() };
  const service = { prepare: vi.fn(), open: vi.fn() };
  const capture = { start: vi.fn(), finish: vi.fn(), close: vi.fn() };
  let emit: (blob: Blob) => void;
  let emitLevel: (level: number) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    service.prepare.mockResolvedValue(undefined);
    service.open.mockResolvedValue(inputSession);
    inputSession.close.mockResolvedValue(undefined);
    inputSession.finish.mockResolvedValue([]);
    inputSession.accept.mockResolvedValue([{ segmentId: 0, revision: 1, text: "离线识别内容", final: false }]);
    getUserMedia.mockResolvedValue(stream);
    capture.start.mockResolvedValue(undefined);
    capture.finish.mockResolvedValue(undefined);
    audio.supported.mockReturnValue(true);
    audio.create.mockImplementation((onSegment, _onError, onLevel) => { emit = onSegment; emitLevel = onLevel; return capture; });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("transcribes automatically while the microphone remains open, then stops immediately", async () => {
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceAnswer(onText, service));
    await act(async () => { await result.current.startListening(); await result.current.startListening(); });
    expect(audio.create).toHaveBeenCalledTimes(1);
    await act(async () => emit(segment()));
    expect(onText).toHaveBeenCalledExactlyOnceWith({ segmentId: 0, revision: 1, text: "离线识别内容", final: false });
    expect(result.current.status).toBe("listening");
    expect(track.stop).not.toHaveBeenCalled();
    act(() => result.current.stopListening());
    expect(result.current.status).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
    expect(capture.close).toHaveBeenCalled();
    await act(async () => emit(segment()));
    expect(inputSession.accept).toHaveBeenCalledTimes(1);
  });

  it("forwards live microphone levels without rendering again and ignores levels after stopping", async () => {
    const onLevel = vi.fn();
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useVoiceAnswer(vi.fn(), service, onLevel); });
    await act(async () => { await result.current.startListening(); });
    const before = renders;
    act(() => { emitLevel(0.2); emitLevel(0.8); });
    expect(onLevel.mock.lastCall).toEqual([0.8]);
    expect(renders).toBe(before);
    act(() => result.current.stopListening());
    expect(onLevel.mock.lastCall).toEqual([0]);
    const calls = onLevel.mock.calls.length;
    act(() => emitLevel(1));
    expect(onLevel).toHaveBeenCalledTimes(calls);
  });

  it("processes segments in order without parallel requests or losing queued speech", async () => {
    const first = deferred<import("../features/chat/voiceInput").VoiceTranscript[]>();
    const second = deferred<import("../features/chat/voiceInput").VoiceTranscript[]>();
    inputSession.accept.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceAnswer(onText, service));
    await act(async () => { await result.current.startListening(); });
    act(() => { emit(segment()); emit(segment()); });
    expect(inputSession.accept).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve([{ segmentId: 0, revision: 1, text: "第一句", final: false }]));
    expect(inputSession.accept).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve([{ segmentId: 0, revision: 2, text: "第一句，第二句。", final: true }]));
    expect(onText.mock.calls.map(([update]) => update.text)).toEqual(["第一句", "第一句，第二句。"]);
    expect(result.current.listening).toBe(true);
  });

  it("stops the microphone, drains queued and buffered audio, and returns the final transcript", async () => {
    const first = deferred<import("../features/chat/voiceInput").VoiceTranscript[]>();
    const preview = { segmentId: 0, revision: 1, text: "语音", final: false };
    const final = { segmentId: 0, revision: 2, text: "语音尾句。", final: true };
    inputSession.accept.mockReturnValueOnce(first.promise).mockResolvedValue([]);
    capture.finish.mockImplementationOnce(async () => { emit(segment()); });
    inputSession.finish.mockResolvedValueOnce([final]);
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceAnswer(onText, service));
    await act(async () => { await result.current.startListening(); emit(segment()); });
    let finishing!: Promise<boolean>;
    act(() => { finishing = result.current.finishListening(); });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("finishing");
    expect(inputSession.finish).not.toHaveBeenCalled();
    await act(async () => { first.resolve([preview]); await expect(finishing).resolves.toBe(true); });
    expect(inputSession.accept).toHaveBeenCalledTimes(2);
    expect(inputSession.finish).toHaveBeenCalledOnce();
    expect(onText.mock.calls).toEqual([[preview], [final]]);
    expect(result.current.status).toBe("idle");
  });

  it("captures during preparation and releases the microphone when cancelled", async () => {
    const pending = deferred<void>();
    service.prepare.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    let start!: Promise<void>;
    await act(async () => { start = result.current.startListening(); });
    expect(result.current.status).toBe("preparing");
    expect(capture.start).toHaveBeenCalled();
    act(() => result.current.stopListening());
    await act(async () => { pending.resolve(); await start; });
    expect(track.stop).toHaveBeenCalled();
    expect(capture.close).toHaveBeenCalled();
  });

  it("keeps the first audio during model preparation and transcribes it in order when ready", async () => {
    const pending = deferred<void>();
    service.prepare.mockReturnValueOnce(pending.promise);
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceAnswer(onText, service));
    let start!: Promise<void>;
    await act(async () => { start = result.current.startListening(); });
    act(() => { emit(segment()); emit(segment()); });
    expect(inputSession.accept).not.toHaveBeenCalled();
    expect(capture.start).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(); await start; });
    expect(inputSession.accept).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenCalledTimes(2);
  });

  it("drains prepared audio without treating it as a live backlog, while still bounding newly queued audio", async () => {
    const pending = deferred<void>();
    service.prepare.mockReturnValueOnce(pending.promise);
    inputSession.accept.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    let start!: Promise<void>;
    await act(async () => { start = result.current.startListening(); });
    act(() => { for (let i=0; i<30; i+=1) emit(segment()); });
    await act(async () => { pending.resolve(); await start; });
    act(() => emit(segment()));
    expect(result.current.status).toBe("listening");
    act(() => { for (let i=0; i<20; i+=1) emit(segment()); });
    expect(result.current.status).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
  });

  it("bounds audio buffered during preparation and ignores a late ready response", async () => {
    const pending = deferred<void>();
    service.prepare.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    let start!: Promise<void>;
    await act(async () => { start = result.current.startListening(); });
    act(() => { for (let i=0; i<151; i+=1) emit(segment()); });
    expect(result.current.status).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
    await act(async () => { pending.resolve(); await start; });
    expect(service.open).not.toHaveBeenCalled();
    expect(inputSession.accept).not.toHaveBeenCalled();
  });

  it("stops a late microphone stream after cancellation", async () => {
    const pending = deferred<typeof stream>();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    let start!: Promise<void>;
    await act(async () => { start = result.current.startListening(); });
    act(() => result.current.cancelListening());
    await act(async () => { pending.resolve(stream); await start; });
    expect(track.stop).toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    expect(service.open).not.toHaveBeenCalled();
  });

  it.each(["stop", "unmount"])("discards pending and queued transcripts after %s", async action => {
    const pending = deferred<import("../features/chat/voiceInput").VoiceTranscript[]>();
    inputSession.accept.mockReturnValueOnce(pending.promise);
    const onText = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceAnswer(onText, service));
    await act(async () => { await result.current.startListening(); emit(segment()); emit(segment()); });
    if (action === "stop") act(() => result.current.stopListening());
    else unmount();
    expect(inputSession.accept.mock.calls[0][1].aborted).toBe(true);
    await act(async () => pending.resolve([{ segmentId: 0, revision: 1, text: "迟到的文字", final: true }]));
    expect(onText).not.toHaveBeenCalled();
    expect(inputSession.accept).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it("ignores quiet segments and keeps listening", async () => {
    inputSession.accept.mockResolvedValueOnce([]).mockResolvedValueOnce([{ segmentId: 1, revision: 1, text: "下一句", final: false }]);
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceAnswer(onText, service));
    await act(async () => { await result.current.startListening(); emit(segment()); });
    expect(result.current.error).toBe("");
    await act(async () => emit(segment()));
    expect(onText).toHaveBeenCalledExactlyOnceWith({ segmentId: 1, revision: 1, text: "下一句", final: false });
    expect(result.current.listening).toBe(true);
  });

  it("stops an overloaded queue instead of silently building unlimited delay", async () => {
    inputSession.accept.mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    await act(async () => { await result.current.startListening(); });
    act(() => { for (let index = 0; index < 22; index += 1) emit(segment()); });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toContain("处理语音较慢");
    expect(track.stop).toHaveBeenCalled();
    expect(inputSession.close).toHaveBeenCalled();
  });

  it("reports permission denial and allows retry", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    await act(async () => { await result.current.startListening(); });
    expect(result.current.error).toContain("麦克风权限");
    await act(async () => { await result.current.startListening(); });
    expect(result.current.status).toBe("listening");
    expect(result.current.error).toBe("");
  });

  it("surfaces preparation and capture failures with microphone cleanup", async () => {
    service.prepare.mockRejectedValueOnce(new Error("模型下载失败"));
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    await act(async () => { await result.current.startListening(); });
    expect(result.current.error).toBe("模型下载失败");
    expect(track.stop).toHaveBeenCalled();
    capture.start.mockRejectedValueOnce(new Error("音频采集失败"));
    await act(async () => { await result.current.startListening(); });
    expect(result.current.error).toBe("音频采集失败");
    expect(track.stop).toHaveBeenCalled();
  });

  it("ends a long session with an explanation instead of silently cutting off", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    await act(async () => { await result.current.startListening(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(inputSession.accept).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toContain("10 分钟");
  });

  it("explains unsupported or insecure browser environments", async () => {
    audio.supported.mockReturnValue(false);
    const { result } = renderHook(() => useVoiceAnswer(vi.fn(), service));
    await act(async () => { await result.current.startListening(); });
    expect(result.current.error).toContain("不支持录音");
    vi.stubGlobal("isSecureContext", false);
    await act(async () => { await result.current.startListening(); });
    expect(result.current.error).toContain("HTTPS");
  });
});
