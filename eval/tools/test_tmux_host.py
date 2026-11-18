#!/usr/bin/env python3
"""tmux_host.py (OPS-82): окно роли, метки «ждёт», переход к ждущему, закрытие панели только своей линии, конфиг и
LaunchAgent без окружения сессии. tmux подменён (TAIBE_TMUX — скрипт, отвечает по spec.json и пишет вызовы в
calls.log рядом с собой); launchd не трогается (TAIBE_TMUX_SERVICE=off).

Run: python3 -I eval/tools/test_tmux_host.py
"""
import json
import os
import plistlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lineage as L  # noqa: E402
import tmux_host as T  # noqa: E402
from test_lineage import FakeSys, P  # noqa: E402

# Подставной tmux: ключ — подкоманда (у list-panes ещё формат: ids или wait), значение — [stdout, код]. Ответы и журнал —
# файлы рядом с ним: окружение клиента tmux_host урезает (client_env), переменные теста до него не доходят.
FAKE = r"""#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
a = sys.argv[3:]  # после -L <сокет>
with open(os.path.join(here, "calls.log"), "a") as f:
    f.write(json.dumps(a) + "\n")
with open(os.path.join(here, "spec.json")) as f:
    spec = json.load(f)
key = a[0] if a else ""
if key == "list-panes":
    key += ":wait" if any("@wait" in x for x in a) else ":ids"
out, rc = spec.get(key, ["", 0])
sys.stdout.write(out)
sys.exit(rc)
"""
SERVER = ["100:200\n", 0]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        fake = d / "tmux"
        fake.write_text(FAKE, encoding="utf-8")
        fake.chmod(0o755)
        self.log, self.spec_file = d / "calls.log", d / "spec.json"
        self.spec_file.write_text("{}")
        self.env = mock.patch.dict(os.environ, {
            "TAIBE_TMUX": str(fake), "TAIBE_TMUX_SOCKET": "agents-test", "TAIBE_TMUX_SERVICE": "off",
            "TAIBE_TMUX_CONF_DIR": str(d / "conf"), "CLAUDE_SESSIONS_DIR": str(d / "sess")})
        self.env.start()
        self.lines = []

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def spec(self, **kw):
        spec = {k.replace("_", "-").replace("-wait", ":wait").replace("-ids", ":ids"): v for k, v in kw.items()}
        self.spec_file.write_text(json.dumps(spec))

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def subs(self):
        return [c[0] for c in self.calls()]


class OpenTest(Base):
    def launcher(self, second="unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE", mode=0o700):
        d = Path(tempfile.mkdtemp(prefix="claude-spawn.", dir=self.tmp.name))
        f = d / "coord.sh"
        f.write_text(f"#!/bin/bash\n{second}\nexec claude\n", encoding="utf-8")
        f.chmod(mode)
        return str(f)

    def run_open(self, launcher=None):
        with mock.patch("sys.stdout.write") as w, mock.patch("sys.stderr.write"):
            rc = T.open_window("taibe", "taibe-coord-ab12", "/w", launcher or self.launcher())
        return rc, "".join(c.args[0] for c in w.call_args_list)

    def test_only_spawn_launcher_runs(self):
        """open — не запуск произвольной команды мимо merge-guard: только пусковой скрипт spawn_session.sh."""
        self.spec(display_message=SERVER, has_session=["", 0], new_window=["@2 %2 /dev/ttys002 556\n", 0])
        for bad in (self.launcher(second="tmux -L agents send-keys -t x y"), self.launcher(mode=0o755),
                    "/bin/bash", "tmux send-keys -t x y"):
            self.assertEqual(self.run_open(bad)[0], 2, bad)
        self.assertEqual(self.calls(), [])

    def test_attach_asked_once_while_terminal_starts(self):
        self.spec(display_message=SERVER, has_session=["", 0], new_window=["@2 %2 /dev/ttys002 556\n", 0])
        first, second = self.run_open()[1], self.run_open()[1]
        self.assertEqual((len(first.splitlines()), len(second.splitlines())), (2, 1))

    def test_first_role_creates_product_session_and_asks_to_attach(self):
        self.spec(display_message=SERVER, has_session=["", 1], new_session=["@1 %1 /dev/ttys001 555\n", 0])
        rc, out = self.run_open()
        self.assertEqual(rc, 0)
        self.assertEqual(out.splitlines(), ["@1 %1 /dev/ttys001 555 100:200",
                                            f"{T.tmux_bin()} -L agents-test attach -t '=taibe'"])
        new = next(c for c in self.calls() if c[0] == "new-session")
        self.assertEqual(new[new.index("-s") + 1], "taibe")
        self.assertEqual(new[new.index("-n") + 1], "coord-ab12")
        self.assertRegex(new[-1], r"^exec \S+ -l -i -c '/bin/bash .*claude-spawn\.")  # оболочка входа: ~/.zshrc
        conf = (Path(os.environ["TAIBE_TMUX_CONF_DIR"]) / "agents-test.conf").read_text()
        self.assertIn('set -g update-environment ""', conf)

    def test_next_role_is_a_window_and_attached_owner_gets_no_second_window(self):
        self.spec(display_message=SERVER, has_session=["", 0], new_window=["@2 %2 /dev/ttys002 556\n", 0],
                  list_clients=["/dev/ttys009: taibe\n", 0])
        rc, out = self.run_open()
        self.assertEqual((rc, out.splitlines()), (0, ["@2 %2 /dev/ttys002 556 100:200"]))
        new = next(c for c in self.calls() if c[0] == "new-window")
        self.assertEqual(new[new.index("-t") + 1], "=taibe:")
        self.assertIn("-d", new)  # окно не отнимает фокус у владельца
        self.assertNotIn("new-session", self.subs())

    def test_window_not_opened(self):
        self.spec(display_message=SERVER, has_session=["", 0], new_window=["", 1])
        self.assertEqual(self.run_open()[0], 1)

    def test_half_opened_window_is_closed(self):
        self.spec(display_message=SERVER, has_session=["", 0], new_window=["@2 %2\n", 0])
        self.assertEqual(self.run_open()[0], 1)
        self.assertIn(["kill-pane", "-t", "%2"], self.calls())  # без записи линии его потом не закрыть

    def test_dead_server_is_started(self):
        self.spec(display_message=["no server running on /tmp/tmux-501/agents-test\n", 1])
        with mock.patch.object(T, "SERVICE_WAIT", 0.3):
            self.assertEqual(self.run_open()[0], 1)
        self.assertTrue(any(c[-1] == "start-server" and "-f" in c for c in self.calls()))  # без launchd — прямой старт
        self.assertNotIn("new-session", self.subs())

    def test_live_server_that_does_not_answer_is_left_alone(self):
        """brew upgrade tmux: клиент новой версии не говорит со старым сервером — роли живы, сервер не трогать."""
        self.spec(display_message=["protocol version mismatch (client 9, server 8)\n", 1])
        self.assertEqual(self.run_open()[0], 1)
        self.assertFalse(any("start-server" in c for c in self.calls()))

    def test_no_tmux_binary_no_service(self):
        with mock.patch.dict(os.environ, {"TAIBE_TMUX": "/nonexistent/tmux"}), mock.patch("sys.stderr.write"):
            self.assertEqual(T.ensure(), 1)
        self.assertFalse((Path(os.environ["TAIBE_TMUX_CONF_DIR"]) / "agents-test.conf").exists())


class ClosePaneTest(Base):
    REC = {"terminal": "tmux", "pane": "%7", "tty": "/dev/ttys005", "pane_pid": "4242", "server": "100:200"}

    def close(self, panes, rec=None, tty="/dev/ttys005"):
        self.spec(display_message=SERVER, list_panes_ids=[panes, 0])
        return T.close_pane(rec or self.REC, tty, self.lines.append)

    def test_same_pane_is_killed(self):
        self.assertTrue(self.close("%7 /dev/ttys005 4242\n%8 /dev/ttys006 4300\n"))
        self.assertIn(["kill-pane", "-t", "%7"], self.calls())

    def test_other_pane_with_the_same_id_is_kept(self):
        for panes, rec in [("%7 /dev/ttys005 9999\n", None),                       # другая пусковая оболочка
                           ("%7 /dev/ttys005 4242\n", {**self.REC, "server": "1:1"}),  # сервер перезапущен
                           ("%7 /dev/ttys011 4242\n", None)]:                       # другой tty
            self.assertFalse(self.close(panes, rec))
            self.assertNotIn("kill-pane", self.subs())

    def test_session_tty_must_match_the_record(self):
        self.assertFalse(self.close("%7 /dev/ttys005 4242\n", tty="/dev/ttys006"))
        self.assertNotIn("kill-pane", self.subs())

    def test_missing_pane_is_success_without_kill(self):
        self.assertTrue(self.close("%8 /dev/ttys006 4300\n"))
        self.assertNotIn("kill-pane", self.subs())

    def test_record_without_pane_id_is_kept(self):
        self.assertFalse(self.close("%7 /dev/ttys005 4242\n", rec={"terminal": "tmux", "tty": "/dev/ttys005"}))
        self.assertEqual(self.calls(), [])


class StatusTest(Base):
    def test_marks_and_summary(self):
        sess = Path(os.environ["CLAUDE_SESSIONS_DIR"])
        sess.mkdir()
        L.write_json(sess / "500.json", {"pid": 500, "status": "waiting"})
        L.write_json(sess / "501.json", {"pid": 501, "status": "idle"})
        L.write_json(sess / "502.json", {"pid": 502, "status": "busy"})
        sx = FakeSys([P(500, 1, 500, "ttys001", "claude --name taibe-coord-ab12"),
                      P(501, 1, 501, "ttys002", "claude --name taibe-plan-cd34"),
                      P(502, 1, 502, "ttys003", "claude --name taibe-backend-ef56")])
        self.spec(list_panes_wait=["@1\t/dev/ttys001\t\n@2\t/dev/ttys002\ti\n@3\t/dev/ttys003\tw\n", 0])
        with mock.patch("builtins.print") as pr:
            T.status_line(sx)
        sets = next(c for c in self.calls() if c[0] == "set-option")
        self.assertEqual(sets, ["set-option", "-w", "-t", "@1", "@wait", "w", ";",
                                "set-option", "-w", "-t", "@3", "@wait", ""])  # @2 уже «i» — не трогаем
        self.assertEqual(pr.call_args.args[0], "! 1 ждут · 1 свободны · ролей в tmux 3")

    def test_next_waiting_wraps_and_prefers_waiting(self):
        self.spec(list_windows=["@1\ti\n@2\tw\n@3\t\n@4\tw\n", 0])
        T.next_waiting("/dev/ttys009", "@2")
        T.next_waiting("/dev/ttys009", "@4")
        self.assertEqual([c[-1] for c in self.calls() if c[0] == "switch-client"], ["@4", "@2"])

    def test_nobody_waits(self):
        self.spec(list_windows=["@1\t\n@2\t\n", 0])
        T.next_waiting("/dev/ttys009", "@1")
        self.assertEqual(self.subs()[-1], "display-message")


class OpsTest(Base):
    """agents_up.py: окна сервисов — только чтение; повторный запуск не множит окна, сменённую команду обновляет."""

    def test_ops_windows_are_read_only_views(self):
        import agents_up as A
        for name, cmd in A.ops_windows():
            self.assertRegex(cmd, r"^(tail -n 40 -F |while :; do )", name)

    def test_rerun_keeps_same_windows_and_respawns_changed(self):
        import agents_up as A
        import hashlib
        shell = __import__("shlex").quote(os.environ.get("SHELL") or "/bin/zsh")
        rows = []
        for k, (name, cmd) in enumerate(A.ops_windows()):
            run = f"exec {shell} -l -c {__import__('shlex').quote(cmd)}"
            tag = "old" if name == "nerve" else hashlib.sha1(run.encode()).hexdigest()[:12]
            rows.append(f"@{k}\t{name}\t{tag}")
        self.spec(list_windows=["\n".join(rows) + "\n", 0], has_session=["", 0])
        A.open_ops()
        subs = self.subs()
        self.assertNotIn("new-window", subs)
        self.assertEqual([c[3] for c in self.calls() if c[0] == "respawn-window"], ["@2"])  # только nerve


class ServiceTest(Base):
    def test_conf(self):
        conf = T.conf_text("/usr/bin/python3", Path("/r/eval/tools"))
        for want in ("set -g exit-empty off", 'set -g update-environment ""', "set -g remain-on-exit off",
                     'set -g status-left "[#S] Ctrl+b: w окна, d выйти "',
                     "#(/usr/bin/python3 -I /r/eval/tools/tmux_host.py status-line)",
                     "bind-key j run-shell -b \"/usr/bin/python3 -I /r/eval/tools/tmux_host.py next "
                     "'#{client_name}' '#{window_id}'\""):
            self.assertIn(want, conf)

    def test_plist_carries_no_session_env(self):
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1", "TAIBE_LINEAGE": "r.x", "LANG": "C"}):
            d = plistlib.loads(T.plist_bytes(Path("/c/agents.conf")))
        self.assertEqual(set(d["EnvironmentVariables"]), {"PATH", "LANG"})
        self.assertEqual(d["EnvironmentVariables"]["LANG"], "en_US.UTF-8")  # tmux без UTF-8 ломает кириллицу
        self.assertEqual(d["ProgramArguments"][1:], ["-D", "-L", "agents-test", "-f", "/c/agents.conf"])
        self.assertEqual(d["KeepAlive"], {"SuccessfulExit": False})  # kill-server владельца сервер не поднимает

    def test_client_env_drops_tmux_and_session_markers(self):
        with mock.patch.dict(os.environ, {"TMUX": "/tmp/x,1,0", "CLAUDECODE": "1", "TAIBE_LINEAGE": "r.x"}):
            env = T.client_env()
        self.assertFalse({"TMUX", "CLAUDECODE", "TAIBE_LINEAGE"} & set(env))

    def test_names_are_safe_targets(self):
        self.assertEqual(T.tmux_name("hr-helper.v2:x y"), "hr-helper-v2-x-y")

    def test_default_terminal_is_known(self):
        self.assertIn(T.default_terminal(), T.TERMINALS)


if __name__ == "__main__":
    unittest.main()
