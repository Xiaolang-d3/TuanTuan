import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

const pngSignature = [0x89, 0x50, 0x4e, 0x47];
const pngEnd = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
// 1x1 opaque PNG used to satisfy the avatar read-back request.
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/6QxLcwAAAABJRU5ErkJggg==",
  "base64"
);

/** Cuts the PNG payload out of the multipart body the page uploaded. */
function pngPart(body: Buffer) {
  const start = body.indexOf(Buffer.from(pngSignature));
  const end = body.indexOf(pngEnd);
  return start === -1 || end === -1 ? null : body.subarray(start, end + pngEnd.length);
}

function shellResponses() {
  return {
    "/auth/me": { user: { id: 1, email: "avatar@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": { ...defaultAgentSettings, model_name: "example-model", api_key_configured: true },
    "/agent/capabilities": { configured: true, active_model_name: "example-model", tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [],
    "/chat/messages": [],
    "/agent/runs/current": { run: null },
    "/channels/weixin": { connected: false, enabled: false, error: "" }
  } as Record<string, unknown>;
}

for (const theme of ["light", "dark"] as const) {
  test(`chooses a built-in nailong avatar in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      sessionStorage.setItem("tuantuan-auth-token", "avatar-e2e-token");
      localStorage.setItem("tuantuan-theme", value);
    }, theme);

    const responses = shellResponses();
    const uploads: Buffer[] = [];
    let storedAvatar: Buffer | null = null;
    await page.route("http://127.0.0.1:4173/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      if (path === "/auth/me/avatar") {
        if (request.method() === "GET") {
          // Serve back what the page uploaded, so the preview and the sidebar
          // credential avatar show the chosen 奶龙 instead of a placeholder.
          return route.fulfill({ status: 200, contentType: "image/png", body: storedAvatar ?? tinyPng });
        }
        if (request.method() === "POST") {
          const uploaded = request.postDataBuffer() ?? Buffer.alloc(0);
          uploads.push(uploaded);
          storedAvatar = pngPart(uploaded);
          return route.fulfill({ json: { user: { id: 1, email: "avatar@local.test", display_name: "测试用户", has_avatar: true } } });
        }
        return route.fulfill({ status: 405, json: { detail: "unexpected avatar method" } });
      }
      return path in responses
        ? route.fulfill({ json: responses[path] })
        : route.fulfill({ status: 404, json: { detail: `Unhandled avatar test route: ${path}` } });
    });

    await page.goto("/#/settings/account");
    const picker = page.getByRole("group", { name: "奶龙头像" });
    await expect(picker).toBeVisible();
    const tiles = picker.getByRole("button");
    await expect(tiles).toHaveCount(12);

    // Every tile has to render real artwork, not a broken image.
    const loaded = await picker.locator("img").evaluateAll(images => images.map(image => ({
      complete: (image as HTMLImageElement).complete,
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight
    })));
    expect(loaded).toHaveLength(12);
    for (const image of loaded) {
      expect(image.complete).toBe(true);
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
    }

    const cheer = picker.getByRole("button", { name: "使用加油奶龙" });
    await expect(cheer).toHaveAttribute("aria-pressed", "false");
    await cheer.click();

    await expect(cheer).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("已换成加油奶龙")).toBeVisible();
    // The preview switches only after the server accepted the new avatar.
    await expect(page.locator(".account-avatar img")).toBeVisible();

    expect(uploads).toHaveLength(1);
    const multipart = uploads[0];
    // A 512x512 canvas render of the SVG is several KB of PNG; a blank failure
    // would be a few hundred bytes, so this guards real rasterisation.
    expect(multipart.length).toBeGreaterThan(4096);
    // The multipart part must carry a PNG produced by the canvas, not the SVG.
    const pngAt = multipart.indexOf(Buffer.from(pngSignature));
    expect(pngAt).toBeGreaterThan(-1);
    expect(multipart.includes(Buffer.from("image/svg+xml"))).toBe(false);

    const output = resolve("..", "output", "account-avatar-presets");
    await mkdir(output, { recursive: true });
    for (const width of [996, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(picker).toBeInViewport();
      await page.screenshot({ path: resolve(output, `account-presets-${width}-${theme}.png`), fullPage: true });
    }
  });
}
