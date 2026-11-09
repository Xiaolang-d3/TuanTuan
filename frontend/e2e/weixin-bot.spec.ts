import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './test-fixtures';
import { defaultAgentSettings } from '../src/constants';

for (const theme of ['light', 'dark']) {
  test(`Weixin bot keeps its status icon beside the account and acknowledges the opened snapshot in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(value => {
      localStorage.setItem('tuantuan-auth-token', 'bot-test-session');
      localStorage.setItem('tuantuan-theme', value);
    }, theme);
    let state = { connected: true, enabled: true, error: '', conversation_id: 6, unread_count: 3,
      latest_sequence: 3, readable_sequence: 2, read_sequence: 0, binding_id: 'test-binding' };
    const reads: unknown[] = [];
    const responses: Record<string, unknown> = {
      '/auth/me': { user: { id: 1, email: 'bot-test@local.test', has_avatar: false } },
      '/system/database-status': { status: 'ready', schema_version: 31, required_schema_version: 31 },
      '/library': { profile: { name: '', privacy_mode: 'redacted' }, facts: [], sources: [], folders: [], collections: [] },
      '/agent/settings': { ...defaultAgentSettings, model_name: 'test-model', api_key_configured: true },
      '/agent/capabilities': { configured: true, active_model_name: 'test-model', tools: [] },
      '/agent/model-connections': { connections: [], profiles: [], default_profile_id: null },
      '/attachments/config': { storage: 'local', vision_enabled: false, checks: [] },
      '/conversations': [{ id: 6, title: '微信会话', status: 'active', summary: '', updated_at: '2026-10-30T00:00:00' }],
      '/chat/messages': [{ id: 1, role: 'user', content: '请整理这周的工作', conversation_id: 6 },
        { id: 2, role: 'assistant', content: '已收到微信消息。', conversation_id: 6 }],
      '/agent/runs/current': { run: null }
    };
    await page.route('http://127.0.0.1:4173/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/' || path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      if (path === '/channels/weixin') return route.fulfill({ json: state });
      if (path === '/channels/weixin/read') {
        reads.push(route.request().postDataJSON());
        state = { ...state, unread_count: 1, read_sequence: 2 };
        return route.fulfill({ json: state });
      }
      return path in responses ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { detail: 'No fixture' } });
    });
    await page.goto('/#/settings/channels');
    const desktop = page.locator('.sidebar-identity-slot .weixin-bot-entry');
    await expect(desktop).toHaveAttribute('aria-label', '微信 Bot，已连接，3 条未读消息');
    await expect(desktop).toHaveText('');
    await expect(page.locator('nav .weixin-bot-entry')).toHaveCount(0);
    expect(reads).toHaveLength(0);
    const output = resolve('..', 'output', 'weixin-bot');
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `unread-${theme}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
    await expect(page.locator('aside.sidebar')).toHaveCSS('width', '72px');
    await expect(desktop.locator('.weixin-bot-status')).toBeVisible();
    await page.screenshot({ path: resolve(output, `collapsed-${theme}.png`), animations: 'disabled' });
    await desktop.click();
    await expect(page).toHaveURL(/#\/chat\/6$/);
    await expect(desktop).toHaveAttribute('aria-label', '微信 Bot，已连接，1 条未读消息');
    expect(reads).toEqual([{ through_sequence: 2, binding_id: 'test-binding' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = page.locator('.sidebar-identity-slot .weixin-bot-entry');
    await expect(page.locator('aside.sidebar')).toHaveCSS('width', '390px');
    await expect(mobile).toBeVisible();
    const buttons = await page.locator('.nav-mobile > button').all();
    for (const button of buttons) expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(32);
    for (let index = 1; index < buttons.length; index++) {
      const previous = await buttons[index - 1].boundingBox();
      const current = await buttons[index].boundingBox();
      expect(previous!.x + previous!.width).toBeLessThanOrEqual(current!.x + 1);
    }
    await expect(mobile).toHaveAttribute('data-status', 'connected');
    const badge = await mobile.boundingBox();
    expect(badge!.x + badge!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: resolve(output, `mobile-${theme}.png`), animations: 'disabled' });
  });
}
