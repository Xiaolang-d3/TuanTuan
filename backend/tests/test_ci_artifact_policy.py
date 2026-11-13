"""Contracts for CI artifact uploads and candidate provenance."""
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def workflow(name):
    return yaml.load((ROOT / f".github/workflows/{name}.yml").read_text(encoding="utf-8"), Loader=yaml.BaseLoader)

def test_pull_requests_do_not_require_artifact_uploads_for_success():
    jobs = workflow("ci")["jobs"]
    frontend = jobs["frontend-unit"]["steps"]
    assert any(step.get("run") == "npm run test" for step in frontend)
    assert any(step.get("run") == "npm run build" for step in frontend)
    build_artifact = next(step for step in frontend if step.get("name") == "Upload frontend dist")
    assert build_artifact["if"] == "github.event_name != 'pull_request'"
    assert build_artifact["with"]["name"] == "frontend-dist"
    assert int(build_artifact["with"]["retention-days"]) == 14

    backend = jobs["backend-tests"]["steps"]
    assert any("-m pytest" in step.get("run", "") for step in backend)
    report = next(step for step in backend if step.get("name") == "Upload backend test report")
    assert report["if"] == "failure()"
    assert int(report["with"]["retention-days"]) == 7


def test_candidate_build_artifact_is_still_used_for_acceptance_and_deployment():
    ci = workflow("ci")["jobs"]
    frontend = next(step for step in ci["frontend-unit"]["steps"] if step.get("name") == "Upload frontend dist")
    acceptance = next(step for step in ci["frontend-e2e"]["steps"] if step.get("name") == "Restore frontend dist")
    cd = workflow("cd")["jobs"]["publish"]
    deployment = next(step for step in cd["steps"] if step.get("uses", "").startswith("actions/download-artifact@"))
    release = workflow("release")["jobs"]["publish"]
    publication = next(step for step in release["steps"] if step.get("name") == "Download frontend dist")
    assert frontend["with"]["name"] == acceptance["with"]["name"]
    assert frontend["with"]["name"] == deployment["with"]["name"] == publication["with"]["name"]
    assert deployment["with"]["run-id"] == "${{ github.event.workflow_run.id }}"
