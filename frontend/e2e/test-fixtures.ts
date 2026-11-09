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
