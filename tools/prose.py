"""Paragraphs short enough to read.

A paragraph or a list item of more than LIMIT_BLOCK words, or a table cell of
more than LIMIT_CELL, hides its rules in its length: a reader skims it and
misses the clause that matters. Such a block is split by structure (separate
paragraphs, a list, a table) or cut, not reflowed. Link targets do not count,
nor do a table cell's code spans (test titles and keys it cites); code blocks
are not prose and are skipped. tests/test_prose.py runs this over
every tracked Markdown file.

    python tools/prose.py          list the blocks over the limits
"""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LIMIT_BLOCK = 120
LIMIT_CELL = 100
SKIP = ("fuzz-findings/",)

LIST_ITEM = re.compile(r"^(?:[-*+]|\d+\.)\s")
LINK_TARGET = re.compile(r"\]\([^)]*\)")
CODE_SPAN = re.compile(r"`[^`]*`")


def documents() -> list[Path]:
    listed = subprocess.run(["git", "ls-files", "*.md"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [ROOT / name for name in listed.split() if not name.startswith(SKIP)]


def words(text: str, *, code: bool = True) -> int:
    text = LINK_TARGET.sub("]", text)
    if not code:
        text = CODE_SPAN.sub("", text)
    return len(text.split())


def blocks(text: str):
    """(kind, first line number, text) for every paragraph, list item and table cell."""
    current: list[str] = []
    kind, start, fenced = "paragraph", 0, False

    def flush():
        nonlocal current
        if current:
            found.append((kind, start, " ".join(current)))
        current = []

    found: list[tuple[str, int, str]] = []
    for number, line in enumerate(text.split("\n"), 1):
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            flush()
            fenced = not fenced
            continue
        if fenced:
            continue
        if not stripped or stripped.startswith(("#", "<!--")):
            flush()
            continue
        if stripped.startswith("|"):
            flush()
            for cell in stripped.strip("|").split("|"):
                found.append(("table cell", number, cell.strip()))
            continue
        if LIST_ITEM.match(stripped):
            flush()
            kind, start = "list item", number
            current = [stripped]
            continue
        if not current:
            kind, start = "paragraph", number
        current.append(stripped)
    flush()
    return found


def too_long(path: Path) -> list[str]:
    problems = []
    for kind, number, text in blocks(path.read_text(encoding="utf-8")):
        limit = LIMIT_CELL if kind == "table cell" else LIMIT_BLOCK
        # a table cell's code spans are references (test titles, keys), not prose
        count = words(text, code=kind != "table cell")
        if count > limit:
            where = path.relative_to(ROOT).as_posix()
            problems.append(f"{where}:{number}: a {kind} of {count} words (limit {limit}): {text[:70]}…")
    return problems


def problems() -> list[str]:
    return [problem for path in documents() for problem in too_long(path)]


if __name__ == "__main__":
    found = problems()
    for line in found:
        print(line)
    print(f"{len(found)} blocks over the limits", file=sys.stderr)
    sys.exit(1 if found else 0)
