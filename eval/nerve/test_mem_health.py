# -*- coding: utf-8 -*-
"""Тревога о сбое наблюдателя claude-mem (mem_health.py) на поддельном файле здоровья:
python3 -I -m unittest discover -s eval/nerve -p 'test_mem_health.py'"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mem_health  # noqa: E402
import nerve  # noqa: E402
from journal import DIGEST, NERVOUS, Journal, read_from  # noqa: E402

MSK = timezone(timedelta(hours=3))
T0 = datetime(2026, 11, 20, 21, 35, tzinfo=MSK)        # начало сбоя 20.11


def ms(t):
    return int(t.timestamp() * 1000)


class Ctx:
    """Продукт по умолчанию: тревога идёт только через emit_account (раздача продуктам — test_nerve)."""

    def __init__(self, d):
        self.tz = MSK
        self.now = T0
        self.state = {}
        self.journal = Journal(os.path.join(d, "journal.jsonl"))

    def emit_account(self, key, kind, cls, to, text, src=""):
        return self.journal.emit(key, kind, cls, to, text, src)

    def emit(self, *a, **k):
        raise AssertionError("событие аккаунта идёт через emit_account")


class MemHealthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.file = os.path.join(self.d, "observer-health.json")
        env = mock.patch.dict(os.environ, {mem_health.ENV: self.file})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self.tmp.cleanup)
        self.ctx = Ctx(self.d)

    def health(self, **kw):
        data = {"consecutiveFailures": 0, "failingSinceAt": None, "lastSuccessAt": ms(T0 - timedelta(minutes=5)),
                "lastErrorKind": None, "lastErrorMessage": "Bearer sk-ant-SECRET-TOKEN", "lastErrorUrl":
                "https://api.example/v1?key=SECRET", "lastErrorRequestId": "req_SECRET"}
        data.update(kw)
        with open(self.file, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def failing(self, n=3, since=T0, kind="auth_invalid"):
        self.health(consecutiveFailures=n, failingSinceAt=ms(since), lastErrorKind=kind)

    def at(self, minutes):
        self.ctx.now = (T0 + timedelta(minutes=minutes)).astimezone(timezone.utc)
        mem_health.poll_mem_health(self.ctx)

    def events(self):
        return read_from(self.ctx.journal.path, 0)[0]

    def test_fail_61_min_one_alert(self):
        """Приёмка: сбой 61 мин — одна тревога координатору; следующие проходы второй не пишут."""
        self.failing()
        for m in (10, 44, 61, 62, 120, 24 * 60):
            self.at(m)
        ev = self.events()
        self.assertEqual(len(ev), 1)
        e = ev[0]
        self.assertEqual((e["kind"], e["class"], e["to"], e["src"]), ("sys.mem", NERVOUS, ["coord"], "system"))
        self.assertEqual(e["key"], "mem:down:2026-11-20T18:35:00+00:00")
        self.assertIn("с 20.11 21:35", e["text"])
        self.assertIn("auth_invalid", e["text"])
        self.assertIn("3 сбоев подряд", e["text"])

    def test_short_failure_no_alert(self):
        self.failing()
        for m in (1, 30, 44):
            self.at(m)
        self.health()                                     # прошло само: успех, 0 сбоев
        self.at(50)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.ctx.state["mem_health"], {})

    def test_threshold_is_45_min(self):
        self.failing()
        self.at(44)
        self.assertEqual(self.events(), [])
        self.at(45)
        self.assertEqual(len(self.events()), 1)

    def test_recovery_one_line(self):
        """Приёмка: восстановление — одна строка (дайджест), повторный проход её не повторяет."""
        self.failing()
        self.at(61)
        self.health(lastSuccessAt=ms(T0 + timedelta(minutes=70)))
        for m in (71, 72, 300):
            self.at(m)
        ev = self.events()
        self.assertEqual([e["key"] for e in ev], ["mem:down:2026-11-20T18:35:00+00:00",
                                                  "mem:up:2026-11-20T18:35:00+00:00"])
        up = ev[1]
        self.assertEqual((up["kind"], up["class"], up["to"]), ("sys.mem", DIGEST, ["coord"]))
        self.assertIn("снова пишет память (сбой с 20.11 21:35)", up["text"])
        self.assertNotIn("down", self.ctx.state["mem_health"])

    def test_recovery_by_success_after_start(self):
        """Счётчик ещё не сброшен, но успех позже начала сбоя — сбой закрыт."""
        self.failing()
        self.at(61)
        self.health(consecutiveFailures=1, failingSinceAt=ms(T0), lastSuccessAt=ms(T0 + timedelta(minutes=65)))
        self.at(66)
        self.assertEqual([e["kind"] for e in self.events()], ["sys.mem", "sys.mem"])
        self.assertEqual(self.events()[1]["class"], DIGEST)

    def test_success_after_start_no_alert(self):
        """Счётчик > 0, а успех новее failingSinceAt (файл не дописан) — не сбой."""
        self.health(consecutiveFailures=2, failingSinceAt=ms(T0), lastSuccessAt=ms(T0 + timedelta(minutes=50)))
        self.at(61)
        self.assertEqual(self.events(), [])

    def test_rewritten_start_same_outage(self):
        """Наблюдатель переписал failingSinceAt без успеха — тот же сбой, второй тревоги нет."""
        self.failing()
        self.at(61)
        self.failing(n=9, since=T0 + timedelta(minutes=90))
        for m in (140, 200):
            self.at(m)
        self.assertEqual(len(self.events()), 1)

    def test_new_outage_after_recovery_alerts_again(self):
        self.failing()
        self.at(61)
        self.health(lastSuccessAt=ms(T0 + timedelta(minutes=70)))
        self.at(71)
        self.failing(since=T0 + timedelta(minutes=100))
        self.at(130)
        self.at(146)
        self.assertEqual([e["key"].split(":")[1] for e in self.events()], ["down", "up", "down"])

    def test_restart_keeps_one_alert(self):
        """Перезапуск демона: состояние из state.json, журнал тот же — ни второй тревоги, ни лишней строки."""
        self.failing()
        self.at(61)
        saved = json.loads(json.dumps(self.ctx.state))
        self.ctx = Ctx(self.d)
        self.ctx.state = saved
        self.at(90)
        self.assertEqual(len(self.events()), 1)

    def test_reads_only_four_keys(self):
        """Текст ошибки, URL и id запроса из файла в журнал не идут; странный lastErrorKind — «?»."""
        self.failing(kind="auth invalid: Bearer sk-ant-SECRET")
        self.at(61)
        text = json.dumps(self.events(), ensure_ascii=False)
        self.assertNotIn("SECRET", text)
        self.assertIn("?)", self.events()[0]["text"])
        self.assertEqual(sorted(mem_health.read(self.file)), sorted(mem_health.KEYS))

    def test_no_file_or_bad_json_writes_nothing(self):
        self.at(61)
        with open(self.file, "w") as f:
            f.write("{не json")
        self.at(62)
        with open(self.file, "w") as f:
            f.write("[1, 2]")
        self.at(63)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.ctx.state, {})

    def test_bad_file_keeps_open_outage(self):
        """Файл пропал посреди сбоя — сбой не закрыт; вернулся с успехом — одна строка восстановления."""
        self.failing()
        self.at(61)
        os.remove(self.file)
        self.at(70)
        self.assertEqual(len(self.events()), 1)
        self.health(lastSuccessAt=ms(T0 + timedelta(minutes=75)))
        self.at(76)
        self.assertEqual(len(self.events()), 2)

    def test_no_start_time_counts_from_first_sight(self):
        self.health(consecutiveFailures=2, failingSinceAt=None, lastSuccessAt=ms(T0 - timedelta(days=1)))
        self.at(0)
        self.at(44)
        self.assertEqual(self.events(), [], "старый lastSuccessAt не начало сбоя")
        self.at(46)
        self.assertEqual(len(self.events()), 1)

    def test_no_start_time_success_between_passes_counts_again(self):
        """SE-199: без failingSinceAt успех между проходами и новый сбой — отсчёт с прохода, что это увидел."""
        self.health(consecutiveFailures=2, failingSinceAt=None, lastSuccessAt=ms(T0 - timedelta(days=1)))
        self.at(0)                                        # отсчёт с T0
        self.health(consecutiveFailures=1, failingSinceAt=None, lastSuccessAt=ms(T0 + timedelta(minutes=10)))
        self.at(20)                                       # успех после T0, снова сбой: отсчёт заново с 20-й минуты
        self.at(64)
        self.assertEqual(self.events(), [], "45 мин от нового отсчёта ещё не прошли")
        self.at(65)
        ev = self.events()
        self.assertEqual([e["key"] for e in ev], ["mem:down:2026-11-20T18:55:00+00:00"])
        self.assertIn("с 20.11 21:55", ev[0]["text"])

    def test_iso_and_seconds_timestamps(self):
        self.assertEqual(mem_health.when("2026-11-20T18:35:00Z"), T0)
        self.assertEqual(mem_health.when("2026-11-20T18:35:00"), T0)
        self.assertEqual(mem_health.when(T0.timestamp()), T0)
        self.assertEqual(mem_health.when(ms(T0)), T0)
        for bad in (None, True, "", "вчера", float("inf"), float("nan"), [1], 1e300):
            self.assertIsNone(mem_health.when(bad), bad)

    def test_bad_counts_ignored(self):
        for n in (None, "3", True, -1, 1.5):
            self.health(consecutiveFailures=n, failingSinceAt=ms(T0))
            self.at(61)
        self.assertEqual(self.events(), [])

    def test_live_shape_no_events(self):
        """Файл как на Mac 23.11 22:11 после восстановления: 0 сбоев, старый lastErrorKind — тишина."""
        self.health(consecutiveFailures=0, failingSinceAt=None, lastSuccessAt=1795461100079,
                    lastErrorKind="auth_invalid")
        self.at(61)
        self.assertEqual(self.events(), [])

    def test_registered_in_pass(self):
        self.assertIn(("mem", mem_health.poll_mem_health), nerve.POLLS)


if __name__ == "__main__":
    unittest.main()
