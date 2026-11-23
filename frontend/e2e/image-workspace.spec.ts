import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StudioRequest, StudioTask, StudioWork } from "../src/features/product/imageStudioApi";
import { expect, seedFirstRunDone, test } from "./test-fixtures";

const origin = process.env.IMAGE_WORKSPACE_E2E_ORIGIN || "http://127.0.0.1:4173";
const art = ["studio-purple", "studio-wave", "studio-sunset", "studio-edited"] as const;

function image(id: string, name: string) {
  return { id, origin: "generated" as const, kind: "image" as const, original_filename: name, parse_status: "parsed" as const, width: 740, height: 480 };
}

test("image workspace makes three drafts, restores settings, edits and archives the final result", async ({ page }) => {
  const history: StudioTask[] = [];
  const works: StudioWork[] = [];
  const requests: StudioRequest[] = [];
  const reads: string[] = [];
  const created_at = "2026-11-18T00:00:00Z";
  const output = resolve("..", "tmp", "image-workspace");
  await mkdir(output, { recursive: true });
  await page.addInitScript(() => sessionStorage.setItem("tuantuan-auth-token", "image-workspace-fixture"));
  await seedFirstRunDone(page, "e2e@local.test");
  await page.route(`${origin}/**`, async route => {
    const request = route.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) return route.continue();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api(?=\/)/, "");
    if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email: "e2e@local.test", display_name: "测试用户", has_avatar: false } } });
    if (path === "/system/database-status") return route.fulfill({ json: { status: "ready" } });
    if (path === "/agent/kernels") return route.fulfill({ json: { default_kernel: "tuantuan", choices: [] } });
    if (path === "/channels/weixin") return route.fulfill({ json: { connected: false, enabled: false, error: "" } });
    if (path === "/conversations" || path === "/chat/messages") return route.fulfill({ json: [] });
    if (path === "/agent/runs/current") return route.fulfill({ json: { run: null } });
    if (path === "/agent/capabilities") return route.fulfill({ json: { configured: true, tools: [] } });
    if (path === "/attachments/config") return route.fulfill({ json: { storage: "local", vision_enabled: false, checks: [] } });
    if (path === "/image-studio/options") return route.fulfill({ json: {
      default_profile_id: "square-only", models: [
        { id: "square-only", name: "默认图片模型", sizes: ["auto"] },
        { id: "selected", name: "横图模型", sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"] },
      ],
    } });
    if (path === "/agent/model-selection/preview") {
      const body = request.postDataJSON();
      const candidates = [
        { profile_id: "square-only", model_name: "默认图片模型", service_name: "服务 A", eligible: true, sizes: ["auto"] },
        { profile_id: "selected", model_name: "横图模型", service_name: "服务 B", eligible: true, sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"] },
      ];
      const selection = candidates.find(item => item.profile_id === (body.profile_id || (body.operation === "image.edit" ? "selected" : "square-only")))!;
      return route.fulfill({ json: { eligible: true, selection: { ...selection, reason: "本次使用" }, candidates,
        comparison_key: body.operation === "image.edit" ? "e".repeat(64) : "a".repeat(64), requires_confirmation: body.operation === "image.edit" } });
    }
    if (path === "/image-studio/history") return route.fulfill({ json: { items: history.filter(t =>
      (!url.searchParams.get("q") || t.prompt.includes(url.searchParams.get("q")!)) &&
      (!url.searchParams.get("status") || t.status === url.searchParams.get("status"))
    ), has_more: false } });
    if (path === "/image-studio/generate") {
      const body = request.postDataJSON() as StudioRequest;
      expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(body).toMatchObject({ profile_id: "selected", size: "1536x1024", comparison_key: "a".repeat(64) });
      expect(requests.some(prior => prior.request_id === body.request_id)).toBe(false);
      requests.push(body);
      history.unshift({ id: body.request_id, prompt: body.prompt, size: body.size, profile_id: body.profile_id, model_name: "横图模型", status: "done", created_at, conversation_id: 42, assets: [image(`result-${requests.length}`, `海报-${requests.length}.png`)] });
      return route.fulfill({ status: 202, json: { id: body.request_id } });
    }
    if (path.startsWith("/image-studio/tasks/")) {
      const task = history.find(t => t.id === path.split("/").pop());
      return task ? route.fulfill({ json: task }) : route.fulfill({ status: 404, json: { detail: "任务不存在" } });
    }
    if (path === "/chat-assets/result-1/edits") {
      const body = request.postDataJSON();
      expect(body).toMatchObject({ mode: "edit", prompt: "把背景改成暖橙色", comparison_key: "e".repeat(64), confirm_data_boundary: true });
      const edited = image("edited", "海报-定稿.png");
      history.unshift({ ...history.find(t => t.assets[0].id === "result-1")!, id: body.operation_id, prompt: body.prompt, assets: [edited], source_asset_id: "result-1" });
      return route.fulfill({ json: { assets: [edited], conversation_id: 42, message_id: 44 } });
    }
    if (path === "/image-studio/works") return route.fulfill({ json: { items: works } });
    if (path === "/image-studio/works/edited" && request.method() === "POST") {
      if (!works.length) works.push({ id: "final-work", asset: image("edited", "海报-定稿.png"), created_at });
      return route.fulfill({ json: works[0] });
    }
    if (/^\/chat-assets\/(?:result-\d+|edited)\/(?:file|thumbnail)$/.test(path) || /^\/image-studio\/works\/final-work\/(?:file|thumbnail)$/.test(path)) {
      expect(request.headers().authorization).toBe("Bearer image-workspace-fixture");
      const resultIndex = Number(/result-(\d+)/.exec(path)?.[1]) - 1;
      const name = art[resultIndex] || art[3];
      const body = await readFile(resolve("e2e/fixtures", `${name}.webp`));
      reads.push(path);
      return route.fulfill({ contentType: "image/webp", body });
    }
    return route.fulfill({ status: 404, json: { detail: `Unhandled fixture route: ${path}` } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/#/images`);
  const workspace = page.getByRole("region", { name: "图片创作工作台" });
  const prompt = workspace.getByRole("textbox", { name: "画面描述" });
  const model = workspace.getByRole("combobox", { name: "图片模型" });
  const size = workspace.getByRole("combobox", { name: "生成画幅" });
  await expect(model).toHaveValue("square-only");
  await expect(model.getByRole("option")).toHaveText(["默认图片模型", "横图模型"]);
  await expect(workspace.getByText(/本次使用/)).toHaveCount(0);
  await model.selectOption({ label: "横图模型" });
  await size.selectOption("1536x1024");
  const prompts = ["夏日音乐节海报·第一稿", "夏日音乐节海报·第二稿", "夏日音乐节海报·第三稿"];
  for (const text of prompts) {
    await prompt.fill(text);
    const submit = workspace.getByRole("button", { name: "生成图片", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    const tile = workspace.getByRole("article").filter({ has: page.getByRole("button", { name: `查看 ${text}`, exact: true }) });
    await expect(tile.getByText("已完成", { exact: true })).toBeVisible();
  }
  expect(requests.map(item => item.prompt)).toEqual(prompts);
  await page.reload();
  const first = workspace.getByRole("button", { name: `查看 ${prompts[0]}`, exact: true });
  await expect(first).toBeVisible();
  await first.click();
  await page.getByRole("button", { name: "复用设置", exact: true }).click();
  await expect(prompt).toHaveValue(prompts[0]);
  await expect(model).toHaveValue("selected");
  await expect(size).toHaveValue("1536x1024");
  await first.click();
  await page.getByRole("button", { name: "编辑图片", exact: true }).click();
  const editPrompt = page.getByRole("textbox", { name: "修改要求" });
  await editPrompt.fill("把背景改成暖橙色");
  await expect(editPrompt).toHaveCSS("box-shadow", "none");
  await expect(editPrompt).toHaveCSS("resize", "none");
  const editSubmit = page.getByRole("button", { name: "生成新版本", exact: true });
  await expect(editSubmit).toBeDisabled();
  await page.getByRole("checkbox", { name: /同意将原图发送到.*服务 B/ }).check();
  await expect(editSubmit).toBeEnabled();
  await page.screenshot({ path: resolve(output, "edit.png"), animations: "disabled" });
  await editSubmit.click();
  const archive = page.getByRole("button", { name: "归档到我的作品", exact: true });
  await archive.click();
  await expect.poll(() => works.length).toBe(1);
  await page.getByRole("button", { name: "已归档 · 查看作品", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的作品" })).toBeVisible();
  await expect(page.getByText("海报-定稿.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看作品", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "作品详情" }).getByRole("button", { name: "下载原图", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("海报-定稿.png");
  expect(reads).toContain("/image-studio/works/final-work/file");
  expect(reads.some(path => path.startsWith("/chat-assets/result-1/"))).toBe(true);

  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(page.getByRole("region", { name: "我的作品" }).locator("img").first()).toBeVisible();
  await page.screenshot({ path: resolve(output, "works.png"), animations: "disabled" });
  await page.goto(`${origin}/#/images`);
  await expect(first).toBeVisible();
  await page.screenshot({ path: resolve(output, "desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(prompt).toBeInViewport();
  await expect(workspace.getByRole("button", { name: "生成图片", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(output, "mobile.png"), animations: "disabled" });
});
