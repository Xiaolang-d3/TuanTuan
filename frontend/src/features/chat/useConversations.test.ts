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

it("forks a used conversation into a new kernel without changing the source", async () => {
  const fetchJson = vi.fn()
    .mockResolvedValueOnce({ id: 9, title: "方案（分支）", kernel: "dsh" })
    .mockResolvedValueOnce([{ id: 9, title: "方案（分支）", kernel: "dsh" }]);
  const { result } = renderHook(() => useConversations({
    fetchJson, setActiveView: vi.fn(), setErrorMessage: vi.fn(), setNoticeMessage: vi.fn(),
  }));

  let created;
  await act(async () => { created = await result.current.forkConversation(3, "dsh"); });

  expect(fetchJson).toHaveBeenNthCalledWith(1, "/conversations/3/fork", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kernel: "dsh" }),
  });
  expect(created).toMatchObject({ id: 9, kernel: "dsh" });
  expect(result.current.currentConversationId).toBe(9);
});
