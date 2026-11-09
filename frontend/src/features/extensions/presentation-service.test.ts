import { afterEach, expect, it, vi } from "vitest";
import { createPresentationService } from "./presentation-service";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["capabilities", "create"])("allows bounded time for full runtime verification during %s", async operation => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const service = createPresentationService("/api", "login");
  const pending = operation === "capabilities" ? service.capabilities() : service.create("主题", 2, "key");
  // A real 14k-file bundle takes ~25 seconds warm; a cold disk can exceed 30.
  await vi.advanceTimersByTimeAsync(31_000);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
  finish(new Response(JSON.stringify({ available: true })));
  await pending;
});

it("reads authenticated readiness without caching stale configuration", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true, code: "ready" })));
  vi.stubGlobal("fetch", fetch);
  expect((await createPresentationService("/api", "login").capabilities()).available).toBe(true);
  expect(fetch.mock.calls[0][0]).toBe("/api/presentations/capabilities");
  expect(fetch.mock.calls[0][1].cache).toBe("no-store");
  expect(new Headers(fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer login");
});

it("scopes listing, readiness and creation to the same conversation", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [], available: true })));
  vi.stubGlobal("fetch", fetch);
  const service = createPresentationService("/api", "login");
  await service.list(7, undefined, "a".repeat(32));
  await service.capabilities(undefined, 7);
  await service.create("主题", 3, "stable-key", 7);
  expect(fetch.mock.calls[0][0]).toBe(`/api/presentations?conversation_id=7&before=${"a".repeat(32)}`);
  expect(fetch.mock.calls[1][0]).toBe("/api/presentations/capabilities?conversation_id=7");
  expect(JSON.parse(fetch.mock.calls[2][1].body).conversation_id).toBe(7);
  expect(new Headers(fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer login");
});

it("bootstraps confirmation with a body ticket and scoped credentials, never a query token", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "one-use" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrf: "scoped" })));
  vi.stubGlobal("fetch", fetch);
  const url = await createPresentationService("/api", "login").confirmation("a".repeat(32));
  expect(url).toBe(`/api/presentations/${"a".repeat(32)}/confirmation/`);
  expect(fetch.mock.calls[1][0]).not.toContain("one-use");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ ticket: "one-use", surface_origin: window.location.origin });
  expect(fetch.mock.calls[1][1].credentials).toBe("same-origin");
  expect(new Headers(fetch.mock.calls[1][1].headers).has("Authorization")).toBe(false);
});

it("retains an idempotency key across create retries and surfaces backend errors", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "请先配置模型" }), { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  await expect(createPresentationService("/api", "login").create("主题", 6, "stable-key")).rejects.toThrow("请先配置模型");
  expect(JSON.parse(fetch.mock.calls[0][1].body).idempotency_key).toBe("stable-key");
});

it("opens cross-origin confirmation using a body-only form without third-party cookie fetches", async () => {
  const popup = { document: document.implementation.createHTMLDocument(), close: vi.fn(), opener: window };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ticket: "body-only-ticket" })));
  vi.stubGlobal("fetch", fetch);
  const pending = createPresentationService("http://localhost:8000", "login").confirmation("b".repeat(32));
  expect(open).toHaveBeenCalledBefore(fetch);
  expect(await pending).toBe("");
  const form = popup.document.querySelector("form")!;
  expect(form.action).toBe(`http://localhost:8000/presentations/${"b".repeat(32)}/confirmation-open`);
  expect(form.method).toBe("post");
  expect(form.querySelector<HTMLInputElement>('input[name="ticket"]')!.value).toBe("body-only-ticket");
  expect(form.action).not.toContain("body-only-ticket");
  expect(popup.opener).toBeNull();
  expect(submit).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});

it("fails before issuing a cross-origin ticket when popups are blocked", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(createPresentationService("http://localhost:8000", "login").confirmation("b".repeat(32))).rejects.toThrow("弹出窗口");
  expect(fetch).not.toHaveBeenCalled();
});

it("uses the native isolated confirmation window on desktop without exposing cookies to JavaScript", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: { core: { invoke } } });
  try {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await createPresentationService("http://localhost:8000", "login").confirmation("c".repeat(32))).toBe("");
    expect(invoke).toHaveBeenCalledWith("desktop_open_presentation_confirmation", { jobId: "c".repeat(32), authorization: "Bearer login" });
    expect(fetch).not.toHaveBeenCalled();
  } finally { delete (window as Window & { __TAURI__?: unknown }).__TAURI__; }
});
