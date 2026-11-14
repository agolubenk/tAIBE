"""SE-106: дайджест роли не выдаёт pr.changes, если голова PR сменилась или линза сняла changes."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import digest  # noqa: E402
import sources  # noqa: E402
from journal import DIGEST, Journal, read_from  # noqa: E402
from test_nerve import FakeCtx, FakeGh, _pr, wj  # noqa: E402

A, B = "a" * 40, "b" * 40


def changes(n=7, sha=A, lens="backend", text=None):
    return {"kind": "pr.changes", "text": text or f"#{n}: changes от «{lens}» на {sha[:9]}", "pr": n, "sha": sha,
            "lens": lens}


def state(d, prs):
    wj(os.path.join(d, "state.json"), {"github": {"etag": "", "prs": prs}})


class FreshTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def out(self, *recs, cur=None):
        cur = cur or {"pending": []}
        for r in recs:
            digest.pend(cur, r)
        return digest.fresh(cur, self.d)

    def test_changes_on_moved_head_is_dropped(self):
        # Линза снова дала changes уже на B: о B придёт своё событие, старое про A — лишнее.
        state(self.d, {"7": {"head": B, "changes_by": ["backend"]}})
        self.assertEqual(self.out(changes(sha=A)), [])

    def test_changes_on_current_head_is_delivered(self):
        state(self.d, {"7": {"head": A, "changes_by": ["backend"]}})
        rec = changes(sha=A[:9])          # вердикт пишет короткий sha
        self.assertEqual(self.out(rec), [rec["text"]])

    def test_pr_missing_from_state_is_kept(self):
        # Демон видит не все открытые PR (страница списка); закрытие приходит своим событием pr.closed.
        state(self.d, {"8": {"head": A, "changes_by": ["backend"]}})
        rec = changes(n=7)
        self.assertEqual(self.out(rec), [rec["text"]])

    def test_no_check_records_skip_state_read(self):
        cur = {"pending": ["#9 открыт: x"]}
        with mock.patch.object(digest, "load_json") as load:
            self.assertEqual(digest.fresh(cur, self.d), ["#9 открыт: x"])
        load.assert_not_called()

    def test_lens_that_approved_after_changes_is_dropped(self):
        state(self.d, {"7": {"head": A, "changes_by": ["release"]}})
        self.assertEqual(self.out(changes(lens="backend")), [])

    def test_fail_open_without_github_state(self):
        rec = changes()
        self.assertEqual(self.out(rec), [rec["text"]], "нет state.json")
        wj(os.path.join(self.d, "state.json"), {"heartbeat": "x"})
        self.assertEqual(self.out(rec), [rec["text"]], "нет github.prs")
        with open(os.path.join(self.d, "state.json"), "w") as f:
            f.write("{")
        self.assertEqual(self.out(rec), [rec["text"]], "битый state.json")

    def test_old_cursor_and_other_kinds_flush_as_is(self):
        state(self.d, {})
        cur = {"pending": ["строка из старого tap"]}
        out = self.out({"kind": "pr.new", "text": "#9 открыт: x", "pr": 9},
                       {"kind": "pr.changes", "text": "#7: changes без полей"}, cur=cur)
        self.assertEqual(out, ["строка из старого tap", "#9 открыт: x", "#7: changes без полей"])

    def test_same_text_drops_only_stale_copies(self):
        state(self.d, {"7": {"head": B, "changes_by": ["backend"]}})
        cur = {"pending": [changes(sha=A)["text"]]}   # копия без записи сверки: старый tap
        self.assertEqual(self.out(changes(sha=A), cur=cur), [changes(sha=A)["text"]])

    def test_pending_stays_strings_for_old_tap(self):
        cur = {"pending": []}
        digest.pend(cur, changes())
        self.assertTrue(all(isinstance(t, str) for t in cur["pending"]), "старый tap делает join по pending")


class TapFlushTest(unittest.TestCase):
    """ACCEPTANCE SE-106 через настоящий tap: changes на голове A в очереди, голова ушла на B — при выдаче выпадает;
    changes на текущей голове — выдаётся."""

    def run_tap(self, d):
        env = dict(os.environ, NERVE_STATE_DIR=d)
        return subprocess.run([sys.executable, "-I", os.path.join(HERE, "nerve.py"), "tap", "backend", "--once"],
                              capture_output=True, text=True, env=env, timeout=30).stdout

    def queue(self, d, recs, prs):
        jp = os.path.join(d, "journal.jsonl")
        open(jp, "w").close()
        hb = datetime.now(timezone.utc).isoformat(timespec="seconds")
        wj(os.path.join(d, "state.json"), {"heartbeat": hb, "github": {"etag": "", "prs": prs}})
        wj(os.path.join(d, "mode.json"), {"phase": "day", "pause": False})
        self.assertEqual(self.run_tap(d), "")  # курсор с конца журнала
        j = Journal(jp)
        for i, r in enumerate(recs):
            extra = {k: r[k] for k in ("pr", "sha", "lens") if k in r}
            j.emit(f"k{i}", r["kind"], DIGEST, ["backend"], r["text"], "github", **extra)
        cpath = os.path.join(d, "tap-backend.json")
        with open(cpath, encoding="utf-8") as f:
            cur = json.load(f)
        cur["last_flush"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
        wj(cpath, cur)
        return self.run_tap(d)

    def test_stale_changes_dropped_fresh_delivered(self):
        with tempfile.TemporaryDirectory() as d:
            stale, fresh = changes(n=7, sha=A), changes(n=8, sha=B)
            out = self.queue(d, [stale, fresh, {"kind": "pr.new", "text": "#9 открыт: x"}],
                             {"7": {"head": B, "changes_by": []}, "8": {"head": B, "changes_by": ["backend"]}})
            self.assertIn("дайджест (2)", out)
            self.assertIn(fresh["text"], out)
            self.assertNotIn(stale["text"], out)

    def test_digest_of_only_stale_changes_prints_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            out = self.queue(d, [changes(n=7, sha=A)], {"7": {"head": B, "changes_by": []}})
            self.assertEqual(out, "")
            with open(os.path.join(d, "tap-backend.json"), encoding="utf-8") as f:
                self.assertEqual(json.load(f)["pending"], [], "выпавшее событие не копится")


class SourceFieldsTest(unittest.TestCase):
    def test_pr_changes_carries_pr_sha_and_lens(self):
        d = tempfile.mkdtemp()
        ctx = FakeCtx(d)
        run = sources.run
        self.addCleanup(setattr, sources, "run", run)
        sources.run = FakeGh([_pr(479, A)], comments={479: ["**Линза корректности (роль 4) — CHANGES на aaaaaaa**"]})
        sources.poll_github(ctx)
        rec = [r for r in read_from(os.path.join(d, "j.jsonl"), 0)[0] if r["kind"] == "pr.changes"]
        self.assertEqual([(r["pr"], r["sha"], r["lens"]) for r in rec], [(479, "aaaaaaa", "backend")])


if __name__ == "__main__":
    unittest.main()
