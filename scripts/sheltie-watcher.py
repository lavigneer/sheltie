#!/usr/bin/env python3
"""sheltie-watcher: files GitHub issues for sheltie failures seen on this Mac.

Run every ~15 minutes by launchd (the dotfiles' herdr-desktop module). It reads:

  - the Herdr app's sheltie-diagnostics/ records (concrete failures, with stack
    traces), and
  - herdr-server.log (ERROR and WARN lines, from a persisted offset).

Each new failure becomes at most one issue on --repo:

  - diagnostics records are auto-filed, at most --max-auto per run;
  - log lines and the per-day slow-render aggregate are staged in
    <state>/staged/<slug>.md, and a notification says so. File one with
    `gh issue create --repo ... --title ... --body-file <that file> --label automated`.

Dedup: the state file remembers each signature. Before filing, open issues are
searched for the signature (written into every body) and for the normalized
message (in the title). Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = "lavigneer/sheltie"
LABEL = "automated"
DIAG_DIR = "sheltie-diagnostics"
SIG_LINE = "sheltie-watcher signature:"
SLOW_MS = 400  # a render slower than this counts toward the day's aggregate
SLOW_DAY_COUNT = 5  # this many in one day makes one aggregate issue
MAX_AUTO = 2  # diagnostics issues filed per run; the rest are staged
SAMPLE_CAP = 50

# Secret-shaped text, scrubbed like src/diagnostics.js and diagnostics.sh do.
SECRETS = [
    (
        re.compile(
            r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]+"
            r"|AKIA[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)"
        ),
        "<redacted>",
    ),
    (re.compile(r"(\b(?:bearer|basic|token)\s+)[\w.~+/=-]{8,}", re.I), r"\1<redacted>"),
    (re.compile(r"(://[^/\s:@]+:)[^@\s/]+(?=@)"), r"\1<redacted>"),
]

# Volatile parts replaced, so one bug on four tickets is one signature.
VOLATILE = [
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?"), "TIME"),
    (
        re.compile(
            r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
        ),
        "ID",
    ),
    (re.compile(r"\b[0-9a-fA-F]{12,}\b"), "ID"),
    (re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b"), "TICKET"),
    (re.compile(r"\b\d+(?:\.\d+)?\s?ms\b"), "N ms"),
    (re.compile(r"\b\d+(?:\.\d+)?\b"), "N"),
]

LOG_LEVEL = re.compile(r"\b(ERROR|WARN)\b")
# Noise: the update check failing offline, and a disk filling up (not sheltie).
LOG_DROP = [re.compile(r"update\.check"), re.compile(r"No space left on device")]
# herdr-core's auto-title, not sheltie: tagged so it reads as such.
HERDR_CORE = re.compile(r"pane\.process_info|auto-?title")


def scrub(text: str) -> str:
    for pattern, replacement in SECRETS:
        text = pattern.sub(replacement, text)
    return text


def normalize(text: str) -> str:
    text = scrub(text)
    for pattern, replacement in VOLATILE:
        text = pattern.sub(replacement, text)
    return " ".join(text.split())


def signature(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:16]


def diagnostic_item(rec: dict) -> dict:
    mod = str(rec.get("mod", "unknown"))
    norm = normalize(f"{rec.get('what', 'unknown')}: {rec.get('message', '')}")
    return {
        "kind": "diagnostic",
        "mod": mod,
        "norm": norm,
        "sig": signature("diagnostic", mod, norm),
        "raw": scrub(json.dumps(rec, indent=2)),
    }


def log_item(line: str) -> dict | None:
    level = LOG_LEVEL.search(line)
    if not level or any(p.search(line) for p in LOG_DROP):
        return None
    mod = "herdr-core" if HERDR_CORE.search(line) else "herdr"
    norm = normalize(line)
    return {
        "kind": "log",
        "mod": mod,
        "norm": norm,
        "sig": signature("log", mod, norm),
        "raw": scrub(line),
    }


def title_for(item: dict) -> str:
    if "title" in item:
        return item["title"]
    text = item["norm"]
    return f"[watcher] {item['mod']}: {text[:87] + '...' if len(text) > 90 else text}"


def version_of(cmd: str | None, *argv: str) -> str:
    if not cmd or not shutil.which(cmd):
        return "not found"
    try:
        proc = subprocess.run(
            [cmd, *(argv or ("--version",))],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return "error"
    out = (proc.stdout or proc.stderr).strip().splitlines()
    return out[0] if out else "unknown"


class GhError(RuntimeError):
    pass


class Watcher:
    def __init__(self, args: argparse.Namespace, state_dir: Path):
        self.args = args
        self.repo = args.repo
        self.dry = args.dry_run
        self.app_home = Path(args.app_home).expanduser()
        self.log_path = Path(args.herdr_log).expanduser()
        self.state_dir = state_dir
        self.staged_dir = state_dir / "staged"
        self.state_file = state_dir / "state.json"
        self.state = self._load()
        self.budget = args.max_auto
        self.label_ready = False
        self.report_lines: list[str] = []
        self.new_staged = 0
        self._env: dict[str, str] | None = None

    # State

    def _load(self) -> dict:
        try:
            state = json.loads(self.state_file.read_text())
        except (OSError, ValueError):
            state = {}
        for key, default in (("seen", {}), ("staged", {}), ("slow", {})):
            state.setdefault(key, default)
        return state

    def _save(self) -> None:
        if self.dry:
            return
        self.state_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2) + "\n")
        tmp.replace(self.state_file)

    def _say(self, line: str) -> None:
        self.report_lines.append(line)
        print(line)

    # GitHub

    def gh(self, argv: list[str], input_text: str | None = None) -> str:
        proc = subprocess.run(
            [self.args.gh, *argv],
            input=input_text,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0:
            detail = proc.stderr.strip() or f"exit {proc.returncode}"
            raise GhError(f"gh {' '.join(argv[:2])} failed: {detail}")
        return proc.stdout

    def _open_issue_matching(self, query: str) -> str | None:
        out = self.gh(
            [
                "issue",
                "list",
                "-R",
                self.repo,
                "--state",
                "open",
                "--search",
                query,
                "--json",
                "number,url,title",
                "--limit",
                "5",
            ]
        )
        hits = json.loads(out or "[]")
        return hits[0]["url"] if hits else None

    def existing_issue(self, item: dict) -> str | None:
        hit = self._open_issue_matching(f"{item['sig']} in:body")
        if hit:
            return hit
        words = item["norm"].replace('"', "").split()[:6]
        phrase = item.get("phrase", words)
        if phrase and len(phrase) >= 4:
            return self._open_issue_matching(f'"{" ".join(phrase)}" in:title')
        return None

    def ensure_label(self) -> None:
        if self.label_ready or self.dry:
            return
        try:
            self.gh(
                [
                    "label",
                    "create",
                    LABEL,
                    "-R",
                    self.repo,
                    "--description",
                    "Filed by sheltie-watcher",
                    "--color",
                    "0E8A16",
                ]
            )
        except GhError as e:
            if "already exists" not in str(e):
                raise
        self.label_ready = True

    def environment(self) -> dict[str, str]:
        if self._env is None:
            self._env = {
                "macOS": platform.mac_ver()[0] or platform.platform(),
                "sheltie": self.args.sheltie_rev or "unknown",
                "herdr-app": version_of(self.args.herdr_app),
                "hc": version_of(self.args.hc),
                "jira-cli": version_of(self.args.jira, "version"),
                "gh": version_of(self.args.gh),
            }
        return self._env

    def body_for(self, item: dict, detail: str | None = None) -> str:
        env = "\n".join(f"{k}: {v}" for k, v in self.environment().items())
        parts = [
            "Filed by sheltie-watcher (lavigneer/sheltie#336).",
            "",
            f"{SIG_LINE} `{item['sig']}`",
            "",
        ]
        if detail:
            parts += [detail, ""]
        if item.get("raw"):
            parts += ["## Record", "", "```", item["raw"], "```", ""]
        parts += ["## Environment", "", "```", env, "```", ""]
        return "\n".join(parts)

    # Filing

    def remember(self, bucket: str, sig: str, value: dict) -> None:
        self.state[bucket][sig] = value
        self._save()

    def handle(self, item: dict, *, auto: bool, detail: str | None = None) -> str:
        sig = item["sig"]
        if sig in self.state["seen"] or sig in self.state["staged"]:
            return "known"
        existing = self.existing_issue(item)
        if existing:
            # Not remembered: if that issue closes and the failure recurs, it's new again.
            self._say(f"covered: {title_for(item)} -> {existing}")
            return "covered"
        body = self.body_for(item, detail)
        if auto and self.budget > 0:
            self.budget -= 1
            self.ensure_label()
            if self.dry:
                self._say(f"would file: {title_for(item)}")
                return "filed"
            url = self.gh(
                [
                    "issue",
                    "create",
                    "-R",
                    self.repo,
                    "--title",
                    title_for(item),
                    "--label",
                    LABEL,
                    "--body-file",
                    "-",
                ],
                input_text=body,
            ).strip()
            self.remember("seen", sig, {"url": url})
            self._say(f"filed: {title_for(item)} -> {url}")
            return "filed"
        self.stage(item, body)
        return "staged"

    def stage(self, item: dict, body: str) -> None:
        slug = re.sub(r"[^a-z0-9]+", "-", item["mod"].lower()).strip("-")[:30]
        path = self.staged_dir / f"{slug}-{item['sig']}.md"
        title = title_for(item)
        if self.dry:
            self._say(f"would stage: {title}")
            return
        self.staged_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        self.state["staged"][item["sig"]] = {"path": str(path), "title": title}
        self._save()
        self.new_staged += 1
        self._say(f"staged: {title} -> {path}")

    # Sources

    def process_diagnostics(self) -> None:
        folder = self.app_home / DIAG_DIR
        names = sorted(p.name for p in folder.glob("*.json")) if folder.is_dir() else []
        if self.state.get("diag_after") is None and not self.args.backfill:
            # First run: start from what exists now, so old failures don't flood in.
            self.state["diag_after"] = names[-1] if names else ""
            self._save()
            return
        after = self.state.get("diag_after") or ""
        for name in names:
            if name <= after:
                continue
            try:
                rec = json.loads((folder / name).read_text())
            except (OSError, ValueError):
                rec = None
            if not isinstance(rec, dict):
                # Pruned or half-written: say so, and move on.
                self._say(f"skipped unreadable record: {name}")
            elif rec.get("what") == "slow render":
                self.count_slow_render(rec)
            else:
                self.handle(diagnostic_item(rec), auto=True)
            self.state["diag_after"] = name
            self._save()
        self.stage_slow_days()

    def count_slow_render(self, rec: dict) -> None:
        # Only counts: no gh call here, so a retried record is never counted twice.
        ms = (rec.get("context") or {}).get("ms")
        if not isinstance(ms, (int, float)) or ms < SLOW_MS:
            return
        day = str(rec.get("at", ""))[:10] or "unknown"
        slow = self.state["slow"].setdefault(day, {"count": 0, "ms": []})
        slow["count"] += 1
        slow["ms"] = (slow["ms"] + [ms])[-SAMPLE_CAP:]
        self._save()

    def stage_slow_days(self) -> None:
        # One aggregate per day, once the day reaches SLOW_DAY_COUNT. A failed
        # gh call raises before `staged` is set, so the next run retries this step.
        for day, slow in sorted(self.state["slow"].items()):
            if slow["count"] < SLOW_DAY_COUNT or slow.get("staged"):
                continue
            samples = ", ".join(str(int(m)) for m in slow["ms"])
            item = {
                "kind": "aggregate",
                "mod": "work",
                "sig": signature("aggregate", "work", day),
                "norm": "",
                "phrase": None,  # a day's title must not match another day's
                "title": f"[watcher] work: slow renders on {day} (over {SLOW_MS} ms)",
            }
            detail = (
                f"{slow['count']} renders over {SLOW_MS} ms on {day}. "
                f"Recent durations (ms): {samples}."
            )
            self.handle(item, auto=False, detail=detail)
            slow["staged"] = True
            self._save()

    def process_log(self) -> None:
        if not self.log_path.exists():
            return
        size = self.log_path.stat().st_size
        offset = self.state.get("log_offset")
        if offset is None:
            if not self.args.backfill:
                self.state["log_offset"] = size
                self._save()
                return
            offset = 0
        if size < offset:
            offset = 0  # rotated or truncated
        with self.log_path.open("rb") as f:
            f.seek(offset)
            data = f.read()
        end = data.rfind(b"\n")
        if end < 0:
            return  # no complete line yet
        this_run: set[str] = set()
        for line in data[: end + 1].decode("utf-8", "replace").splitlines():
            item = log_item(line)
            if item is None or item["sig"] in this_run:
                continue
            this_run.add(item["sig"])
            self.handle(item, auto=False)
        self.state["log_offset"] = offset + end + 1
        self._save()

    def run(self) -> None:
        self.process_diagnostics()
        self.process_log()
        if self.new_staged and not self.dry:
            self.notify(
                f"{self.new_staged} new staged in {self.staged_dir}: file with gh issue create"
            )

    def notify(self, text: str) -> None:
        if self.args.no_notify or sys.platform != "darwin":
            return
        msg = text.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.run(
            ["osascript", "-e", f'display notification "{msg}" with title "sheltie watcher"'],
            capture_output=True,
            timeout=10,
        )


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--repo", default=REPO, help="where issues go (owner/repo)")
    parser.add_argument(
        "--app-home",
        default=os.environ.get("HERDR_APP_HOME") or str(home / ".config" / "herdr-app"),
    )
    parser.add_argument(
        "--herdr-log", default=str(home / ".config" / "herdr" / "herdr-server.log")
    )
    parser.add_argument(
        "--state-dir", default=str(home / ".local" / "state" / "sheltie-watcher")
    )
    parser.add_argument("--gh", default=shutil.which("gh") or "gh")
    parser.add_argument("--herdr-app", default=shutil.which("herdr-app") or "herdr-app")
    parser.add_argument("--hc", default=shutil.which("hc") or "hc")
    parser.add_argument("--jira", default=shutil.which("jira") or "jira")
    parser.add_argument("--sheltie-rev", default=None, help="sheltie's revision, for the body")
    parser.add_argument("--max-auto", type=int, default=MAX_AUTO)
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="on the first run, process existing diagnostics and log, not just new ones",
    )
    parser.add_argument("--dry-run", action="store_true", help="print, change nothing")
    parser.add_argument("--no-notify", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    watcher = Watcher(args, Path(args.state_dir).expanduser())
    try:
        watcher.run()
    except GhError as e:
        print(f"sheltie-watcher: {e}; state kept, retrying next run", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
