import { expect, test as base } from "@playwright/test";

export { expect };
export type { Page } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    // UI regressions use system fallbacks and must not depend on public font CDNs.
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.fulfill({
      contentType: "text/css",
      body: ""
    }));
    await use(page);
  }
});

/**
 * Marks the account as having seen the first-run guide.
 * Specs that start on the home dashboard describe returning users, so the
 * one-time guide must not sit on top of the page they are inspecting.
 */
export async function seedFirstRunDone(page: Page, email: string) {
  await page.addInitScript(key => localStorage.setItem(key, "done"), `tuantuan-first-run:${email}`);
}
