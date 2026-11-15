from __future__ import annotations

from pathlib import Path


from app.feeds import curation, digest, service
from test_home_curation import home_workspace, pipeline


def test_skill_is_a_real_bundled_resource_and_missing_skill_never_searches(home_workspace, pipeline, tmp_path, monkeypatch):
    guidance = curation._skill()
    assert "正文" in guidance and "event_date" in guidance and "不凑数" in guidance
    monkeypatch.setattr(curation, "SKILL_PATH", tmp_path / "missing.md")
    service.save_preferences(["Agent"], [], "editor", curation_enabled=True)
    assert service.get_feed(refresh_if_due=False)["curation"]["status"] == "error"
    assert pipeline["search"] == []
    assert pipeline["model"] == []


def test_profile_changed_to_images_is_rejected_before_search(home_workspace, pipeline, monkeypatch):
    service.save_preferences(["Agent"], [], "editor", curation_enabled=True)
    pipeline["search"].clear()
    pipeline["model"].clear()
    monkeypatch.setattr(digest, "_resolve_connection", lambda profile_id: {"model_name": "image-only", "resolved_model_protocol": "images"})
    curation.regenerate()
    result = service.get_feed(refresh_if_due=False)["curation"]
    assert result["status"] == "error"
    assert pipeline["search"] == []
    assert pipeline["model"] == []
