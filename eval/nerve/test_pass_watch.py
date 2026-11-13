# -*- coding: utf-8 -*-
"""SE-70: пульс прохода, длительности источников, nerve.slow, тревога о застрявшем проходе, перезапуск после правки
кода. Запуск: python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from argparse import Namespace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import nerve  # noqa: E402
import pass_watch  # noqa: E402
import state_io  # noqa: E402
from heartbeat import running_pass  # noqa: E402
from journal import read_from  # noqa: E402

with open(os.path.join(HERE, "config.json"), encoding="utf-8") as _f:
    CFG = json.load(_f)
PERIOD = CFG["interval_seconds"]


def wj(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")


class Clock:
    """time.monotonic под тестом: источник «спит», сдвигая часы, а не настоящим sleep."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class PassTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        open(os.path.join(self.d, "journal.jsonl"), "w").close()
        self.clock = Clock()
        self.pulses = {}
        self.patches = [mock.patch.object(nerve, "STATE_DIR", self.d),
                        mock.patch.object(time, "monotonic", self.clock)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def source(self, name, seconds):
        def fn(ctx):
            self.pulses[name] = state_io.read_pulse(self.d)
            self.clock.t += seconds
        return name, fn

    def run_pass(self, **seconds):
        ctx = nerve.Ctx(CFG, self.d)
        with mock.patch.object(nerve, "POLLS", [self.source(n, s) for n, s in seconds.items()]):
            nerve.one_pass(ctx)
        return ctx

    def slow_events(self):
        recs, _ = read_from(os.path.join(self.d, "journal.jsonl"), 0)
        return [r for r in recs if r["kind"] == "nerve.slow"]

    def test_slow_source_emits_nerve_slow_with_its_name(self):
        ctx = self.run_pass(github=1, queue=3 * PERIOD, system=0.5, budget=2)
        ev = self.slow_events()
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["to"], ["release"])
        self.assertIn(f"дольше всех queue — {3 * PERIOD} с", ev[0]["text"])
        d = ctx.state["durations"]
        self.assertEqual(d["sources"], {"github": 1, "queue": 3 * PERIOD, "system": 0.5, "budget": 2})
        self.assertEqual(d["pass"], 1 + 3 * PERIOD + 0.5 + 2)
        saved = state_io.load_json(os.path.join(self.d, "state.json"), {})
        self.assertEqual(saved["durations"], d, "длительности — в state.json той же записью, что пульс")

    def test_fast_pass_is_quiet(self):
        self.run_pass(github=1, queue=2, system=0.5, budget=2)
        self.assertEqual(self.slow_events(), [])

    def test_slow_pass_once_an_hour(self):
        self.run_pass(queue=3 * PERIOD)
        self.run_pass(budget=3 * PERIOD)
        self.assertEqual(len(self.slow_events()), 1, "каждый медленный проход не будит release")

    def test_slow_pass_hour_counts_from_last_digest_not_calendar(self):
        path = os.path.join(self.d, "state.json")
        for minutes, expect in ((59, 0), (61, 1)):   # 10:59 → 11:01 — граница часа, но прошло 2 мин
            st = state_io.load_json(path, {})
            st["slow_at"] = ago(minutes)
            wj(path, st)
            before = len(self.slow_events())
            self.run_pass(queue=3 * PERIOD)
            self.assertEqual(len(self.slow_events()) - before, expect, f"прошлый дайджест {minutes} мин назад")

    def test_pulse_write_failure_does_not_stop_the_pass(self):
        real = state_io.save_json

        def save(path, data):
            if path.endswith("pulse"):
                raise OSError("диск полон")
            return real(path, data)

        with mock.patch.object(state_io, "save_json", save):
            ctx = self.run_pass(github=1, queue=2)
        self.assertEqual(ctx.state["durations"]["sources"], {"github": 1, "queue": 2})

    def test_pulse_names_the_running_source(self):
        ctx = self.run_pass(github=1, queue=1)
        self.assertEqual(self.pulses["queue"]["source"], "queue")
        self.assertEqual(self.pulses["queue"]["pass"], ctx.pass_started)
        self.assertIsNone(running_pass(state_io.read_pulse(self.d), state_io.read_heartbeat(self.d)),
                          "после прохода пульс новее — проход не идёт")

    def test_peer_durations_join_only_from_this_pass(self):
        ctx = nerve.Ctx(CFG, self.d)
        fresh = SimpleNamespace(pass_started="P", state={"durations": {"at": "P", "sources": {"github@taibe": 9}}})
        stale = SimpleNamespace(pass_started="P", state={"durations": {"at": "old", "sources": {"github@x": 99}}})
        ctx.state["durations"] = {"at": ctx.pass_started, "sources": {"github": 1}}
        pass_watch.close_pass(ctx, {"taibe": fresh, "x": stale})
        self.assertEqual(ctx.state["durations"]["sources"], {"github": 1, "github@taibe": 9})


class RestartTest(unittest.TestCase):
    def test_code_changed_after_start(self):
        with tempfile.TemporaryDirectory() as d:
            now = time.time()
            for name, age in (("products.py", 10), ("old.py", 500), ("test_x.py", 10), ("notes.txt", 10),
                              ("future.py", -3600), ("same.py", 100)):
                p = os.path.join(d, name)
                open(p, "w").close()
                os.utime(p, (now - age, now - age))
            self.assertEqual(pass_watch.code_changed(now - 100, d, now), ["products.py"],
                             "тесты, не-py, mtime в будущем и mtime ровно в секунду старта — не повод для перезапуска")

    def test_run_exits_nonzero_when_products_py_is_newer_than_start(self):
        started = os.stat(os.path.join(HERE, "products.py")).st_mtime - 1
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "journal.jsonl"), "w").close()
            with mock.patch.object(nerve, "STATE_DIR", d), mock.patch.object(nerve, "STARTED", started), \
                    mock.patch.object(nerve, "one_pass"), mock.patch.object(nerve, "run_products"), \
                    mock.patch.object(nerve, "Ctx") as ctx, mock.patch.object(nerve, "wakes_on", return_value=False), \
                    mock.patch.object(nerve.time, "sleep", side_effect=AssertionError("уснул вместо выхода")), \
                    mock.patch("sys.stderr"):
                ctx.return_value.now, ctx.return_value.tz = datetime.now(timezone.utc), timezone.utc
                rc = nerve.cmd_run(CFG, Namespace(interval=60))
        self.assertNotEqual(rc, 0, "launchd поднимает демон только после выхода с кодом ≠ 0")
        kinds = [c.args[1] for c in ctx.return_value.emit.call_args_list]
        self.assertEqual(kinds, ["nerve.restart"])


class TapTest(unittest.TestCase):
    def run_tap(self, d, role="coord"):
        env = dict(os.environ, NERVE_STATE_DIR=d)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "nerve.py"), "tap", role, "--once"],
                           capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 0, f"тап упал: {r.stderr[-600:]}")   # пустой stdout упавшего тапа — не «тишина»
        return r.stdout

    def state(self, d, hb_min, pulse=None):
        open(os.path.join(d, "journal.jsonl"), "a").close()
        wj(os.path.join(d, "state.json"), {"heartbeat": ago(hb_min)})
        wj(os.path.join(d, "mode.json"), {"phase": "day"})
        if pulse:
            source, pass_min = pulse
            wj(os.path.join(d, "pulse"), {"pass": ago(pass_min), "source": source, "at": ago(pass_min)})

    def test_long_pass_is_not_silence(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 7, ("budget", 6))
            self.assertEqual(self.run_tap(d), "", "проход 6 мин (13.11) — не «НЕРВ МОЛЧИТ» и не перезапуск")

    def test_stuck_pass_names_the_source(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 17, ("budget", 16))
            out = self.run_tap(d)
            self.assertIn("НЕРВ ЗАСТРЯЛ", out)
            self.assertIn("источник budget", out)
            self.assertEqual(self.run_tap(d), "", "одна строка на эпизод")

    def test_pulse_of_a_finished_pass_keeps_old_alarm(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 7, ("budget", 8))
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d), "пульс прошлого прохода старше пульса — демон спит или умер")

    def test_broken_pulse_file_keeps_old_alarm(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 7)
            with open(os.path.join(d, "pulse"), "w") as f:
                f.write("[1")
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d))

    def test_no_pulse_file_old_daemon(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 2)
            self.assertEqual(self.run_tap(d), "", "демон старше SE-70, пульс свежий — тихо")
            self.state(d, 7)
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d), "демон старше SE-70, пульс старый — прежняя тревога")

    def test_stuck_then_dead_prints_again(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 17, ("budget", 16))
            self.assertIn("НЕРВ ЗАСТРЯЛ", self.run_tap(d))
            os.remove(os.path.join(d, "pulse"))
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d), "застрял → молчит: другая тревога — новая строка")
            self.assertEqual(self.run_tap(d), "")

    def test_pulse_in_future_falls_back_to_heartbeat(self):
        with tempfile.TemporaryDirectory() as d:
            self.state(d, 7, ("budget", -120))   # часы отвели на 2 ч назад посреди прохода
            self.assertIn("НЕРВ МОЛЧИТ", self.run_tap(d))


class StuckTest(unittest.TestCase):
    def test_mac_asleep_mid_pass_is_not_stuck(self):
        from heartbeat import pass_stuck
        now = datetime.now(timezone.utc)
        hb = (now - timedelta(minutes=62)).isoformat(timespec="seconds")
        cycle = {"seconds": PERIOD, "at": hb, "awake": 5000.0}
        run = ((now - timedelta(minutes=61)).isoformat(timespec="seconds"), "budget")
        day = {"phase": "day"}
        self.assertEqual(pass_stuck(CFG, day, cycle, hb, run, now, 5000.0 + 200), 0,
                         "61 мин по стене, 200 с бодрствования — Mac спал посреди прохода")
        self.assertEqual(pass_stuck(CFG, day, cycle, hb, run, now, 5000.0 + 1000), 61)
        self.assertEqual(pass_stuck(CFG, day, None, hb, run, now, 0.0), 61, "без cycle.json — стенные часы")


class StatusTest(unittest.TestCase):
    def test_status_lines_show_durations_and_running_pass(self):
        with tempfile.TemporaryDirectory() as d:
            st = {"heartbeat": ago(3), "durations": {"at": "2026-11-13T17:32:00+00:00", "pass": 361.2,
                                                     "sources": {"github": 2.1, "budget": 355.0}}}
            wj(os.path.join(d, "pulse"), {"pass": ago(1), "source": "queue", "at": ago(1)})
            lines = pass_watch.pass_lines(st, d)
        self.assertEqual(lines[0], "проход 17:32 UTC: 361.2 с; по источникам, с: github 2.1, budget 355.0")
        self.assertTrue(lines[1].startswith("идёт проход с "), lines)
        self.assertTrue(lines[1].endswith("источник queue"), lines)

    def test_status_without_durations(self):
        self.assertEqual(pass_watch.pass_lines({}, tempfile.gettempdir() + "/нет-такой-папки"), [])


if __name__ == "__main__":
    unittest.main()
