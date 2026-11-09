"""Host response adapter isolates official root paths and hides process metadata."""
import json

from app.presentations.confirmation_proxy import BRIDGE, SECURITY_HEADERS, adapt_response


def test_html_loads_host_bridge_before_official_script_with_relative_resources():
    html = b'<link href="/static/style.css"><script src="/static/app.js"></script>'
    result = adapt_response("/", "text/html", html, csrf="host-token").decode()
    assert 'href="./static/style.css"' in result
    assert result.index("./bridge.js") < result.index("./static/app.js")
    assert 'data-csrf="host-token"' in result
    assert "<script>" not in result


def test_dynamic_image_paths_are_job_relative_without_rewriting_api_strings():
    js = b'fetch("/api/session"); return "/static/style_previews/"; return "/ai-image-comparison/";'
    result = adapt_response("/static/app.js", "text/javascript", js).decode()
    assert 'fetch("/api/session")' in result  # bridge supplies prefix + credentials
    assert '"./static/style_previews/' in result
    assert '"./ai-image-comparison/' in result


def test_health_and_session_never_expose_internal_process_or_error_paths():
    body = json.dumps({"status": "ok", "pid": 123, "project": "C:/private", "server_port": 5001,
                       "recommendation_error": "C:/private", "template_error": "C:/private",
                       "recommendation_stage_number": 1}).encode()
    for route in ["/api/health", "/api/session"]:
        result = adapt_response(route, "application/json", body)
        assert b"private" not in result and b"5001" not in result and b"123" not in result
    assert json.loads(adapt_response("/api/session", "application/json", body))["recommendation_stage_number"] == 1


def test_recommendations_keep_selection_keys_but_hide_template_paths():
    body = json.dumps({"template_options": {
        "explicit_workspace_roots": ["D:/private/template"],
        "root_snapshots": [{"workspace_root": "D:/private/template"}],
        "candidates": [{"key": "style:clear", "workspace_root": "D:/private/template",
                        "label": "清晰", "kind": "style"}],
    }, "audience": {"value": ""}}).encode()
    result = adapt_response("/api/recommendations", "application/json", body)
    data = json.loads(result)
    assert b"private" not in result
    options = data["template_options"]
    assert options["explicit_workspace_roots"] == options["root_snapshots"] == []
    assert options["candidates"][0] == {"key": "style:clear", "workspace_root": "style:clear",
                                         "label": "清晰", "kind": "style"}
    assert data["audience"]["value"] == ""


def test_bridge_limits_fetch_scope_adds_csrf_and_never_forwards_shutdown():
    assert 'headers.set("X-PPT-CSRF", csrf)' in BRIDGE
    assert 'input === "/api/shutdown"' in BRIDGE
    assert 'redirect: "error"' in BRIDGE
    assert "localStorage" not in BRIDGE and "Authorization" not in BRIDGE
    assert "确认已保存" in BRIDGE
    assert "script-src 'self'" in SECURITY_HEADERS["Content-Security-Policy"]
    assert "base-uri 'none'" in SECURITY_HEADERS["Content-Security-Policy"]
