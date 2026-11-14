#!/usr/bin/env python3
"""release_status.py на синтетике: линзы на текущей голове, m-пункты по влитым PR. Run: python3 -I <this file>"""
import io
import os
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import release_status as rs  # noqa: E402

HEAD = "b55b246ec0aa11bb22cc33dd44ee55ff66778899"
PULLS = [
    {"number": 433, "state": "open", "merged_at": None, "head": {"sha": HEAD}, "base": {"ref": "main"}},
    {"number": 429, "state": "closed", "merged_at": "2026-10-30T10:00:00Z", "head": {"sha": "1" * 40},
     "base": {"ref": "main"}},
    {"number": 440, "state": "open", "merged_at": None, "head": {"sha": "2" * 40}, "base": {"ref": "main"}},
]
COMMENTS = {
    433: [{"body": "Линза DevOps (Т3), голова 0000000aa — approve"},          # старая голова — не считается
          {"body": "**Бэкенд: approve на b55b246ec.**"}],
    440: [{"body": "Фронтенд: approve на 2222222"}, {"body": "Бэкенд: approve на 2222222"},
          {"body": "Безопасность: approve на 2222222"}],
}
OQ = [{"id": "m-429", "data": {"kind": "merge", "title": "Влить #429"}},
      {"id": "m-440", "data": {"kind": "merge", "title": "Влить #440"}},
      {"id": "m-428", "data": {"kind": "merge", "title": "Влить #428", "done": True}}]


class ReleaseStatusTest(unittest.TestCase):
    def setUp(self):
        self.rows, self.todo = rs.build_rows(PULLS, COMMENTS, OQ, 3)

    def test_lenses_count_only_on_head(self):
        row = next(r for r in self.rows if r[0] == 433)
        self.assertEqual(row[4], 1)
        self.assertIn("PR #433 голова b55b246ec: линз 1/3", self.todo)

    def test_open_merge_item_of_merged_pr(self):
        self.assertIn("закрыть m-429: PR #429 уже влит", self.todo)
        self.assertFalse(any("m-428" in t for t in self.todo))

    def test_quorum_pr_needs_nothing(self):
        self.assertFalse(any("PR #440" in t for t in self.todo))

    def test_second_session_is_the_same_lens(self):
        """#324 B3: approve backend и backend-2 — одна линза, как в кворуме Нерва (quorum.tally)."""
        pr = {"number": 450, "state": "open", "merged_at": None, "head": {"sha": "3" * 40}, "base": {"ref": "main"}}
        labels = ("Бэкенд (роль 4)", "Бэкенд (роль 7)", "Линза плана (роль 2)")
        rows, todo = rs.build_rows([pr], {450: [{"body": f"{x}: approve на 3333333"} for x in labels]}, [], 3)
        self.assertEqual(rows[0][4], 2)
        self.assertIn("PR #450 голова 333333333: линз 2/3", todo)

    def test_render(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            print(rs.render(self.rows, self.todo))
        self.assertIn("что сделать:", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
