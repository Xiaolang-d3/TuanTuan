import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StudioRequest, StudioTask, StudioWork } from "../src/features/product/imageStudioApi";
import { expect, seedFirstRunDone, test } from "./test-fixtures";

const origin = process.env.IMAGE_WORKSPACE_E2E_ORIGIN || "http://127.0.0.1:4173";
const art = ["studio-purple", "studio-wave", "studio-sunset", "studio-edited"] as const;

function image(id: string, name: string) {
  return { id, origin: "generated" as const, kind: "image" as const, original_filename: name, parse_status: "parsed" as const, width: 740, height: 480 };
}

test("unconfigured image workspace guides users to image model settings", async ({ page }) => {
  const output = resolve("..", "tmp", "image-workspace");
  await mkdir(output, { recursive: true });
  await page.addInitScript(() => sessionStorage.setItem("tuantuan-auth-token", "image-workspace-fixture"));
  await seedFirstRunDone(page, "e2e@local.test");
  await page.route(`${origin}/**`, async route => {
    const request = route.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) return route.continue();
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/)/, "");
    if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email: "e2e@local.test", display_name: "测试用户", has_avatar: false } } });
    if (path === "/system/database-status") return route.fulfill({ json: { status: "ready" } });
    if (path === "/image-studio/history") return route.fulfill({ json: { items: [], has_more: false } });
    if (path === "/image-studio/options") return route.fulfill({ json: { default_profile_id: null, models: [] } });
    if (path === "/agent/model-selection/preview") return route.fulfill({ json: { eligible: false, selection: null, candidates: [], reason_code: "not_configured" } });
    return route.fulfill({ status: 404, json: { detail: "Fixture route not needed" } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/#/images`);
  const guide = page.getByRole("region", { name: "尚未配置模型" });
  await expect(guide.getByText("还没有可用的图片模型")).toBeVisible();
  await page.screenshot({ path: resolve(output, "onboarding-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  const tutorial = guide.getByText("模型接入说明和配置教程");
  await tutorial.focus();
  await tutorial.press("Enter");
  await expect(guide.getByText(/测试连接，然后添加支持图片生成的模型/)).toBeVisible();
  await tutorial.press("Enter");
  await expect(guide.getByRole("heading", { name: "尚未配置模型" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(output, "onboarding-mobile.png"), animations: "disabled" });
  await guide.getByRole("button", { name: "配置图片模型" }).click();
  await expect(page).toHaveURL(/#\/settings\/model\?purpose=image$/);
});

test("image workspace makes three drafts, restores settings, edits and archives the final result", async ({ page }) => {
  const history: StudioTask[] = [];
  const works: StudioWork[] = [];
  const requests: StudioRequest[] = [];
  const reads: string[] = [];
  let finishFirst!: () => void;
  const firstGeneration = new Promise<void>(resolve => { finishFirst = resolve; });
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
      if (requests.length === 1) await firstGeneration;
      const asset = image(`result-${requests.length}`, `海报-${requests.length}.png`);
      if (requests.length === 2) Object.assign(asset, { width: 480, height: 740 });
      history.unshift({ id: body.request_id, prompt: body.prompt, size: body.size, profile_id: body.profile_id, model_name: "横图模型", status: "done", created_at, conversation_id: 42, assets: [asset] });
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
      reads.push(path);
      if (resultIndex === 1) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="740"><rect width="480" height="740" fill="#5543a9"/><circle cx="240" cy="302" r="155" fill="#d8a2d1"/></svg>' });
      const name = art[resultIndex] || art[3];
      const body = await readFile(resolve("e2e/fixtures", `${name}.webp`));
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
    const stage = workspace.getByRole("region", { name: "本次图片生成" });
    if (text === prompts[0]) {
      try {
        await expect(stage.getByRole("heading", { name: "生成中" })).toBeVisible();
        await expect(workspace.getByLabel("创作历史", { exact: true })).toHaveCount(0);
        const field = stage.locator(".studio-dot-matrix");
        const wave = () => field.evaluate(el => getComputedStyle(el, "::after").animationName);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        expect(await wave()).toBe("studio-dot-wave");
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await field.evaluate(el => el.clientWidth === el.parentElement!.clientWidth && el.clientHeight === el.parentElement!.clientHeight)).toBe(true);
        }
        await page.screenshot({ path: resolve(output, "generation.png") });
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await wave()).toBe("none");
        await page.emulateMedia({ reducedMotion: null });
      } finally {
        finishFirst();
      }
    }
    await expect(stage.getByRole("heading", { name: "图片已生成" })).toBeVisible();
    await expect(stage.getByRole("img", { name: /^海报-/ })).toBeVisible();
    await stage.getByRole("button", { name: "返回创作广场" }).click();
    const tile = workspace.getByRole("article").filter({ has: page.getByRole("button", { name: `查看 ${text}`, exact: true }) });
    await expect(tile.locator("img")).toBeVisible();
    await expect(tile.getByText("已完成", { exact: true })).toHaveCount(0);
  }
  expect(requests.map(item => item.prompt)).toEqual(prompts);
  await page.reload();
  const first = workspace.getByRole("button", { name: `查看 ${prompts[0]}`, exact: true });
  await expect(first).toBeVisible();
  async function expectOriginalRatios() {
    for (const [text, ratio] of [[prompts[0], 740 / 480], [prompts[1], 480 / 740]] as const) {
      const thumbnail = workspace.getByRole("button", { name: `查看 ${text}`, exact: true }).locator("img");
      await expect(thumbnail).toBeVisible();
      await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => {
        const { width, height } = img.getBoundingClientRect();
        return img.naturalWidth && height ? width / height : 0;
      })).toBeCloseTo(ratio, 2);
      expect(await thumbnail.evaluate((img: HTMLImageElement) => {
        const image = img.getBoundingClientRect();
        const frame = img.closest("button")!.getBoundingClientRect();
        return image.top >= frame.top - 1 && image.bottom <= frame.bottom + 1;
      })).toBe(true);
    }
  }
  await expectOriginalRatios();
  await first.click();
  await page.getByRole("dialog", { name: "图片详情" }).getByRole("button", { name: "复用描述生图", exact: true }).click();
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
  const editedCard = workspace.getByRole("article").filter({ hasText: "把背景改成暖橙色" });
  await expect(editedCard).toHaveText("把背景改成暖橙色");
  await page.screenshot({ path: resolve(output, "desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectOriginalRatios();
  await expect(prompt).toBeInViewport();
  await expect(workspace.getByRole("button", { name: "生成图片", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(output, "mobile.png"), animations: "disabled" });
});
