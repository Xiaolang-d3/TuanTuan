import { expect, test } from "./test-fixtures";

test.use({ isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/config", route => route.fulfill({
    json: { enabled: true, setup_required: false, registration_open: true }
  }));
});

for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`sign-in stays still when swiping at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const email = page.getByRole("combobox", { name: "邮箱" });
    await expect(email).toBeVisible();
    const before = await email.boundingBox();
    const gate = page.locator(".auth-gate");
    expect(await gate.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.synthesizeScrollGesture", {
      x: viewport.width / 2, y: viewport.height / 2,
      yDistance: -300, gestureSourceType: "touch", preventFling: true
    });
    await expect.poll(async () => (await email.boundingBox())!.y).toBe(before!.y);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    // iOS enlarges focused text fields below 16px, shifting the whole viewport.
    expect(await email.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeInViewport();
  });
}

test("registration stays reachable in short viewports without scrolling the document", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.getByRole("button", { name: "没有账号？创建账号" }).click();
  for (const viewport of [{ width: 375, height: 667 }, { width: 375, height: 360 }, { width: 844, height: 390 }, { width: 1024, height: 480 }]) {
    await page.setViewportSize(viewport);
    const confirm = page.getByLabel("确认密码", { exact: true });
    await confirm.blur();
    await confirm.focus();
    await expect(confirm).toBeInViewport();
    const submit = page.getByRole("button", { name: "创建账号", exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height);
    await page.getByRole("button", { name: "已有账号？去登录" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "已有账号？去登录" })).toBeInViewport();
    await page.locator(".auth-gate").evaluate(el => { el.scrollTop = 0; });
    await expect(page.getByRole("heading", { name: "创建本地账户" })).toBeInViewport();
  }
});

test("connection status remains centered and does not create document scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route("**/auth/config", route => route.abort());
  await page.goto("/");
  const retry = page.getByRole("button", { name: "重新连接", exact: true });
  await expect(retry).toBeInViewport();
  const card = await page.locator(".auth-status-card").boundingBox();
  expect(Math.abs(card!.y + card!.height / 2 - 667 / 2)).toBeLessThanOrEqual(24);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(667);
});

test("expired-session and validation messages fit on a regular phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => localStorage.setItem("tuantuan-auth-token", "expired-layout-fixture"));
  await page.route("**/auth/me", route => route.fulfill({ status: 401, json: { detail: "expired" } }));
  await page.goto("/");
  await expect(page.getByText("登录状态已失效，请重新登录")).toBeVisible();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("请输入邮箱", { exact: true })).toBeVisible();
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();
  expect(await page.locator(".auth-gate").evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeInViewport();
});
