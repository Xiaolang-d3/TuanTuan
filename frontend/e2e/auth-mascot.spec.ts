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
  expect(await scene.locator("canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return (canvas.getContext("webgl2") ?? canvas.getContext("webgl"))?.getContextAttributes()?.alpha;
  })).toBe(true);
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

test("transparent pixels outside the mascot stay transparent during animation", async ({ page }) => {
  await page.goto("/");
  const scene = page.locator(".auth-mascot-scene");
  await expect(scene).toHaveAttribute("data-animated", "true");
  const pixels = await scene.locator("canvas").evaluate(async element => {
    const canvas = element as HTMLCanvasElement;
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl"))!;
    return new Promise<number[]>((resolve, reject) => {
      const original = gl.drawArrays;
      const timer = setTimeout(() => { gl.drawArrays = original; reject(new Error("Mascot did not render")); }, 3000);
      gl.drawArrays = function (...args) {
        original.apply(this, args);
        const data = new Uint8Array(4);
        gl.readPixels(Math.floor(canvas.width * .96), Math.floor(canvas.height * .8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.drawArrays = original;
        clearTimeout(timer);
        resolve(Array.from(data));
      };
    });
  });
  expect(pixels[3]).toBe(0);
  expect(pixels.slice(0, 3)).toEqual([0, 0, 0]);
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
