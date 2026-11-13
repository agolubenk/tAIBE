"""Тесты usage_by_server.py: python3 -I -m unittest discover -s infra/mcp-hub -p 'test_*.py' (make check-infra)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import usage_by_server as u  # noqa: E402

ROUTED_LINE = ('2026-11-11T14:05:08.606Z [INFO] message="tool.routed" source="local-diagnostic" details="{\\"callId\\":'
               '\\"x\\",\\"requestedTool\\":\\"t-boards_1mcp_get_task\\",\\"server\\":\\"t-boards\\",\\"tool\\":'
               '\\"get_task\\"}"\n')


def use(tid, name, ts):
    return json.dumps({"timestamp": ts, "message": {"content": [{"type": "tool_use", "id": tid, "name": name,
                                                                 "input": {"secret": "не читается"}}]}}) + "\n"


class Classify(unittest.TestCase):
    def test_hub_and_direct(self):
        self.assertEqual(u.classify("mcp__hub__t-boards_1mcp_get_task"), ("hub", "t-boards"))
        self.assertEqual(u.classify("mcp__hub__postgres-readonly_1mcp_query"), ("hub", "postgres-readonly"))
        self.assertEqual(u.classify("mcp__postgres-readonly__query"), ("direct", "postgres-readonly"))
        self.assertEqual(u.classify("mcp__plugin_context-mode_context-mode__ctx_execute"),
                         ("direct", "plugin_context-mode_context-mode"))
        self.assertEqual(u.classify("mcp__hub__compactname"), ("hub", "?"))

    def test_not_mcp(self):
        self.assertIsNone(u.classify("Bash"))
        self.assertIsNone(u.classify("mcp__nodelimiter"))


class Product(unittest.TestCase):
    def test_repo_name_wins_over_worktree_topic(self):
        self.assertEqual(u.product("-Users-a-Desktop-Development-HR-Helper-v2"), "HR")
        self.assertEqual(u.product("-Users-a-Desktop-Development-HR-Helper-v2-worktrees-fix-taibe-link"), "HR")
        self.assertEqual(u.product("-Users-a-Desktop-Development-tAIBE-worktrees-feature-aion"), "tAIBE")
        self.assertEqual(u.product("-Users-a"), "прочее")


class Counts(unittest.TestCase):
    def test_transcripts_window_dedup_and_products(self):
        now = time.time()
        fresh = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - 3600))
        old = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - 10 * 86400))
        with tempfile.TemporaryDirectory() as root:
            hr = Path(root, "-Users-a-Development-HR-Helper-v2")
            tb = Path(root, "-Users-a-Development-tAIBE", "sess", "subagents")
            hr.mkdir()
            tb.mkdir(parents=True)
            (hr / "s.jsonl").write_text(
                use("1", "mcp__hub__t-boards_1mcp_get_task", fresh)
                + use("1", "mcp__hub__t-boards_1mcp_get_task", fresh)  # тот же id — один вызов
                + use("2", "mcp__postgres-readonly__query", fresh)
                + use("3", "mcp__hub__git_1mcp_git_log", old)  # вне окна
                + "не json\n", encoding="utf-8")
            (tb / "a.jsonl").write_text(use("4", "mcp__hub__t-boards_1mcp_search", fresh), encoding="utf-8")
            table = u.count_transcripts(root, now - 7 * 86400)
        self.assertEqual(table[("hub", "t-boards")], {"HR": 1, "tAIBE": 1})
        self.assertEqual(table[("direct", "postgres-readonly")], {"HR": 1})
        self.assertNotIn(("hub", "git"), table)
        text = u.render(table, 7)
        self.assertIn("| t-boards | 1 | 1 | 0 | 0 | 2 |", text)
        self.assertNotIn("не читается", text)

    def test_routed_counts_and_window(self):
        since = u.epoch("2026-11-11T14:00:00Z")
        old = ROUTED_LINE.replace("2026-11-11T14:05", "2026-11-10T14:05")
        routed, first = u.count_routed([old, ROUTED_LINE, ROUTED_LINE, "2026-11-11 other line\n"], since)
        self.assertEqual(routed, {"t-boards": 2})
        self.assertEqual(first, "2026-11-11T14:05")
        self.assertIn("| t-boards | 2 |", u.render({}, 7, routed, first))


if __name__ == "__main__":
    unittest.main()
