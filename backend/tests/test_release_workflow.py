"""Offline regression contracts for release identity, input safety and permissions."""
from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_metadata", ROOT / "scripts/release_metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)
OLD = "a" * 40
NEW = "b" * 40
TAG_OBJECT = "c" * 40


def workflow(name):
    # BaseLoader keeps GitHub's `on` key and boolean-like scalar values literal.
    return yaml.load((ROOT / f".github/workflows/{name}.yml").read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def mock_tag(monkeypatch, *, sha=NEW, tag_object=TAG_OBJECT):
    calls = []

    def git(*args):
        calls.append(args)
        if args[0] == "fetch":
            return ""
        return sha if args[-1] == "FETCH_HEAD^{commit}" else tag_object

    monkeypatch.setattr(metadata, "git", git)
    return calls


@pytest.mark.parametrize("tag", ["v0.0.0", "v2.0.0", "v2.1.0-rc.1", "v2.1.0+build.01", "v2.1.0-alpha-beta.2"])
def test_manual_release_resolves_exact_tag_not_dispatch_branch(monkeypatch, tag):
    calls = mock_tag(monkeypatch)
    result = metadata.resolve("workflow_dispatch", tag, "refs/heads/main", OLD)
    assert result == {"tag": tag, "sha": NEW, "tag_sha": TAG_OBJECT, "publish": "true"}
    assert calls == [
        ("fetch", "--no-tags", "origin", f"refs/tags/{tag}"),
        ("rev-parse", "--verify", "FETCH_HEAD"),
        ("rev-parse", "--verify", "FETCH_HEAD^{commit}"),
    ]


@pytest.mark.parametrize("tag", ["main", "refs/tags/v2.0.0", "v2", "v01.0.0", "v2.0.0-01", "v2.0.0/evil", "v$(id)", 'v2.0.0";id;"', "v2.0.0\nsha=bad", " v2.0.0"])
def test_unsafe_or_nonversion_tags_fail_before_git(monkeypatch, tag):
    monkeypatch.setattr(metadata, "git", lambda *_: pytest.fail("invalid tag reached git"))
    with pytest.raises(ValueError, match="version tag"):
        metadata.resolve("workflow_dispatch", tag, "refs/heads/main", OLD)


def test_missing_tag_cannot_fall_back_to_a_branch(monkeypatch):
    def git(*args):
        assert args == ("fetch", "--no-tags", "origin", "refs/tags/v2.0.0")
        raise subprocess.CalledProcessError(128, ["git", *args])
    monkeypatch.setattr(metadata, "git", git)
    with pytest.raises(subprocess.CalledProcessError):
        metadata.resolve("workflow_dispatch", "v2.0.0", "refs/heads/main", OLD)


def test_tag_push_uses_event_tag_and_rejects_movement(monkeypatch):
    mock_tag(monkeypatch)
    assert metadata.resolve("push", "ignored", "refs/tags/v2.0.0", NEW)["sha"] == NEW
    with pytest.raises(ValueError, match="moved"):
        metadata.resolve("push", "", "refs/tags/v2.0.0", OLD)
    with pytest.raises(ValueError, match="tag pushes"):
        metadata.resolve("push", "v2.0.0", "refs/heads/main", NEW)


def test_lightweight_tag_is_resolved_to_its_commit(monkeypatch):
    mock_tag(monkeypatch, tag_object=NEW)
    result = metadata.resolve("workflow_dispatch", "v2.0.0", "refs/heads/main", OLD)
    assert result["tag_sha"] == result["sha"] == NEW


def test_noncommit_tag_is_rejected(monkeypatch):
    def git(*args):
        if args[-1] == "FETCH_HEAD^{commit}":
            raise subprocess.CalledProcessError(128, ["git", *args])
        return TAG_OBJECT if args[0] == "rev-parse" else ""
    monkeypatch.setattr(metadata, "git", git)
    with pytest.raises(subprocess.CalledProcessError):
        metadata.resolve("workflow_dispatch", "v2.0.0", "refs/heads/main", OLD)


def test_blank_manual_tag_only_builds_current_sha(monkeypatch):
    monkeypatch.setattr(metadata, "git", lambda *_: pytest.fail("build-only needs no tag"))
    assert metadata.resolve("workflow_dispatch", "", "refs/heads/main", OLD) == {
        "tag": "", "sha": OLD, "tag_sha": "", "publish": "false",
    }


@pytest.mark.parametrize("head,remote,valid", [
    (NEW, TAG_OBJECT, True), (OLD, TAG_OBJECT, False), (NEW, OLD, False), (NEW, "", False),
])
def test_publish_rechecks_exact_remote_tag_object_and_checkout(monkeypatch, head, remote, valid):
    def git(*args):
        if args == ("rev-parse", "HEAD"):
            return head
        assert args == ("ls-remote", "--exit-code", "--refs", "origin", "refs/tags/v2.0.0")
        return f"{remote}\trefs/tags/v2.0.0" if remote else ""
    monkeypatch.setattr(metadata, "git", git)
    if valid:
        metadata.check("v2.0.0", TAG_OBJECT, NEW)
    else:
        with pytest.raises(ValueError):
            metadata.check("v2.0.0", TAG_OBJECT, NEW)


def test_metadata_outputs_only_validated_values(monkeypatch):
    output = io.StringIO()
    # Keep even GitHub output-file writes in memory; no runner or network needed.
    from contextlib import nullcontext
    monkeypatch.setattr(Path, "open", lambda *_args, **_kwargs: nullcontext(output))
    mock_tag(monkeypatch)
    for key, value in {"GITHUB_OUTPUT": "outputs", "RELEASE_EVENT": "workflow_dispatch", "REQUESTED_TAG": "v2.0.0", "EVENT_REF": "refs/heads/main", "EVENT_SHA": OLD}.items():
        monkeypatch.setenv(key, value)
    metadata.main()
    assert output.getvalue().splitlines() == [f"tag=v2.0.0", f"sha={NEW}", f"tag_sha={TAG_OBJECT}", "publish=true"]


def test_release_verification_and_publish_share_resolved_sha():
    release = workflow("release")
    jobs = release["jobs"]
    assert jobs["verify"]["needs"] == "resolve"
    assert jobs["verify"]["with"]["ref"] == "${{ needs.resolve.outputs.sha }}"
    publish = jobs["publish"]
    assert publish["needs"] == ["resolve", "verify"]
    checkout = next(step for step in publish["steps"] if step.get("uses", "").startswith("actions/checkout@"))
    assert checkout["with"]["ref"] == jobs["verify"]["with"]["ref"]
    assert publish["if"] == "needs.resolve.outputs.publish == 'true'"
    assert release["permissions"] == {"contents": "read"}
    assert publish["permissions"] == {"contents": "write"}
    for job_name in ["resolve", "publish"]:
        for step in jobs[job_name]["steps"]:
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] == "false"
            assert "${{ inputs.tag }}" not in step.get("run", "")
            assert "${{ github.ref_name }}" not in step.get("run", "")
    steps = publish["steps"]
    checker = next(step for step in steps if step.get("env", {}).get("RELEASE_CHECK") == "true")
    create = next(step for step in steps if "gh release create" in step.get("run", ""))
    assert steps.index(checker) < steps.index(create)
    assert "$RUNNER_TEMP/release-checker/release_metadata.py" in checker["run"]
    script = create["run"]
    assert script.startswith("set -euo pipefail\n")
    assert "--clobber" not in script and "gh release view" not in script
    assert script.index("gh release create") < script.index("gh release upload") < script.index("gh release edit")
    assert "--draft --verify-tag" in script


def test_all_ci_checkouts_use_optional_ref_and_guard_is_required():
    ci = workflow("ci")
    assert ci["on"]["workflow_call"]["inputs"]["ref"]["default"] == ""
    for job in ci["jobs"].values():
        for step in job.get("steps", []):
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step["with"]["ref"] == "${{ inputs.ref || '' }}"
                assert step["with"]["persist-credentials"] == "false"
    for name in ["docs-sync", "backend-tests", "backend-windows-documents", "frontend-unit"]:
        assert ci["jobs"][name]["needs"] == "validate-ref"
    gate = ci["jobs"]["ci-gate"]
    assert "validate-ref" in gate["needs"]
    assert 'test "${{ needs.validate-ref.result }}" = success' in gate["steps"][0]["run"]


@pytest.mark.parametrize("requested,event,tag,remote,allowed", [
    ("", "pull_request", "", "", True),
    (OLD, "pull_request", "", "", True),
    (NEW, "pull_request", "v2.0.0", NEW, False),
    (NEW, "push", "v2.0.0", NEW, False),
    ("main", "workflow_dispatch", "v2.0.0", NEW, False),
    (NEW, "workflow_dispatch", "", NEW, False),
    (NEW, "workflow_dispatch", "v2.0.0", OLD, False),
    (NEW, "workflow_dispatch", "v$(id)", NEW, False),
    (NEW, "workflow_dispatch", "v2.0.0-01", NEW, False),
    (NEW, "workflow_dispatch", "v2.0.0", NEW, True),
])
def test_ci_ref_override_cannot_relabel_other_event_checks(monkeypatch, requested, event, tag, remote, allowed):
    step = workflow("ci")["jobs"]["validate-ref"]["steps"][0]
    code = step["run"].split("\n", 1)[1].rsplit("\nPY", 1)[0]
    for key, value in {"REQUESTED_REF": requested, "EVENT_NAME": event, "EVENT_SHA": OLD, "RELEASE_TAG": tag, "REPOSITORY": "test/repo"}.items():
        monkeypatch.setenv(key, value)
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        assert args == ["git", "ls-remote", "--exit-code", "https://github.com/test/repo.git", "refs/tags/v2.0.0", "refs/tags/v2.0.0^{}"]
        return SimpleNamespace(stdout=f"{TAG_OBJECT}\trefs/tags/v2.0.0\n{remote}\trefs/tags/v2.0.0^{{}}\n")
    monkeypatch.setattr(subprocess, "run", run)
    try:
        exec(compile(code, "ci-ref-guard", "exec"), {})
    except SystemExit as error:
        assert (error.code == 0) is allowed
    else:
        assert allowed
    if calls:
        assert event == "workflow_dispatch" and tag == "v2.0.0"
