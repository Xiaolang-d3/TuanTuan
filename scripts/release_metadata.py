#!/usr/bin/env python3
"""Resolve release metadata without evaluating tag names as shell code."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess


# SemVer with a required v prefix; numeric prerelease identifiers cannot have
# leading zeroes. Restrict metadata to portable, safe artifact-name characters.
NUMBER = r"(?:0|[1-9][0-9]*)"
IDENTIFIER = rf"(?:{NUMBER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
VERSION = re.compile(
    rf"v{NUMBER}\.{NUMBER}\.{NUMBER}"
    rf"(?:-{IDENTIFIER}(?:\.{IDENTIFIER})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?",
    re.ASCII,
)
SHA = re.compile(r"[0-9a-f]{40}", re.ASCII)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, timeout=60,
    ).stdout.strip()


def resolve(event: str, tag: str, ref: str, context_sha: str) -> dict[str, str]:
    if not SHA.fullmatch(context_sha):
        raise ValueError("The event must provide a full commit SHA")
    if event == "push":
        prefix = "refs/tags/"
        if not ref.startswith(prefix):
            raise ValueError("Only tag pushes can release")
        tag = ref[len(prefix):]
    elif event != "workflow_dispatch":
        raise ValueError("Unsupported release event")
    if not tag and event == "workflow_dispatch":
        return {"tag": "", "sha": context_sha, "tag_sha": "", "publish": "false"}
    if not VERSION.fullmatch(tag):
        raise ValueError("Expected a version tag such as v2.0.0 or v2.0.0-rc.1")

    # Fetch the exact tag namespace, never a branch or an ambiguous short ref.
    git("fetch", "--no-tags", "origin", f"refs/tags/{tag}")
    tag_sha = git("rev-parse", "--verify", "FETCH_HEAD")
    sha = git("rev-parse", "--verify", "FETCH_HEAD^{commit}")
    if not SHA.fullmatch(tag_sha) or not SHA.fullmatch(sha):
        raise ValueError("Tag must resolve to a commit")
    if event == "push" and sha != context_sha:
        raise ValueError("The pushed tag has moved since this event")
    return {"tag": tag, "sha": sha, "tag_sha": tag_sha, "publish": "true"}


def check(tag: str, tag_sha: str, sha: str) -> None:
    if not VERSION.fullmatch(tag) or not SHA.fullmatch(tag_sha) or not SHA.fullmatch(sha):
        raise ValueError("Invalid resolved release metadata")
    if git("rev-parse", "HEAD") != sha:
        raise ValueError("Publishing checkout does not match the verified SHA")
    ref = f"refs/tags/{tag}"
    remote = git("ls-remote", "--exit-code", "--refs", "origin", ref)
    if remote != f"{tag_sha}\t{ref}":
        raise ValueError("Remote release tag has moved or was deleted")


def main() -> None:
    if os.environ.get("RELEASE_CHECK") == "true":
        check(os.environ["RELEASE_TAG"], os.environ["RELEASE_TAG_SHA"], os.environ["RELEASE_SHA"])
        return
    values = resolve(
        os.environ["RELEASE_EVENT"], os.environ.get("REQUESTED_TAG", ""),
        os.environ["EVENT_REF"], os.environ["EVENT_SHA"],
    )
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


if __name__ == "__main__":
    main()
