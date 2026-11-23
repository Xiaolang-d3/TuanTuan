import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";
import type { ModelCatalog, ModelCatalogEntry } from "../src/types";

test.use({ ...(process.env.UNIFIED_MODEL_E2E_URL ? { baseURL: process.env.UNIFIED_MODEL_E2E_URL } : {}), viewport: { width: 1440, height: 1000 }, hasTouch: true });

test("manages services and cross-service model defaults through the real settings UI", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const modelList = page.getByRole("list", { name: "模型目录" });
  const model = (name: string | RegExp) => modelList.getByText(name, { exact: typeof name === "string" });
  const management = page.getByRole("region", { name: "管理单个模型" });
  const manageModel = (label: string) => management.getByRole("combobox").selectOption({ label });
  const output = resolve("..", "output", "unified-model-management");
  await mkdir(output, { recursive: true });
  const requests: string[] = [], unexpected: string[] = [], errors: string[] = [], escaped: string[] = [];
  let emptyStart = true;
  let rejectNextDefault = false;
  const responseChecks: Promise<void>[] = [];
  const catalog: ModelCatalog = {
    connections: [{ id: "primary", name: "文本服务", model_base_url: "https://text.example.test/v1", model_protocol: "openai", api_key_configured: true, enabled: true, revision: 1 }],
    profiles: [{ id: "primary-chat", connection_id: "primary", model_name: "gpt-4.1", enabled: true, revision: 1, output_types: ["chat"], supported_purposes: ["chat"], capabilities: { chat: "supported", vision: "supported" }, context_limit: 128000, reasoning_effort: "low" }],
    default_profile_id: "primary-chat", purpose_defaults: { chat: null, image: null }, purpose_version: 1
  };
  catalog.profiles.push({ id: "disabled-chat", connection_id: "primary", model_name: "deepseek-chat", enabled: false, revision: 1, output_types: ["chat"], supported_purposes: ["chat"] });
  const entries: ModelCatalogEntry[] = [
    { id: "gpt-4.1", display_name: "GPT 4.1", output_types: ["chat"], output_types_source: "provider" },
    { id: "vendor/studio-paint-v2", display_name: "Studio Paint", output_types: ["image"], output_types_source: "provider" },
    { id: "vendor/video-preview", display_name: "Video Preview", output_types: ["video"], output_types_source: "provider" }
  ];
  const sourceOf = (id?: string | null) => catalog.profiles.find(profile => profile.id === id);
  const savedSettings = () => {
    const profile = sourceOf(catalog.purpose_defaults?.chat) || catalog.profiles[0];
    const connection = catalog.connections.find(item => item.id === profile.connection_id)!;
    return { ...defaultAgentSettings, model_name: profile.model_name, model_base_url: connection.model_base_url, model_protocol: connection.model_protocol, api_key: "", api_key_configured: true, credential_status: "saved_unverified", connection_id: connection.id, config_revision: connection.revision, secret_storage_writable: true };
  };
  const monitor = () => ({ status: "unknown", status_message: "尚未进行调用", model_name: savedSettings().model_name, base_url: savedSettings().model_base_url, protocol: savedSettings().model_protocol, api_key_configured: true, window_hours: 24, summary: { total_requests: 0, successful_requests: 0, failed_requests: 0, success_rate: null, average_latency_ms: null, p95_latency_ms: null, timeout_count: 0, consecutive_failures: 0, total_tokens: 0 }, error_breakdown: [], recent_events: [], last_event_at: null, last_success_at: null, last_check_at: null });
  const capFlag = { status: "unknown", source: "model_id", detail: "测试目录，不执行探测" };
  const initial: Record<string, unknown> = {
    "/auth/me": { user: { id: 42, email: "model-manager@local.test", display_name: "模型管理测试", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 37, required_schema_version: 37 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/capabilities": { configured: true, active_model_name: "gpt-4.1", tools: [] },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [], "/chat/messages": [], "/agent/runs/current": { run: null },
    "/channels/weixin": { connected: false, enabled: false, error: "" },
    "/agent/model-fallbacks": { enabled: false, fallback_profile_ids: [], context_window_profile_ids: [], content_policy_profile_ids: [], retry_policy: { timeout: 0, rate_limit: 0, server_error: 0 }, allowed_fails: 1, cooldown_seconds: 30, revision: 1, backend: "native" },
    "/agent/model-routing": { roles: {}, strict_capabilities: false, version: 1 },
    "/agent/kernels": { default_kernel: "tuantuan", choices: [{ id: "tuantuan", name: "团团内核", available: true, reason: "" }] }
  };
  await page.addInitScript(() => { sessionStorage.setItem("tuantuan-auth-token", "synthetic-model-manager-token"); localStorage.setItem("tuantuan-theme", "light"); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", request => { if (request.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
  page.on("response", response => {
    const url = new URL(response.url());
    const staticAsset = url.origin === new URL(baseURL!).origin && (url.pathname === "/" || url.pathname.startsWith("/assets/") || /\.(?:svg|png|ico|webmanifest|woff2?)$/i.test(url.pathname));
    if (!staticAsset) responseChecks.push(response.serverAddr().then(address => { if (address) escaped.push(`${url.origin}${url.pathname}`); }));
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin === new URL(baseURL!).origin && (path === "/" || path.startsWith("/assets/") || /\.(?:svg|png|ico|webmanifest|woff2?)$/i.test(path))) { await route.continue(); return; }
    requests.push(`${request.method()} ${path}`);
    // The product stylesheet references Google Fonts; keep this validation entirely local.
    if (url.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (path === "/channels/weixin/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": mocked local events\n\n" });
    const send = (json: unknown) => route.fulfill({ json });
    if (path === "/agent/settings") return send(savedSettings());
    if (path === "/agent/model-monitor") return send(monitor());
    if (path === "/agent/models/capabilities") return send({ model_name: savedSettings().model_name, provider: "openai", provider_label: "OpenAI", protocol: "openai", protocol_label: "OpenAI", vision: capFlag, streaming: capFlag, tools: capFlag, probed: false, probe_error: null });
    if (path === "/agent/model-connections") {
      if (emptyStart) return send({ ...catalog, connections: [], profiles: [], purpose_defaults: { chat: null, image: null } });
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        expect(Object.keys(body).sort()).toEqual(["api_key", "model_base_url", "model_protocol", "name"]);
        expect(body.model_base_url).toBe("https://gateway.example.test/v1");
        expect(body.model_protocol).toBe("auto");
        catalog.connections.push({ id: "gateway", name: body.name, model_base_url: body.model_base_url, model_protocol: "auto", api_key_configured: true, enabled: true, revision: 1 });
      }
      return send(catalog);
    }
    const removal = path.match(/^\/agent\/model-connections\/([^/]+)$/);
    if (removal && request.method() === "DELETE") {
      expect(url.searchParams.get("remove")).toBe("true");
      expect(url.searchParams.get("expected_revision")).toBe("1");
      catalog.connections = catalog.connections.filter(item => item.id !== removal[1]);
      catalog.profiles = catalog.profiles.filter(item => item.connection_id !== removal[1]);
      return send(catalog);
    }
    const cached = path.match(/^\/agent\/model-connections\/([^/]+)\/catalog$/);
    if (cached && request.method() === "GET") {
      const connection = catalog.connections.find(item => item.id === cached[1]);
      return send({ connection_id: cached[1], connection_revision: connection?.revision, models: [], entries: [], discovered_at: null });
    }
    const discover = path.match(/^\/agent\/model-connections\/([^/]+)\/discover$/);
    if (discover) return send(discover[1] === "gateway" ? { models: entries.map(item => item.id), entries } : { models: ["gpt-4.1"], entries: [entries[0]] });
    const ensure = path.match(/^\/agent\/model-connections\/([^/]+)\/profiles\/ensure$/);
    if (ensure) {
      const body = request.postDataJSON(), entry = entries.find(item => item.id === body.model_name)!;
      expect(body.expected_revision).toBe(1);
      if (!catalog.profiles.some(item => item.connection_id === ensure[1] && item.model_name === body.model_name)) {
        const supported = entry.output_types.filter((type): type is "chat" | "image" => type !== "video");
        catalog.profiles.push({ id: `gateway-${entry.output_types[0]}`, connection_id: ensure[1], model_name: entry.id, discovery: entry, enabled: true, revision: 1, output_types: entry.output_types, output_types_source: "inferred", supported_purposes: supported });
      }
      return send(catalog);
    }
    const defaults = path.match(/^\/agent\/model-defaults\/(chat|image)$/);
    if (defaults) {
      const purpose = defaults[1] as "chat" | "image", body = request.postDataJSON();
      expect(body.expected_version).toBe(catalog.purpose_version);
      if (body.profile_id !== null) expect(sourceOf(body.profile_id)?.supported_purposes).toContain(purpose);
      if (rejectNextDefault) {
        rejectNextDefault = false;
        return route.fulfill({ status: 500, json: { detail: "模拟保存失败" } });
      }
      catalog.purpose_defaults![purpose] = body.profile_id; catalog.purpose_version! += 1;
      if (body.profile_id !== null && (purpose === "chat" || !catalog.default_profile_id)) catalog.default_profile_id = body.profile_id;
      return send(catalog);
    }
    const profile = path.match(/^\/agent\/model-profiles\/([^/]+)$/);
    if (profile && request.method() === "PATCH") {
      const target = sourceOf(profile[1])!, { expected_revision, ...update } = request.postDataJSON();
      expect(expected_revision).toBe(target.revision);
      expect(update).not.toHaveProperty("capabilities");
      Object.assign(target, update); target.revision += 1;
      return send(catalog);
    }
    if (/^\/agent\/model-profiles\/[^/]+\/capabilities$/.test(path)) {
      const target = sourceOf(path.split("/")[3])!;
      const capability = (label: string) => ({ status: "supported", source: "heuristic", detail: "本地测试", label, overridden: false, probe_status: null, litellm_status: null });
      return send({ profile_id: target.id, model_name: target.model_name, protocol: "openai", capabilities: Object.fromEntries(["vision", "tools", "reasoning", "structured_output", "pdf", "prompt_caching"].map(key => [key, capability(key)])), context_window: { tokens: 128000, source: "litellm" }, max_output_tokens: { tokens: 8192, source: "litellm" }, litellm_known: true, pricing: { input_per_million_usd: null, output_per_million_usd: null }, probe_error: null });
    }
    if (path in initial) return send(initial[path]);
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { detail: `Unexpected model management test endpoint: ${path}` } });
  });
  try {
    await page.goto("/#/settings/model");
    await expect(page.getByRole("heading", { name: "模型管理", exact: true })).toBeVisible();
    await expect(page.getByLabel("新对话默认内核")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "连接模型服务，开始使用" })).toBeVisible();
    await expect(modelList).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "搜索模型" })).toHaveCount(0);
    await page.setViewportSize({ width: 805, height: 820 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: resolve(output, "product-first-service.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "连接第一个服务" }).click();
    await expect(page.getByLabel("Base URL", { exact: true })).toBeFocused();
    await page.screenshot({ path: resolve(output, "product-first-service-narrow.png"), fullPage: true, animations: "disabled" });
    emptyStart = false;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(page.getByRole("region", { name: "当前默认模型" })).toContainText("自动选择");
    await expect(modelList).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "搜索模型" })).toHaveCount(0);
    await page.screenshot({ path: resolve(output, "product-desktop-overview.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "模型列表", exact: true }).click();
    const disabledModel = model("deepseek-chat");
    await expect(modelList.getByRole("listitem")).toHaveText(["gpt-4.1", "deepseek-chat"]);
    await expect(modelList.getByRole("button")).toHaveCount(0);
    await disabledModel.click();
    await expect(modelList.getByRole("group")).toHaveCount(0);
    const writesBeforeViewing = requests.filter(item => item.startsWith("PATCH")).length;
    await page.getByRole("button", { name: "高级设置", exact: true }).click();
    await manageModel("deepseek-chat · 文本服务");
    await expect(management.getByRole("group")).toContainText("未启用");
    const parameters = management.getByRole("button", { name: "参数", exact: true });
    await parameters.click();
    await expect(page.getByRole("region", { name: "deepseek-chat 参数设置" })).toContainText("只读预览");
    expect(sourceOf("disabled-chat")?.enabled).toBe(false);
    expect(requests.filter(item => item.startsWith("PATCH"))).toHaveLength(writesBeforeViewing);
    await page.getByRole("button", { name: "收起参数" }).click();
    await expect(parameters).toBeFocused();
    await page.getByRole("button", { name: "添加服务", exact: true }).click();
    const form = page.getByRole("form", { name: "添加服务" });
    await expect(form.locator("input:visible")).toHaveCount(2);
    await expect(form.getByLabel("接口协议")).not.toBeVisible();
    await page.screenshot({ path: resolve(output, "product-desktop-connection.png"), fullPage: true, animations: "disabled" });
    await form.getByLabel("Base URL").fill("invalid-address");
    await form.getByLabel("API Key", { exact: true }).fill("synthetic-key-only-for-intercepted-test");
    await form.getByRole("button", { name: "保存并获取模型" }).click();
    await expect(form.getByLabel("API Key", { exact: true })).toHaveValue("synthetic-key-only-for-intercepted-test");
    await expect(form.getByLabel("Base URL")).toBeFocused();
    expect(requests.filter(item => item === "POST /agent/model-connections")).toHaveLength(0);
    await form.getByLabel("Base URL").fill("https://gateway.example.test/v1");
    await form.getByLabel("API Key", { exact: true }).fill("synthetic-key-only-for-intercepted-test");
    await form.getByRole("button", { name: "保存并获取模型" }).click();
    await expect(form).not.toBeVisible();
    await expect(model("Studio Paint")).toBeVisible();
    expect(requests.filter(item => item.endsWith("/primary/discover"))).toHaveLength(0);
    const gatewayDiscoveries = requests.filter(item => item.endsWith("/gateway/discover")).length;
    await page.getByRole("button", { name: "刷新此服务模型", exact: true }).click();
    await expect.poll(() => requests.filter(item => item.endsWith("/gateway/discover")).length).toBe(gatewayDiscoveries + 1);
    expect(requests.filter(item => item.endsWith("/primary/discover"))).toHaveLength(0);
    await page.getByRole("combobox", { name: "按服务筛选" }).selectOption("");
    await expect(model(/^gpt[- ]4\.1$/i)).toHaveCount(2);
    await manageModel("GPT 4.1 · gateway.example.test · gpt-4.1");
    await management.getByRole("button", { name: "设为文本默认", exact: true }).click();
    await expect(management.getByRole("group").getByText("文本默认", { exact: true })).toBeVisible();
    await expect(model("Studio Paint")).toBeVisible();
    await expect(model("Video Preview")).toBeVisible();
    await page.getByRole("button", { name: "概览", exact: true }).click();
    const changeText = page.getByRole("button", { name: "更换文本对话模型" });
    await changeText.click();
    const picker = page.getByRole("region", { name: "选择文本对话模型" });
    const pickerSearch = picker.getByRole("textbox", { name: "搜索可用模型" });
    await expect(pickerSearch).toBeFocused();
    await expect(pickerSearch).toHaveCSS("outline-style", "none");
    await expect(picker.locator(".unified-search")).toHaveCSS("outline-style", "solid");
    await expect(picker.getByRole("radio", { name: /gateway.example.test.*当前默认/ })).toBeChecked();
    await page.screenshot({ path: resolve(output, "product-desktop-default-picker.png"), fullPage: true, animations: "disabled" });
    await pickerSearch.fill("gpt-4.1 文本服务");
    const originalOption = picker.getByRole("radio", { name: /gpt-4.1.*文本服务/ });
    await originalOption.check();
    rejectNextDefault = true;
    const saveDefault = picker.getByRole("button", { name: "设为默认", exact: true });
    await saveDefault.click();
    await expect(picker.getByRole("alert")).toContainText("保存未完成");
    await expect(originalOption).toBeChecked();
    expect(catalog.purpose_defaults!.chat).toBe("gateway-chat");
    await saveDefault.click();
    await expect(picker).toHaveCount(0);
    await expect(changeText).toBeFocused();
    await expect(page.getByRole("region", { name: "当前默认模型" })).toContainText("文本服务 · 后续新任务使用");
    await page.getByRole("button", { name: "模型列表", exact: true }).click();
    await manageModel("Studio Paint · gateway.example.test · vendor/studio-paint-v2");
    await management.getByRole("button", { name: "设为图片默认", exact: true }).click();
    await expect(management.getByRole("group").getByText("图片默认", { exact: true })).toBeVisible();
    expect(sourceOf(catalog.purpose_defaults!.image)?.model_name).toBe("vendor/studio-paint-v2");
    expect(sourceOf(catalog.purpose_defaults!.chat)?.connection_id).toBe("primary");
    await manageModel("Video Preview · gateway.example.test · vendor/video-preview");
    await expect(management.getByRole("group").getByRole("button", { name: /默认/ })).toHaveCount(0);
    await page.getByRole("button", { name: "收起高级", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(output, "product-desktop-models.png"), fullPage: true, animations: "disabled" });
    await expect(page.getByRole("button", { name: "删除gateway.example.test", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "服务管理", exact: true }).click();
    await expect(page.getByRole("region", { name: "已连接服务" })).toContainText("API Key 已配置");
    await page.screenshot({ path: resolve(output, "product-desktop-services.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "删除gateway.example.test", exact: true }).click();
    await expect(page.getByRole("region", { name: "删除服务", exact: true }).getByRole("button", { name: "确认删除" })).toBeDisabled();
    await page.screenshot({ path: resolve(output, "product-desktop-removal.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "取消删除", exact: true }).click();
    await page.getByRole("button", { name: "模型列表", exact: true }).click();
    await page.getByRole("button", { name: "高级设置", exact: true }).click();
    await manageModel("gpt-4.1 · 文本服务");
    await parameters.click();
    const inspector = page.getByRole("region", { name: "gpt-4.1 参数设置" });
    await inspector.getByText("请求参数（可选）", { exact: true }).click();
    await inspector.getByRole("button", { name: "编辑请求参数" }).click();
    await inspector.getByLabel("温度", { exact: true }).fill("0.7");
    await inspector.getByLabel("思考程度").selectOption("high");
    await expect.poll(() => sourceOf("primary-chat")?.reasoning_effort).toBe("high");
    await expect(inspector.getByLabel("温度", { exact: true })).toHaveValue("0.7");
    await page.getByRole("button", { name: "收起参数" }).click();
    await expect(page.getByRole("alert")).toContainText("参数有未保存");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(inspector.getByLabel("温度", { exact: true })).toHaveValue("0.7");
    await inspector.getByLabel("温度", { exact: true }).fill("0.4");
    await inspector.getByLabel("最大输出 token", { exact: true }).fill("4096");
    await inspector.getByRole("button", { name: "保存请求参数" }).click();
    await expect.poll(() => sourceOf("primary-chat")?.parameters?.temperature).toBe(0.4);
    expect(sourceOf("primary-chat")?.capabilities).toEqual({ chat: "supported", vision: "supported" });
    expect(sourceOf("primary-chat")?.context_limit).toBe(128000);
    expect(sourceOf("primary-chat")?.reasoning_effort).toBe("high");
    await page.screenshot({ path: resolve(output, "product-desktop-parameters.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "收起参数" }).click();
    await expect(page.getByRole("button", { name: "使用规则", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "概览", exact: true }).click();
    await expect(page.getByRole("heading", { name: "模型额度", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "阶段模型分工", exact: true })).toBeVisible();
    await expect(page.getByLabel("新对话默认内核")).toBeVisible();
    await page.screenshot({ path: resolve(output, "product-desktop-advanced.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "收起高级", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "添加服务", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "模型列表", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "添加服务", exact: true })).toBeInViewport();
    await page.screenshot({ path: resolve(output, "product-narrow-models.png"), fullPage: true, animations: "disabled" });
    await disabledModel.tap();
    await expect(modelList.getByRole("button")).toHaveCount(0);
    await expect(modelList.getByRole("group")).toHaveCount(0);
    await expect(management).toHaveCount(0);
    await page.getByRole("button", { name: "服务管理", exact: true }).click();
    await page.getByRole("button", { name: "删除gateway.example.test", exact: true }).click();
    const removalPanel = page.getByRole("region", { name: "删除服务", exact: true });
    await expect(removalPanel.getByRole("button", { name: "确认删除" })).toBeDisabled();
    await expect(removalPanel).toContainText("先切换");
    await removalPanel.getByRole("button", { name: "取消删除" }).click();
    await page.getByRole("button", { name: "概览", exact: true }).click();
    await page.getByRole("button", { name: "更换图片生成模型" }).click();
    const imagePicker = page.getByRole("region", { name: "选择图片生成模型" });
    await imagePicker.getByRole("radio", { name: /自动选择/ }).check();
    await imagePicker.getByRole("button", { name: "设为自动选择" }).click();
    await expect(imagePicker).toHaveCount(0);
    expect(catalog.purpose_defaults!.image).toBeNull();
    await expect(page.getByRole("region", { name: "当前默认模型" })).toContainText("自动选择");
    await page.getByRole("button", { name: "服务管理", exact: true }).click();
    await page.getByRole("button", { name: "删除gateway.example.test", exact: true }).click();
    await expect(removalPanel.getByRole("button", { name: "确认删除" })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, "product-narrow-removal.png"), fullPage: true, animations: "disabled" });
    await removalPanel.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByRole("button", { name: "删除gateway.example.test", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "已连接服务" }).getByRole("article")).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("region", { name: "当前默认模型" })).toBeVisible();
    await expect(modelList).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, "product-narrow-overview.png"), fullPage: true, animations: "disabled" });
    await changeText.tap();
    await expect(picker).toBeFocused();
    await expect(pickerSearch).not.toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, "product-narrow-default-picker.png"), fullPage: true, animations: "disabled" });
    await pickerSearch.tap();
    await expect(pickerSearch).toBeFocused();
    await pickerSearch.press("Escape");
    await expect(changeText).toBeFocused();
    await page.setViewportSize({ width: 320, height: 700 });
    await changeText.press("Enter");
    await expect(pickerSearch).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await pickerSearch.press("Escape");
    const longModel = "provider/extra-long-unbroken-model-identifier-for-a-narrow-display";
    catalog.profiles.push({ id: "long-chat", connection_id: "primary", model_name: longModel, enabled: false, revision: 1, output_types: ["chat"], supported_purposes: ["chat"] });
    await page.reload();
    await page.getByRole("button", { name: "模型列表", exact: true }).tap();
    await page.getByRole("textbox", { name: "搜索模型" }).fill(longModel);
    const matchingModel = model(longModel);
    await expect(matchingModel).toBeVisible();
    await expect(modelList.getByRole("listitem")).toHaveText(longModel);
    await matchingModel.tap();
    await expect(modelList.getByRole("group")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "概览", exact: true }).tap();
    await page.getByRole("button", { name: "选择图片生成模型" }).tap();
    await expect(page.getByRole("region", { name: "选择图片生成模型" })).toContainText("没有可用的图片模型");
    await page.getByRole("button", { name: "连接模型服务", exact: true }).click();
    await expect(page.getByRole("form", { name: "添加服务" })).toBeVisible();
    await Promise.all(responseChecks);
    expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(escaped).toEqual([]);
    expect(requests.some(path => /\/reveal-key|\/probe|\/check|\/chat\/send|\/images\/generations/.test(path))).toBe(false);
    const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(persisted).not.toContain("synthetic-key-only-for-intercepted-test");
  } finally {
    await writeFile(resolve(output, "product-browser-evidence.json"), JSON.stringify({ requests, unexpected, errors, escaped, purpose_defaults: catalog.purpose_defaults, profiles: catalog.profiles.map(({ id, connection_id, model_name, parameters, reasoning_effort }) => ({ id, connection_id, model_name, parameters, reasoning_effort })) }, null, 2));
  }
});
