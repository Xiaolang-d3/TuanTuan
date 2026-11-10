import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";

test("a minimal split sign-in page links to a public product page on desktop and mobile", async ({ page }) => {
  await page.route("**/auth/config", (route) => route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } }));
  const evidenceDir = resolve(import.meta.dirname, "../../output/playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.goto("/");

  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "登录本地账户" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "团团", exact: true })).toBeVisible();
    await expect(page.locator('img[src="/tuantuan-logo.png"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toHaveCount(0);
    const card = await page.locator(".auth-card").boundingBox();
    expect(card).not.toBeNull();
    if (viewport.width > 860) {
      const artwork = page.locator(".auth-artwork");
      await expect(artwork).toBeVisible();
      await expect(artwork.locator("img")).toHaveJSProperty("naturalWidth", 1448);
      const artworkBounds = await artwork.boundingBox();
      const sceneBounds = (await artwork.locator(".auth-mascot-scene").boundingBox())!;
      const captionBounds = (await artwork.locator(".auth-artwork-caption").boundingBox())!;
      expect(captionBounds.y).toBeGreaterThanOrEqual(sceneBounds.y + sceneBounds.height + 12);
      expect(captionBounds.x + captionBounds.width / 2).toBeCloseTo(artworkBounds!.x + artworkBounds!.width / 2, 0);
      expect(await artwork.locator(".auth-artwork-caption").evaluate(el => getComputedStyle(el).textAlign)).toBe("center");
      expect(card!.x + card!.width).toBeLessThan(artworkBounds!.x);
      expect(Math.abs(artworkBounds!.y + artworkBounds!.height / 2 - card!.y - card!.height / 2)).toBeLessThanOrEqual(4);
    } else {
      await expect(page.locator(".auth-artwork")).toBeHidden();
      expect(card!.x + card!.width / 2).toBeCloseTo(viewport.width / 2, 0);
    }
    expect(card!.width).toBeLessThanOrEqual(420);
    await page.screenshot({ path: resolve(evidenceDir, `login-only-${viewport.width}.png`), animations: "disabled" });
    const aboutLink = page.getByRole("link", { name: "关于 团团" });
    const aboutBounds = await aboutLink.boundingBox();
    expect(aboutBounds).not.toBeNull();
    expect(aboutBounds!.y + aboutBounds!.height).toBeLessThanOrEqual(card!.y);
    await aboutLink.click();
    await expect(page).toHaveURL(/#\/about$/);
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
    await expect(page.locator(".product-intro-brand img")).toHaveJSProperty("naturalWidth", 940);
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.locator(".product-intro-page").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: resolve(evidenceDir, `product-intro-${viewport.width}.png`), animations: "disabled" });
    await page.goBack();
    await expect(page.getByRole("heading", { name: "登录本地账户" })).toBeVisible();
  }

  await page.route(/\/auth\/(?:config|login|register|me|logout)(?:[/?]|$)/, (route) => route.abort());
  await page.goto("/#/about");
  await page.reload();
  await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录" })).toBeVisible();
});
