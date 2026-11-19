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
import gh_source  # noqa: E402
import sources  # noqa: E402
from journal import DIGEST, Journal, read_from  # noqa: E402
from test_nerve import FakeCtx, FakeGh, _pr, wj  # noqa: E402

A, B = "a" * 40, "b" * 40


def changes(n=7, sha=A, lens="backend", text=None):
    return {"kind": "pr.changes", "text": text or f"#{n}: changes от «{lens}» на {sha[:9]}", "pr": n, "sha": sha,
            "lens": lens}


def state(d, prs, closed=None):
    gh = {"etag": "", "prs": prs}
    if closed is not None:
        gh["closed"] = closed
    wj(os.path.join(d, "state.json"), {"github": gh})


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

    def test_changes_of_closed_pr_is_dropped(self):
        # SE-153: PR влит или закрыт после вердикта — снят с prs, номер в closed; pr.closed уже ушёл координатору.
        state(self.d, {}, closed={"7": "2026-11-16T11:00:00Z"})
        other = changes(n=8)
        self.assertEqual(self.out(changes(n=7), other), [other["text"]], "#8 нет ни в prs, ни в closed — fail open")

    def test_open_pr_wins_over_closed_record(self):
        # Переоткрыт: в prs снова есть — сверка по голове, запись closed не решает.
        state(self.d, {"7": {"head": A, "changes_by": ["backend"]}}, closed={"7": "2026-11-16T11:00:00Z"})
        rec = changes(n=7, sha=A)
        self.assertEqual(self.out(rec), [rec["text"]])

    def test_bad_closed_field_fails_open(self):
        rec = changes(n=7)
        for bad in (["7"], "7", None, 7):
            state(self.d, {}, closed=bad)
            self.assertEqual(self.out(rec), [rec["text"]], repr(bad))

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
        # продукт по умолчанию — курсор в самой папке d; TAIBE_PRODUCT сессии увёл бы его в products/<slug>/
        env = dict({k: v for k, v in os.environ.items() if k != "TAIBE_PRODUCT"}, NERVE_STATE_DIR=d)
        return subprocess.run([sys.executable, "-I", os.path.join(HERE, "nerve.py"), "tap", "backend", "--once"],
                              capture_output=True, text=True, env=env, timeout=30).stdout

    def queue(self, d, recs, prs, closed=None):
        jp = os.path.join(d, "journal.jsonl")
        open(jp, "w").close()
        hb = datetime.now(timezone.utc).isoformat(timespec="seconds")
        gh = dict({"etag": "", "prs": prs}, **({"closed": closed} if closed is not None else {}))
        wj(os.path.join(d, "state.json"), {"heartbeat": hb, "github": gh})
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


    def test_changes_of_pr_closed_after_verdict_is_not_delivered(self):
        """ACCEPTANCE SE-153 через настоящий tap: changes в очереди, PR закрыт до выдачи — строки нет."""
        with tempfile.TemporaryDirectory() as d:
            kept = changes(n=8, sha=B)
            out = self.queue(d, [changes(n=7, sha=A), kept], {"8": {"head": B, "changes_by": ["backend"]}},
                             closed={"7": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
            self.assertIn("дайджест (1)", out)
            self.assertIn(kept["text"], out)
            self.assertNotIn("#7:", out)


class LineTest(unittest.TestCase):
    def test_line_counts_cuts_and_is_empty_without_texts(self):
        self.assertEqual(digest.line([], 3), "")
        self.assertEqual(digest.line(["a", "b"], 3), "дайджест (2): a · b")
        self.assertEqual(digest.line(["a", "b", "c", "d"], 2), "дайджест (4): a · b · ещё 2")


class SourceFieldsTest(unittest.TestCase):
    def test_pr_changes_carries_pr_sha_and_lens(self):
        d = tempfile.mkdtemp()
        ctx = FakeCtx(d)
        run = sources.run
        self.addCleanup(setattr, sources, "run", run)
        sources.run = FakeGh([_pr(479, A)], comments={479: ["**Линза корректности (роль 4) — CHANGES на aaaaaaa**"]})
        gh_source.poll_github(ctx)
        rec = [r for r in read_from(os.path.join(d, "j.jsonl"), 0)[0] if r["kind"] == "pr.changes"]
        self.assertEqual([(r["pr"], r["sha"], r["lens"]) for r in rec], [(479, "aaaaaaa", "backend")])


class ClosedMemoryTest(unittest.TestCase):
    """SE-153: проход GitHub помнит снятые PR сутки — без новых вызовов gh."""

    def setUp(self):
        self.ctx = FakeCtx(tempfile.mkdtemp())
        run = sources.run
        self.addCleanup(setattr, sources, "run", run)

    def poll(self, fake, after=timedelta(0)):
        self.ctx.now += after
        sources.run = fake
        gh_source.poll_github(self.ctx)
        return [c[1:3] for c in fake.calls]

    def gone(self):
        return self.ctx.state["github"]["closed"]

    def test_closed_pr_is_remembered_a_day_and_reopen_clears_it(self):
        self.poll(FakeGh([_pr(7, A), _pr(8, B)]))
        calls = self.poll(FakeGh([_pr(8, B)], closed={7}))
        self.assertEqual(calls, [["pr", "list"], ["pr", "view"]], "только список и pr view снятого — как до SE-153")
        self.assertEqual(list(self.gone()), ["7"])
        self.poll(FakeGh([_pr(8, B)]), timedelta(hours=23))
        self.assertEqual(list(self.gone()), ["7"])
        self.poll(FakeGh([_pr(8, B)]), timedelta(hours=2))      # 25 ч — запись ушла
        self.assertEqual(self.gone(), {})

    def test_reopened_pr_leaves_closed_and_bad_time_is_pruned(self):
        self.poll(FakeGh([_pr(7, A)]))
        self.poll(FakeGh([], closed={7}))
        self.gone()["9"] = "не время"
        self.poll(FakeGh([_pr(7, A)]))
        self.assertEqual(self.gone(), {})


if __name__ == "__main__":
    unittest.main()
