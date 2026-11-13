# -*- coding: utf-8 -*-
"""SE-66: доля окна 5 ч по продуктам — отнесение записей транскрипта, накладные эволюции, доли и строка статуса."""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import actions  # noqa: E402
import budget  # noqa: E402

MSK = timezone(timedelta(hours=3))
ROOTS = {"hr-helper": "/U/a/HR_Helper-v2", "taibe": "/U/a/tAIBE"}
MILLION_IN = {"input_tokens": 1_000_000, "output_tokens": 0}   # $4 по цене opus-5-5


def line(rid, ts, cwd=None):
    o = {"type": "assistant", "timestamp": ts.isoformat(), "requestId": rid,
         "message": {"model": "claude-opus-5-5", "usage": MILLION_IN, "content": []}}
    if cwd:
        o["cwd"] = cwd
    return json.dumps(o)


def write(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write("".join(x + "\n" for x in lines))


def at(path, dt):
    """mtime файла — dt: тест не зависит от часа, в который запущен."""
    os.utime(path, (dt.timestamp(), dt.timestamp()))


class ProductsTest(unittest.TestCase):
    def setUp(self):
        self.p = budget.Products(ROOTS)

    def test_cwd_under_a_root_on_a_path_boundary(self):
        cases = {"/U/a/tAIBE": "taibe", "/U/a/tAIBE/worktrees/feature/se66": "taibe",
                 "/U/a/HR_Helper-v2/.claude/worktrees/wf-1": "hr-helper", "/U/a/tAIBE-old": None,
                 "/private/tmp/claude-501/x/scratchpad": None, "": None, None: None}
        for cwd, want in cases.items():
            self.assertEqual(self.p.of_cwd(cwd), want, cwd)

    def test_the_longest_root_wins(self):
        p = budget.Products({"outer": "/U/a/p", "inner": "/U/a/p/sub"})
        self.assertEqual(p.of_cwd("/U/a/p/sub/x"), "inner")
        self.assertEqual(p.of_cwd("/U/a/p/x"), "outer")

    def test_project_folder_name(self):
        cases = {"-U-a-tAIBE": "taibe", "-U-a-tAIBE-worktrees-fix-se74": "taibe", "-U-a-HR-Helper-v2": "hr-helper",
                 "-U-a-tAIBEx": None, "-private-tmp": None,
                 "-private-tmp-claude-501--U-a-HR-Helper-v2-0cd5-scratchpad": None}
        for name, want in cases.items():
            self.assertEqual(self.p.of_project(name), want, name)

    def test_cwd_first_then_folder_then_unattributed(self):
        self.assertEqual(self.p.of("/U/a/HR_Helper-v2", "-U-a-tAIBE"), "hr-helper")
        self.assertEqual(self.p.of("/private/tmp/x", "-U-a-tAIBE"), "taibe")
        self.assertEqual(self.p.of("/private/tmp/x", "-private-tmp"), budget.UNATTRIBUTED)


class MeterProductsTest(unittest.TestCase):
    def test_attribution_and_the_5h_window(self):
        now = datetime(2026, 11, 14, 1, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as d:
            st = {}
            m = budget.Meter(st, products=budget.Products(ROOTS))
            m.update(d, now - timedelta(minutes=1))     # первый проход: отсюда копятся корзины продуктов
            t = now - timedelta(minutes=30)
            write(os.path.join(d, "-U-a-tAIBE", "s.jsonl"), [
                line("r1", t, "/U/a/tAIBE/worktrees/feature/se66"),     # worktree
                line("r2", t, "/private/tmp/claude-501/x/scratchpad"),  # смена cwd: продукт по папке сессии
                line("r3", t, "/U/a/HR_Helper-v2"),                     # cd в чужой репо: тому репо
                line("r4", now - timedelta(hours=6), "/U/a/tAIBE")])    # вне окна 5 ч: только в общий счёт
            write(os.path.join(d, "-U-a-tAIBE", "sess", "subagents", "a.jsonl"), [line("r5", t)])  # без cwd
            write(os.path.join(d, "-private-tmp", "t.jsonl"), [line("r6", t, "/private/tmp")])
            m.update(d, now)
            m.update(d, now)                                            # повторный проход без дублей
            self.assertEqual(m.by_product(now - timedelta(hours=5), now),
                             {"taibe": 12.0, "hr-helper": 4.0, budget.UNATTRIBUTED: 4.0})
            self.assertAlmostEqual(m.total(now - timedelta(hours=7), now), 24.0)
            self.assertEqual(st["products_from"], "2026-11-14T00:59+00:00")
            m.update(d, now + timedelta(hours=6))
            self.assertEqual(st["products"], {}, "корзины старше 5 ч удаляются")

    def test_no_products_no_buckets(self):
        with tempfile.TemporaryDirectory() as d:
            st = {}
            budget.Meter(st).update(d, datetime.now(timezone.utc))
            self.assertNotIn("products", st)

    def test_state_stays_small(self):
        """5 ч 5 мин по 5 мин — не больше 62 ключей, сколько бы записей ни было (state.json не раздувать)."""
        now = datetime(2026, 11, 14, 1, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as d:
            st = {}
            m = budget.Meter(st, products=budget.Products(ROOTS))
            m.update(d, now - timedelta(hours=6))
            write(os.path.join(d, "-U-a-tAIBE", "s.jsonl"),
                  [line(f"r{i}", now - timedelta(minutes=i), "/U/a/tAIBE") for i in range(0, 330)])
            m.update(d, now)
            self.assertLessEqual(len(st["products"]), 62)
            self.assertLess(len(json.dumps(st["products"])), 4000)


class OverheadTest(unittest.TestCase):
    def test_evolve_runs_and_session(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "runs", "2026-11-14.json"), [json.dumps(
                {"finished": "2026-11-14T05:01:41+03:00", "budget": {"calls": 3, "tokens": 1_000_000}})])
            write(os.path.join(d, "runs", "session-latest.json"), [json.dumps(
                {"exit": 0, "usd": 1.5, "finished": "2026-11-14T02:05:00+00:00"})])
            win = (datetime(2026, 11, 14, 4, 0, tzinfo=MSK), datetime(2026, 11, 14, 8, 0, tzinfo=MSK))
            usd, unknown = budget.evolve_overhead(d, *win)
            self.assertAlmostEqual(usd, 2.0 + 1.5)
            self.assertEqual(unknown, [])
            later = (datetime(2026, 11, 14, 6, 0, tzinfo=MSK), datetime(2026, 11, 14, 9, 0, tzinfo=MSK))
            self.assertEqual(budget.evolve_overhead(d, *later), (0.0, []))

    def test_a_run_started_the_day_before_counts_when_it_ends_in_the_window(self):
        """Цепочка ревью на 97950da5c: файл назван днём старта; прогон 13.11 23:50 → 14.11 00:40 — в окне 14.11."""
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "runs", "2026-11-13.json"), [json.dumps(
                {"finished": "2026-11-14T00:40:00+03:00", "budget": {"tokens": 1_000_000}})])
            win = (datetime(2026, 11, 14, 0, 30, tzinfo=MSK), datetime(2026, 11, 14, 5, 30, tzinfo=MSK))
            self.assertAlmostEqual(budget.evolve_overhead(d, *win)[0], 2.0)

    def test_missing_or_broken_files_are_zero(self):
        with tempfile.TemporaryDirectory() as d:
            win = (datetime(2026, 11, 14, 4, 0, tzinfo=MSK), datetime(2026, 11, 14, 8, 0, tzinfo=MSK))
            self.assertEqual(budget.evolve_overhead(d, *win), (0.0, []))
            write(os.path.join(d, "runs", "2026-11-14.json"), ["{not json"])
            write(os.path.join(d, "runs", "session-latest.json"), [json.dumps({"exit": 0, "comment": "x"})])
            at(os.path.join(d, "runs", "session-latest.json"), datetime(2026, 11, 13, 5, 3, tzinfo=MSK))  # mtime вне окна
            self.assertEqual(budget.evolve_overhead(d, *win), (0.0, []))
            # Цепочка ревью: вложенный budget не словарь, finished не строка или без пояса — ноль, а не исключение.
            for bad in ({"finished": "2026-11-14T05:00:00+03:00", "budget": [1]},
                        {"finished": "2026-11-14T05:00:00+03:00", "budget": {"tokens": "много"}},
                        {"finished": 1763085600, "budget": {"tokens": 5}},
                        {"finished": "2026-11-14T05:00:00", "budget": {"tokens": 5}}):
                write(os.path.join(d, "runs", "2026-11-14.json"), [json.dumps(bad)])
                self.assertEqual(budget.evolve_overhead(d, *win), (0.0, []), bad)

    def test_a_session_without_usd_is_named_not_zero(self):
        """Цепочка ревью: CLI не дал total_cost_usd — «без $: сессия» в строке статуса, а не честный ноль."""
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "runs", "session-latest.json"), [json.dumps(
                {"exit": 1, "usd": None, "finished": "2026-11-14T02:05:00+00:00"})])
            win = (datetime(2026, 11, 14, 4, 0, tzinfo=MSK), datetime(2026, 11, 14, 8, 0, tzinfo=MSK))
            self.assertEqual(budget.evolve_overhead(d, *win), (0.0, ["сессия"]))
            mode = {"share5": 0.5, "share5_by": {"taibe": 0.5}, "overhead_unknown": ["сессия"]}
            self.assertTrue(budget.shares_text(mode).endswith("накладные — сверх share5, без $: сессия"))

    def test_a_session_file_without_finished_is_timed_by_mtime(self):
        """SE-81: файл до SE-66 (без finished и usd) или битый — сессия по mtime: в окне — «без $», вне — ничего."""
        win = (datetime(2026, 11, 14, 4, 0, tzinfo=MSK), datetime(2026, 11, 14, 8, 0, tzinfo=MSK))
        for text in (json.dumps({"exit": 0, "comment": "posted to SE-49"}), "{not json",
                     json.dumps({"exit": 0, "usd": 0.7, "finished": "2026-11-14T05:03:05"})):  # без пояса
            with self.subTest(text=text), tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "runs", "session-latest.json")
                write(path, [text])
                at(path, datetime(2026, 11, 14, 5, 3, 5, tzinfo=MSK))
                usd, unknown = budget.evolve_overhead(d, *win)
                self.assertEqual(unknown, [] if "0.7" in text else ["сессия"])
                self.assertAlmostEqual(usd, 0.7 if "0.7" in text else 0.0)
                at(path, datetime(2026, 11, 13, 5, 3, 5, tzinfo=MSK))
                self.assertEqual(budget.evolve_overhead(d, *win), (0.0, []))


class SharesTest(unittest.TestCase):
    def test_products_split_share5_and_overhead_is_on_top(self):
        by = {"taibe": 3.0, "hr-helper": 1.0, budget.UNATTRIBUTED: 2.0}
        self.assertEqual(budget.shares(0.6, by, 1.0, 10.0),
                         {"hr-helper": 0.1, "taibe": 0.3, budget.UNATTRIBUTED: 0.2, budget.OVERHEAD: 0.1})
        self.assertEqual(budget.shares(None, by, 1.0, 10.0), {budget.OVERHEAD: 0.1})
        self.assertEqual(budget.shares(0.6, {}, 0.0, 10.0), {})

    def test_status_line(self):
        mode = {"share5": 0.6, "share5_by": {"hr-helper": 0.1, "taibe": 0.3, budget.UNATTRIBUTED: 0.2,
                                             budget.OVERHEAD: 0.1}}
        self.assertEqual(budget.shares_text(mode), "share5 0.60: taibe 0.30 · hr-helper 0.10 · не отнесено 0.20 · "
                                                   "накладные 0.10; накладные — сверх share5")
        mode.update(products_from="2026-11-14T03:59+03:00", products_partial=True)
        self.assertIn("(продукты — с 03:59)", budget.shares_text(mode))
        self.assertEqual(budget.shares_text({}), "share5 по продуктам: нет данных")

    def test_mode_fields(self):
        now_l = datetime(2026, 11, 14, 8, 0, tzinfo=MSK)
        ws = now_l - timedelta(hours=5)
        with tempfile.TemporaryDirectory() as d:
            st = {"products_from": "2026-11-14T01:00+00:00",
                  "products": {"2026-11-14T02:00": {"taibe": 2.0}, "2026-11-14T04:30": {"hr-helper": 2.0}}}
            m = budget.Meter(st, products=budget.Products(ROOTS))
            out = actions.product_shares(m, st, 0.5, 20.0, ws, now_l, evolve_dir=d)
        self.assertEqual(out, {"share5_by": {"hr-helper": 0.25, "taibe": 0.25},
                               "products_from": "2026-11-14T04:00+03:00", "products_partial": True})

    def test_a_failure_in_shares_does_not_stop_the_mode(self):
        """Цепочка ревью: сбой измерения — причина в mode.json, poll_budget доходит до write_mode."""
        now_l = datetime(2026, 11, 14, 8, 0, tzinfo=MSK)
        broken = mock.Mock()
        broken.by_product.side_effect = AttributeError("'list' object has no attribute 'get'")
        out = actions.product_shares(broken, {}, 0.5, 20.0, now_l - timedelta(hours=5), now_l, evolve_dir="/nonexistent")
        self.assertEqual(out, {"share5_by_error": "AttributeError: 'list' object has no attribute 'get'"})
        self.assertEqual(budget.shares_text(out),
                         "share5 по продуктам: нет данных (сбой: AttributeError: 'list' object has no attribute 'get')")


if __name__ == "__main__":
    unittest.main()
