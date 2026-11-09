import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useConversations } from "./useConversations";

it("PPT conversation creation does not override a newer user selection", async () => {
  let finish!: (value: unknown) => void;
  const fetchJson = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue([{ id: 1 }, { id: 2 }]);
  const { result } = renderHook(() => useConversations({ fetchJson, setActiveView: vi.fn(), setErrorMessage: vi.fn(), setNoticeMessage: vi.fn() }));
  let pending!: ReturnType<typeof result.current.createNewConversation>;
  act(() => { pending = result.current.createNewConversation({ onlyIfUnchanged: true }); });
  act(() => { result.current.setCurrentConversationId(2); });
  await act(async () => { finish({ id: 1 }); await pending; });
  expect(result.current.currentConversationId).toBe(2);
  expect(await pending).toBeUndefined();
});
