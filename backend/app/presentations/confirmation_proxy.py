"""Narrow response adaptation for the pinned official confirmation application."""
from __future__ import annotations

import json

# Script is a separate same-origin resource, so the page needs no inline script
# permission. No login token or cookie value is exposed to the official JS.
BRIDGE = r'''(() => {
  "use strict";
  const script = document.currentScript;
  const base = new URL(script.src).pathname.replace(/\/bridge\.js$/, "");
  const csrf = script.dataset.csrf;
  const send = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    if (typeof input !== "string" || !/^\/(api\/|static\/|ai-image-comparison\/)/.test(input)) {
      return Promise.reject(new Error("Unsupported confirmation request"));
    }
    if (input === "/api/shutdown") return Promise.resolve(new Response("{}", {status: 200}));
    const headers = new Headers(options.headers || {});
    if ((options.method || "GET").toUpperCase() === "POST") headers.set("X-PPT-CSRF", csrf);
    return send(base + input, {...options, headers, credentials: "same-origin", redirect: "error"}).then(response => {
      if (input === "/api/confirm" && response.status === 422) {
        return response.clone().json().then(problem => {
          const status = document.getElementById("confirm-status");
          const button = document.getElementById("btn-confirm");
          if (typeof problem.error === "string" && status && button) {
            status.textContent = problem.error;
            button.disabled = false;
            // The pinned app replaces all failures with a generic retry label.
            // Keep this handled request out of that callback; the next click
            // uses the same unreserved session and can submit corrected input.
            return new Promise(() => {});
          }
          return response;
        }, () => response);
      }
      if (input === "/api/confirm" && response.ok) {
        document.getElementById("sections").style.display = "none";
        document.getElementById("actionbar").style.display = "none";
        const loading = document.getElementById("loading");
        loading.style.display = "block";
        loading.textContent = "确认已保存，请返回团团查看下一阶段。";
        window.fetch = () => Promise.reject(new Error("Confirmation saved; return to Tuantuan"));
        // The host, not the upstream poll loop, owns stage/session transitions.
        return new Promise(() => {});
      }
      return response;
    });
  };
})();
'''


def adapt_response(route: str, content_type: str, body: bytes, *, csrf: str = "") -> bytes:
    if route == "/":
        text = body.decode("utf-8")
        text = text.replace('href="/static/', 'href="./static/').replace('src="/static/', 'src="./static/')
        # Tokens are generated URL-safe by the host, never user-authored markup.
        bridge = f'<script src="./bridge.js" data-csrf="{csrf}"></script>'
        text = text.replace('<script src="./static/app.js">', bridge + '<script src="./static/app.js">')
        return text.encode("utf-8")
    if route == "/static/app.js":
        # Dynamic image src attributes do not pass through window.fetch.
        text = body.decode("utf-8")
        text = text.replace('"/static/style_previews/', '"./static/style_previews/')
        text = text.replace('"/ai-image-comparison/', '"./ai-image-comparison/')
        return text.encode("utf-8")
    if route == "/api/health":
        return b'{"status":"ok","service":"confirm_ui"}'
    if route == "/api/session":
        data = json.loads(body)
        allowed = {"phase", "status", "current_stage", "expected_stage", "expected_stage_number",
                   "recommendation_stage", "recommendation_stage_number", "result_stage", "result_stage_number",
                   "template_status"}
        return json.dumps({key: value for key, value in data.items() if key in allowed}).encode("utf-8")
    if route == "/api/recommendations":
        data = json.loads(body)

        def public(value):
            if isinstance(value, list):
                return [public(item) for item in value]
            if isinstance(value, dict):
                return {key: (value.get("key", "内置模板") if key == "workspace_root"
                              else [] if key in {"explicit_workspace_roots", "root_snapshots"} else public(item))
                        for key, item in value.items()}
            return value

        return json.dumps(public(data), ensure_ascii=False).encode("utf-8")
    return body


SECURITY_HEADERS = {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                               "img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; "
                               "base-uri 'none'; form-action 'none'; object-src 'none'",
}
