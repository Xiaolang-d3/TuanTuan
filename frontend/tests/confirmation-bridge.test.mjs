import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const source = readFileSync(resolve(process.cwd(), "../backend/app/presentations/confirmation_proxy.py"), "utf8");
const bridge = source.split("BRIDGE = r'''")[1].split("'''")[0];

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["stage1", "final"])("shows a correctable %s error and allows another submission", async stage => {
  const script = document.createElement("script");
  script.src = `${window.location.origin}/api/presentations/job/confirmation/bridge.js`;
  script.dataset.csrf = "scoped-csrf";
  vi.spyOn(document, "currentScript", "get").mockReturnValue(script);
  document.body.innerHTML = '<button id="btn-confirm" disabled>确认</button><p id="confirm-status"></p>';
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "请先选择自由设计" }), { status: 422 }));
  vi.stubGlobal("fetch", send);
  new Function(bridge)();
  let reachedGenericError = false;
  void window.fetch("/api/confirm", { method: "POST", body: JSON.stringify({ stage }) }).then(() => { reachedGenericError = true; });
  await vi.waitFor(() => expect(document.getElementById("confirm-status")).toHaveTextContent("请先选择自由设计"));
  expect(document.getElementById("btn-confirm")).toBeEnabled();
  expect(reachedGenericError).toBe(false);
  void window.fetch("/api/confirm", { method: "POST", body: JSON.stringify({ stage }) });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(new Headers(send.mock.calls[1][1].headers).get("X-PPT-CSRF")).toBe("scoped-csrf");
});
