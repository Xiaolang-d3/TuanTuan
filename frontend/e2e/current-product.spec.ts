import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "./test-fixtures";

const conversation = {
  id: 1,
  title: "资料研究",
  status: "active",
  summary: "",
  message_count: 0,
  task_status: "active",
  updated_at: "2026-09-22T08:00:00Z",
  last_message_at: "2026-09-22T08:00:00Z"
};

const anotherConversation = { ...conversation, id: 2, title: "新对话" };

async function mockCurrentProduct(page: Page) {
  const conversations = [conversation];
  await page.addInitScript(() => {
    window.sessionStorage.setItem("tuantuan-auth-token", "e2e-token");
    window.localStorage.setItem("tuantuan-first-run:e2e@local.test", "done");
  });
  await page.route("http://127.0.0.1:4173/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) {
      return route.continue();
    }
    if (path === "/auth/me") {
      return route.fulfill({ json: { user: { id: 1, email: "e2e@local.test", display_name: "测试用户", has_avatar: false } } });
    }
    if (path === "/system/database-status") {
      return route.fulfill({ json: { status: "ready", schema_version: 25, required_schema_version: 25 } });
    }
    if (path === "/home/feed") return route.fulfill({ json: {
      news: [], repositories: { day: [], week: [] }, updates: [], practices: [], sources: [],
      preferences: { topics: ["AI", "Agent", "MCP"], repositories: [] }, item_states: {}, bookmarks: [],
      refreshing: false, last_synced_at: null
    } });
    if (path === "/home/workspace") return route.fulfill({ json: {
      generated_at: "2026-09-22T08:00:00Z", weixin: { connected: false, unread_count: 0 },
      conversations: { items: [], error: null }, jobs: { running: [], pending_confirmations: [] },
      changelog: { items: [], error: null }, skills: { items: [], error: null }, library_recent: { items: [], error: null }
    } });
    if (path === "/creation-records") {
      const records = [
        { kind: "chat", id: "1", title: conversation.title, updated_at: conversation.updated_at, conversation_id: 1, status: "active" },
        { kind: "image", id: "previous-image", title: "海边海报", updated_at: conversation.updated_at, conversation_id: 1, status: "uncertain" },
      ];
      const kind = url.searchParams.get("kind");
      return route.fulfill({ json: { items: records.filter(record => !kind || record.kind === kind), has_more: false } });
    }
    if (path === "/image-studio/tasks/previous-image") return route.fulfill({ json: {
      id: "previous-image", conversation_id: 1, prompt: "海边海报", status: "uncertain", profile_id: null,
      model_name: "mock-model", size: "auto", created_at: conversation.updated_at, error: "", assets: []
    } });
    if (path === "/library") return route.fulfill({ json: {
      profile: { name: "读者", privacy_mode: "redacted", knowledge_revision: 1 },
      facts: [{ id: 1, category: "knowledge", statement: "每周整理一次阅读笔记", status: "pending" }],
      sources: [{ id: 7, title: "读书笔记", source_kind: "paste", original_filename: "", mime_type: "text/plain", source_uri: "", privacy_mode: "redacted", enabled: true, parse_status: "ready", character_count: 120, file_available: false, created_at: "2026-09-22T08:00:00Z", updated_at: "2026-09-22T08:00:00Z" }]
    } });
    if (path === "/image-studio/options") return route.fulfill({ json: { default_profile_id: null, models: [] } });
    if (path === "/image-studio/history") return route.fulfill({ json: { items: [], has_more: false } });
    if (path === "/image-studio/works") return route.fulfill({ json: { items: [] } });
    if (path === "/conversations") {
      if (route.request().method() === "POST") {
        conversations.push(anotherConversation);
        return route.fulfill({ json: anotherConversation });
      }
      return route.fulfill({ json: conversations });
    }
    if (path === "/chat/messages") return route.fulfill({ json: [] });
    if (path === "/presentations") return route.fulfill({ json: { jobs: [], next_cursor: null } });
    if (path === "/document-reviews") return route.fulfill({ json: { jobs: [] } });
    if (path === "/agent/runs/current") return route.fulfill({ json: { run: null } });
    if (path === "/agent/capabilities") {
      return route.fulfill({
        json: {
          configured: true,
          active_model_provider: "openai_compatible",
          active_model_name: "mock-model",
          active_platform: "local",
          model_providers: ["openai_compatible"],
          platforms: ["local"],
          tools: ["get_library_context", "search_library", "search_public_web", "ask_user", "propose_library_knowledge"],
          web_research: { enabled: true, provider: "mock" }
        }
      });
    }
    if (path === "/attachments/config") {
      return route.fulfill({
        json: {
          storage: "local",
          vision_enabled: false,
          vision_ready: false,
          vision_url_ttl_seconds: 900,
          requires_public_endpoint: false,
          checks: []
        }
      });
    }
    return route.fulfill({ status: 404, json: { detail: `Unhandled E2E route: ${path}` } });
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-22T08:00:00Z"));
  await mockCurrentProduct(page);
});

const imageSkillPreview = {
  eligible: true, comparison_key: "skills-image", requires_confirmation: false,
  selection: { profile_id: "skill-image", model_name: "Fixture Image", service_name: "Fixture", reason: "default", sizes: ["1024x1024"] },
  candidates: [{ profile_id: "skill-image", model_name: "Fixture Image", service_name: "Fixture", eligible: true }],
};

async function mockSkillCenter(page: Page) {
  const weekly = { id: "weekly", kind: "skill", name: "周报助手", description: "整理周报", source: "user", enabled: true, permissions: [], status: "installed", user_invocable: true };
  await page.route("http://127.0.0.1:4173/extensions", route => route.fulfill({ json: {
    extensions: [weekly, { ...weekly, id: "ppt-master", name: "PPT Master", source: "builtin" }],
    connections: [], execution: { available: false, reason: "缺少隔离运行环境", adapter: "quick-ppt" },
  } }));
  await page.route("http://127.0.0.1:4173/agent/model-selection/preview", route => route.fulfill({ json: imageSkillPreview }));
  const writes: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:4173" && request.method() === "POST" && url.pathname !== "/agent/model-selection/preview") writes.push(url.pathname);
  });
  return writes;
}

test("skills center preselects a real skill in a new chat without starting a task", async ({ page }) => {
  const writes = await mockSkillCenter(page);
  await page.goto("/#/history");
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  const entry = nav.getByRole("link", { name: "技能中心" });
  await entry.click();
  await expect(page).toHaveURL(/#\/skills$/);
  await expect(entry).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "技能中心" })).toBeVisible();
  const unavailable = page.getByRole("article", { name: "PPT Master" });
  await expect(unavailable.getByText("缺少隔离运行环境")).toBeVisible();
  await expect(unavailable.getByRole("button", { name: "在新对话中选择" })).toBeDisabled();
  expect(writes).toEqual([]);

  await page.getByRole("article", { name: "周报助手" }).getByRole("button", { name: "在新对话中选择" }).click();
  await expect(page).toHaveURL(/#\/chat\/2$/);
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "可用技能" }).getByRole("button", { name: "周报助手" })).toHaveAttribute("aria-pressed", "true");
  expect(writes).toEqual(["/conversations"]);
});

test("skills center opens existing agent settings without writing or starting a task", async ({ page }, testInfo) => {
  await mockSkillCenter(page);
  await page.route("**/agent/settings", route => route.fulfill({ json: {
    model_name: "mock-model", model_base_url: "https://fixture.test/v1", default_kernel: "tuantuan",
    api_key_configured: true, config_revision: 1, credential_status: "saved_unverified",
  } }));
  await page.route("**/agent/kernels", route => route.fulfill({ json: { default_kernel: "tuantuan", choices: [
    { id: "tuantuan", name: "团团内核", available: true, reason: "" },
    { id: "dsh", name: "DeepSeek Harness", available: false, reason: "当前环境不可用" },
  ] } }));
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method()) && path !== "/agent/model-selection/preview") writes.push(path);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/skills");
  await page.getByRole("button", { name: "智能体设置", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\/agent$/);
  const kernel = page.getByRole("combobox", { name: "新对话默认内核" });
  await expect(kernel).toHaveValue("tuantuan");
  await expect(kernel.getByRole("option", { name: /DeepSeek Harness.*当前环境不可用/ })).toHaveJSProperty("disabled", true);
  const screenshot = testInfo.outputPath("agent-settings.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("智能体设置", { path: screenshot, contentType: "image/png" });
  expect(writes).toEqual([]);
});

test("skills center opens image creation from mobile without changing the existing draft or generating", async ({ page }) => {
  const writes = await mockSkillCenter(page);
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto("/#/images");
  await page.getByRole("textbox", { name: "画面描述" }).fill("尚未提交的图片草稿");
  const mobileNav = page.getByRole("navigation", { name: "移动端主导航" });
  await mobileNav.getByRole("link", { name: "技能中心" }).click();
  await expect(page).toHaveURL(/#\/skills$/);
  await expect(mobileNav.getByRole("link", { name: "技能中心" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "技能中心" })).toBeVisible();
  await page.getByRole("button", { name: "打开图片工作区" }).click();
  await expect(page).toHaveURL(/#\/images$/);
  await expect(page.getByRole("textbox", { name: "画面描述" })).toHaveValue("尚未提交的图片草稿");
  expect(writes).toEqual([]);
});

for (const theme of ["light", "dark", "blue"] as const) {
  test(`sidebar account and logo control remain reachable in ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem("tuantuan-theme", value), theme);
    await page.setViewportSize({ width: 874, height: 770 });
    await page.goto("/#/chat/1");
    const sidebar = page.locator("aside.sidebar");
    const account = page.getByRole("button", { name: "账号菜单", exact: true });
    const evidenceDir = resolve("..", "..", "output", "sidebar-navigation");
    await mkdir(evidenceDir, { recursive: true });

    for (const width of [874, 1280]) {
      await page.setViewportSize({ width, height: 770 });
      for (const collapsed of [false, true]) {
        const toggle = page.getByRole("button", { name: collapsed ? "展开侧边栏" : "收起侧边栏", exact: true });
        await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed));
        await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(collapsed ? 72 : 176);
        const themeShortcut = sidebar.getByRole("button", { name: /点击切换到/ });
        await expect(themeShortcut).toBeInViewport();
        const [sideBox, identityBox, accountBox, themeBox, toggleBox, brandBox] = await Promise.all([
          sidebar.boundingBox(), sidebar.locator(".sidebar-identity-slot").boundingBox(),
          account.boundingBox(), themeShortcut.boundingBox(), toggle.boundingBox(), sidebar.locator(".brand").boundingBox()
        ]);
        expect(identityBox!.y + identityBox!.height).toBeGreaterThan(sideBox!.y + sideBox!.height - 24);
        expect(accountBox!.y).toBeGreaterThanOrEqual(identityBox!.y);
        expect(accountBox!.y + accountBox!.height).toBeLessThanOrEqual(identityBox!.y + identityBox!.height);
        expect(themeBox!.y + themeBox!.height).toBeLessThanOrEqual(identityBox!.y + identityBox!.height);
        if (collapsed) {
          expect(themeBox!.y).toBeGreaterThanOrEqual(accountBox!.y + accountBox!.height);
          expect(themeBox!.x + themeBox!.width / 2).toBeCloseTo(accountBox!.x + accountBox!.width / 2, 0);
        } else {
          expect(themeBox!.x).toBeGreaterThanOrEqual(accountBox!.x + accountBox!.width);
          expect(themeBox!.y + themeBox!.height / 2).toBeCloseTo(accountBox!.y + accountBox!.height / 2, 0);
        }
        expect(accountBox!.x).toBeGreaterThanOrEqual(sideBox!.x + 8);
        expect(accountBox!.x + accountBox!.width).toBeLessThan(sideBox!.x + sideBox!.width);
        expect(toggleBox!.y).toBeGreaterThanOrEqual(brandBox!.y);
        expect(toggleBox!.y + toggleBox!.height).toBeLessThanOrEqual(brandBox!.y + brandBox!.height);
        expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(brandBox!.x + brandBox!.width);
        if (collapsed) {
          await expect(sidebar.getByRole("button", { name: "返回首页", exact: true })).toBeHidden();
          expect(toggleBox!.width).toBe(40);
          expect(toggleBox!.height).toBe(40);
          expect(Math.abs(toggleBox!.x + toggleBox!.width / 2 - sideBox!.x - sideBox!.width / 2)).toBeLessThanOrEqual(1);
          expect(toggleBox!.y).toBeCloseTo(brandBox!.y, 0);
          const logo = toggle.locator(".sidebar-toggle-logo");
          const icon = toggle.locator(".sidebar-toggle-icon");
          await account.focus();
          await page.mouse.move(width - 4, 766);
          await expect(logo).toHaveCSS("opacity", "1");
          await expect(icon).toHaveCSS("opacity", "0");
          await expect(logo.locator("img")).toBeVisible();
          expect(await logo.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          await toggle.hover();
          await expect(logo).toHaveCSS("opacity", "0");
          await expect(icon).toHaveCSS("opacity", "1");
          await page.mouse.move(width - 4, 766);
          await expect(logo).toHaveCSS("opacity", "1");
          await expect(icon).toHaveCSS("opacity", "0");
          await page.keyboard.press("Tab");
          await toggle.focus();
          await expect(toggle).toBeFocused();
          await expect(logo).toHaveCSS("opacity", "0");
          await expect(icon).toHaveCSS("opacity", "1");
        } else {
          const home = sidebar.getByRole("button", { name: "返回首页", exact: true });
          await expect(home).toBeVisible();
          const homeBox = (await home.boundingBox())!;
          expect(toggleBox!.x).toBeGreaterThanOrEqual(homeBox.x + homeBox.width);
          expect(toggleBox!.x + toggleBox!.width / 2).toBeGreaterThan(brandBox!.x + brandBox!.width / 2);
          expect(toggleBox!.y + toggleBox!.height / 2).toBeCloseTo(homeBox.y + homeBox.height / 2, 0);
          await expect(toggle.locator(".sidebar-toggle-icon")).toHaveCSS("opacity", "1");
        }

        await account.click();
        const menu = page.getByRole("menu", { name: "账号菜单" });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem")).toHaveText(["账号与安全", "退出登录"]);
        if (width === 1280 && !collapsed) {
          await menu.screenshot({ path: testInfo.outputPath(`sidebar-account-menu-${theme}.png`), animations: "disabled" });
        }
        const menuBox = (await menu.boundingBox())!;
        expect(menuBox.x).toBeGreaterThanOrEqual(0);
        expect(menuBox.y).toBeGreaterThanOrEqual(0);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
        await menu.press("Escape");
        await expect(account).toBeFocused();
        await page.screenshot({ path: resolve(evidenceDir, `sidebar-${width}-${collapsed ? "collapsed" : "expanded"}-${theme}.png`), animations: "disabled" });
        await toggle.click();
        await expect(page.getByRole("button", { name: collapsed ? "收起侧边栏" : "展开侧边栏", exact: true }))
          .toHaveAttribute("aria-expanded", String(collapsed));
      }
    }
    await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
    await expect(sidebar).toHaveClass(/collapsed/);
    await page.setViewportSize({ width: 390, height: 770 });
    await expect(page.getByRole("button", { name: "展开侧边栏", exact: true })).toBeHidden();
    const mobileHome = sidebar.getByRole("button", { name: "返回首页", exact: true });
    await expect(mobileHome).toBeInViewport();
    await mobileHome.click();
    await expect(page).toHaveURL(/#\/home$/);
  });
}

test("recent records link to filtered creation history and open image results read-only", async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path !== "/agent/model-selection/preview") writes.push(path);
  });
  await page.goto("/#/home");
  const recent = page.getByRole("navigation", { name: "工作区快捷入口" });
  await expect(recent.getByRole("button", { name: /资料研究/ })).toBeVisible();
  await recent.getByRole("button", { name: "查看全部创作记录" }).click();
  await expect(page).toHaveURL(/#\/history$/);
  const records = page.getByRole("region", { name: "创作记录" });
  const filters = records.getByRole("group", { name: "创作类型" });
  await filters.getByRole("button", { name: "图片", exact: true }).click();
  const image = records.getByRole("button", { name: /海边海报/ });
  await expect(image).toBeVisible();
  await expect(records.getByRole("button", { name: /资料研究/ })).toHaveCount(0);
  const screenshot = testInfo.outputPath("creation-records.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("创作记录", { path: screenshot, contentType: "image/png" });
  await image.click();
  await expect(page).toHaveURL(/#\/images\?task=previous-image$/);
  const detail = page.getByRole("dialog", { name: "图片详情" });
  await expect(detail.getByText("海边海报", { exact: true })).toBeVisible();
  await expect(detail.getByText(/不会自动重新提交/)).toBeVisible();
  await page.goBack();
  await expect(records).toBeVisible();
  await expect(detail).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("desktop sidebar keeps its layout and shortcut groups across module navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/home");
  const sidebar = page.locator("aside.sidebar");
  const navigation = sidebar.getByRole("navigation", { name: "主导航", exact: true });
  const shortcuts = sidebar.getByRole("navigation", { name: "工作区快捷入口" });
  const projects = shortcuts.getByRole("button", { name: "我的项目", exact: true });
  const recent = shortcuts.getByRole("button", { name: "最近记录" });
  const settings = sidebar.getByRole("link", { name: "设置", exact: true });
  await recent.click();

  for (const collapsed of [false, true]) {
    const toggle = sidebar.getByRole("button", { name: collapsed ? "展开侧边栏" : "收起侧边栏" });
    const buttons = ["工作台", "创作记录", "我的作品", "技能中心", "知识库"];
    if (collapsed) buttons.push("我的项目", "设置");

    for (const [button, route] of [
      [navigation.getByRole("link", { name: "我的作品" }), /#\/works$/],
      [navigation.getByRole("link", { name: "技能中心" }), /#\/skills$/],
      [navigation.getByRole("link", { name: "知识库" }), /#\/chat\/library$/],
      [collapsed ? navigation.getByRole("link", { name: "我的项目" }) : shortcuts.getByRole("button", { name: "查看全部项目" }), /#\/projects$/],
      [settings, /#\/settings$/],
      [navigation.getByRole("link", { name: "工作台" }), /#\/home$/],
    ] as const) {
      await button.click();
      await expect(page).toHaveURL(route);
      await expect(button).toHaveAttribute("aria-current", "page");
      await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed));
      await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(collapsed ? 72 : 176);
      await expect(navigation.getByRole("link")).toHaveText(buttons);
      if (collapsed) await expect(shortcuts).toBeHidden();
      else {
        await expect(projects).toHaveAttribute("aria-expanded", "true");
        await expect(recent).toHaveAttribute("aria-expanded", "false");
      }
    }

    await toggle.click();
  }
  await expect(projects).toHaveAttribute("aria-expanded", "true");
  await expect(recent).toHaveAttribute("aria-expanded", "false");
});

test("desktop shortcuts reuse the original project and creation lists", async ({ page }, testInfo) => {
  const project = { id: "press", name: "发布项目", description: "整理资料", status: "active", created_at: conversation.updated_at, updated_at: conversation.updated_at };
  await page.route("**/projects", route => {
    return route.fulfill({ json: { items: [{ ...project, id: "archived", name: "已归档项目", status: "archived" }, project] } });
  });
  await page.route("**/projects/press", route => route.fulfill({ json: { ...project, items: [] } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/works");
  const shortcuts = page.getByRole("navigation", { name: "工作区快捷入口" });
  const projects = shortcuts.getByRole("button", { name: "我的项目", exact: true });
  const records = shortcuts.getByRole("button", { name: "最近记录" });
  await expect(shortcuts).toBeVisible();
  await expect(projects).toHaveAttribute("aria-expanded", "true");
  await projects.press("Enter");
  await expect(projects).toHaveAttribute("aria-expanded", "false");
  await projects.press("Enter");
  await expect(projects).toHaveAttribute("aria-expanded", "true");
  await expect(shortcuts.getByRole("button", { name: "发布项目", exact: true })).toBeVisible();
  await expect(shortcuts.getByRole("button", { name: "已归档项目", exact: true })).toHaveCount(0);
  await expect(records).toHaveAttribute("aria-expanded", "true");
  await projects.click();
  await expect(projects).toHaveAttribute("aria-expanded", "false");
  await expect(shortcuts.getByRole("button", { name: "发布项目", exact: true })).toBeHidden();
  await expect(shortcuts.getByRole("button", { name: "图片：海边海报" })).toBeVisible();
  await projects.click();
  await expect(shortcuts.getByRole("button", { name: "发布项目", exact: true })).toBeVisible();
  const shot = testInfo.outputPath("workspace-shortcuts.png");
  await page.screenshot({ path: shot, animations: "disabled" });
  await testInfo.attach("工作区快捷入口", { path: shot, contentType: "image/png" });
  await shortcuts.getByRole("button", { name: "发布项目", exact: true }).click();
  await expect(page).toHaveURL(/#\/projects\?id=press$/);
  await shortcuts.getByRole("button", { name: "图片：海边海报" }).click();
  await expect(page).toHaveURL(/#\/images\?task=previous-image$/);
});

test("global search opens a source without starting a task", async ({ page }, testInfo) => {
  await page.route("**/search?*", async route => {
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).searchParams.get("q")).toBe("海边");
    return route.fulfill({ json: { items: [{ kind: "image", id: "previous-image", title: "图片记录", updated_at: conversation.updated_at, conversation_id: 1, status: "uncertain" }], has_more: false } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/home");
  await page.getByRole("group", { name: "工作区工具" }).getByRole("button", { name: "全局搜索" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "全局搜索" });
  const field = dialog.getByRole("textbox", { name: "关键词" });
  await field.fill("海边");
  await field.press("Enter");
  const result = dialog.getByRole("button", { name: "图片记录 图片记录" });
  await expect(result).toBeVisible();
  const shot = testInfo.outputPath("global-search-mobile.png");
  await page.screenshot({ path: shot, animations: "disabled" });
  await testInfo.attach("全局搜索", { path: shot, contentType: "image/png" });
  await result.click();
  await expect(page).toHaveURL(/#\/images\?task=previous-image$/);
  await expect(page.getByRole("dialog", { name: "图片详情" }).getByText("海边海报", { exact: true })).toBeVisible();
});

test("projects open linked final works without generating or copying them", async ({ page }, testInfo) => {
  const date = "2026-09-22T08:00:00Z";
  let archived = false;
  await page.route("**/projects/press", async route => {
    if (route.request().method() === "PATCH") {
      expect(route.request().postDataJSON()).toEqual({ status: "archived" });
      archived = true;
    }
    return route.fulfill({ json: {
      id: "press", name: "发布项目", description: "整理发布资料", status: archived ? "archived" : "active", created_at: date, updated_at: date,
      items: [{ kind: "final_work", source_id: "draft", title: "发布说明.md", conversation_id: null }],
    } });
  });
  await page.route("**/works/final", route => route.fulfill({ json: { items: [{ id: "draft", kind: "document", filename: "发布说明.md", created_at: date, media_type: "text/markdown", size: 11 }] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/projects?id=press");
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(page.getByText("状态：已归档")).toBeVisible();
  const screenshot = testInfo.outputPath("project-mobile.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("我的项目", { path: screenshot, contentType: "image/png" });
  await page.getByRole("button", { name: /^发布说明\.md/ }).click();
  await expect(page).toHaveURL(/#\/works\?work=final_work%3Adraft$/);
  await expect(page.getByRole("dialog").getByRole("heading", { name: "发布说明.md" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "发布项目" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^发布说明\.md/ })).toBeVisible();
});

test("task notifications open the original receipt without resubmitting", async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path !== "/agent/model-selection/preview") writes.push(path);
  });
  await page.route("**/task-center", route => route.fulfill({ json: { items: [{
    kind: "image", id: "previous-image", title: "图片生成", status: "outcome_unknown", updated_at: conversation.updated_at,
    source: { kind: "image", id: "previous-image" }, notification_key: "image:previous-image:outcome_unknown",
  }], has_more: false } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/chat/1");
  const tools = page.getByRole("group", { name: "工作区工具" });
  await tools.getByRole("button", { name: "任务中心" }).click();
  const tasks = page.getByRole("dialog", { name: "任务中心" });
  await expect(tasks.getByText(/结果待核实/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tasks).toBeHidden();
  await tools.getByRole("button", { name: "通知", exact: true }).click();
  const notification = page.getByRole("dialog", { name: "通知" });
  await expect(notification.getByText(/不会自动重新提交/)).toBeVisible();
  const screenshot = testInfo.outputPath("task-notifications-mobile.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("任务通知", { path: screenshot, contentType: "image/png" });
  await notification.getByRole("button", { name: "查看来源：图片生成" }).click();
  await expect(page.getByRole("dialog", { name: "图片详情" }).getByText("海边海报", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test("mobile navigation keeps settings reachable through the account menu", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tuantuan-sidebar:e2e@local.test", "collapsed"));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 770 });
    await page.goto("/#/chat/1");
    const navigation = page.getByRole("navigation", { name: "移动端主导航" });
    await expect(navigation.getByRole("link")).toHaveText([
      "工作台", "记录", "作品", "知识库", "项目", "技能", "设置"
    ]);
    const labels = await navigation.locator(".mobile-nav-item span").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }));
    expect(labels).toHaveLength(7);
    for (let index = 1; index < labels.length; index += 1) {
      expect(labels[index].left).toBeGreaterThanOrEqual(labels[index - 1].right - 1);
    }
    await navigation.getByRole("link", { name: "工作台", exact: true }).click();
    const entry = page.getByRole("region", { name: "工作台" });
    await expect(entry.getByRole("textbox", { name: "工作台草稿" })).toBeVisible();
    await entry.getByRole("button", { name: "查看视频工作区" }).click();
    await expect(page.getByText("视频生成尚未接入。")).toBeVisible();
    await navigation.getByRole("link", { name: "我的作品", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的作品", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "去图片创作", exact: true }).click();
    await expect(page).toHaveURL(/#\/images$/);
    await navigation.getByRole("link", { name: "创作记录", exact: true }).click();
    await expect(page).toHaveURL(/#\/history$/);
    await page.getByRole("region", { name: "创作记录" }).getByRole("button", { name: /资料研究/ }).click();
    await expect(page).toHaveURL(/#\/chat\/1$/);
    await expect(page.getByRole("button", { name: /[收展][起开]侧边栏/ })).toBeHidden();
    await expect(page.locator("aside.sidebar")).toHaveClass(/collapsed/);
    await expect(page.getByRole("button", { name: "返回首页", exact: true })).toBeInViewport();
    const account = page.getByRole("button", { name: "账号菜单", exact: true });
    await expect(account).toBeInViewport();
    await account.click();
    const menu = page.getByRole("menu", { name: "账号菜单" });
    await expect(menu.getByRole("menuitem")).toHaveText(["账号与安全", "退出登录"]);
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(770);
    await page.keyboard.press("Escape");
    await navigation.getByRole("link", { name: "设置", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "返回首页", exact: true }).click();
    await expect(page).toHaveURL(/#\/home$/);
  }
});

test("long conversations keep one scroll viewport without blank space above the composer", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("tuantuan-theme", "dark"));
  const source = { title: "参考资料", url: "https://example.com/reference", domain: "example.com" };
  const messages = Array.from({ length: 6 }, (_, index) => [
    { id: index * 2 + 1, role: "user", content: `问题 ${index + 1}`, created_at: conversation.updated_at },
    {
      id: index * 2 + 2, role: "assistant", created_at: conversation.updated_at,
      content: `${"这是一段用于验证长对话滚动的回答。\n\n".repeat(20)}[参考资料](${source.url})`,
      payload: { agent: {
        provider: "mock", platform: "local", status: "done", rounds: 1,
        events: [{ round: 1, tool_call_id: `search-${index}`, tool_name: "search_public_web", status: "done", message: "已检索", data: { sources: [source] } }]
      } }
    }
  ]).flat();
  let currentMessages = messages;
  await page.route("**/chat/messages?*", route => route.fulfill({ json: currentMessages }));
  await page.route("**/chat/messages/11/tail?*", route => {
    currentMessages = messages.slice(0, -2);
    return route.fulfill({ json: { messages: messages.slice(-2) } });
  });
  await page.route("**/chat/messages/restore", route => {
    currentMessages = messages;
    return route.fulfill({ json: {} });
  });
  await page.route("**/ag-ui", route => {
    const { threadId, runId } = route.request().postDataJSON();
    const [userMessage, originalAnswer] = messages.slice(-2);
    const assistantMessage = { ...originalAnswer, content: `重新生成的回答。\n\n${originalAnswer.content}` };
    currentMessages = [...currentMessages, userMessage, assistantMessage];
    const events = [
      { type: "RUN_STARTED", threadId, runId },
      { type: "STATE_SNAPSHOT", snapshot: { tuantuan: { status: "done", userMessage, assistantMessage } } },
      { type: "RUN_FINISHED", threadId, runId },
    ];
    return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  await page.setViewportSize({ width: 1088, height: 770 });
  await page.goto("/#/chat/1");
  await expect(page.locator(".message.assistant")).toHaveCount(6);

  const surface = page.locator(".chat-thread-surface");
  const viewport = page.getByRole("log");
  const assertSingleViewport = async () => {
    await expect.poll(() => surface.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    const [surfaceBox, viewportBox] = await Promise.all([surface.boundingBox(), viewport.boundingBox()]);
    expect(viewportBox!.y).toBeCloseTo(surfaceBox!.y, 0);
    expect(viewportBox!.height).toBeCloseTo(surfaceBox!.height, 0);
  };
  await assertSingleViewport();
  const composer = page.locator(".chat-composer");
  // The compact editor now has a separate, always-reachable skills footer.
  // Include the two 1px borders around the 100px editor.
  expect((await composer.locator(".composer-input").boundingBox())!.height).toBeLessThanOrEqual(102);
  await expect(composer.getByRole("group", { name: "技能与外部工具" })).toBeInViewport();
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(176);
  const [questionBox, answerBox] = await Promise.all([
    // The question includes its in-flow toolbar, even while the controls are hidden.
    page.locator(".message.user").last().boundingBox(),
    page.locator(".message.assistant").last().boundingBox()
  ]);
  expect(answerBox!.y - questionBox!.y - questionBox!.height).toBeLessThanOrEqual(24);
  const idleHeight = (await viewport.boundingBox())!.height;
  await page.getByRole("textbox", { name: "输入消息" }).focus();
  expect((await viewport.boundingBox())!.height).toBeCloseTo(idleHeight, 0);
  await page.getByRole("button", { name: "查看全部 1 个来源", exact: true }).last().click();
  const panel = page.getByRole("complementary", { name: "来源详情" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "关闭来源详情", exact: true }).click();
  await expect(panel).toBeHidden();
  await assertSingleViewport();

  for (const width of [777, 390, 1088]) {
    await page.setViewportSize({ width, height: 770 });
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const jump = page.getByRole("button", { name: /回到最新/ });
    await expect(jump).toBeHidden();
    const [viewportBefore, composerBefore] = await Promise.all([viewport.boundingBox(), composer.boundingBox()]);
    const scrollHeight = await viewport.evaluate(el => el.scrollHeight);
    await viewport.evaluate(el => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(jump).toBeVisible();
    await assertSingleViewport();
    const [viewportAfter, composerAfter, jumpBox] = await Promise.all([viewport.boundingBox(), composer.boundingBox(), jump.boundingBox()]);
    expect(viewportAfter!.height).toBeCloseTo(viewportBefore!.height, 0);
    expect(composerAfter!.y).toBeCloseTo(composerBefore!.y, 0);
    expect(await viewport.evaluate(el => el.scrollHeight)).toBe(scrollHeight);
    expect(jumpBox!.y + jumpBox!.height).toBeLessThan(composerAfter!.y);
    expect(jumpBox!.y + jumpBox!.height).toBeGreaterThan(composerAfter!.y - 24);
    const overlayBox = await page.locator(".chat-main > .chat-thread-overlay").boundingBox();
    expect(overlayBox!.width).toBeCloseTo(jumpBox!.width, 0);
    await expect.poll(() => viewport.evaluate((el, y) => {
      const hit = document.elementFromPoint(el.getBoundingClientRect().left + 24, y);
      return el.contains(hit);
    }, jumpBox!.y + jumpBox!.height / 2)).toBe(true);
    await jump.click();
    await expect(jump).toBeHidden();
    await assertSingleViewport();
    const [viewportBox, lastMessageBox] = await Promise.all([
      viewport.boundingBox(), page.locator(".message.assistant").last().boundingBox()
    ]);
    const bottomGap = viewportBox!.y + viewportBox!.height - lastMessageBox!.y - lastMessageBox!.height;
    expect(bottomGap).toBeGreaterThanOrEqual(0);
    expect(bottomGap).toBeLessThanOrEqual(64);
  }

  await page.setViewportSize({ width: 390, height: 640 });
  const sessionHeader = page.locator(".chat-session-header");
  expect((await sessionHeader.boundingBox())!.height).toBe(44);
  expect((await composer.locator(".composer-input").boundingBox())!.height).toBeLessThanOrEqual(110);
  const regenerate = viewport.getByRole("button", { name: "重新生成回答", exact: true }).last();
  await regenerate.focus();
  await regenerate.press("Enter");
  const undo = page.getByRole("status", { name: "撤销替换" });
  await expect(undo).toContainText("生成的图片无法恢复");
  expect((await undo.boundingBox())!.height).toBeLessThanOrEqual(56);
  expect((await viewport.boundingBox())!.height).toBeGreaterThan(300);
  const latest = page.getByRole("button", { name: /回到最新/ });
  await viewport.evaluate(el => { el.scrollTop = 0; });
  await expect(latest).toBeVisible();
  await expect(latest.locator(".chat-jump-latest-label")).toBeHidden();
  expect((await latest.boundingBox())!.width).toBe(44);
  await page.screenshot({ path: testInfo.outputPath("mobile-reading-space.png"), animations: "disabled" });
  await undo.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(undo).toBeHidden();
  await expect(viewport.getByText("重新生成的回答。", { exact: true })).toBeHidden();
});

test("home web search choice reaches the first message and the new conversation", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("tuantuan-theme", "dark"));
  const requests: boolean[] = [];
  await page.route("**/ag-ui", async route => {
    const { threadId, runId, messages, forwardedProps } = route.request().postDataJSON();
    requests.push(forwardedProps.webSearch);
    const userMessage = { id: 101, role: "user", content: messages.at(-1).content, created_at: "2026-09-22T08:00:00Z" };
    const assistantMessage = { id: 102, role: "assistant", content: "这是模拟回复。", created_at: userMessage.created_at };
    const events = [
      { type: "RUN_STARTED", threadId, runId },
      { type: "STATE_SNAPSHOT", snapshot: { tuantuan: { status: "done", userMessage, assistantMessage } } },
      { type: "RUN_FINISHED", threadId, runId },
    ];
    return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  await page.setViewportSize({ width: 1279, height: 1253 });
  await page.goto("/#/home");
  const home = page.getByRole("region", { name: "工作台", exact: true });
  const toggle = home.getByRole("button", { name: "联网搜索" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await toggle.hover();
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await toggle.click();
  await expect(toggle).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.locator(".creation-entry-form").screenshot({ path: testInfo.outputPath("home-web-search-desktop.png") });
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 320, height: 740 });
  for (const name of ["添加资料", "联网搜索", "语音输入", "发送"]) {
    await expect(home.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await expect(toggle.locator("span")).toBeHidden();
  await page.locator(".creation-entry-form").screenshot({ path: testInfo.outputPath("home-web-search-mobile.png") });
  await home.getByRole("textbox", { name: "工作台草稿" }).fill("查找最新公开资料");
  await home.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\/2$/);
  await expect.poll(() => requests).toEqual([true]);
  const chatToggle = page.getByRole("button", { name: "联网搜索", exact: true });
  await expect(chatToggle).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(chatToggle).toHaveAttribute("aria-pressed", "true");
  expect(requests).toEqual([true]);
});

test("home web search stays visible and disabled when the service is unavailable", async ({ page }) => {
  await page.route("**/agent/capabilities", route => route.fulfill({ json: {
    configured: true, active_model_name: "mock-model", tools: [], web_research: { enabled: false, provider: "none" },
  } }));
  await page.goto("/#/home");
  const toggle = page.getByRole("region", { name: "工作台", exact: true }).getByRole("button", { name: "联网搜索" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAttribute("title", "联网搜索服务未启用");
});

test("web search consent is explicit and persists only for the selected conversation", async ({ page }, testInfo) => {
  const requests: Array<{ threadId: string; webSearch: boolean }> = [];
  await page.addInitScript(() => localStorage.setItem("tuantuan-theme", "dark"));
  await page.setViewportSize({ width: 512, height: 850 });
  await page.route("**/ag-ui", async route => {
    const { threadId, runId, messages, forwardedProps } = route.request().postDataJSON();
    requests.push({ threadId, webSearch: forwardedProps.webSearch });
    const created_at = "2026-09-22T08:00:00Z";
    const userMessage = { id: requests.length * 2, role: "user", content: messages.at(-1).content, created_at };
    const assistantMessage = { id: userMessage.id + 1, role: "assistant", content: "这是模拟回复。", created_at };
    const events = [
      { type: "RUN_STARTED", threadId, runId },
      { type: "STATE_SNAPSHOT", snapshot: { tuantuan: { status: "done", userMessage, assistantMessage } } },
      { type: "RUN_FINISHED", threadId, runId },
    ];
    return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  });
  await page.goto("/#/chat/1");
  const toggle = page.getByRole("button", { name: "联网搜索", exact: true });
  async function send(content: string, threadId: string, webSearch: boolean) {
    await page.getByRole("textbox", { name: "输入消息" }).fill(content);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => requests.at(-1)).toEqual({ threadId, webSearch });
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  }
  await expect(toggle).toBeEnabled();
  await expect(toggle.locator(".composer-tool-label")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.locator(".chat-composer").screenshot({ path: testInfo.outputPath("web-search-off.png") });
  await send("请查看最新资讯", "1", false);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(toggle).toHaveCSS("box-shadow", "none");
  await expect(toggle.locator("svg")).toHaveCSS("stroke-width", "2.75px");
  await page.locator(".chat-composer").screenshot({ path: testInfo.outputPath("web-search-on.png") });
  await send("查找公开研究资料", "1", true);
  await send("再核实另一条信息", "1", true);
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\/2$/);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await send("请总结背景", "2", false);
  await page.goto("/#/chat/1");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await send("继续整理已有资料", "1", false);
  expect(requests).toHaveLength(5);
});

test("AI workspace keeps one reading axis and switches history rail by breakpoint", async ({ page }) => {
  const evidenceDir = process.env.CI ? resolve("..", "..", "output", "playwright") : resolve("..", "tmp", "playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.goto("/#/chat/1");
  await expect(page.getByRole("heading", { name: "今天，想完成什么？" })).toBeVisible();
  await expect(page.getByRole("button", { name: "联网搜索" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "搜索类别" })).toHaveCount(0);
  await page.getByRole("button", { name: "对话记录" }).click();

  for (const viewport of [
    { width: 960, height: 800, mode: "drawer" },
    { width: 1280, height: 820, mode: "rail" },
    { width: 1440, height: 900, mode: "rail" }
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const panel = page.locator(".conversation-history-panel");
    const main = page.locator(".chat-main");
    const composer = page.locator(".composer-input");
    const header = page.locator(".chat-session-header");

    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("position", viewport.mode === "drawer" ? "absolute" : "relative");
    const [mainBox, composerBox, headerBox] = await Promise.all([
      main.boundingBox(),
      composer.boundingBox(),
      header.boundingBox()
    ]);
    expect(mainBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.x).toBeCloseTo(mainBox!.x, 0);
    expect(headerBox!.width).toBeCloseTo(mainBox!.width, 0);
    expect(composerBox!.width).toBeGreaterThanOrEqual(600);
    expect(composerBox!.width).toBeLessThanOrEqual(900);
    expect(composerBox!.x).toBeGreaterThanOrEqual(mainBox!.x + 15);
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width - 15);

    await page.screenshot({
      path: resolve(evidenceDir, `chat-workspace-${viewport.width}.png`),
      fullPage: true,
      animations: "disabled"
    });
    // Pixel baselines are macOS-specific. Linux still checks geometry and
    // interactions and emits the same screenshots for review.
    if (process.platform === "darwin") {
      // Collect every breakpoint's diff in one run; any mismatch still fails
      // the test and the required CI gate.
      await expect.soft(page).toHaveScreenshot(`chat-workspace-${viewport.width}.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.01
      });
    }
  }
});

test("keyboard leaves the account menu and returns focus after closing history dialogs", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 800 });
  await page.goto("/#/chat/1");
  const account = page.getByRole("button", { name: "账号菜单" });
  const accountMenu = page.getByRole("menu", { name: "账号菜单" });
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeFocused();
  await account.press("ArrowDown");
  await expect(accountMenu.getByRole("menuitem", { name: "账号与安全" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(accountMenu).toBeHidden();
  await expect(account).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "对话记录", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "对话记录" });
  const trigger = panel.getByRole("button", { name: "资料研究 的更多操作" });
  const menu = panel.getByRole("menu", { name: "资料研究 的操作" });
  await trigger.press("ArrowDown");
  const rename = menu.getByRole("menuitem", { name: "重命名" });
  await expect(rename).toBeFocused();
  const [panelBox, menuBox] = await Promise.all([panel.boundingBox(), menu.boundingBox()]);
  expect(menuBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(trigger).toBeFocused();

  await trigger.press("ArrowDown");
  await expect(rename).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "重命名对话" });
  const title = dialog.getByRole("textbox", { name: "对话名称" });
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("资料研究");
  const evidenceDir = process.env.CI ? resolve("..", "..", "output", "playwright") : resolve("..", "tmp", "playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, "shadcn-history-rename.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "删除" }).click();
  const alert = page.getByRole("alertdialog", { name: "删除对话" });
  const cancel = alert.getByRole("button", { name: "取消" });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(alert).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("scrolling a conversation out of the history list closes its menu", async ({ page }) => {
  await page.route("http://127.0.0.1:4173/conversations", (route) => route.fulfill({
    json: [conversation, ...Array.from({ length: 30 }, (_, index) => ({
      ...conversation, id: index + 2, title: `历史对话 ${index + 2}`
    }))]
  }));
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto("/#/chat/1");
  await page.getByRole("button", { name: "对话记录", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "对话记录" });
  const trigger = panel.getByRole("button", { name: "资料研究 的更多操作" });
  const list = panel.locator(".conversation-history-list");
  await trigger.click();
  await expect(panel.getByRole("menu")).toBeVisible();
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByRole("menu")).toBeHidden();
});

test("retired career routes are not recognized and open home", async ({ page }) => {
  for (const legacyRoute of ["/#/opportunities", "/#/interview-prep", "/#/knowledge"]) {
    await page.goto(legacyRoute);
    await expect(page).toHaveURL(/#\/home$/);
    await expect(page.getByRole("region", { name: "团团首页" })).toBeVisible();
  }
  await expect(page.getByText("职位机会", { exact: true })).toHaveCount(0);
});


test("the creation homepage fills inspiration into the single workbench draft", async ({ page }, testInfo) => {
  const sizes = ["auto", "1536x1024", "768x512", "1024x1536"];
  await page.addInitScript(() => localStorage.setItem("tuantuan-theme", "dark"));
  await page.route("**/projects", route => route.fulfill({ json: { items: [
    { id: "game-ui", name: "游戏 UI 设计", status: "active" },
    { id: "archived", name: "已归档项目", status: "archived" },
  ] } }));
  await page.route("**/image-studio/options", route => route.fulfill({ json: {
    default_profile_id: "skill-image", models: [{ id: "skill-image", name: "Fixture Image", sizes }],
  } }));
  await page.route("**/documents", route => route.fulfill({ json: { documents: [] } }));
  await page.route("**/agent/model-selection/preview", route => route.fulfill({ json: {
    ...imageSkillPreview, selection: { ...imageSkillPreview.selection, sizes },
  } }));
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path !== "/agent/model-selection/preview") writes.push(path);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/home");
  const entry = page.getByRole("region", { name: "工作台" });
  const inspiration = entry.getByRole("region", { name: "探索创作灵感" });
  const projects = page.getByRole("navigation", { name: "工作区快捷入口" });
  await expect(entry.getByRole("group", { name: "创作方式" })).toHaveCount(0);
  const shortcuts = entry.getByRole("group", { name: "创作快捷入口" });
  await expect(projects.getByRole("button", { name: "我的项目" })).toHaveAttribute("aria-expanded", "true");
  await expect(projects.getByRole("button", { name: "最近记录" })).toHaveAttribute("aria-expanded", "true");
  await expect(projects.getByRole("button", { name: "游戏 UI 设计" })).toBeVisible();
  await expect(projects.getByText("已归档项目")).toHaveCount(0);
  await expect(inspiration.locator("img")).toHaveCount(3);
  await expect.poll(() => inspiration.locator("img").evaluateAll(images =>
    images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(inspiration.getByRole("button", { name: "游戏道具创作" })).toBeInViewport({ ratio: 1 });
  const draft = entry.getByRole("textbox", { name: "工作台草稿" });
  const initialHeight = await draft.evaluate(element => element.getBoundingClientRect().height);
  const multilinePrompt = "一座面朝大海的灯塔\n清晨薄雾\n远处有帆船\n用低饱和色表现光线";
  await draft.fill(multilinePrompt);
  await expect.poll(() => draft.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(initialHeight);
  await entry.locator("form").screenshot({ path: testInfo.outputPath("creation-composer-focused.png"), animations: "disabled" });
  await draft.press("End");
  await draft.press("Enter");
  await expect(draft).toHaveValue(`${multilinePrompt}\n`);
  await expect(page).toHaveURL(/#\/home$/);
  await draft.fill(Array.from({ length: 20 }, () => "灯塔").join("\n"));
  await expect.poll(() => draft.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await draft.fill("");
  await draft.blur();
  await expect.poll(() => draft.evaluate(element => element.getBoundingClientRect().height)).toBe(initialHeight);
  await entry.locator("form").screenshot({ path: testInfo.outputPath("creation-composer.png"), animations: "disabled" });
  await page.screenshot({ path: testInfo.outputPath("creation-home-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(projects).toBeHidden();
  await expect(page.getByRole("navigation", { name: "移动端主导航" })
    .getByRole("link", { name: "我的项目", exact: true })).toBeInViewport();
  await expect(entry.getByRole("button", { name: "添加资料", exact: true })).toBeInViewport();
  await expect(entry.getByRole("button", { name: "发送" })).toBeInViewport();
  await expect(inspiration.getByRole("button", { name: "游戏道具创作" })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("creation-home-mobile-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });

  const sidebar = page.locator("aside.sidebar");
  const recentRecords = projects.getByRole("button", { name: "最近记录" });
  await recentRecords.click();
  await expect(recentRecords).toHaveAttribute("aria-expanded", "false");
  await expect(projects.getByRole("button", { name: "游戏 UI 设计" })).toBeVisible();
  await sidebar.getByRole("button", { name: "收起侧边栏" }).click();
  const expand = sidebar.getByRole("button", { name: "展开侧边栏" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(72);
  await expect(projects).toBeHidden();
  await expect(sidebar.getByRole("link", { name: "我的项目", exact: true })).toBeInViewport();
  await expect(sidebar.getByRole("link", { name: "设置", exact: true })).toBeInViewport();
  await expect(entry.getByRole("button", { name: "语音输入", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("creation-home-sidebar-collapsed.png"), animations: "disabled" });
  await expand.press("Enter");
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(176);
  await expect(recentRecords).toHaveAttribute("aria-expanded", "false");
  await sidebar.getByRole("link", { name: "我的作品", exact: true }).click();
  await expect(page).toHaveURL(/#\/works$/);
  await page.goBack();
  await expect(recentRecords).toHaveAttribute("aria-expanded", "false");
  await expect(projects.getByRole("button", { name: "游戏 UI 设计" })).toBeVisible();
  await recentRecords.press("Space");
  await expect(recentRecords).toHaveAttribute("aria-expanded", "true");
  await expect(projects.getByRole("button", { name: "图片：海边海报" })).toBeVisible();

  await shortcuts.getByRole("button", { name: "文档" }).click();
  const documents = page.getByRole("dialog", { name: "文档成果" });
  await expect(documents).toBeVisible();
  await documents.getByRole("button", { name: "关闭文档成果" }).click();
  await inspiration.getByRole("button", { name: "电商设计" }).click();
  await expect(inspiration.locator("img")).toHaveCount(1);
  await inspiration.getByRole("button", { name: "商品宣传设计" }).click();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(/浅鼠尾草绿/);
  await expect(entry.getByRole("combobox")).toHaveCount(0);
  await shortcuts.getByRole("button", { name: "智能体" }).click();
  await expect(page).toHaveURL(/#\/skills$/);
  // 灵感只填入草稿，不会自动发送。
  expect(writes).toEqual([]);
});

test("home voice input edits the workbench draft and finishes before sending", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const context = new AudioContext({ sampleRate: 16_000 });
      await context.resume();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      const track = destination.stream.getTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { stop(); void context.close(); };
      return destination.stream;
    } });
  });
  await page.route("**/speech/prepare", route => route.fulfill({ json: { state: "ready", error: "" } }));
  let sessions = 0;
  const closed: string[] = [];
  let pendingAudio = false;
  let releaseAudio!: () => void;
  const audioGate = new Promise<void>(resolve => { releaseAudio = resolve; });
  await page.route("**/speech/sessions", route => route.fulfill({ json: { id: `home-${++sessions}` } }));
  await page.route(/\/speech\/sessions\/home-\d+\/audio\?/, async route => {
    const url = route.request().url();
    if (url.includes("/home-3/")) {
      pendingAudio = true;
      await audioGate;
      return route.fulfill({ json: { updates: [{ segmentId: 0, revision: 1, text: "最后", final: false }] } });
    }
    const imageSession = url.includes("/home-1/");
    return route.fulfill({ json: { updates: [{ segmentId: 0, revision: 1, text: imageSession ? "晚霞" : "会议纪要", final: true }] } });
  });
  await page.route(/\/speech\/sessions\/home-[123]\/finish\?/, route => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    expect(Number(url.searchParams.get("sequence"))).toBeGreaterThan(0);
    closed.push(id);
    const updates = id === "home-3" ? [{ segmentId: 0, revision: 2, text: "最后一句。", final: true }] : [];
    return route.fulfill({ json: { updates } });
  });
  await page.route(/\/speech\/sessions\/home-\d+$/, route => {
    expect(route.request().method()).toBe("DELETE");
    closed.push(new URL(route.request().url()).pathname.split("/").pop()!);
    return route.fulfill({ json: { closed: true } });
  });
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && !path.startsWith("/speech/") && path !== "/agent/model-selection/preview") writes.push(path);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/home");
  const entry = page.getByRole("region", { name: "工作台" });
  const mic = entry.getByRole("button", { name: "语音输入", exact: true });
  const stop = entry.getByRole("button", { name: "停止语音输入", exact: true });
  const draft = entry.getByRole("textbox", { name: "工作台草稿" });
  await draft.fill("画面：海边");
  await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(3, 3));
  await expect(mic).toBeInViewport();
  await mic.click();
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(draft).toHaveValue("画面：晚霞海边");
  await stop.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => closed).toEqual(["home-1"]);

  await draft.fill("请整理");
  await mic.click();
  await expect(draft).toHaveValue("请整理会议纪要");
  await stop.click();
  await expect.poll(() => closed).toEqual(["home-1", "home-2"]);

  await draft.fill("海报：");
  await mic.click();
  try {
    await expect.poll(() => pendingAudio).toBe(true);
    await entry.getByRole("button", { name: "发送" }).click();
    await expect(entry.getByText("正在完成转写…")).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
  } finally {
    releaseAudio();
  }
  // 转写完成后直接把最终文字发进对话。
  await expect(page.getByText("海报：最后一句。", { exact: true }).first()).toBeVisible();
  expect(closed).toEqual(["home-1", "home-2", "home-3"]);
  await expect.poll(() => writes).toEqual(["/conversations", "/ag-ui"]);
});

test("home restores the workbench draft after refresh", async ({ page }) => {
  await page.goto("/#/home");
  const entry = page.getByRole("region", { name: "工作台" });
  const draft = entry.getByRole("textbox", { name: "工作台草稿" });
  await draft.fill("海边夜景");
  await page.reload();
  await expect(draft).toHaveValue("海边夜景");
  await expect(entry.getByRole("combobox")).toHaveCount(0);
});

test("the unified entry sends chat and image requests from one input", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // Model selection preview is read-only, even though it uses POST.
    if (path !== "/agent/model-selection/preview" && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(path);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/home");
  const entry = page.getByRole("region", { name: "工作台" });
  await expect(entry.getByRole("group", { name: "创作方式" })).toHaveCount(0);
  await entry.getByRole("textbox", { name: "工作台草稿" }).fill("整理调研结果");
  expect(writes).toEqual([]);
  const screenshots = resolve("..", "tmp", "v2-creation-entry");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, "mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(screenshots, "desktop.png"), animations: "disabled" });
  await entry.getByRole("button", { name: "发送" }).click();
  // 发送后直接进入对话并发起运行，不再停在第二个输入框里等待确认。
  await expect.poll(() => writes).toEqual(["/conversations", "/ag-ui"]);
  await expect(page).toHaveURL(/#\/chat\/\d+$/);
});

test("home keeps draft files and uploads only on request", async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path !== "/agent/model-selection/preview") writes.push(path);
  });
  const attachment = { id: "draft-note", kind: "document", original_filename: "资料.md", parse_status: "parsed" };
  let attempts = 0;
  await page.route("**/attachments", route => {
    expect(route.request().postDataBuffer()?.toString()).toContain('name="conversation_id"\r\n\r\n2');
    if (++attempts === 1) return route.fulfill({ status: 400, json: { detail: "测试上传失败" } });
    return route.fulfill({ json: attachment });
  });
  await page.route("**/attachments/draft-note/parse", route => route.fulfill({ json: attachment }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/home");
  const entry = page.getByRole("region", { name: "工作台" });
  await expect(entry.getByRole("button", { name: "添加资料", exact: true })).toBeVisible();
  await entry.locator('input[type="file"]').setInputFiles([
    { name: "资料.md", mimeType: "text/markdown", buffer: Buffer.from("# 测试资料") },
    { name: "不支持.exe", mimeType: "application/octet-stream", buffer: Buffer.from("invalid") },
  ]);
  await expect(entry.getByRole("alert")).toContainText("不支持的文件未添加");
  await entry.getByRole("textbox", { name: "工作台草稿" }).fill("整理这份资料");
  expect(writes).toEqual([]);
  await expect(entry.getByRole("list", { name: "对话草稿附件" })).toContainText("资料.md");
  const screenshot = testInfo.outputPath("creation-draft-attachments.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("首页附件草稿", { path: screenshot, contentType: "image/png" });
  await entry.getByRole("button", { name: "发送" }).click();
  const editor = page.getByRole("textbox", { name: "输入消息" });
  await expect(editor).toHaveText("整理这份资料");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await editor.press("Enter");
  await expect(editor).toHaveText("整理这份资料");
  const upload = page.getByRole("button", { name: "上传 资料.md" });
  await expect(upload).toBeVisible();
  expect(writes).toEqual(["/conversations"]);
  await upload.click();
  await expect(page.getByText("测试上传失败", { exact: true })).toBeVisible();
  await expect(upload).toBeEnabled();
  await upload.click();
  await expect(page.getByRole("button", { name: "预览 资料.md" })).toBeVisible();
  await expect(upload).toHaveCount(0);
  await expect(editor).toHaveText("整理这份资料");
  expect(writes).toEqual(["/conversations", "/attachments", "/attachments", "/attachments/draft-note/parse"]);
});

test("home and library use current sources and stay usable on narrow screens", async ({ page }) => {
  for (const width of [375, 960, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/dashboard");
    await expect(page.getByRole("heading", { name: "让想法成为现实", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看完整资讯" }).click();
    const aiTab = page.getByRole("tab", { name: /AI 动态/ });
    await aiTab.click();
    await expect(page.getByRole("heading", { name: "模型动态", exact: true })).toBeVisible();
    await aiTab.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "技术热榜" })).toBeFocused();
    await expect(page.getByRole("heading", { name: "GitHub 热榜", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.goto("/#/library");
    await expect(page.getByRole("table", { name: "文件列表" })).toBeVisible();
    await expect(page.getByRole("button", { name: "操作 读书笔记" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "文件类型" })).toHaveText("全部图像文档视频");
    await expect(page.getByRole("textbox", { name: "搜索文件名或内容" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: resolve("..", "..", "output", "playwright", `library-${width}.png`), fullPage: true });
  }
});
