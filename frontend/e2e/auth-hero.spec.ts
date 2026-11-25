import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "./test-fixtures";
import { hostedHome, icpNumber, mockHostedSite } from "./hosted-site";

const evidenceDir = resolve(import.meta.dirname, "../../output/playwright/home-hero");

async function checkLayout(page: Page, width: number) {
  const hero = page.locator(".auth-hero");
  const title = hero.getByRole("heading", { name: /把想法，\s*变成行动。/ });
  const demo = hero.locator(".auth-demo");
  const form = page.getByRole("form", { name: "欢迎登录" });
  await expect(title).toBeInViewport({ ratio: 1 });
  await expect(form).toBeInViewport({ ratio: 1 });
  const card = (await form.boundingBox())!;
  expect(card.width).toBeLessThanOrEqual(432);
  const logo = page.locator('.auth-brand img[src="/tuantuan-mark.svg"]');
  await expect(logo).toBeInViewport({ ratio: 1 });
  await expect(logo).toHaveCSS("mask-image", "none");
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(form.locator('img[src="/tuantuan-favicon.png"]')).toHaveCount(0);
  const mascot = hero.locator(".auth-hero-mascot");
  if (width > 860) {
    await expect(mascot).toHaveAttribute("src", "/auth-companion-cutout.webp");
    await expect(mascot).toBeInViewport({ ratio: 1 });
    await expect.poll(() => mascot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(demo.locator("figcaption")).toContainText("对话示例");
    await expect(demo.getByRole("list", { name: "执行步骤" }).getByRole("listitem")).toHaveCount(3);
    await expect(demo.locator(".auth-demo-output").getByRole("listitem")).toHaveCount(2);
    await expect(demo).toBeInViewport({ ratio: 1 });
    const heading = (await title.boundingBox())!;
    const artwork = (await mascot.boundingBox())!;
    expect(heading.x + heading.width).toBeLessThan(artwork.x);
    const panel = (await hero.boundingBox())!;
    expect(panel.x + panel.width).toBeLessThanOrEqual(card.x);
    expect(card.x + card.width / 2).toBeGreaterThan(width / 2);
    if (width >= 1180) {
      expect(panel.y).toBeCloseTo(card.y, 0);
      expect(panel.height).toBeCloseTo(card.height, 0);
      const execution = (await demo.getByRole("list", { name: "执行步骤" }).boundingBox())!;
      const result = (await demo.locator(".auth-demo-result").boundingBox())!;
      expect(execution.x + execution.width).toBeLessThan(result.x);
      expect(result.y).toBeLessThan(execution.y);
    }
  } else {
    await expect(demo).toBeHidden();
    if (width >= 600) {
      await expect(mascot).toBeInViewport({ ratio: 1 });
      const artwork = (await mascot.boundingBox())!;
      expect(artwork.y + artwork.height).toBeLessThanOrEqual(card.y);
    } else {
      await expect(mascot).toBeHidden();
    }
    const intro = hero.locator(".auth-hero-intro");
    if (page.viewportSize()!.height <= 740) await expect(intro).toBeHidden();
    else await expect(intro).toBeInViewport({ ratio: 1 });
    const heading = (await title.boundingBox())!;
    expect(heading.y + heading.height).toBeLessThanOrEqual(card.y);
    expect(card.x + card.width / 2).toBeCloseTo(width / 2, 0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test("the example panel collapses at 860px and returns at 861px without reloading", async ({ page, baseURL }) => {
  await mockHostedSite(page, baseURL);
  await page.setViewportSize({ width: 861, height: 900 });
  await page.goto(hostedHome);
  for (const width of [861, 860, 861]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, width);
  }
});

test("the desktop demo switches examples with the keyboard without moving focus", async ({ page, baseURL }) => {
  await mockHostedSite(page, baseURL);
  await page.setViewportSize({ width: 861, height: 640 });
  await page.goto(hostedHome);
  const notes = page.getByRole("button", { name: "整理会议" });
  const plan = page.getByRole("button", { name: "拆解计划" });
  await expect(notes).toHaveAttribute("aria-pressed", "true");
  await notes.focus();
  await page.keyboard.press("Tab");
  await expect(plan).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(plan).toBeFocused();
  await expect(plan).toHaveAttribute("aria-pressed", "true");
  await expect(notes).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { name: "访谈准备计划" })).toBeVisible();
  await expect(page.getByText("筛选访谈对象，发出预约邀请")).toBeVisible();
  await checkLayout(page, 861);
  await notes.click();
  await expect(page.getByRole("heading", { name: "行动清单" })).toBeVisible();
});

test("the demo plays steps in order and automatically replays after showing the result", async ({ page, baseURL }) => {
  await mockHostedSite(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  const start = new Date("2026-11-25T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto(hostedHome);

  const demo = page.locator(".auth-demo");
  const current = demo.locator('[aria-current="step"]');
  const result = demo.getByRole("heading", { name: "行动清单" });
  await expect(current).toContainText("读取周会笔记");
  await expect(result).toBeHidden();
  const pending = demo.getByText("执行完成后在这里显示结果");
  await expect(pending).toBeVisible();
  const initialBounds = await demo.boundingBox();

  await page.clock.runFor(750);
  await expect(current).toContainText("提取会议决定和后续事项");
  await page.clock.runFor(750);
  await expect(current).toContainText("核对待办截止时间");
  await expect(result).toBeHidden();
  await page.clock.runFor(750);
  await expect(demo.locator(".auth-demo-status")).toHaveText("已完成");
  await expect(result).toBeVisible();
  await expect(pending).toBeHidden();
  expect(await demo.boundingBox()).toEqual(initialBounds);

  await expect(demo.getByRole("button", { name: /跳过|重播/ })).toHaveCount(0);
  await page.clock.runFor(5_999);
  await expect(result).toBeVisible();
  await page.clock.runFor(1);
  await expect(current).toContainText("读取周会笔记");
  await expect(result).toBeHidden();
  await expect(pending).toBeVisible();
  expect(await demo.boundingBox()).toEqual(initialBounds);
});

test("the demo shows the completed record immediately with reduced motion", async ({ page, baseURL }) => {
  await mockHostedSite(page, baseURL);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  await page.goto(hostedHome);

  const demo = page.locator(".auth-demo");
  await expect(demo.getByRole("heading", { name: "行动清单" })).toBeVisible();
  await expect(demo.locator(".auth-demo-status")).toHaveText("已完成");
  await expect(demo.getByRole("button", { name: /跳过|重播/ })).toHaveCount(0);
  await page.clock.fastForward(7_000);
  await expect(demo.getByRole("heading", { name: "行动清单" })).toBeVisible();

  await demo.getByRole("button", { name: "拆解计划" }).click();
  await expect(demo.getByRole("heading", { name: "访谈准备计划" })).toBeVisible();
});

const viewports = [
  { width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 640 },
  { width: 768, height: 1024 }, { width: 600, height: 700 }, { width: 390, height: 844 }, { width: 320, height: 568 },
];

for (const theme of ["dark", "light", "blue"]) {
  for (const size of theme === "blue" ? [viewports[1], viewports[3], viewports[5]] : viewports) {
    test(`hosted ${theme} home at ${size.width}×${size.height} keeps login and navigation in view and the footer reachable`, async ({ page, baseURL }) => {
      await mockHostedSite(page, baseURL);
      await page.addInitScript(value => localStorage.setItem("tuantuan-theme", value), theme);
      await page.setViewportSize(size);
      await page.goto(hostedHome);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await checkLayout(page, size.width);
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: resolve(evidenceDir, `${theme}-${size.width}x${size.height}.png`), animations: "disabled" });
      const qq = page.getByRole("button", { name: "使用 QQ 登录" });
      await expect(qq).toBeEnabled();
      await expect(qq).toHaveText("");
      await expect(qq).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(qq).toHaveCSS("border-top-width", "0px");
      await expect(qq).toBeInViewport({ ratio: 1 });
      const qqBounds = (await qq.boundingBox())!;
      expect(qqBounds.width).toBeGreaterThanOrEqual(44);
      expect(qqBounds.height).toBeGreaterThanOrEqual(44);
      const password = page.getByLabel("密码", { exact: true });
      await page.getByRole("button", { name: "显示密码" }).click();
      await expect(password).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "隐藏密码" }).click();
      await expect(password).toHaveAttribute("type", "password");
      const email = page.getByRole("combobox", { name: "邮箱" });
      for (const [field, value] of [[email, "preview@example.com"], [password, "sample-password"]] as const) {
        const label = page.locator(`label[for="${await field.getAttribute("id")}"]`);
        await expect(label).toHaveCSS("opacity", "0");
        await field.focus();
        await expect(label).toHaveCSS("opacity", "1");
        await field.fill(value);
        await field.blur();
        await expect(label).toHaveCSS("opacity", "1");
        await field.clear();
        await field.blur();
        await expect(label).toHaveCSS("opacity", "0");
      }
      await page.mouse.move(1, 1);
      const about = page.getByRole("link", { name: "关于 团团" });
      const footer = page.getByRole("contentinfo", { name: "网站页脚" });
      await expect(about).toBeInViewport({ ratio: 1 });
      const registration = footer.getByRole("link", { name: icpNumber });
      const form = (await page.getByRole("form", { name: "欢迎登录" }).boundingBox())!;
      const nav = (await about.boundingBox())!;
      expect(nav.y + nav.height).toBeLessThanOrEqual(form.y);
      expect((await footer.boundingBox())!.y).toBeGreaterThanOrEqual(form.y + form.height);
      // Preserve the login controls on short screens; reaching the footer may require a scroll.
      if (size.height === 568) await registration.scrollIntoViewIfNeeded();
      await expect(registration).toBeInViewport({ ratio: 1 });
    });
  }
}
