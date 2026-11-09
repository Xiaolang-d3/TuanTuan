import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, fetchWithTimeout } from "./client";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("turns a stalled request into a recoverable timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const result = fetchWithTimeout("/slow-request", {}, 10);
    const assertion = expect(result).rejects.toThrow("请求超时，请检查网络后重试");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("does not send a request that was already cancelled", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWithTimeout("/library", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards cancellation during an active request without calling it a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const controller = new AbortController();
    const request = fetchWithTimeout("/library", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sends multipart files and repeated fields through the desktop bridge", async () => {
    const invoke = vi.fn(async (_command: string, args: { request: { formFields: Array<Record<string, string>> } }) => {
      const fields = args.request.formFields;
      expect(fields.map((field) => field.name)).toEqual(["mode", "files", "files"]);
      expect(fields[0].value).toBe("fast");
      expect(fields[1]).toMatchObject({ filename: "笔记.txt", contentType: "text/plain", dataBase64: "aGVsbG8=" });
      expect(fields[2]).toMatchObject({ filename: "图片.png", contentType: "image/png", dataBase64: "AAEC" });
      return { status: 200, body: '{"results":[]}', contentType: "application/json" };
    });
    Object.assign(window, { __TAURI__: { core: { invoke } } });
    try {
      const form = new FormData();
      form.append("mode", "fast");
      form.append("files", new File(["hello"], "笔记.txt", { type: "text/plain" }));
      form.append("files", new File([new Uint8Array([0, 1, 2])], "图片.png", { type: "image/png" }));
      const response = await fetchWithTimeout("http://127.0.0.1:8000/library/sources/import", { method: "POST", body: form });
      expect(await response.json()).toEqual({ results: [] });
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("returns binary avatar data from the desktop bridge intact", async () => {
    const invoke = vi.fn(async () => ({ status: 200, body: "", bodyBase64: "AAEC/w==", contentType: "image/jpeg" }));
    Object.assign(window, { __TAURI__: { core: { invoke } } });
    try {
      const response = await fetchWithTimeout("http://127.0.0.1:8000/auth/me/avatar");
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([0, 1, 2, 255]);
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("times out the desktop bridge and ignores a late unauthorized response", async () => {
    vi.useFakeTimers();
    let finish!: (response: unknown) => void;
    const invoke = vi.fn((command: string) => command === "desktop_cancel_api_request"
      ? Promise.resolve()
      : new Promise((resolve) => { finish = resolve; }));
    const expired = vi.fn();
    window.addEventListener("tuantuan:session-expired", expired);
    Object.assign(window, { __TAURI__: { core: { invoke } } });
    try {
      const result = fetchWithTimeout("http://127.0.0.1:8000/agent/settings", { headers: { Authorization: "Bearer synthetic-token" } }, 10);
      const assertion = expect(result).rejects.toThrow("请求超时");
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      const requestId = invoke.mock.calls[0][0] === "desktop_api_request"
        ? (invoke.mock.calls[0] as unknown as [string, { request: { requestId: string } }])[1].request.requestId : "";
      expect(invoke).toHaveBeenCalledWith("desktop_cancel_api_request", { requestId });
      finish({ status: 401, body: "{}", contentType: "application/json" });
      await Promise.resolve();
      expect(expired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("tuantuan:session-expired", expired);
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("streams desktop event-stream chunks before the bridge command resolves", async () => {
    let emit: (payload: Record<string, unknown>) => void = () => undefined;
    const listen = vi.fn(async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      emit = (payload) => handler({ payload });
      return () => undefined;
    });
    const invoke = vi.fn(async (command: string, args?: { request: { requestId: string } }) => {
      if (command !== "desktop_api_request") return undefined;
      const requestId = args?.request.requestId ?? "";
      emit({ requestId, kind: "headers", status: 200, contentType: "text/event-stream" });
      emit({ requestId, kind: "chunk", chunkBase64: btoa("data: hi\n\n") });
      emit({ requestId, kind: "end" });
      return { status: 200, body: "data: hi\n\n", contentType: "text/event-stream" };
    });
    Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen } } });
    try {
      const response = await fetchWithTimeout("http://127.0.0.1:8000/ag-ui", { method: "POST", body: "{}" });
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(await response.text()).toBe("data: hi\n\n");
      expect(listen).toHaveBeenCalledWith("desktop-api-stream", expect.any(Function));
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("keeps the buffered desktop body when stream events never arrive", async () => {
    const listen = vi.fn(async () => () => undefined);
    const invoke = vi.fn(async () => ({ status: 200, body: "{\"ok\":true}", contentType: "application/json" }));
    Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen } } });
    try {
      const response = await fetchWithTimeout("http://127.0.0.1:8000/library");
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("cancels a desktop event stream when the caller aborts", async () => {
    let emit: (payload: Record<string, unknown>) => void = () => undefined;
    const listen = vi.fn(async (_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
      emit = (payload) => handler({ payload });
      return () => undefined;
    });
    const invoke = vi.fn((command: string, args?: { request: { requestId: string } }) => {
      if (command === "desktop_cancel_api_request") return Promise.resolve();
      const requestId = args?.request.requestId ?? "";
      emit({ requestId, kind: "headers", status: 200, contentType: "text/event-stream" });
      return new Promise(() => undefined);
    });
    Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen } } });
    try {
      const controller = new AbortController();
      const response = await fetchWithTimeout("http://127.0.0.1:8000/ag-ui", { method: "POST", body: "{}", signal: controller.signal });
      const pending = response.body?.getReader().read();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(invoke.mock.calls.some(([command]) => command === "desktop_cancel_api_request")).toBe(true);
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it("cancels an active desktop request without treating it as a timeout", async () => {
    const invoke = vi.fn((command: string) => command === "desktop_cancel_api_request" ? Promise.resolve() : new Promise(() => undefined));
    Object.assign(window, { __TAURI__: { core: { invoke } } });
    try {
      const controller = new AbortController();
      const result = fetchWithTimeout("http://127.0.0.1:8000/agent/settings", { signal: controller.signal });
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(invoke.mock.calls.some(([command]) => command === "desktop_cancel_api_request")).toBe(true);
    } finally {
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    }
  });
});

describe("fetchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces field-level messages from FastAPI validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        detail: [
          { loc: ["body", "job_description"], msg: "String should have at least 20 characters", type: "string_too_short" }
        ]
      }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    )));

    const fetchJson = createApiClient("https://app.example.com");
    await expect(fetchJson("/quick-match", { method: "POST" })).rejects.toThrow(
      "job_description：String should have at least 20 characters"
    );
  });

  it("adds the plain-text body when the server did not return JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "Internal Server Error",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    )));

    const fetchJson = createApiClient("https://app.example.com");
    await expect(fetchJson("/agent/models/discover", { method: "POST" })).rejects.toThrow(
      "/agent/models/discover 请求失败（500） @ https://app.example.com：Internal Server Error"
    );
  });

  it("does not paste an HTML error page into the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><body>502 Bad Gateway</body></html>",
      { status: 502, headers: { "Content-Type": "text/html" } }
    )));

    const fetchJson = createApiClient("https://app.example.com");
    await expect(fetchJson("/agent/models/discover", { method: "POST" })).rejects.toThrow(
      /^\/agent\/models\/discover 请求失败（502） @ https:\/\/app\.example\.com$/
    );
  });

  it("keeps the status-code fallback when the detail array is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: [] }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    )));

    const fetchJson = createApiClient("https://app.example.com");
    await expect(fetchJson("/quick-match", { method: "POST" })).rejects.toThrow(
      "/quick-match 请求失败（422）"
    );
  });
});

describe("account API transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  });

  it("retains retry metadata as a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"detail":"请稍后重试"}', { status: 429, headers: { "Retry-After": "30" } })));
    await expect(createApiClient("https://app.example.com")("/auth/login")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 30, message: "请稍后重试" });
  });

  it("handles a desktop logout with an empty 204 response", async () => {
    const invoke = vi.fn(async () => ({ status: 204, body: "", contentType: null }));
    Object.assign(window, { __TAURI__: { core: { invoke } } });
    await expect(createApiClient("http://127.0.0.1:8000", "test-token")("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("retains Retry-After across the desktop proxy", async () => {
    const invoke = vi.fn(async () => ({ status: 429, body: '{"detail":"请稍后重试"}', contentType: "application/json", retryAfter: "12" }));
    Object.assign(window, { __TAURI__: { core: { invoke } } });
    await expect(createApiClient("http://127.0.0.1:8000")("/auth/login")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 12 });
  });
});
