import type { Page } from "./test-fixtures";

export const icpNumber = "鄂ICP备2026067631号-1";
export const icpUrl = "https://beian.miit.gov.cn/";
export const hostedHome = "https://xiaocheng.online/";

export async function mockHostedSite(page: Page, baseURL: string | undefined, responses: Record<string, unknown> = {}) {
  // Exercise the public hostname, but never request the live site or its API.
  await page.route(`${hostedHome}**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\//, "/");
    if (path === "/auth/config") {
      await route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true, qq_enabled: true } });
      return;
    }
    if (path in responses) {
      await route.fulfill({ json: responses[path] });
      return;
    }
    if (path !== "/" && !path.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(path)) {
      await route.fulfill({ status: 404, json: { detail: `Unhandled test route: ${path}` } });
      return;
    }
    const local = new URL(url.pathname + url.search, baseURL);
    const response = await route.fetch({ url: local.href, maxRedirects: 0 });
    if (path !== "/") {
      await route.fulfill({ response });
      return;
    }
    const legacy = `<a href="${icpUrl}" style="position:fixed;bottom:2px;right:8px">${icpNumber}</a>`;
    await route.fulfill({ response, body: (await response.text()).replace("</body>", `${legacy}</body>`) });
  });
}
