const DEFAULT_API_TIMEOUT_MS = 30_000;

type DesktopApiResponse = { status: number; body: string; bodyBase64?: string | null; contentType?: string | null; retryAfter?: string | null };
type DesktopStreamEvent = {
  requestId: string;
  kind: "headers" | "chunk" | "end" | "error";
  status?: number;
  contentType?: string | null;
  retryAfter?: string | null;
  chunkBase64?: string | null;
  error?: string | null;
};
type DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type DesktopListen = (event: string, handler: (event: { payload: DesktopStreamEvent }) => void) => Promise<() => void>;

export const SESSION_EXPIRED_EVENT = "tuantuan:session-expired";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterSeconds = 0, public readonly details: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

type DesktopFormField = {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  dataBase64?: string;
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("读取上传文件失败"));
    reader.readAsArrayBuffer(file);
  });
}

async function desktopFormFields(form: FormData): Promise<DesktopFormField[]> {
  const fields: DesktopFormField[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      fields.push({ name, value });
    } else {
      fields.push({
        name,
        filename: value.name,
        contentType: value.type || "application/octet-stream",
        dataBase64: encodeBase64(new Uint8Array(await readFileBytes(value)))
      });
    }
  }
  return fields;
}

function desktopResponse(result: DesktopApiResponse): Response {
  const responseHeaders = new Headers();
  if (result.contentType) responseHeaders.set("Content-Type", result.contentType);
  if (result.retryAfter) responseHeaders.set("Retry-After", result.retryAfter);
  return new Response(result.status === 204 ? null : result.bodyBase64 ? decodeBase64(result.bodyBase64) : result.body, {
    status: result.status,
    headers: responseHeaders,
  });
}

function abortReason(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

async function openDesktopEventStream(
  invoke: DesktopInvoke,
  listen: DesktopListen,
  request: Record<string, unknown>,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const requestId = String(request.requestId);
  let unlisten: (() => void) | undefined;
  let removeAbort: (() => void) | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let opened = false;
  let finished = false;
  let resolveReady: (response: Response) => void = () => undefined;
  let rejectReady: (reason: unknown) => void = () => undefined;
  const ready = new Promise<Response>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const cleanup = () => {
    removeAbort?.();
    removeAbort = undefined;
    const stop = unlisten;
    unlisten = undefined;
    stop?.();
  };
  const cancelRequest = () => {
    void invoke("desktop_cancel_api_request", { requestId }).catch(() => undefined);
  };
  const fail = (reason: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (opened) {
      try { streamController?.error(reason); } catch { /* already closed */ }
      streamController = undefined;
      return;
    }
    rejectReady(reason);
  };

  const onAbort = () => {
    cancelRequest();
    fail(abortReason(signal));
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) {
    onAbort();
    return ready;
  }

  let stop: (() => void) | undefined;
  try {
    stop = await listen("desktop-api-stream", (event) => {
    const payload = event.payload;
    if (!payload || payload.requestId !== requestId || finished) return;
    if (payload.kind === "headers") {
      if (opened) return;
      opened = true;
      const headers = new Headers();
      if (payload.contentType) headers.set("Content-Type", payload.contentType);
      if (payload.retryAfter) headers.set("Retry-After", payload.retryAfter);
      const body = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
        cancel() {
          if (finished) return;
          finished = true;
          cleanup();
          cancelRequest();
          streamController = undefined;
        },
      });
      resolveReady(new Response(body, { status: payload.status ?? 200, headers }));
      return;
    }
    if (!opened) return;
    if (payload.kind === "chunk" && payload.chunkBase64) {
      try { streamController?.enqueue(decodeBase64(payload.chunkBase64)); } catch { /* closed */ }
      return;
    }
    if (payload.kind === "end") {
      finished = true;
      cleanup();
      try { streamController?.close(); } catch { /* already closed */ }
      streamController = undefined;
      return;
    }
    if (payload.kind === "error") fail(new Error(payload.error || "本地事件流中断"));
  });
  } catch (reason) {
    fail(reason);
    return ready;
  }
  unlisten = stop;
  if (finished) {
    stop();
    unlisten = undefined;
    return ready;
  }

  void invoke<DesktopApiResponse>("desktop_api_request", { request }).then((result) => {
    if (finished) return;
    if (!opened) {
      finished = true;
      cleanup();
      resolveReady(desktopResponse(result));
      return;
    }
    // The end event is emitted before the command returns, but it can still be
    // queued behind this resolution. Wait a turn so those chunks are not dropped.
    window.setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      try { streamController?.close(); } catch { /* already closed */ }
      streamController = undefined;
    }, 0);
  }).catch((reason: unknown) => {
    fail(reason);
  });
  return ready;
}

async function tauriAwareFetch(input: RequestInfo | URL, init?: RequestInit, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<Response> {
  // Desktop WebView is https://tauri.localhost; browser fetch to http://127.0.0.1
  // is mixed-content blocked. Prefer the Rust sidecar proxy (known apiBase),
  // and fall back to the Tauri HTTP plugin for non-loopback URLs.
  const tauri = (window as Window & {
    __TAURI__?: { core?: { invoke: DesktopInvoke }; event?: { listen: DesktopListen } };
  }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (invoke) {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, window.location.href);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      const headers = new Headers(init?.headers);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      const formFields = init?.body instanceof FormData ? await desktopFormFields(init.body) : undefined;
      const requestId = crypto.randomUUID();
      const request = {
        path: `${url.pathname}${url.search}`,
        method,
        body,
        formFields,
        authorization: headers.get("Authorization"),
        requestId,
        timeoutMs,
      };
      let onAbort: (() => void) | undefined;
      try {
        if (init?.signal?.aborted) throw abortReason(init.signal);
        if (tauri?.event?.listen) return await openDesktopEventStream(invoke, tauri.event.listen, request, init?.signal);
        const pending = invoke<DesktopApiResponse>("desktop_api_request", { request });
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            void invoke("desktop_cancel_api_request", { requestId }).catch(() => undefined);
            reject(abortReason(init?.signal));
          };
          init?.signal?.addEventListener("abort", onAbort, { once: true });
          if (init?.signal?.aborted) onAbort();
        });
        const result = await Promise.race([pending, cancelled]);
        if (init?.signal?.aborted) throw abortReason(init.signal);
        return desktopResponse(result);
      } catch (reason) {
        if (init?.signal?.aborted) throw abortReason(init.signal);
        const detail = reason instanceof Error ? reason.message : String(reason);
        throw new Error(`无法连接本地服务（${url.origin}${url.pathname}）：${detail}`);
      } finally {
        if (onAbort) init?.signal?.removeEventListener("abort", onAbort);
      }
    }
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return fetch(input, init);
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  options: RequestInit = {},
  timeoutMs = DEFAULT_API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  let timedOut = false;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const release = () => {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  };
  let streaming = false;

  try {
    const response = await tauriAwareFetch(input, { ...options, signal: controller.signal }, timeoutMs);
    if (controller.signal.aborted) throw abortReason(controller.signal);
    const authorization = new Headers(options.headers).get("Authorization");
    if (response.status === 401 && authorization?.startsWith("Bearer ")) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { token: authorization.slice(7) } }));
    }
    if (response.body && (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/event-stream")) {
      streaming = true;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              stream.close();
              return;
            }
            stream.enqueue(next.value);
          } catch (reason) {
            release();
            stream.error(timedOut ? new Error("请求超时，请检查网络后重试") : reason);
          }
        },
        cancel(reason) {
          release();
          return reader.cancel(timedOut ? new Error("请求超时，请检查网络后重试") : reason);
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  } catch (reason) {
    if (timedOut) throw new Error("请求超时，请检查网络后重试");
    throw reason;
  } finally {
    if (!streaming) release();
  }
}

type ValidationErrorItem = { loc?: unknown[]; msg?: string };

function formatValidationErrors(items: ValidationErrorItem[]): string {
  const lines = items
    .map((item) => {
      const field = (item.loc ?? []).filter((part) => part !== "body").join(".");
      if (!item.msg) return "";
      return field ? `${field}：${item.msg}` : item.msg;
    })
    .filter(Boolean);
  return lines.join("；");
}

export function createApiClient(apiBase: string, accessToken?: string) {
  return async function fetchJson<T>(path: string, options?: RequestInit, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<T> {
    const headers = new Headers(options?.headers);
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    const response = await fetchWithTimeout(`${apiBase}${path}`, { ...options, headers }, timeoutMs);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let message = `${path} 请求失败（${response.status}） @ ${apiBase}`;
      let details: Record<string, unknown> | null = null;
      try {
        const payload = JSON.parse(body) as {
          detail?: string | { message?: string } | ValidationErrorItem[];
        };
        if (typeof payload.detail === "string") message = payload.detail;
        else if (Array.isArray(payload.detail)) {
          // FastAPI 参数校验错误返回 detail 数组，拼出字段级提示。
          message = formatValidationErrors(payload.detail) || message;
        } else if (payload.detail && typeof payload.detail === "object" && payload.detail.message) {
          message = payload.detail.message;
          details = payload.detail as Record<string, unknown>;
        }
      } catch {
        // 未捕获异常会返回纯文本响应，附上正文片段比只给状态码更可诊断。
        const plain = body.trim();
        if (plain && !plain.startsWith("<") && plain.length <= 200) {
          message = `${message}：${plain}`;
        }
      }
      const retryAfter = Number(response.headers.get("Retry-After"));
      throw new ApiError(message, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 0, details);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };
}
