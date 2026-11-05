#!/usr/bin/env python3
"""lineage.py / lineage_reap.py: сторож предшественника и уборка сессий.

Логика — на подставном Sys (процессы, kill, osascript, часы); интеграция (только macOS, `ps -E`) — на настоящих
процессах `exec -a claude` в своих сессиях, osascript — заглушка: окна не трогаются.
Run: python3 -I eval/tools/test_lineage.py
"""
import io
import json
import os
import signal
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
import lineage_reap as R  # noqa: E402
import lineage_retire as LR  # noqa: E402

TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
ST = "Wed Nov  4 20:00:00 2026"
CHILD, PARENT = "r.ab12.cd34", "r.ab12"


def P(pid, ppid, pgid, tty, cmd, start=ST):
    return L.Proc(pid, ppid, pgid, tty, start, cmd)


class FakeSys:
    def __init__(self, procs, env=None, status=None):
        self.p = {q.pid: q for q in procs}
        self.env = env or {}
        self.st = status or {}
        self.t = 1000.0
        self.events = []
        self.sent = []
        self.osa_calls = []
        self.osa_reply = "closed 19220"
        self.stubborn = set()

    def procs(self):
        self.n_procs = getattr(self, "n_procs", 0) + 1
        return dict(self.p)

    def alive(self, p):
        q = self.p.get(p.pid)
        return q is not None and L.norm(q.start) == L.norm(p.start)

    def env_line(self, pid):
        return self.env.get(pid)

    def status(self, pid):
        s = self.st.get(pid)
        return s(self.t) if callable(s) else s

    def kill(self, pid, sig):
        self.sent.append((pid, sig))
        if pid in self.p and (sig == signal.SIGKILL or pid not in self.stubborn):
            del self.p[pid]
        return True

    def killpg(self, pgid, sig):
        self.sent.append((-pgid, sig))
        for q in [q for q in self.p.values() if q.pgid == pgid]:
            if sig == signal.SIGKILL or q.pid not in self.stubborn:
                del self.p[q.pid]
        return True

    def osa(self, script, *args):
        self.osa_calls.append(args)
        return self.osa_reply

    def metrics(self):
        return {"claude": sum(1 for q in self.p.values() if L.argv0(q) == "claude"), "terminal_windows": "?",
                "swap": "-"}

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s
        for ev in [e for e in self.events if e[0] <= self.t]:
            self.events.remove(ev)
            ev[1]()

    def at(self, t, fn):
        self.events.append((self.t + t, fn))


def tree(successor_parent=211, with_tap=True, pred_host=TERMINAL):
    """Предшественник 300 на ttys005 в Terminal (группа: MCP 301; Bash 302 в своей группе → tap 303) и наследник 400
    на ttys006 (Bash 401 → tap 402)."""
    procs = [P(100, 1, 100, "??", pred_host), P(200, 100, 200, "ttys005", "login -pf u"),
             P(201, 200, 201, "ttys005", "-zsh"), P(300, 201, 300, "ttys005", "claude --settings /x/genome/backend.json"),
             P(301, 300, 300, "ttys005", "node mcp"), P(302, 300, 302, "??", "/bin/zsh -c source snap"),
             P(303, 302, 302, "??", "Python -I eval/nerve/nerve.py tap backend"),
             P(210, 100, 210, "ttys006", "login -pf u"), P(211, 210, 211, "ttys006", "-zsh"),
             P(400, successor_parent, 400, "ttys006", "claude --settings /x/genome/backend.json"),
             P(401, 400, 401, "??", "/bin/zsh -c source snap")]
    if with_tap:
        procs.append(P(402, 401, 401, "??", "Python -I -u eval/nerve/nerve.py tap backend"))
    return procs


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"TAIBE_LINEAGE_DIR": str(self.dir / "lin"),
                                                "CLAUDE_SESSIONS_DIR": str(self.dir / "sess")})
        self.env.start()
        self.lines = []

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def log(self, m):
        self.lines.append(m)

    def ack(self, pid=400, start=ST, line=CHILD):
        L.write_json(L.ldir() / f"{line}.ack", {"line": line, "pid": pid, "start": start})


class WatchTest(Base):
    def run_watch(self, sx, role="backend", timeout=600):
        self.pred = sx.p[300]
        return LR.watch(sx, self.pred, PARENT, CHILD, role, timeout, self.log, poll=1)

    def fake(self, **kw):
        return FakeSys(tree(**kw), env={400: CHILD, 300: PARENT})

    def test_success_takes_down_group_window_and_tty(self):
        sx = self.fake()
        L.write_json(L.ldir() / f"{PARENT}.json", {"terminal": "terminal", "window_id": "19220", "tty": "/dev/ttys005"})
        sx.at(10, self.ack)
        self.assertEqual(self.run_watch(sx), 0, self.lines)
        for pid in (300, 301, 302, 303, 200, 201):
            self.assertNotIn(pid, sx.p, pid)
        for pid in (400, 401, 402, 210, 211):
            self.assertIn(pid, sx.p, pid)
        self.assertIn((-300, signal.SIGTERM), sx.sent)
        self.assertEqual(sx.osa_calls, [("/dev/ttys005", "19220")])
        self.assertIn((201, signal.SIGHUP), sx.sent)

    def test_successor_died_after_ack(self):
        sx = self.fake()
        self.ack(pid=999)
        self.assertEqual(self.run_watch(sx), 3)
        self.assertEqual(sx.sent, [])
        self.assertIn("не жив", " ".join(self.lines))

    def test_no_ack_until_timeout(self):
        sx = self.fake()
        self.assertEqual(self.run_watch(sx, timeout=30), 3)
        self.assertEqual(sx.sent, [])

    def test_no_tap_means_monitor_not_armed(self):
        sx = self.fake(with_tap=False)
        self.ack()
        self.assertEqual(self.run_watch(sx), 3)
        self.assertEqual(sx.sent, [])
        self.assertIn("nerve.py tap backend", " ".join(self.lines))

    def test_tap_appears_later(self):
        sx = self.fake(with_tap=False)
        self.ack()
        sx.at(60, lambda: sx.p.update({402: P(402, 401, 401, "??", "python3 -I eval/nerve/nerve.py tap backend")}))
        self.assertEqual(self.run_watch(sx), 0, self.lines)
        self.assertNotIn(300, sx.p)

    def test_pid_reused(self):
        sx = self.fake()
        self.ack(start="Tue Nov  3 10:00:00 2026")
        self.assertEqual(self.run_watch(sx), 3)
        self.assertEqual(sx.sent, [])

    def test_other_lineage(self):
        sx = self.fake()
        sx.env[400] = "r.zzzz.yyyy"
        self.ack()
        self.assertEqual(self.run_watch(sx), 3)
        self.assertEqual(sx.sent, [])

    def test_successor_inside_predecessor_tree(self):
        sx = self.fake(successor_parent=302)
        self.ack()
        self.assertEqual(self.run_watch(sx), 3)
        self.assertEqual(sx.sent, [])
        self.assertIn("в дереве", " ".join(self.lines))

    def test_predecessor_left_by_itself(self):
        sx = self.fake()
        sx.at(10, lambda: sx.p.pop(300))
        self.assertEqual(self.run_watch(sx), 0)
        self.assertEqual(sx.sent, [])

    def test_stubborn_gets_kill_after_term_wait(self):
        sx = self.fake()
        sx.stubborn = {301}
        self.ack()
        t0 = sx.t
        self.assertEqual(self.run_watch(sx), 0)
        self.assertIn((301, signal.SIGKILL), sx.sent)
        self.assertGreaterEqual(sx.t - t0, L.TERM_WAIT)

    def test_waits_until_predecessor_turn_ends(self):
        sx = self.fake()
        sx.st[300] = lambda t: "busy" if t < 1120 else "idle"
        self.ack()
        self.assertEqual(self.run_watch(sx), 0)
        self.assertGreaterEqual(sx.t, 1120)

    def test_successor_dies_while_predecessor_busy(self):
        sx = self.fake()
        sx.st[300] = lambda t: "busy" if t < 1120 else "idle"
        self.ack()
        sx.at(30, lambda: [sx.p.pop(q) for q in (402, 401, 400)])
        self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assertEqual(sx.sent, [])
        self.assertIn(300, sx.p)
        self.assertIn("не жив", " ".join(self.lines))

    def test_tap_dropped_while_predecessor_busy(self):
        sx = self.fake()
        sx.st[300] = lambda t: "busy" if t < 1120 else "idle"
        self.ack()
        sx.at(30, lambda: sx.p.pop(402))
        self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assertEqual(sx.sent, [])
        self.assertIn("пропал", " ".join(self.lines))

    def test_no_tap_on_either_side_takes_down(self):
        """Ночь (TEAM-0 §10.6): монитора нет ни у предшественника, ни у наследника — паритет, P снят."""
        sx = self.fake(with_tap=False)
        sx.p.pop(303)
        self.ack()
        self.assertEqual(self.run_watch(sx), 0, self.lines)
        self.assertNotIn(300, sx.p)
        self.assertIn("tap не требую", " ".join(self.lines))

    def test_pre_ack_wait_skips_full_ps(self):
        """До квитанции — только дешёвый alive(p), полный procs() — один раз (паритет tap)."""
        sx = self.fake()
        self.assertEqual(self.run_watch(sx, timeout=300), 3)
        self.assertEqual(sx.n_procs, 1)

    def test_busy_past_idle_wait_kept(self):
        sx = self.fake()
        sx.st[300] = "busy"
        self.ack()
        self.assertEqual(self.run_watch(sx), 3, self.lines)
        self.assertEqual(sx.sent, [])
        self.assertIn("занят дольше", " ".join(self.lines))

    def test_vscode_host_window_untouched(self):
        sx = self.fake(pred_host="/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin)")
        self.ack()
        self.assertEqual(self.run_watch(sx), 0)
        self.assertNotIn(300, sx.p)
        self.assertEqual(sx.osa_calls, [])

    def test_record_of_other_window_falls_back_to_tty(self):
        sx = self.fake()
        L.write_json(L.ldir() / f"{PARENT}.json", {"terminal": "terminal", "window_id": "777", "tty": "/dev/ttys099"})
        self.ack()
        self.run_watch(sx)
        self.assertEqual(sx.osa_calls, [("/dev/ttys005", "")])

    def test_multi_tab_window_not_closed_no_hup(self):
        sx = self.fake()
        sx.osa_reply = "skip 19220: tabs 2"
        self.ack()
        self.assertEqual(self.run_watch(sx), 0)
        self.assertNotIn((201, signal.SIGHUP), sx.sent)
        self.assertIn(201, sx.p)

    def test_iterm_record_window_untouched(self):
        sx = self.fake()
        L.write_json(L.ldir() / f"{PARENT}.json", {"terminal": "iterm"})
        self.ack()
        self.run_watch(sx)
        self.assertEqual(sx.osa_calls, [])


class CommandsTest(Base):
    def test_record_rejects_path_in_line(self):
        sx = FakeSys([])
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(L.main(["record", "--line", "../x", "--terminal", "terminal"], sx), 2)
        self.assertFalse((self.dir / "x.json").exists())

    def test_record_and_ack(self):
        me = os.getpid()
        sx = FakeSys([P(700, 1, 700, "ttys001", "claude"), P(me, 700, me, "??", "python3 lineage.py ack")])
        self.assertEqual(L.main(["record", "--line", CHILD, "--terminal", "terminal", "--window-id", "5",
                                 "--tty", "/dev/ttys001"], sx), 0)
        self.assertEqual(L.read_json(L.ldir() / f"{CHILD}.json")["window_id"], "5")
        with mock.patch.dict(os.environ, {"TAIBE_LINEAGE": CHILD}), mock.patch("sys.stdout", io.StringIO()):
            self.assertEqual(L.main(["ack"], sx), 0)
        a = L.read_json(L.ldir() / f"{CHILD}.ack")
        self.assertEqual((a["pid"], a["start"]), (700, ST))

    def test_retire_refuses_foreign_child_line(self):
        with mock.patch.dict(os.environ, {"TAIBE_LINEAGE": PARENT}), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(L.main(["retire", "--child", "r.other.x1y2", "--foreground"], FakeSys([])), 2)

    def test_retire_outside_claude_is_noop(self):
        with mock.patch.dict(os.environ, {"TAIBE_LINEAGE": PARENT}), mock.patch("sys.stdout", io.StringIO()) as out:
            self.assertEqual(L.main(["retire", "--child", CHILD, "--foreground"], FakeSys([])), 0)
        self.assertIn("снимать некого", out.getvalue())


class ReapTest(Base):
    def setUp(self):
        super().setUp()
        self.root = self.dir / "proj"
        (self.root / "worktrees" / "x").mkdir(parents=True)
        self.me = os.getpid()
        self.procs = [P(100, 1, 100, "??", TERMINAL), P(700, 100, 700, "ttys001", "claude"),
                      P(self.me, 700, self.me, "??", "python3 lineage.py reap")]
        self.env_l = {}
        self.now = 1.8e9  # часы FakeSys: updatedAt в sessions/*.json — мс от эпохи

    def sess(self, pid, line=None, role="backend", status="idle", idle_h=1.0, cwd=None, start=ST, pstart=None):
        cmd = "claude" + (f" --settings /x/genome/{role}.json" if role else "")
        self.procs.append(P(pid, 100, pid, f"ttys{pid % 1000:03d}", cmd, start))
        if line:
            self.env_l[pid] = line
        now = self.now
        L.write_json(L.sessions_dir() / f"{pid}.json", {
            "pid": pid, "procStart": pstart or start, "name": f"s-{pid}", "status": status,
            "cwd": str(cwd or self.root / "worktrees" / "x"), "startedAt": (now - 48 * 3600) * 1000,
            "updatedAt": (now - idle_h * 3600) * 1000})

    def reap(self, *args, stdin=None):
        sx = FakeSys(self.procs, env=self.env_l)
        sx.t = self.now
        out = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", out), \
                mock.patch("sys.stdin", stdin or io.StringIO("")):
            rc = L.main(["reap", "--root", str(self.root), *args], sx)
        return rc, out.getvalue(), sx

    def verdicts(self, text):
        return {int(ln.split()[0]): ln for ln in text.splitlines()[1:] if ln.strip()[:1].isdigit()}

    def test_candidates_and_protected(self):
        self.sess(701, line="r.a1", idle_h=2)                       # принят наследником 702
        self.sess(702, line="r.a1.b2", idle_h=0.1)                  # наследник, текущая роль
        L.write_json(L.ldir() / "r.a1.b2.ack", {"pid": 702, "start": ST})
        self.sess(703, line="r.c3", role="plan", idle_h=25)         # простой, не текущая роль plan
        self.sess(704, line="r.x9.d4", role="plan", idle_h=30)      # текущая роль plan (не наследник 703), хоть и простой
        self.sess(705, line="r.e5", role="coord", idle_h=40, cwd="/elsewhere/proj")
        self.sess(706, line="r.f6", role="boards", status="waiting", idle_h=50)
        self.sess(707, line="r.g7", role=None, idle_h=3)             # не роль Т3, простой меньше суток
        self.sess(708, line="r.h8", pstart="Mon Nov  2 10:00:00 2026")  # файл от другого процесса — не в списке
        (L.sessions_dir() / "x.key").write_text("k")
        rc, out, _ = self.reap()
        v = self.verdicts(out)
        self.assertEqual(rc, 0, out)
        self.assertIn("наследник принял", v[701])
        self.assertIn("текущая роль", v[702])
        self.assertIn("простой 25", v[703])
        self.assertIn("текущая роль", v[704])
        self.assertIn("чужой проект", v[705])
        self.assertIn("ждёт ввода", v[706])
        self.assertIn("живая", v[707])
        self.assertNotIn(708, v)
        shown = L.read_json(L.ldir() / "reap-list.json")
        self.assertEqual(sorted(c["pid"] for c in shown["candidates"]), [701, 703])

    def test_resumed_session_line_from_transcript(self):
        """--resume теряет TAIBE_LINEAGE: линия — из первого промпта транскрипта по sessionId (05.11, роль 4)."""
        sid = "3904fd53-0ebf-4dcc-a5a9-10b640809dcd"
        self.sess(701, line=None, idle_h=1)
        self.sess(702, line="r.a1", idle_h=30)                         # предшественник, gen 1
        d = L.read_json(L.sessions_dir() / "701.json")
        d["sessionId"] = sid
        L.write_json(L.sessions_dir() / "701.json", d)
        proj = self.dir / "projects" / "-x-proj"
        proj.mkdir(parents=True)
        recs = [{"type": "mode"}, {"type": "user", "isMeta": True, "message": {"content": "Линия: r.zz.zz"}},
                {"type": "user", "message": {"content": "Сборка Т3, ключ реестра backend… Линия: r.a1.b2 (поколение 2)"}},
                {"type": "user", "message": {"content": [{"type": "text", "text": "Линия: r.q.q"}]}}]
        (proj / f"{sid}.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs), encoding="utf-8")
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECTS_DIR": str(self.dir / "projects")}):
            _, out, _ = self.reap()
        v = self.verdicts(out)
        self.assertIn("текущая роль", v[701])                          # линия r.a1.b2 длиннее, чем у 702
        self.assertIn(" 2 ", v[701])
        self.assertIn("сменён наследником (поколение 2)", v[702])  # 701 продолжает линию 702

    def test_superseded_without_ack(self):
        """Наследник той же роли продолжает линию, квитанции нет (--resume, ночные передачи) — кандидат через 1 ч."""
        self.sess(701, line="r.a1", idle_h=2)
        self.sess(702, line="r.a1.b2.c3", idle_h=0.1)
        _, out, _ = self.reap()
        v = self.verdicts(out)
        self.assertIn("сменён наследником (поколение 3)", v[701])
        self.assertIn("текущая роль", v[702])
        self.assertEqual([c["pid"] for c in L.read_json(L.ldir() / "reap-list.json")["candidates"]], [701])

    def test_superseded_short_idle_kept(self):
        self.sess(701, line="r.a1", idle_h=0.5)
        self.sess(702, line="r.a1.b2", idle_h=0.1)
        self.assertIn("живая", self.verdicts(self.reap()[1])[701])
        _, out, _ = self.reap("--superseded-idle-hours", "0.25")
        self.assertIn("сменён наследником", self.verdicts(out)[701])

    def test_sibling_or_other_role_is_not_successor(self):
        self.sess(701, line="r.a1.b2", idle_h=5)                    # сиблинг: та же длина, другая ветка
        self.sess(702, line="r.a1.c3", idle_h=0.1)
        self.sess(703, line="r.a10.x1", idle_h=0.1)                  # префикс без точки — не наследник r.a1
        self.sess(704, line="r.a1", role="plan", idle_h=5)           # наследник есть, но роли backend
        self.sess(705, line="r.e5", role=None, idle_h=5)             # не роль Т3
        self.sess(706, line="r.e5.f6", role=None, idle_h=0.1)
        v = self.verdicts(self.reap()[1])
        for pid in (701, 704, 705):
            self.assertNotIn("сменён", v[pid])
            self.assertNotIn("кандидат", v[pid])

    def test_superseded_busy_or_waiting_kept(self):
        self.sess(701, line="r.a1", status="busy", idle_h=5)
        self.sess(702, line="r.a1.b2", idle_h=0.1)
        self.sess(703, line="r.c3", role="plan", status="waiting", idle_h=5)
        self.sess(704, line="r.c3.d4", role="plan", idle_h=0.1)
        _, out, _ = self.reap("--superseded-idle-hours", "0")
        v = self.verdicts(out)
        self.assertIn("живая", v[701])
        self.assertIn("ждёт ввода", v[703])
        self.assertEqual(L.read_json(L.ldir() / "reap-list.json")["candidates"], [])

    def test_line_subcommand(self):
        sx = FakeSys([P(700, 1, 700, "ttys001", "claude --resume x"), P(self.me, 700, self.me, "??", "python3")])
        with mock.patch.dict(os.environ, {"TAIBE_LINEAGE": ""}), mock.patch("sys.stdout", io.StringIO()) as out:
            self.assertEqual(L.main(["line"], sx), 1)
            sx.env[700] = "r.k1.k2"
            self.assertEqual(L.main(["line"], sx), 0)
        self.assertEqual(out.getvalue().strip(), "r.k1.k2")

    def test_own_session_never_candidate(self):
        self.procs = [q for q in self.procs if q.pid != 700]
        self.sess(700, line="r.me", idle_h=99)
        _, out, _ = self.reap()
        self.assertIn("своя", self.verdicts(out)[700])

    def test_kill_needs_fresh_list(self):
        self.sess(703, line="r.c3", role="plan", idle_h=25)
        self.sess(704, line="r.c3.d4", role="plan", idle_h=1)
        rc, out, sx = self.reap("--kill", "--yes")
        self.assertEqual(rc, 2, out)
        self.assertEqual(sx.sent, [])

    def test_kill_only_listed_and_confirmed(self):
        self.sess(703, line="r.c3", role="plan", idle_h=25)
        self.sess(704, line="r.c3.d4", role="plan", idle_h=1)        # текущая plan — 703 кандидат
        self.reap()
        self.sess(709, line="r.k9", role=None, idle_h=26)            # стал кандидатом после показа
        rc, out, sx = self.reap("--kill")                             # нет tty и нет --yes
        self.assertEqual(rc, 2, out)
        self.assertEqual(sx.sent, [])
        rc, out, sx = self.reap("--kill", "--yes")
        self.assertEqual(rc, 0, out)
        self.assertNotIn(703, sx.p)
        self.assertIn(709, sx.p)
        self.assertIn("claude: ", out)
        rc, out, sx = self.reap("--kill", "--yes")                    # список израсходован
        self.assertEqual(rc, 2, out)

    def test_kill_stale_list(self):
        self.sess(703, line="r.c3", role="plan", idle_h=25)
        self.sess(704, line="r.c3.d4", role="plan", idle_h=1)
        self.assertIn("кандидатов 1", self.reap()[1])
        shown = L.read_json(L.ldir() / "reap-list.json")
        shown["at"] -= L.LIST_TTL + 1
        L.write_json(L.ldir() / "reap-list.json", shown)
        rc, _, sx = self.reap("--kill", "--yes")
        self.assertEqual((rc, sx.sent), (2, []))


FAKE_CLAUDE = r"""
import subprocess, sys, time
mode, lin, child = sys.argv[1:4]
py = sys.executable
if mode == "pred":
    subprocess.Popen(["sleep", "600"])                                   # MCP-сервер: в группе
    subprocess.run(["sh", "-c", "sleep 600 &"])                          # сирота в группе (ppid 1)
    subprocess.Popen([py, "-c", "import time; time.sleep(600)"], process_group=0)  # Bash-инструмент: своя группа
    subprocess.run([py, "-I", lin, "retire", "--child", child, "--role", "backend", "--poll", "0.2",
                    "--timeout", "60"])
elif mode == "succ":
    subprocess.Popen(["sh", "-c", "sleep 600; :", "x", "nerve.py", "tap", "backend"])  # Monitor наследника
    time.sleep(0.3)
    subprocess.run([py, "-I", lin, "ack"])
else:                                                                     # наследник упал сразу после квитанции
    subprocess.run([py, "-I", lin, "ack"])
    sys.exit(0)
time.sleep(600)
"""


@unittest.skipUnless(sys.platform == "darwin", "ps -E и lstart — macOS")
class RealProcessTest(Base):
    """Настоящие процессы. Предшественник — лидер своей группы: потомок в группе, сирота в группе, потомок в своей
    группе, сторож retire. Наследник — такой же «claude» с потомком `… nerve.py tap backend`. osascript — заглушка,
    у процессов нет tty: окна не трогаются."""

    def setUp(self):
        super().setUp()
        osa = self.dir / "osa.sh"
        osa.write_text('#!/bin/sh\necho "$@" >> "%s"\necho "not found"\n' % (self.dir / "osa.log"))
        osa.chmod(0o700)
        os.environ["LINEAGE_OSASCRIPT"] = str(osa)  # Base.setUp патчит os.environ целиком — вернётся в tearDown
        self.real = subprocess.run(["ps", "-o", "comm=", "-p", str(os.getpid())], capture_output=True,
                                   text=True).stdout.strip()
        self.started = []

    def tearDown(self):
        for p in self.started:
            for pid in self.group_and_kids(p.pid) | {p.pid}:
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            p.wait(timeout=5)
        for ln in subprocess.run(["ps", "-A", "-o", "pid=,command="], capture_output=True, text=True).stdout.splitlines():
            if f"retire --child {CHILD}" in ln and str(L.ldir()) not in ln:  # сторож этого теста (отцеплен, ppid 1)
                env = subprocess.run(["ps", "-E", "-ww", "-o", "command=", "-p", ln.split()[0]], capture_output=True,
                                     text=True).stdout
                if f"TAIBE_LINEAGE_DIR={L.ldir()}" in env:
                    os.kill(int(ln.split()[0]), signal.SIGKILL)
        super().tearDown()

    def spawn(self, line, mode):
        p = subprocess.Popen(["claude", "-I", "-c", FAKE_CLAUDE, mode, os.path.join(HERE, "lineage.py"), CHILD],
                             executable=self.real, env={**os.environ, "TAIBE_LINEAGE": line}, start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.started.append(p)
        return p

    def alive(self, pid):
        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return st[:1] not in ("", "Z")

    def wait_log(self, needle, secs=40):
        log = L.ldir() / f"{CHILD}.retire.log"
        until = time.time() + secs
        while time.time() < until:
            text = log.read_text(encoding="utf-8") if log.exists() else ""
            if needle in text:
                return text
            time.sleep(0.2)
        self.fail(f"нет «{needle}» в журнале: {log.read_text(encoding='utf-8') if log.exists() else '—'}")

    def group_and_kids(self, pid):
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid="], capture_output=True, text=True).stdout
        rows = [tuple(map(int, ln.split())) for ln in out.splitlines() if ln.strip()]
        res = {r[0] for r in rows if r[2] == pid}
        res |= L.descendants({r[0]: L.Proc(r[0], r[1], r[2], "", "", "") for r in rows}, pid)
        return res - {pid}

    def test_successor_accepted_predecessor_gone(self):
        pred = self.spawn(PARENT, "pred")
        until = time.time() + 15  # под нагрузкой передний план retire (ps -A ≈0,4 с) ещё в группе — ждём, пока уйдёт
        while len(doomed := self.group_and_kids(pred.pid) | {pred.pid}) != 4 and time.time() < until:
            time.sleep(0.2)
        self.assertEqual(len(doomed), 4, doomed)  # claude, sleep в группе, сирота в группе, потомок в своей группе
        succ = self.spawn(CHILD, "succ")
        text = self.wait_log("TERM")
        time.sleep(0.5)
        self.assertEqual([p for p in doomed if self.alive(p)], [], text)
        self.assertTrue(self.alive(succ.pid), text)
        self.assertTrue(any(self.alive(p) for p in self.group_and_kids(succ.pid)), text)
        self.assertIn("окно не трогаю", text)

    def test_successor_crashed_predecessor_kept(self):
        pred = self.spawn(PARENT, "pred")
        time.sleep(0.5)
        self.spawn(CHILD, "crash")
        text = self.wait_log("предшественника не трогаю")
        self.assertIn("не жив", text)
        self.assertTrue(self.alive(pred.pid), text)


if __name__ == "__main__":
    unittest.main(verbosity=1)
