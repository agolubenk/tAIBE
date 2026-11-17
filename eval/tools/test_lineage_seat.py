"""Тесты: Контроль новому release после «ВКЛ» (lineage_seat.py, SE-155). Запуск: python3 eval/tools/test_lineage_seat.py"""
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lineage as L  # noqa: E402
import lineage_guard as G  # noqa: E402
import lineage_seat as S  # noqa: E402
import team_status as TS  # noqa: E402
from test_lineage import CHILD, ST, TERMINAL, TMUX_SERVER, Base, FakeSys, P, tree  # noqa: E402

SUCC = "22222222-aaaa-4bbb-8ccc-000000000400"
DEAD_TB = "a2760000-aaaa-4bbb-8ccc-000000000001"
DEAD_TB2 = "a2770000-aaaa-4bbb-8ccc-000000000002"
DEAD_HR = "9b850000-aaaa-4bbb-8ccc-000000000003"
LIVE_HR = "8e070000-aaaa-4bbb-8ccc-000000000004"
LIVE_TB = "f4c30000-aaaa-4bbb-8ccc-000000000005"
NOBODY = "77770000-aaaa-4bbb-8ccc-000000000006"
KEEPER = 500


def keeper_chain(top_cmd="/usr/bin/python3 -I /x/eval/tools/team_plan.py up 4", top_ppid=1):
    """Сторож под launchd: team_plan.py (500) → bash spawn_session.sh (501) → lineage.py seat (502), без tty."""
    return [P(KEEPER, top_ppid, KEEPER, "??", top_cmd),
            P(501, KEEPER, KEEPER, "??", "bash /x/eval/tools/spawn_session.sh --launch --product taibe --role release"),
            P(502, 501, KEEPER, "??", "python3 -I /x/eval/tools/lineage.py seat --product taibe")]


def window_chain(top=TERMINAL):
    """«ВКЛ»: окно (Terminal или tmux) → login → zsh → agents_up.py → spawn_session.sh → seat, всё на ttys007."""
    return [P(600, 1, 600, "??", top), P(601, 600, 601, "ttys007", "login -pf u"),
            P(602, 601, 602, "ttys007", "/bin/zsh /Users/u/Desktop/Разработка ВКЛ.command"),
            P(603, 602, 602, "ttys007", "python3 -I /x/eval/tools/agents_up.py"),
            P(604, 603, 602, "ttys007", "bash /x/eval/tools/spawn_session.sh --launch --product taibe --role release"),
            P(605, 604, 602, "ttys007", "python3 -I /x/eval/tools/lineage.py seat --product taibe")]


class SeatTest(Base):
    def setUp(self):
        super().setUp()
        self.env2 = mock.patch.dict(os.environ, {"CLAUDE_PROJECTS_DIR": str(self.dir / "proj")})
        self.env2.start()
        self.hr, self.tb = self.dir / "hr", self.dir / "tb"
        for d in (self.hr, self.tb):
            (d / ".claude").mkdir(parents=True)
            (d / ".git").mkdir()
        self.roots = {"hr-helper": str(self.hr), "taibe": str(self.tb)}
        self.extra = []  # живые сессии сверх tree()
        self.talk(DEAD_TB, self.tb)
        self.talk(DEAD_TB2, self.tb / "worktrees" / "fix" / "x")
        self.talk(DEAD_HR, self.hr)
        self.sess(400, SUCC, self.tb)  # наследник 400 из tree(): claude на ttys006 под zsh окна Terminal

    def tearDown(self):
        self.env2.stop()
        super().tearDown()

    def put(self, d, control):
        (d / G.GUARD).write_text(json.dumps({"control": control}) + "\n", encoding="utf-8")

    def get(self, d):
        return json.loads((d / G.GUARD).read_text(encoding="utf-8"))["control"]

    def sess(self, pid, sid, cwd):
        L.sessions_dir().mkdir(parents=True, exist_ok=True)
        (L.sessions_dir() / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid, "procStart": ST,
                                                                  "cwd": str(cwd)}))

    def talk(self, sid, cwd):
        f = Path(os.environ["CLAUDE_PROJECTS_DIR"]) / ("-" + str(cwd).strip("/").replace("/", "-")) / f"{sid}.jsonl"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"type": "summary"}) + "\n" + json.dumps({"type": "user", "cwd": str(cwd)}) + "\n")

    def live(self, pid, sid, cwd, tty="ttys009"):
        self.extra.append(P(pid, 211, pid, tty, "claude --settings /x/genome/release.json"))
        self.sess(pid, sid, cwd)

    def sx(self, caller=None, me=502, jobs=None, env=None):
        sx = FakeSys(tree() + (caller if caller is not None else keeper_chain()) + self.extra, env=env or {400: CHILD})
        sx.me = me
        sx.job_pid = lambda label: (jobs if jobs is not None else {S.LABELS[0]: KEEPER}).get(label)
        return sx

    def run_seat(self, sx=None, product="taibe", guard=None):
        self.sxo = sx or self.sx()
        guard = [str(x) for x in (guard or [self.tb])]
        return S.seat(self.sxo, product, CHILD, "/dev/ttys006", guard, self.log, self.roots)

    def assert_untouched(self, d, control):
        self.assertEqual(self.get(d), control, self.lines)
        self.assertFalse((d / ".claude" / G.BACKUP).exists(), self.lines)

    # Приёмка карточки: в списке только мёртвые записи — мёртвая tAIBE заменена новым release, HR на месте.
    def test_keeper_replaces_dead_entry_of_product_keeps_hr(self):
        self.put(self.tb, [DEAD_TB, DEAD_HR])
        self.assertTrue(self.run_seat(), self.lines)
        self.assertEqual(self.get(self.tb), [SUCC, DEAD_HR])
        self.assertEqual(json.loads((self.tb / ".claude" / G.BACKUP).read_text())["control"], [DEAD_TB, DEAD_HR])
        self.assertFalse((G.state_dir() / G.INTENT).exists())

    def test_short_prefix_entry_is_replaced(self):
        self.put(self.tb, [DEAD_TB[:8], DEAD_HR[:8]])
        self.assertTrue(self.run_seat(), self.lines)
        self.assertEqual(self.get(self.tb), [SUCC, DEAD_HR[:8]])

    # Сегодняшний случай (17.11): HR release жив, tAIBE мёртв — живая HR-запись не мешает и не трогается.
    def test_live_hr_entry_kept_dead_tb_replaced(self):
        self.live(700, LIVE_HR, self.hr)
        self.put(self.tb, [DEAD_TB, LIVE_HR])
        self.assertTrue(self.run_seat(), self.lines)
        self.assertEqual(self.get(self.tb), [SUCC, LIVE_HR])

    # Приёмка: живая запись продукта — файл не меняется.
    def test_live_entry_of_product_no_change(self):
        self.live(700, LIVE_TB, self.tb)
        self.put(self.tb, [LIVE_TB, DEAD_HR])
        self.assertTrue(self.run_seat())
        self.assert_untouched(self.tb, [LIVE_TB, DEAD_HR])
        self.assertIn("живой Контроль", self.lines[-1])

    def test_two_dead_entries_of_product_no_change(self):
        self.put(self.tb, [DEAD_TB, DEAD_TB2])  # DEAD_TB2 — сессия в worktree tAIBE: тоже продукт taibe
        self.assertTrue(self.run_seat())
        self.assert_untouched(self.tb, [DEAD_TB, DEAD_TB2])
        self.assertIn("решает владелец", self.lines[-1])

    def test_dead_entry_without_transcript_is_not_product(self):
        self.put(self.tb, [NOBODY])
        self.assertTrue(self.run_seat())
        self.assert_untouched(self.tb, [NOBODY])
        self.assertIn("нет", self.lines[-1])

    def test_dead_entry_with_two_transcripts_is_not_product(self):
        self.talk(DEAD_TB2, self.tb)  # второй транскрипт той же сессии (worktree и корень) — продукт не ясен
        self.put(self.tb, [DEAD_TB2])
        self.assertTrue(self.run_seat())
        self.assert_untouched(self.tb, [DEAD_TB2])

    def test_agent_session_caller_refused(self):
        chain = [P(503, 302, 302, "??", "python3 -I /x/eval/tools/team_plan.py up"),  # из Bash сессии 300
                 P(502, 503, 302, "??", "python3 -I /x/eval/tools/lineage.py seat")]
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(caller=chain)))
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("агентская сессия", self.lines[-1])

    def test_orphan_caller_refused(self):
        self.put(self.tb, [DEAD_TB])  # nohup/& из Bash сессии: под launchd, но не pid задачи сторожа
        self.assertFalse(self.run_seat(self.sx(jobs={})))
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("не задача launchd", self.lines[-1])

    def test_caller_without_team_plan_refused(self):
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(caller=keeper_chain(top_cmd="/usr/bin/python3 -I /x/other.py"))))
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("team_plan.py", self.lines[-1])

    def test_login_job_allowed(self):
        self.put(self.tb, [DEAD_TB])
        chain = keeper_chain(top_cmd="/usr/bin/python3 -I /x/eval/tools/agents_up.py")
        self.assertTrue(self.run_seat(self.sx(caller=chain, jobs={S.LABELS[1]: KEEPER})), self.lines)
        self.assertEqual(self.get(self.tb), [SUCC])

    def test_vkl_in_terminal_window_allowed(self):
        self.put(self.tb, [DEAD_TB])
        self.assertTrue(self.run_seat(self.sx(caller=window_chain(), me=605, jobs={})), self.lines)
        self.assertEqual(self.get(self.tb), [SUCC])

    def test_tmux_window_refused(self):
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(caller=window_chain(top=TMUX_SERVER), me=605, jobs={})))
        self.assert_untouched(self.tb, [DEAD_TB])

    def test_window_chain_with_detached_link_refused(self):
        chain = window_chain()
        chain[3] = P(603, 602, 603, "??", "python3 -I /x/eval/tools/agents_up.py")  # звено без tty окна
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(caller=chain, me=605, jobs={})))
        self.assert_untouched(self.tb, [DEAD_TB])

    def test_successor_of_other_line_refused(self):
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(env={400: "r.zz99"})))
        self.assert_untouched(self.tb, [DEAD_TB])

    def test_successor_in_worktree_refused(self):
        self.sess(400, SUCC, self.tb / "worktrees" / "fix" / "x")
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat())
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("не в корне продукта", "\n".join(self.lines))

    def test_successor_started_from_claude_refused(self):
        self.put(self.tb, [DEAD_TB])
        sx = self.sx()
        sx.p[400] = P(400, 302, 400, "ttys006", "claude --settings /x/genome/release.json")
        self.assertFalse(self.run_seat(sx))
        self.assert_untouched(self.tb, [DEAD_TB])

    def test_live_entry_appears_under_lock_refused(self):
        self.sess(700, LIVE_TB, self.tb)  # реестр есть, процесса ещё нет: при планировании запись не живая и не наша
        self.put(self.tb, [DEAD_TB, LIVE_TB])
        sx = self.sx()
        first = sx.procs

        def procs():
            got = first()
            if sx.n_procs > 1:
                got[700] = P(700, 211, 700, "ttys009", "claude --settings /x/genome/release.json")
            return got
        sx.procs = procs
        self.assertFalse(self.run_seat(sx))
        self.assert_untouched(self.tb, [DEAD_TB, LIVE_TB])
        self.assertIn("другой живой Контроль", "\n".join(self.lines))

    # HR release: списки HR и tAIBE; мёртвая HR-запись заменяется в обоих, записи tAIBE не трогаются.
    def test_hr_release_two_folders(self):
        self.sess(400, SUCC, self.hr)
        self.put(self.hr, [DEAD_HR])
        self.put(self.tb, [DEAD_TB, DEAD_HR])
        self.assertTrue(self.run_seat(product="hr-helper", guard=[self.hr, self.tb]), self.lines)
        self.assertEqual(self.get(self.hr), [SUCC])
        self.assertEqual(self.get(self.tb), [DEAD_TB, SUCC])

    def test_no_list_no_change(self):
        self.assertTrue(self.run_seat())
        self.assertFalse((self.tb / G.GUARD).exists())

    def test_cli_wiring(self):
        self.put(self.tb, [DEAD_TB])
        out = io.StringIO()
        with mock.patch.object(TS, "product_roots", return_value=list(self.roots.items())), redirect_stdout(out):
            rc = L.main(["seat", "--product", "taibe", "--line", CHILD, "--succ-tty", "/dev/ttys006",
                         "--guard", str(self.tb), "--guard", str(self.tb)], self.sx())
        self.assertEqual(rc, 0, out.getvalue())
        self.assertEqual(self.get(self.tb), [SUCC])

    def test_job_pid_parses_launchctl(self):
        text = "gui/501/x = {\n\tstate = running\n\tpid = 4242\n\t\tpid = 1\n}\n"
        with mock.patch.object(S.subprocess, "run", return_value=mock.Mock(stdout=text)):
            self.assertEqual(S.job_pid("x"), 4242)
        with mock.patch.object(S.subprocess, "run", return_value=mock.Mock(stdout="\tstate = not running\n")):
            self.assertIsNone(S.job_pid("x"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
