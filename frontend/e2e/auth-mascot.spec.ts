import { expect, test } from "./test-fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tuantuan-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/auth/config", route => route.fulfill({
    json: { enabled: true, setup_required: false, registration_open: true }
  }));
});

test("the mascot moves while the desk and shared neutral background stay still", async ({ page }) => {
  await page.goto("/");
  const scene = page.locator(".auth-mascot-scene");
  await expect(scene).toHaveAttribute("data-animated", "true");
  expect(await scene.locator("canvas").evaluate(element => (element as HTMLCanvasElement).getContext("webgl")?.getContextAttributes()?.alpha)).toBe(true);
  await expect(scene.getByRole("button")).toHaveCount(0);
  const background = await page.locator(".auth-gate").evaluate(el => getComputedStyle(el).backgroundColor);
  expect(background).toBe("rgb(250, 250, 250)");
  expect(await page.locator(".auth-artwork").evaluate(el => getComputedStyle(el).backgroundColor)).toBe(background);
  const bounds = (await scene.boundingBox())!;
  const desk = { x: bounds.x + bounds.width * .15, y: bounds.y + bounds.height * .74, width: bounds.width * .65, height: bounds.height * .2 };
  // Let the first GPU texture presentation settle before comparing pixels.
  let stillDesk = await page.screenshot({ clip: desk });
  await expect.poll(async () => {
    const next = await page.screenshot({ clip: desk });
    const stable = next.equals(stillDesk);
    stillDesk = next;
    return stable;
  }).toBe(true);
  const first = (await scene.screenshot()).toString("base64");
  await expect.poll(async () => (await scene.screenshot()).toString("base64"), { timeout: 3000 }).not.toBe(first);
  expect((await page.screenshot({ clip: desk })).equals(stillDesk)).toBe(true);
});

test("reduced motion keeps the original illustration and can change live", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const scene = page.locator(".auth-mascot-scene");
  await expect(scene).toHaveAttribute("data-animated", "false");
  await expect(scene.locator("img")).toBeVisible();
  await expect(scene.locator("canvas")).toBeHidden();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(scene).toHaveAttribute("data-animated", "true");
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(scene).toHaveAttribute("data-animated", "false");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(scene).toHaveAttribute("data-animated", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(scene).toHaveAttribute("data-animated", "false");
});

test("unsupported graphics retains the static mascot", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/");
  const scene = page.locator(".auth-mascot-scene");
  await expect(scene).toHaveAttribute("data-animated", "false");
  await expect(scene.locator("img")).toHaveJSProperty("naturalWidth", 1448);
  await expect(scene.locator("img")).toBeVisible();
});
