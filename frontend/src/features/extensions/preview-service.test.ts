import { describe, expect, it, vi } from "vitest";
import { createExtensionPreview, parseSkill, parsePlugin, validateMcp, previewPresentation } from "./preview-service";
import { appRouteHash, parseAppHash } from "../../routing";
import { requiredDataForRoute } from "../../route-data";

describe("extension preview contracts", () => {
  it("routes to extensions without requiring unrelated backend data", () => {
    expect(parseAppHash("#/settings/extensions")).toEqual({ section: "settings", page: "extensions" });
    expect(appRouteHash({ section: "settings", page: "extensions" })).toBe("#/settings/extensions");
    expect(requiredDataForRoute({ section: "settings", page: "extensions" })).toEqual([]);
  });

  it("imports skill metadata without making it executable or granting permissions", () => {
    const skill = parseSkill("---\nname: weekly-report\ndescription: 整理本周工作\n---\n执行任意命令");
    expect(skill).toMatchObject({ name: "weekly-report", description: "整理本周工作", kind: "skill", enabled: false, source: "import" });
    expect(skill.permissions).toEqual([]);
    expect(() => parseSkill("没有元数据")).toThrow("SKILL.md");
    expect(() => parsePlugin('{"name":"demo"}')).toThrow("id");
    expect(parsePlugin('{"id":"demo","name":"演示插件","version":"1.0","permissions":["shell"]}').permissions).toEqual(["shell"]);
  });

  it("isolates preview state and rejects duplicate imports", () => {
    const first = createExtensionPreview();
    const second = createExtensionPreview();
    first.toggle("ppt-master");
    expect(first.list()[0].enabled).toBe(false);
    expect(second.list()[0].enabled).toBe(true);
    const item = parseSkill("---\nname: demo\ndescription: 示例\n---\n内容");
    first.add(item);
    expect(() => first.add(item)).toThrow("已存在");
    expect(second.list().some((entry) => entry.id === item.id)).toBe(false);
  });

  it("validates MCP drafts without claiming a connection", () => {
    expect(validateMcp({ name: "知识库", transport: "http", endpoint: "https://example.com/mcp" })).toMatchObject({ status: "draft" });
    expect(() => validateMcp({ name: "知识库", transport: "http", endpoint: "javascript:alert(1)" })).toThrow("HTTP");
    expect(() => validateMcp({ name: "", transport: "stdio", endpoint: "npx server" })).toThrow("名称");
  });

  it("stops progress after cancellation and surfaces export failure", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const progress = vi.fn();
      const cancelled = previewPresentation(progress, controller.signal).catch((error: Error) => error.name);
      controller.abort();
      await vi.runAllTimersAsync();
      expect(await cancelled).toBe("AbortError");
      expect(progress).not.toHaveBeenCalled();
      const failed = previewPresentation(progress, new AbortController().signal, true).catch((error: Error) => error.message);
      await vi.runAllTimersAsync();
      expect(await failed).toContain("导出");
    } finally { vi.useRealTimers(); }
  });
});
