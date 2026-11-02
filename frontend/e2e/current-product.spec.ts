import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

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

async function mockCurrentProduct(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("tuantuan-auth-token", "e2e-token");
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
    if (path === "/conversations") return route.fulfill({ json: [conversation] });
    if (path === "/chat/messages") return route.fulfill({ json: [] });
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

for (const theme of ["light", "dark"] as const) {
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
        "首页", "AI 工作区", "文件库"
      ]);

      for (const collapsed of [false, true]) {
        const toggle = page.getByRole("button", { name: collapsed ? "展开侧边栏" : "收起侧边栏", exact: true });
        await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed));
        await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(collapsed ? 72 : 232);
        const themeShortcut = sidebar.getByRole("button", { name: /切换到[浅深]色主题/ });
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
    await expect(page.getByRole("navigation", { name: "移动端主导航" }).getByRole("button")).toHaveText([
      "首页", "AI 工作区", "文件库"
    ]);
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

test("long conversations keep one scroll viewport without blank space above the composer", async ({ page }) => {
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
  await page.route("**/chat/messages?*", route => route.fulfill({ json: messages }));
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
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(140);
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
    await assertSingleViewport();
    const [viewportBox, lastMessageBox] = await Promise.all([
      viewport.boundingBox(), page.locator(".message.assistant").last().boundingBox()
    ]);
    const bottomGap = viewportBox!.y + viewportBox!.height - lastMessageBox!.y - lastMessageBox!.height;
    expect(bottomGap).toBeGreaterThanOrEqual(0);
    expect(bottomGap).toBeLessThanOrEqual(64);
  }
});

test("AI workspace keeps one reading axis and switches history rail by breakpoint", async ({ page }) => {
  const evidenceDir = process.env.CI ? resolve("..", "..", "output", "playwright") : resolve("..", "tmp", "playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.goto("/#/chat/1");
  await expect(page.getByRole("heading", { name: "今天，想完成什么？" })).toBeVisible();
  await expect(page.getByRole("button", { name: "联网搜索" })).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: "模型动态", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "GitHub 热榜", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.goto("/#/library");
    await expect(page.getByRole("table", { name: "文件列表" })).toBeVisible();
    await expect(page.getByRole("button", { name: "操作 读书笔记" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "文件类型" })).toHaveText("全部图片文档视频");
    await expect(page.getByRole("textbox", { name: "搜索文件名或内容" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: resolve("..", "..", "output", "playwright", `library-${width}.png`), fullPage: true });
  }
});
