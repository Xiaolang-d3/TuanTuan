"""Send a short notice, plus the merged PR's screenshots, to the QQ group.

Runs from .github/workflows/qq-notify.yml on every push to main. A failed
notice is reported as a workflow warning and never fails the push.
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

MAX_IMAGES = 3
MAX_IMAGE_BYTES = 8 * 1024 * 1024
QQ_API = "https://api.sgroup.qq.com"
IMAGE_PATTERNS = (
    re.compile(r"!\[[^\]]*\]\(\s*<?(https?://[^\s)>]+)>?(?:\s+\"[^\"]*\")?\s*\)"),
    re.compile(r"<img\b[^>]*\bsrc=[\"'](https?://[^\"']+)[\"']", re.IGNORECASE),
)
PR_SUFFIX = re.compile(r"\s*\(#(\d+)\)$")


def warn(message):
    print(f"::warning::QQ notice: {message}")


def describe(commit):
    """Return the commit's first line without a trailing (#N), and N if present."""
    title = (commit.get("message") or "").splitlines()[0].strip() if commit.get("message") else ""
    match = PR_SUFFIX.search(title)
    return (title[: match.start()], int(match.group(1))) if match else (title, None)


def local_time(stamp):
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return ""
    return moment.astimezone(timezone(timedelta(hours=8))).strftime("%m-%d %H:%M")


def build_text(event, repo):
    head = event.get("head_commit") or {}
    commits = event.get("commits") or ([head] if head else [])
    items = [describe(commit) for commit in commits]
    pusher = (event.get("pusher") or {}).get("name") or os.environ.get("GITHUB_ACTOR", "")
    author = (head.get("author") or {}).get("name") or pusher

    lines = ["【团团】main 已更新"]
    if len(items) == 1:
        lines.append(f"内容：{items[0][0][:60]}")
    else:
        lines.append(f"内容：共 {len(items)} 项")
        for index, (title, _) in enumerate(items[-5:], 1):
            lines.append(f"  {index}. {title[:50]}")
    lines.append(f"作者：{author}")
    when = local_time(head.get("timestamp"))
    if when:
        lines.append(f"时间：{when}")

    number = items[0][1] if len(items) == 1 else None
    if number:
        link = f"https://github.com/{repo}/pull/{number}"
    elif len(items) > 1:
        link = event.get("compare")
    else:
        link = head.get("url")
    if link:
        lines.append(f"链接：{link}")
    return "\n".join(lines), number


def image_urls(body):
    """Image URLs in a PR description, in order of appearance, without duplicates."""
    found = []
    for pattern in IMAGE_PATTERNS:
        found.extend((match.start(), match.group(1)) for match in pattern.finditer(body or ""))
    urls = []
    for _, url in sorted(found):
        if url not in urls:
            urls.append(url)
    return urls


def request(url, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    merged = {"Content-Type": "application/json", **(headers or {})} if data else dict(headers or {})
    req = urllib.request.Request(url, data=data, headers=merged, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def github_json(path, token):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "tuantuan-qq-notify"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return json.loads(request(f"https://api.github.com{path}", headers=headers))


def merged_pr_body(repo, number, sha, token):
    try:
        if number is None:
            pulls = github_json(f"/repos/{repo}/commits/{sha}/pulls", token)
            pulls = [pull for pull in pulls if pull.get("merged_at")]
            if len(pulls) != 1:
                return ""
            number = pulls[0]["number"]
        return github_json(f"/repos/{repo}/pulls/{number}", token).get("body") or ""
    except (urllib.error.URLError, ValueError, KeyError) as error:
        warn(f"could not read PR description: {error}")
        return ""


def download_image(url, token):
    """Download one image; GitHub attachment links may need the workflow token."""
    attempts = [{}]
    if token and urllib.parse.urlparse(url).hostname in {"github.com", "raw.githubusercontent.com"}:
        attempts.append({"Authorization": f"Bearer {token}"})
    for headers in attempts:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tuantuan-qq-notify", **headers})
            with urllib.request.urlopen(req, timeout=30) as response:
                kind = response.headers.get_content_type()
                data = response.read(MAX_IMAGE_BYTES + 1)
        except urllib.error.URLError:
            continue
        if not kind.startswith("image/"):
            warn(f"skipped non-image attachment ({kind})")
            return None
        if len(data) > MAX_IMAGE_BYTES:
            warn("skipped an image larger than 8 MB")
            return None
        return data
    warn("could not download a screenshot")
    return None


def qq_token():
    reply = request(
        "https://bots.qq.com/app/getAppAccessToken",
        {"appId": os.environ["QQ_APP_ID"], "clientSecret": os.environ["QQ_APP_SECRET"]},
    )
    return json.loads(reply)["access_token"]


def send_group(token, body):
    group = os.environ["QQ_GROUP_OPENID"]
    reply = request(f"{QQ_API}/v2/groups/{group}/messages", body, {"Authorization": f"QQBot {token}"})
    return json.loads(reply or b"{}").get("id", "")


def send_image(token, data, sequence, label):
    group = os.environ["QQ_GROUP_OPENID"]
    upload = json.loads(
        request(
            f"{QQ_API}/v2/groups/{group}/files",
            {"file_type": 1, "file_data": base64.b64encode(data).decode(), "srv_send_msg": False},
            {"Authorization": f"QQBot {token}"},
            timeout=60,
        )
    )
    return send_group(
        token,
        {"msg_type": 7, "content": label, "media": {"file_info": upload["file_info"]}, "msg_seq": sequence},
    )


def main():
    event = json.load(open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8"))
    repo = os.environ["GITHUB_REPOSITORY"]
    github_token = os.environ.get("GITHUB_TOKEN", "")
    text, number = build_text(event, repo)

    images = []
    commits = event.get("commits") or []
    if len(commits) <= 1:
        sha = (event.get("head_commit") or {}).get("id") or event.get("after", "")
        urls = image_urls(merged_pr_body(repo, number, sha, github_token))
        for url in urls[:MAX_IMAGES]:
            data = download_image(url, github_token)
            if data:
                images.append(data)
        if len(urls) > MAX_IMAGES:
            text += f"\n截图：{len(urls)} 张，群内展示前 {MAX_IMAGES} 张"

    if os.environ.get("QQ_NOTIFY_DRY_RUN"):
        print(text)
        print(f"[dry run] {len(images)} screenshot(s)")
        return

    try:
        token = qq_token()
        print("sent", send_group(token, {"msg_type": 0, "content": text, "msg_seq": 1}))
    except (urllib.error.URLError, ValueError, KeyError) as error:
        detail = error.read().decode("utf-8", "replace")[:300] if isinstance(error, urllib.error.HTTPError) else error
        warn(f"text failed: {detail}")
        return

    for index, data in enumerate(images, 1):
        label = f"截图 {index}/{len(images)}"
        try:
            print("sent", send_image(token, data, index + 1, label))
        except (urllib.error.URLError, ValueError, KeyError) as error:
            detail = error.read().decode("utf-8", "replace")[:300] if isinstance(error, urllib.error.HTTPError) else error
            warn(f"{label} failed: {detail}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # A notice must never mark the push as failed.
        warn(f"unexpected error: {error}")
    sys.exit(0)
