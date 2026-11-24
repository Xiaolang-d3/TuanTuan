import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

if (process.env.PROMPT_BAR_BASE_URL) test.use({ baseURL: process.env.PROMPT_BAR_BASE_URL });

test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

test("the mobile prompt bar opens real resource actions without losing a draft", async ({ page, baseURL }) => {
  await page.addInitScript(() => sessionStorage.setItem("tuantuan-auth-token", "prompt-bar-test"));
  const attachment = { id: "prompt-bar-file", kind: "document", original_filename: "notes.txt", parse_status: "parsed" };
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "prompt-bar@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": defaultAgentSettings,
    "/agent/capabilities": { configured: true, active_model_provider: "openai_compatible", active_model_name: "mock-model", active_platform: "local", model_providers: ["openai_compatible"], platforms: ["local"], tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [{ id: 1, title: "资料测试", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-11-02T08:00:00Z" }],
    "/chat/messages": [],
    "/agent/runs/current": { run: null },
    "/presentations": { jobs: [], next_cursor: null },
    "/document-reviews": { jobs: [] },
    "/extensions": { extensions: [], connections: [], execution: { available: false, reason: "测试" } },
    "/attachments": attachment,
    [`/attachments/${attachment.id}/parse`]: attachment
  };
  const posts: string[] = [];
  await page.route(`${baseURL}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/" || pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) return route.continue();
    if (route.request().method() === "POST") posts.push(pathname);
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 404, json: { detail: "Not Found" } });
  });

  await page.goto("/#/chat/1");
  const draft = page.getByRole("textbox", { name: "输入消息" });
  const trigger = page.getByRole("button", { name: "添加资料" });
  const panel = page.getByRole("menu", { name: "资料选项" });
  const upload = panel.getByRole("menuitem", { name: "上传文件" });
  await draft.fill("保留这段草稿");
  await trigger.press("ArrowDown");
  await expect(panel).toBeInViewport({ ratio: 1 });
  await expect(upload).toBeFocused();
  if (process.env.PROMPT_BAR_SCREENSHOT) await page.screenshot({ path: process.env.PROMPT_BAR_SCREENSHOT });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.tap();
  const [filechooser] = await Promise.all([page.waitForEvent("filechooser"), upload.tap()]);
  await filechooser.setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("example notes") });
  await expect(page.getByRole("button", { name: "预览 notes.txt" })).toBeVisible();
  await expect(draft).toHaveValue("保留这段草稿");
  expect(posts).toEqual(["/attachments", `/attachments/${attachment.id}/parse`]);

  await trigger.tap();
  await panel.getByRole("menuitem", { name: "打开文件库" }).tap();
  await expect(page).toHaveURL(/#\/chat\/library$/);
  await page.goBack();
  await expect(draft).toHaveValue("保留这段草稿");
  await expect(panel).toBeHidden();
});
