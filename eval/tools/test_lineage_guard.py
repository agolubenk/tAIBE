"""Тесты передачи Контроля сторожем retire (lineage_guard.py, IS-233). Запуск: python3 eval/tools/test_lineage_guard.py"""
import io
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
            (d / ".git").mkdir()
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

    def run_watch(self, sx=None, sid=PRED, pred=None, tty="/dev/ttys006", dirs=None):
        sx = sx or FakeSys(tree(), env={400: CHILD, 300: PARENT})
        self.sx = sx
        self.ack()
        ctl = {"dirs": [str(x) for x in (dirs or (self.hr, self.tb))], "sid": sid, "tty": tty}
        return LR.watch(sx, pred or sx.p[300], PARENT, CHILD, "backend", 600, self.log, poll=1, ctl=ctl)

    def assert_untouched(self):
        for d in (self.hr, self.tb):
            self.assertEqual(self.get(d)["control"], [PRED])
            self.assertFalse((d / ".claude" / G.BACKUP).exists())
        self.assertFalse((G.state_dir() / G.INTENT).exists())
        self.assertIn(300, self.sx.p, "Контроль не передан — предшественник должен остаться")

    def test_control_moves_to_successor_then_predecessor_goes(self):
        self.put(self.hr, [OTHER, PRED], {"protected": ["release"]})
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual(self.get(self.hr), {"control": [OTHER, SUCC], "protected": ["release"]})
        self.assertEqual(self.get(self.tb)["control"], [SUCC])
        backup = self.hr / ".claude" / G.BACKUP
        self.assertEqual(json.loads(backup.read_text())["control"], [OTHER, PRED])
        self.assertFalse((G.state_dir() / G.INTENT).exists())
        self.assertEqual(sorted(x.name for x in (self.hr / ".claude").iterdir()), [G.GUARD.name, G.BACKUP])
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
        self.assertFalse((self.hr / ".claude" / G.BACKUP).exists())
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
        self.assertFalse((G.state_dir() / G.INTENT).exists(), "откат удался — журнал не нужен")

    def test_successor_not_in_spawned_window_keeps_everything(self):
        (L.ldir() / f"{CHILD}.json").unlink()
        self.assertEqual(self.run_watch(tty="/dev/ttys099"), 3, self.lines)
        self.assert_untouched()

    def test_forged_record_tty_is_ignored(self):
        # Папку линий правят агенты (GLM #120, находка 1): tty берётся только из аргумента сторожа.
        self.assertEqual(self.run_watch(tty="/dev/ttys099"), 3, self.lines)  # запись линии — ttys006, как у наследника
        self.assert_untouched()
        L.write_json(L.ldir() / f"{CHILD}.json", {"terminal": "terminal", "tty": "/dev/ttys099"})
        self.assertEqual(self.run_watch(), 0, self.lines)  # запись врёт в другую сторону — тоже не мешает
        self.assertEqual(self.get(self.tb)["control"], [SUCC])

    def test_planted_intent_in_lineage_dir_is_not_trusted(self):
        # Журнал в папке линий (открыта агентам) больше не блокирует передачу (GLM #120, находка 3).
        L.write_json(L.ldir() / G.INTENT, {"from": "x", "to": "y", "files": []})
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual((self.get(self.hr)["control"], self.get(self.tb)["control"]), ([SUCC], [SUCC]))
        self.assertFalse((G.state_dir() / G.INTENT).exists())

    def test_symlinked_state_dir_keeps_everything(self):
        elsewhere = self.dir / "elsewhere-state"
        elsewhere.mkdir()
        L.sessions_dir().mkdir(parents=True, exist_ok=True)
        G.state_dir().symlink_to(elsewhere)
        self.assertFalse(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log))
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn("ссылка", self.lines[-1])
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_worktrees_above_repo_root_keeps_everything(self):
        # Хук режет путь по «/worktrees/» и прочтёт <tmp>, а корень репозитория — <tmp>/worktrees/repo (находка 2).
        repo = self.dir / "worktrees" / "repo"
        (repo / ".claude").mkdir(parents=True)
        (repo / ".git").mkdir()
        self.put(repo, [PRED])
        self.assertIsNone(G.guard_dirs([self.hr, repo]))
        self.assertEqual(self.run_watch(dirs=(self.hr, repo)), 3, self.lines)
        self.assert_untouched()
        self.assertEqual(self.get(repo)["control"], [PRED])
        self.assertIn("корню репозитория", " ".join(self.lines))

    def test_dir_outside_any_repo_keeps_everything(self):
        bare = self.dir / "bare"
        (bare / ".claude").mkdir(parents=True)
        self.put(bare, [PRED])
        self.assertIsNone(G.main_root(bare))
        self.assertFalse(G.hand_control([self.hr, bare], PRED, (SUCC, None), "cd34", self.log))
        self.assertEqual(self.get(self.hr)["control"], [PRED])

    def test_successor_dies_after_writes_rolls_back(self):
        # Наследник упал между записью списков и снятием предшественника (GLM #120, находка 4).
        sx = FakeSys(tree(), env={400: CHILD, 300: PARENT})
        real = G.write_atomic

        def then_die(f, text, mode):
            out = real(f, text, mode)
            if Path(f).resolve() == (self.tb / G.GUARD).resolve() and SUCC in text:
                for pid in (400, 401, 402):
                    sx.p.pop(pid, None)
            return out

        with mock.patch.object(G, "write_atomic", then_die):
            self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assertEqual((self.get(self.hr)["control"], self.get(self.tb)["control"]), ([PRED], [PRED]))
        self.assertFalse((G.state_dir() / G.INTENT).exists())
        self.assertIn(300, self.sx.p)
        self.assertIn("не подтверждён", " ".join(self.lines))

    def test_successor_started_by_another_claude_keeps_everything(self):
        # Сессия-не-Контроль запустила claude с линией наследника на «своём» tty и подделала запись линии.
        procs = tree(successor_parent=501) + [P(500, 1, 500, "ttys006", "claude"), P(501, 500, 501, "ttys006", "zsh")]
        sx = FakeSys(procs, env={400: CHILD, 300: PARENT})
        self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assert_untouched()
        self.assertIn("из другой сессии claude", " ".join(self.lines))

    def test_print_mode_without_tty_keeps_everything(self):
        # --terminal print / iterm: spawn_session.sh передаёт пустой --succ-tty — Контроль не передаётся.
        self.assertEqual(self.run_watch(tty=""), 3, self.lines)
        self.assert_untouched()
        self.assertIn("tty окна не передан", " ".join(self.lines))

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

    def test_unknown_predecessor_sid_keeps_everything(self):
        # sessionId предшественника не известен — не проверить, Контроль ли он: не снимать (fail-closed).
        self.assertFalse(G.hand_control([self.hr], None, (SUCC, None), "cd34", self.log))
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertEqual(self.run_watch(sid=None), 3, self.lines)
        self.assert_untouched()

    def test_unknown_predecessor_sid_without_lists_retires(self):
        bare = self.dir / "bare"
        (bare / ".git").mkdir(parents=True)
        self.assertTrue(G.hand_control([bare], None, (SUCC, None), "cd34", self.log))

    def test_reparented_successor_keeps_everything(self):
        # Вложенный claude, чей Bash умер: ppid 1 (launchd), ancestor_claude его уже не видит.
        sx = FakeSys(tree(successor_parent=1), env={400: CHILD, 300: PARENT})
        self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assert_untouched()
        self.assertIn("не пусковой скрипт или shell", " ".join(self.lines))

    def test_successor_under_spawn_launcher_hands_over(self):
        procs = [x for x in tree(successor_parent=212)] + [
            P(212, 211, 212, "ttys006", "/bin/bash /var/folders/x/T//claude-spawn.AbC123/backend.sh")]
        sx = FakeSys(procs, env={400: CHILD, 300: PARENT})
        self.assertEqual(self.run_watch(sx), 0, self.lines)
        self.assertEqual(self.get(self.tb)["control"], [SUCC])

    def test_symlinked_list_keeps_everything(self):
        real = self.dir / "elsewhere.json"
        real.write_text(json.dumps({"control": [PRED]}), encoding="utf-8")
        (self.tb / G.GUARD).unlink()
        (self.tb / G.GUARD).symlink_to(real)
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertEqual(json.loads(real.read_text())["control"], [PRED])
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn(300, self.sx.p)

    def test_hardlinked_list_keeps_everything(self):
        os.link(self.tb / G.GUARD, self.dir / "twin.json")
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [PRED])

    def test_planted_links_at_backup_and_tmp_are_not_followed(self):
        victim = self.dir / "victim.txt"
        victim.write_text("keep", encoding="utf-8")
        claude = self.tb / ".claude"
        (claude / G.BACKUP).symlink_to(victim)
        (claude / (G.GUARD.name + ".tmp-handover")).symlink_to(victim)
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual(victim.read_text(encoding="utf-8"), "keep")
        self.assertFalse((claude / G.BACKUP).is_symlink())
        self.assertEqual(self.get(self.tb)["control"], [SUCC])
        self.assertEqual([x.name for x in claude.iterdir() if x.name.endswith(".tmp-handover") and not x.is_symlink()], [])

    def test_busy_lock_gives_up_and_keeps_everything(self):
        import fcntl
        G.state_dir().mkdir(parents=True, exist_ok=True)
        with open(G.state_dir() / "guard.lock", "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.assertFalse(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log, lock_wait=0.3))
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn("guard.lock занят", self.lines[-1])

    def test_interrupted_handover_blocks_next_until_checked(self):
        real, calls = G.write_atomic, []

        def killed(f, text, mode):
            if Path(f).name == G.GUARD.name and SUCC in text:
                calls.append(f)
                if len(calls) == 2:
                    raise KeyboardInterrupt("сторож убит между папками")
            return real(f, text, mode)

        with mock.patch.object(G, "write_atomic", killed):
            with self.assertRaises(KeyboardInterrupt):
                G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log)
        self.assertEqual(self.get(self.hr)["control"], [SUCC])
        self.assertEqual(self.get(self.tb)["control"], [PRED])
        intent = json.loads((G.state_dir() / G.INTENT).read_text())
        self.assertEqual((intent["from"], intent["to"], len(intent["files"])), (PRED[:8], SUCC[:8], 2))
        self.assertFalse(G.hand_control([self.tb], PRED, (SUCC, None), "ef56", self.log))
        self.assertIn("прерванной передачи", self.lines[-1])
        self.assertEqual(self.get(self.tb)["control"], [PRED])

    def test_failed_rollback_leaves_intent(self):
        real = G.write_atomic
        hr, tb = (self.hr / G.GUARD).resolve(), (self.tb / G.GUARD).resolve()

        def broken(f, text, mode):
            target = Path(f).resolve() if Path(f).name == G.GUARD.name else None
            if target == tb and SUCC in text:
                raise OSError("disk full")
            if target == hr and SUCC not in text:
                raise OSError("откат тоже не пишется")
            return real(f, text, mode)

        with mock.patch.object(G, "write_atomic", broken):
            self.assertFalse(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log))
        self.assertTrue((G.state_dir() / G.INTENT).exists(), "расхождение осталось — журнал сигналит следующей передаче")
        self.assertIn("откат не полон", self.lines[-1])
        self.assertEqual(json.loads((self.hr / ".claude" / G.BACKUP).read_text())["control"], [PRED])

    def test_failed_rollback_through_watch_keeps_predecessor(self):
        # GLM #120 7fb2287d2, находка 9b: неполный откат на пути сторожа — rc 3, предшественник жив, журнал остался.
        real = G.write_atomic
        hr, tb = (self.hr / G.GUARD).resolve(), (self.tb / G.GUARD).resolve()

        def broken(f, text, mode):
            target = Path(f).resolve() if Path(f).name == G.GUARD.name else None
            if target == tb and SUCC in text:
                raise OSError("disk full")
            if target == hr and SUCC not in text:
                raise OSError("откат тоже не пишется")
            return real(f, text, mode)

        with mock.patch.object(G, "write_atomic", broken):
            self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertIn(300, self.sx.p, "Контроль не передан — предшественник должен остаться")
        self.assertNotIn((300, 15), self.sx.sent)
        self.assertTrue((G.state_dir() / G.INTENT).exists(), "расхождение осталось — журнал сигналит следующей передаче")
        self.assertTrue(any("откат не полон" in m for m in self.lines), self.lines)
        self.assertEqual(self.get(self.tb)["control"], [PRED])

    @mock.patch.dict(os.environ, {"TAIBE_LINEAGE": PARENT})
    def test_cli_retire_with_foreign_registry_start_keeps_predecessor(self):
        # GLM #120 7fb2287d2, находка 9a: настоящий session_id(p) = None (запись реестра 300 — другого старта
        # процесса) через cmd_retire, без подмены sid в ctl: Контроль не передаётся, предшественник жив.
        self.sess(300, PRED, start="Thu Nov  5 09:00:00 2026")
        sx = FakeSys(tree(), env={400: CHILD, 300: PARENT})
        self.sx = sx
        self.assertIsNone(G.session_id(sx.p[300]))
        self.ack()
        args = ["retire", "--child", CHILD, "--guard", str(self.hr), "--guard", str(self.tb),
                "--succ-tty", "/dev/ttys006", "--foreground"]
        with mock.patch.object(LR.os, "getpid", return_value=302), mock.patch("sys.stdout", io.StringIO()) as out:
            rc = L.main(args, sx=sx)
        self.assertEqual(rc, 3, out.getvalue())
        self.assert_untouched()
        self.assertNotIn((300, 15), sx.sent)

    def test_successor_already_listed_is_not_doubled(self):
        self.put(self.hr, [SUCC, PRED])
        self.put(self.tb, [OTHER, OTHER, PRED])
        self.assertEqual(self.run_watch(), 0, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [SUCC])
        self.assertEqual(self.get(self.tb)["control"], [OTHER, OTHER, SUCC])

    def test_lock_file_recreated_on_every_try_gives_up_in_time(self):
        import time
        from types import SimpleNamespace
        G.state_dir().mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        with mock.patch.object(G.os, "stat", lambda *a, **k: SimpleNamespace(st_ino=-1)):
            self.assertIsNone(G.lock(0.3))
        self.assertLess(time.monotonic() - t0, 2.0)

    def test_lock_path_is_a_symlink_gives_up_at_once(self):
        import time
        G.state_dir().mkdir(parents=True, exist_ok=True)
        os.symlink(self.dir / "elsewhere", G.state_dir() / "guard.lock")
        t0 = time.monotonic()
        self.assertFalse(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log, lock_wait=5))
        self.assertLess(time.monotonic() - t0, 1.0, "ELOOP повтор не исправит — ждать срок незачем")
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn("guard.lock", self.lines[-1])

    def test_oversized_list_keeps_everything(self):
        (self.tb / G.GUARD).write_text(json.dumps({"control": [PRED], "pad": "x" * (G.MAX_LIST + 1)}))
        self.assertFalse(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log))
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn("испорчен", self.lines[-1])

    def test_list_edited_after_plan_is_not_overwritten(self):
        real = G.plan

        def edited(dirs, pred_sid, log):
            todo = real(dirs, pred_sid, log)
            self.put(self.tb, [PRED, OTHER])  # владелец правит список без guard.lock
            return todo

        with mock.patch.object(G, "plan", edited):
            self.assertFalse(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log))
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertEqual(self.get(self.tb)["control"], [PRED, OTHER])
        self.assertFalse((G.state_dir() / G.INTENT).exists())
        self.assertIn("изменился", " ".join(self.lines))

    def test_no_ack_until_timeout_keeps_everything(self):
        self.sx = sx = FakeSys(tree(), env={400: CHILD, 300: PARENT})
        ctl = {"dirs": [str(self.hr), str(self.tb)], "sid": PRED, "tty": "/dev/ttys006"}
        self.assertEqual(LR.watch(sx, sx.p[300], PARENT, CHILD, "backend", 0, self.log, poll=1, ctl=ctl), 3)
        self.assert_untouched()
        self.assertIn("квитанции нет", self.lines[-1])

    def test_successor_dies_while_lock_is_awaited(self):
        sx = FakeSys(tree(), env={400: CHILD, 300: PARENT})
        real = G.lock

        def slow(wait):
            fd = real(wait)
            for pid in (400, 401, 402):  # наследник упал, пока сторож ждал guard.lock
                sx.p.pop(pid, None)
            return fd

        with mock.patch.object(G, "lock", slow):
            self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assert_untouched()
        self.assertIn("не жив", self.lines[-1])

    def test_intent_not_removed_after_handover_still_retires(self):
        real = os.unlink

        def stuck(path, *a, **k):
            if Path(path).name == G.INTENT:
                raise PermissionError("operation not permitted")
            return real(path, *a, **k)

        with mock.patch.object(G.os, "unlink", stuck):
            self.assertTrue(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log))
        self.assertEqual((self.get(self.hr)["control"], self.get(self.tb)["control"]), ([SUCC], [SUCC]))
        self.assertTrue((G.state_dir() / G.INTENT).exists())
        self.assertTrue(any("не удалён" in x for x in self.lines), self.lines)

    def test_settled_intent_is_dropped_and_next_handover_goes(self):
        # Журнал остался, а списки согласованы (GLM #120 7fb2287d2, находки 7, 14): следующая передача снимает его сама.
        with mock.patch.object(G.os, "unlink", side_effect=PermissionError("eperm")):
            self.assertTrue(G.hand_control([self.hr, self.tb], PRED, (SUCC, None), "cd34", self.log))
        self.assertTrue((G.state_dir() / G.INTENT).exists())
        self.assertTrue(G.hand_control([self.hr, self.tb], SUCC, (OTHER, None), "ef56", self.log))
        self.assertEqual((self.get(self.hr)["control"], self.get(self.tb)["control"]), ([OTHER], [OTHER]))
        self.assertFalse((G.state_dir() / G.INTENT).exists())
        self.assertTrue(any("согласованы, снимаю" in x for x in self.lines), self.lines)

    def test_impostor_under_orphaned_shell_keeps_everything(self):
        # Потомок Bash наследника, умершего без квитанции (GLM #120 7fb2287d2, находка 1): shell переподвешен к launchd.
        procs = tree(successor_parent=600) + [P(600, 601, 600, "ttys006", "zsh -c claude"),
                                               P(601, 1, 601, "ttys006", "/bin/zsh -c source snap")]
        self.assertEqual(self.run_watch(FakeSys(procs, env={400: CHILD, 300: PARENT})), 3, self.lines)
        self.assert_untouched()
        self.assertIn("оборвана", " ".join(self.lines))

    def test_symlinked_claude_dir_keeps_everything(self):
        # Папка .claude подменена ссылкой на подложный список (GLM #120 7fb2287d2, находка 2).
        fake = self.dir / "fake"
        fake.mkdir()
        (fake / G.GUARD.name).write_text(json.dumps({"control": [PRED]}), encoding="utf-8")
        (self.tb / ".claude").rename(self.tb / ".claude.real")
        (self.tb / ".claude").symlink_to(fake)
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertEqual(json.loads((fake / G.GUARD.name).read_text())["control"], [PRED])
        self.assertEqual(json.loads((self.tb / ".claude.real" / G.GUARD.name).read_text())["control"], [PRED])
        self.assertEqual(self.get(self.hr)["control"], [PRED])
        self.assertIn(300, self.sx.p)
        (fake / G.GUARD.name).unlink()  # и ссылка на папку без списка — сомнение, а не «списка нет»
        self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertIn(300, self.sx.p)

    def test_rollback_does_not_overwrite_later_edit(self):
        real = G.write_atomic

        def edit_then_fail(f, text, mode):
            if Path(f).resolve() == (self.tb / G.GUARD).resolve() and SUCC in text:
                self.put(self.hr, [SUCC, OTHER])  # владелец правит hr после нашей записи
                raise OSError("disk full")
            return real(f, text, mode)

        with mock.patch.object(G, "write_atomic", edit_then_fail):
            self.assertEqual(self.run_watch(), 3, self.lines)
        self.assertEqual(self.get(self.hr)["control"], [SUCC, OTHER])
        self.assertTrue((G.state_dir() / G.INTENT).exists())
        self.assertIn(300, self.sx.p)

    def test_only_empty_guard_dirs_keep_predecessor(self):
        self.assertFalse(G.hand_control(["", ""], PRED, (SUCC, None), "cd34", self.log))
        self.assertIn("нет папок guard", self.lines[-1])
        self.assertTrue(G.hand_control([], PRED, (SUCC, None), "cd34", self.log))

    def test_empty_guard_dir_is_skipped(self):
        self.assertEqual(G.guard_dirs(["", str(self.hr)]), [self.hr.resolve()])

    def test_worktree_maps_to_main_root(self):
        # Настоящая раскладка git worktree: файл .git → gitdir → commondir → общая .git основной папки.
        wt = self.hr / "worktrees" / "feature" / "x"
        wt.mkdir(parents=True)
        gd = self.hr / ".git" / "worktrees" / "x"
        gd.mkdir(parents=True)
        (gd / "commondir").write_text("../..\n", encoding="utf-8")
        (wt / ".git").write_text(f"gitdir: {gd}\n", encoding="utf-8")
        (self.hr / "sub").mkdir()
        self.assertEqual(G.guard_dirs([wt, self.hr, self.hr / "sub"]), [self.hr.resolve()])

    def test_worktree_without_commondir_is_doubt(self):
        wt = self.hr / "worktrees" / "feature" / "y"
        wt.mkdir(parents=True)
        (wt / ".git").write_text(f"gitdir: {self.hr / '.git' / 'worktrees' / 'y'}\n", encoding="utf-8")
        self.assertIsNone(G.main_root(wt))

    def test_gitdir_line_over_4k_is_doubt(self):
        # Граница чтения head — контракт (GLM #120 89dcafeb9, minor failures): верный gitdir длиннее 4 КБ (путь,
        # раздутый «./») — сомнение, а не корень; без границы он бы разрешился в настоящую папку.
        wt = self.hr / "worktrees" / "feature" / "z"
        wt.mkdir(parents=True)
        gd = self.hr / ".git" / "worktrees" / "z"
        gd.mkdir(parents=True)
        (gd / "commondir").write_text("../..\n", encoding="utf-8")
        (wt / ".git").write_text(f"gitdir: {self.hr}/{'./' * 2100}.git/worktrees/z\n", encoding="utf-8")
        self.assertGreater(len((wt / ".git").read_bytes()), 4096)
        self.assertIsNone(G.main_root(wt))

    def test_write_atomic_closes_fd_when_chmod_fails(self):
        got = {}
        real = G.tempfile.mkstemp

        def spy(*a, **k):
            got["fd"], got["tmp"] = real(*a, **k)
            return got["fd"], got["tmp"]

        with mock.patch.object(G.tempfile, "mkstemp", spy), \
                mock.patch.object(G.os, "fchmod", side_effect=OSError("EPERM")):
            with self.assertRaises(OSError):
                G.write_atomic(self.hr / G.GUARD, "{}\n", 0o600)
        with self.assertRaises(OSError):
            os.fstat(got["fd"])
        self.assertFalse(Path(got["tmp"]).exists())
        self.assertEqual(self.get(self.hr)["control"], [PRED])

    @mock.patch.dict(os.environ, {"TAIBE_LINEAGE": PARENT})
    def test_cli_accepts_guard(self):
        out = L.main(["retire", "--child", CHILD, "--guard", str(self.hr), "--guard", str(self.tb),
                      "--succ-tty", "/dev/ttys006"], sx=FakeSys([]))
        self.assertEqual(out, 0)


if __name__ == "__main__":
    unittest.main()
