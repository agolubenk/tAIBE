# -*- coding: utf-8 -*-
"""Тесты Нерва на синтетике: python3 -I -m unittest discover -s supertick-eval/nerve -p 'test_*.py'"""
import io
import json
import os
import re
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
import products  # noqa: E402
import quorum  # noqa: E402
import gh_source  # noqa: E402
import sources  # noqa: E402
from journal import DIGEST, NERVOUS, Journal, read_from  # noqa: E402

MSK = timezone(timedelta(hours=3))
# Окружение живой сессии роли (геном ставит продукт и линию): подпроцесс nerve.py без них, иначе журнал уходит в
# папку продукта, а тест читает NERVE_STATE_DIR (SE-129).
SESSION_ENV = ("TAIBE_PRODUCT", "TAIBE_LINEAGE")


def clean_env(**extra):
    return {**{k: v for k, v in os.environ.items() if k not in SESSION_ENV}, **extra}


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
        self.assertTrue(quorum.quorum(vs, head, ["SUCCESS"])[0])
        vs.append(pv("Поправка к линзе корректности (роль 4) — мой ACCEPT на 76183ab0d отменяю"))
        self.assertFalse(quorum.quorum(vs, head, ["SUCCESS"])[0], "отозванный ACCEPT не считается")

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
        ok, approved, _, _ = quorum.quorum(vs, head, ["SUCCESS"])
        self.assertEqual((ok, approved), (False, ["backend", "plan"]))

    def test_odd_unicode_does_not_raise(self):
        self.assertEqual(pv("Линза QA: changeſ на 76183ab0d")["verdict"], "changes")
        self.assertIsNone(pv("Линза QA: approve на " + " *_`" * 20000 + "76183ab0d"), "строка режется до 500 знаков")

    def test_quorum_needs_three_lenses_on_head_and_no_changes(self):
        head = "46b9f87e1aaaabbbbcccc"
        vs = [pv(f"{l}: approve на 46b9f87e1") for l in ("QA", "Бэкенд", "Контроль")]
        self.assertTrue(quorum.quorum(vs, head, ["SUCCESS"])[0])
        self.assertFalse(quorum.quorum(vs[:2], head, ["SUCCESS"])[0])
        old = [pv(f"{l}: approve на 1111111") for l in ("QA", "Бэкенд", "Контроль")]
        self.assertFalse(quorum.quorum(old, head, ["SUCCESS"])[0], "вердикт на старую голову не считается")
        ch = vs + [pv("Линза «корректность и отказы»: changes на 46b9f87e1 — секрет в логе")]
        ok, _, changes, _ = quorum.quorum(ch, head, ["SUCCESS"])
        self.assertFalse(ok)
        self.assertEqual(changes, ["корректность и отказы"])
        self.assertFalse(quorum.quorum(vs, head, ["IN_PROGRESS"])[0], "CI ещё идёт")
        self.assertEqual(quorum.quorum(vs, head, [])[::3], (False, "pending"), "проверок ещё нет — не ok (SE-126)")
        self.assertEqual(quorum.ci_state([]), "pending")
        self.assertEqual(quorum.ci_state(["SUCCESS", "STARTUP_FAILURE"]), "failure", "workflow не стартовал — провал")
        self.assertEqual(quorum.ci_state(["SUCCESS", "REQUESTED"]), "pending", "прогон запрошен — CI ещё идёт")
        self.assertEqual(quorum.quorum(vs, head, ["NONE"])[::3], (True, "none"), "CI у PR нет — маркер gh_source")

    def test_author_roles_add_second_sessions(self):
        roles = CFG["team"]["roles"]
        self.assertEqual(quorum.author_roles("backend", roles), ["backend", "backend-2"])
        self.assertEqual(quorum.author_roles("frontend", roles), ["frontend", "frontend-2"])
        self.assertEqual(quorum.author_roles("coord", roles), ["coord"])
        self.assertEqual(quorum.author_roles("backend", ["backend"]), ["backend"])

    def test_second_session_is_the_same_lens(self):
        """Линза backend #324: approve от backend и backend-2 — одна линза. Кворум трёх линз — от трёх ролей."""
        head = "abd008c5c" + "0" * 31
        vs = [pv(f"{l}: approve на abd008c5c") for l in ("Бэкенд (роль 4)", "Бэкенд (роль 7)", "Линза плана (роль 2)")]
        self.assertEqual([v["lens"] for v in vs], ["backend", "backend-2", "plan"])
        ok, approved, _, _ = quorum.quorum(vs, head, ["SUCCESS"])
        self.assertEqual((ok, approved), (False, ["backend", "plan"]))
        ok, approved, _, ci = quorum.quorum(vs, head, ["IN_PROGRESS"])
        self.assertLess(len(approved), 3, "await_ci (sources.py) считает те же approved")
        ok, approved, _, _ = quorum.quorum(vs + [pv("Данные (роль 6): approve на abd008c5c")], head, ["SUCCESS"])
        self.assertEqual((ok, approved), (True, ["backend", "boards", "plan"]))
        ch = vs + [pv("Данные (роль 6): approve на abd008c5c"), pv("Бэкенд (роль 7): changes на abd008c5c")]
        ok, approved, changes, _ = quorum.quorum(ch, head, ["SUCCESS"])
        self.assertEqual((ok, approved, changes), (False, ["backend", "boards", "plan"], ["backend-2"]),
                         "changes второй сессии блокирует и адресован ей")

    def test_later_verdict_of_a_lens_overrides(self):
        head = "abcdef1234"
        vs = [pv(x) for x in (
            "QA: changes на abcdef1", "QA: approve на abcdef1", "Бэкенд: approve на abcdef1",
            "Контроль: approve на abcdef1")]
        self.assertTrue(quorum.quorum(vs, head, ["SUCCESS"])[0])

    def test_author_role_by_files(self):
        pr = CFG["github"]["path_roles"]
        self.assertEqual(quorum.author_role(["apps/frontend/src/a.tsx", "apps/frontend/b.ts", "docs/x.md"], pr),
                         "frontend")
        self.assertEqual(quorum.author_role(["README.md"], pr), "coord")
        self.assertEqual(quorum.role_of_lens("линза devops", CFG["github"]["lens_roles"]), "release")
        self.assertEqual(quorum.role_of_lens("backend", LR, TEAM), "backend", "ключ-роль — сама роль")

    def test_body_author_line(self):
        """SE-121: «роль N — автор» в теле PR — роль автора; другие слова и цитата — нет."""
        roles = CFG["team"]["roles"]
        for body, want in (("Линзы: роль 6 — автор. Нужны 3 линзы ролей не автора.", "boards"),
                           ("Lenses: role 4 - author", "backend"), ("**Роль 7 – автор**", "backend-2"),
                           ("роль 4 — автора не считаем", None), ("> роль 4 — автор\nтекст", None),
                           ("роль 9 — автор", None), ("роль 0 — автор", None),
                           ("Нужны 3 линзы ролей не автора", None), ("", None),
                           (None, None), ("строка\nроль 2 — автор\nроль 5 — автор", "plan")):
            self.assertEqual(quorum.body_author(body, roles), want, body)
        paths = CFG["github"]["path_roles"]
        backend_files = ["apps/backend/src/a.ts", "apps/backend/src/b.ts"]
        self.assertEqual(quorum.pr_author("роль 2 — автор", backend_files, paths, roles), "plan", "строка важнее путей")
        self.assertEqual(quorum.pr_author("", backend_files, paths, roles), "backend")

    def test_author_approve_is_not_counted(self):
        """SE-121: approve базовой роли автора не идёт в кворум — и от второй сессии; changes автора блокирует."""
        head = "c0ffee123" + "0" * 31
        vs = [pv(f"{l}: approve на c0ffee123") for l in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        self.assertTrue(quorum.quorum(vs, head, ["SUCCESS"])[0], "без автора — как раньше")
        ok, approved, _, _ = quorum.quorum(vs, head, ["SUCCESS"], author="backend")
        self.assertEqual((ok, approved), (False, ["boards", "plan"]))
        self.assertEqual(quorum.quorum(vs, head, ["SUCCESS"], author="backend-2")[:2], (False, ["boards", "plan"]),
                         "автор — вторая сессия: approve основной сессии той же роли тоже выпадает")
        last = quorum.last_on_head(vs + [pv("Бэкенд (роль 7): approve на c0ffee123")], head)
        self.assertEqual(quorum.tally(last, "backend"), (["boards", "plan"], []))
        self.assertTrue(quorum.author_approved(last, "backend"))
        self.assertFalse(quorum.author_approved(last, "frontend"))
        self.assertFalse(quorum.author_approved(last, None))
        withdrawn = quorum.last_on_head(vs + [pv("Бэкенд (роль 4): approve на c0ffee123 отзываю")], head)
        self.assertFalse(quorum.author_approved(withdrawn, "backend"), "отозванный approve автора не называется")
        ch = vs + [pv("Линза «продукт» (роль 1): approve на c0ffee123"), pv("Бэкенд (роль 4): changes на c0ffee123")]
        ok, approved, changes, _ = quorum.quorum(ch, head, ["SUCCESS"], author="backend")
        self.assertEqual((ok, approved, changes), (False, ["boards", "coord", "plan"], ["backend"]))


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

    def test_route_source_second_sessions(self):
        """#324 B1: пункт второй сессии — её ключ, не базовой роли; правила стоят до базовых в обоих продуктах."""
        shared, prods = products.load()
        for slug in ("taibe", "hr-helper"):
            rules = products.config_for(slug, shared, prods)["queue"]["source_roles"]
            for src, role in (("backend-2 r.ab12", "backend-2"), ("Бэкенд-2 (роль 7) r.ab12", "backend-2"),
                              ("Фронтенд-2 r.cd34", "frontend-2"), ("frontend (роль 8)", "frontend-2"),
                              ("Бэкенд r.f93t", "backend"), ("Фронтенд (роль 3)", "frontend")):
                self.assertEqual(sources.route_source(src, rules), role, (slug, src))


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

    FILES = ["apps/backend/src/x.ts"]

    def __init__(self, open_prs, merged=(), broken=(), comments=None, closed=(), ci=None, mute=(), files=None,
                 bodies=None):
        self.open_prs, self.merged, self.broken = open_prs, set(merged), set(broken)
        self.files, self.bodies = files or {}, bodies or {}   # номер → пути файлов, тело PR
        self.mute = set(mute)       # номера, у которых падает чтение комментариев
        self.ci = ci or {}          # номер → статус CI в gh pr view; по умолчанию SUCCESS
        self.closed = set(closed)   # закрыты без мёржа; остальные номера вне merged — OPEN
        self.comments = comments or {}
        self.calls = []

    def __call__(self, cmd, stdin=None, timeout=30):
        self.calls.append(list(cmd))
        if cmd[:3] == ["gh", "pr", "list"]:
            if cmd[cmd.index("--repo") + 1] != self.REPO:
                return 1, "", "GraphQL: Could not resolve to a Repository"
            limit = int(cmd[cmd.index("--limit") + 1])
            return 0, json.dumps([{"number": p["number"], "title": p["title"], "updatedAt": p["updated_at"],
                                   "createdAt": p["created_at"], "headRefOid": p["head"]["sha"]}
                                  for p in self.open_prs[:limit]]), ""
        if cmd[:2] == ["gh", "api"] and cmd[-1].startswith(f"repos/{self.REPO}/issues/"):
            n = int(cmd[-1].split("/")[4])
            if n in self.mute:
                return 1, "", "HTTP 502"
            return 0, json.dumps([{"id": i, "body": b} for i, b in enumerate(self.comments.get(n, []))]), ""
        if cmd[:3] == ["gh", "pr", "view"]:
            n = int(cmd[3])
            if "--repo" not in cmd or cmd[cmd.index("--repo") + 1] != self.REPO:
                return 1, "", f"GraphQL: Could not resolve to a PullRequest with the number of {n}."
            if n in self.broken:
                return 1, "", "HTTP 502"
            state = "MERGED" if n in self.merged else "CLOSED" if n in self.closed else "OPEN"
            ci = self.ci.get(n, "SUCCESS")          # "" — у головы ещё нет ни одной проверки (SE-126)
            d = {"files": [{"path": f} for f in self.files.get(n, self.FILES)],
                 "statusCheckRollup": [{"conclusion": ci}] if ci else [],
                 "state": state, "mergedAt": "2026-11-04T15:55:00Z" if state == "MERGED" else None,
                 "closedAt": None if state == "OPEN" else "2026-11-04T15:55:00Z"}
            if "body" in cmd[cmd.index("--json") + 1].split(","):
                d["body"] = self.bodies.get(n, "")
            return 0, json.dumps(d), ""
        raise AssertionError(f"неожиданный вызов: {cmd}")


def _pr(n, sha, upd="2026-11-04T10:00:00Z", created=""):
    return {"number": n, "title": f"PR {n}", "updated_at": upd, "head": {"sha": sha}, "created_at": created}


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
        files, checks, state, _, _ = gh_source._gh_view(FakeGh.REPO, 458)
        self.assertEqual((files, checks, state), (FakeGh.FILES, ["SUCCESS"], "OPEN"))
        gh_source.poll_github(self.ctx)
        self.assertTrue(fake.calls)
        for c in fake.calls:
            if c[:3] in (["gh", "pr", "view"], ["gh", "pr", "list"]):
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
        gh_source.poll_github(self.ctx)
        kinds = [k for k, _ in self.kinds()]
        self.assertNotIn("pr.changes", kinds)
        self.assertIn("pr.quorum", kinds)
        self.assertEqual(self.ctx.state["github"]["prs"]["478"]["changes_by"], [])

    def test_second_session_approve_does_not_make_quorum(self):
        """Линза backend #324: backend + backend-2 + plan — две линзы: ни pr.quorum, ни await_ci."""
        head = "abd008c5c" + "0" * 31
        three = ["Бэкенд (роль 4): approve на abd008c5c", "Бэкенд (роль 7): approve на abd008c5c",
                 "Линза плана (роль 2): approve на abd008c5c"]
        sources.run = FakeGh([_pr(324, head)], comments={324: three})
        gh_source.poll_github(self.ctx)
        p = self.ctx.state["github"]["prs"]["324"]
        self.assertNotIn("pr.quorum", [k for k, _ in self.kinds()])
        self.assertFalse(p["await_ci"])
        sources.run = FakeGh([_pr(324, head, "2026-11-04T11:00:00Z")],
                             comments={324: three + ["Данные (роль 6): approve на abd008c5c"]})
        gh_source.poll_github(self.ctx)
        self.assertIn(("pr.quorum", "#324 собран: approve backend, boards, plan на abd008c5c, CI ok"), self.kinds())

    def test_changes_reach_the_author_role_and_its_second_session(self):
        """#324 B2: автор по путям — базовая роль; changes доходит и до второй сессии (PR могла открыть она)."""
        sources.run = FakeGh([_pr(480, "c" * 40)], comments={480: ["**Линза плана (роль 2) — CHANGES на ccccccc**"]})
        gh_source.poll_github(self.ctx)
        rec = [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["kind"] == "pr.changes"]
        self.assertEqual([e["to"] for e in rec], [["backend", "backend-2"]])

    def test_author_approve_is_named_once_and_does_not_make_quorum(self):
        """SE-121: тело называет автора backend; его approve не засчитан: одно pr.own Контролю на голову, потом
        кворум трёх других линз, и строка кворума называет не засчитанный approve."""
        head = "d0d0d0d0d" + "0" * 31
        lens = [f"{x}: approve на d0d0d0d0d" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        body = {486: "Линзы: роль 4 — автор."}
        sources.run = FakeGh([_pr(486, head)], comments={486: lens}, bodies=body)
        gh_source.poll_github(self.ctx)
        own = [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["kind"] == "pr.own"]
        self.assertEqual([(e["text"], e["to"]) for e in own],
                         [("#486: approve автора backend на d0d0d0d0d не засчитан — линз 2/3", ["release"])])
        self.assertNotIn("pr.quorum", [k for k, _ in self.kinds()])
        lens.append("Линза фронтенда (роль 3): changes на 0000000")   # вердикт на старую голову: кворум тот же
        sources.run = FakeGh([_pr(486, head, "2026-11-04T10:30:00Z")], comments={486: lens}, bodies=body)
        gh_source.poll_github(self.ctx)
        sources.run = FakeGh([_pr(486, head, "2026-11-04T11:00:00Z")], bodies=body,
                             comments={486: lens + ["Контроль (роль 5): approve на d0d0d0d0d"]})
        gh_source.poll_github(self.ctx)
        self.assertIn(("pr.quorum", "#486 собран: approve boards, plan, release на d0d0d0d0d, CI ok; "
                                    "approve автора backend не засчитан"), self.kinds())
        self.assertEqual([k for k, _ in self.kinds()].count("pr.own"), 1, "pr.own — один раз на голову")

    def test_quorum_with_the_author_approve_at_once_has_no_own_event(self):
        """SE-121: кворум собран и без автора — pr.own не нужен, причину называет строка кворума."""
        head = "a2a2a2a2a" + "0" * 31
        labels = ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)", "Контроль (роль 5)")
        sources.run = FakeGh([_pr(489, head)], comments={489: [f"{x}: approve на a2a2a2a2a" for x in labels]},
                             bodies={489: "роль 4 — автор"})
        gh_source.poll_github(self.ctx)
        self.assertEqual([k for k, _ in self.kinds()], ["pr.quorum"])

    def test_only_the_body_line_drops_an_approve_paths_do_not(self):
        """SE-121 (координатор 06:40, вариант A): пути backend без строки — approve backend считается; строка
        «роль 2 — автор» при тех же путях — выпадает approve plan, и pr.changes адресован plan."""
        head = "e0e0e0e0e" + "0" * 31
        lens = [f"{x}: approve на e0e0e0e0e" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        sources.run = FakeGh([_pr(487, head), _pr(490, head)], comments={487: lens, 490: lens},
                             bodies={490: "Правка.\n\nЛинзы: роль 2 — автор."})
        gh_source.poll_github(self.ctx)
        prs = self.ctx.state["github"]["prs"]
        self.assertEqual((prs["487"]["author"], prs["487"]["author_line"]), ("backend", None))
        self.assertEqual((prs["490"]["author"], prs["490"]["author_line"]), ("plan", "plan"))
        self.assertIn(("pr.quorum", "#487 собран: approve backend, boards, plan на e0e0e0e0e, CI ok"), self.kinds())
        self.assertIn(("pr.own", "#490: approve автора plan на e0e0e0e0e не засчитан — линз 2/3"), self.kinds())
        self.assertNotIn("#490 собран", " ".join(t for _, t in self.kinds()))

    def test_pr_parsed_before_se121_reads_the_body_once_on_change(self):
        """Состояние до SE-121: author есть, author_line нет — при изменении PR одно чтение тела, строка действует."""
        head = "e1e1e1e1e" + "0" * 31
        lens = [f"{x}: approve на e1e1e1e1e" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        self.ctx.state["github"] = {"rev": gh_source.GH_STATE_REV, "prs": {"491": {
            "head": head, "updated": "x", "seen": [], "changes_by": [], "author": "backend", "checks": ["SUCCESS"]}}}
        fake = FakeGh([_pr(491, head)], comments={491: lens}, bodies={491: "роль 4 — автор"})
        sources.run = fake
        gh_source.poll_github(self.ctx)
        self.assertEqual(self.ctx.state["github"]["prs"]["491"]["author_line"], "backend")
        self.assertEqual(sum(c[:3] == ["gh", "pr", "view"] for c in fake.calls), 1)
        self.assertNotIn("pr.quorum", [k for k, _ in self.kinds()])

    def test_ci_recheck_does_not_read_the_body(self):
        """SE-121: тело PR — только при разборе автора; перепроверка CI читает прежние поля без тела."""
        head = "f1f1f1f1f" + "0" * 31
        lens = [f"{x}: approve на f1f1f1f1f" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        fake = FakeGh([_pr(488, head)], comments={488: lens}, ci={488: "IN_PROGRESS"})
        sources.run = fake
        gh_source.poll_github(self.ctx)
        gh_source.poll_github(self.ctx)
        views = [c[c.index("--json") + 1] for c in fake.calls if c[:3] == ["gh", "pr", "view"]]
        self.assertEqual(views, ["files,statusCheckRollup,body", "files,statusCheckRollup,state,mergedAt,closedAt"])

    def test_new_head_after_changes_goes_to_the_lens_role(self):
        sources.run = FakeGh([_pr(479, "a" * 40)], comments={479: ["**Линза корректности (роль 4) — CHANGES на aaaaaaa**"]})
        gh_source.poll_github(self.ctx)
        self.assertEqual(self.ctx.state["github"]["prs"]["479"]["changes_by"], ["backend"])
        sources.run = FakeGh([_pr(479, "b" * 40, "2026-11-04T11:00:00Z")])
        gh_source.poll_github(self.ctx)
        rec = [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["kind"] == "pr.newhead"]
        self.assertEqual([e["to"] for e in rec], [["backend"]])

    def test_stuck_merged_pr_is_reported_once_after_upgrade(self):
        # Состояние rev 1: #457 влит, но остался в prs; etag живой — без сброса 304 спрятал бы его навсегда.
        self.ctx.state["github"] = {"etag": 'W/"e1"', "prs": {"457": {"head": "b" * 40, "updated": "x",
                                                                       "seen": [], "changes_by": []}}}
        sources.run = FakeGh([], merged={457})
        gh_source.poll_github(self.ctx)
        st = self.ctx.state["github"]
        self.assertNotIn("457", st["prs"])
        self.assertIn(("pr.closed", "#457 влит"), self.kinds())
        self.assertEqual(st["rev"], gh_source.GH_STATE_REV)
        self.assertNotIn("etag", st, "etag REST-страницы снят (SE-119)")
        gh_source.poll_github(self.ctx)  # второй проход — тот же список, повторного «влит» нет
        self.assertEqual(self.kinds().count(("pr.closed", "#457 влит")), 1)

    def test_stuck_open_pr_without_author_is_resolved_after_upgrade(self):
        # rev 1 записывал head и updated до падения _gh_view: PR выглядел увиденным, но author и checks пусты.
        sha, upd = "9" * 40, "2026-11-04T10:00:00Z"
        self.ctx.state["github"] = {"etag": 'W/"e1"', "prs": {"458": {"head": sha, "updated": upd,
                                                                       "seen": [], "changes_by": []}}}
        sources.run = FakeGh([_pr(458, sha, upd)])
        gh_source.poll_github(self.ctx)
        p = self.ctx.state["github"]["prs"]["458"]
        self.assertEqual(p.get("checks"), ["SUCCESS"])
        self.assertIn("author", p)

    def test_one_failing_pr_does_not_stop_the_pass_and_is_retried(self):
        sources.run = FakeGh([_pr(1, "c" * 40), _pr(2, "d" * 40)], merged={9}, broken={1})
        self.ctx.state["github"] = {"etag": "", "rev": gh_source.GH_STATE_REV,
                                    "prs": {"9": {"head": "e" * 40, "updated": "x", "seen": [], "changes_by": []}}}
        with self.assertRaisesRegex(RuntimeError, r"PR с ошибкой: 1; #1: gh pr view"):
            gh_source.poll_github(self.ctx)
        st = self.ctx.state["github"]
        self.assertIn("author", st["prs"]["2"], "#2 разобран, хотя #1 упал раньше")
        self.assertNotIn("9", st["prs"], "цикл закрытых прошёл")
        self.assertEqual((st["prs"]["1"]["head"], st["prs"]["1"]["updated"]), ("", ""), "#1 не считается увиденным")
        sources.run = FakeGh([_pr(1, "c" * 40), _pr(2, "d" * 40)])
        gh_source.poll_github(self.ctx)
        self.assertIn("author", st["prs"]["1"])
        self.assertEqual(self.kinds().count(("pr.new", "#1 открыт: PR 1")), 1, "повтор не дублирует событие")

    def test_closed_pr_that_fails_stays_for_retry(self):
        sources.run = FakeGh([], broken={7})
        self.ctx.state["github"] = {"etag": "", "rev": gh_source.GH_STATE_REV,
                                    "prs": {"7": {"head": "f" * 40, "updated": "x", "seen": [], "changes_by": []}}}
        with self.assertRaises(RuntimeError):
            gh_source.poll_github(self.ctx)
        self.assertIn("7", self.ctx.state["github"]["prs"])
        self.assertNotIn("pr.closed", [k for k, _ in self.kinds()])

    def _known(self, *ns):
        return {str(n): {"head": "a" * 40, "updated": "2026-11-04T10:00:00Z", "seen": [], "changes_by": [],
                         "author": "backend", "checks": []} for n in ns}

    def test_one_list_call_covers_all_open_prs(self):
        """Дайджест 14.11 18:32: «#267 закрыт» при открытом PR — читалась одна страница из 50 при 161 открытом.
        SE-119: весь список — один gh pr list с нужными полями, без REST-страниц на 3,45 МБ."""
        self.ctx.state["github"] = {"etag": 'W/"e1"', "rev": gh_source.GH_STATE_REV,
                                    "prs": self._known(1, 2, 3, 4, 5)}
        fake = FakeGh([_pr(n, "a" * 40) for n in (1, 2, 3, 4, 5)])
        sources.run = fake
        gh_source.poll_github(self.ctx)
        lists = [c for c in fake.calls if c[:3] == ["gh", "pr", "list"]]
        self.assertEqual(lists, [["gh", "pr", "list", "--repo", FakeGh.REPO, "--state", "open", "--limit", "1000",
                                  "--json", "number,headRefOid,updatedAt,createdAt,title"]])
        self.assertFalse([c for c in fake.calls if c[:2] == ["gh", "api"]], "PR не менялись: ни списка REST, "
                         "ни комментариев")
        self.assertNotIn("etag", self.ctx.state["github"])
        self.assertEqual(sorted(self.ctx.state["github"]["prs"]), ["1", "2", "3", "4", "5"])
        self.assertNotIn("pr.closed", [k for k, _ in self.kinds()])
        self.assertFalse([c for c in fake.calls if c[:3] == ["gh", "pr", "view"]], "все в списке: разбирать нечего")

    def test_open_pr_missing_from_the_list_stays(self):
        # Потолок страниц или сдвиг списка между страницами: PR нет в списке, но gh pr view говорит OPEN.
        self.ctx.state["github"] = {"etag": "", "rev": gh_source.GH_STATE_REV, "prs": self._known(267, 300)}
        sources.run = FakeGh([_pr(300, "a" * 40)], closed={268})
        gh_source.poll_github(self.ctx)
        self.assertIn("267", self.ctx.state["github"]["prs"])
        self.assertNotIn("pr.closed", [k for k, _ in self.kinds()])

    def test_real_close_after_a_false_one_is_reported(self):
        # rev 2 записал ложный ключ gh:closed:268; настоящее закрытие — другой ключ, событие доходит.
        self.ctx.emit("gh:closed:268", "pr.closed", DIGEST, ["coord"], "#268 закрыт", "github")
        self.ctx.state["github"] = {"etag": "", "rev": gh_source.GH_STATE_REV, "prs": self._known(268)}
        sources.run = FakeGh([], closed={268})
        gh_source.poll_github(self.ctx)
        self.assertEqual(self.kinds().count(("pr.closed", "#268 закрыт")), 2)
        self.assertNotIn("268", self.ctx.state["github"]["prs"])

    def test_quorum_waiting_for_ci_is_rechecked_while_the_pr_is_unchanged(self):
        """SE-119: CI доезжает, не меняя PR. Раньше такой PR перепроверялся только на 304, а его почти не было."""
        head = "d" * 40
        three = [f"{x}: approve на ddddddd" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        sources.run = FakeGh([_pr(481, head)], comments={481: three}, ci={481: "IN_PROGRESS"})
        gh_source.poll_github(self.ctx)
        self.assertTrue(self.ctx.state["github"]["prs"]["481"]["await_ci"])
        self.assertNotIn("pr.quorum", [k for k, _ in self.kinds()])
        idle = FakeGh([_pr(481, head)], comments={481: three}, ci={481: "IN_PROGRESS"})
        sources.run = idle
        gh_source.poll_github(self.ctx)
        self.assertEqual([c[:3] for c in idle.calls if c[:2] != ["gh", "pr"] or c[2] != "list"],
                         [["gh", "pr", "view"]], "CI идёт: только статус проверок, комментарии не читаются (#292: 54 КБ)")
        self.assertTrue(self.ctx.state["github"]["prs"]["481"]["await_ci"])
        fake = FakeGh([_pr(481, head)], comments={481: three})
        sources.run = fake
        gh_source.poll_github(self.ctx)
        self.assertIn(("pr.quorum", "#481 собран: approve backend, boards, plan на ddddddddd, CI ok"), self.kinds())
        self.assertFalse(self.ctx.state["github"]["prs"]["481"]["await_ci"])
        gh_source.poll_github(self.ctx)
        self.assertEqual(len([c for c in fake.calls if c[:3] == ["gh", "pr", "view"]]), 1, "CI доехал: дальше без view")

    def test_head_without_checks_waits_for_ci(self):
        """SE-126: сразу после push у головы нет ни одной проверки. Три approve — ожидание CI, а не pr.quorum с «CI ok»."""
        head = "e" * 40
        three = [f"{x}: approve на eeeeeee" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        sources.run = FakeGh([_pr(482, head)], comments={482: three}, ci={482: ""})
        gh_source.poll_github(self.ctx)
        p = self.ctx.state["github"]["prs"]["482"]
        self.assertEqual((p["checks"], p["await_ci"]), ([], True))
        self.assertNotIn("pr.quorum", [k for k, _ in self.kinds()])
        sources.run = FakeGh([_pr(482, head)], comments={482: three})
        gh_source.poll_github(self.ctx)
        self.assertIn(("pr.quorum", "#482 собран: approve backend, boards, plan на eeeeeeeee, CI ok"), self.kinds())
        self.assertFalse(p["await_ci"])

    def test_no_checks_for_30_min_gives_quorum_with_ci_none_then_normal_rule(self):
        """SE-126, решение координатора 05:50: у PR вне фильтров paths проверок не будет. Через 30 мин после головы —
        pr.quorum с «CI: none» и одно событие координатору; дальше gh pr view раз в 15 мин; проверки появились —
        обычное правило CI; новая голова сбрасывает отсчёт."""
        head, t0 = "f" * 40, self.ctx.now
        three = [f"{x}: approve на {{}}" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        views, reads = [], []

        def at(minutes, sha=head, ci=""):
            self.ctx.now = t0 + timedelta(minutes=minutes)
            fake = FakeGh([_pr(483, sha)], comments={483: [c.format(sha[:7]) for c in three]}, ci={483: ci})
            sources.run = fake
            gh_source.poll_github(self.ctx)
            views.append(len([c for c in fake.calls if c[:3] == ["gh", "pr", "view"]]))
            reads.append(len([c for c in fake.calls if c[:2] == ["gh", "api"]]))

        def events(kind):
            return [t for k, t in self.kinds() if k == kind]

        for m in (0, 29):
            at(m)
        self.assertEqual(events("pr.quorum"), [], "до 30 мин пустой список — CI ещё не стартовал")
        for m in (31, 35, 45, 47):
            at(m)
        self.assertEqual(views, [1, 1, 1, 0, 0, 1], "до 30 мин — каждый проход, дальше раз в 15 мин")
        self.assertEqual(reads, [1, 0, 1, 0, 0, 0], "комментарии — на голове и один раз на «CI: none», не раз в 15 мин")
        self.assertEqual(events("pr.quorum"),
                         ["#483 собран: approve backend, boards, plan на fffffffff, CI: none (проверок нет 30 мин)"])
        self.assertEqual(len(events("pr.nochecks")), 1)
        self.assertTrue(self.ctx.state["github"]["prs"]["483"]["await_ci"], "CI: none — ожидание не снято")
        at(50, ci="SUCCESS")
        self.assertEqual(views[-1], 0, "проверки заметны на следующем чтении раз в 15 мин")
        at(62, ci="SUCCESS")
        self.assertEqual(events("pr.quorum")[-1], "#483 собран: approve backend, boards, plan на fffffffff, CI ok")
        self.assertFalse(self.ctx.state["github"]["prs"]["483"]["await_ci"])
        new = "1" * 40
        at(63, new)
        at(64, new)
        self.assertEqual(views[-2:], [1, 1], "новая голова: снова каждый проход")
        self.assertEqual(len(events("pr.quorum")), 2)
        at(94, new)
        self.assertEqual(len(events("pr.quorum")), 3)
        self.assertEqual(len(events("pr.nochecks")), 2)

    def test_ci_registered_after_the_first_view_gives_normal_quorum_not_none(self):
        """Линза Claude #371, B1: первое чтение после push видит [] (CI ещё не зарегистрирован), две линзы — без
        ожидания CI; третья через 40 мин. Старый [] не даёт «CI: none»: пустой список перечитывается."""
        head, t0 = "a1" * 20, self.ctx.now
        lens = [f"{x}: approve на a1a1a1a" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]
        sources.run = FakeGh([_pr(484, head)], comments={484: lens[:2]}, ci={484: ""})
        gh_source.poll_github(self.ctx)
        p = self.ctx.state["github"]["prs"]["484"]
        self.assertEqual((p["checks"], p["await_ci"]), ([], False))
        self.ctx.now = t0 + timedelta(minutes=40)
        sources.run = FakeGh([_pr(484, head, upd="2026-11-04T10:40:00Z")], comments={484: lens}, ci={484: "FAILURE"})
        gh_source.poll_github(self.ctx)
        self.assertEqual([t for k, t in self.kinds() if k in ("pr.quorum", "pr.nochecks")],
                         ["#484 собран: approve backend, boards, plan на a1a1a1a1a, CI failure"])
        self.assertEqual(p["head_at"], t0.strftime("%Y-%m-%dT%H:%M:%SZ"), "head_at — только от новой головы")

    def test_failed_reads_on_ci_none_do_not_lose_the_quorum(self):
        """Линза Claude #371: B2 — упавшее чтение комментариев не ставит none_head, «CI: none» приходит на следующей
        перепроверке; ci_at — после удачного gh pr view: сбой view повторяется следующим проходом, а не через 15 мин."""
        head, t0 = "b2" * 20, self.ctx.now
        lens = [f"{x}: approve на b2b2b2b" for x in ("Бэкенд (роль 4)", "Линза плана (роль 2)", "Данные (роль 6)")]

        def at(minutes, **kw):
            self.ctx.now = t0 + timedelta(minutes=minutes)
            fake = FakeGh([_pr(485, head)], comments={485: lens}, ci={485: ""}, **kw)
            sources.run = fake
            try:
                gh_source.poll_github(self.ctx)
            except RuntimeError:
                pass
            return [c[:3] for c in fake.calls if c[:3] != ["gh", "pr", "list"]]

        def none():
            return [t for k, t in self.kinds() if k == "pr.quorum"]

        at(0)
        self.assertEqual(at(31, broken=(485,)), [["gh", "pr", "view"]])
        self.assertEqual(at(32, mute=(485,)),
                         [["gh", "pr", "view"], ["gh", "api", f"repos/{FakeGh.REPO}/issues/485/comments?per_page=100"]])
        self.assertEqual(none(), [])
        self.assertEqual(at(40), [], "после удачного чтения — раз в 15 мин")
        at(47)
        self.assertEqual(none(), ["#485 собран: approve backend, boards, plan на b2b2b2b2b, CI: none (проверок нет 30 мин)"])
        self.assertEqual(at(63), [["gh", "pr", "view"]], "«CI: none» разобран: комментарии больше не читаются")

    def test_upgrade_backfill_is_capped_and_says_open_only_for_new_prs(self):
        old = [_pr(n, "b" * 40, created="2026-11-01T10:00:00Z") for n in range(1, 26)]
        self.ctx.state["github"] = {"etag": 'W/"e1"', "rev": 2, "prs": {}}
        sources.run = FakeGh(old)
        gh_source.poll_github(self.ctx)
        st = self.ctx.state["github"]
        self.assertEqual(len(st["prs"]), gh_source.GH_NEW_PER_PASS)
        self.assertEqual(st["rev"], gh_source.GH_STATE_REV)
        self.assertIn("backfill", st)
        new = _pr(26, "c" * 40, created="2999-01-01T00:00:00Z")
        sources.run = FakeGh(old + [new])
        gh_source.poll_github(self.ctx)
        self.assertEqual(len(st["prs"]), 26)
        self.assertNotIn("backfill", st)
        self.assertEqual([t for k, t in self.kinds() if k == "pr.new"], ["#26 открыт: PR 26"])

    def test_pr_opened_during_a_restart_gap_says_open(self):
        """SE-120: граница догона — самое позднее updated известных PR, а не старт нового процесса. PR, открытый
        в паузе перезапуска, получает «открыт»; давний PR, впервые увиденный новым кодом, — нет."""
        known = self._known(1)
        known["1"]["updated"] = "2026-11-05T00:00:00Z"
        self.ctx.state["github"] = {"rev": 2, "prs": known}
        sources.run = FakeGh([_pr(1, "a" * 40, "2026-11-05T00:00:00Z"),
                              _pr(2, "b" * 40, created="2026-11-05T00:05:00Z"),
                              _pr(3, "c" * 40, created="2026-11-04T10:00:00Z")])
        gh_source.poll_github(self.ctx)
        self.assertEqual([t for k, t in self.kinds() if k == "pr.new"], ["#2 открыт: PR 2"])
        self.assertEqual(sorted(self.ctx.state["github"]["prs"]), ["1", "2", "3"])

    def test_backfill_boundary_ignores_bad_dates_and_the_future(self):
        p = lambda u: {"updated": u}  # noqa: E731
        since = gh_source._backfill_since
        self.assertEqual(since({"1": p("2026-11-04T10:00:00Z"), "2": p("2026-11-05T00:00:00Z"), "3": p("x"),
                                "4": p("")}), "2026-11-05T00:00:00Z")
        now = since({})
        self.assertRegex(now, gh_source.ISO_RE)
        self.assertLess(since({"1": p("2999-01-01T00:00:00Z")}), "2999", "не позже текущего момента")
        self.assertEqual(since({"1": p("x")})[:4], now[:4], "нет дат — сейчас, как до SE-120")


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
        env = clean_env(NERVE_STATE_DIR=d)
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
        env = clean_env(NERVE_STATE_DIR=d)
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
            self.assertEqual(to, [["boards"], ["backend", "release"], ["backend", "boards", "frontend", "plan", "release"]])
            out = self.nerve(d, "tap", "boards", "--once").stdout
            self.assertIn("роль 6: одна", out, "tap 6 и tap boards — один курсор")
            self.assertIn("пятерым", out)
            self.assertNotIn("двум", out)

    def test_second_session_has_its_own_cursor(self):
        """backend-2 (роль 7): emit «backend» до неё не доходит (нет двойной работы), «all» — доходит обеим."""
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            wj(os.path.join(d, "state.json"), {"heartbeat": datetime.now(timezone.utc).isoformat()})
            for role in ("backend", "backend-2"):
                self.assertEqual(self.nerve(d, "tap", role, "--once").stdout, "")  # курсоры — с конца журнала
            self.assertEqual(self.nerve(d, "emit", "backend", "только первой").returncode, 0)
            self.assertEqual(self.nerve(d, "emit", "7", "только второй").returncode, 0)
            self.assertEqual(self.nerve(d, "emit", "frontend-2,backend-2", "вторым").returncode, 0)
            self.assertEqual(self.nerve(d, "emit", "all", "всем").returncode, 0)
            self.assertEqual([sorted(r["to"]) for r in self.records(d)][1:3], [["backend-2"], ["backend-2", "frontend-2"]])
            first = self.nerve(d, "tap", "backend", "--once").stdout
            second = self.nerve(d, "tap", "backend-2", "--once").stdout
            self.assertIn("только первой", first)
            self.assertNotIn("только второй", first)
            self.assertNotIn("только первой", second)
            self.assertIn("только второй", second)
            self.assertIn("вторым", second)
            self.assertIn("всем", first)
            self.assertIn("всем", second)

    def test_emit_refuses_unknown_role(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            for target in ("tboards", "9", "backend-3", "backend,review", ","):
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
            for n in ("0", "9", "99"):
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

    def test_owner_answer_on_taibe_item_with_console_default_product(self):
        """SE-88: консоль даёт `d-taibe-…` поле `product: hr-helper` (id не начинается с `taibe-`) — ответ всё равно
        в журнал tAIBE, координатору HR — ничего."""
        self.taibe["queue"] = dict(CFG["queue"], match="-taibe-", source_roles=[["taibe-59", "coord"]])
        ctx = self.peered()
        items = [{"id": "d-taibe-se44-1311", "product": "hr-helper", "data": {"kind": "decision", "source": "taibe-59"}}]
        checks = [{"id": "d-taibe-se44-1311", "data": {"choice": "A", "at": "2026-11-13T20:08:00Z"}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else checks, {})):
            sources.poll_queue(ctx)
        self.assertEqual([(r["kind"], r["to"]) for r in self.records("taibe")], [("owner.answer", ["coord"])])
        self.assertEqual([r for r in self.records() if r["kind"] == "owner.answer"], [])

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
        """Мост: поле `product` документа с продуктом из peers важнее метки в id; входящее с продуктом — coord этого
        продукта и стоп только туда. Поле с продуктом по умолчанию метку `-taibe-` не перебивает (SE-88)."""
        self.taibe["queue"] = dict(CFG["queue"], match="-taibe-")
        ctx = self.peered()
        self.assertIs(ctx.for_item("s-set-control-b1-0711", "taibe"), ctx.peers["taibe"])
        self.assertIs(ctx.for_item("d-taibe-m1m2-0411", "hr-helper"), ctx.peers["taibe"])
        self.assertIs(ctx.for_item("d-465", "hr-helper"), ctx)
        self.assertIs(ctx.for_item("d-taibe-1", "gone"), ctx.peers["taibe"], "неизвестный продукт — по метке")
        items = [{"id": "i-2", "product": "taibe",
                  "data": {"kind": "inbox", "inbox": {"text": "стоп", "urgency": "now"}}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else [], {})):
            sources.poll_queue(ctx)
        self.assertEqual(sorted(r["kind"] for r in self.records("taibe")), ["owner.inbox", "owner.stop"])
        self.assertEqual(self.records(), [], "входящее tAIBE не будит coord HR")

    def test_queue_match_is_a_regex(self):
        """SE-109: `queue.match` — регулярное выражение. `m-taibe310-1411` (метка без дефиса после продукта) — tAIBE,
        а не координатору HR; HR-пункты и чужие слова с `taibe` внутри — продукту по умолчанию."""
        self.taibe["queue"] = dict(CFG["queue"], match=r"-taibe(-|\d|$)", source_roles=[["taibe-310", "release"]])
        ctx = self.peered()
        for item_id in ("m-taibe310-1411", "d-taibe-x", "s-restart-4-taibe-1211", "m-taibe-79", "s-restart-taibe"):
            self.assertIs(ctx.for_item(item_id, "hr-helper"), ctx.peers["taibe"], item_id)
        self.assertIs(ctx.for_item("taibe-m-93", "taibe"), ctx.peers["taibe"], "начало id — полем product")
        for item_id in ("d-hr-x-1411", "d-1", "m-465", "d-taibeta-1", "taibe-m-93"):
            self.assertIs(ctx.for_item(item_id, "hr-helper"), ctx, item_id)
        items = [{"id": "m-taibe310-1411", "product": "hr-helper", "data": {"kind": "merge", "source": "taibe-310"}}]
        checks = [{"id": "m-taibe310-1411", "data": {"done": True, "at": "2026-11-14T18:00:00Z"}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else checks, {})):
            sources.poll_queue(ctx)
        self.assertEqual([(r["kind"], r["to"]) for r in self.records("taibe")], [("owner.answer", ["release"])])
        self.assertEqual([r for r in self.records() if r["kind"] == "owner.answer"], [])

    def test_answer_in_another_journal_is_not_repeated(self):
        """SE-109, линза boards: ответ, уже записанный в журнал HR по старому правилу, после смены `queue.match` в
        журнал tAIBE не идёт; новый ответ на тот же пункт (другое `at`) — идёт."""
        self.taibe["queue"] = dict(CFG["queue"], match=r"-taibe(-|\d|$)", source_roles=[["taibe-310", "release"]])
        ctx = self.peered()
        old_at, new_at = "2026-11-14T13:41:36.560Z", "2026-11-14T19:00:00Z"
        ctx.journal.emit(f"oq:answer:m-taibe310-1411:{old_at}", "owner.answer", NERVOUS, ["coord"], "старое", "queue")
        items = [{"id": "m-taibe310-1411", "product": "hr-helper", "data": {"kind": "merge", "source": "taibe-310"}}]
        checks = [{"id": "m-taibe310-1411", "data": {"done": True, "at": old_at}}]
        poll = lambda: sources.poll_queue(ctx)  # noqa: E731
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else checks, {})):
            poll()
        self.assertEqual([r for r in self.records("taibe") if r["kind"] == "owner.answer"], [])
        self.assertEqual(len([r for r in self.records() if r["kind"] == "owner.answer"]), 1, "в HR — только старое")
        checks = [{"id": "m-taibe310-1411", "data": {"done": True, "at": new_at}}]
        with mock.patch.object(sources, "_oq_get", side_effect=lambda c, col: (items if col == "items" else checks, {})):
            poll()
        self.assertEqual([r["key"] for r in self.records("taibe") if r["kind"] == "owner.answer"],
                         [f"oq:answer:m-taibe310-1411:{new_at}"])

    def test_broken_queue_match_falls_back_to_substring(self):
        """SE-109: битое выражение (минуя проверку `products.py`) не роняет обход очереди — сравнение подстрокой."""
        self.taibe["queue"] = dict(CFG["queue"], match="-taibe[")
        ctx = self.peered()
        self.assertIs(ctx.for_item("d-taibe[-1"), ctx.peers["taibe"])
        self.assertIs(ctx.for_item("d-taibe-1"), ctx)

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
        numbered = {key: int(n) for key, n in re.findall(r"([\w-]+)\) echo (\d+)", body.group(1))}
        expected = {key: i for i, key in enumerate(CFG["team"]["roles"], 1)}
        self.assertEqual(numbered, expected)


if __name__ == "__main__":
    unittest.main()
