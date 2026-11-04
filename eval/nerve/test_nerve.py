# -*- coding: utf-8 -*-
"""Тесты Нерва на синтетике: python3 -I -m unittest discover -s supertick-eval/nerve -p 'test_*.py'"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import actions  # noqa: E402
import budget  # noqa: E402
import quorum  # noqa: E402
import sources  # noqa: E402
from journal import DIGEST, NERVOUS, Journal, read_from  # noqa: E402

MSK = timezone(timedelta(hours=3))
with open(os.path.join(HERE, "config.json"), encoding="utf-8") as _f:
    CFG = json.load(_f)


def wj(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


class QuorumTest(unittest.TestCase):
    def test_parses_t3_verdict_styles(self):
        self.assertEqual(quorum.parse_verdict("**Бэкенд: approve на 46b9f87e1.** План реализуем"),
                         {"lens": "бэкенд", "verdict": "approve", "sha": "46b9f87e1"})
        v = quorum.parse_verdict("**Линза DevOps (память, деплой, health), голова b55b246ec — approve.**")
        self.assertEqual((v["lens"], v["verdict"], v["sha"]), ("devops", "approve", "b55b246ec"))
        v = quorum.parse_verdict("\n\nQA: changes на 901feb3e5 — тест падает")
        self.assertEqual((v["lens"], v["verdict"]), ("qa", "changes"))
        self.assertIsNone(quorum.parse_verdict("Спасибо, посмотрю позже"))

    def test_quorum_needs_three_lenses_on_head_and_no_changes(self):
        head = "46b9f87e1aaaabbbbcccc"
        vs = [quorum.parse_verdict(f"{l}: approve на 46b9f87e1") for l in ("QA", "Бэкенд", "Контроль")]
        self.assertTrue(quorum.quorum(vs, head, ["SUCCESS"])[0])
        self.assertFalse(quorum.quorum(vs[:2], head, [])[0])
        old = [quorum.parse_verdict(f"{l}: approve на 1111111") for l in ("QA", "Бэкенд", "Контроль")]
        self.assertFalse(quorum.quorum(old, head, [])[0], "вердикт на старую голову не считается")
        ch = vs + [quorum.parse_verdict("Безопасность: changes на 46b9f87e1 — секрет в логе")]
        ok, _, changes, _ = quorum.quorum(ch, head, [])
        self.assertFalse(ok)
        self.assertEqual(changes, ["безопасность"])
        self.assertFalse(quorum.quorum(vs, head, ["IN_PROGRESS"])[0], "CI ещё идёт")

    def test_later_verdict_of_a_lens_overrides(self):
        head = "abcdef1234"
        vs = [quorum.parse_verdict(x) for x in (
            "QA: changes на abcdef1", "QA: approve на abcdef1", "Бэкенд: approve на abcdef1",
            "Контроль: approve на abcdef1")]
        self.assertTrue(quorum.quorum(vs, head, [])[0])

    def test_author_role_by_files(self):
        pr = CFG["github"]["path_roles"]
        self.assertEqual(quorum.author_role(["apps/frontend/src/a.tsx", "apps/frontend/b.ts", "docs/x.md"], pr),
                         "frontend")
        self.assertEqual(quorum.author_role(["README.md"], pr), "coord")
        self.assertEqual(quorum.role_of_lens("линза devops", CFG["github"]["lens_roles"]), "release")


class BudgetTest(unittest.TestCase):
    def test_parse_reset(self):
        seen = datetime(2026, 10, 24, 9, 16, tzinfo=MSK)
        self.assertEqual(budget.parse_reset("Oct 29 at 7pm (Europe/Minsk)", seen),
                         datetime(2026, 10, 29, 19, 0, tzinfo=MSK))
        seen = datetime(2026, 10, 28, 10, 52, tzinfo=MSK)
        self.assertEqual(budget.parse_reset("2:40pm (Europe/Minsk)", seen), datetime(2026, 10, 28, 14, 40, tzinfo=MSK))
        late = datetime(2026, 10, 27, 23, 50, tzinfo=MSK)
        self.assertEqual(budget.parse_reset("12am (Europe/Minsk)", late), datetime(2026, 10, 28, 0, 0, tzinfo=MSK))

    def test_week_start_and_circadian(self):
        now = datetime(2026, 10, 28, 16, 0, tzinfo=MSK)  # среда
        self.assertEqual(budget.week_start(now, 3, 19, 0), datetime(2026, 10, 22, 19, 0, tzinfo=MSK))
        thu = datetime(2026, 10, 29, 19, 30, tzinfo=MSK)
        self.assertEqual(budget.week_start(thu, 3, 19, 0), datetime(2026, 10, 29, 19, 0, tzinfo=MSK))
        c = CFG["circadian"]
        f = lambda h, m: budget.circadian(now.replace(hour=h, minute=m), c["day_from"], c["evening_from"],  # noqa: E731
                                          c["night_from"])
        self.assertEqual((f(8, 29), f(8, 30), f(20, 0), f(22, 0), f(3, 0)),
                         ("night", "day", "evening", "night", "night"))

    def test_resume_waits_for_day_when_reset_is_at_night(self):
        self.assertEqual(budget.resume_at(datetime(2026, 10, 28, 5, 0, tzinfo=MSK), CFG),
                         datetime(2026, 10, 28, 8, 30, tzinfo=MSK))
        self.assertEqual(budget.resume_at(datetime(2026, 10, 28, 14, 40, tzinfo=MSK), CFG),
                         datetime(2026, 10, 28, 14, 40, tzinfo=MSK))

    def test_mode(self):
        now = datetime(2026, 10, 28, 15, 0, tzinfo=MSK)
        m = budget.decide_mode(now, 0.7, now + timedelta(hours=1), CFG)
        self.assertEqual((m["phase"], m["pause"], m["batch"]), ("day", True, True))
        m = budget.decide_mode(now, 0.2, now - timedelta(minutes=1), CFG)
        self.assertEqual((m["pause"], m["batch"]), (False, False))

    def test_window_start_and_median(self):
        now = datetime(2026, 10, 28, 15, 0, tzinfo=MSK)
        self.assertEqual(budget.window_start(now, now - timedelta(hours=1), 5), now - timedelta(hours=1))
        self.assertEqual(budget.window_start(now, now - timedelta(hours=9), 5), now - timedelta(hours=5))
        self.assertEqual(budget.median([3, 1, 2]), 2)
        self.assertEqual(budget.median([1, 2, 3, 4]), 2.5)

    def test_meter_counts_one_response_once(self):
        with tempfile.TemporaryDirectory() as d:
            proj = os.path.join(d, "p")
            os.makedirs(proj)
            ts = datetime.now(timezone.utc).isoformat()
            u = {"input_tokens": 1_000_000, "output_tokens": 0}
            line = {"type": "assistant", "timestamp": ts, "requestId": "r1",
                    "message": {"model": "claude-opus-5-5", "usage": u, "content": []}}
            with open(os.path.join(proj, "s.jsonl"), "w") as f:
                f.write(json.dumps(line) + "\n" + json.dumps(line) + "\n")
            st = {}
            m = budget.Meter(st)
            m.update(d, datetime.now(timezone.utc))
            self.assertAlmostEqual(m.total(datetime.now(timezone.utc) - timedelta(hours=1)), 4.0)
            m.update(d, datetime.now(timezone.utc))
            self.assertAlmostEqual(m.total(datetime.now(timezone.utc) - timedelta(hours=1)), 4.0, msg="без дублей")
            err = {"type": "assistant", "timestamp": ts, "isApiErrorMessage": True, "message": {
                "model": "<synthetic>", "usage": {"input_tokens": 0, "output_tokens": 0},
                "content": [{"type": "text", "text": "You've hit your session limit · resets 7:50pm (Europe/Minsk)"}]}}
            with open(os.path.join(proj, "s.jsonl"), "a") as f:
                f.write(json.dumps(err) + "\n")
            lims = m.update(d, datetime.now(timezone.utc))
            self.assertEqual(len(lims), 1, "отказ найден счётчиком, без хвостового окна")
            self.assertIn("7:50pm", lims[0][1])
            self.assertEqual(m.update(d, datetime.now(timezone.utc)), [], "повторно не отдаётся")


class JournalTest(unittest.TestCase):
    def test_idempotent_and_partial_line(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "j.jsonl")
            j = Journal(p)
            self.assertTrue(j.emit("k1", "x", NERVOUS, ["coord"], "a"))
            self.assertFalse(j.emit("k1", "x", NERVOUS, ["coord"], "a"))
            self.assertFalse(Journal(p).emit("k1", "x", NERVOUS, ["coord"], "a"), "ключ переживает рестарт")
            with open(p, "a") as f:
                f.write('{"seq": 9, "key": "half')
            recs, off = read_from(p, 0)
            self.assertEqual([r["key"] for r in recs], ["k1"])
            self.assertLess(off, os.path.getsize(p))

    def test_route_source(self):
        rules = CFG["queue"]["source_roles"]
        self.assertEqual(sources.route_source("hr-helper-v2-e1 («Контроль»), проба", rules), "release")
        self.assertEqual(sources.route_source("supertick-eval (Claude, сессия)", rules), "boards")
        self.assertEqual(sources.route_source("t-boards: TB-119", rules), "boards")
        self.assertEqual(sources.route_source("hr-helper-v2-85 (QA)", rules), "coord")
        self.assertEqual(sources.route_source("plan-13-10", rules), "plan")


class FakeCtx:
    def __init__(self, d):
        self.cfg = CFG
        self.tz = MSK
        self.now = datetime(2026, 10, 28, 10, 53, tzinfo=MSK).astimezone(timezone.utc)
        self.projects_root = d
        self.journal = Journal(os.path.join(d, "j.jsonl"))
        self.deliver = False
        self.state = {}

    def emit(self, key, kind, cls, to, text, src=""):
        return self.journal.emit(key, kind, cls, to, text, src)


class FakeGh:
    """Подмена sources.run для gh: пишет argv, отвечает по репозиторию и номеру; broken — номера с отказом."""
    REPO = CFG["github"]["repo"]

    def __init__(self, open_prs, merged=(), broken=(), etag='W/"e1"'):
        self.open_prs, self.merged, self.broken, self.etag = open_prs, set(merged), set(broken), etag
        self.calls = []

    def __call__(self, cmd, stdin=None, timeout=30):
        self.calls.append(list(cmd))
        if cmd[:2] == ["gh", "api"] and cmd[-1].startswith(f"repos/{self.REPO}/pulls"):
            if "-H" in cmd and self.etag in cmd[cmd.index("-H") + 1]:
                return 1, "HTTP/2.0 304 Not Modified\r\n\r\n", ""
            return 0, f"HTTP/2.0 200 OK\r\nEtag: {self.etag}\r\n\r\n" + json.dumps(self.open_prs), ""
        if cmd[:2] == ["gh", "api"] and cmd[-1].startswith(f"repos/{self.REPO}/issues/"):
            return 0, "[]", ""
        if cmd[:3] == ["gh", "pr", "view"]:
            n = int(cmd[3])
            if "--repo" not in cmd or cmd[cmd.index("--repo") + 1] != self.REPO:
                return 1, "", f"GraphQL: Could not resolve to a PullRequest with the number of {n}."
            if n in self.broken:
                return 1, "", "HTTP 502"
            d = {"files": [{"path": "apps/backend/src/x.ts"}], "statusCheckRollup": [{"conclusion": "SUCCESS"}],
                 "state": "MERGED" if n in self.merged else "OPEN", "mergedAt": "2026-11-04T15:55:00Z"
                 if n in self.merged else None}
            return 0, json.dumps(d), ""
        raise AssertionError(f"неожиданный вызов: {cmd}")


def _pr(n, sha, upd="2026-11-04T10:00:00Z"):
    return {"number": n, "title": f"PR {n}", "updated_at": upd, "head": {"sha": sha}}


class GithubPollTest(unittest.TestCase):
    """SE-40: gh pr view без --repo искал номер HR PR в tAIBE (рабочая папка демона)."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = FakeCtx(self.d)
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)

    def kinds(self):
        return [(e["kind"], e["text"]) for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0]]

    def test_every_gh_call_names_the_repo(self):
        fake = FakeGh([_pr(458, "a" * 40)])
        sources.run = fake
        files, checks, state, _ = sources._gh_view(FakeGh.REPO, 458)
        self.assertEqual((files, checks, state), (["apps/backend/src/x.ts"], ["SUCCESS"], "OPEN"))
        sources.poll_github(self.ctx)
        self.assertTrue(fake.calls)
        for c in fake.calls:
            if c[:3] == ["gh", "pr", "view"]:
                self.assertEqual(c[c.index("--repo") + 1], FakeGh.REPO, c)
            else:
                self.assertTrue(c[-1].startswith(f"repos/{FakeGh.REPO}/"), c)
        p = self.ctx.state["github"]["prs"]["458"]
        self.assertEqual((p["checks"], p["head"]), (["SUCCESS"], "a" * 40))
        self.assertIn("author", p)

    def test_stuck_merged_pr_is_reported_once_after_upgrade(self):
        # Состояние rev 1: #457 влит, но остался в prs; etag живой — без сброса 304 спрятал бы его навсегда.
        self.ctx.state["github"] = {"etag": 'W/"e1"', "prs": {"457": {"head": "b" * 40, "updated": "x",
                                                                       "seen": [], "changes_by": []}}}
        sources.run = FakeGh([], merged={457})
        sources.poll_github(self.ctx)
        st = self.ctx.state["github"]
        self.assertNotIn("457", st["prs"])
        self.assertIn(("pr.closed", "#457 влит"), self.kinds())
        self.assertEqual((st["rev"], st["etag"]), (sources.GH_STATE_REV, 'W/"e1"'))
        sources.poll_github(self.ctx)  # второй проход — 304, повторного «влит» нет
        self.assertEqual(self.kinds().count(("pr.closed", "#457 влит")), 1)

    def test_one_failing_pr_does_not_stop_the_pass_and_is_retried(self):
        sources.run = FakeGh([_pr(1, "c" * 40), _pr(2, "d" * 40)], merged={9}, broken={1})
        self.ctx.state["github"] = {"etag": "", "rev": sources.GH_STATE_REV,
                                    "prs": {"9": {"head": "e" * 40, "updated": "x", "seen": [], "changes_by": []}}}
        with self.assertRaisesRegex(RuntimeError, r"PR с ошибкой: 1; #1: gh pr view"):
            sources.poll_github(self.ctx)
        st = self.ctx.state["github"]
        self.assertIn("author", st["prs"]["2"], "#2 разобран, хотя #1 упал раньше")
        self.assertNotIn("9", st["prs"], "цикл закрытых прошёл")
        self.assertEqual((st["prs"]["1"]["head"], st["prs"]["1"]["updated"]), ("", ""), "#1 не считается увиденным")
        self.assertEqual(st["etag"], "", "без etag следующий проход берёт полный список, а не 304")
        sources.run = FakeGh([_pr(1, "c" * 40), _pr(2, "d" * 40)])
        sources.poll_github(self.ctx)
        self.assertIn("author", st["prs"]["1"])
        self.assertEqual(st["etag"], 'W/"e1"')
        self.assertEqual(self.kinds().count(("pr.new", "#1 открыт: PR 1")), 1, "повтор не дублирует событие")

    def test_closed_pr_that_fails_stays_for_retry(self):
        sources.run = FakeGh([], broken={7})
        self.ctx.state["github"] = {"etag": "", "rev": sources.GH_STATE_REV,
                                    "prs": {"7": {"head": "f" * 40, "updated": "x", "seen": [], "changes_by": []}}}
        with self.assertRaises(RuntimeError):
            sources.poll_github(self.ctx)
        self.assertIn("7", self.ctx.state["github"]["prs"])
        self.assertNotIn("pr.closed", [k for k, _ in self.kinds()])


class LimitActionTest(unittest.TestCase):
    def test_limit_sets_pause_and_wave_once(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = FakeCtx(d)
            st = {"waves": [], "limit": None}
            m = budget.Meter({})
            text = "You've hit your session limit · resets 2:40pm (Europe/Minsk)"
            ts = datetime(2026, 10, 28, 10, 52, tzinfo=MSK)
            actions._on_limit(ctx, st, m, ts, text)
            actions._on_limit(ctx, st, m, ts + timedelta(seconds=30), text)
            self.assertEqual(len(st["waves"]), 1)
            self.assertEqual(st["limit"]["resume"], "2026-10-28T14:40+03:00")
            recs, _ = read_from(os.path.join(d, "j.jsonl"), 0)
            self.assertEqual([r["kind"] for r in recs], ["limit.hit"])


class TapTest(unittest.TestCase):
    def run_tap(self, d, role):
        env = dict(os.environ, NERVE_STATE_DIR=d)
        return subprocess.run([sys.executable, "-I", os.path.join(HERE, "nerve.py"), "tap", role, "--once"],
                              capture_output=True, text=True, env=env, timeout=30).stdout

    def test_tap_holds_nervous_in_pause_and_releases_after(self):
        with tempfile.TemporaryDirectory() as d:
            jp = os.path.join(d, "journal.jsonl")
            open(jp, "w").close()
            hb = {"heartbeat": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            wj(os.path.join(d, "state.json"), hb)
            wj(os.path.join(d, "mode.json"), {"phase": "day", "pause": True})
            self.assertEqual(self.run_tap(d, "backend"), "")  # курсор с конца журнала
            j = Journal(jp)
            j.emit("a", "owner.answer", NERVOUS, ["backend"], "ответ владельца d-1: да")
            j.emit("b", "limit.resume", NERVOUS, ["backend"], "лимит снят")
            j.emit("c", "pr.changes", DIGEST, ["backend"], "#1: changes")
            j.emit("d", "owner.answer", NERVOUS, ["frontend"], "чужое")
            out = self.run_tap(d, "backend")
            self.assertIn("limit.resume", out)
            self.assertNotIn("d-1", out)
            wj(os.path.join(d, "mode.json"), {"phase": "day", "pause": False})
            out = self.run_tap(d, "backend")
            self.assertIn("d-1", out)
            self.assertIn("придержано", out)
            self.assertNotIn("чужое", out)
            self.assertNotIn("#1: changes", out, "дайджест ждёт своего интервала")

    def test_tap_warns_when_heartbeat_is_stale(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            wj(os.path.join(d, "state.json"), {"heartbeat": "2026-10-01T00:00:00+00:00"})
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d, "coord"))
            self.assertEqual(self.run_tap(d, "coord"), "", "одна строка на эпизод")
            self.assertEqual(self.run_tap(d, "backend"), "", "пульс смотрят только coord и release")


if __name__ == "__main__":
    unittest.main()
