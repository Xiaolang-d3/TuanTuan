import { expect, seedFirstRunDone, test } from "./test-fixtures";

const email = "dialogs@local.test";
const createdAt = "2026-11-09T08:00:00Z";
const documentId = "a".repeat(32);
const evidence = {
  citation_id: `e_${"b".repeat(32)}`, source_kind: "library", source_id: 1,
  source_revision: "c".repeat(64), block_id: "d".repeat(32), title: "验收报告",
  locator: { kind: "text_range" }, excerpt: "报告里的验收标准。", excerpt_hash: "e".repeat(64)
};
const markdown = `已核对验收标准 [[cite:${evidence.citation_id}]]`;
const version = { version: 1, parent_document_version: null, created_at: createdAt };
const savedDocument = {
  ...version, document_id: documentId, latest_version: 1, conversation_id: 1, message_id: 2,
  title: "交付结果", markdown, evidence: [evidence], citations: [], resources: [], incomplete: false
};

test.beforeEach(async ({ page, baseURL }) => {
  await seedFirstRunDone(page, email);
  await page.addInitScript(() => sessionStorage.setItem("tuantuan-auth-token", "chat-dialogs-test"));
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email, display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
    "/conversations": [{ id: 1, title: "核对验收标准", status: "active", summary: "", message_count: 2, task_status: "active", updated_at: createdAt }],
    "/agent/capabilities": { configured: true, active_model_name: "mock-model", tools: [] },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/agent/runs/current": { run: null },
    "/presentations": { jobs: [], next_cursor: null },
    "/document-reviews": { jobs: [] },
    "/chat/messages": [
      { id: 1, role: "user", content: "请核对验收标准。", created_at: createdAt },
      {
        id: 2, role: "assistant", content: markdown, created_at: createdAt,
        payload: { agent: { status: "done", provider: "test", platform: "local", rounds: 1, evidence: [evidence], events: [] } }
      }
    ],
    "/chat/messages/2/artifacts": {
      message_id: 2, snapshot: "f".repeat(64), incomplete: false, sources: [evidence],
      artifacts: [{ selector: "answer", kind: "answer", filename: "回答.md", mime_type: "text/markdown", content: markdown, can_index: true }]
    },
    "/conversations/1/documents": savedDocument,
    "/documents": { documents: [savedDocument] },
    [`/documents/${documentId}`]: savedDocument,
    [`/documents/${documentId}/versions`]: { versions: [version] },
    [`/library/sources/1/versions/${evidence.source_revision}/blocks/${evidence.block_id}`]: {
      title: evidence.title, locator: evidence.locator, text: "引用版本的原文", model_text: evidence.excerpt,
      is_current: false, original: { available: false }
    }
  };
  await page.route(`${baseURL}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/" || pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) return route.continue();
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 404, json: { detail: "Not found" } });
  });
});

test("keeps a draft when dismissing the confirmation and restores focus when discarding", async ({ page }) => {
  await page.goto("/#/chat/1");
  const trigger = page.getByRole("button", { name: "编辑文档", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const result = page.getByRole("dialog", { name: "文档编辑" });
  const editor = result.getByRole("textbox", { name: "文档正文" });
  await expect(result.getByRole("button", { name: "关闭文档成果" })).toBeFocused();
  await editor.fill("未保存的草稿。");
  await page.keyboard.press("Escape");
  const confirmation = page.getByRole("alertdialog", { name: "放弃草稿？" });
  const keep = confirmation.getByRole("button", { name: "保留草稿" });
  const discard = confirmation.getByRole("button", { name: "放弃草稿" });
  await expect(keep).toBeFocused();
  await expect(result).toBeHidden();
  await page.keyboard.press("Shift+Tab");
  await expect(discard).toBeFocused();
  await page.mouse.click(4, 4);
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("未保存的草稿。");
  await page.keyboard.press("Escape");
  await discard.click();
  await expect(result).toBeHidden();
  await expect(trigger).toBeFocused();
});

test.describe("touch source verification", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("opens a citation inside the editor on the first tap and returns to it on close", async ({ page }) => {
    await page.goto("/#/chat/1");
    await page.getByRole("button", { name: "编辑文档", exact: true }).tap();
    const editor = page.getByRole("dialog", { name: "文档编辑" });
    await expect(editor.getByRole("textbox", { name: "文档正文" })).toBeVisible();
    await editor.getByRole("button", { name: "预览", exact: true }).tap();
    const citation = editor.getByRole("button", { name: /核对来源：验收报告/ });
    await citation.tap();
    const source = page.getByRole("dialog", { name: "验收报告" });
    await expect(source.getByText("引用版本的原文")).toBeVisible();
    const close = source.getByRole("button", { name: "关闭来源" });
    await expect(close).toBeFocused();
    await expect(editor).toBeHidden();
    await expect(page.getByRole("tooltip")).toBeHidden();
    if (process.env.CHAT_DIALOG_SCREENSHOT) {
      await page.screenshot({ path: process.env.CHAT_DIALOG_SCREENSHOT, animations: "disabled" });
    }
    await close.tap();
    await expect(source).toBeHidden();
    await expect(citation).toBeFocused();
    await expect(citation).toBeVisible();
    await expect(page.getByRole("tooltip")).toBeHidden();
  });
});
