import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LibrarySource } from "../src/types";

const baseSource: LibrarySource = {
  id: 7, title: "项目方案.pdf", source_kind: "upload", original_filename: "项目方案.pdf",
  mime_type: "application/pdf", source_uri: "", privacy_mode: "redacted", enabled: true,
  parse_status: "ready", character_count: 120, file_available: false, folder_id: 3,
  created_at: "2026-10-14T08:00:00Z", updated_at: "2026-10-14T08:00:00Z"
};
const sources: LibrarySource[] = [
  baseSource,
  { ...baseSource, id: 8, title: "会议纪要.md", original_filename: "会议纪要.md", mime_type: "text/markdown", source_kind: "paste", enabled: false, updated_at: "2026-10-13T08:00:00Z" },
  { ...baseSource, id: 9, title: "产品参考.png", original_filename: "产品参考.png", mime_type: "image/png", character_count: 0, enabled: false, text_parse_status: "not_required", folder_id: null, updated_at: "2026-10-12T08:00:00Z" },
  { ...baseSource, id: 10, title: "一份名称比较长的产品设计研究与阅读笔记", original_filename: "研究笔记.txt", mime_type: "text/plain", folder_id: 4, favorite: true, updated_at: "2026-10-11T08:00:00Z" }
];
const evidenceDir = resolve("..", "..", "output", "file-library-redesign");

async function mockLibrary(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => {
    localStorage.setItem("tuantuan-auth-token", "file-library-e2e-token");
    localStorage.setItem("tuantuan-theme", value);
  }, theme);
  await page.route("http://127.0.0.1:4173/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email: "library@local.test", display_name: "测试读者", has_avatar: false } } });
    if (path === "/system/database-status") return route.fulfill({ json: { status: "ready", schema_version: 31, required_schema_version: 31 } });
    if (path === "/library") return route.fulfill({ json: {
      profile: { name: "", privacy_mode: "redacted", knowledge_revision: 1 },
      facts: [{ id: 21, category: "knowledge", statement: "每周整理阅读笔记", status: "pending" }],
      folders: [{ id: 3, name: "项目资料" }, { id: 4, name: "阅读笔记" }],
      collections: [{ id: 10, name: "产品研究", source_ids: [7, 8], file_count: 2 }], sources
    } });
    if (path === "/library/sources") return route.fulfill({ json: sources });
    const match = path.match(/^\/library\/sources\/(\d+)(\/organization)?$/);
    if (match) {
      const source = sources.find((item) => item.id === Number(match[1]));
      return route.fulfill({ json: { ...source, content: "# 项目资料\n\n这是一份用于界面验证的合成资料。", redacted_content: "这是一份用于界面验证的合成资料。", metadata: {} } });
    }
    if (path === "/conversations" || path === "/chat/messages") return route.fulfill({ json: [] });
    if (path === "/agent/runs/current") return route.fulfill({ json: { run: null } });
    return route.fulfill({ status: 404, json: { detail: `Unhandled library test route: ${path}` } });
  });
}

for (const { width, theme } of [
  { width: 1440, theme: "light" },
  { width: 1440, theme: "dark" },
  { width: 960, theme: "light" },
  { width: 375, theme: "light" },
  { width: 320, theme: "light" }
] as const) {
  test(`file library keeps reading and batch controls usable at ${width}px in ${theme}`, async ({ page }) => {
    await mkdir(evidenceDir, { recursive: true });
    await mockLibrary(page, theme);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/library");
    const list = page.getByRole("table", { name: "文件列表" });
    await expect(list.locator("tbody tr")).toHaveCount(3);
    await expect(page.getByRole("group", { name: "图片列表" }).getByRole("button", { name: "预览 产品参考.png" })).toBeVisible();
    await expect(page.getByRole("button", { name: "网格视图" })).toHaveCount(0);
    const assertNoOverflow = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await page.locator(".fl-browser").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    };
    await assertNoOverflow();
    await page.screenshot({ path: resolve(evidenceDir, `files-${width}-${theme}.png`), fullPage: true });

    await page.getByRole("button", { name: "预览 项目方案.pdf", exact: true }).click();
    const preview = page.getByRole("complementary", { name: "文件快速预览" });
    await expect(preview.getByRole("heading", { name: "项目方案.pdf", exact: true })).toBeVisible();
    await expect(preview.getByRole("button", { name: "用于对话", exact: true })).toBeInViewport();
    await expect(page.getByRole("checkbox", { name: "选择 项目方案.pdf", exact: true })).not.toBeChecked();
    if (width > 1100) {
      const [browserBox, previewBox] = await Promise.all([page.locator(".fl-browser").boundingBox(), preview.boundingBox()]);
      expect(browserBox!.x + browserBox!.width).toBeLessThanOrEqual(previewBox!.x);
    } else {
      await expect(preview).toHaveCSS("position", "fixed");
    }
    await assertNoOverflow();
    await page.screenshot({ path: resolve(evidenceDir, `preview-${width}-${theme}.png`), fullPage: true });
    await preview.getByRole("button", { name: "关闭快速预览" }).click();

    await page.getByRole("checkbox", { name: "选择 项目方案.pdf", exact: true }).check();
    await page.getByRole("checkbox", { name: "选择 会议纪要.md", exact: true }).check();
    const toolbar = page.getByRole("toolbar", { name: "批量文件操作" });
    await expect(toolbar).toContainText("已选 2 个文件");
    await expect(toolbar.getByRole("button", { name: "加入主题集合" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "移动", exact: true })).toBeVisible();
    await assertNoOverflow();
    if (width === 375) await page.screenshot({ path: resolve(evidenceDir, "selection-mobile.png"), fullPage: true });

    await toolbar.getByRole("button", { name: "取消选择" }).click();
    await page.getByRole("button", { name: "文件库更多选项" }).click();
    await page.getByRole("button", { name: "搜索与筛选" }).click();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page.getByLabel("筛选来源").selectOption("note");
    await page.getByLabel("筛选来源").press("Escape");
    await expect(page.getByLabel("筛选来源")).toBeHidden();
    await expect(list.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator(".fl-filter-summary")).toContainText("文本笔记");
    await assertNoOverflow();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await page.getByLabel("筛选目录").selectOption("3");
    await expect(list.locator("tbody tr")).toHaveCount(2);
    await expect(page.getByRole("navigation", { name: "文件路径" })).toContainText("项目资料");
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await page.getByRole("button", { name: "按时间从旧到新" }).click();
    await expect(list.locator("tbody tr").first()).toContainText("一份名称比较长");
    await page.getByRole("button", { name: "网格视图" }).click();
    await expect(list).toHaveClass(/fl-grid/);
    await assertNoOverflow();
    if (width === 1440 && theme === "light") await page.screenshot({ path: resolve(evidenceDir, "files-grid.png"), fullPage: true });
  });
}
