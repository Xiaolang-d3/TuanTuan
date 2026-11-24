import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";
import type { ModelCatalog } from "../src/types";

const subscriptionPath = "/agent/chatgpt-subscription";
const authorize = "https://auth.openai.com/api/accounts/authorize?state=synthetic-test-state";
const existingModel = "existing-chat-model";
const existingConnection = { id: "existing", name: "示例 API 服务", model_base_url: "https://models.example.test/v1", model_protocol: "openai", api_key_configured: true, enabled: true, revision: 1 } as const;
const catalog: ModelCatalog = {
  connections: [existingConnection],
  profiles: [{ id: "existing-chat", connection_id: existingConnection.id, model_name: existingModel, enabled: true, revision: 1, output_types: ["chat"], supported_purposes: ["chat"] }],
  default_profile_id: "existing-chat",
  purpose_defaults: { chat: "existing-chat", image: null, vision: null },
  purpose_version: 1
};
const signedOut = { available: true, configured: false, plan_enabled: false, status: "signed_out", accounts: [] };
const account = { id: "sample-account", label: "示例 ChatGPT 账号", signed_in: true, plan_enabled: true };
const connected = { ...signedOut, configured: true, plan_enabled: true, status: "connected", active_id: account.id, connection_id: account.id, accounts: [account] };
const subscriptionConnection: ModelCatalog["connections"][number] = { id: account.id, name: "ChatGPT 订阅", model_base_url: "https://api.openai.com/v1", model_protocol: "responses", auth_kind: "chatgpt_subscription", api_key_configured: false, enabled: true, revision: 1 };
const capFlag = { status: "unknown", source: "model_id", detail: "不执行在线探测" };
const reads: Record<string, unknown> = {
  "/auth/me": { user: { id: 42, email: "demo@local.test", display_name: "示例用户", has_avatar: false } },
  "/system/database-status": { status: "ready", schema_version: 37, required_schema_version: 37 },
  "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
  "/agent/capabilities": { configured: true, active_model_name: existingModel, tools: [] },
  "/agent/settings": { ...defaultAgentSettings, ...existingConnection, model_name: existingModel, api_key: "", credential_status: "saved_unverified", connection_id: existingConnection.id, config_revision: 1, secret_storage_writable: true },
  "/agent/model-monitor": { status: "unknown", status_message: "尚未进行调用", model_name: existingModel, base_url: existingConnection.model_base_url, protocol: "openai", api_key_configured: true, window_hours: 24, summary: { total_requests: 0, successful_requests: 0, failed_requests: 0, success_rate: null, average_latency_ms: null, p95_latency_ms: null, timeout_count: 0, consecutive_failures: 0, total_tokens: 0 }, error_breakdown: [], recent_events: [], last_event_at: null, last_success_at: null, last_check_at: null },
  "/agent/models/capabilities": { model_name: existingModel, provider: "openai", provider_label: "OpenAI", protocol: "openai", protocol_label: "OpenAI", vision: capFlag, streaming: capFlag, tools: capFlag, probed: false, probe_error: null },
  "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
  "/conversations": [], "/chat/messages": [], "/agent/runs/current": { run: null },
  "/channels/weixin": { connected: false, enabled: false, error: "" },
  "/agent/model-fallbacks": { enabled: false, fallback_profile_ids: [], context_window_profile_ids: [], content_policy_profile_ids: [], retry_policy: { timeout: 0, rate_limit: 0, server_error: 0 }, allowed_fails: 1, cooldown_seconds: 30, revision: 1, backend: "native" },
  "/agent/model-routing": { roles: {}, strict_capabilities: false, version: 1 },
  "/agent/kernels": { default_kernel: "tuantuan", choices: [{ id: "tuantuan", name: "团团内核", available: true, reason: "" }] },
  "/agent/model-connections/existing/catalog": { connection_id: "existing", connection_revision: 1, models: [], entries: [], discovered_at: null },
  [`/agent/model-connections/${account.id}/catalog`]: { connection_id: account.id, connection_revision: 1, models: [], entries: [], discovered_at: null }
};

test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });

async function mockApp(page: Page, baseURL: string, available = true) {
  const origin = new URL(baseURL).origin;
  const writes: Array<{ path: string; body: unknown }> = [];
  const unexpected: string[] = [];
  const authorizationRequests: Array<{ url: string; referrer?: string }> = [];
  let authorized = false;
  let complete = false;
  let pendingPolls = 0;
  let catalogReads = 0;
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "synthetic-demo-session");
    localStorage.setItem("tuantuan-theme", "light");
  });
  // Context-level interception also handles the disowned authorization popup.
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (method === "GET" && url.href === authorize) {
      authorizationRequests.push({ url: url.href, referrer: request.headers().referer });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>模拟授权页</title><h1>模拟授权页</h1>" });
    }
    if (url.origin !== origin) {
      unexpected.push(`${method} ${url.origin}${path}`);
      return route.abort();
    }
    if (method === "GET" && (path === "/" || path.startsWith("/assets/") || /\.(?:svg|png|ico|webmanifest|woff2?)$/i.test(path))) return route.continue();
    const send = (json: unknown) => route.fulfill({ json });
    if (method !== "GET") {
      writes.push({ path, body: request.postData() ? request.postDataJSON() : null });
      if (method === "POST" && path === `${subscriptionPath}/start`) {
        return send({ attempt_id: "demo-attempt", authorization_url: authorize });
      }
    } else {
      if (path === subscriptionPath) return send(authorized ? connected : available ? signedOut : { ...signedOut, available: false, status: "unavailable" });
      if (path === `${subscriptionPath}/attempts/demo-attempt`) {
        if (!complete) {
          pendingPolls++;
          return send({ status: "pending" });
        }
        authorized = true;
        return send({ status: "completed" });
      }
      if (path === "/agent/model-connections") {
        catalogReads++;
        return send(authorized ? { ...catalog, connections: [...catalog.connections, subscriptionConnection] } : catalog);
      }
      if (path === "/channels/weixin/events") return route.fulfill({ contentType: "text/event-stream", body: ": local test\n\n" });
      if (Object.hasOwn(reads, path)) return send(reads[path]);
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { detail: `Unexpected test request: ${path}` } });
  });
  return { writes, unexpected, authorizationRequests, pendingPolls: () => pendingPolls, catalogReads: () => catalogReads, complete: () => { complete = true; } };
}

async function showSubscription(page: Page) {
  await page.getByRole("button", { name: "基础配置", exact: true }).click();
  return page.getByRole("region", { name: "ChatGPT 订阅登录" });
}

async function screenshot(region: ReturnType<Page["getByRole"]>, name: string) {
  const directory = process.env.CHATGPT_SUBSCRIPTION_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await region.screenshot({ path: resolve(directory, name), animations: "disabled" });
}

test("authorizes ChatGPT in a separate browser page without changing the default model", async ({ page, context, baseURL }) => {
  const mock = await mockApp(page, baseURL!);
  const defaults = page.getByRole("region", { name: "当前默认模型" });
  await page.goto("/#/settings/model");
  await expect(defaults).toContainText(existingModel);
  const subscription = await showSubscription(page);
  await expect(subscription.getByText("尚未登录 ChatGPT 账号。")).toBeVisible();
  const catalogReadsBefore = mock.catalogReads();
  const popupPromise = context.waitForEvent("page");
  await subscription.getByRole("button", { name: "登录 ChatGPT", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "模拟授权页" })).toBeVisible();
  await expect(popup).toHaveURL(authorize);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(mock.authorizationRequests).toEqual([{ url: authorize, referrer: undefined }]);
  await expect(subscription.getByText("请在浏览器中完成授权，然后返回团团。")).toBeVisible();
  await expect.poll(mock.pendingPolls).toBeGreaterThan(0);
  mock.complete();
  await expect(subscription.getByText("已连接 ChatGPT 订阅。")).toBeVisible();
  await expect(subscription.getByText("授权流程已完成；不会自动更换默认模型。")).toBeVisible();
  await expect(subscription.getByRole("list", { name: "已保存的 ChatGPT 账号" })).toContainText(account.label);
  await expect(subscription.getByRole("button", { name: "添加 ChatGPT 账号" })).toBeEnabled();
  await expect.poll(mock.catalogReads).toBeGreaterThan(catalogReadsBefore);
  await popup.close();
  await screenshot(subscription, "connected-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(subscription, "connected-narrow.png");
  await page.getByRole("button", { name: "模型配置", exact: true }).click();
  await expect(defaults).toContainText(existingModel);
  expect(mock.writes).toEqual([{ path: `${subscriptionPath}/start`, body: {} }]);
  expect(mock.unexpected).toEqual([]);
});

test("does not offer sign-in when the local backend reports subscription login unavailable", async ({ page, baseURL }) => {
  const mock = await mockApp(page, baseURL!, false);
  await page.goto("/#/settings/model");
  const subscription = await showSubscription(page);
  await expect(subscription.getByText("当前环境不支持 ChatGPT 订阅登录。")).toBeVisible();
  await expect(subscription.getByRole("button", { name: "登录 ChatGPT", exact: true })).toHaveCount(0);
  expect(mock.writes).toEqual([]);
  expect(mock.unexpected).toEqual([]);
});
