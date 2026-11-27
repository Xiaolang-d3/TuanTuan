import { expect, test } from "./test-fixtures";

if (process.env.CHAT_INTERACTIONS_BASE_URL) test.use({ baseURL: process.env.CHAT_INTERACTIONS_BASE_URL });
test.use({ viewport: { width: 1400, height: 1000 } });

const citationId = `e_${"a".repeat(32)}`;
const excerpt = "报告中记录的原始验收标准。";

test("shows actual task rows, code changes, source excerpts and explicit approval in chat", async ({ page, baseURL }, testInfo) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "chat-interactions-test");
    localStorage.setItem("tuantuan-first-run:interactions@local.test", "done");
  });
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "interactions@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
    "/conversations": [{ id: 1, title: "项目资料核对", status: "active", summary: "", message_count: 2, task_status: "active", updated_at: "2026-11-02T08:00:00Z" }],
    "/agent/capabilities": { configured: true, active_model_name: "mock-model", tools: [] },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/agent/runs/current": { run: null },
    "/presentations": { jobs: [], next_cursor: null },
    "/document-reviews": { jobs: [] },
    "/chat/messages": [
      { id: 1, role: "user", content: "请根据项目资料核对这项修改。", created_at: "2026-11-02T08:00:00Z" },
      {
        id: 2, role: "assistant", content: `修改依据 [[cite:${citationId}]]\n\n~~~diff\n@@ -1 +1 @@\n- status = 'pending'\n+ status = 'ready'\n~~~`, created_at: "2026-11-02T08:00:10Z",
        payload: { agent: {
          status: "waiting_user", duration_ms: 10000, provider: "test", platform: "local", rounds: 1,
          plan: { steps: [
            { id: "s1", title: "检索项目资料", tool_name: "search_library", status: "done" },
            { id: "s2", title: "核对修改范围", tool_name: "get_library_context", status: "pending" }
          ] },
          evidence: [{ citation_id: citationId, source_kind: "library", source_id: 1, source_revision: "b".repeat(64), block_id: "c".repeat(32), title: "项目验收报告", locator: { kind: "pdf_page", page: 3, precise: true }, excerpt, excerpt_hash: "d".repeat(64) }],
          events: [{ round: 1, tool_call_id: "ask-1", tool_name: "ask_user", status: "waiting_approval", message: "接下来核对哪一部分？", data: { clarification: { question: "接下来核对哪一部分？", options: [{ id: "scope", label: "只核对修改范围", send: "请只核对修改范围" }, { id: "all", label: "核对整个项目", send: "请核对整个项目" }], allow_custom: true } } }]
        } }
      }
    ]
  };
  const posts: string[] = [];
  await page.route(`${baseURL}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/" || pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) return route.continue();
    if (route.request().method() === "POST") posts.push(pathname);
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 404, json: { detail: "Not found" } });
  });

  await page.goto("/#/chat/1");
  await expect(page.getByRole("textbox", { name: "输入消息", exact: true })).toBeVisible();
  await expect(page.locator(".composer-primary-actions").getByText(/团团内核|DeepSeek Harness/)).toHaveCount(0);
  await page.getByRole("button", { name: "展开思考与执行过程" }).click();
  const tasks = page.getByRole("region", { name: "任务步骤" });
  await expect(tasks).toContainText("已完成 1/2");
  await expect(tasks).toContainText("核对修改范围");
  await expect(page.getByText("+ status = 'ready'", { exact: true })).toBeVisible();
  const citation = page.getByRole("button", { name: /核对来源：项目验收报告/ });
  await citation.hover();
  await expect(page.getByRole("tooltip")).toContainText(excerpt);
  if (process.env.CHAT_INTERACTIONS_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath("chat-source-preview.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();

  const approval = page.getByRole("region", { name: "需要你确认后继续" });
  const next = approval.getByRole("button", { name: "继续", exact: true });
  await expect(next).toBeDisabled();
  await approval.getByRole("radio", { name: "只核对修改范围" }).check();
  await expect(next).toBeEnabled();
  expect(posts).toEqual([]);
  if (process.env.CHAT_INTERACTIONS_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath("chat-approval.png"), animations: "disabled" });
});
