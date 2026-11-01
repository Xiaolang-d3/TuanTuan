import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`voice input uses only icon color and live audio waves in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem("tuantuan-auth-token", "voice-e2e-token");
      localStorage.setItem("tuantuan-theme", value);
      // Exercise the actual AudioWorklet without opening a real microphone.
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
        const context = new AudioContext({ sampleRate: 16000 });
        await context.resume();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.1;
        oscillator.connect(gain); gain.connect(destination); oscillator.start();
        destination.stream.getTracks()[0].addEventListener("ended", () => void context.close());
        return destination.stream;
      } });
    }, theme);
    let releasePreparation!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    let chunks = 0;
    let closed = false;
    const responses: Record<string, unknown> = {
      "/auth/me": { user: { id: 1, email: "voice@local.test", display_name: "测试读者", has_avatar: false } },
      "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
      "/conversations": [{ id: 1, title: "语音输入", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-10-25T00:00:00Z" }],
      "/chat/messages": [], "/agent/runs/current": { run: null },
      "/agent/capabilities": { configured: true, active_model_name: "example-model", tools: [] },
      "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
      "/speech/sessions": { id: "test-session" }
    };
    await page.route("http://127.0.0.1:4173/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      if (path === "/speech/prepare") {
        await preparation;
        return route.fulfill({ json: { state: "ready", error: "" } });
      }
      if (path === "/speech/sessions/test-session/audio") {
        chunks += 1;
        return route.fulfill({ json: { updates: [{ segmentId: 0, revision: chunks, text: "语音文字直接显示在输入框。", final: false }] } });
      }
      if (path === "/speech/sessions/test-session" && route.request().method() === "DELETE") {
        closed = true;
        return route.fulfill({ json: { closed: true } });
      }
      return path in responses ? route.fulfill({ json: responses[path] })
        : route.fulfill({ status: 404, json: { detail: `Unhandled voice test route: ${path}` } });
    });
    await page.goto("/#/chat/1");
    const button = page.locator(".composer-voice-tool");
    const icon = button.locator(".composer-voice-icon");
    const input = page.getByRole("textbox", { name: "输入消息" });
    const idleColor = await icon.evaluate(el => getComputedStyle(el).color);
    await button.click();
    await expect(button).toHaveText("语音");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(icon).not.toHaveCSS("color", idleColor);
    await expect(page.locator("#composer-voice-feedback")).toHaveCount(0);
    await expect(page.getByText(/准备中|启动中|停止转录/)).toHaveCount(0);
    // The first words must be captured even while the model is preparing.
    await expect.poll(() => icon.evaluate(el => Number((el as HTMLElement).style.getPropertyValue("--voice-level")))).toBeGreaterThan(0.1);
    releasePreparation();
    await expect.poll(() => icon.evaluate(el => Number((el as HTMLElement).style.getPropertyValue("--voice-level")))).toBeGreaterThan(0.1);
    await expect(input).toHaveValue("语音文字直接显示在输入框。");
    await expect(button.locator(".composer-voice-wave line")).toHaveCount(3);
    await input.click();
    const output = process.env.CI ? resolve("../..", "output", "playwright") : resolve("../tmp", "voice-feedback-e2e");
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `voice-recording-${theme}.png`) });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveText("语音");
    await expect(button.locator(".composer-voice-wave")).toHaveCount(0);
    await expect(icon).toHaveCSS("--voice-level", "0");
    await input.click();
    await expect(icon).toHaveCSS("color", idleColor);
    await expect.poll(() => closed).toBe(true);
    await expect(input).toHaveValue("语音文字直接显示在输入框。");
  });
}
