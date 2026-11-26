import { afterEach, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import { createVoiceInputService } from "./voiceInput";

function setup() {
  const client = vi.fn();
  return { client, service: createVoiceInputService(client as ReturnType<typeof createApiClient>) };
}

afterEach(() => vi.useRealTimers());

it("prepares and polls the model without uploading audio", async () => {
  vi.useFakeTimers();
  const { client, service } = setup();
  client.mockResolvedValueOnce({ state: "preparing" }).mockResolvedValueOnce({ state: "ready" });
  const signal = new AbortController().signal;
  const ready = service.prepare(signal);
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  expect(client.mock.calls.map(([path]) => path)).toEqual(["/speech/prepare", "/speech/status"]);
  expect(client.mock.calls[0][1]).toMatchObject({ method: "POST", signal });
});

it("cancels polling and propagates model errors", async () => {
  vi.useFakeTimers();
  const { client, service } = setup();
  client.mockResolvedValue({ state: "preparing" });
  const controller = new AbortController();
  const ready = service.prepare(controller.signal);
  const rejected = expect(ready).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(client).toHaveBeenCalledTimes(1);
  client.mockResolvedValue({ state: "error", error: "模型准备失败" });
  await expect(service.prepare(new AbortController().signal)).rejects.toThrow("模型准备失败");
});

it("keeps ordered chunks in one authenticated session and closes independently of cancellation", async () => {
  const { client, service } = setup();
  const updates = [{ segmentId: 0, revision: 1, text: "离线识别结果", final: false }];
  client.mockResolvedValueOnce({ id: "session-1" }).mockResolvedValue({ updates });
  const controller = new AbortController();
  const session = await service.open(controller.signal);
  expect(await session.accept(new Blob(["audio"], { type: "audio/wav" }), controller.signal)).toEqual(updates);
  await session.accept(new Blob(["audio"], { type: "audio/wav" }), controller.signal);
  const [path, options, timeout] = client.mock.calls[1];
  expect(path).toBe("/speech/sessions/session-1/audio?sequence=0");
  expect(client.mock.calls[2][0]).toBe("/speech/sessions/session-1/audio?sequence=1");
  expect(options.signal).toBe(controller.signal);
  expect(timeout).toBe(10_000);
  expect(options.body.get("file").name).toBe("dictation.wav");
  controller.abort();
  await session.close();
  await session.close();
  expect(client).toHaveBeenCalledTimes(4);
  expect(client.mock.calls[3]).toEqual(["/speech/sessions/session-1", { method: "DELETE" }, 3000]);
  await expect(session.accept(new Blob(), new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("releases a session created while its start request was being cancelled", async () => {
  const { client, service } = setup();
  const controller = new AbortController();
  client.mockImplementationOnce(async () => { controller.abort(); return { id: "late" }; }).mockResolvedValue(undefined);
  await expect(service.open(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(client.mock.calls[1][0]).toBe("/speech/sessions/late");
});

it("finalizes at the next audio sequence and uses the returned transcript", async () => {
  const { client, service } = setup();
  const updates = [{ segmentId: 0, revision: 2, text: "语音尾句。", final: true }];
  client.mockResolvedValueOnce({ id: "session-1" }).mockResolvedValueOnce({ updates: [] }).mockResolvedValueOnce({ updates });
  const signal = new AbortController().signal;
  const session = await service.open(signal);
  await session.accept(new Blob(["audio"]), signal);
  await expect(session.finish(signal)).resolves.toEqual(updates);
  await session.close();
  expect(client.mock.calls[2]).toEqual(["/speech/sessions/session-1/finish?sequence=1", { method: "POST", signal }, 10_000]);
  expect(client).toHaveBeenCalledTimes(3);
});
