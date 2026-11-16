#!/usr/bin/env python3
"""dev_power.py и agents_up.py --down: порядок служб (headroom первым при включении, последним при выключении),
снятые службы загружаются обратно, без plist — пропуск; приложения; ярлыки и автозагрузка; выключение при живых
сессиях без терминала — отказ. launchctl, osascript и open подменены.

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

AGENTS = ["space.hrhelper.nerve", "space.hrhelper.headroom", "space.hrhelper.agents-tmux", "evil.agent"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "Library" / "LaunchAgents").mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {"TAIBE_DEV_HOME": str(self.home)})
        self.env.start()
        self.calls, self.loaded, self.running = [], set(), set()
        cfg = (sorted([a for a in AGENTS if a.startswith("space.hrhelper.")], key=lambda a: a != D.FIRST),
               ["com.electron.ollama"], ["com.docker.docker", "com.electron.ollama"])
        self.patches = [mock.patch.object(D, "config", lambda: cfg), mock.patch.object(D, "run", self.fake_run)]
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
        elif cmd[0] == "osascript" and "is running" in cmd[2]:
            out = "true" if cmd[2].split('"')[1] in self.running else "false"
        return subprocess.CompletedProcess(cmd, rc, out, "")

    def acts(self, verb):
        return [c[-1].split("/")[-1].replace(".plist", "") for c in self.calls if c[:2] == ("launchctl", verb)]


class AgentsTest(Base):
    def test_on_loads_only_unloaded_with_plist_headroom_first(self):
        for a in ("space.hrhelper.headroom", "space.hrhelper.nerve"):
            (self.home / "Library" / "LaunchAgents" / f"{a}.plist").write_text("x")
        self.loaded = {"space.hrhelper.nerve"}
        log = []
        D.agents_on(log.append)
        self.assertEqual(self.acts("bootstrap"), ["space.hrhelper.headroom"])
        self.assertIn("space.hrhelper.agents-tmux: нет plist", " ".join(log))

    def test_off_reverse_order_headroom_last(self):
        self.loaded = {"space.hrhelper.headroom", "space.hrhelper.agents-tmux", "space.hrhelper.nerve"}
        D.agents_off(lambda m: None)
        self.assertEqual(self.acts("bootout")[-1], "space.hrhelper.headroom")
        self.assertEqual(len(self.acts("bootout")), 3)

    def test_apps(self):
        D.apps_on(lambda m: None)
        self.assertIn(("open", "-g", "-b", "com.electron.ollama"), self.calls)
        self.running = {"com.docker.docker"}
        self.calls.clear()
        D.apps_off(lambda m: None)
        quits = [c[2] for c in self.calls if c[0] == "osascript" and "quit" in c[2]]
        self.assertEqual(quits, ['tell application id "com.docker.docker" to quit'])


class InstallTest(Base):
    def test_install_writes_shortcuts_and_login_agent(self):
        self.assertEqual(D.install(lambda m: None), 0)
        on, off = self.home / "Desktop" / D.DESKTOP_ON, self.home / "Desktop" / D.DESKTOP_OFF
        self.assertEqual(os.stat(on).st_mode & 0o777, 0o755)
        self.assertIn("agents_up.py --down", off.read_text())
        self.assertNotIn("--down", on.read_text())
        d = plistlib.loads(D.plist(D.LABEL_UP).read_bytes())
        self.assertTrue(d["RunAtLoad"])
        self.assertNotIn("KeepAlive", d)  # один раз при входе
        self.assertTrue(d["ProgramArguments"][-1].endswith("agents_up.py"))
        self.assertEqual(self.acts("bootstrap"), [D.LABEL_UP])

    def test_uninstall(self):
        D.install(lambda m: None)
        D.uninstall(lambda m: None)
        self.assertFalse((self.home / "Desktop" / D.DESKTOP_ON).exists())
        self.assertFalse(D.plist(D.LABEL_UP).exists())


class DownTest(Base):
    def test_live_sessions_without_terminal_refuse(self):
        with mock.patch.object(A.TS, "live_sessions", lambda sx: 2), \
                mock.patch.object(A.T, "tmux", lambda *a: subprocess.CompletedProcess(a, 0, "taibe\nops\n", "")), \
                mock.patch.object(sys.stdin, "isatty", lambda: False), mock.patch("builtins.print"):
            self.assertEqual(A.down(False), 2)
        self.assertEqual(self.acts("bootout"), [])

    def test_answer_no_cancels(self):
        with mock.patch.object(A.TS, "live_sessions", lambda sx: 1), \
                mock.patch.object(A.T, "tmux", lambda *a: subprocess.CompletedProcess(a, 0, "", "")), \
                mock.patch.object(sys.stdin, "isatty", lambda: True), mock.patch("builtins.input", lambda p: "n"), \
                mock.patch("builtins.print"):
            self.assertEqual(A.down(False), 1)
        self.assertEqual(self.acts("bootout"), [])


if __name__ == "__main__":
    unittest.main()
