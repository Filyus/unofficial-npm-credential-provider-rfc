"""Which situations the examples show, for which registry.

The matrix is computed from what the transcripts hold (the request kinds, the
operations, the retries, the errors), never from file names, and written to
examples/COVERAGE.md. examples/coverage.json says what every empty cell is:
"n/a: reason" (the registry has no such situation, as far as the reason says),
"by design: reason" (the registry has it, and the reference provider chooses not
to show it; the reason is required), or "task N: what" (the task that will fill
it). tests/test_examples.py fails when a cell is empty and unexplained, when
an explanation is left on a cell that has since been filled, and when the page
differs from what this computes.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"

REGISTRIES = {
    "npmjs": "npmjs",
    "gitlab": "GitLab",
    "corporate-sso": "SSO gateway",
    "github-packages": "GitHub",
    "google-artifact-registry": "Google AR",
    "jfrog-artifactory": "JFrog",
    "azure-artifacts": "Azure",
    "aws-codeartifact": "AWS",
    "verdaccio": "Verdaccio",
}
WRITES = {"dist-tag", "unpublish", "deprecate", "owner", "access", "trust", "account"}
STAGE = {"stage", "stage-read", "stage-reject"}

FEATURES = {
    "install": "a `read` for `npm install`, answered with a credential",
    "login": "`login` answered `Ok`",
    "logout": "`logout` answered `Ok`",
    "publish": "an interactive `publish` answered with a credential",
    "ci-read": "a `read` with `interactive: false`, answered with a credential",
    "ci-publish": "a `publish` with `interactive: false`, answered with a credential",
    "401-erase": "`erase` after a 401, then a retry that gets a new credential",
    "401-dead": "`erase` after a 401, then a retry that ends in an error (nothing to replace it with)",
    "403-retry": "a retry with `httpStatus: 403`",
    "stage": "a `stage`, `stage-read` or `stage-reject` answered with a credential",
    "unsupported": "an `operation-not-supported` answer",
    "other-write": "`dist-tag`, `unpublish`, `deprecate`, `owner`, `access`, `trust` or `account` answered with a credential",
    "login-refused": "`login` answered with an error",
    "not-found": "a `not-found` answer",
}


def messages(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            if "message" in item:
                yield item["from"], item["message"]


def features_of(path: Path) -> set[str]:
    found: set[str] = set()
    pairs = list(messages(path))
    for index, (sender, message) in enumerate(pairs):
        if sender == "client":
            kind = message.get("kind")
            answer = pairs[index + 1][1] if index + 1 < len(pairs) and pairs[index + 1][0] == "provider" else {}
            ok = "Ok" in answer
            err = answer.get("Err", {}).get("kind")
            operation = message.get("operation")
            if err == "operation-not-supported":
                found.add("unsupported")
            if err == "not-found":
                found.add("not-found")
            if kind == "login":
                found.add("login" if ok else "login-refused")
            if kind == "logout" and ok:
                found.add("logout")
            if kind == "get" and ok:
                ci = message.get("interactive") is False
                if operation == "read":
                    if message.get("command") == "install":
                        found.add("install")
                    if ci:
                        found.add("ci-read")
                if operation == "publish":
                    found.add("ci-publish" if ci else "publish")
                if operation in STAGE:
                    found.add("stage")
                if operation in WRITES:
                    found.add("other-write")
            if message.get("httpStatus") == 403 and kind == "get":
                found.add("403-retry")
            if message.get("httpStatus") == 401 and kind == "get":
                found.add("401-dead" if err else "401-erase")
    return found


def scenarios(registry: str) -> set[str]:
    return {path.stem for path in (EXAMPLES / "providers" / registry / "scenarios").glob("*.json")}


def matrix() -> dict[str, dict[str, str]]:
    """registry -> feature -> '●' (runnable provider), '○' (transcript only) or ''."""
    table: dict[str, dict[str, str]] = {}
    for registry in REGISTRIES:
        runnable = scenarios(registry)
        cells = {feature: "" for feature in FEATURES}
        for path in sorted((EXAMPLES / registry).glob("*.jsonl")):
            for feature in features_of(path):
                if path.stem in runnable:
                    cells[feature] = "●"
                elif cells[feature] != "●":
                    cells[feature] = "○"
        table[registry] = cells
    return table


def has_provider(registry: str) -> bool:
    return (EXAMPLES / "providers" / registry / "provider.js").is_file()


def explanations() -> dict[str, dict[str, str]]:
    return json.loads((EXAMPLES / "coverage.json").read_text(encoding="utf-8"))


def mark(note: str) -> str:
    """The cell for an explained gap: `n/a`, `by design`, or the task."""
    if note.startswith("n/a:"):
        return "n/a"
    if note.startswith("by design:"):
        return "by design"
    return note.split(":")[0] if note else "?"


def render() -> str:
    table = matrix()
    notes = explanations()
    names = list(REGISTRIES.values())
    lines = [
        "<!-- Generated by tools/example_coverage.py from the transcripts and examples/coverage.json; do not edit. -->",
        "# What the examples show",
        "",
        "`●` a transcript the reference provider produces against its fake API; `○` a transcript only, written by hand because the registry has no reference provider (first row); "
        "`n/a` the registry has no such situation, as far as the reason under \"Why a cell is empty\" says (some reasons rest on an absence in the documentation, and say so); "
        "`by design` the registry has the situation and the reference provider chooses not to handle it that way, for the reason given there; "
        "`task N` not done yet: a gap, not a claim, planned under that number in the maintainer's own tracker (not in this repository).",
        "A cell is `n/a`, `by design` or `task N` only because [coverage.json](coverage.json) says so, and "
        "`tests/test_examples.py` fails when a cell is empty without it.",
        "",
        "| Situation | " + " | ".join(names) + " |",
        "|---|" + "---|" * len(names),
    ]
    provider_row = []
    for registry in REGISTRIES:
        note = notes.get(registry, {}).get("provider", "")
        provider_row.append("●" if has_provider(registry) else mark(note))
    lines.append("| reference provider | " + " | ".join(provider_row) + " |")
    for feature, meaning in FEATURES.items():
        row = []
        for registry in REGISTRIES:
            cell = table[registry][feature]
            if not cell:
                note = notes.get(registry, {}).get(feature, "")
                cell = mark(note)
            row.append(cell)
        lines.append(f"| {feature} | " + " | ".join(row) + " |")
    lines += ["", "## Situations", ""]
    lines.append("- **reference provider**: the registry has a provider in examples/providers that produces its transcripts; without one the cells show `○`")
    lines += [f"- **{feature}**: {meaning}" for feature, meaning in FEATURES.items()]
    reasons = [(registry, feature, note) for registry, cells in notes.items() for feature, note in cells.items()]
    lines += ["", "## Why a cell is empty", ""]
    for registry, feature, note in reasons:
        lines.append(f"- {REGISTRIES[registry]}, {feature}: {note}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    (EXAMPLES / "COVERAGE.md").write_text(render(), encoding="utf-8", newline="\n")
