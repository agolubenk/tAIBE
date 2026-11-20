#!/usr/bin/env python3
"""dev_power.py и agents_up.py --down: порядок служб (headroom первым при включении, последним при выключении);
загружается только свой plist; метки и bundle id — по спискам, в AppleScript — аргументом; Docker с контейнерами —
только с подтверждением; ярлыки, автозагрузка и сторож команды; выключение при живых
сессиях без терминала — отказ. launchctl, osascript, open, docker и pgrep подменены.

Run: python3 -I eval/tools/test_dev_power.py
"""
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agents_up as A  # noqa: E402
import dev_power as D  # noqa: E402

AGENTS = ["space.hrhelper.headroom", "space.hrhelper.agents-tmux", "space.hrhelper.nerve"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "Library" / "LaunchAgents").mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {"TAIBE_DEV_HOME": str(self.home), "TAIBE_DEV_TEST": "1",
                                                "TAIBE_TMUX_CONF_DIR": str(self.home / "conf")})
        self.env.start()
        self.calls, self.loaded, self.running, self.containers = [], set(), set(), ""
        cfg = (AGENTS, ["com.electron.ollama"], ["com.docker.docker", "com.electron.ollama"])
        self.patches = [mock.patch.object(D, "config", lambda: cfg), mock.patch.object(D, "run", self.fake_run),
                        mock.patch.object(D.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.env.stop()
        self.tmp.cleanup()

    def fake_run(self, *cmd, timeout=60):
        self.calls.append(cmd)
        out, rc = "", 0
        if cmd[:2] == ("launchctl", "print"):
            rc = 0 if cmd[2].split("/")[-1] in self.loaded else 113
        elif cmd[:2] == ("launchctl", "bootstrap"):
            self.loaded.add(Path(cmd[3]).stem)
        elif cmd[:2] == ("launchctl", "bootout"):
            self.loaded.discard(cmd[2].split("/")[-1])
        elif cmd[:2] == ("launchctl", "kickstart"):
            rc = getattr(self, "kick_rc", 0)
        elif cmd[0] == "osascript":
            bundle = cmd[-1]
            if "is running" in cmd[4]:
                out = "true" if bundle in self.running else "false"
            elif "quit" in cmd[4]:
                self.running.discard(bundle)
        elif cmd[:2] == ("docker", "ps"):
            out = self.containers
        return subprocess.CompletedProcess(cmd, rc, out, "")

    def acts(self, verb):
        return [c[-1].split("/")[-1].replace(".plist", "") for c in self.calls if c[:2] == ("launchctl", verb)]

    def own_plist(self, label, mode=0o644, lab=None):
        p = D.plist(label)
        p.write_bytes(plistlib.dumps({"Label": lab or label}))
        p.chmod(mode)


class ConfigTest(unittest.TestCase):
    def test_labels_and_bundles_by_list(self):
        sysdev = {"agents": ["space.hrhelper.nerve", "space.hrhelper../../x", "com.apple.x", "space.hrhelper.headroom"],
                  "apps_on": ['x" & (do shell script "id") & "', "com.electron.ollama"],
                  "apps_off": ["com.docker.docker", "com.evil.app"]}
        fake = mock.Mock(load=lambda: ({"system": {"dev": sysdev}}, {}))
        with mock.patch.dict(sys.modules, {"products": fake}):
            agents, on, off = D.config()
        self.assertEqual(agents, ["space.hrhelper.headroom", "space.hrhelper.nerve"])
        self.assertEqual((on, off), (["com.electron.ollama"], ["com.docker.docker"]))


class AgentsTest(Base):
    def test_on_loads_only_own_plist_headroom_first(self):
        self.own_plist("space.hrhelper.headroom")
        self.own_plist("space.hrhelper.agents-tmux", mode=0o666)  # пишут другие — не грузить
        self.own_plist("space.hrhelper.nerve", lab="space.hrhelper.other")  # Label не тот
        log = []
        D.agents_on(log.append)
        self.assertEqual(self.acts("bootstrap"), ["space.hrhelper.headroom"])
        self.assertEqual(sum("нет своего plist" in m for m in log), 2)

    def test_off_reverse_order_headroom_last(self):
        self.loaded = set(AGENTS)
        D.agents_off(lambda m: None)
        self.assertEqual(self.acts("bootout"), list(reversed(AGENTS)))

    def test_apps_bundle_is_an_argument(self):
        D.apps_on(lambda m: None)
        self.assertIn(("open", "-g", "-b", "com.electron.ollama"), self.calls)
        osa = next(c for c in self.calls if c[0] == "osascript")
        self.assertEqual((osa[-1], "com.electron.ollama" in " ".join(osa[:-1])), ("com.electron.ollama", False))

    def test_docker_with_containers_needs_yes(self):
        self.running, self.containers = {"com.docker.docker"}, "abc123\n"
        log = []
        D.apps_off(log.append, lambda q: False)
        self.assertIn("com.docker.docker", self.running)
        self.assertIn("Docker оставлен", " ".join(log))
        D.apps_off(log.append, lambda q: True)
        self.assertNotIn("com.docker.docker", self.running)


class InstallTest(Base):
    def test_install_writes_shortcuts_and_login_agent(self):
        self.assertEqual(D.install(lambda m: None), 0)
        on, off = self.home / "Desktop" / D.DESKTOP_ON, self.home / "Desktop" / D.DESKTOP_OFF
        self.assertEqual(os.stat(on).st_mode & 0o777, 0o755)
        self.assertIn("agents_up.py --down", off.read_text())
        self.assertNotIn("--down", on.read_text())
        self.assertIn("agents_up.py --attach", on.read_text())  # окно ярлыка — окно ролей
        d = plistlib.loads(D.plist(D.LABEL_UP).read_bytes())
        self.assertTrue(d["RunAtLoad"])
        self.assertNotIn("KeepAlive", d)  # один раз при входе
        self.assertTrue(d["ProgramArguments"][-1].endswith("agents_up.py"))
        self.assertEqual(self.acts("bootstrap"), [D.LABEL_KEEPER, D.LABEL_UP])
        keeper = plistlib.loads(D.plist(D.LABEL_KEEPER).read_bytes())
        self.assertEqual((keeper["StartInterval"], keeper["ProgramArguments"][-2:]), (600, ["up", "4"]))

    def test_uninstall(self):
        D.install(lambda m: None)
        D.uninstall(lambda m: None)
        self.assertFalse((self.home / "Desktop" / D.DESKTOP_ON).exists())
        self.assertFalse(D.plist(D.LABEL_UP).exists())
        self.assertFalse(D.plist(D.LABEL_KEEPER).exists())

    def test_dev_home_only_in_tests(self):
        with mock.patch.dict(os.environ, {"TAIBE_DEV_TEST": ""}):
            self.assertEqual(D.home(), Path.home())


class DownTest(Base):
    def down(self, live, tty, answer="n"):
        with mock.patch.object(A.TS, "live_sessions", lambda sx: live), \
                mock.patch.object(A.T, "tmux", lambda *a: subprocess.CompletedProcess(a, 0, "taibe:coord-ab12\nops:hub\n", "")), \
                mock.patch.object(sys.stdin, "isatty", lambda: tty), mock.patch("builtins.input", lambda p: answer), \
                mock.patch("builtins.print"):
            return A.down(False)

    def test_live_sessions_without_terminal_refuse(self):
        self.assertEqual(self.down(2, tty=False), 1)
        self.assertEqual(self.acts("bootout"), [])

    def test_answer_no_cancels(self):
        self.assertEqual(self.down(1, tty=True, answer="n"), 1)
        self.assertEqual(self.acts("bootout"), [])


class Attach(Base):
    """Ярлык «ВКЛ» (--attach): роли — в фоне, окно ярлыка — окно ролей tmux; ✗ в сводке — сначала Enter."""

    def up(self, summary=0, server="1:2", tmux_env=None, tty=True):
        self.execs, self.bg, self.asked, self.team_up = [], [], [], []
        with mock.patch.dict(os.environ, {}), \
                mock.patch.object(A.D, "agents_on", lambda log: None), mock.patch.object(A.D, "apps_on", lambda log: None), \
                mock.patch.object(A.T, "ensure", lambda: 1), mock.patch.object(A, "port_open", lambda port: True), \
                mock.patch.object(A, "summary", lambda: summary), mock.patch.object(A.T, "server_info", lambda: server), \
                mock.patch.object(A.TP, "up", lambda log: self.team_up.append(1)), \
                mock.patch.object(A.subprocess, "Popen", lambda cmd, **kw: self.bg.append((cmd, kw))), \
                mock.patch.object(A.os, "execvp", lambda f, args: self.execs.append(args)), \
                mock.patch.object(sys.stdin, "isatty", lambda: tty), \
                mock.patch("builtins.input", getattr(self, "input_hook", None) or self.asked.append), \
                mock.patch("builtins.print"):
            os.environ.pop("TMUX", None)
            if tmux_env:
                os.environ["TMUX"] = tmux_env
            return A.main(["--attach"])

    def test_team_in_background_then_attach(self):
        """Роли открывает задача launchd входа (dev-up): release от неё получает Контроль (SE-155, Claude-линза #457 B1)."""
        self.up()
        self.assertEqual(self.team_up, [])  # не ждёт открытия ролей
        self.assertEqual([c for c in self.calls if c[:2] == ("launchctl", "kickstart")],
                         [("launchctl", "kickstart", f"gui/{os.getuid()}/{D.LABEL_UP}")])  # без -k: работающую не рвёт
        self.assertEqual(self.bg, [])
        self.assertEqual(self.execs, [[A.T.tmux_bin(), "-L", A.T.socket(), "attach"]])
        self.assertEqual(self.asked, [])
        self.assertTrue((self.home / "conf" / f"{A.T.socket()}.attach").exists())  # роли не откроют второе окно

    def test_job_not_started_team_in_detached_background(self):
        self.kick_rc = 113  # задачи dev-up нет (не установлена): роли всё равно открываются, Контроль — s-пунктом
        self.up()
        (cmd, kw), = self.bg
        self.assertEqual(cmd[-2:], [str(Path(A.__file__).resolve().parent / "team_plan.py"), "up"])
        self.assertTrue(kw["start_new_session"])  # закрытое окно не обрывает открытие ролей
        self.assertEqual(len(self.execs), 1)

    def test_failed_summary_waits_for_enter(self):
        self.up(summary=1)
        self.assertEqual(len(self.asked), 1)
        self.assertEqual(len(self.execs), 1)

    def test_ctrl_c_at_enter_no_attach(self):
        def stop(prompt):
            raise KeyboardInterrupt
        self.input_hook = stop
        self.assertEqual(self.up(summary=1), 1)
        self.assertEqual(self.execs, [])

    def test_no_server_no_attach(self):
        self.assertEqual(self.up(server=None), 1)
        self.assertEqual(self.execs, [])

    def test_inside_tmux_no_nested_attach(self):
        self.assertEqual(self.up(tmux_env="/tmp/tmux-501/default,1,0"), 0)
        self.assertEqual(self.execs, [])

    def test_login_agent_keeps_team_in_foreground(self):
        with mock.patch.object(A.D, "agents_on", lambda log: None), mock.patch.object(A.D, "apps_on", lambda log: None), \
                mock.patch.object(A.T, "ensure", lambda: 1), mock.patch.object(A, "port_open", lambda port: True), \
                mock.patch.object(A, "summary", lambda: 0), mock.patch.object(A.os, "execvp", self.fail), \
                mock.patch.object(A.subprocess, "Popen", self.fail), mock.patch("builtins.print"):
            ran = []
            with mock.patch.object(A.TP, "up", lambda log: ran.append(1)):
                self.assertEqual(A.main([]), 0)
        self.assertEqual(ran, [1])


if __name__ == "__main__":
    unittest.main()
