import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";

test("the sign-in page shows the mascot on desktop and links to the product page at both sizes", async ({ page }) => {
  await page.route("**/auth/config", (route) => route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } }));
  const evidenceDir = resolve(import.meta.dirname, "../../output/playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.goto("/");

  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    const signIn = page.getByRole("form", { name: "欢迎登录" });
    await expect(signIn).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("heading", { name: "团团", exact: true })).toBeVisible();
    const cardMascot = signIn.locator('img[src="/tuantuan-favicon.png"]');
    if (viewport.width <= 480) {
      await expect(cardMascot).toBeVisible();
      await expect(cardMascot).toHaveJSProperty("naturalWidth", 64);
    } else {
      await expect(cardMascot).toBeHidden();
    }
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toHaveCount(0);
    const card = (await signIn.boundingBox())!;
    const mascot = page.locator(".auth-artwork img");
    if (viewport.width > 860) {
      await expect(mascot).toBeInViewport({ ratio: 1 });
      await expect(mascot).toHaveJSProperty("naturalWidth", 1448);
      const image = (await mascot.boundingBox())!;
      expect(image.x + image.width).toBeLessThan(card.x);
      expect(image.y + image.height / 2).toBeCloseTo(card.y + card.height / 2, 0);
    } else {
      await expect(mascot).toBeHidden();
      expect(card.x + card.width / 2).toBeCloseTo(viewport.width / 2, 0);
    }
    expect(card.width).toBeLessThanOrEqual(432);
    await page.screenshot({ path: resolve(evidenceDir, `login-only-${viewport.width}.png`), animations: "disabled" });
    const aboutLink = page.getByRole("link", { name: "关于 团团" });
    const aboutBounds = await aboutLink.boundingBox();
    expect(aboutBounds).not.toBeNull();
    expect(aboutBounds!.y + aboutBounds!.height).toBeLessThanOrEqual(card.y);
    await aboutLink.click();
    await expect(page).toHaveURL(/#\/about$/);
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
    await expect(page.locator(".product-intro-brand img")).toHaveJSProperty("naturalWidth", 940);
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.locator(".product-intro-page").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: resolve(evidenceDir, `product-intro-${viewport.width}.png`), animations: "disabled" });
    await page.goBack();
    await expect(signIn).toBeVisible();
  }

  await page.route(/\/auth\/(?:config|login|register|me|logout)(?:[/?]|$)/, (route) => route.abort());
  await page.goto("/#/about");
  await page.reload();
  await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录" })).toBeVisible();
});

test("the public site shows one centered and usable ICP link on both public pages", async ({ page, baseURL }) => {
  const icpNumber = "鄂ICP备2026067631号-1";
  const icpUrl = "https://beian.miit.gov.cn/";
  // Serve only local fixtures, even while exercising the production hostname.
  await page.route("https://xiaocheng.online/**", async (route) => {
    const url = new URL(route.request().url());
    if (["/auth/config", "/api/auth/config"].includes(url.pathname)) {
      await route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } });
      return;
    }
    const local = new URL(url.pathname + url.search, baseURL);
    const response = await route.fetch({ url: local.href, maxRedirects: 0 });
    if (url.pathname !== "/") {
      await route.fulfill({ response });
      return;
    }
    const legacy = `<a href="${icpUrl}" style="position:fixed;bottom:2px;right:8px">${icpNumber}</a>`;
    await route.fulfill({ response, body: (await response.text()).replace("</body>", `${legacy}</body>`) });
  });
  const footer = page.getByRole("contentinfo", { name: "网站页脚" });
  async function checkRegistration(viewportWidth: number) {
    const link = footer.getByRole("link", { name: icpNumber });
    await expect(link).toHaveAttribute("href", icpUrl);
    await expect(page.getByRole("link", { name: icpNumber, exact: true })).toHaveCount(1);
    await expect(page.locator(`body > a[href="${icpUrl}"]`)).toBeHidden();
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    const bounds = (await link.boundingBox())!;
    expect(bounds.x + bounds.width / 2).toBeCloseTo(viewportWidth / 2, 0);
    return bounds;
  }

  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    await page.goto("https://xiaocheng.online/");
    const loginHeading = page.getByRole("heading", { name: "欢迎登录" });
    await expect(loginHeading).toBeVisible();

    const registration = await checkRegistration(viewport.width);
    const privacy = footer.getByRole("link", { name: "隐私说明" });
    const feedback = footer.getByRole("link", { name: "帮助与反馈" });
    const privacyBounds = (await privacy.boundingBox())!;
    const feedbackBounds = (await feedback.boundingBox())!;
    expect(privacyBounds.y).toBeCloseTo(feedbackBounds.y, 0);
    expect(registration.y).toBeGreaterThanOrEqual(privacyBounds.y + privacyBounds.height);

    await privacy.click();
    const privacySection = page.getByRole("region", { name: "你的资料，始终由你掌握。" });
    await expect(privacySection).toBeFocused();
    const privacyHeading = privacySection.getByRole("heading", { level: 2 });
    await expect(privacyHeading).toBeInViewport({ ratio: 1 });
    const headerBounds = (await page.locator(".product-intro-header").boundingBox())!;
    expect((await privacyHeading.boundingBox())!.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
    await checkRegistration(viewport.width);

    await page.goto("https://xiaocheng.online/#/about");
    const introHeading = page.getByRole("heading", { name: /理解你的想法/ });
    await expect(introHeading).toBeFocused();
    await expect(introHeading).toBeInViewport({ ratio: 1 });
    await footer.getByRole("link", { name: "返回登录" }).click();
    await expect(loginHeading).toBeVisible();
  }
});
