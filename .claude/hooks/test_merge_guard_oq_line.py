#!/usr/bin/env python3
"""OPS-88: в oq_agent_status session сессия пишет своё имя, его хвост или свою линию r.<…> — чужую нет.

Сервер очереди узнаёт наследника захвата только по линии (`infra/ops-console/server/queue/store.ts`, LINE), а имя окна
роли Т3 (`taibe-backend-4rn2`) линией не является.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_mcp import oq_identity, own_line  # noqa: E402

TOOL = "mcp__owner-queue__oq_agent_status"
SID = "0b3c2d1e-0000-4000-8000-000000000001"
SESSIONS = [{"sessionId": SID, "name": "taibe-backend-4rn2"}]


def verdict(session, line="r.62u1.4rn2", tool=TOOL):
    return oq_identity(tool, {"id": "i-1", "session": session}, SID, lambda: SESSIONS, get_line=lambda sid: line)


class OqLine(unittest.TestCase):
    def test_own_name_tail_and_line_pass(self):
        for value in ("taibe-backend-4rn2", "4rn2", "r.62u1.4rn2"):
            self.assertIsNone(verdict(value), value)

    def test_foreign_line_refused(self):
        # предок, сосед, «наследник» чужой линии и префикс без точки — не своя линия
        for value in ("r.62u1", "r.62u1.zz99", "r.62u1.4rn2.ab12", "r.62u1.4rn"):
            self.assertIsNotNone(verdict(value), value)

    def test_no_line_refuses_any_line(self):
        self.assertIsNotNone(verdict("r.62u1.4rn2", line=None))

    def test_line_must_start_with_r(self):
        self.assertIsNotNone(verdict("x.62u1", line="x.62u1"))

    def test_foreign_name_refused(self):
        self.assertIsNotNone(verdict("taibe-frontend-y60m"))

    def test_hub_name_checked_too(self):
        self.assertIsNotNone(verdict("r.62u1", tool="mcp__hub__owner-queue_1mcp_oq_agent_status"))
        self.assertIsNone(verdict("r.62u1.4rn2", tool="mcp__hub__owner-queue_1mcp_oq_agent_status"))

    def test_broken_lineage_code_means_no_line(self):
        # любой сбой кода линии (не только OSError) — линии нет, значит отказ, а не падение хука (= проход)
        import merge_guard_identity as ident
        with tempfile.TemporaryDirectory() as d:
            tools = Path(d) / "eval" / "tools"
            tools.mkdir(parents=True)
            (tools / "lineage.py").write_text("raise RuntimeError('сломан')\n", "utf-8")
            old = ident.MAIN_ROOT
            ident.MAIN_ROOT = Path(d)
            try:
                self.assertIsNone(own_line(SID))
                self.assertIsNotNone(oq_identity(TOOL, {"id": "i-1", "session": "r.62u1.4rn2"}, SID, lambda: SESSIONS))
            finally:
                ident.MAIN_ROOT = old

    def test_own_line_reads_first_prompt_only(self):
        with tempfile.TemporaryDirectory() as d:
            proj = Path(d) / "-x"
            proj.mkdir()
            rows = [
                {"type": "user", "message": {"content": "Сборка Т3, роль 4. Линия: r.62u1.4rn2 (поколение 1)."}},
                {"type": "user", "message": {"content": "Линия: r.zz99 — цитата чужой сессии"}},
            ]
            (proj / f"{SID}.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), "utf-8")
            old = os.environ.get("CLAUDE_PROJECTS_DIR")
            os.environ["CLAUDE_PROJECTS_DIR"] = d
            try:
                self.assertEqual(own_line(SID), "r.62u1.4rn2")
                self.assertIsNone(own_line("не-id"))
            finally:
                if old is None:
                    os.environ.pop("CLAUDE_PROJECTS_DIR")
                else:
                    os.environ["CLAUDE_PROJECTS_DIR"] = old


if __name__ == "__main__":
    unittest.main()
