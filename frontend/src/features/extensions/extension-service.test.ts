import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionService } from "./extension-service";

afterEach(() => vi.unstubAllGlobals());

describe("authenticated extension service", () => {
  it("encodes online queries, forwards cancellation and installs a server preview", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ id: "skill-1", content: "正文" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const service = createExtensionService("/api", "test-token");
    const controller = new AbortController();
    await service.searchSkills("react & 测试", controller.signal);
    expect(fetch.mock.calls[0][0]).toBe(`/api/extensions/skills/search?q=${encodeURIComponent("react & 测试")}`);
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    await service.previewSkills("acme/reports", "feature/demo", "report", controller.signal);
    expect(fetch.mock.calls[1][0]).toBe("/api/extensions/skills/preview");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ source: "acme/reports", ref: "feature/demo", name: "report" });
    expect(fetch.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
    const result = await service.installSkill("preview-1", "skills/report");
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({ preview_id: "preview-1", path: "skills/report" });
    expect(result.instructions).toBe("正文");
    expect(new Headers(fetch.mock.calls[2][1]?.headers).get("Authorization")).toBe("Bearer test-token");
  });
  it("cancels an in-flight discovery request through the shared timeout signal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = createExtensionService("/api", "token").searchSkills("report", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("uses the server catalog without seeding preview items and sends raw metadata for authoritative parsing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ extensions: [], connections: [], execution: { available: false, reason: "缺少执行环境" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const service = createExtensionService("/api", "test-token");
    const catalog = await service.list();
    expect(catalog.extensions).toEqual([]);
    expect(catalog.execution.reason).toBe("缺少执行环境");
    expect(fetch.mock.calls[0][0]).toBe("/api/extensions");
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    await service.importContent("skill", "---\nname: demo\ndescription: >\n  多行说明\n---\n正文");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ content: expect.stringContaining("多行说明") });
  });
});
