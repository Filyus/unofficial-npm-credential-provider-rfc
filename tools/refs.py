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
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

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


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    if command == "init":
        sys.exit(init())
    if command == "pin":
        sys.exit(pin(sys.argv[2]))
    for line in problems():
        print(line)
    sys.exit(1 if problems() else 0)
