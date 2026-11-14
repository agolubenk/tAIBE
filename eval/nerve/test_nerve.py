# -*- coding: utf-8 -*-
"""Тесты Нерва на синтетике: python3 -I -m unittest discover -s supertick-eval/nerve -p 'test_*.py'"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import actions  # noqa: E402
import budget  # noqa: E402
import nerve  # noqa: E402
import quorum  # noqa: E402
import sources  # noqa: E402
from journal import DIGEST, NERVOUS, Journal, read_from  # noqa: E402

MSK = timezone(timedelta(hours=3))
with open(os.path.join(HERE, "config.json"), encoding="utf-8") as _f:
    CFG = json.load(_f)
# Дельта /changes (OPS-50) ходит в консоль через sources.run — у неё свои тесты с фальшивой консолью
# (test_queue_delta.py). Здесь опрос очереди — прежним списком: тесты подменяют _oq_get и не идут в сеть.
CFG["queue"]["delta"] = False


def wj(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


LR, TEAM = CFG["github"]["lens_roles"], CFG["team"]["roles"]


def pv(body):
    return quorum.parse_verdict(body, LR, TEAM)


class QuorumTest(unittest.TestCase):
    def test_parses_t3_verdict_styles(self):
        self.assertEqual(pv("**Бэкенд: approve на 46b9f87e1.** План реализуем"),
                         {"lens": "backend", "verdict": "approve", "sha": "46b9f87e1"})
        v = pv("\n\nQA: changes на 901feb3e5 — тест падает")
        self.assertEqual((v["lens"], v["verdict"]), ("coord", "changes"))
        self.assertIsNone(pv("Спасибо, посмотрю позже"))

    def test_old_approve_sha_still_counts(self):
        """Прежний формат: «approve <sha>», «approve на <sha>», «approve @<sha>», «changes at <sha>»."""
        self.assertEqual(pv("**Бэкенд: approve 46b9f87e1**"),
                         {"lens": "backend", "verdict": "approve", "sha": "46b9f87e1"})
        self.assertEqual(pv("Контроль: approve @46B9F87E1")["sha"], "46b9f87e1")
        self.assertEqual(pv("Линза QA: changes at 901feb3e5")["verdict"], "changes")
        self.assertEqual(pv("Линза QA: APPROVED на 901feb3e5")["verdict"], "approve")

    def test_accept_on_sha_counts_as_approve(self):
        """TB-84 ч. 2: вердикты линз Т3 — «ACCEPT на <sha>» (HR #481, #478, #477)."""
        self.assertEqual(pv("**Линза «корректность и отказы» (роль 4) — ACCEPT на 1d66762204**"),
                         {"lens": "backend", "verdict": "approve", "sha": "1d66762204"})
        self.assertEqual(pv("## Линза «корректность и отказы»: **ACCEPT** на `2bc2b66ff`"),
                         {"lens": "корректность и отказы", "verdict": "approve", "sha": "2bc2b66ff"})
        cases = {
            "**Линза «продукт и простота» — ACCEPT на голове `479bcdaf9`.**": "479bcdaf9",
            "Линза «продукт и простота» (роль 2): **ACCEPT перенесён на `c6d61b7dd`**. Дельта сверена": "c6d61b7dd",
            "**«Correctness and failures» lens (role 4): ACCEPT holds on a481926a2** (05.11)": "a481926a2",
            "**HR #477 (#660), линза «продукт и простота» (роль 2, план): ACCEPT на 9e9b77ce9**": "9e9b77ce9",
            "**Контроль (роль 5: безопасность · отказы · поставка) — ACCEPT на голове `479bcdaf9`**": "479bcdaf9",
            "**Линза «дизайн» — ACCEPT с условиями на 1d66762204**: два нита": "1d66762204",
            "**Линза «дизайн» — **ACCEPT** с оговорками на 1d66762204": "1d66762204",
            "Линза корректности: approve with changes на 1d66762204": "1d66762204",
            "Линза корректности, ACCEPT на 1d66762204": "1d66762204",
            "Линза корректности — вердикт ACCEPT на 1d66762204": "1d66762204",
        }
        for body, sha in cases.items():
            v = pv(body)
            self.assertEqual((v["verdict"], v["sha"]), ("approve", sha), body)

    def test_reject_counts_as_changes(self):
        for body in ("**Линза «корректность и отказы» (роль 6) — REJECT на 54c85848b**",
                     "Линза QA: reject на 54c85848b", "**Линза роли 1 (QA): CHANGES на 54c85848b**",
                     "Линза QA — REJECTED на 54c85848b", "Линза QA — CHANGES REQUESTED на 54c85848b",
                     "Линза QA — CHANGES_REQUESTED @54c85848b", "Линза QA — REQUEST CHANGES на 54c85848b",
                     "Линза QA — REJECT (на 54c85848b)", "Линза QA — REJECT, голова 54c85848b",
                     "Линза QA — REJECT на [54c85848b](https://github.com/x/y/commit/54c85848b)",
                     "Линза QA — REJECT по голове 54c85848b", "Линза QA — REJECT на коммит 54c85848b"):
            v = pv(body)
            self.assertEqual((v["verdict"], v["sha"]), ("changes", "54c85848b"), body)

    def test_non_lens_author_does_not_count(self):
        """TB-84 ч. 1, повтор HR #478: строка автора PR со словом CHANGES и SHA головы — не вердикт."""
        self.assertIsNone(pv("Голова **2bc2b66ff** — правка по линзе ресурсов Контроля 8c (CHANGES на 3b34254e2): "
                             "таймауты шлюза 504 и 524 больше не повторяются"))
        for body in ("Голова 2bc2b66ff — линза Контроля: CHANGES на 3b34254e2",
                     "**Автор (роль 3, t3-frontend): ACCEPT на 2bc2b66ff**",
                     "Авторская правка по линзе корректности: changes на 2bc2b66ff",
                     "Ответ линзе «корректность и отказы»: changes на 2bc2b66ff учтены",
                     "Ответ линзе «корректность и отказы»: changes на 2bc2b66ff",
                     "Сводка линз: ACCEPT на 2bc2b66ff (3/3)", "Итог по линзам: ACCEPT на 2bc2b66ff",
                     "Итог Контроля: ACCEPT на 2bc2b66ff", "Проверено автором: approve на 2bc2b66ff",
                     "Спасибо: ACCEPT на 2bc2b66ff", "ACCEPT на 2bc2b66ff"):
            self.assertIsNone(pv(body), body)

    def test_hex_elsewhere_on_the_line_is_not_the_sha(self):
        """SHA — только токен за словом вердикта; SHA до слова или дальше по строке не берётся."""
        for body in ("**Линза «продукт и простота» (роль 1), голова 19fda2dc7: **ACCEPT**.",
                     "**Линза DevOps (память, деплой, health), голова b55b246ec — approve.**",
                     "Линза QA — ACCEPT, дельта 9e9b77ce9..1fd7daab0 сверена",
                     "Линза 4 (ревью 1fd7daab0) — ACCEPT"):
            self.assertIsNone(pv(body), body)
        self.assertIsNone(pv("Линза QA: ACCEPT на 9e9b77ce9abcxyz"), "SHA — целый токен")

    def test_retraction_and_negative_verdict_win(self):
        """Отзыв и changes в одной строке с ACCEPT не дают approve (HR #471: «мой ACCEPT выше отменяю»)."""
        v = pv("**Поправка к линзе корректности (роль 4) — CHANGES на 76183ab0d, мой ACCEPT выше отменяю**")
        self.assertEqual((v["lens"], v["verdict"], v["sha"]), ("backend", "changes", "76183ab0d"))
        v = pv("Линза «корректность и отказы» (роль 4): ACCEPT на 76183ab0d отменяю — CHANGES на 76183ab0d")
        self.assertEqual((v["verdict"], v["sha"]), ("changes", "76183ab0d"))
        v = pv("Поправка к линзе корректности (роль 4) — мой ACCEPT на 76183ab0d отменяю")
        self.assertEqual((v["verdict"], v["sha"]), ("withdrawn", "76183ab0d"))
        v = pv("Линза корректности (роль 4): CHANGES на 1111111 закрыты — ACCEPT на 76183ab0d")
        self.assertEqual((v["verdict"], v["sha"]), ("approve", "76183ab0d"))
        head = "76183ab0d" + "0" * 31
        vs = [pv(f"Линза «{l}» (роль {n}) — ACCEPT на 76183ab0d") for l, n in (("qa", 1), ("продукт", 2), ("к", 4))]
        self.assertTrue(quorum.quorum(vs, head, [])[0])
        vs.append(pv("Поправка к линзе корректности (роль 4) — мой ACCEPT на 76183ab0d отменяю"))
        self.assertFalse(quorum.quorum(vs, head, [])[0], "отозванный ACCEPT не считается")

    def test_quoted_line_is_skipped(self):
        """Ответ с цитатой: вердикт — первая строка вне «>»."""
        body = "> **Линза «продукт и простота» — ACCEPT на 76183ab0d**\n\n**Линза «корректность» — CHANGES на 76183ab0d**"
        self.assertEqual(pv(body)["verdict"], "changes")
        self.assertIsNone(pv("> Линза QA: ACCEPT на 76183ab0d\n\nСогласен"))

    def test_one_lens_under_two_labels_is_one_key(self):
        """Подпись линзы меняется (HR #477, #471): номер роли и lens_roles дают один ключ."""
        head = "76183ab0d" + "0" * 31
        vs = [pv(x) for x in ("Линза корректности (роль 4): ACCEPT на 76183ab0d",
                              "**Линза «корректность и отказы» (роль 4) — ACCEPT на 76183ab0d**",
                              "## Продуктовая линза (роль 2) — ACCEPT на 76183ab0d",
                              "**Линза «продукт и простота» — ACCEPT на 76183ab0d**")]
        ok, approved, _, _ = quorum.quorum(vs, head, [])
        self.assertEqual((ok, approved), (False, ["backend", "plan"]))

    def test_odd_unicode_does_not_raise(self):
        self.assertEqual(pv("Линза QA: changeſ на 76183ab0d")["verdict"], "changes")
        self.assertIsNone(pv("Линза QA: approve на " + " *_`" * 20000 + "76183ab0d"), "строка режется до 500 знаков")

    def test_quorum_needs_three_lenses_on_head_and_no_changes(self):
        head = "46b9f87e1aaaabbbbcccc"
        vs = [pv(f"{l}: approve на 46b9f87e1") for l in ("QA", "Бэкенд", "Контроль")]
        self.assertTrue(quorum.quorum(vs, head, ["SUCCESS"])[0])
        self.assertFalse(quorum.quorum(vs[:2], head, [])[0])
        old = [pv(f"{l}: approve на 1111111") for l in ("QA", "Бэкенд", "Контроль")]
        self.assertFalse(quorum.quorum(old, head, [])[0], "вердикт на старую голову не считается")
        ch = vs + [pv("Линза «корректность и отказы»: changes на 46b9f87e1 — секрет в логе")]
        ok, _, changes, _ = quorum.quorum(ch, head, [])
        self.assertFalse(ok)
        self.assertEqual(changes, ["корректность и отказы"])
        self.assertFalse(quorum.quorum(vs, head, ["IN_PROGRESS"])[0], "CI ещё идёт")

    def test_later_verdict_of_a_lens_overrides(self):
        head = "abcdef1234"
        vs = [pv(x) for x in (
            "QA: changes на abcdef1", "QA: approve на abcdef1", "Бэкенд: approve на abcdef1",
            "Контроль: approve на abcdef1")]
        self.assertTrue(quorum.quorum(vs, head, [])[0])

    def test_author_role_by_files(self):
        pr = CFG["github"]["path_roles"]
        self.assertEqual(quorum.author_role(["apps/frontend/src/a.tsx", "apps/frontend/b.ts", "docs/x.md"], pr),
                         "frontend")
        self.assertEqual(quorum.author_role(["README.md"], pr), "coord")
        self.assertEqual(quorum.role_of_lens("линза devops", CFG["github"]["lens_roles"]), "release")
        self.assertEqual(quorum.role_of_lens("backend", LR, TEAM), "backend", "ключ-роль — сама роль")


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

    peers = None
    emit_account = emit

    def for_item(self, _id, _product=None):
        return self


class FakeGh:
    """Подмена sources.run для gh: пишет argv, отвечает по репозиторию и номеру; broken — номера с отказом."""
    REPO = CFG["github"]["repo"]

    def __init__(self, open_prs, merged=(), broken=(), etag='W/"e1"', comments=None, closed=(), page2=()):
        self.open_prs, self.merged, self.broken, self.etag = open_prs, set(merged), set(broken), etag
        self.closed, self.page2 = set(closed), list(page2)
        self.comments = comments or {}
        self.calls = []

    def __call__(self, cmd, stdin=None, timeout=30):
        self.calls.append(list(cmd))
        if cmd[:2] == ["gh", "api"] and cmd[-1].startswith(f"repos/{self.REPO}/pulls"):
            if cmd[-1].endswith("&page=2"):
                return 0, json.dumps(self.page2), ""
            if "-H" in cmd and self.etag in cmd[cmd.index("-H") + 1]:
                return 1, "HTTP/2.0 304 Not Modified\r\n\r\n", ""
            return 0, f"HTTP/2.0 200 OK\r\nEtag: {self.etag}\r\n\r\n" + json.dumps(self.open_prs), ""
        if cmd[:2] == ["gh", "api"] and cmd[-1].startswith(f"repos/{self.REPO}/issues/"):
            n = int(cmd[-1].split("/")[4])
            return 0, json.dumps([{"id": i, "body": b} for i, b in enumerate(self.comments.get(n, []))]), ""
        if cmd[:3] == ["gh", "pr", "view"]:
            n = int(cmd[3])
            if "--repo" not in cmd or cmd[cmd.index("--repo") + 1] != self.REPO:
                return 1, "", f"GraphQL: Could not resolve to a PullRequest with the number of {n}."
            if n in self.broken:
                return 1, "", "HTTP 502"
            d = {"files": [{"path": "apps/backend/src/x.ts"}], "statusCheckRollup": [{"conclusion": "SUCCESS"}],
                 "state": "MERGED" if n in self.merged else "CLOSED" if n in self.closed else "OPEN",
                 "mergedAt": "2026-11-04T15:55:00Z"
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

    def test_lens_accepts_reach_quorum_and_author_line_is_not_changes(self):
        """TB-84, повтор HR #478: строка автора «Голова <sha> — … (CHANGES на <старая>)» раньше давала changes на голову."""
        head = "2bc2b66ff" + "0" * 31
        fake = FakeGh([_pr(478, head)], comments={478: [
            "Голова **2bc2b66ff** — правка по линзе ресурсов Контроля 8c (CHANGES на 3b34254e2): таймауты",
            "## Линза «продукт и простота»: **ACCEPT** на `2bc2b66ff`",
            "**Линза «корректность и отказы» (роль 4) — ACCEPT на 2bc2b66ff**",
            "**Контроль (роль 5: безопасность · отказы · поставка) — ACCEPT на голове `2bc2b66ff`**"]})
        sources.run = fake
        sources.poll_github(self.ctx)
        kinds = [k for k, _ in self.kinds()]
        self.assertNotIn("pr.changes", kinds)
        self.assertIn("pr.quorum", kinds)
        self.assertEqual(self.ctx.state["github"]["prs"]["478"]["changes_by"], [])

    def test_new_head_after_changes_goes_to_the_lens_role(self):
        sources.run = FakeGh([_pr(479, "a" * 40)], comments={479: ["**Линза корректности (роль 4) — CHANGES на aaaaaaa**"]})
        sources.poll_github(self.ctx)
        self.assertEqual(self.ctx.state["github"]["prs"]["479"]["changes_by"], ["backend"])
        sources.run = FakeGh([_pr(479, "b" * 40, "2026-11-04T11:00:00Z")], etag='W/"e2"')
        sources.poll_github(self.ctx)
        rec = [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["kind"] == "pr.newhead"]
        self.assertEqual([e["to"] for e in rec], [["backend"]])

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

    def test_merged_pr_removes_its_worktree_and_reports_kept_ones(self):
        """OPS-52: ветка PR запоминается из списка открытых; после «влит» — wt_gc.py branch по repo_root продукта."""
        pr = _pr(460, "c" * 40)
        pr["head"]["ref"], pr["base"] = "fix/done", {"ref": "main"}
        sources.run = FakeGh([pr])
        sources.poll_github(self.ctx)
        self.assertEqual(self.ctx.state["github"]["prs"]["460"]["branch"], "fix/done")
        gc_calls = []
        fake = FakeGh([], etag='W/"e2"', merged={460})

        def run(cmd, stdin=None, timeout=30):
            if cmd[2:4] == [sources.WT_GC, "branch"]:
                gc_calls.append(cmd)
                return 0, json.dumps([{"path": "/r/worktrees/fix/done", "branch": "fix/done", "removed": True},
                                      {"path": "/r/x", "branch": "fix/done", "removed": False, "reason": "незакоммиченные изменения: 2"}]), ""
            return fake(cmd, stdin, timeout)
        sources.run = run
        sources.poll_github(self.ctx)
        self.assertEqual([c[4:] for c in gc_calls], [[self.ctx.cfg["repo_root"], "fix/done", "--json", "--head", "c" * 40, "--base", "main"]])
        self.assertIn(("pr.closed", "#460 влит"), self.kinds())
        recs = [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["kind"] == "wt.gc"]
        self.assertEqual([(e["to"], e["text"]) for e in recs], [
            ([], "#460: worktree /r/worktrees/fix/done удалён"),
            (["coord"], "#460 влит, worktree /r/x оставлен — незакоммиченные изменения: 2")])

    def test_fork_pr_with_same_branch_name_is_not_ours(self):
        """Ревью #178: PR из форка с именем локальной ветки не должен убрать чужой worktree."""
        pr = _pr(463, "f" * 40)
        pr["head"]["ref"], pr["head"]["repo"] = "fix/done", {"full_name": "someone/fork"}
        sources.run = FakeGh([pr])
        sources.poll_github(self.ctx)
        self.assertNotIn("branch", self.ctx.state["github"]["prs"]["463"])

    def test_closed_unmerged_pr_and_gc_failure_do_not_break_the_pass(self):
        pr = _pr(461, "d" * 40)
        pr["head"]["ref"] = "fix/dropped"
        sources.run = FakeGh([pr])
        sources.poll_github(self.ctx)
        fake = FakeGh([], etag='W/"e2"', closed={461})  # закрыт без мёржа — уборки нет
        sources.run = fake
        sources.poll_github(self.ctx)
        self.assertFalse([c for c in fake.calls if sources.WT_GC in c])
        self.assertIn(("pr.closed", "#461 закрыт"), self.kinds())
        self.assertNotIn("461", self.ctx.state["github"]["prs"])
        pr = _pr(462, "e" * 40)
        pr["head"]["ref"] = "fix/boom"
        sources.run = FakeGh([pr], etag='W/"e3"')
        sources.poll_github(self.ctx)
        fake = FakeGh([], etag='W/"e4"', merged={462})
        sources.run = lambda cmd, stdin=None, timeout=30: (1, "", "timeout") if sources.WT_GC in cmd else fake(cmd, stdin, timeout)
        sources.poll_github(self.ctx)
        self.assertNotIn("462", self.ctx.state["github"]["prs"])
        self.assertIn(("pr.closed", "#462 влит"), self.kinds())
        rec = [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["key"] == "wt:gc:462"]
        self.assertEqual([(e["to"], e["text"]) for e in rec], [(["coord"], "#462: уборка worktree fix/boom не удалась: timeout — wt_gc.py sweep")])

    def test_stuck_open_pr_without_author_is_resolved_after_upgrade(self):
        # rev 1 записывал head и updated до падения _gh_view: PR выглядел увиденным, но author и checks пусты.
        sha, upd = "9" * 40, "2026-11-04T10:00:00Z"
        self.ctx.state["github"] = {"etag": 'W/"e1"', "prs": {"458": {"head": sha, "updated": upd,
                                                                       "seen": [], "changes_by": []}}}
        sources.run = FakeGh([_pr(458, sha, upd)])
        sources.poll_github(self.ctx)
        p = self.ctx.state["github"]["prs"]["458"]
        self.assertEqual(p.get("checks"), ["SUCCESS"])
        self.assertIn("author", p)

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

    def test_all_pages_are_read_and_an_open_pr_missing_from_the_list_is_not_closed(self):
        """14.11: 125 открытых PR при одной странице из 50 — старые выпадали, Нерв объявлял их закрытыми."""
        page1 = [_pr(n, f"{n:040d}") for n in range(300, 200, -1)]
        fake = FakeGh(page1, page2=[_pr(173, "1" * 40)])
        sources.run = fake
        sources.poll_github(self.ctx)
        lists = [c[-1] for c in fake.calls if c[:2] == ["gh", "api"] and "/pulls?" in c[-1]]
        self.assertEqual(len(lists), 2)
        self.assertIn("sort=updated", lists[0])
        self.assertIn("per_page=100", lists[0])
        self.assertIn("173", self.ctx.state["github"]["prs"])
        # #173 нет в списке (сдвиг при листании), но он открыт — не закрыт и остаётся под наблюдением.
        sources.run = FakeGh(page1, etag='W/"e2"')
        sources.poll_github(self.ctx)
        self.assertIn("173", self.ctx.state["github"]["prs"])
        self.assertNotIn("pr.closed", [k for k, _ in self.kinds()])

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

    def heartbeat_ago(self, d, minutes, phase):
        hb = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
        wj(os.path.join(d, "state.json"), {"heartbeat": hb})
        wj(os.path.join(d, "mode.json"), {"phase": phase})

    def test_tap_night_cycle_is_not_silence(self):
        # Ночью демон спит 60 с × 5 = 300 с — ровно прежний порог 5 мин: затянувшийся проход давал ложную тревогу.
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            self.heartbeat_ago(d, 7, "night")
            self.assertEqual(self.run_tap(d, "coord"), "", "ночью 7 мин — меньше двух циклов, пульс жив")
            self.heartbeat_ago(d, 7, "day")
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d, "release"), "днём порог прежний, 5 мин")

    def test_tap_night_warns_after_two_cycles(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            self.heartbeat_ago(d, 11, "night")
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d, "coord"))

    def test_stale_threshold_values(self):
        self.assertEqual(nerve.heartbeat_stale_after(CFG, {"phase": "day"}), timedelta(minutes=5))
        self.assertEqual(nerve.heartbeat_stale_after(CFG, {"phase": "evening"}), timedelta(minutes=5))
        self.assertEqual(nerve.heartbeat_stale_after(CFG, {"phase": "night"}), timedelta(minutes=10))
        self.assertEqual(nerve.cycle_seconds(CFG, {"phase": "night"}, 30), 150, "--interval демона учитывается")

    def test_stale_threshold_follows_the_pause_the_daemon_slept_on(self):
        night = {"phase": "night"}
        # Ручной «run --interval 120» ночью: пауза 600 с, порог от конфига (10 мин) снова дал бы ложную тревогу.
        self.assertEqual(nerve.heartbeat_stale_after(CFG, night, {"seconds": 600}), timedelta(minutes=20))
        self.assertEqual(nerve.heartbeat_stale_after(CFG, {"phase": "day"}, {"seconds": 30}), timedelta(minutes=5),
                         "короткий цикл не опускает порог ниже heartbeat_stale_min")
        for bad in (None, {}, {"seconds": 0}, {"seconds": -5}, {"seconds": "600"}, {"seconds": True}, [1], "x", 5,
                    {"seconds": float("inf")}, {"seconds": float("nan")}, {"seconds": 1e12}):
            self.assertEqual(nerve.heartbeat_stale_after(CFG, night, bad), timedelta(minutes=10),
                             f"нет или битый cycle.json → конфиг: {bad!r}")

    def test_run_writes_the_pause_before_sleeping(self):
        from argparse import Namespace
        from unittest import mock

        class Slept(Exception):
            pass

        with tempfile.TemporaryDirectory() as d:
            wj(os.path.join(d, "mode.json"), {"phase": "night"})
            open(os.path.join(d, "journal.jsonl"), "w").close()
            with mock.patch.object(nerve, "STATE_DIR", d), mock.patch.object(nerve, "one_pass"), \
                    mock.patch.object(nerve, "Ctx"), mock.patch.object(nerve, "wakes_on", return_value=False), \
                    mock.patch.object(nerve.time, "sleep", side_effect=Slept) as sleep:
                with self.assertRaises(Slept):
                    nerve.cmd_run(CFG, Namespace(interval=120))
            sleep.assert_called_once_with(600)
            with open(os.path.join(d, "cycle.json"), encoding="utf-8") as f:
                cycle = json.load(f)
            self.assertEqual(cycle["seconds"], 600, "ручной --interval 120 ночью = 600 с")
            self.assertLessEqual(abs(nerve.awake_seconds() - cycle["awake"]), 5, "перед сном — часы бодрствования")

    def test_tap_reads_cycle_file(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            self.heartbeat_ago(d, 15, "night")
            wj(os.path.join(d, "cycle.json"), {"seconds": 600, "at": "2026-11-04T20:00:00+00:00"})
            self.assertEqual(self.run_tap(d, "coord"), "", "ночью при паузе 600 с 15 мин — меньше двух циклов")
            self.heartbeat_ago(d, 21, "night")
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d, "release"))

    def test_sleeping_mac_is_not_silence_and_unknown_awake_falls_back_to_the_wall(self):
        # Ночь 05.11: пульс 02:48:29, тревоги в 03:40–04:17 (DarkWake); к 04:17 Mac бодрствовал 272 с из 88 мин.
        hb = datetime(2026, 11, 4, 23, 48, 29, tzinfo=timezone.utc)
        c = {"seconds": 300, "at": hb.isoformat(), "awake": 1000.0}
        silent = lambda cycle, wall_min, awake, phase="night", h=hb.isoformat(): nerve.heartbeat_silent(  # noqa: E731
            CFG, {"phase": phase}, cycle, h, hb + timedelta(minutes=wall_min), awake)
        self.assertFalse(silent(c, 88.5, 1272.0), "ночь 05.11: 272 с бодрствования < 600 с")
        self.assertTrue(silent(c, 88.5, 1601.0), "бодрствовал больше двух пауз — демон правда пропустил цикл")
        self.assertTrue(silent(dict(c, seconds=60), 6, 1360.0, "day"), "днём без сна — как раньше")
        self.assertFalse(silent(c, 9, 9e9), "свежий по стенным часам пульс жив при любом счёте")
        for h in (None, "x", "2026-11-04T23:48:29", 5):
            self.assertTrue(silent(c, 88.5, 1272.0, h=h), f"пульса нет или он битый — тишина: {h!r}")
        for why, cycle, awake in (("нет cycle.json", None, 1272.0), ("демон до правки", {"seconds": 300}, 1272.0),
                                  ("прошлый проход", dict(c, at="2026-11-04T23:43:29+00:00"), 1272.0),
                                  ("перезагрузка: счёт назад", c, 400.0), ("awake строкой", dict(c, awake="1"), 1272.0),
                                  ("awake логическое", dict(c, awake=True), 1272.0),
                                  ("битое at", dict(c, at="x"), 1272.0), ("cycle не объект", [1], 1272.0),
                                  ("at без пояса", dict(c, at="2026-11-05T02:48:30"), 1272.0)):
            self.assertTrue(silent(cycle, 88, awake), f"нет надёжного счёта → стенные часы: {why}")

    def test_tap_compares_the_daemons_awake_count_with_its_own(self):
        # tap — другой процесс: счёт бодрствования должен быть общим для системы, а не своим у процесса.
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            self.heartbeat_ago(d, 30, "night")
            hb = nerve.load_json(os.path.join(d, "state.json"), {})["heartbeat"]
            wj(os.path.join(d, "cycle.json"), {"seconds": 300, "at": hb, "awake": nerve.awake_seconds() - 100})
            self.assertEqual(self.run_tap(d, "coord"), "", "30 мин по стене, 100 с бодрствования — Mac спал")
            wj(os.path.join(d, "cycle.json"), {"seconds": 300, "at": hb, "awake": nerve.awake_seconds() - 700})
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d, "release"))
            [wj(os.path.join(d, n), v) for n, v in (("cycle.json", [1]), ("state.json", []), ("mode.json", "x"))]
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d, "coord"), "битые файлы состояния не валят tap")


class EmitTest(unittest.TestCase):
    def nerve(self, d, *args):
        env = dict(os.environ, NERVE_STATE_DIR=d)
        return subprocess.run([sys.executable, "-I", os.path.join(HERE, "nerve.py"), *args],
                              capture_output=True, text=True, env=env, timeout=30)

    def records(self, d):
        return read_from(os.path.join(d, "journal.jsonl"), 0)[0]

    def test_emit_resolves_role_numbers_and_lists(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            wj(os.path.join(d, "state.json"), {"heartbeat": datetime.now(timezone.utc).isoformat()})
            self.assertEqual(self.nerve(d, "tap", "6", "--once").stdout, "")  # курсор boards — с конца журнала
            self.assertEqual(self.nerve(d, "emit", "6", "роль 6: одна").returncode, 0)
            self.assertEqual(self.nerve(d, "emit", "backend, release,4", "двум").returncode, 0)
            self.assertEqual(self.nerve(d, "emit", "plan,frontend,backend,release,boards", "пятерым").returncode, 0)
            to = [sorted(r["to"]) for r in self.records(d)]
            self.assertEqual(to, [["boards"], ["backend", "release"], sorted(CFG["team"]["roles"][1:])])
            out = self.nerve(d, "tap", "boards", "--once").stdout
            self.assertIn("роль 6: одна", out, "tap 6 и tap boards — один курсор")
            self.assertIn("пятерым", out)
            self.assertNotIn("двум", out)

    def test_emit_refuses_unknown_role(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            for target in ("tboards", "7", "backend,review", ","):
                p = self.nerve(d, "emit", target, "никому")
                self.assertEqual(p.returncode, 2, target)
                self.assertIn("ничего не записано", p.stderr, target)
            self.assertEqual(self.records(d), [])

    def test_tap_takes_one_role_and_keeps_helper_taps(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            self.assertEqual(self.nerve(d, "tap", "backend,release", "--once").returncode, 2)
            self.assertEqual(self.nerve(d, "tap", "selftest", "--once").returncode, 0, "split/6-verify.sh")
            self.assertTrue(os.path.exists(os.path.join(d, "tap-selftest.json")))
            for n in ("0", "7", "99"):
                self.assertEqual(self.nerve(d, "tap", n, "--once").returncode, 2, f"emit не запишет «{n}»")
                self.assertFalse(os.path.exists(os.path.join(d, f"tap-{n}.json")), n)


class ProductsTest(unittest.TestCase):
    """OPS-25 Ф2a: один процесс, журнал и курсоры у каждого продукта, режим и пульс — общие."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.taibe = dict(CFG, active=True, github=dict(CFG["github"], repo="o/taibe"))
        self.cfgs = {"hr-helper": CFG, "taibe": self.taibe}
        self.keys = []
        self.patches = [mock.patch.object(nerve, "STATE_DIR", self.d),
                        mock.patch.object(nerve, "load_products", return_value=("hr-helper", self.cfgs)),
                        mock.patch.object(nerve, "PRODUCT_POLLS", [("github", self.fake_github)])]
        for p in self.patches:
            p.start()
        wj(os.path.join(self.d, "mode.json"), {"phase": "day"})
        with open(os.path.join(self.d, "heartbeat"), "w") as f:
            f.write(datetime.now(timezone.utc).isoformat(timespec="seconds"))

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def fake_github(self, ctx):
        for k in self.keys:
            ctx.emit(k, "pr.new", NERVOUS, ["boards"], f"{ctx.cfg['github']['repo']} {k}", "github")

    def tdir(self):
        return os.path.join(self.d, "products", "taibe")

    def tap(self, product, env_product=None):
        out, err = io.StringIO(), io.StringIO()
        env = {"TAIBE_PRODUCT": env_product} if env_product is not None else {"TAIBE_PRODUCT": ""}
        with mock.patch.dict(os.environ, env), redirect_stdout(out), redirect_stderr(err):
            nerve.cmd_tap(CFG, Namespace(role="boards", once=True, product=product))
        return out.getvalue(), err.getvalue()

    def test_seed_then_delivery_only_to_own_product(self):
        open(os.path.join(self.d, "journal.jsonl"), "w").close()
        self.tap("taibe")                       # курсоры с конца журнала
        self.tap("hr-helper")
        self.keys = ["k1"]
        nerve.other_product_passes(True)       # первый проход нового продукта — seed: журнал есть, никого не будит
        self.assertTrue(os.path.exists(os.path.join(self.tdir(), "journal.jsonl")))
        self.assertEqual(self.tap("taibe")[0], "")
        self.keys = ["k1", "k2"]
        nerve.other_product_passes(True)       # следующий проход доставляет
        out, _ = self.tap("taibe")
        self.assertIn("o/taibe k2", out)
        self.assertNotIn("k1", out)
        self.assertEqual(self.tap("hr-helper")[0], "", "событие tAIBE не приходит в tap HR")

    def test_seed_survives_emit_before_first_pass_and_failed_github(self):
        """Ни ранний emit, ни сбой gh в первом проходе не отменяют seed: открытые PR не уходят будилками."""
        with redirect_stdout(io.StringIO()):
            nerve.cmd_emit(CFG, Namespace(role="coord", text="рано", kind="assign", product="taibe"))
        self.tap("taibe")
        calls = []

        def flaky(ctx):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("gh недоступен")
            self.fake_github(ctx)

        self.keys = ["pr1", "pr2"]
        with mock.patch.object(nerve, "PRODUCT_POLLS", [("github", flaky)]):
            nerve.other_product_passes(True)   # сбой gh — seed остаётся
            nerve.other_product_passes(True)   # первый удачный проход — seed
        self.assertEqual(self.tap("taibe")[0], "")
        self.keys = ["pr1", "pr2", "pr3"]
        nerve.other_product_passes(True)
        out, _ = self.tap("taibe")
        self.assertIn("pr3", out)
        self.assertNotIn("pr1", out)

    def test_taibe_tap_sees_shared_pause(self):
        """tap другого продукта видит паузу общего mode.json: нервное событие придержано."""
        wj(os.path.join(self.d, "mode.json"), {"phase": "day", "pause": True})
        self.tap("taibe")
        nerve.other_product_passes(True)
        self.keys = ["k9"]
        nerve.other_product_passes(True)
        self.assertEqual(self.tap("taibe")[0], "", "в паузе нервное событие придержано")
        wj(os.path.join(self.d, "mode.json"), {"phase": "day"})
        self.assertIn("k9 (придержано на время лимита)", self.tap("taibe")[0])

    # ---------- Ф2b: события аккаунта, ответы владельца, транскрипты worktree ----------

    def peered(self, seeded=True):
        os.makedirs(self.tdir(), exist_ok=True)
        if seeded:
            wj(os.path.join(self.tdir(), "state.json"), {"seeded": "2026-11-07T10:00:00+00:00"})
        ctx = nerve.Ctx(CFG, self.d)
        nerve.attach_peers(ctx, True)
        return ctx

    def records(self, product=None):
        path = os.path.join(self.tdir() if product == "taibe" else self.d, "journal.jsonl")
        return read_from(path, 0)[0] if os.path.exists(path) else []

    def test_account_events_reach_every_product(self):
        """R-5: одно событие — в оба журнала с тем же ключом; у tAIBE budget.warn и limit.hit — только coord,
        limit.resume — живые роли tAIBE; роли HR — как раньше."""
        ctx = self.peered()
        with mock.patch.object(sources, "active_roles", return_value=["boards", "coord"]):
            ctx.emit_account("budget:warn:x", "budget.warn", NERVOUS, ["coord", "backend"], "окно 80 %", "budget")
            ctx.emit_account("limit:hit:y", "limit.hit", NERVOUS, ["coord"], "лимит", "budget")
            ctx.emit_account("limit:resume:y", "limit.resume", NERVOUS, ["coord", "frontend"], "лимит снят", "budget")
        hr = {r["kind"]: r["to"] for r in self.records()}
        tb = {r["kind"]: (r["to"], r["key"]) for r in self.records("taibe")}
        self.assertEqual(hr["budget.warn"], ["backend", "coord"])
        self.assertEqual(hr["limit.resume"], ["coord", "frontend"])
        self.assertEqual(tb["budget.warn"], (["coord"], "budget:warn:x"))
        self.assertEqual(tb["limit.hit"][0], ["coord"])
        self.assertEqual(tb["limit.resume"][0], ["boards", "coord"])

    def test_account_event_to_unseeded_product_wakes_nobody(self):
        ctx = self.peered(seeded=False)
        ctx.emit_account("budget:warn:z", "budget.warn", NERVOUS, ["coord"], "окно 80 %", "budget")
        self.assertEqual([r["to"] for r in self.records("taibe")], [[]], "до seed продукт никого не будит")

    def test_poll_budget_fans_out_through_emit_account(self):
        """Бюджет считает аккаунт один раз (проход по умолчанию) и раздаёт событие продуктам."""
        ctx = self.peered()
        st = {"waves": [], "limit": None}
        ts = datetime(2026, 10, 28, 10, 52, tzinfo=MSK)
        ctx.tz = MSK
        actions._on_limit(ctx, st, budget.Meter({}), ts, "You've hit your session limit · resets 2:40pm (Europe/Minsk)")
        self.assertEqual([r["kind"] for r in self.records("taibe")], ["limit.hit"])
        self.assertEqual([r["kind"] for r in self.records()], ["limit.hit"])

    def test_owner_answer_routed_by_item_id(self):
        """R-6: ответ на пункт с `-taibe-` — в журнал tAIBE по его правилам ролей; без метки — продукту по умолчанию;
        стоп владельца — во все журналы."""
        self.taibe["queue"] = dict(CFG["queue"], match="-taibe-", source_roles=[["boards-x", "boards"]])
        ctx = self.peered()
        self.assertIs(ctx.for_item("m-taibe-79"), ctx.peers["taibe"])
        self.assertIs(ctx.for_item("m-465"), ctx)
        items = [{"id": "m-taibe-79", "data": {"kind": "merge", "source": "boards-x"}},
                 {"id": "m-465", "data": {"kind": "merge", "source": "Координатор"}},
                 {"id": "i-1", "data": {"kind": "inbox", "inbox": {"text": "СТОП, откатить", "urgency": "now"}}}]
        checks = [{"id": "m-taibe-79", "data": {"done": True, "at": "2026-11-07T10:00:00Z"}},
                  {"id": "m-465", "data": {"done": True, "at": "2026-11-07T10:01:00Z"}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else checks, {})):
            sources.poll_queue(ctx)
        tb = [(r["kind"], r["to"]) for r in self.records("taibe")]
        hr = [(r["kind"], r["to"]) for r in self.records()]
        self.assertIn(("owner.answer", ["boards"]), tb)
        self.assertNotIn("m-465", " ".join(r["text"] for r in self.records("taibe")))
        self.assertIn(("owner.answer", ["coord"]), hr)
        self.assertNotIn("m-taibe-79", " ".join(r["text"] for r in self.records()))
        self.assertIn("owner.stop", [k for k, _ in tb])
        self.assertIn("owner.stop", [k for k, _ in hr])
        self.assertNotIn("owner.inbox", [k for k, _ in tb], "R-7: входящее — одному coord продукта по умолчанию")

    def test_failing_peer_does_not_break_default_events(self):
        """Линза 1: сбой журнала продукта — в его errors; событие и состояние продукта по умолчанию — как без продуктов."""
        ctx = self.peered()
        broken = ctx.peers["taibe"]
        broken.emit = mock.Mock(side_effect=OSError("диск"))
        self.assertTrue(ctx.emit_account("limit:hit:q", "limit.hit", NERVOUS, ["coord"], "лимит", "budget"))
        self.assertEqual([r["kind"] for r in self.records()], ["limit.hit"])
        self.assertIn("route", broken.state["errors"])
        items = [{"id": "m-taibe-1", "data": {"kind": "merge", "source": "x"}},
                 {"id": "m-2", "data": {"kind": "merge", "source": "Координатор"}}]
        checks = [{"id": "m-taibe-1", "data": {"done": True, "at": "2026-11-07T10:00:00Z"}},
                  {"id": "m-2", "data": {"done": True, "at": "2026-11-07T10:01:00Z"}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else checks, {})):
            sources.poll_queue(ctx)
        self.assertIn("m-2", " ".join(r["text"] for r in self.records()), "обход очереди не остановился")

    def test_reactivation_is_a_new_seed(self):
        """Линза 1: выключенный продукт теряет отметку seed — включение заново не отдаёт накопленное будилками."""
        self.peered()
        self.taibe["active"] = False
        ctx = nerve.Ctx(CFG, self.d)
        nerve.attach_peers(ctx, True)
        self.assertEqual(ctx.peers, {})
        self.taibe["active"] = True
        ctx = nerve.Ctx(CFG, self.d)
        nerve.attach_peers(ctx, True)
        self.assertFalse(ctx.peers["taibe"].deliver, "после простоя — снова seed")

    def test_item_product_field_wins_over_id(self):
        """Мост: продукт пункта выбирает владелец (поле `product` документа, v2-lite) — оно важнее метки в id;
        входящее с продуктом — coord этого продукта и стоп только туда."""
        ctx = self.peered()
        self.assertIs(ctx.for_item("s-set-control-b1-0711", "taibe"), ctx.peers["taibe"])
        self.assertIs(ctx.for_item("d-taibe-m1m2-0411", "hr-helper"), ctx)
        items = [{"id": "i-2", "product": "taibe",
                  "data": {"kind": "inbox", "inbox": {"text": "стоп", "urgency": "now"}}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else [], {})):
            sources.poll_queue(ctx)
        self.assertEqual(sorted(r["kind"] for r in self.records("taibe")), ["owner.inbox", "owner.stop"])
        self.assertEqual(self.records(), [], "входящее tAIBE не будит coord HR")

    def test_broken_instances_keeps_last_good_products(self):
        """Линза 1: сбой instances/ на проходе — событие release и продукты последней удачной загрузки."""
        self.peered()
        with mock.patch.object(nerve, "load_products", side_effect=ValueError("taibe.json: не JSON")):
            ctx = nerve.Ctx(CFG, self.d)
            with redirect_stderr(io.StringIO()):
                nerve.attach_peers(ctx, True)
        self.assertIn("taibe", ctx.peers)
        self.assertTrue(any(r["kind"] == "nerve.error" for r in self.records()))

    def test_map_roles_reads_worktree_transcripts(self):
        """R-9: сессия в worktree пишет транскрипт в `<project_dir>-worktrees-*`."""
        base = os.path.join(self.d, "proj")
        wt = base + "-worktrees-fix-x"
        for d, role in ((base, "coord"), (wt, "backend")):
            os.makedirs(d)
            with open(os.path.join(d, f"{role}.jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps({"type": "user", "message": {"content": f"сборка Т3, ключ реестра {role}"}}) + "\n")
        ctx = nerve.Ctx(dict(CFG, team=dict(CFG["team"], project_dir=base, roles=["coord", "backend"])), self.d)
        self.assertEqual(sources.active_roles(ctx), ["backend", "coord"])

    def test_broken_instances_keeps_default_tap_alive(self):
        with mock.patch.object(nerve, "load_products", side_effect=ValueError("taibe.json: не JSON")):
            open(os.path.join(self.d, "journal.jsonl"), "w").close()
            _, err = self.tap(None)
            self.assertIn("instances/ не читается", err)
            with self.assertRaises(SystemExit):
                self.tap("taibe")
            ctx = nerve.Ctx(CFG, self.d)
            nerve.run_products(ctx, True)
        recs, _ = read_from(os.path.join(self.d, "journal.jsonl"), 0)
        self.assertTrue(any(r["kind"] == "nerve.error" and "instances/" in r["text"] for r in recs))

    def test_emit_to_inactive_product_refused(self):
        self.taibe["active"] = False
        with redirect_stderr(io.StringIO()):
            rc = nerve.cmd_emit(CFG, Namespace(role="coord", text="x", kind="assign", product="taibe"))
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(os.path.join(self.tdir(), "journal.jsonl")))

    def test_inactive_product_is_not_polled(self):
        self.taibe["active"] = False
        self.keys = ["k1"]
        nerve.other_product_passes(True)
        self.assertFalse(os.path.exists(self.tdir()))

    def test_product_from_env_and_fallback_line(self):
        os.makedirs(self.tdir())
        open(os.path.join(self.tdir(), "journal.jsonl"), "w").close()
        open(os.path.join(self.d, "journal.jsonl"), "w").close()
        _, err = self.tap(None, env_product="taibe")
        self.assertEqual(err, "")
        self.assertTrue(os.path.exists(os.path.join(self.tdir(), "tap-boards.json")))
        _, err = self.tap(None)
        self.assertIn("продукт по умолчанию hr-helper", err)
        self.assertTrue(os.path.exists(os.path.join(self.d, "tap-boards.json")))

    def test_emit_writes_to_product_journal(self):
        with redirect_stdout(io.StringIO()):
            nerve.cmd_emit(CFG, Namespace(role="coord", text="первая карточка", kind="assign", product="taibe"))
        recs, _ = read_from(os.path.join(self.tdir(), "journal.jsonl"), 0)
        self.assertEqual([r["text"] for r in recs], ["первая карточка"])
        self.assertFalse(os.path.exists(os.path.join(self.d, "journal.jsonl")))

    def test_unknown_product_refused(self):
        with self.assertRaises(SystemExit):
            nerve.resolve_product(CFG, Namespace(product="nope"))

    def test_heartbeat_from_file(self):
        with open(os.path.join(self.d, "heartbeat"), "w") as f:
            f.write("2026-11-07T00:00:00+00:00")
        wj(os.path.join(self.d, "state.json"), {"heartbeat": "old"})
        self.assertEqual(nerve.read_heartbeat(), "2026-11-07T00:00:00+00:00")
        os.remove(os.path.join(self.d, "heartbeat"))
        self.assertEqual(nerve.read_heartbeat(), "old", "демон старее — пульс из state.json")


class RoleNumberingTest(unittest.TestCase):
    """Role numbers live in two places: team.roles here and role_num() in spawn_session.sh. If only one changes,
    «emit 4» silently reaches a different role than the session launched as role 4."""

    def test_spawn_session_role_num_matches_team_roles(self):
        import re
        path = os.path.join(HERE, "..", "tools", "spawn_session.sh")
        with open(path, encoding="utf-8") as f:
            body = re.search(r"^role_num\(\) \{\n(.*?)^\}", f.read(), re.S | re.M)
        self.assertIsNotNone(body, f"role_num() not found in {path}")
        numbered = {key: int(n) for key, n in re.findall(r"(\w+)\) echo (\d+)", body.group(1))}
        expected = {key: i for i, key in enumerate(CFG["team"]["roles"], 1)}
        self.assertEqual(numbered, expected)


if __name__ == "__main__":
    unittest.main()
