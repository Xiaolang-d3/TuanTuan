import { afterEach, expect, it, vi } from 'vitest';
import { createApiClient } from './client';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete (window as Window & { __TAURI__?: unknown }).__TAURI__; });

it('keeps authenticated notifications alive beyond 30 seconds and decodes split UTF-8 frames', async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  let authorization = '';
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signal = init.signal;
    authorization = new Headers(init.headers).get('Authorization')!;
    signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }));
  const controller = new AbortController();
  const seen: unknown[] = [];
  const api = createApiClient('http://local', 'private-token');
  const pending = api.events!('/channels/weixin/events', controller.signal, (event, data) => seen.push([event, data]));
  const finished = pending.catch(reason => reason);
  await vi.advanceTimersByTimeAsync(20_000);
  stream.enqueue(new TextEncoder().encode(': heartbeat\r\n\r\n'));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signal.aborted).toBe(false);
  const bytes = new TextEncoder().encode('event: weixin-status\r\ndata: {"error":"微信"}\r\n\r\n');
  for (const byte of bytes) stream.enqueue(new Uint8Array([byte]));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([['weixin-status', { error: '微信' }]]);
  expect(authorization).toBe('Bearer private-token');
  controller.abort();
  await finished;
  expect(signal.aborted).toBe(true);
});

it('aborts a notification stream that stops sending heartbeats', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }));
  const api = createApiClient('http://local', 'token');
  const pending = api.events!('/channels/weixin/events', new AbortController().signal, () => {});
  const assertion = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(45_001);
  expect(signal.aborted).toBe(true);
  await assertion;
});

it('uses the desktop persistent stream mode and cancels its native request on logout', async () => {
  let emit!: (payload: Record<string, unknown>) => void;
  let persistent = false;
  let cancelled = false;
  let unlistened = false;
  const listen = async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    emit = payload => handler({ payload });
    return () => { unlistened = true; };
  };
  const invoke = async (command: string, args: { request?: { requestId: string; persistentStream: boolean } }) => {
    if (command === 'desktop_cancel_api_request') { cancelled = true; return; }
    persistent = !!args.request?.persistentStream;
    emit({ requestId: args.request?.requestId, kind: 'headers', status: 200, contentType: 'text/event-stream' });
    emit({ requestId: args.request?.requestId, kind: 'chunk', chunkBase64: btoa('event: weixin-status\ndata: {"connected":true}\n\n') });
    return new Promise(() => {});
  };
  Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen } } });
  const controller = new AbortController();
  let received!: () => void;
  const notification = new Promise<void>(resolve => { received = resolve; });
  const pending = createApiClient('http://127.0.0.1:8000', 'token').events!('/channels/weixin/events', controller.signal, () => received());
  const finished = pending.catch(reason => reason);
  await notification;
  expect(persistent).toBe(true);
  controller.abort();
  await finished;
  expect(cancelled).toBe(true);
  expect(unlistened).toBe(true);
});
