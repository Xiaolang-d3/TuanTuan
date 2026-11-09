import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWeixinBot } from './useWeixinBot';

afterEach(cleanup);
const state = { connected: true, enabled: true, error: '', conversation_id: 6, unread_count: 3, latest_sequence: 3, readable_sequence: 2, read_sequence: 0, binding_id: 'binding' };

it('keeps unread messages on other pages and acknowledges only the loaded snapshot', async () => {
  const messages = [{ id: 1, content: '微信消息' }];
  const api = vi.fn(async (path: string) => path.includes('/chat/messages') ? messages : path.endsWith('/read') ? { ...state, unread_count: 1 } : state);
  const onMessages = vi.fn();
  const { result, rerender } = renderHook(({ activeId }) => useWeixinBot({ fetchJson: api as never, enabled: true, activeConversationId: activeId, chatBusy: false, onMessages }), { initialProps: { activeId: null as number | null } });
  await waitFor(() => expect(result.current?.unread_count).toBe(3));
  expect(api.mock.calls.some(([path]) => path.endsWith('/read'))).toBe(false);
  rerender({ activeId: 6 });
  await waitFor(() => expect(onMessages).toHaveBeenCalledWith(messages));
  await waitFor(() => expect(result.current?.unread_count).toBe(1));
  expect(api).toHaveBeenCalledWith('/channels/weixin/read', expect.objectContaining({ body: JSON.stringify({ through_sequence: 2, binding_id: 'binding' }) }));
});

it('does not mark messages read after leaving the conversation during loading', async () => {
  let finish: (value: unknown[]) => void = () => {};
  let loading = false;
  const api = vi.fn(async (path: string) => {
    if (path.includes('/chat/messages')) return new Promise<unknown[]>(resolve => { finish = resolve; loading = true; });
    return state;
  });
  const onMessages = vi.fn();
  const { rerender } = renderHook(({ activeId }) => useWeixinBot({ fetchJson: api as never, enabled: true, activeConversationId: activeId, chatBusy: false, onMessages }), { initialProps: { activeId: 6 as number | null } });
  await waitFor(() => expect(loading).toBe(true));
  rerender({ activeId: null });
  await act(async () => { finish([]); });
  expect(onMessages).not.toHaveBeenCalled();
  expect(api.mock.calls.some(([path]) => path.endsWith('/read'))).toBe(false);
});

it('loads a newer pushed snapshot as soon as the previous message load finishes', async () => {
  let finish!: (messages: unknown[]) => void;
  let loads = 0;
  const reads: number[] = [];
  const first = { ...state, unread_count: 1, latest_sequence: 1, readable_sequence: 1, read_sequence: 0, revision: 1, stream_id: 'server' };
  const api = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.includes('/chat/messages')) {
      if (++loads === 1) return new Promise(resolve => { finish = resolve; });
      return [{ id: 2, content: '第二条微信消息' }];
    }
    const sequence = JSON.parse(options?.body as string).through_sequence;
    reads.push(sequence);
    return { ...first, read_sequence: sequence, readable_sequence: 2, revision: sequence + 2, unread_count: 2 - sequence };
  });
  const onMessages = vi.fn();
  const channel = { status: first, connection: 'live' as const, refresh: vi.fn(), accept: vi.fn() };
  const { rerender } = renderHook(({ snapshot }) => useWeixinBot({ fetchJson: api as never, enabled: true, activeConversationId: 6, chatBusy: false, onMessages,
    channel: { ...channel, status: snapshot } }), { initialProps: { snapshot: first } });
  await waitFor(() => expect(loads).toBe(1));
  rerender({ snapshot: { ...first, unread_count: 2, latest_sequence: 2, readable_sequence: 2, revision: 2 } });
  await act(async () => { finish([{ id: 1, content: '第一条微信消息' }]); });
  await waitFor(() => expect(reads).toEqual([1, 2]));
  expect(onMessages).toHaveBeenLastCalledWith([{ id: 2, content: '第二条微信消息' }]);
});

it('does not replace new chat output with a history response from before a complete busy cycle', async () => {
  let finish!: (messages: unknown[]) => void;
  let loads = 0;
  const api = vi.fn(async (path: string) => {
    if (path.includes('/chat/messages')) {
      if (++loads === 1) return new Promise(resolve => { finish = resolve; });
      return [{ content: '新回答' }];
    }
    return { ...state, unread_count: 0 };
  });
  const onMessages = vi.fn();
  const channel = { status: state, connection: 'live' as const, refresh: vi.fn(), accept: vi.fn() };
  const { rerender } = renderHook(({ busy }) => useWeixinBot({ fetchJson: api as never, enabled: true, activeConversationId: 6, chatBusy: busy, onMessages, channel }), { initialProps: { busy: false } });
  await waitFor(() => expect(loads).toBe(1));
  rerender({ busy: true });
  rerender({ busy: false });
  await act(async () => { finish([{ content: '旧回答' }]); });
  await waitFor(() => expect(onMessages).toHaveBeenCalledWith([{ content: '新回答' }]));
  expect(onMessages).not.toHaveBeenCalledWith([{ content: '旧回答' }]);
});
