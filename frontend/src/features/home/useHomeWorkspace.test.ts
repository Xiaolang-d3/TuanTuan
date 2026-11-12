import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeWorkspace } from "./useHomeWorkspace";
import type { FetchJson, HomeWorkspaceResponse } from "./types";

function fixtureWorkspace(running: number): HomeWorkspaceResponse {
  return {
    generated_at: "2026-10-08T02:00:00Z",
    conversations: { items: [], error: null },
    jobs: {
      running: Array.from({ length: running }, (_, index) => ({ id: `job-${index}`, kind: "task", display_title: `任务 ${index}`, status: "running", created_at: "2026-10-08T01:00:00Z" })),
      pending_confirmations: []
    },
    weixin: { connected: false, unread_count: 0 },
    changelog: { items: [], error: null },
    skills: { items: [], error: null },
    library_recent: { items: [], error: null }
  };
}

async function settle() { await act(async () => undefined); }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useHomeWorkspace", () => {
  it("fetches /home/workspace on mount and exposes the snapshot", async () => {
    const client = vi.fn(async () => fixtureWorkspace(0)) as unknown as FetchJson;
    const { result } = renderHook(() => useHomeWorkspace(client));
    expect(result.current.loading).toBe(true);
    await settle();
    expect(client).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledWith("/home/workspace", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.workspace?.generated_at).toBe("2026-10-08T02:00:00Z");
  });

  it("polls every 30 seconds only while jobs are running and stops once they finish", async () => {
    let running = 1;
    const client = vi.fn(async () => fixtureWorkspace(running)) as unknown as FetchJson;
    renderHook(() => useHomeWorkspace(client));
    await settle();
    expect(client).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(client).toHaveBeenCalledTimes(2);
    running = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(client).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(client).toHaveBeenCalledTimes(3);
  });

  it("refreshes once when the window regains focus", async () => {
    const client = vi.fn(async () => fixtureWorkspace(0)) as unknown as FetchJson;
    renderHook(() => useHomeWorkspace(client));
    await settle();
    expect(client).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent manual refreshes", async () => {
    const client = vi.fn(async () => fixtureWorkspace(0)) as unknown as FetchJson;
    const { result } = renderHook(() => useHomeWorkspace(client));
    await settle();
    let first: Promise<void>;
    let second: Promise<void>;
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    await act(async () => { await Promise.all([first, second]); });
    expect(client).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous workspace and reports the error on a failed refresh", async () => {
    let calls = 0;
    const client = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return fixtureWorkspace(0);
      throw new Error("服务暂不可用");
    }) as unknown as FetchJson;
    const { result } = renderHook(() => useHomeWorkspace(client));
    await settle();
    expect(result.current.workspace).not.toBeNull();
    act(() => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(result.current.workspace?.generated_at).toBe("2026-10-08T02:00:00Z");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("服务暂不可用");
  });

  it("aborts the in-flight request on unmount and ignores its late resolution", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveRequest: ((value: HomeWorkspaceResponse) => void) | undefined;
    const client = vi.fn((_path: string, options?: RequestInit) => new Promise<HomeWorkspaceResponse>((resolve) => {
      capturedSignal = options?.signal ?? undefined;
      resolveRequest = resolve;
    })) as unknown as FetchJson;
    const { unmount } = renderHook(() => useHomeWorkspace(client));
    await settle();
    expect(client).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
    resolveRequest?.(fixtureWorkspace(0));
    await settle();
    expect(client).toHaveBeenCalledTimes(1);
  });
});
