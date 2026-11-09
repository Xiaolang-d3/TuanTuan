import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import type { ModelConnection } from "../../types";
import { useComposerModelDiscovery } from "./useComposerModelDiscovery";

const connection: ModelConnection = { id: "service-a", name: "服务 A", revision: 1, model_base_url: "https://a.example.test/v1", model_protocol: "auto", api_key_configured: true, enabled: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("useComposerModelDiscovery", () => {
  it("keeps provider output evidence per service and never confuses vision with generation", async () => {
    const entry = { id: "gateway/shared", display_name: "Vision group", input_types: ["image"], output_types: ["chat"], output_types_source: "provider" };
    const client = vi.fn().mockResolvedValue({ models: ["gateway/shared"], entries: [entry] });
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection }));
    await act(() => result.current.discover());
    expect(result.current.catalogs[0].entries).toEqual([entry]);
    expect(result.current.entries).toEqual([entry]);
  });
  it("queries every enabled connection independently and preserves an image catalog when chat discovery fails", async () => {
    const pending = deferred<{ models: string[] }>();
    const client = vi.fn((path: string) => path.includes("image-service") ? Promise.resolve({ models: ["gpt-image-1"] }) : pending.promise);
    const connections = [connection, { ...connection, id: "image-service", name: "生图服务", model_protocol: "images" as const }, { ...connection, id: "disabled-service", enabled: false }];
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection, connections }));
    let request!: Promise<void>;
    await act(async () => { request = result.current.discover(); });
    expect(client).toHaveBeenCalledTimes(2);
    expect(result.current.catalogs.find(service => service.connection_id === "image-service")?.models).toEqual(["gpt-image-1"]);
    expect(result.current.busy).toBe(true);
    await act(async () => { pending.resolve({ models: ["deepseek-flash"] }); await request; });
    expect(result.current.models).toEqual(["deepseek-flash"]);
    client.mockImplementation(path => path.includes("image-service") ? Promise.resolve({ models: ["gpt-image-2"] }) : Promise.reject(new Error("chat offline")));
    await act(() => result.current.discover(true));
    expect(result.current.error).toBe("chat offline");
    expect(result.current.catalogs.find(service => service.connection_id === "image-service")?.models).toEqual(["gpt-image-2"]);
    expect(result.current.catalogs.some(service => service.connection_id === "disabled-service")).toBe(false);
  });

  it("backs off failed requests while allowing an immediate manual retry", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ models: ["recovered"] });
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection }));
    await act(() => result.current.discover());
    await act(() => result.current.discover());
    expect(client).toHaveBeenCalledTimes(1);
    await act(() => result.current.discover(true));
    expect(client).toHaveBeenCalledTimes(2);
    expect(result.current.models).toEqual(["recovered"]);
  });

  it("drops an image service catalog when its connection is disabled during a request", async () => {
    const old = deferred<{ models: string[] }>();
    const client = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ models: ["chat"] });
    const { result, rerender } = renderHook(({ enabled }) => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connections: [{ ...connection, enabled }] }), { initialProps: { enabled: true } });
    let request!: Promise<void>;
    act(() => { request = result.current.discover(); });
    rerender({ enabled: false });
    await act(async () => { old.resolve({ models: ["removed-image-model"] }); await request; });
    expect(result.current.catalogs).toEqual([]);
    expect(client.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("uses fresh cached lists and refreshes when expired or requested", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = vi.fn().mockResolvedValueOnce({ models: [" grok-model ", "claude-model", "grok-model", " "] }).mockResolvedValue({ models: ["new-model"] });
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection }));
    expect(client).not.toHaveBeenCalled();
    await act(() => result.current.discover());
    expect(result.current.models).toEqual(["grok-model", "claude-model"]);
    expect(client.mock.calls[0][0]).toBe("/agent/model-connections/service-a/discover");
    expect(client.mock.calls[0][1].body).toBeUndefined();
    await act(() => result.current.discover());
    expect(client).toHaveBeenCalledTimes(1);
    expect(result.current.models).toEqual(["grok-model", "claude-model"]);
    now += 300_001;
    await act(() => result.current.discover());
    expect(client).toHaveBeenCalledTimes(2);
    expect(result.current.models).toEqual(["new-model"]);
    await act(() => result.current.discover(true));
    expect(client).toHaveBeenCalledTimes(3);
  });

  it("coalesces an opening while loading and ignores results superseded by a manual refresh", async () => {
    const old = deferred<{ models: string[] }>();
    const client = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ models: ["latest-model"] });
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection }));
    const discover = result.current.discover;
    let pending!: Promise<void>;
    act(() => { pending = result.current.discover(); });
    await act(() => result.current.discover());
    expect(result.current.discover).toBe(discover);
    expect(client).toHaveBeenCalledOnce();
    await act(() => result.current.discover(true));
    expect(client.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { old.resolve({ models: ["outdated-model"] }); await pending; });
    expect(result.current.models).toEqual(["latest-model"]);
  });

  it("keeps the previous service list visible while querying again", async () => {
    const next = deferred<{ models: string[] }>();
    const client = vi.fn().mockResolvedValueOnce({ models: ["known-model"] }).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection }));
    await act(() => result.current.discover());
    let pending!: Promise<void>;
    act(() => { pending = result.current.discover(true); });
    expect(result.current.busy).toBe(true);
    expect(result.current.models).toEqual(["known-model"]);
    await act(async () => { next.resolve({ models: ["latest-model"] }); await pending; });
    expect(result.current.busy).toBe(false);
  });

  it("drops late results after a connection revision or account changes", async () => {
    const old = deferred<{ models: string[] }>();
    const client = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ models: ["new-model"] });
    const { result, rerender } = renderHook(({ revision, scope }) => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope, connection: { ...connection, revision } }), { initialProps: { revision: 1, scope: "user-a" } });
    let pending!: Promise<void>;
    act(() => { pending = result.current.discover(); });
    rerender({ revision: 2, scope: "user-b" });
    expect(result.current.models).toEqual([]);
    expect(client.mock.calls[0][1].signal.aborted).toBe(true);
    await act(() => result.current.discover());
    await act(async () => { old.resolve({ models: ["old-model"] }); await pending; });
    expect(result.current.models).toEqual(["new-model"]);
  });

  it("retains a known catalog on refresh failure and permits retry", async () => {
    const client = vi.fn().mockResolvedValueOnce({ models: ["known-model"] }).mockRejectedValueOnce(new Error("service offline")).mockResolvedValueOnce({ models: ["recovered-model"] });
    const { result } = renderHook(() => useComposerModelDiscovery({ fetchJson: client as ReturnType<typeof createApiClient>, scope: "user-a", connection }));
    await act(() => result.current.discover());
    await act(() => result.current.discover(true));
    expect(result.current.models).toEqual(["known-model"]);
    expect(result.current.error).toBe("service offline");
    await act(() => result.current.discover(true));
    await waitFor(() => expect(result.current.error).toBe(""));
    expect(result.current.models).toEqual(["recovered-model"]);
  });
});
