#!/usr/bin/env python3
"""team_plan.py (OPS-82, владелец 17.11): доли из ответа владельца (не меньше 2 на продукт, сумма 12; заметка «7-5»
важнее варианта), раскладка вперемешку по рангу роли, потолок 12 → 10 с запасом на возврат и уведомлением только
когда он мешает, повтор неподнявшейся роли с растущей паузой, без запусков при лимите Нерва, молчащем хабе и паузе
владельца, кэш долей проверяется как ответ. Очередь, spawn_session.sh, сессии и память подменены.

Run: python3 -I eval/tools/test_team_plan.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import team_plan as TP  # noqa: E402

ROLES = {"hr-helper": list(TP.ORDER), "taibe": list(TP.ORDER)}
TEAM = {**TP.DEFAULTS, "split": {"hr-helper": 6, "taibe": 6}}


class SplitTest(unittest.TestCase):
    def test_parse(self):
        slugs = ["hr-helper", "taibe"]
        self.assertEqual(TP.parse_split("8-4", slugs, 12, 2), {"hr-helper": 8, "taibe": 4})
        self.assertEqual(TP.parse_split([7, 5], slugs, 12, 2), {"hr-helper": 7, "taibe": 5})
        for bad in ("11-1", "6-5", "x-y", "6-6-0", None, [-5, 17], {"a": 1}):
            self.assertIsNone(TP.parse_split(bad, slugs, 12, 2), bad)

    def test_allocate_caps_by_roles_and_gives_rest_away(self):
        roles = {"a": ["coord", "release"], "b": list(TP.ORDER)}
        self.assertEqual(TP.allocate({"a": 6, "b": 6}, roles), {"a": 2, "b": 8})

    def test_plan_interleaves_by_rank(self):
        steps = TP.plan({"hr-helper": 3, "taibe": 2}, ROLES)
        self.assertEqual(steps, [("hr-helper", "coord"), ("taibe", "coord"), ("hr-helper", "release"),
                                 ("taibe", "release"), ("hr-helper", "backend")])

    def test_ceiling_hysteresis(self):
        self.assertEqual(TP.ceiling(15, 12, 20, TEAM), 10)
        self.assertEqual(TP.ceiling(22, 10, 20, TEAM), 10)   # ещё мало запаса — не поднимаем
        self.assertEqual(TP.ceiling(22, 12, 20, TEAM), 12)   # уже 12 — держим
        self.assertEqual(TP.ceiling(30, 10, 20, TEAM), 12)
        self.assertEqual(TP.ceiling(None, 12, 20, TEAM), 10)  # памяти не знаем — осторожно


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"TAIBE_TMUX_CONF_DIR": self.tmp.name})
        self.env.start()
        self.spawned, self.notes, self.log = [], [], []
        self.free, self.live, self.choice, self.note = 60, set(), None, ""
        self.limit, self.hub, self.failing, self.queue_down = None, True, set(), False

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_up(self, limit=None):
        def oq(path, root=None, method="GET", data=None):
            if self.queue_down:
                raise TP.subprocess.TimeoutExpired("secret", 20)
            if path.startswith("checks/"):
                return {"data": {"choice": self.choice, "note": self.note}} if self.choice or self.note else None
            self.notes.append((path, data))
            return {}

        def spawn(s, r, log):
            self.spawned.append((s, r))
            if (s, r) in self.failing:
                return False
            self.live.add((s, r))
            return True

        sysm = mock.Mock(mem_free=lambda: self.free)
        with mock.patch.object(TP, "config", lambda: (TEAM, 20, 10, 14, ROLES, {"hr-helper": "/h", "taibe": "/t"})), \
                mock.patch.object(TP.Q, "oq_request", oq), mock.patch.object(TP, "spawn", spawn), \
                mock.patch.object(TP, "live_set", lambda roots, log=None: (set(self.live), set())), \
                mock.patch.object(TP, "nerve_limit", lambda slugs: self.limit), \
                mock.patch.object(TP, "hub_up", lambda: self.hub), \
                mock.patch.object(TP.TS, "Sys", lambda: sysm), \
                mock.patch.object(TP.TS, "live_sessions", lambda sx: len(self.live)), \
                mock.patch.object(TP.time, "sleep", lambda s: None), \
                mock.patch.object(TP.subprocess, "run", lambda *a, **k: mock.Mock(returncode=0)):
            return TP.up(limit, self.log.append)

    def state(self):
        return json.loads((Path(self.tmp.name) / "team-state.json").read_text())


class UpTest(Base):
    def test_full_team_6_6(self):
        self.run_up()
        self.assertEqual(len(self.spawned), 12)
        self.assertEqual(sum(s == "taibe" for s, _ in self.spawned), 6)
        self.assertEqual(self.notes, [])

    def test_keeper_limit_per_run(self):
        self.run_up(limit=4)
        self.assertEqual(len(self.spawned), 4)

    def test_owner_split_from_queue_and_note(self):
        self.choice = "8-4"
        self.run_up()
        self.assertEqual(sum(s == "hr-helper" for s, _ in self.spawned), 8)
        self.live, self.spawned, self.note = set(), [], "давай 7-5 на эту неделю"
        self.run_up()
        self.assertEqual(sum(s == "hr-helper" for s, _ in self.spawned), 7)

    def test_queue_down_uses_validated_cache(self):
        self.choice = "4-8"
        self.run_up()
        self.live, self.spawned, self.queue_down = set(), [], True
        self.run_up()
        self.assertEqual(sum(s == "taibe" for s, _ in self.spawned), 8)
        (Path(self.tmp.name) / "team-split.json").write_text(json.dumps([-5, 17]))  # подделка — не принять
        self.live, self.spawned = set(), []
        self.run_up()
        self.assertEqual(sum(s == "taibe" for s, _ in self.spawned), 6)  # конфиг 6+6

    def test_live_roles_not_reopened(self):
        self.live = {("hr-helper", "coord"), ("taibe", "coord")}
        self.run_up()
        self.assertNotIn(("hr-helper", "coord"), self.spawned)
        self.assertEqual(len(self.live), 12)

    def test_low_memory_floor_notice_once_then_back(self):
        self.free = 15
        self.run_up()
        self.assertEqual(len(self.spawned), 10)
        self.assertEqual(len(self.notes), 1)
        self.assertIn("10 ролей вместо 12", self.notes[0][1]["data"]["title"])
        self.assertIn("taibe/boards", self.notes[0][1]["data"]["body"])
        self.run_up()  # всё ещё мало памяти — повторного уведомления нет
        self.assertEqual(len(self.notes), 1)
        self.free, self.spawned = 24, []
        self.run_up()  # 24% < 28% — запаса мало, не поднимаем
        self.assertEqual(self.spawned, [])
        self.free = 40
        self.run_up()
        self.assertEqual(len(self.spawned), 2)
        self.assertIn("снова 12", self.notes[-1][1]["data"]["title"])

    def test_low_memory_but_all_open_is_silent(self):
        self.run_up()
        self.free = 15
        self.run_up()
        self.assertEqual(self.notes, [])

    def test_failed_role_backs_off_and_notices_on_third(self):
        self.failing = {("taibe", "boards")}
        self.run_up()
        self.assertEqual(self.state()["roles"]["taibe/boards"]["fails"], 1)
        self.spawned = []
        self.run_up()
        self.assertNotIn(("taibe", "boards"), self.spawned)  # пауза ещё идёт
        for n in (2, 3):
            st = self.state()
            st["roles"]["taibe/boards"]["next"] = 0
            (Path(self.tmp.name) / "team-state.json").write_text(json.dumps(st))
            self.run_up()
            self.assertEqual(self.state()["roles"]["taibe/boards"]["fails"], n)
        self.assertEqual(sum("не поднимается" in d["data"]["title"] for _, d in self.notes), 1)

    def test_blockers_open_nothing(self):
        for setup, word in ((lambda: setattr(self, "limit", {"resume": "2099-01-01T19:00"}), "лимите"),
                            (lambda: setattr(self, "hub", False), "хаб MCP"),
                            (lambda: (Path(self.tmp.name) / "team-pause").write_text("x"), "пауза")):
            self.limit, self.hub = None, True
            (Path(self.tmp.name) / "team-pause").unlink(missing_ok=True)
            setup()
            self.spawned = []
            self.run_up()
            self.assertEqual(self.spawned, [], word)
            self.assertIn(word, self.log[-1])

    def test_critical_memory_opens_nothing(self):
        self.free = 5
        self.run_up()
        self.assertEqual(self.spawned, [])


class LimitTest(unittest.TestCase):
    def test_past_limit_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "products" / "taibe").mkdir(parents=True)
            (Path(d) / "state.json").write_text(json.dumps({"budget": {"limit": {"resume": "2020-01-01T00:00:00+03:00"}}}))
            (Path(d) / "products" / "taibe" / "state.json").write_text(
                json.dumps({"budget": {"limit": {"resume": "2099-01-01T00:00:00+03:00"}}}))
            with mock.patch.dict(os.environ, {"NERVE_STATE_DIR": d}):
                self.assertIsNone(TP.nerve_limit([]))
                self.assertIsNotNone(TP.nerve_limit(["taibe"]))


if __name__ == "__main__":
    unittest.main()
