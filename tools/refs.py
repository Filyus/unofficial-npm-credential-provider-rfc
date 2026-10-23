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
    python tools/refs.py init            add addresses the list lacks, drop those nobody cites
    python tools/refs.py pin YYYY-MM-DD  pin branch links to commits
    python tools/refs.py fetch N         save the text of up to N pages not yet saved

`fetch` reads only addresses the documents already cite, one request each,
never follows a link or a redirect to another host, obeys robots.txt, waits two seconds between requests to a
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
# Any ref that is not a full commit id: a branch moves, and so does a tag (it can be
# deleted and made again), so only a 40-hex id keeps pointing at the file we read.
BRANCH_SOURCE = re.compile(r"^(https://github\.com/[^/]+/[^/]+/blob/)(?![0-9a-f]{40}/)([^/]+)(/.+)$")
PINNED_SOURCE = re.compile(r"^https://github\.com/[^/]+/[^/]+/blob/[0-9a-f]{40}/.+$")


def documents() -> list[Path]:
    # the tracked documents, as tools/prose.py reads them: a directory walk would
    # also read another worktree checked out under .claude/worktrees/
    listed = subprocess.run(["git", "ls-files", "*.md"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return sorted(ROOT / name for name in listed.split() if not SKIP & set(Path(name).parts))


def key(url: str) -> str:
    return url.split("#")[0]


FENCE = re.compile(r"^(```|~~~)[^\n]*\n.*?^\1[^\n]*$", re.M | re.S)


def links_in(text: str) -> list[str]:
    """The addresses a document cites. A fenced block is text to copy somewhere
    else, a pull request body for instance, and cites nothing: its links point
    at this repository's main branch because they are read where it is pasted."""
    return [match.group(1) or match.group(2) for match in LINK.finditer(FENCE.sub("", text))]


def cited() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for path in documents():
        for url in links_in(path.read_text(encoding="utf-8")):
            found.setdefault(key(url), []).append(str(path.relative_to(ROOT)).replace("\\", "/"))
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
    """Adds the addresses the list lacks and drops, with their saved copy, those nobody cites."""
    manifest, found, added, dropped = load(), cited(), 0, 0
    for url in found:
        if url not in manifest:
            manifest[url] = {"kind": kind(url), "cited": first_cited(url) or time.strftime("%Y-%m-%d")}
            added += 1
    for url in [url for url in manifest if url not in found]:
        copy = ROOT / manifest.pop(url).get("file", "")
        if copy.is_file():
            copy.unlink()
        dropped += 1
    save(manifest)
    print(f"{added} added, {dropped} dropped, {len(manifest)} in all")
    return 0


def pin_text(text: str, changed: dict[str, str]) -> str:
    """Rewrites the links whose whole target (anchor apart) is a key of `changed`; a
    longer address that merely starts with one is another file and stays."""
    def one(match: re.Match) -> str:
        group = 1 if match.group(1) else 2
        url = match.group(group)
        base, hash_, fragment = url.partition("#")
        if base not in changed:
            return match.group(0)
        start, end = match.start(group) - match.start(), match.end(group) - match.start()
        return match.group(0)[:start] + changed[base] + hash_ + fragment + match.group(0)[end:]
    return LINK.sub(one, text)


def pin(day: str) -> int:
    changed: dict[str, str] = {}
    for url in cited():
        match = BRANCH_SOURCE.match(url)
        if not match:
            continue
        owner_repo = "/".join(url.split("/")[3:5])
        ref = match.group(2)
        path = match.group(3)[1:]
        sha = subprocess.run(
            ["gh", "api", "--method", "GET", f"repos/{owner_repo}/commits", "-f", f"sha={ref}", "-f", f"path={path}", "-f", f"until={day}T23:59:59Z", "-f", "per_page=1", "--jq", ".[0].sha"],
            capture_output=True, text=True,
        ).stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            print(f"no commit for {url} on or before {day}", file=sys.stderr)
            return 1
        changed[url] = f"{match.group(1)}{sha}/{path}"
    manifest = load()
    for path in documents():
        text = path.read_text(encoding="utf-8")
        new = pin_text(text, changed)
        if new != text:
            path.write_text(new, encoding="utf-8", newline="\n")
    for old, pinned in changed.items():
        entry = manifest.pop(old, None) or {"kind": "source", "cited": first_cited(old) or time.strftime("%Y-%m-%d")}
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


class SameHost(urllib.request.HTTPRedirectHandler):
    """A redirect to another host is not followed: robots.txt was read for the host cited, not for that one."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            raise urllib.error.HTTPError(req.full_url, code, f"redirect to another host: {newurl}", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(SameHost)
USER_AGENT = "npm-auth-rfc-refs/1 (a private copy of pages this repository cites)"
UNREACHABLE = "robots.txt unreachable"


def robots_of(host: str, opener=OPENER) -> tuple[urllib.robotparser.RobotFileParser | None, str]:
    """The rules of a host and, when there are none to obey, why the host is skipped.
    A 2xx answer is parsed. 401 and 403 disallow everything (as the standard library
    reads them, and the cautious reading of RFC 9309, which lets a crawler go on after
    any 4xx). Another 4xx, 429 apart, means no rules. A 5xx, 429, a redirect to another
    host or a network error is "unreachable", which RFC 9309 treats as disallow all:
    the host is skipped for now and tried again on the next run."""
    parser = urllib.robotparser.RobotFileParser(f"https://{host}/robots.txt")
    request = urllib.request.Request(parser.url, headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(request, timeout=30) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            parser.disallow_all = True
            return parser, f"robots.txt disallows (HTTP {error.code})"
        if 400 <= error.code < 500 and error.code != 429:
            parser.allow_all = True
            return parser, ""
        return None, f"{UNREACHABLE}: HTTP {error.code}"
    except (urllib.error.URLError, OSError) as error:
        return None, f"{UNREACHABLE}: {error}"
    parser.parse(body.decode("utf-8", errors="replace").splitlines())
    return parser, ""


def fetch(limit: int) -> int:
    manifest = load()
    robots: dict[str, tuple[urllib.robotparser.RobotFileParser | None, str]] = {}
    last: dict[str, float] = {}
    refused: set[str] = set()
    todo = [url for url, entry in manifest.items() if entry["kind"] != "source" and "sha256" not in entry and (not entry.get("status") or entry["status"].startswith(UNREACHABLE))]
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
            robots[host] = robots_of(host)
        parser, why = robots[host]
        if parser is None:
            manifest[url]["status"] = why
            print(f"skipped ({why}): {url}")
            continue
        if not parser.can_fetch(USER_AGENT, url):
            manifest[url]["status"] = why or "robots.txt disallows"
            print(f"skipped (robots.txt): {url}")
            continue
        wait = last.get(host, 0) + 2 - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        last[host] = time.monotonic()
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain"})
            with OPENER.open(request, timeout=60) as response:
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
