import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useConversationWebSearch } from "./useConversationWebSearch";

const user = { id: 7, email: "test@example.test" };
const base = "/test-api";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("isolates conversations, accounts and servers and restores a saved choice after remount", () => {
  const initialProps = { apiBase: base, account: user, id: 1 };
  const { result, rerender, unmount } = renderHook(({ apiBase, account, id }) => useConversationWebSearch(apiBase, account, id), { initialProps });
  expect(result.current.enabled).toBe(false);
  act(() => result.current.setEnabled(true));
  expect(result.current.enabled).toBe(true);
  rerender({ ...initialProps, id: 2 });
  expect(result.current.enabled).toBe(false);
  rerender({ ...initialProps, account: { ...user, id: 8 } });
  expect(result.current.enabled).toBe(false);
  rerender({ ...initialProps, apiBase: "/other" });
  expect(result.current.enabled).toBe(false);
  rerender({ ...initialProps, account: { ...user, email: "renamed@example.test" } });
  expect(result.current.enabled).toBe(true);
  unmount();
  const remounted = renderHook(() => useConversationWebSearch(base, user, 1));
  expect(remounted.result.current.enabled).toBe(true);
  act(() => remounted.result.current.setEnabled(false));
  expect(remounted.result.current.enabled).toBe(false);
});

it("updates the active choice when another tab turns it off", () => {
  const { result } = renderHook(() => useConversationWebSearch(base, user, 1));
  act(() => result.current.setEnabled(true));
  expect(result.current.enabled).toBe(true);
  const key = localStorage.key(0)!;
  act(() => {
    localStorage.setItem(key, "false");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "false", storageArea: localStorage }));
  });
  expect(result.current.enabled).toBe(false);
});
