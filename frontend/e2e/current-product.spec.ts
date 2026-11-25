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

for (const theme of ["light", "dark", "blue"] as const) {
  test(`sidebar account and logo control remain reachable in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("tuantuan-theme", value), theme);
    await page.setViewportSize({ width: 874, height: 770 });
    await page.goto("/#/chat/1");
    const sidebar = page.locator("aside.sidebar");
    const account = page.getByRole("button", { name: "账号菜单", exact: true });
    const evidenceDir = resolve("..", "..", "output", "sidebar-navigation");
    await mkdir(evidenceDir, { recursive: true });

    for (const width of [874, 1280]) {
      await page.setViewportSize({ width, height: 770 });
      await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button")).toHaveText([
        "对话", "图片", "视频", "我的作品", "设置"
      ]);

      for (const collapsed of [false, true]) {
        const toggle = page.getByRole("button", { name: collapsed ? "展开侧边栏" : "收起侧边栏", exact: true });
        await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed));
        await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(collapsed ? 72 : 232);
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
        await expect(menu.getByRole("menuitem")).toHaveText(["账号与安全", "设置", "退出登录"]);
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

test("mobile navigation keeps settings reachable through the account menu", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tuantuan-sidebar:e2e@local.test", "collapsed"));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 770 });
    await page.goto("/#/chat/1");
    const navigation = page.getByRole("navigation", { name: "移动端主导航" });
    await expect(navigation.getByRole("button")).toHaveText([
      "对话", "图片", "视频", "我的作品", "设置"
    ]);
    const labels = await navigation.locator(".mobile-nav-item span").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }));
    expect(labels).toHaveLength(5);
    for (let index = 1; index < labels.length; index += 1) {
      expect(labels[index].left).toBeGreaterThanOrEqual(labels[index - 1].right - 1);
    }
    await navigation.getByRole("button", { name: "图片", exact: true }).click();
    await expect(page).toHaveURL(/#\/images$/);
    await expect(page.getByRole("region", { name: "图片创作工作台" })).toBeVisible();
    await navigation.getByRole("button", { name: "视频", exact: true }).click();
    await expect(page.getByText("视频生成尚未接入。")).toBeVisible();
    await navigation.getByRole("button", { name: "我的作品", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的作品", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "去图片创作", exact: true }).click();
    await expect(page).toHaveURL(/#\/images$/);
    await navigation.getByRole("button", { name: "对话", exact: true }).click();
    await expect(page).toHaveURL(/#\/chat\/1$/);
    await expect(page.getByRole("button", { name: /[收展][起开]侧边栏/ })).toBeHidden();
    await expect(page.locator("aside.sidebar")).toHaveClass(/collapsed/);
    await expect(page.getByRole("button", { name: "返回首页", exact: true })).toBeInViewport();
    const account = page.getByRole("button", { name: "账号菜单", exact: true });
    await expect(account).toBeInViewport();
    await account.click();
    const menu = page.getByRole("menu", { name: "账号菜单" });
    await expect(menu.getByRole("menuitem")).toHaveText(["账号与安全", "设置", "退出登录"]);
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(770);
    await menu.getByRole("menuitem", { name: "设置", exact: true }).click();
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
  const panel = page.getByRole("complementary", { name: "对话记录" });
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
  for (const legacyRoute of ["/#/opportunities", "/#/interview-prep", "/#/projects", "/#/knowledge"]) {
    await page.goto(legacyRoute);
    await expect(page).toHaveURL(/#\/home$/);
    await expect(page.getByRole("region", { name: "开发者首页" })).toBeVisible();
  }
  await expect(page.getByText("职位机会", { exact: true })).toHaveCount(0);
});


test("home and library use current sources and stay usable on narrow screens", async ({ page }) => {
  for (const width of [375, 960, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/dashboard");
    await expect(page.getByRole("heading", { name: /测试用户/ })).toBeVisible();
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
