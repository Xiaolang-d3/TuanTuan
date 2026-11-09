import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { useWeixinStatus } from './useWeixinStatus';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const status = { connected: true, enabled: true, error: '', unread_count: 2, latest_sequence: 2,
  readable_sequence: 2, read_sequence: 0, binding_id: 'binding', stream_id: 'server', revision: 2 };

it('uses live snapshots without status polling and rejects an older HTTP acknowledgement', async () => {
  vi.useFakeTimers();
  let push!: (event: string, data: unknown) => void;
  const api = Object.assign(vi.fn(async () => status), {
    events: vi.fn(async (_path, signal: AbortSignal, callback) => {
      push = callback;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    })
  });
  const { result, unmount } = renderHook(() => useWeixinStatus(api as never, true));
  await act(async () => { push('weixin-status', status); });
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
  expect(result.current.status?.unread_count).toBe(2);
  expect(api).not.toHaveBeenCalled();
  act(() => result.current.accept({ ...status, revision: 1, unread_count: 9 }));
  expect(result.current.status?.unread_count).toBe(2);
  expect(result.current.connection).toBe('live');
  act(() => result.current.accept({ ...status, stream_id: 'restarted', revision: 1, unread_count: 5 }));
  act(() => result.current.accept({ ...status, revision: 10, unread_count: 9 }));
  expect(result.current.status?.unread_count).toBe(5);
  unmount();
});

it('ignores a fallback response overtaken by a live push and pauses hidden tabs', async () => {
  vi.useFakeTimers();
  let finish!: (value: typeof status) => void;
  let push!: (event: string, data: unknown) => void;
  let attempts = 0;
  const signals: AbortSignal[] = [];
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const api = Object.assign(vi.fn(async () => new Promise<typeof status>(resolve => { finish = resolve; })), {
    events: vi.fn(async (_path, signal: AbortSignal, callback) => {
      if (++attempts === 1) throw new Error('offline');
      signals.push(signal); push = callback;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    })
  });
  const { result } = renderHook(() => useWeixinStatus(api as never, true));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); push('weixin-status', { ...status, revision: 3, unread_count: 4 }); finish(status); });
  expect(result.current.status?.unread_count).toBe(4);
  await act(async () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(90_000); });
  expect(signals[0].aborted).toBe(true);
  expect(api.events).toHaveBeenCalledTimes(2);
  await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); push('weixin-status', { ...status, revision: 4, unread_count: 6 }); });
  expect(result.current.status?.unread_count).toBe(6);
  expect(api.events).toHaveBeenCalledTimes(3);
});

it('polls only while disconnected and stops fallback when a reconnect snapshot arrives', async () => {
  vi.useFakeTimers();
  let push!: (event: string, data: unknown) => void;
  let attempts = 0;
  const api = Object.assign(vi.fn(async () => status), {
    events: vi.fn(async (_path, signal: AbortSignal, callback) => {
      if (++attempts === 1) throw new Error('offline');
      push = callback;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    })
  });
  const { result } = renderHook(() => useWeixinStatus(api as never, true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.status?.unread_count).toBe(2);
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); push('weixin-status', { ...status, revision: 3, unread_count: 4 }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(api).toHaveBeenCalledTimes(1);
  expect(result.current.status?.unread_count).toBe(4);
});

it('discards late events after switching accounts and stops retrying an expired session', async () => {
  vi.useFakeTimers();
  let oldPush!: (event: string, data: unknown) => void;
  const oldApi = Object.assign(vi.fn(async () => status), { events: vi.fn(async (_path, signal: AbortSignal, callback) => {
    oldPush = callback;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
  }) });
  const nextApi = Object.assign(vi.fn(async () => status), { events: vi.fn(async () => { throw new ApiError('expired', 401); }) });
  const { result, rerender } = renderHook(({ api }) => useWeixinStatus(api as never, true), { initialProps: { api: oldApi as typeof nextApi } });
  rerender({ api: nextApi });
  await act(async () => { oldPush('weixin-status', status); await vi.advanceTimersByTimeAsync(90_000); });
  expect(result.current.status).toBeNull();
  expect(nextApi).not.toHaveBeenCalled();
  expect(nextApi.events).toHaveBeenCalledTimes(1);
});
