import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "./test-fixtures";

const copyTestBaseURL = process.env.COPY_TEST_BASE_URL ?? "http://127.0.0.1:4173";
test.use({ baseURL: copyTestBaseURL });

const userMessage = "请帮我整理这段中文：\n第一行是用户原话。\n第二行保留换行和标点！";
const assistantMessage = "整理结果如下：\n\n第一项：保留中文内容。\n第二项：原样保留多行文本。";
const copyError = "复制失败，请检查权限或手动选择复制";
const staleClipboard = "旧控制台日志：这不是消息内容";

async function openConversation(page: Page, userContent = userMessage) {
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "chat-copy-e2e-token");
    localStorage.setItem("tuantuan-first-run:copy@local.test", "done");
  });
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "copy@local.test", display_name: "测试读者", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
    "/conversations": [{ id: 1, title: "复制测试", status: "active", summary: "", message_count: 2, task_status: "active", updated_at: "2026-10-17T00:00:00Z" }],
    "/chat/messages": [
      { id: 1, role: "user", content: userContent, created_at: "2026-10-17T00:00:00Z" },
      { id: 2, role: "assistant", content: assistantMessage, created_at: "2026-10-17T00:00:01Z" }
    ],
    "/agent/runs/current": { run: null },
    "/presentations": { jobs: [], next_cursor: null },
    "/document-reviews": { jobs: [] },
    "/agent/capabilities": { configured: true, active_model_name: "example-model", tools: [], web_research: { enabled: false, provider: "none" } },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] }
  };
  await page.route(`${copyTestBaseURL}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    return path in responses ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 404, json: { detail: `Unhandled copy test route: ${path}` } });
  });
  await page.goto("/#/chat/1");
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeVisible();
}

async function clickCopy(page: Page, role: "user" | "assistant") {
  const message = page.locator(`.message.${role}`);
  await message.scrollIntoViewIfNeeded();
  await message.hover();
  await message.getByRole("button", { name: role === "user" ? "复制消息" : "复制回答", exact: true }).click();
  return message;
}

async function seedClipboard(page: Page) {
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill(staleClipboard);
  await composer.press("ControlOrMeta+A");
  await composer.press("ControlOrMeta+C");
  await composer.fill("");
  await composer.press("ControlOrMeta+V");
  await expect(composer).toHaveValue(staleClipboard);
  await composer.fill("");
}

async function expectCopiedIntoComposer(page: Page, role: "user" | "assistant", expected: string) {
  const message = await clickCopy(page, role);
  await expect(message.getByText("已复制", { exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("");
  await composer.focus();
  await composer.press("ControlOrMeta+V");
  await expect(composer).toHaveValue(expected);
}

// Chromium contexts can otherwise overwrite the same system clipboard in parallel.
test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("copies user and assistant messages to the real clipboard for pasting", async ({ page }) => {
  await openConversation(page);
  // Start with a real, known stale clipboard value so an unchanged clipboard cannot pass.
  await seedClipboard(page);
  await expectCopiedIntoComposer(page, "user", userMessage);
  // The second copy must replace the previous message rather than paste it again.
  await expectCopiedIntoComposer(page, "assistant", assistantMessage);
});

test("uses the real legacy copy command when navigator.clipboard is unavailable", async ({ page }) => {
  await openConversation(page);
  await seedClipboard(page);
  // Hide only the modern API; document.execCommand and clipboard contents remain real.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
  expect(await page.evaluate(() => navigator.clipboard === undefined)).toBe(true);
  const user = await clickCopy(page, "user");
  await expect(user.getByText("已复制", { exact: true })).toBeVisible();
  const messageText = user.locator(".message-dialog");
  await messageText.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const selectedText = await page.evaluate(() => window.getSelection()?.toString());
  expect(selectedText).toBe(userMessage);
  await user.getByRole("button", { name: "复制消息", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selectedText);
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.focus();
  await composer.press("ControlOrMeta+V");
  await expect(composer).toHaveValue(userMessage);
  await expectCopiedIntoComposer(page, "assistant", assistantMessage);
});

test("keeps the copy failure visible after focus and pointer leave on a narrow screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openConversation(page, "好");
  // A rejected write is distinct from an absent modern API and must surface an error.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Clipboard permission denied", "NotAllowedError"))
    });
  });
  const message = await clickCopy(page, "user");
  const feedback = message.getByText(copyError, { exact: true });
  await expect(feedback).toBeVisible();
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.focus();
  await page.mouse.move(1, 1);
  await expect(composer).toBeFocused();
  await expect(message.locator(":focus")).toHaveCount(0);
  await expect(message).not.toHaveClass(/is-latest/);
  await expect(message.locator(".message-actions")).toHaveCSS("opacity", "1");
  await expect(feedback).toBeVisible();
  // Error feedback must outlive the normal success-feedback dismissal timer.
  await page.waitForTimeout(3200);
  await expect(feedback).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect.poll(() => page.getByRole("log").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const box = (await feedback.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(321);
  for (const button of await message.locator(".message-actions button").all()) {
    const buttonBox = (await button.boundingBox())!;
    expect(buttonBox.x).toBeGreaterThanOrEqual(0);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(321);
  }
  await feedback.scrollIntoViewIfNeeded();
  const output = resolve(testInfo.config.rootDir, "..", "..", "output", "chat-copy");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "copy-error-320.png"), fullPage: true });
});
