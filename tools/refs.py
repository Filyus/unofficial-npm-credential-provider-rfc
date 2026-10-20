"""The sources the documents cite.

refs.json lists every address a markdown link in this repository points to,
with the day it was first cited (from git history) and what kind of source it
is. `check` fails when a document cites an address the list does not have, when
the list has an address nobody cites, and when a link to source code names a
branch instead of a commit, because a branch moves and the file we read does
not stay where the link points. `pin` rewrites such links to the last commit of
that file on or before a day, through the GitHub API. Copies of the pages live
in .refs/ (not tracked); see `fetch`.

    python tools/refs.py check
    python tools/refs.py init            add addresses the list lacks
    python tools/refs.py pin YYYY-MM-DD  pin branch links to commits
    python tools/refs.py fetch N         save the text of up to N pages not yet saved

`fetch` reads only addresses the documents already cite, one request each,
never follows a link, obeys robots.txt, waits two seconds between requests to a
host, and gives up on a host that answers 403 or 429. It keeps the text without
markup in .refs/ and records the day and sha256 in refs.json.
"""

from __future__ import annotations

import hashlib
from itertools import zip_longest
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "refs.json"
SKIP = {".git", "target", "node_modules", ".refs", "__pycache__"}
LINK = re.compile(r"\]\((https?://[^)\s]+)\)|<(https?://[^>\s]+)>")
BRANCH_SOURCE = re.compile(r"^(https://github\.com/[^/]+/[^/]+/blob/)(master|main)(/.+)$")
PINNED_SOURCE = re.compile(r"^https://github\.com/[^/]+/[^/]+/blob/[0-9a-f]{40}/.+$")


def documents() -> list[Path]:
    return sorted(path for path in ROOT.rglob("*.md") if not SKIP & set(path.relative_to(ROOT).parts))


def key(url: str) -> str:
    return url.split("#")[0]


def cited() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for path in documents():
        text = path.read_text(encoding="utf-8")
        for match in LINK.finditer(text):
            found.setdefault(key(match.group(1) or match.group(2)), []).append(str(path.relative_to(ROOT)).replace("\\", "/"))
    return found


def kind(url: str) -> str:
    if PINNED_SOURCE.match(url) or BRANCH_SOURCE.match(url):
        return "source"
    if re.match(r"https://github\.com/[^/]+/[^/]+/(issues|pull|discussions)/", url) or "/discussions/" in url:
        return "discussion"
    if "rfc-editor.org" in url:
        return "standard"
    return "page"


def load() -> dict[str, dict]:
    return json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}


def save(manifest: dict[str, dict]) -> None:
    text = json.dumps(dict(sorted(manifest.items())), indent=2, ensure_ascii=False) + "\n"
    MANIFEST.write_text(text, encoding="utf-8", newline="\n")


def problems() -> list[str]:
    manifest, found = load(), cited()
    out = [f"cited and not in refs.json: {url} ({found[url][0]})" for url in found if url not in manifest]
    out += [f"in refs.json and cited nowhere: {url}" for url in manifest if url not in found]
    out += [f"a branch, not a commit: {url} ({found[url][0]})" for url in found if BRANCH_SOURCE.match(url)]
    return out


def first_cited(url: str) -> str:
    log = subprocess.run(["git", "log", "-S" + url, "--format=%cs", "--reverse"], cwd=ROOT, capture_output=True, text=True).stdout.split()
    return log[0] if log else ""


def init() -> int:
    manifest, added = load(), 0
    for url in cited():
        if url not in manifest:
            manifest[url] = {"kind": kind(url), "cited": first_cited(url)}
            added += 1
    save(manifest)
    print(f"{added} added, {len(manifest)} in all")
    return 0


def pin(day: str) -> int:
    changed: dict[str, str] = {}
    for url in cited():
        match = BRANCH_SOURCE.match(url)
        if not match:
            continue
        owner_repo = "/".join(url.split("/")[3:5])
        path = match.group(3)[1:]
        sha = subprocess.run(
            ["gh", "api", "--method", "GET", f"repos/{owner_repo}/commits", "-f", f"path={path}", "-f", f"until={day}T23:59:59Z", "-f", "per_page=1", "--jq", ".[0].sha"],
            capture_output=True, text=True,
        ).stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            print(f"no commit for {url} on or before {day}", file=sys.stderr)
            return 1
        changed[url] = f"{match.group(1)}{sha}{path and '/' + path}"
    manifest = load()
    for path in documents():
        text = path.read_text(encoding="utf-8")
        new = text
        for old, pinned in changed.items():
            new = new.replace(old, pinned)
        if new != text:
            path.write_text(new, encoding="utf-8", newline="\n")
    for old, pinned in changed.items():
        entry = manifest.pop(old, {"kind": "source", "cited": ""})
        entry["pinned"] = day
        manifest[pinned] = entry
    save(manifest)
    print(f"{len(changed)} links pinned to the last commit of their file on or before {day}")
    return 0


class Text(HTMLParser):
    SKIP = {"script", "style", "nav", "header", "footer", "noscript", "svg"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.depth += 1
        if tag in {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "pre", "section"}:
            self.parts.append("\n")
        if tag in {"td", "th"}:
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if not self.depth:
            self.parts.append(data)


def text_of(body: bytes, content_type: str) -> str:
    raw = body.decode("utf-8", errors="replace")
    if "html" not in content_type:
        return raw
    parser = Text()
    parser.feed(raw)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in "".join(parser.parts).splitlines()]
    return "\n".join(line for line in lines if line) + "\n"


USER_AGENT = "npm-auth-rfc-refs/1 (a private copy of pages this repository cites)"


def fetch(limit: int) -> int:
    manifest = load()
    robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
    last: dict[str, float] = {}
    refused: set[str] = set()
    todo = [url for url, entry in manifest.items() if entry["kind"] != "source" and "sha256" not in entry and not entry.get("status")]
    by_host: dict[str, list[str]] = {}
    for url in todo:
        by_host.setdefault(urllib.parse.urlsplit(url).netloc, []).append(url)
    todo = [url for round_ in zip_longest(*by_host.values()) for url in round_ if url]
    saved = 0
    for url in todo[:limit]:
        host = urllib.parse.urlsplit(url).netloc
        if host in refused:
            continue
        if host not in robots:
            parser = urllib.robotparser.RobotFileParser(f"https://{host}/robots.txt")
            try:
                request = urllib.request.Request(parser.url, headers={"User-Agent": USER_AGENT})
                parser.parse(urllib.request.urlopen(request, timeout=30).read().decode("utf-8", errors="replace").splitlines())
                robots[host] = parser
            except (urllib.error.URLError, OSError):
                robots[host] = None
        if robots[host] is not None and not robots[host].can_fetch(USER_AGENT, url):
            manifest[url]["status"] = "robots.txt disallows"
            print(f"skipped (robots.txt): {url}")
            continue
        wait = last.get(host, 0) + 2 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        last[host] = time.monotonic()
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain"})
            with urllib.request.urlopen(request, timeout=60) as response:
                body, content_type = response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            manifest[url]["status"] = f"HTTP {error.code}"
            print(f"HTTP {error.code}: {url}")
            if error.code in (403, 429):
                refused.add(host)
            continue
        except (urllib.error.URLError, OSError) as error:
            manifest[url]["status"] = f"failed: {error}"
            print(f"failed: {url}: {error}")
            continue
        text = text_of(body, content_type)
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", urllib.parse.urlsplit(url).path.strip("/")) or "index"
        target = ROOT / ".refs" / host / (name[:120] + ".txt")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
        manifest[url].update({"fetched": time.strftime("%Y-%m-%d"), "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(), "file": str(target.relative_to(ROOT)).replace("\\", "/")})
        manifest[url].pop("status", None)
        saved += 1
        print(f"{len(text):>8} chars  {url}")
    save(manifest)
    print(f"{saved} saved")
    return 0


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    if command == "init":
        sys.exit(init())
    if command == "pin":
        sys.exit(pin(sys.argv[2]))
    if command == "fetch":
        sys.exit(fetch(int(sys.argv[2])))
    for line in problems():
        print(line)
    sys.exit(1 if problems() else 0)
