"""Тесты передачи Контроля сторожем retire (lineage_guard.py, IS-233). Запуск: python3 eval/tools/test_lineage_guard.py"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lineage as L  # noqa: E402
import lineage_guard as G  # noqa: E402
import lineage_retire as LR  # noqa: E402
from test_lineage import CHILD, PARENT, ST, Base, FakeSys, P, tree  # noqa: E402

PRED = "11111111-aaaa-4bbb-8ccc-000000000300"
SUCC = "22222222-aaaa-4bbb-8ccc-000000000400"
OTHER = "33333333-aaaa-4bbb-8ccc-000000000999"


class HandoverTest(Base):
    def setUp(self):
        super().setUp()
        self.hr, self.tb = self.dir / "hr", self.dir / "tb"
        for d in (self.hr, self.tb):
            (d / ".claude").mkdir(parents=True)
            self.put(d, [PRED])
        self.sess(300, PRED)
        self.sess(400, SUCC)
        L.write_json(L.ldir() / f"{CHILD}.json", {"terminal": "terminal", "tty": "/dev/ttys006"})

    def put(self, d, control, extra=None):
        f = d / G.GUARD
        f.write_text(json.dumps({"control": control, **(extra or {})}) + "\n", encoding="utf-8")
        os.chmod(f, 0o644)

    def get(self, d):
        return json.loads((d / G.GUARD).read_text(encoding="utf-8"))

    def sess(self, pid, sid, start=ST):
        L.sessions_dir().mkdir(parents=True, exist_ok=True)
        (L.sessions_dir() / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid, "procStart": start}))

    def run_watch(self, sx=None, sid=PRED, pred=None):
        sx = sx or FakeSys(tree(), env={400: CHILD, 300: PARENT})
        self.sx = sx
        self.ack()
        ctl = {"dirs": [str(self.hr), str(self.tb)], "sid": sid}
        return LR.watch(sx, pred or sx.p[300], PARENT, CHILD, "backend", 600, self.log, poll=1, ctl=ctl)

    def assert_untouched(self):
        for d in (self.hr, self.tb):
            self.assertEqual(self.get(d)["control"], [PRED])
            self.assertFalse((d / ".claude" / "merge-guard.local.json.before-cd34").exists())
        self.assertIn(300, self.sx.p, "Контроль не передан — предшественник должен остаться")

    def test_control_moves_to_successor_then_predecessor_goes(self):
        self.put(self.hr, [OTHER, PRED], {"protected": ["release"]})
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual(self.get(self.hr), {"control": [OTHER, SUCC], "protected": ["release"]})
        self.assertEqual(self.get(self.tb)["control"], [SUCC])
        backup = self.hr / ".claude" / "merge-guard.local.json.before-cd34"
        self.assertEqual(json.loads(backup.read_text())["control"], [OTHER, PRED])
        self.assertEqual(oct((self.hr / G.GUARD).stat().st_mode & 0o777), oct(0o644))
        self.assertNotIn(300, self.sx.p)
        self.assertIn(400, self.sx.p)

    def test_prefix_entry_is_replaced(self):
        self.put(self.tb, [PRED[:8]])
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual(self.get(self.tb)["control"], [SUCC])

    def test_not_control_changes_nothing_and_retires_as_before(self):
        for d in (self.hr, self.tb):
            self.put(d, [OTHER])
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [OTHER])
        self.assertFalse((self.hr / ".claude" / "merge-guard.local.json.before-cd34").exists())
        self.assertNotIn(300, self.sx.p)

    def test_write_failure_rolls_back_and_keeps_predecessor(self):
        real = G.write_atomic

        def flaky(f, text, mode):
            if Path(f).resolve() == (self.tb / G.GUARD).resolve() and SUCC in text:
                raise OSError("disk full")
            return real(f, text, mode)

        with mock.patch.object(G, "write_atomic", flaky):
            self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertEqual(self.get(self.tb)["control"], [PRED])
        self.assertIn(300, self.sx.p)
        self.assertIn("сбой записи", " ".join(self.lines))

    def test_successor_not_in_spawned_window_keeps_everything(self):
        L.write_json(L.ldir() / f"{CHILD}.json", {"terminal": "terminal", "tty": "/dev/ttys099"})
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assert_untouched()

    def test_successor_started_by_another_claude_keeps_everything(self):
        # Сессия-не-Контроль запустила claude с линией наследника на «своём» tty и подделала запись линии.
        procs = tree(successor_parent=501) + [P(500, 1, 500, "ttys006", "claude"), P(501, 500, 501, "ttys006", "zsh")]
        sx = FakeSys(procs, env={400: CHILD, 300: PARENT})
        self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assert_untouched()
        self.assertIn("из другой сессии claude", " ".join(self.lines))

    def test_print_mode_without_tty_keeps_everything(self):
        L.write_json(L.ldir() / f"{CHILD}.json", {"terminal": "print"})
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assert_untouched()

    def test_successor_missing_from_registry_keeps_everything(self):
        (L.sessions_dir() / "400.json").unlink()
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assert_untouched()

    def test_registry_of_reused_pid_is_not_trusted(self):
        self.sess(400, SUCC, start="Mon Nov  2 09:00:00 2026")
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assert_untouched()

    def test_corrupt_list_keeps_everything(self):
        (self.tb / G.GUARD).write_text("{not json", encoding="utf-8")
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn(300, self.sx.p)

    def test_predecessor_gone_after_ack_still_hands_over(self):
        sx = FakeSys(tree(), env={400: CHILD, 300: PARENT})
        pred = sx.p[300]
        for pid in (300, 301, 302, 303):
            del sx.p[pid]
        self.assertEqual(self.run_watch(sx, pred=pred), 0, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [SUCC])

    def test_second_successor_gets_nothing(self):
        self.assertEqual(self.run_watch(), 0, self.lines)
        third = "44444444-aaaa-4bbb-8ccc-000000000500"
        ok = G.hand_control([self.hr, self.tb], PRED, (third, None), "zz99", self.log)
        self.assertTrue(ok)
        self.assertEqual(self.get(self.hr)["control"], [SUCC])
        self.assertIn("нет в списке", self.lines[-1])

    def test_unknown_predecessor_sid_changes_nothing(self):
        self.assertTrue(G.hand_control([self.hr], None, (SUCC, None), "cd34", self.log))
        self.assertEqual(self.get(self.hr)["control"], [PRED])

    def test_worktree_maps_to_main_root(self):
        wt = self.hr / "worktrees" / "feature" / "x"
        wt.mkdir(parents=True)
        self.assertEqual(G.guard_dirs([wt, self.hr]), [self.hr.resolve()])

    @mock.patch.dict(os.environ, {"TAIBE_LINEAGE": PARENT})
    def test_cli_accepts_guard(self):
        out = L.main(["retire", "--child", CHILD, "--guard", str(self.hr), "--guard", str(self.tb)], sx=FakeSys([]))
        self.assertEqual(out, 0)


if __name__ == "__main__":
    unittest.main()
