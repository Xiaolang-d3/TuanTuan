import { randomUUID } from "node:crypto";
import { expect, seedFirstRunDone, test } from "./test-fixtures";

// The real FastAPI e2e server serves this checkout's frontend/dist, not Vite's
// development server. CI must restore the candidate build before starting it.
test.use({ baseURL: "http://127.0.0.1:4184" });

test("core smoke: account imports a file, chats with it and reloads saved history", async ({ page }) => {
  test.setTimeout(90_000);
  const email = `smoke-${randomUUID()}@local.test`;
  const password = "synthetic-core-smoke-password";
  const fact = "核心冒烟资料：每周整理一次阅读笔记。";
  const question = "根据我的知识库回答：多久整理一次阅读笔记？";

  // Onboarding is unrelated to this deployment check; only its local UI flag is
  // seeded. Registration, file operations and chat all use the actual APIs.
  await seedFirstRunDone(page, email);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /创建本地账户|欢迎登录/ })).toBeVisible();
  if (await page.getByRole("button", { name: "没有账号？创建账号", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "没有账号？创建账号", exact: true }).click();
  }
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("button", { name: "账号菜单", exact: true })).toBeVisible();
  await page.goto("/#/library");
  const upload = page.getByLabel("选择上传文件", { exact: true });
  await expect(upload).toBeAttached();

  // A reload must restore this account through the backend, not merely leave a
  // token in browser storage. This also verifies that authenticated UI boots.
  const restoredIdentity = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/auth/me" && response.request().method() === "GET"
  );
  await page.reload();
  const identity = await restoredIdentity;
  expect(identity.ok()).toBe(true);
  expect((await identity.json()).user.email).toBe(email);
  await expect(upload).toBeAttached();

  await upload.setInputFiles({
    name: "core-smoke.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(fact)
  });
  const files = page.getByRole("table", { name: "文件列表", exact: true });
  await expect(files.locator("tbody tr")).toHaveCount(1, { timeout: 20_000 });
  await expect(files).toContainText("core-smoke.md");
  await files.getByRole("button", { name: "预览 core-smoke", exact: true }).click();
  const preview = page.getByRole("complementary", { name: "文件快速预览", exact: true });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "AI 读取内容", exact: true }).click();
  await expect(preview).toContainText(fact);
  const longTermUse = preview.getByRole("checkbox", { name: "长期使用", exact: true });
  await expect(longTermUse).toBeEnabled({ timeout: 20_000 });
  // The controlled checkbox changes after the API save, not on the click itself.
  await longTermUse.click();
  await expect(longTermUse).toBeChecked();
  await preview.getByRole("button", { name: "关闭快速预览", exact: true }).click();

  await page.goto("/#/chat");
  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill(question);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const log = page.getByRole("log");
  // LocalTestModel emits this prefix only after the real Agent runtime has read
  // library evidence. The unique account has exactly one available source.
  const answer = log.getByRole("region", { name: "输出结果", exact: true });
  await expect(answer).toContainText("已根据资料库完成：", { timeout: 20_000 });
  await expect(answer).toContainText("每周整理一次阅读笔记");
  await expect(log.getByRole("button", { name: "重新生成回答", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/chat\/\d+$/);
  const conversationUrl = page.url();

  await page.reload();
  await expect(page).toHaveURL(conversationUrl);
  await expect(log).toContainText(question);
  await expect(answer).toContainText("已根据资料库完成：");
  await expect(answer).toContainText("每周整理一次阅读笔记");
});
