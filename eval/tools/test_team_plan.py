#!/usr/bin/env python3
"""team_plan.py (OPS-82, владелец 17.11): доли из ответа владельца (не меньше 2 на продукт, сумма 12), раскладка
вперемешку по рангу роли, потолок 12 → 10 при нехватке памяти с уведомлением (Mac и очередь) и обратно, без
запусков при лимите Нерва, живые роли не открываются заново. Очередь, spawn_session.sh и память подменены.

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
        for bad in ("11-1", "6-5", "x-y", "6-6-0", None):
            self.assertIsNone(TP.parse_split(bad, slugs, 12, 2), bad)

    def test_allocate_caps_by_roles_and_gives_rest_away(self):
        roles = {"a": ["coord", "release"], "b": list(TP.ORDER)}
        self.assertEqual(TP.allocate({"a": 6, "b": 6}, roles), {"a": 2, "b": 8})

    def test_plan_interleaves_by_rank(self):
        steps = TP.plan({"hr-helper": 3, "taibe": 2}, ROLES)
        self.assertEqual(steps, [("hr-helper", "coord"), ("taibe", "coord"), ("hr-helper", "release"),
                                 ("taibe", "release"), ("hr-helper", "backend")])


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"TAIBE_TMUX_CONF_DIR": self.tmp.name})
        self.env.start()
        self.spawned, self.notes, self.log = [], [], []
        self.free, self.live, self.choice, self.limit, self.note = 60, set(), None, None, ""

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_up(self):
        def oq(path, root=None, method="GET", data=None):
            if path.startswith("checks/"):
                return {"data": {"choice": self.choice, "note": self.note}} if self.choice or self.note else None
            self.notes.append((path, data))
            return {}

        def spawn(s, r, log):
            self.spawned.append((s, r))
            self.live.add((s, r))
            return True

        sysm = mock.Mock(mem_free=lambda: self.free)
        with mock.patch.object(TP, "config", lambda: (TEAM, 20, 10, 14, ROLES, {"hr-helper": "/h", "taibe": "/t"})), \
                mock.patch.object(TP.Q, "oq_request", oq), mock.patch.object(TP, "spawn", spawn), \
                mock.patch.object(TP, "is_live", lambda s, r, root: (s, r) in self.live), \
                mock.patch.object(TP, "nerve_limit", lambda: self.limit), \
                mock.patch.object(TP.TS, "Sys", lambda: sysm), \
                mock.patch.object(TP.TS, "live_sessions", lambda sx: len(self.live)), \
                mock.patch.object(TP.subprocess, "run", lambda *a, **k: mock.Mock(returncode=0)):
            return TP.up(self.log.append)


class UpTest(Base):
    def test_full_team_6_6(self):
        self.run_up()
        self.assertEqual(len(self.spawned), 12)
        self.assertEqual(sum(s == "taibe" for s, _ in self.spawned), 6)
        self.assertEqual(self.notes, [])  # потолок не менялся — уведомлений нет

    def test_owner_split_from_queue(self):
        self.choice = "8-4"
        self.run_up()
        self.assertEqual(sum(s == "hr-helper" for s, _ in self.spawned), 8)
        self.assertEqual(json.loads((Path(self.tmp.name) / "team-split.json").read_text()), {"hr-helper": 8, "taibe": 4})

    def test_note_split_beats_choice(self):
        self.choice, self.note = "6-6", "давай 7-5 на эту неделю"
        self.run_up()
        self.assertEqual(sum(s == "hr-helper" for s, _ in self.spawned), 7)

    def test_bad_note_falls_back_to_choice(self):
        self.choice, self.note = "4-8", "12-0"
        self.run_up()
        self.assertEqual(sum(s == "taibe" for s, _ in self.spawned), 8)

    def test_live_roles_not_reopened(self):
        self.live = {("hr-helper", "coord"), ("taibe", "coord")}
        self.run_up()
        self.assertNotIn(("hr-helper", "coord"), self.spawned)
        self.assertEqual(len(self.live), 12)

    def test_low_memory_floor_10_and_notice_then_back(self):
        self.free = 15  # < mem_warn 20
        self.run_up()
        self.assertEqual(len(self.spawned), 10)
        self.assertEqual(len(self.notes), 1)
        self.assertIn("10 ролей вместо 12", self.notes[0][1]["data"]["title"])
        self.free, self.spawned = 50, []
        self.run_up()
        self.assertEqual(len(self.spawned), 2)
        self.assertIn("снова 12", self.notes[-1][1]["data"]["title"])

    def test_critical_memory_opens_nothing(self):
        self.free = 5
        self.run_up()
        self.assertEqual(self.spawned, [])

    def test_nerve_limit_opens_nothing(self):
        self.limit = {"kind": "weekly", "resume": "2026-11-19T19:00"}
        self.run_up()
        self.assertEqual(self.spawned, [])
        self.assertIn("лимите", self.log[-1])


if __name__ == "__main__":
    unittest.main()
