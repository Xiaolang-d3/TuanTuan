import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client";
import { createImageStudioApi } from "./imageStudioApi";

afterEach(() => vi.unstubAllGlobals());

describe("image studio transport", () => {
  it("sends the request identity, selected model and exact pixel size once", async () => {
    const raw = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task" }), { status: 202 }));
    vi.stubGlobal("fetch", raw);
    const api = createImageStudioApi("/api", "fixture", createApiClient("/api", "fixture"));
    const body = { request_id: "task", prompt: "夏日海报", profile_id: "alternate", size: "1536x1024" };
    await expect(api.generate(body)).resolves.toEqual({ id: "task" });
    expect(raw).toHaveBeenCalledTimes(1);
    const [url, init] = raw.mock.calls[0];
    expect(url).toBe("/api/image-studio/generate");
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBe("Bearer fixture");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("uses operation capabilities and accepts legacy size lists", async () => {
    const models = [
      { id: "legacy", name: "Legacy", sizes: ["auto"] },
      { id: "current", name: "Current", sizes: ["auto"], capabilities: { generate: { sizes: ["auto", "1536x1024"] }, edit: null } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models, default_profile_id: "current" })));
    const api = createImageStudioApi("/api", "fixture", createApiClient("/api", "fixture"));
    const options = await api.options();
    expect(options.models).toEqual([models[0], { ...models[1], sizes: ["auto", "1536x1024"] }]);
  });

  it("reads archived bytes using the work ID and authenticated transport", async () => {
    const raw = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", raw);
    const api = createImageStudioApi("/api", "fixture", createApiClient("/api", "fixture"));
    expect((await api.workFile("work/a")).size).toBe(2);
    const [url, init] = raw.mock.calls[0];
    expect(url).toBe("/api/image-studio/works/work%2Fa/file");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture");
  });
});
