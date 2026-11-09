import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useImageEdits } from "./useImageEdits";
import type { ChatAttachment } from "./types";
import type { ImageEditRequest } from "./ImageEditor";
const asset: ChatAttachment = { id: 'source', origin: 'generated', kind: 'image', original_filename: 'image.png', parse_status: 'parsed' };
const request: ImageEditRequest = { operation_id: 'edit-id', mode: 'edit', prompt: '改为近脸图', strokes: [], comments: [], width: 1024, height: 1024, rotation: 0, flip: false };

it('shows an editing turn in chat immediately, then replaces it with saved messages', async () => {
  let finish!: (value: unknown) => void;
  const fetchJson = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const refreshChat = vi.fn().mockResolvedValue(undefined);
  const ref = { current: 4 as number | null };
  const { result } = renderHook(() => useImageEdits({ fetchJson, currentConversationId: 4, currentConversationIdRef: ref, refreshChat, refreshConversations: vi.fn().mockResolvedValue(undefined), accountKey: 'owner' }));
  let running!: Promise<unknown>;
  act(() => { running = result.current.editImage(asset, request); });
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.messages[0].content).toContain('改为近脸图');
  expect(result.current.messages[1].payload?.image_edit_pending).toBe(true);
  await act(async () => { finish({ assets: [{ ...asset, id: 'new' }], message_id: 12, conversation_id: 4 }); await running; });
  expect(refreshChat).toHaveBeenCalledWith(4);
  expect(result.current.messages).toHaveLength(0);
});

it('keeps failures visible in the chat after the preview has closed', async () => {
  const { result } = renderHook(() => useImageEdits({ fetchJson: vi.fn().mockRejectedValue(new Error('服务不支持编辑')), currentConversationId: 4, currentConversationIdRef: { current: 4 }, refreshChat: vi.fn(), refreshConversations: vi.fn(), accountKey: 'owner' }));
  await act(async () => { await expect(result.current.editImage(asset, request)).rejects.toThrow('服务不支持编辑'); });
  expect(result.current.messages[1].payload?.image_edit_pending).toBeFalsy();
  expect(result.current.messages[1].payload?.agent?.status).toBe('failed');
  expect(result.current.messages[1].content).toContain('服务不支持编辑');
});

it('shows the saved result if refreshing chat fails and isolates pending work by conversation', async () => {
  const options = { fetchJson: vi.fn().mockResolvedValue({ assets: [{ ...asset, id: 'new' }], message_id: 12, conversation_id: 4 }), currentConversationIdRef: { current: 4 as number | null }, refreshChat: vi.fn().mockRejectedValue(new Error('刷新失败')), refreshConversations: vi.fn().mockResolvedValue(undefined), accountKey: 'owner' };
  const { result, rerender } = renderHook(({ conversationId }) => useImageEdits({ ...options, currentConversationId: conversationId }), { initialProps: { conversationId: 4 } });
  await act(async () => { await result.current.editImage(asset, request); });
  expect(result.current.messages[1].payload?.agent?.assets?.[0].id).toBe('new');
  rerender({ conversationId: 5 });
  await waitFor(() => expect(result.current.messages).toHaveLength(0));
});
