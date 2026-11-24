import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";
import type { AgentSettings, ModelServiceCheck } from "../src/types";

test("legacy model settings trap and restore focus and stay open until saving completes", async ({ page, baseURL }, testInfo) => {
  let savedSettings: AgentSettings = {
    ...defaultAgentSettings,
    model_name: "test-chat",
    model_base_url: "https://gateway.example.test/v1",
    model_protocol: "openai",
    api_key_configured: true,
    credential_status: "saved_unverified",
    config_revision: 1,
    secret_storage_writable: true
  };
  let releaseSave!: () => void;
  const pendingSave = new Promise<void>(resolve => { releaseSave = resolve; });
  let releaseCatalogReload!: () => void;
  const pendingCatalogReload = new Promise<void>(resolve => { releaseCatalogReload = resolve; });
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "model-dialog@local.test", display_name: "模型设置测试", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 37, required_schema_version: 37 },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/agent/capabilities": { configured: true, active_model_name: savedSettings.model_name, tools: [] },
    "/agent/models/capabilities": {
      model_name: "test-chat", provider: "openai", provider_label: "OpenAI",
      protocol: "openai", protocol_label: "OpenAI Chat Completions",
      vision: { status: "unknown", source: "model_id", detail: "" },
      streaming: { status: "supported", source: "client", detail: "" },
      tools: { status: "supported", source: "client", detail: "" },
      probed: false, probe_error: null
    },
    "/agent/models/discover": { models: [], count: 0 },
    "/agent/model-monitor": {
      status: "unknown", status_message: "尚未进行调用", model_name: "test-chat",
      base_url: "https://gateway.example.test/v1", protocol: "openai", api_key_configured: true,
      window_hours: 24, summary: { total_requests: 0, successful_requests: 0, failed_requests: 0,
        success_rate: null, average_latency_ms: null, p95_latency_ms: null, timeout_count: 0,
        consecutive_failures: 0, total_tokens: 0 },
      error_breakdown: [], recent_events: [], last_event_at: null, last_success_at: null, last_check_at: null
    },
    "/agent/runs/current": { run: null },
    "/conversations": [],
    "/chat/messages": []
  };
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "legacy-model-dialog-test");
    localStorage.setItem("tuantuan-theme", "light");
  });
  await page.route(`${baseURL}/**`, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    if (path === "/agent/settings") {
      if (request.method() === "PUT") {
        await pendingSave;
        savedSettings = { ...savedSettings, model_name: request.postDataJSON().model_name, config_revision: 2 };
      }
      return route.fulfill({ json: savedSettings });
    }
    if (path === "/agent/model-monitor/check") {
      const check: ModelServiceCheck = {
        available: true,
        config_revision: savedSettings.config_revision,
        status: "healthy",
        status_message: "连接正常",
        model_name: savedSettings.model_name,
        base_url: savedSettings.model_base_url,
        protocol: "openai",
        api_key_configured: true,
        window_hours: 24,
        summary: {
          total_requests: 0, successful_requests: 0, failed_requests: 0,
          success_rate: null, average_latency_ms: null, p95_latency_ms: null,
          timeout_count: 0, consecutive_failures: 0, total_tokens: 0
        },
        error_breakdown: [], recent_events: [],
        last_event_at: null, last_success_at: null, last_check_at: null,
        check_error_code: null, check_error_message: null
      };
      return route.fulfill({ json: check });
    }
    if (path === "/agent/model-connections" && savedSettings.config_revision === 2) await pendingCatalogReload;
    if (path in responses) return route.fulfill({ json: responses[path] });
    return route.fulfill({ status: 404, json: { detail: `Unhandled model dialog test route: ${path}` } });
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/settings/model");
    const trigger = page.getByRole("button", { name: "配置模型", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "配置模型" });
    const address = dialog.getByRole("textbox", { name: "Base URL" });
    const close = dialog.getByRole("button", { name: "关闭模型设置" });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    await expect(address).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("shared-model-settings-dialog-mobile.png") });
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.press("Enter");
    await expect(address).toBeFocused();
    await dialog.getByRole("textbox", { name: "模型名称" }).fill("test-chat-updated");
    const saveRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/agent/settings" && request.method() === "PUT");
    await dialog.getByRole("button", { name: "保存并应用" }).click();
    expect((await saveRequest).postDataJSON()).toMatchObject({ model_name: "test-chat-updated", expected_revision: 1 });
    await expect(dialog.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await expect(close).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    const reloadRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/agent/model-connections");
    releaseSave();
    await reloadRequest;
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    const reloadResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/agent/model-connections");
    releaseCatalogReload();
    await reloadResponse;
    await expect(trigger).toBeFocused();
  } finally {
    releaseSave();
    releaseCatalogReload();
  }
});
