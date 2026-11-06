#!/usr/bin/env python3
"""lineage_auto.py: критерии автоуборки (reap --auto) и само-закрытие окна (autoclose) — на подставных данных.

Процессы, osascript, git status и часы — FakeSys из test_lineage; окна и процессы не трогаются. Интеграция
пускового скрипта — под `script` (свой pty), claude = /usr/bin/true, osascript — заглушка, пишущая аргументы в файл.
Run: python3 -I eval/tools/test_lineage_auto.py
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lineage as L  # noqa: E402
import lineage_auto as A  # noqa: E402
from test_lineage import ST, TERMINAL, Base, FakeSys, P  # noqa: E402

NOW = 1.8e9                                   # часы FakeSys (с от эпохи)
TERM_START = "Thu Jan  1 00:00:00 2026"       # Terminal запущен раньше любой записи линии


def stamp_at(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))


class AutoSys(FakeSys):
    def __init__(self, procs, env=None, dirty=(), windows=""):
        super().__init__(procs, env=env)
        self.t = NOW
        self.dirty_dirs = {os.path.realpath(d) for d in dirty}
        self.windows = windows
        self.alive_pids = set()

    def dirty(self, path):
        return os.path.realpath(path) in self.dirty_dirs

    def osa(self, script, *args):
        self.osa_calls.append((script.split("\n", 1)[0][:40], *args))
        return self.windows if script is A.LIST_SCRIPT else self.osa_reply

    def status(self, pid):
        d = L.read_json(L.sessions_dir() / f"{pid}.json")
        return d.get("status") if isinstance(d, dict) else None

    def pid_alive(self, pid):
        return pid in self.alive_pids


class AutoTest(Base):
    def setUp(self):
        super().setUp()
        self.root = self.dir / "dev" / "proj"            # продукт; его родитель dev — общий корень (мост)
        (self.root / "worktrees" / "x").mkdir(parents=True)
        self.wt = self.root / "worktrees" / "x"
        self.me = os.getpid()
        self.procs = [P(100, 1, 100, "??", TERMINAL, TERM_START), P(90, 1, 90, "??", "/usr/sbin/sshd"),
                      P(50, 1, 50, "??", "/Applications/Visual Studio Code.app/Contents/MacOS/Code"),
                      P(700, 90, 700, "ttys001", "claude"), P(self.me, 700, self.me, "??", "python3 lineage.py reap")]
        self.env_l = {}

    def sess(self, pid, line=None, role="backend", status="idle", idle_h=1.0, cwd=None, parent=100):
        cmd = "claude" + (f" --settings /x/genome/{role}.json" if role else "")
        self.procs.append(P(pid, parent, pid, f"ttys{pid % 1000:03d}", cmd, ST))
        if line:
            self.env_l[pid] = line
        L.write_json(L.sessions_dir() / f"{pid}.json", {
            "pid": pid, "procStart": ST, "name": f"s-{pid}", "status": status,
            "cwd": str(cwd or self.wt), "startedAt": (NOW - 48 * 3600) * 1000,
            "updatedAt": (NOW - idle_h * 3600) * 1000})

    def ack(self, pid, line, minutes_ago):
        L.write_json(L.ldir() / f"{line}.ack", {"line": line, "pid": pid, "start": ST,
                                                "at": stamp_at(NOW - minutes_ago * 60)})

    def auto(self, *args, sx=None, **kw):
        sx = sx or AutoSys(self.procs, env=self.env_l, **kw)
        out = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", out), \
                mock.patch.object(A, "keep_dirs", lambda extra: {os.path.realpath(self.dir / "dev")}):
            rc = L.main(["reap", "--auto", "--root", str(self.root), *args], sx)
        return rc, out.getvalue(), sx

    def verdicts(self, text):
        return {int(m.group(1)): ln for ln in text.splitlines() for m in [re.match(r"\s*(\d+)\s", ln)] if m}

    def journal(self):
        path = L.ldir() / "reap-auto.jsonl"
        return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    # ── критерии ─────────────────────────────────────────────────────────────────────────────────────────────
    def test_ack_older_than_n_minutes(self):
        self.sess(701, line="r.a1", idle_h=0.2)
        self.sess(702, line="r.a1.b2", idle_h=0.1)
        self.ack(702, "r.a1.b2", 45)
        rc, out, sx = self.auto()
        v = self.verdicts(out)
        self.assertEqual(rc, 0, out)
        self.assertIn("СНЯТЬ: наследник r.a1.b2 принял 45 мин", v[701])
        self.assertNotIn("СНЯТЬ", v[702])
        self.assertEqual(sx.sent, [])                                    # сухо по умолчанию
        dry = [e for e in self.journal() if e.get("kind") == "ack"]
        self.assertEqual([(e["mode"], e["pid"]) for e in dry], [("dry", 701)])

    def test_fresh_or_unverified_ack_kept(self):
        self.sess(701, line="r.a1")
        self.sess(702, line="r.a1.b2")
        self.ack(702, "r.a1.b2", 10)                                      # моложе 30 мин
        self.sess(703, line="r.c3")
        self.ack(999, "r.c3.d4", 120)                                     # наследника нет
        self.sess(704, line="r.e5")
        self.sess(705, line="r.x9")                                       # жив, но другой линии
        self.ack(705, "r.e5.f6", 120)
        v = self.verdicts(self.auto()[1])
        self.assertIn("квитанция r.a1.b2 свежая", v[701])
        self.assertNotIn("СНЯТЬ", v[703])
        self.assertNotIn("СНЯТЬ", v[704])

    def test_ack_minutes_flag(self):
        self.sess(701, line="r.a1")
        self.sess(702, line="r.a1.b2")
        self.ack(702, "r.a1.b2", 10)
        self.assertIn("СНЯТЬ", self.verdicts(self.auto("--ack-minutes", "5")[1])[701])

    def test_idle_rules(self):
        self.sess(711, line="r.k1", role="plan", idle_h=12, cwd=self.root / "worktrees" / "x")   # держатель plan
        self.sess(712, line="r.k2", role=None, idle_h=12)                                          # не роль, чисто
        dirty = self.root / "worktrees" / "d"
        dirty.mkdir()
        self.sess(713, line="r.k3", role=None, idle_h=12, cwd=dirty)                               # незакоммиченное
        self.sess(714, line="r.k4", role=None, idle_h=3)                                           # простой мал
        self.sess(715, line="r.k5", role=None, idle_h=12, status="waiting")
        self.sess(716, line="r.k6", role=None, idle_h=12, status="busy")
        self.sess(717, line="r.k7", role="plan", idle_h=20)            # вторая plan без наследника: держатель — одна
        v = self.verdicts(self.auto(dirty=[str(dirty)])[1])
        self.assertIn("СНЯТЬ: простой 12 ч", v[712])
        self.assertIn("незакоммиченное", v[713])
        self.assertIn("простой 3.0 < 8", v[714])
        self.assertIn("ждёт ввода", v[715])
        self.assertIn("статус busy", v[716])
        holders = [p for p in (711, 717) if "оставить: держатель роли" in v[p]]
        self.assertEqual(len(holders), 1, out := "\n".join(v.values()))
        self.assertTrue(any("СНЯТЬ" in v[p] for p in (711, 717) if p not in holders), out)

    def test_protections_beat_every_criterion(self):
        self.sess(721, line="r.m1", role=None, idle_h=50, cwd=self.dir / "dev")           # мост в общем корне
        self.sess(722, line="r.m2", role=None, idle_h=50, cwd="/elsewhere")               # чужой проект
        self.sess(723, line="r.m3", role=None, idle_h=50, parent=50)                      # VS Code
        self.sess(724, line="r.m4", role=None, idle_h=50, parent=90)                      # не в Terminal (ssh)
        self.sess(725, line="r.m5")                                                       # предшественник моста
        self.sess(726, line="r.m5.n6", cwd=self.dir / "dev")
        self.ack(726, "r.m5.n6", 120)
        L.write_json(L.sessions_dir() / "700.json", {"pid": 700, "procStart": ST, "status": "idle",
                                                     "cwd": str(self.wt), "updatedAt": 0, "startedAt": 0})
        v = self.verdicts(self.auto()[1])
        self.assertIn("общий корень проектов", v[721])
        self.assertIn("чужой проект", v[722])
        self.assertIn("не в Terminal (vscode)", v[723])
        self.assertIn("не в Terminal (other)", v[724])
        self.assertIn("СНЯТЬ", v[725])                                   # квитанция наследника-моста годится
        self.assertIn("своя сессия", v[700])

    def test_apply_refused_from_claude_session(self):
        self.sess(712, line="r.k2", role=None, idle_h=12)
        rc, out, sx = self.auto("--apply")
        self.assertEqual((rc, sx.sent), (2, []), out)
        self.assertIn("не сессии claude", out)

    def test_apply_from_launchd_takes_down_and_journals(self):
        self.procs = [p for p in self.procs if p.pid not in (700, self.me)] + \
            [P(self.me, 1, self.me, "??", "python3 lineage.py reap")]      # launchd: предка-claude нет
        self.sess(712, line="r.k2", role=None, idle_h=12)
        self.sess(714, line="r.k4", role=None, idle_h=12, status="busy")
        rc, out, sx = self.auto("--apply")
        self.assertEqual(rc, 0, out)
        self.assertNotIn(712, sx.p)
        self.assertIn(714, sx.p)
        apply = [e for e in self.journal() if e.get("mode") == "apply" and e.get("pid")]
        self.assertEqual([(e["pid"], e["kind"], e["result"]) for e in apply], [(712, "idle", "снята")])
        self.assertTrue(any(e.get("summary") for e in self.journal()))

    def test_apply_rechecks_status(self):
        self.procs = [p for p in self.procs if p.pid not in (700, self.me)] + \
            [P(self.me, 1, self.me, "??", "python3 lineage.py reap")]
        self.sess(712, line="r.k2", role=None, idle_h=12)
        sx = AutoSys(self.procs, env=self.env_l)
        real = A.decide

        def decide_then_busy(*args):
            res = real(*args)
            d = L.read_json(L.sessions_dir() / "712.json")
            L.write_json(L.sessions_dir() / "712.json", {**d, "status": "busy"})   # ход начался после решения
            return res
        with mock.patch.object(A, "decide", decide_then_busy):
            rc, out, sx = self.auto("--apply", sx=sx)
        self.assertIn(712, sx.p)
        self.assertIn("пропуск: статус стал busy", json.dumps(self.journal(), ensure_ascii=False))

    # ── окна линий без claude ────────────────────────────────────────────────────────────────────────────────
    def record(self, line, wid, tty, at=NOW - 3600):
        L.write_json(L.ldir() / f"{line}.json", {"line": line, "terminal": "terminal", "window_id": wid,
                                                 "tty": tty, "role": None, "at": stamp_at(at)})

    def test_orphan_windows(self):
        self.record("r.w1", "11", "/dev/ttys021")                  # claude нет, в окне shell → закрыть
        self.record("r.w2", "12", "/dev/ttys022")                  # в окне идёт vim
        self.record("r.w3", "13", "/dev/ttys023")                  # две вкладки
        self.record("r.w4", "14", "/dev/ttys024")                  # у окна уже другой tty
        self.record("r.w5", "15", "/dev/ttys025", at=0)            # запись старше запуска Terminal
        self.record("r.w6", "16", "/dev/ttys026")                  # claude линии жив
        self.sess(726, line="r.w6")
        L.write_json(L.ldir() / "r.w7.json", {"line": "r.w7", "terminal": "terminal", "window_id": None,
                                               "tty": "/dev/ttys027", "at": stamp_at(NOW)})   # без id окна
        wins = "".join(f"{w}\t{n}\t{t}\t{b}\t{p}\n" for w, n, t, b, p in [
            ("11", 1, "/dev/ttys021", "false", "login,-zsh,"), ("12", 1, "/dev/ttys022", "true", "login,-zsh,vim,"),
            ("13", 2, "/dev/ttys023", "false", "login,-zsh,"), ("14", 1, "/dev/ttys099", "false", "login,-zsh,"),
            ("15", 1, "/dev/ttys025", "false", "login,-zsh,"), ("16", 1, "/dev/ttys026", "true", "login,claude,"),
            ("17", 1, "/dev/ttys027", "false", "login,-zsh,")])
        rc, out, sx = self.auto(windows=wins)
        lines = {m.group(1): ln for ln in out.splitlines() for m in [re.search(r"окно (\d+) ", ln)] if m}
        self.assertIn("ЗАКРЫТЬ", lines["11"])
        self.assertIn("идёт процесс", lines["12"])
        self.assertIn("вкладок 2", lines["13"])
        self.assertIn("другой tty", lines["14"])
        self.assertIn("старше запуска Terminal", lines["15"])
        self.assertNotIn("16", lines)
        self.assertNotIn("17", lines)
        self.assertIn("окон закрыл бы: 1", out)
        self.assertEqual([c for c in sx.osa_calls if c[0].startswith("on run")], [])   # сухо: закрытий нет

    def test_no_terminal_no_osascript(self):
        self.procs = [p for p in self.procs if p.pid != 100]
        self.record("r.w1", "11", "/dev/ttys021")
        _, out, sx = self.auto()
        self.assertEqual(sx.osa_calls, [])

    # ── autoclose пускового скрипта ──────────────────────────────────────────────────────────────────────────
    def autoclose(self, line="r.q1", tty="/dev/ttys031", pid=0, procs=(), reply="closed 31", rec=True, **rec_kw):
        if rec:
            L.write_json(L.ldir() / f"{line}.json", {"line": line, "terminal": rec_kw.get("terminal", "terminal"),
                                                     "window_id": "31", "tty": rec_kw.get("rec_tty", tty)})
        sx = AutoSys(list(procs))
        sx.osa_reply = reply
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"TAIBE_LINEAGE": line}), mock.patch("sys.stdout", out), \
                mock.patch("sys.stderr", out):
            rc = L.main(["autoclose", "--tty", tty, "--pid", str(pid), "--foreground", "--wait", "5"], sx)
        return rc, out.getvalue(), sx

    def test_autoclose_closes_own_window_when_only_shell_left(self):
        rc, out, sx = self.autoclose(procs=[P(200, 100, 200, "ttys031", "login -pf u"),
                                            P(201, 200, 201, "ttys031", "-zsh")])
        self.assertEqual(rc, 0, out)
        self.assertEqual(sx.osa_calls, [("on run argv", "/dev/ttys031", "31")])
        self.assertEqual(sorted(p for p, _ in sx.sent), [200, 201])          # HUP shell-остаткам

    def test_autoclose_keeps_window_with_running_process(self):
        rc, out, sx = self.autoclose(procs=[P(201, 200, 201, "ttys031", "-zsh"), P(202, 201, 202, "ttys031", "vim")])
        self.assertEqual((rc, sx.osa_calls), (3, []), out)

    def test_autoclose_waits_for_launcher(self):
        sx_holder = {}
        orig = AutoSys.__init__

        def init(self_, *a, **k):
            orig(self_, *a, **k)
            self_.alive_pids = {555}
            self_.at(2, lambda: self_.alive_pids.discard(555))
            sx_holder["sx"] = self_
        with mock.patch.object(AutoSys, "__init__", init):
            rc, out, sx = self.autoclose(pid=555)
        self.assertEqual(rc, 0, out)
        self.assertGreaterEqual(sx.t, NOW + 2)

    def test_autoclose_refuses_foreign_or_missing_record(self):
        for kw in ({"rec": False}, {"terminal": "iterm"}, {"rec_tty": "/dev/ttys099"}):
            with self.subTest(kw):
                rc, out, sx = self.autoclose(line="r.q" + next(iter(kw)).replace("_", ""), **kw)
                self.assertEqual((rc, sx.osa_calls), (0, []), out)
                self.assertIn("не закрываю", out)

    def test_autoclose_bad_args(self):
        rc, _, sx = self.autoclose(tty="ttys031")
        self.assertEqual((rc, sx.osa_calls), (2, []))


class GroupTest(unittest.TestCase):
    def test_launcher_without_exec_owns_the_group(self):
        """claude без exec под пусковым bash spawn_session.sh: снимается группа скрипта, не только claude."""
        procs = {q.pid: q for q in [
            P(201, 200, 201, "ttys005", "-zsh"),
            P(250, 201, 250, "ttys005", "/bin/bash /var/folders/x/T/claude-spawn.Ab12Cd/backend.sh"),
            P(300, 250, 250, "ttys005", "claude --settings /x/genome/backend.json"),
            P(301, 300, 250, "ttys005", "node mcp"),
            P(400, 201, 400, "ttys005", "bash other.sh"), P(401, 400, 400, "ttys005", "claude")]}
        self.assertEqual(L.group_of(procs, procs[300]), 250)
        self.assertEqual(L.doomed(procs, procs[300]), {250, 300, 301})
        self.assertIsNone(L.group_of(procs, procs[401]))                 # чужой bash — только дерево claude
        self.assertEqual(L.doomed(procs, procs[401]), {401})


@unittest.skipUnless(sys.platform == "darwin" and os.path.exists("/usr/bin/script"), "pty через script — macOS")
class LauncherIntegrationTest(unittest.TestCase):
    """Пусковой скрипт из --dry-run под настоящим pty: claude = true (код 0) → autoclose зовёт osascript-заглушку
    с tty этой вкладки; claude = false → окно остаётся, заглушку не зовут."""

    def run_launcher(self, claude_bin):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            handoff = Path(tmp) / "h.md"
            handoff.write_text("x\n", encoding="utf-8")
            calls = Path(tmp) / "osa.txt"
            stub = Path(tmp) / "osa.sh"
            stub.write_text(f'#!/bin/sh\ncat >/dev/null\necho "$@" >> {calls}\necho "closed 1"\n')
            stub.chmod(0o700)
            env = {**os.environ, "TMPDIR": tmp, "TAIBE_LINEAGE": "r.zz", "TAIBE_LINEAGE_DIR": f"{tmp}/lin",
                   "LINEAGE_OSASCRIPT": str(stub), "CLAUDE_BIN": claude_bin}
            dry = subprocess.run(["bash", os.path.join(HERE, "spawn_session.sh"), "--handoff", str(handoff),
                                  "--dry-run", "--cwd", tmp], capture_output=True, text=True, env=env, timeout=30)
            lines = dry.stdout.splitlines()
            start = next(i for i, ln in enumerate(lines) if ln.startswith("unset "))
            end = next(i for i, ln in enumerate(lines) if ln == "exit 0")
            body = lines[start:end + 1]
            line = re.search(r"TAIBE_LINEAGE='([^']+)'", "\n".join(body)).group(1)
            msg = re.search(r"cat '([^']+)'", "\n".join(body)).group(1)
            os.makedirs(os.path.dirname(msg), exist_ok=True)
            Path(msg).write_text("m", encoding="utf-8")
            launcher = Path(os.path.dirname(msg)) / "successor.sh"
            launcher.write_text("#!/bin/bash\n" + "\n".join(body) + "\n", encoding="utf-8")
            L.write_json(Path(tmp) / "lin" / f"{line}.json", {"line": line, "terminal": "terminal",
                                                               "window_id": None, "tty": None})
            run = subprocess.run(["script", "-q", "/dev/null", "/bin/bash", str(launcher)], stdin=subprocess.DEVNULL,
                                 capture_output=True, text=True, env=env, timeout=60)
            for _ in range(100):                                        # сторож отцеплен: ждём его запись
                if calls.exists() or not claude_bin.endswith("true"):
                    break
                time.sleep(0.1)
            time.sleep(0.3)
            return run, calls.read_text() if calls.exists() else ""

    def test_exit_0_closes_own_tty(self):
        run, calls = self.run_launcher("/usr/bin/true")
        self.assertRegex(calls, r"^- /dev/ttys\d+ $", run.stdout)

    def test_nonzero_exit_keeps_window(self):
        run, calls = self.run_launcher("/usr/bin/false")
        self.assertEqual(calls, "")
        self.assertIn("окно оставлено", run.stdout)


class LaunchdTemplateTest(unittest.TestCase):
    """reaper_launchd.sh print: plist валиден, раз в 30 мин, сухо по умолчанию; install/uninstall — только --dry-run."""

    def run_tool(self, *args):
        return subprocess.run(["/bin/bash", os.path.join(HERE, "reaper_launchd.sh"), *args], capture_output=True,
                              text=True, timeout=30)

    def test_print_renders_valid_plist(self):
        import plistlib
        for flags, apply in (((), False), (("--apply",), True)):
            with self.subTest(flags):
                run = self.run_tool("print", *flags)
                self.assertEqual(run.returncode, 0, run.stderr)
                d = plistlib.loads(run.stdout.encode())
                self.assertEqual((d["Label"], d["StartInterval"], d["RunAtLoad"]), ("space.hrhelper.reaper", 1800, False))
                argv = d["ProgramArguments"]
                self.assertEqual(argv[1:5], ["-I", argv[2], "reap", "--auto"])
                self.assertTrue(argv[2].endswith("/tools/lineage.py") and "/worktrees/" not in argv[2], argv[2])
                self.assertEqual("--apply" in argv, apply)
                self.assertNotIn("@", run.stdout.split("-->", 1)[1])

    def test_dry_run_installs_nothing(self):
        run = self.run_tool("uninstall", "--dry-run")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("bootout", run.stdout)


if __name__ == "__main__":
    unittest.main()
