import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

test("restores service models immediately and retains them if refresh fails", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "model-catalog-test-token");
    localStorage.setItem("tuantuan-theme", "dark");
  });
  const service = { id: "one", name: "测试服务", model_base_url: "https://example.test/v1", model_protocol: "openai", api_key_configured: true, enabled: true, revision: 1 };
  const profile = { id: "p1", connection_id: "one", model_name: "claude-sonnet-5", enabled: true, revision: 1, output_types: ["chat"], supported_purposes: ["chat"] };
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "model-cache@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 37, required_schema_version: 37 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": { ...defaultAgentSettings, model_name: profile.model_name, model_base_url: service.model_base_url, model_protocol: "openai", api_key_configured: true },
    "/agent/capabilities": { configured: true, active_model_name: profile.model_name, tools: [] },
    "/agent/model-connections": { connections: [service], profiles: [profile], default_profile_id: profile.id, purpose_defaults: { chat: profile.id, image: null }, purpose_version: 1 },
    "/agent/model-connections/one/catalog": { connection_id: "one", connection_revision: 1, models: ["claude-sonnet-5", "cached-model"], entries: [{ id: "claude-sonnet-5", output_types: ["chat"], output_types_source: "provider" }, { id: "cached-model", output_types: ["chat"], output_types_source: "provider" }], discovered_at: "2020-01-01T00:00:00Z" },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [{ id: 1, title: "目录测试", status: "active", summary: "", model_profile_id: profile.id, message_count: 0, task_status: "active", updated_at: "2026-11-02T08:00:00Z" }],
    "/chat/messages": [], "/agent/runs/current": { run: null }, "/presentations": { jobs: [], next_cursor: null }, "/document-reviews": { jobs: [] }, "/extensions": { extensions: [], connections: [], execution: { available: false, reason: "未配置" } }
  };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let discoveries = 0;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173" && (url.pathname === "/" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/src/") || url.pathname.startsWith("/@") || url.pathname.startsWith("/node_modules/") || /\.[a-z0-9]+$/i.test(url.pathname))) return route.continue();
    if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") return route.fulfill({ contentType: "text/css", body: "" });
    const path = url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;
    if (path === "/agent/model-connections/one/discover") {
      discoveries += 1;
      await blocked;
      return route.fulfill({ status: 503, json: { detail: "测试服务暂不可用" } });
    }
    if (path in responses) return route.fulfill({ json: responses[path] });
    return route.fulfill({ status: 404, json: { detail: `Unhandled route ${path}` } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/chat/1");
  const trigger = page.getByRole("button", { name: /切换模型，当前 claude-sonnet-5/ });
  await expect(trigger).toBeEnabled();
  await expect(trigger).toHaveAttribute("title", /测试服务/);
  await trigger.click();
  const menu = page.getByRole("dialog", { name: "模型与参数" });
  await expect(menu.getByRole("option", { name: "cached-model" })).toBeVisible();
  await expect(menu.getByText("上次获取，可能不是最新")).toBeVisible();
  await expect(menu.getByRole("option", { name: "claude-sonnet-5" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => discoveries).toBe(1);
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const output = resolve("..", "output", "chat-model-catalog-cache");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "cached-models-narrow.png"), animations: "disabled" });
  release();
  await expect(menu.getByRole("alert")).toContainText("测试服务暂不可用");
  await expect(menu.getByRole("option", { name: "cached-model" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(menu.getByRole("option", { name: "cached-model" })).toBeVisible();
  expect(errors).toEqual([]);
});
