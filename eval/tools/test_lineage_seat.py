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
REAL_ENV_PROBLEM = G.env_problem  # Base подменяет её: реестр теста — из окружения
KEEPER = 500
TOOLS, GENOME = "/x/eval/tools", "/x/eval/pipeline/genome"
PYTHON = "/Library/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python"
# Пусковой скрипт release под окном наследника (tree(): zsh 211 на ttys006) — как spawn_session.sh в tmux и Terminal
LAUNCH = P(212, 211, 212, "ttys006", "/bin/bash /var/folders/T//claude-spawn.w8u1L3/release.sh")


def release_cmd(genome="taibe/release.json", product="taibe", tail=" Сборка Т3, ключ реестра release, роль 5."):
    """argv release, как пишет spawn_session.sh: геном, имя <продукт>-release-<хвост линии>, первое сообщение."""
    return f"claude --settings {GENOME}/{genome} --name {product}-release-{CHILD.rsplit('.', 1)[-1]}{tail}"


def fake_exe(p):
    """Путь файла по ядру у поддельного процесса: bash и python — системные, остальное — первое слово argv."""
    if p is None:
        return None
    a0 = p.command.split()[0]
    name = os.path.basename(a0)
    if name == "bash":
        return "/bin/bash"
    if name.lower().startswith("python"):
        return PYTHON
    return a0 if a0.startswith("/") else "/usr/bin/" + name


def keeper_chain(top_cmd="/usr/bin/python3 -I /x/eval/tools/team_plan.py up 4", top_ppid=1):
    """Сторож под launchd: team_plan.py (500) → bash spawn_session.sh (501) → lineage.py seat (502), без tty."""
    return [P(KEEPER, top_ppid, KEEPER, "??", top_cmd),
            P(501, KEEPER, KEEPER, "??", "bash /x/eval/tools/spawn_session.sh --launch --product taibe --role release"),
            P(502, 501, KEEPER, "??", "python3 -I /x/eval/tools/lineage.py seat --product taibe")]


def window_chain(top=TERMINAL):
    """Окно (Terminal или tmux) → login → zsh → agents_up.py → spawn_session.sh → seat, всё на ttys007. Не пропуск:
    окно Terminal открывает и агент (osascript); «ВКЛ» роли открывает задачей launchd входа (Claude-линза #457, B1)."""
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
        self.exes = {}   # pid → путь файла по ядру, если не тот, что даёт argv (поддельный argv)
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

    def sx(self, caller=None, me=502, jobs=None, env=None, genome="taibe/release.json", product="taibe"):
        procs = [p._replace(command=release_cmd(genome, product)) if p.pid == 400 else p
                 for p in tree(successor_parent=212)]
        sx = FakeSys(procs + [LAUNCH] + (caller if caller is not None else keeper_chain()) + self.extra,
                     env=env or {400: CHILD})
        sx.me, sx.tools = me, TOOLS
        sx.exe_path = lambda pid: self.exes.get(pid) or fake_exe(sx.p.get(pid))
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

    def test_launchd_job_must_be_the_caller_itself(self):
        """Задача сторожа запустила процесс, а уже он — team_plan.py up: вызов не задача launchd, отказ."""
        chain = keeper_chain()
        chain.insert(1, P(503, KEEPER, KEEPER, "??", "/usr/bin/python3 -I /x/eval/tools/team_plan.py up 4"))
        chain[2] = chain[2]._replace(ppid=503)
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(caller=chain)))
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("не задача launchd", self.lines[-1])

    def test_login_job_and_vkl_attach_allowed(self):
        """Задача входа dev-up (argv из её plist): при входе в систему и по «ВКЛ» — agents_up.py --attach запускает её
        (team_bg → launchctl kickstart, Claude-линза #457, B1)."""
        self.put(self.tb, [DEAD_TB])
        chain = keeper_chain(top_cmd="/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 -I "
                                     "/x/eval/tools/agents_up.py")
        self.assertTrue(self.run_seat(self.sx(caller=chain, jobs={S.LABELS[1]: KEEPER})), self.lines)
        self.assertEqual(self.get(self.tb), [SUCC])

    def test_attach_fallback_background_refused(self):
        """Задача dev-up не запустилась — team_bg открывает роли прежним фоном (setsid): Контроль — s-пунктом."""
        bg = "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 -I -u /x/eval/tools/team_plan.py up"
        closed = keeper_chain(top_cmd=bg)  # окно ярлыка закрыто: фон под launchd, но не pid задачи
        win = window_chain()[:3] + [
            P(603, 602, 602, "ttys007", "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 -I "
                                        "/x/eval/tools/agents_up.py --attach"),
            P(606, 603, 606, "??", bg),
            P(604, 606, 606, "??", "bash /x/eval/tools/spawn_session.sh --launch --product taibe --role release"),
            P(605, 604, 606, "??", "python3 -I /x/eval/tools/lineage.py seat --product taibe")]
        for name, chain, me in (("окно закрыто", closed, 502), ("окно открыто", win, 605)):
            with self.subTest(name):
                self.put(self.tb, [DEAD_TB])
                self.assertFalse(self.run_seat(self.sx(caller=chain, me=me, jobs={S.LABELS[1]: 99999})))
                self.assert_untouched(self.tb, [DEAD_TB])

    def test_terminal_and_tmux_window_refused(self):
        for top in (TERMINAL, TMUX_SERVER):
            with self.subTest(top):
                self.put(self.tb, [DEAD_TB])
                self.assertFalse(self.run_seat(self.sx(caller=window_chain(top=top), me=605, jobs={})))
                self.assert_untouched(self.tb, [DEAD_TB])
                self.assertIn("не задача launchd", self.lines[-1])

    def test_chain_link_replaced_after_snapshot_refused(self):
        """Снимок ps раньше чтения путей и задач launchd: звено ушло, pid занял другой процесс (N5)."""
        self.put(self.tb, [DEAD_TB])
        sx = self.sx()
        sx.alive = lambda p: p.pid != KEEPER
        self.assertFalse(self.run_seat(sx))
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("сменилось", self.lines[-1])

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
        sx.p[400] = P(400, 302, 400, "ttys006", release_cmd())
        self.assertFalse(self.run_seat(sx))
        self.assert_untouched(self.tb, [DEAD_TB])

    # Claude-линза #457, B1: слово team_plan.py в argv и подстрока /Terminal.app/ больше не пропуск.
    def test_sh_c_with_caller_word_in_terminal_window_refused(self):
        chain = window_chain()[:3] + [
            P(603, 602, 602, "ttys007", "sh -c python3 -I /x/eval/tools/lineage.py seat team_plan.py"),
            P(605, 603, 602, "ttys007", "python3 -I /x/eval/tools/lineage.py seat --product taibe")]
        self.put(self.tb, [DEAD_TB])
        self.assertFalse(self.run_seat(self.sx(caller=chain, me=605, jobs={})))
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("родитель seat", self.lines[-1])

    def test_faked_argv_refused_by_kernel_path(self):
        """argv любого звена задаёт execv: путь файла по ядру решает. spawn — bash из /tmp, вызов — sh или python из
        $HOME под argv python."""
        for pid, exe in ((501, "/private/tmp/x/bash"), (KEEPER, "/bin/sh"), (KEEPER, "/Users/u/bin/python3")):
            with self.subTest(pid=pid, exe=exe):
                self.exes = {pid: exe}
                self.put(self.tb, [DEAD_TB])
                self.assertFalse(self.run_seat(self.sx()))
                self.assert_untouched(self.tb, [DEAD_TB])

    def test_spawn_and_caller_argv_by_position(self):
        spawn = "bash /x/eval/tools/spawn_session.sh --launch --product taibe --role release"
        bad = {1: [spawn.replace("release", "backend"), spawn.replace(" --launch", ""),
                   spawn.replace("/x/eval/tools", "/x/worktrees/fix/a/eval/tools"), spawn + " --role release"],
               0: ["/usr/bin/python3 -I /x/eval/tools/team_plan.py down", "/usr/bin/python3 -I eval/tools/team_plan.py up",
                   "/usr/bin/python3 /x/eval/tools/team_plan.py up", "/usr/bin/python3 -I /x/other.py team_plan.py up",
                   # путь — значение опции, а исполняется ./up из cwd
                   "/usr/bin/python3 -W /x/eval/tools/team_plan.py up", "/usr/bin/python3 -X /x/eval/tools/agents_up.py"]}
        for i, cmds in bad.items():
            for cmd in cmds:
                with self.subTest(cmd):
                    chain = keeper_chain()
                    chain[i] = chain[i]._replace(command=cmd)
                    self.put(self.tb, [DEAD_TB])
                    self.assertFalse(self.run_seat(self.sx(caller=chain)))
                    self.assert_untouched(self.tb, [DEAD_TB])

    def test_successor_bound_to_release_launcher_and_genome(self):
        cases = [("геном backend", lambda sx: sx.p.update({400: sx.p[400]._replace(command=release_cmd("taibe/backend.json"))})),
                 ("геном HR для tAIBE", lambda sx: sx.p.update({400: sx.p[400]._replace(command=release_cmd("release.json"))})),
                 ("пусковой скрипт backend", lambda sx: sx.p.update({212: LAUNCH._replace(command=LAUNCH.command.replace(
                     "release.sh", "backend.sh"))})),
                 ("claude прямо под zsh окна", lambda sx: sx.p.update({400: sx.p[400]._replace(ppid=211)})),
                 ("пусковой скрипт не системным bash", lambda sx: self.exes.update({212: "/private/tmp/bash"})),
                 # B2: флаги сверх тех, что пишет spawn_session.sh; --resume оставил бы выбранный sessionId
                 ("--resume", lambda sx: sx.p.update({400: sx.p[400]._replace(command=release_cmd(
                     tail=f" Сборка Т3 --resume {SUCC}"))})),
                 ("флаг до текста", lambda sx: sx.p.update({400: sx.p[400]._replace(command=release_cmd(
                     tail=" -c Сборка Т3"))})),
                 ("без текста", lambda sx: sx.p.update({400: sx.p[400]._replace(command=release_cmd(tail=""))})),
                 ("имя другой линии", lambda sx: sx.p.update({400: sx.p[400]._replace(
                     command=release_cmd().replace("-release-cd34", "-release-zz99"))})),
                 ("имя другого продукта", lambda sx: sx.p.update({400: sx.p[400]._replace(
                     command=release_cmd(product="hr-helper"))})),
                 ("без --name", lambda sx: sx.p.update({400: sx.p[400]._replace(
                     command=release_cmd().replace("--name ", ""))}))]
        for name, spoil in cases:
            with self.subTest(name):
                self.exes = {}
                sx = self.sx()
                spoil(sx)
                self.put(self.tb, [DEAD_TB])
                self.assertFalse(self.run_seat(sx))
                self.assert_untouched(self.tb, [DEAD_TB])

    def test_tools_dir_only_in_main_checkout(self):
        (self.tb / "eval" / "tools").mkdir(parents=True)
        with mock.patch.object(S, "__file__", str(self.tb / "eval" / "tools" / "lineage_seat.py")):
            self.assertEqual(S.tools_dir(object()), os.path.realpath(self.tb / "eval" / "tools"))
        copy = self.dir / "copy" / "eval" / "tools"
        copy.mkdir(parents=True)
        with mock.patch.object(S, "__file__", str(copy / "lineage_seat.py")):
            self.assertIsNone(S.tools_dir(object()))

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
        self.assertTrue(self.run_seat(self.sx(genome="release.json", product="hr-helper"), product="hr-helper",
                                      guard=[self.hr, self.tb]),
                        self.lines)
        self.assertEqual(self.get(self.hr), [SUCC])
        self.assertEqual(self.get(self.tb), [DEAD_TB, SUCC])

    # SE-167, Claude-линза #457 B2: CLAUDE_SESSIONS_DIR и CLAUDE_PROJECTS_DIR подменили бы реестр и транскрипты.
    def test_registry_from_environment_refused(self):
        self.put(self.tb, [DEAD_TB])
        with mock.patch.object(G, "env_problem", REAL_ENV_PROBLEM):  # окружение теста: папки реестра заданы
            self.assertFalse(self.run_seat())
        self.assert_untouched(self.tb, [DEAD_TB])
        self.assertIn("CLAUDE_SESSIONS_DIR", self.lines[-1])

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
