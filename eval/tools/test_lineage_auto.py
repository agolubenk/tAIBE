#!/usr/bin/env python3
"""lineage_auto.py / lineage_close.py: критерии автоуборки (reap --auto) и само-закрытие окна — на подставных данных.

Процессы, osascript, «несохранённое» и часы — FakeSys из test_lineage; окна и процессы не трогаются. Sys.unsaved —
на настоящем временном git-репо. Пусковой скрипт — под `script` (свой pty), claude = /usr/bin/true|false,
osascript — заглушка, пишущая аргументы в файл.
Run: python3 -I eval/tools/test_lineage_auto.py
"""
import io
import json
import os
import re
import stat
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
import lineage_close as C  # noqa: E402
from test_lineage import ST, TERMINAL, Base, FakeSys, P  # noqa: E402

NOW = 1.8e9                                   # часы FakeSys (с от эпохи)
TERM_START = "Thu Jan  1 00:00:00 2026"       # Terminal запущен раньше любой записи линии
LAUNCHD = {"XPC_SERVICE_NAME": A.LABEL}


def stamp_at(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))


class AutoSys(FakeSys):
    def __init__(self, procs, env=None, unsaved=None, windows=""):
        super().__init__(procs, env=env)
        self.t = NOW
        self.lost = {os.path.realpath(k): v for k, v in (unsaved or {}).items()}
        self.windows = windows
        self.alive_pids = set()

    def unsaved(self, path):
        return self.lost.get(os.path.realpath(path), "")

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

    def as_launchd(self):
        """Прогон из launchd: предка-claude нет, XPC_SERVICE_NAME — метка агента."""
        self.procs = [p for p in self.procs if p.pid not in (700, self.me)] + \
            [P(self.me, 1, self.me, "??", "python3 lineage.py reap")]

    def sess(self, pid, line=None, role="backend", status="idle", idle_h=1.0, cwd=None, parent=100, spawned=True):
        cmd = "claude" + (f" --settings /x/genome/{role}.json" if role else "")
        self.procs.append(P(pid, parent, pid, f"ttys{pid % 1000:03d}", cmd, ST))
        if line:
            self.env_l[pid] = line
            if spawned:
                self.record(line, str(pid), f"/dev/ttys{pid % 1000:03d}")
        L.write_json(L.sessions_dir() / f"{pid}.json", {
            "pid": pid, "procStart": ST, "name": f"s-{pid}", "status": status,
            "cwd": str(cwd or self.wt), "startedAt": (NOW - 48 * 3600) * 1000,
            "updatedAt": (NOW - idle_h * 3600) * 1000})

    def record(self, line, wid, tty, at=NOW - 3600, **extra):
        L.write_json(L.ldir() / f"{line}.json", {"line": line, "terminal": "terminal", "window_id": wid,
                                                 "tty": tty, "role": None, "at": stamp_at(at), **extra})

    def ack(self, pid, line, minutes_ago):
        L.write_json(L.ldir() / f"{line}.ack", {"line": line, "pid": pid, "start": ST,
                                                "at": stamp_at(NOW - minutes_ago * 60)})

    def auto(self, *args, sx=None, env=None, **kw):
        sx = sx or AutoSys(self.procs, env=self.env_l, **kw)
        out = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", out), \
                mock.patch.dict(os.environ, env or {"XPC_SERVICE_NAME": "0"}), \
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
        v = self.verdicts(self.auto("--ack-minutes", "30")[1])
        self.assertIn("квитанция r.a1.b2 свежая", v[701])
        self.assertNotIn("СНЯТЬ", v[703])
        self.assertNotIn("СНЯТЬ", v[704])
        self.assertIn("СНЯТЬ", self.verdicts(self.auto("--ack-minutes", "5")[1])[701])

    def test_ack_needs_saved_work_too(self):
        """Ревью #82: квитанция наследника не спасает незапушенное и stash предшественника."""
        for n, lost in enumerate(("незакоммиченное", "коммиты не на remote", "stash этой ветки")):
            with self.subTest(lost):
                wt = self.root / "worktrees" / f"p{n}"
                wt.mkdir()
                line = f"r.p{n}"
                self.sess(710 + n, line=line, cwd=wt)
                self.sess(720 + n, line=f"{line}.q1")
                self.ack(720 + n, f"{line}.q1", 60)
                v = self.verdicts(self.auto(unsaved={str(wt): lost})[1])
                self.assertIn(f"оставить: {lost} в папке", v[710 + n])

    def test_idle_rules(self):
        self.sess(711, line="r.k1", role="plan", idle_h=12)                                      # держатель plan
        self.sess(712, line="r.k2", role=None, idle_h=12)                                        # не роль, чисто
        d = self.root / "worktrees" / "d"
        d.mkdir()
        self.sess(713, line="r.k3", role=None, idle_h=12, cwd=d)                                 # незапушенное
        self.sess(714, line="r.k4", role=None, idle_h=3)                                         # простой мал
        self.sess(715, line="r.k5", role=None, idle_h=12, status="waiting")
        self.sess(716, line="r.k6", role=None, idle_h=12, status="busy")
        self.sess(717, line="r.k7", role=None, idle_h=50, spawned=False)                         # открыта руками
        self.sess(718, role=None, idle_h=50)                                                     # без линии вовсе
        v = self.verdicts(self.auto(unsaved={str(d): "коммиты не на remote"})[1])
        self.assertIn("оставить: держатель роли", v[711])
        self.assertIn("СНЯТЬ: простой 12 ч, сессия spawn_session.sh", v[712])
        self.assertIn("коммиты не на remote в папке", v[713])
        self.assertIn("простой 3.0 < 8", v[714])
        self.assertIn("ждёт ввода", v[715])
        self.assertIn("статус busy", v[716])
        self.assertIn("открыта не spawn_session.sh", v[717])
        self.assertIn("открыта не spawn_session.sh", v[718])

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

    # ── --apply: только launchd ──────────────────────────────────────────────────────────────────────────────
    def test_apply_needs_launchd_label_and_no_claude_ancestor(self):
        self.sess(712, line="r.k2", role=None, idle_h=12)
        cases = [("сессия claude, метки нет", False, {"XPC_SERVICE_NAME": "0"}),
                 ("сессия claude с меткой launchd", False, LAUNCHD),
                 ("не claude, без метки (терминал владельца)", True, {"XPC_SERVICE_NAME": "0"})]
        for name, launchd_tree, env in cases:
            with self.subTest(name):
                if launchd_tree:
                    self.as_launchd()
                rc, out, sx = self.auto("--apply", env=env)
                self.assertEqual((rc, sx.sent), (2, []), out)
                self.assertIn("--apply", out)

    def test_apply_from_launchd_takes_down_and_journals(self):
        self.as_launchd()
        self.sess(712, line="r.k2", role=None, idle_h=12)
        self.sess(714, line="r.k4", role=None, idle_h=12, status="busy")
        rc, out, sx = self.auto("--apply", env=LAUNCHD)
        self.assertEqual(rc, 0, out)
        self.assertNotIn(712, sx.p)
        self.assertIn(714, sx.p)
        apply = [e for e in self.journal() if e.get("mode") == "apply" and e.get("pid")]
        self.assertEqual([(e["pid"], e["kind"], e["result"]) for e in apply], [(712, "idle", "снята")])

    def test_apply_rechecks_status_and_unsaved(self):
        self.as_launchd()
        self.sess(712, line="r.k2", role=None, idle_h=12)
        d = self.root / "worktrees" / "d"
        d.mkdir()
        self.sess(713, line="r.k3", role=None, idle_h=12, cwd=d)
        sx = AutoSys(self.procs, env=self.env_l)
        real = A.window_plan

        def plan_then_change(*args):                                      # после всех решений, до снятия
            rec = L.read_json(L.sessions_dir() / "712.json")
            L.write_json(L.sessions_dir() / "712.json", {**rec, "status": "busy"})   # ход начался
            sx.lost[os.path.realpath(d)] = "незакоммиченное"             # в папке 713 появилась правка
            return real(*args)
        with mock.patch.object(A, "window_plan", plan_then_change):
            rc, out, sx = self.auto("--apply", sx=sx, env=LAUNCHD)
        self.assertIn(712, sx.p)
        self.assertIn(713, sx.p)
        text = json.dumps(self.journal(), ensure_ascii=False)
        self.assertIn("пропуск: статус стал busy", text)
        self.assertIn("пропуск: незакоммиченное в папке", text)

    # ── журнал ───────────────────────────────────────────────────────────────────────────────────────────────
    def test_dry_journal_only_on_plan_change_and_private(self):
        self.sess(712, line="r.k2", role=None, idle_h=12)
        self.auto()
        n = len(self.journal())
        self.auto()
        self.assertEqual(len(self.journal()), n)                          # план тот же — журнал не растёт
        self.sess(719, line="r.k9", role=None, idle_h=12)
        self.auto()
        self.assertGreater(len(self.journal()), n)
        for name in ("reap-auto.jsonl", "reap-auto.plan.json", "r.k2.json"):
            with self.subTest(name):
                self.assertEqual(stat.S_IMODE((L.ldir() / name).stat().st_mode), 0o600)

    def test_summary_is_readable(self):
        self.sess(712, line="r.k2", role=None, idle_h=12)
        self.auto()
        self.auto()
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            rc = L.main(["reap", "--auto", "--summary"], AutoSys([]))
        text = out.getvalue()
        self.assertEqual(rc, 0, text)
        self.assertIn("прогонов всего 2", text)
        self.assertIn("снял бы: s-712 (pid 712) — простой 12 ч", text)
        self.assertNotIn("{", text)

    # ── окна линий без claude ────────────────────────────────────────────────────────────────────────────────
    def test_orphan_windows_need_exit_0_and_ten_minutes(self):
        old, fresh = NOW - 20 * 60, NOW - 2 * 60
        self.record("r.w1", "11", "/dev/ttys021", exit=0, exited_at=stamp_at(old))      # закрыть
        self.record("r.w2", "12", "/dev/ttys022", exit=0, exited_at=stamp_at(fresh))    # рано
        self.record("r.w3", "13", "/dev/ttys023", exit=1, exited_at=stamp_at(old))      # упала — причина
        self.record("r.w4", "14", "/dev/ttys024", exit=0, exited_at=stamp_at(old), keep=True)  # Enter
        self.record("r.w5", "15", "/dev/ttys025")                                         # кода нет
        self.record("r.w6", "16", "/dev/ttys026", exit=0, exited_at=stamp_at(old))      # в окне vim
        self.record("r.w7", "17", "/dev/ttys027", exit=0, exited_at=stamp_at(old))      # две вкладки
        self.record("r.w8", "18", "/dev/ttys028", exit=0, exited_at=stamp_at(old), at=0)  # до запуска Terminal
        wins = "".join(f"{w}\t{n}\t{t}\t{b}\t{p}\n" for w, n, t, b, p in [
            ("11", 1, "/dev/ttys021", "false", "login,-zsh,"), ("12", 1, "/dev/ttys022", "false", "login,-zsh,"),
            ("13", 1, "/dev/ttys023", "false", "login,-zsh,"), ("14", 1, "/dev/ttys024", "false", "login,-zsh,"),
            ("15", 1, "/dev/ttys025", "false", "login,-zsh,"), ("16", 1, "/dev/ttys026", "true", "login,-zsh,vim,"),
            ("17", 2, "/dev/ttys027", "false", "login,-zsh,"), ("18", 1, "/dev/ttys028", "false", "login,-zsh,"),
            ("19", 1, "/dev/ttys029", "false", "login,-zsh,")])                          # окно без записи
        rc, out, sx = self.auto(windows=wins)
        lines = {m.group(1): ln for ln in out.splitlines() for m in [re.search(r"окно (\d+) ", ln)] if m}
        self.assertIn("ЗАКРЫТЬ", lines["11"])
        self.assertIn("меньше 10 мин", lines["12"])
        self.assertIn("кодом 1", lines["13"])
        self.assertIn("Enter", lines["14"])
        self.assertIn("нет кода выхода", lines["15"])
        self.assertIn("идёт процесс", lines["16"])
        self.assertIn("вкладок 2", lines["17"])
        self.assertIn("старше запуска Terminal", lines["18"])
        self.assertNotIn("19", lines)
        self.assertIn("окон закрыл бы: 1", out)
        self.assertEqual([c for c in sx.osa_calls if c[0].startswith("on run")], [])   # сухо: закрытий нет

    def test_no_terminal_no_osascript(self):
        self.procs = [p for p in self.procs if p.pid != 100]
        self.record("r.w1", "11", "/dev/ttys021", exit=0, exited_at=stamp_at(0))
        _, out, sx = self.auto()
        self.assertEqual(sx.osa_calls, [])

    # ── exited и autoclose пускового скрипта ─────────────────────────────────────────────────────────────────
    def run_cmd(self, argv, sx, line="r.q1"):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"TAIBE_LINEAGE": line}), mock.patch("sys.stdout", out), \
                mock.patch("sys.stderr", out):
            rc = L.main(argv, sx)
        return rc, out.getvalue()

    def autoclose(self, line="r.q1", tty="/dev/ttys031", pid=0, procs=(), reply="closed 31", rec=True, **kw):
        if rec:
            self.record(line, "31", kw.pop("rec_tty", tty), **kw)
            if "exit" not in kw:
                self.run_cmd(["exited", "--rc", "0"], AutoSys([]), line)
        sx = AutoSys(list(procs))
        sx.osa_reply = reply
        rc, out = self.run_cmd(["autoclose", "--tty", tty, "--pid", str(pid), "--foreground", "--wait", "5"], sx, line)
        return rc, out, sx

    def test_exited_records_code_time_and_keep(self):
        self.record("r.q1", "31", "/dev/ttys031")
        self.run_cmd(["exited", "--rc", "0", "--keep"], AutoSys([]))
        rec = L.read_json(L.ldir() / "r.q1.json")
        self.assertEqual((rec["exit"], rec["keep"], rec["window_id"]), (0, True, "31"))
        self.assertIsNotNone(A.parse_stamp(rec["exited_at"]))
        self.assertEqual(self.run_cmd(["exited", "--rc", "0"], AutoSys([]), "r.none"), (0, ""))   # нет записи

    def test_autoclose_closes_own_window_when_only_shell_left(self):
        rc, out, sx = self.autoclose(procs=[P(200, 100, 200, "ttys031", "login -pf u"),
                                            P(201, 200, 201, "ttys031", "-zsh")])
        self.assertEqual(rc, 0, out)
        self.assertEqual(sx.osa_calls, [("on run argv", "/dev/ttys031", "31")])
        self.assertEqual(sorted(p for p, _ in sx.sent), [200, 201])          # HUP shell-остаткам

    def test_autoclose_keeps_window(self):
        for name, kw in [("процесс в окне", {"procs": [P(201, 200, 201, "ttys031", "-zsh"),
                                                        P(202, 201, 202, "ttys031", "vim")]}),
                         ("код 1", {"exit": 1}), ("Enter", {"exit": 0, "keep": True}),
                         ("нет записи", {"rec": False}), ("чужой tty", {"rec_tty": "/dev/ttys099"})]:
            with self.subTest(name):
                rc, out, sx = self.autoclose(line="r.k" + str(abs(hash(name)) % 997), **kw)
                self.assertEqual([c for c in sx.osa_calls if c[0].startswith("on run")], [], out)

    def test_autoclose_waits_for_launcher(self):
        orig = AutoSys.__init__

        def init(self_, *a, **k):
            orig(self_, *a, **k)
            self_.alive_pids = {555}
            self_.at(2, lambda: self_.alive_pids.discard(555))
        with mock.patch.object(AutoSys, "__init__", init):
            rc, out, sx = self.autoclose(pid=555)
        self.assertEqual(rc, 0, out)
        self.assertGreaterEqual(sx.t, NOW + 2)

    def test_autoclose_bad_args(self):
        rc, _, sx = self.autoclose(tty="ttys031")
        self.assertEqual((rc, sx.osa_calls), (2, []))


class AppleScriptShapeTest(unittest.TestCase):
    def test_processes_read_by_index(self):
        """Замер 06.11: `repeat with p in (processes of t)` → `p as text` падает с -1700, try глотал ошибку, окна не
        видны и не закрываются. Проверка на живом Terminal — в PR (закрытие подменено на return)."""
        for script in (C.LIST_SCRIPT, C.CLOSE_IDLE_SCRIPT):
            self.assertNotIn("in (processes of", script)
            self.assertIn("set pl to processes of t", script)
        self.assertLess(C.CLOSE_IDLE_SCRIPT.index("set pl to processes"), C.CLOSE_IDLE_SCRIPT.index("close w"))


class UnsavedGitTest(unittest.TestCase):
    """Sys.unsaved на настоящем git: незакоммиченное, коммиты не на remote, stash этой ветки."""

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", str(cwd or self.wt), *args], capture_output=True, text=True, check=True,
                              env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}).stdout

    def test_unsaved_reasons(self):
        sx = L.Sys()
        with tempfile.TemporaryDirectory() as tmp:
            self.wt, bare = Path(tmp) / "w", Path(tmp) / "b.git"
            subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
            subprocess.run(["git", "init", "-q", "-b", "feat", str(self.wt)], check=True)
            (self.wt / "a").write_text("1")
            self.git("add", "a")
            self.git("commit", "-qm", "a")
            self.assertEqual(sx.unsaved(self.wt), "коммиты не на remote")
            self.git("remote", "add", "origin", str(bare))
            self.git("push", "-q", "origin", "feat")
            self.assertEqual(sx.unsaved(self.wt), "")
            (self.wt / "b").write_text("new")
            self.assertEqual(sx.unsaved(self.wt), "незакоммиченное")
            self.git("stash", "push", "-q", "-u", "-m", "t")
            self.assertEqual(sx.unsaved(self.wt), "stash этой ветки")
            self.git("stash", "drop", "-q")
            self.assertEqual(sx.unsaved(self.wt), "")
            self.assertEqual(sx.unsaved(Path(tmp)), "git не ответил")


@unittest.skipUnless(sys.platform == "darwin" and os.path.exists("/usr/bin/script"), "pty через script — macOS")
class LauncherIntegrationTest(unittest.TestCase):
    """Пусковой скрипт из --dry-run под настоящим pty, отсчёт 1 с: claude = true (код 0) → код в записи, autoclose
    зовёт osascript-заглушку с tty вкладки; Enter в отсчёте → окно оставлено; claude = false → окно оставлено."""

    def run_launcher(self, claude_bin, enter_after=None):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = os.path.realpath(tmp)
            handoff = Path(tmp) / "h.md"
            handoff.write_text("x\n", encoding="utf-8")
            calls = Path(tmp) / "osa.txt"
            stub = Path(tmp) / "osa.sh"
            stub.write_text(f'#!/bin/sh\ncat >/dev/null\necho "$@" >> {calls}\necho "closed 1"\n')
            stub.chmod(0o700)
            env = {**os.environ, "TMPDIR": tmp, "TAIBE_LINEAGE": "r.zz", "TAIBE_LINEAGE_DIR": f"{tmp}/lin",
                   "LINEAGE_OSASCRIPT": str(stub), "CLAUDE_BIN": claude_bin,
                   "SPAWN_CLOSE_DELAY": "1" if enter_after is None else "3"}
            dry = subprocess.run(["bash", os.path.join(HERE, "spawn_session.sh"), "--handoff", str(handoff),
                                  "--dry-run", "--cwd", tmp], capture_output=True, text=True, env=env, timeout=30)
            lines = dry.stdout.splitlines()
            body = lines[next(i for i, ln in enumerate(lines) if ln.startswith("unset ")):lines.index("exit 0") + 1]
            line = re.search(r"TAIBE_LINEAGE='([^']+)'", "\n".join(body)).group(1)
            msg = re.search(r"cat '([^']+)'", "\n".join(body)).group(1)
            os.makedirs(os.path.dirname(msg), exist_ok=True)
            Path(msg).write_text("m", encoding="utf-8")
            launcher = Path(os.path.dirname(msg)) / "successor.sh"
            launcher.write_text("#!/bin/bash\n" + "\n".join(body) + "\n", encoding="utf-8")
            L.write_json(Path(tmp) / "lin" / f"{line}.json", {"line": line, "terminal": "terminal",
                                                               "window_id": None, "tty": None})
            # Ввод — после старта отсчёта: `script` отдаёт EOF с stdin в pty сразу, и read увидел бы его первым.
            proc = subprocess.Popen(["script", "-q", "/dev/null", "/bin/bash", str(launcher)], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            if enter_after is not None:
                time.sleep(enter_after)
                proc.stdin.write("\n")
                proc.stdin.flush()
            out, err = proc.communicate(timeout=60)
            run = subprocess.CompletedProcess(proc.args, proc.returncode, out, err)
            expect = claude_bin.endswith("true") and enter_after is None
            for _ in range(100 if expect else 0):                       # сторож отцеплен: ждём его запись
                if calls.exists():
                    break
                time.sleep(0.1)
            time.sleep(0.5)                                             # и что лишнего вызова не будет
            rec = L.read_json(Path(tmp) / "lin" / f"{line}.json") or {}
            return run, calls.read_text() if calls.exists() else "", rec

    def test_exit_0_closes_own_tty_after_countdown(self):
        run, calls, rec = self.run_launcher("/usr/bin/true")
        self.assertRegex(calls, r"^- /dev/ttys\d+ $", run.stdout)
        self.assertEqual(rec.get("exit"), 0)
        self.assertIn("Окно закроется через 1 с", run.stdout)

    def test_enter_keeps_window(self):
        run, calls, rec = self.run_launcher("/usr/bin/true", enter_after=1.0)
        self.assertEqual(calls, "", run.stdout)
        self.assertEqual((rec.get("exit"), rec.get("keep")), (0, True))

    def test_nonzero_exit_keeps_window(self):
        run, calls, rec = self.run_launcher("/usr/bin/false")
        self.assertEqual(calls, "")
        self.assertEqual(rec.get("exit"), 1)
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
                self.assertEqual((d["Label"], d["StartInterval"], d["RunAtLoad"]), (A.LABEL, 1800, False))
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
