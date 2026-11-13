# -*- coding: utf-8 -*-
"""Проба системы Нервом (OPS-44): хаб MCP и Serena — два прохода без ответа будят release и coord командой из папки
tAIBE, ожил — сводка release; LaunchAgent хаба не загружен — сводка release раз в сутки. Без сети и launchctl.
python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'"""
import copy
import os
import sys
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sources  # noqa: E402
from journal import DIGEST, NERVOUS, read_from  # noqa: E402
from test_nerve import CFG, FakeCtx  # noqa: E402

HUB = "http://127.0.0.1:3050/health"
SERENA = "http://127.0.0.1:9121/mcp"
AGENT = "space.hrhelper.mcp-hub"


class FakeHost:
    """Подмена sources.run: curl — код по url (нет в codes — 000), launchctl print — 0 для загруженных меток."""

    def __init__(self, codes, loaded=(AGENT,)):
        self.codes, self.loaded, self.calls = dict(codes), set(loaded), []

    def __call__(self, cmd, stdin=None, timeout=30):  # noqa: ARG002 — сигнатура sources.run
        del stdin, timeout
        self.calls.append(list(cmd))
        if cmd[0] == "curl":
            return 0, self.codes.get(cmd[-1], "000"), ""
        if cmd[:2] == ["launchctl", "print"]:
            return (0 if cmd[2].rsplit("/", 1)[1] in self.loaded else 113), "", ""
        raise AssertionError(f"неожиданная команда {cmd}")


class SystemProbeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = FakeCtx(self.tmp.name)
        self.ctx.cfg = copy.deepcopy(CFG)
        self.ctx.cfg["system"].update(hub_health=HUB, serena_mcp=[SERENA], launch_agents=[AGENT])
        self.offset = 0
        patches = [mock.patch.object(sources.shutil, "which", lambda name: "/bin/" + name if name == "launchctl" else None)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def passes(self, host, n=1):
        with mock.patch.object(sources, "run", host):
            for _ in range(n):
                sources.poll_system(self.ctx)
                self.ctx.now += timedelta(minutes=1)
        recs, self.offset = read_from(self.ctx.journal.path, self.offset)
        return recs

    def test_all_up_is_silent(self):
        self.assertEqual(self.passes(FakeHost({HUB: "200", SERENA: "400"}), 3), [])

    def test_hub_down_two_passes_wakes_release_and_coord_with_taibe_command(self):
        host = FakeHost({SERENA: "400"})
        self.assertEqual(self.passes(host), [], "один проход без ответа — ещё не тревога")
        recs = self.passes(host, 3)
        self.assertEqual(len(recs), 1, "тревога один раз, а не на каждом проходе")
        r = recs[0]
        self.assertEqual((r["kind"], r["class"]), ("sys.hub", NERVOUS))
        self.assertEqual(sorted(r["to"]), ["coord", "release"])
        self.assertIn("в папке tAIBE: npm run mcp-hub:status", r["text"])
        self.assertTrue(r["key"].startswith("sys:hub:down:"), "ключ хаба прежний — дедуп не сбрасывается")
        up = self.passes(FakeHost({HUB: "200", SERENA: "400"}))
        self.assertEqual([(x["kind"], x["class"], x["to"]) for x in up], [("sys.hub", DIGEST, ["release"])])
        self.assertIn("снова отвечает", up[0]["text"])

    def test_serena_closed_port_alarms_but_4xx_is_up(self):
        recs = self.passes(FakeHost({HUB: "200"}), 2)
        self.assertEqual(len(recs), 1)
        self.assertIn("Serena :9121", recs[0]["text"])
        self.assertTrue(recs[0]["key"].startswith("sys:serena:9121:down:"))
        self.assertEqual(self.ctx.state["probes"]["serena:9121"]["fails"], 2)
        self.passes(FakeHost({HUB: "200", SERENA: "406"}))
        self.assertEqual(self.ctx.state["probes"]["serena:9121"], {"fails": 0, "down_since": ""})

    def test_missing_launch_agent_digest_once_a_day(self):
        recs = self.passes(FakeHost({HUB: "200", SERENA: "400"}, loaded=()), 3)
        self.assertEqual(len(recs), 1)
        self.assertEqual((recs[0]["class"], recs[0]["to"]), (DIGEST, ["release"]))
        self.assertIn(AGENT, recs[0]["text"])

    def test_old_config_without_new_keys_probes_hub_only(self):
        for key in ("serena_mcp", "launch_agents"):
            self.ctx.cfg["system"].pop(key)
        host = FakeHost({HUB: "200"})
        self.assertEqual(self.passes(host), [])
        self.assertEqual([c[0] for c in host.calls], ["curl"])


if __name__ == "__main__":
    unittest.main()
