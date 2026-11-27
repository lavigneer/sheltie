"""scripts/sheltie-watcher.py: dedup, filtering, budget and state, against a fake gh."""

import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ in scripts/ or here

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("sheltie_watcher", ROOT / "scripts" / "sheltie-watcher.py")
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)

# A gh stand-in: records its argv, answers `issue list` from FAKE_GH_LIST,
# and fails when FAKE_GH_FAIL is set.
FAKE_GH = """#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
if [ -n "$FAKE_GH_FAIL" ]; then echo "boom" >&2; exit 1; fi
case "$1 $2" in
  "issue list") printf '%s' "${FAKE_GH_LIST:-[]}" ;;
  "issue create") cat > /dev/null; echo "https://github.com/lavigneer/sheltie/issues/$(wc -l < "$FAKE_GH_LOG")" ;;
  "label create") if [ -n "$FAKE_GH_LABEL_EXISTS" ]; then echo "label already exists" >&2; exit 1; fi ;;
esac
"""


class WatcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.app = base / "herdr-app"
        self.diag = self.app / "sheltie-diagnostics"
        self.diag.mkdir(parents=True)
        self.log = base / "herdr-server.log"
        self.log.write_text("")
        self.state = base / "state"
        self.gh = base / "gh"
        self.gh.write_text(FAKE_GH)
        self.gh.chmod(self.gh.stat().st_mode | stat.S_IEXEC)
        self.gh_log = base / "gh.log"
        self.gh_log.write_text("")
        for var in ("FAKE_GH_LOG",):
            os.environ[var] = str(self.gh_log)
        for var in ("FAKE_GH_LIST", "FAKE_GH_FAIL", "FAKE_GH_LABEL_EXISTS"):
            os.environ.pop(var, None)
        self.addCleanup(self._clear_env)
        self.n = 0

    def _clear_env(self):
        for var in ("FAKE_GH_LOG", "FAKE_GH_LIST", "FAKE_GH_FAIL", "FAKE_GH_LABEL_EXISTS"):
            os.environ.pop(var, None)

    def run_watcher(self, *extra):
        argv = [
            "--repo", "lavigneer/sheltie",
            "--app-home", str(self.app),
            "--herdr-log", str(self.log),
            "--state-dir", str(self.state),
            "--gh", str(self.gh),
            "--no-notify",
            *extra,
        ]
        out = io.StringIO()
        with redirect_stdout(out):
            rc = watcher.main(argv)
        return rc, out.getvalue()

    def add_record(self, what="Finish", message="Jira transition failed", mod="work", ms=None):
        self.n += 1
        name = f"2026-11-20T10-00-{self.n:02d}-000Z-{self.n}-{mod}.json"
        rec = {"at": f"2026-11-20T10:00:{self.n:02d}.000Z", "mod": mod, "what": what, "message": message, "stack": None, "context": {}}
        if ms is not None:
            rec["message"] = f"{ms} ms"
            rec["context"] = {"ms": ms, "rows": 3, "trigger": "tick"}
        (self.diag / name).write_text(json.dumps(rec))
        return name

    def creates(self):
        return [line for line in self.gh_log.read_text().splitlines() if line.startswith("issue create")]

    def staged_files(self):
        folder = self.state / "staged"
        return sorted(folder.glob("*.md")) if folder.exists() else []

    def test_first_run_baselines_existing_records(self):
        self.add_record("Finish", "old failure")
        rc, _ = self.run_watcher()
        self.assertEqual(rc, 0)
        self.assertEqual(self.creates(), [])
        state = json.loads((self.state / "state.json").read_text())
        self.assertTrue(state["diag_after"].endswith("-work.json"))

    def test_new_diagnostic_is_filed_once_with_label_and_signature(self):
        self.run_watcher()  # baseline
        self.add_record("Finish", "Jira transition failed for DEVPROD-25882")
        rc, out = self.run_watcher()
        self.assertEqual(rc, 0)
        creates = self.creates()
        self.assertEqual(len(creates), 1)
        self.assertIn("--label automated", creates[0])
        self.assertIn("filed:", out)
        self.run_watcher()  # nothing new
        self.assertEqual(len(self.creates()), 1)

    def test_same_bug_on_other_tickets_files_one_issue(self):
        self.run_watcher()
        self.add_record("Finish", "Jira transition failed for DEVPROD-25882")
        self.add_record("Finish", "Jira transition failed for WEB-11")
        self.run_watcher("--max-auto", "5")
        self.assertEqual(len(self.creates()), 1)

    def test_auto_file_budget_stages_the_rest(self):
        self.run_watcher()
        for msg in ("first thing broke", "second thing broke", "third thing broke"):
            self.add_record("Finish", msg)
        self.run_watcher()
        self.assertEqual(len(self.creates()), watcher.MAX_AUTO)
        self.assertEqual(len(self.staged_files()), 1)

    def test_open_issue_covering_it_suppresses_filing(self):
        self.run_watcher()
        self.add_record("Finish", "Jira transition failed")
        os.environ["FAKE_GH_LIST"] = json.dumps([{"number": 7, "url": "https://github.com/lavigneer/sheltie/issues/7", "title": "x"}])
        rc, out = self.run_watcher()
        self.assertEqual(rc, 0)
        self.assertEqual(self.creates(), [])
        self.assertIn("covered:", out)

    def test_slow_renders_aggregate_into_one_staged_issue(self):
        self.run_watcher()
        for _ in range(5):
            self.add_record("slow render", ms=500)
        self.add_record("slow render", ms=100)  # under the threshold: ignored
        self.run_watcher()
        self.assertEqual(self.creates(), [])
        self.assertEqual(len(self.staged_files()), 1)
        body = self.staged_files()[0].read_text()
        self.assertIn("5 renders over 400 ms on 2026-11-20", body)

    def test_unreadable_record_is_reported_and_skipped(self):
        self.run_watcher()
        (self.diag / "2026-11-20T10-00-09-000Z-9-work.json").write_text('{"mod": "work", "what": "Fin')
        rc, out = self.run_watcher()
        self.assertEqual(rc, 0)
        self.assertIn("skipped unreadable record", out)
        self.assertEqual(self.creates(), [])

    def test_covered_failure_is_staged_once_its_issue_is_gone(self):
        self.log.write_text("")
        self.run_watcher()  # baseline
        with self.log.open("a") as f:
            f.write("2026-11-20T10:00:00Z ERROR tickets load failed for DEVPROD-1\n")
        os.environ["FAKE_GH_LIST"] = json.dumps([{"number": 7, "url": "https://github.com/lavigneer/sheltie/issues/7", "title": "x"}])
        self.run_watcher()
        self.assertEqual(self.staged_files(), [])  # covered: not remembered
        os.environ.pop("FAKE_GH_LIST")
        with self.log.open("a") as f:
            f.write("2026-11-21T10:00:00Z ERROR tickets load failed for DEVPROD-2\n")
        self.run_watcher()
        self.assertEqual(len(self.staged_files()), 1)

    def test_gh_failure_while_staging_a_slow_day_retries_without_double_counting(self):
        self.run_watcher()
        for _ in range(4):
            self.add_record("slow render", ms=500)
        self.run_watcher()
        self.add_record("slow render", ms=500)  # the fifth: its aggregate's gh call fails
        os.environ["FAKE_GH_FAIL"] = "1"
        rc, _ = self.run_watcher()
        self.assertEqual(rc, 1)
        os.environ.pop("FAKE_GH_FAIL")
        self.run_watcher()
        self.assertEqual(len(self.staged_files()), 1)
        state = json.loads((self.state / "state.json").read_text())
        (day,) = state["slow"].keys()
        self.assertEqual(state["slow"][day]["count"], 5)

    def test_log_noise_is_dropped_and_core_lines_tagged(self):
        self.log.write_text("2026-11-20T10:00:00Z INFO started\n")
        self.run_watcher()  # baseline at end of file
        with self.log.open("a") as f:
            f.write("2026-11-20T10:01:00Z WARN update.check fetch failed\n")
            f.write("2026-11-20T10:01:01Z ERROR No space left on device\n")
            f.write("2026-11-20T10:01:02Z ERROR pane.process_info burst 12 ms\n")
            f.write("2026-11-20T10:01:03Z ERROR tickets load failed for DEVPROD-99\n")
        rc, out = self.run_watcher()
        self.assertEqual(rc, 0)
        self.assertEqual(self.creates(), [])
        self.assertEqual(len(self.staged_files()), 2)
        self.assertIn("[watcher] herdr-core:", out)
        self.assertNotIn("update.check", out)

    def test_gh_failure_keeps_the_watermark_for_retry(self):
        self.run_watcher()
        self.add_record("Finish", "something failed")
        os.environ["FAKE_GH_FAIL"] = "1"
        rc, _ = self.run_watcher()
        self.assertEqual(rc, 1)
        state = json.loads((self.state / "state.json").read_text())
        self.assertEqual(state["diag_after"], "")  # the empty baseline: the failed record isn't passed
        os.environ.pop("FAKE_GH_FAIL")
        self.run_watcher()
        self.assertEqual(len(self.creates()), 1)

    def test_label_already_existing_is_fine(self):
        self.run_watcher()
        self.add_record("Finish", "a fresh failure")
        os.environ["FAKE_GH_LABEL_EXISTS"] = "1"
        rc, _ = self.run_watcher()
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.creates()), 1)

    def test_dry_run_changes_nothing(self):
        self.run_watcher()
        self.add_record("Finish", "a dry failure")
        rc, out = self.run_watcher("--dry-run")
        self.assertEqual(rc, 0)
        self.assertIn("would file:", out)
        self.assertEqual(self.creates(), [])
        self.assertEqual(self.staged_files(), [])

    def test_normalize_makes_volatile_parts_one_signature(self):
        a = watcher.normalize("2026-11-20T10:00:00Z Finish DEVPROD-25882 took 120 ms id 3f9a2c1b8d7e6f50")
        b = watcher.normalize("2026-11-21T11:30:09.5Z Finish WEB-11 took 540 ms id 9a8b7c6d5e4f3a21")
        self.assertEqual(a, b)
        self.assertNotIn("ghp_", watcher.scrub("token ghp_abcdefghijklmnopqrstuvwxyz123456"))
        self.assertIn("<redacted>", watcher.scrub("https://user:hunter2hunter2@host/x"))


if __name__ == "__main__":
    unittest.main()
