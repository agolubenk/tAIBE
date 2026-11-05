#!/usr/bin/env python3
"""team_status.py: живая роль продукта, ожидание новой сессии, пульс и подъём нерва (OPS-24).

Логика — на подставном Sys из test_lineage (процессы, часы) плюс подставной launchctl; интеграция (только macOS) —
настоящий процесс `claude` с геномом роли и spawn_session.sh --launch --dry-run: живую роль он не открывает второй раз.
Run: python3 -I eval/tools/test_team_status.py
"""
import io
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lineage as L  # noqa: E402
import team_status as TS  # noqa: E402
from test_lineage import ST, TERMINAL, Base, FakeSys, P  # noqa: E402

NOW = 1.8e9  # часы FakeSys: startedAt/updatedAt в sessions/*.json — мс от эпохи


class TeamSys(FakeSys):
    def __init__(self, procs, env=None, launchctl=None):
        super().__init__(procs, env=env)
        self.t = NOW
        self.lc = launchctl or {}
        self.lc_calls = []

    def launchctl(self, *args):
        self.lc_calls.append(args)
        return self.lc.get(args[0], (0, ""))


class Roles(Base):
    def setUp(self):
        super().setUp()
        self.root = self.dir / "proj"
        (self.root / "worktrees" / "x").mkdir(parents=True)
        self.procs = [P(100, 1, 100, "??", TERMINAL)]
        self.env_l = {}

    def sess(self, pid, line, role, age_h=1.0, cwd=None, status="idle", started=None):
        cmd = "claude" + (f" --settings /x/genome/{role}.json" if role else "")
        self.procs.append(P(pid, 100, pid, f"ttys{pid % 1000:03d}", cmd))
        self.env_l[pid] = line
        L.write_json(L.sessions_dir() / f"{pid}.json", {
            "pid": pid, "procStart": ST, "name": f"s-{pid}", "status": status,
            "cwd": str(cwd or self.root / "worktrees" / "x"),
            "startedAt": (started if started is not None else NOW - age_h * 3600) * 1000,
            "updatedAt": (NOW - 60) * 1000})

    def sx(self):
        return TeamSys(self.procs, env=self.env_l)

    def run_main(self, *argv, sx=None):
        sx = sx or self.sx()
        out = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", out):
            rc = TS.main(list(argv), sx)
        return rc, out.getvalue(), sx


class LiveRoleTest(Roles):
    def test_youngest_without_successor_wins(self):
        self.sess(701, "r.a1.b2.c3.d4", "coord", age_h=30)   # длинная старая линия Координатора
        self.sess(702, "r.z9", "coord", age_h=1)             # новая корневая линия после перезапуска — она живая
        self.sess(711, "r.k1", "backend", age_h=5)           # принят наследником 712
        self.sess(712, "r.k1.m2", "backend", age_h=2)
        L.write_json(L.ldir() / "r.k1.m2.ack", {"pid": 712, "start": ST})
        self.sess(721, "r.p1", "plan", age_h=3)              # потомок 722 жив, квитанции ещё нет
        self.sess(722, "r.p1.q2", "plan", age_h=0.1)
        self.sess(731, "r.f1", "frontend", cwd="/elsewhere/proj")  # чужой продукт
        self.sess(741, "r.n1", None)                         # без генома — не роль
        live = TS.live_roles(TS.role_rows(self.sx(), str(self.root)))
        self.assertEqual({k: v["pid"] for k, v in live.items()}, {"coord": 702, "backend": 712, "plan": 722})

    def test_successor_with_dead_successor_does_not_revive_role(self):
        """Квитанция есть, наследника уже нет (ack†) — предшественник роль не держит: команда откроет новую."""
        self.sess(751, "r.w1", "release")
        L.write_json(L.ldir() / "r.w1.x2.ack", {"pid": 999, "start": ST})
        self.assertNotIn("release", TS.live_roles(TS.role_rows(self.sx(), str(self.root))))

    def test_live_command_rc_and_text(self):
        self.sess(702, "r.z9", "coord")
        rc, out, _ = self.run_main("live", "--role", "coord", "--cwd", str(self.root))
        self.assertEqual(rc, 0, out)
        self.assertIn("pid 702 s-702 idle", out)
        rc, out, _ = self.run_main("live", "--role", "plan", "--cwd", str(self.root))
        self.assertEqual((rc, out), (1, ""))

    def test_status_and_stop(self):
        self.sess(702, "r.z9", "coord")
        self.sess(701, "r.a1.b2", "coord", age_h=30)
        os.environ["NERVE_PLIST"] = str(self.dir / "none.plist")
        rc, out, _ = self.run_main("status", "--cwd", str(self.root))
        self.assertEqual(rc, 0, out)
        lines = out.splitlines()
        self.assertTrue(lines[1].startswith("1 coord") and "pid 702" in lines[1] and "ещё 1 старых" in lines[1], out)
        self.assertIn("5 release   нет", out)
        self.assertIn("нерв: не установлен", out)
        rc, out, _ = self.run_main("stop", "--cwd", str(self.root))
        self.assertIn("kill 702   # 1 coord s-702", out)
        self.assertNotIn("kill 701", out)


class WaitTest(Roles):
    def test_waits_for_the_new_line(self):
        sx = self.sx()
        sx.at(6, lambda: (self.sess(800, "r.z9.n1", "release", started=sx.t),
                          sx.p.update({800: next(p for p in self.procs if p.pid == 800)}), sx.env.update({800: "r.z9.n1"})))
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            rc = TS.main(["wait", "--role", "release", "--line", "r.z9.n1", "--timeout", "90"], sx)
        self.assertEqual(rc, 0, out.getvalue())
        self.assertIn("pid 800", out.getvalue())
        self.assertLess(sx.t - NOW, 10)

    def test_timeout_and_no_full_ps_without_new_session_file(self):
        self.sess(702, "r.z9", "coord", age_h=1)  # старая сессия той же роли — не та линия и не свежий файл
        rc, out, sx = self.run_main("wait", "--role", "coord", "--line", "r.z9.n1", "--timeout", "10")
        self.assertEqual(rc, 1)
        self.assertIn("не поднялась за 10 с", out)
        self.assertEqual(getattr(sx, "n_procs", 0), 0, "без нового файла сессии полный ps не нужен")

    def test_other_role_with_same_line_is_not_a_hit(self):
        self.sess(801, "r.z9.n1", "plan", started=NOW)
        rc, out, _ = self.run_main("wait", "--role", "release", "--line", "r.z9.n1", "--timeout", "4")
        self.assertEqual(rc, 1, out)


class NerveTest(Base):
    def setUp(self):
        super().setUp()
        self.home = self.dir / "nerve"
        (self.home / "state").mkdir(parents=True)
        L.write_json(self.home / "config.json", {"interval_seconds": 300, "tap": {"heartbeat_stale_min": 5}})
        self.plist = self.dir / "space.hrhelper.nerve.plist"
        os.environ["NERVE_PLIST"] = str(self.plist)

    def install(self):
        with open(self.plist, "wb") as f:
            plistlib.dump({"Label": TS.LABEL, "ProgramArguments": ["python3", "-I", str(self.home / "nerve.py"), "run"]}, f)

    def pulse(self, ago_s):
        hb = datetime.fromtimestamp(NOW - ago_s, timezone.utc).isoformat(timespec="seconds")
        L.write_json(self.home / "state" / "state.json", {"heartbeat": hb})
        L.write_json(self.home / "state" / "cycle.json", {"seconds": 300, "at": hb})

    def nerve(self, lc, *args):
        sx = TeamSys([], launchctl=lc)
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            rc = TS.main(["nerve", *args], sx)
        return rc, out.getvalue(), sx

    RUNNING = (0, "gui/501/space.hrhelper.nerve = {\n\tactive count = 1\n\tstate = running\n\tpid = 18870\n"
                  "\tresource coalition = {\n\t\tstate = active\n\t}\n}")

    def test_not_installed_only_hints(self):
        rc, out, sx = self.nerve({"print": (113, "Could not find service")}, "--fix")
        self.assertEqual(rc, 1)
        self.assertIn("не установлен", out)
        self.assertEqual([c[0] for c in sx.lc_calls], ["print"], "без plist — ни bootstrap, ни kickstart")

    def test_not_loaded_bootstraps(self):
        self.install()
        rc, out, sx = self.nerve({"print": (113, "Could not find service")}, "--fix")
        self.assertEqual(rc, 0, out)
        self.assertEqual(sx.lc_calls[-1], ("bootstrap", f"gui/{os.getuid()}", str(self.plist)))
        self.assertIn("bootstrap → загружен", out)

    def test_silent_pulse_kickstarts(self):
        self.install()
        self.pulse(ago_s=20 * 60)
        rc, out, sx = self.nerve({"print": self.RUNNING}, "--fix")
        self.assertEqual(rc, 0, out)
        self.assertEqual(sx.lc_calls[-1], ("kickstart", "-k", f"gui/{os.getuid()}/{TS.LABEL}"))
        self.assertIn("МОЛЧИТ", out)

    def test_fresh_pulse_no_action_and_top_level_state(self):
        self.install()
        self.pulse(ago_s=60)
        rc, out, sx = self.nerve({"print": self.RUNNING}, "--fix")
        self.assertEqual(rc, 0, out)
        self.assertEqual([c[0] for c in sx.lc_calls], ["print"])
        self.assertIn("работает, pid 18870", out, "вложенный «state = active» не перекрывает state службы")
        self.assertIn("· ок ·", out)
        self.assertEqual(TS.nerve_home(self.plist), self.home)


@unittest.skipUnless(sys.platform == "darwin", "ps -E и lstart — macOS")
class SpawnLaunchTest(Base):
    """Настоящий «claude» с геномом coord в папке продукта: --launch его не открывает второй раз, plan — открывает."""

    def setUp(self):
        super().setUp()
        self.root = self.dir / "proj"
        self.root.mkdir()
        real = subprocess.run(["ps", "-o", "comm=", "-p", str(os.getpid())], capture_output=True, text=True).stdout.strip()
        self.p = subprocess.Popen(["claude", "-I", "-c", "import time; time.sleep(60)", "--settings", "/x/genome/coord.json"],
                                  executable=real, env={**os.environ, "TAIBE_LINEAGE": "r.t1"}, start_new_session=True,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        start = L.Sys().procs()[self.p.pid].start
        L.write_json(L.sessions_dir() / f"{self.p.pid}.json", {
            "pid": self.p.pid, "procStart": start, "name": "fake-coord", "status": "idle", "cwd": str(self.root),
            "startedAt": (datetime.now().timestamp() - 60) * 1000, "updatedAt": datetime.now().timestamp() * 1000})
        os.environ["NERVE_PLIST"] = str(self.dir / "none.plist")

    def tearDown(self):
        self.p.kill()
        self.p.wait(timeout=5)
        super().tearDown()

    def launch(self, *extra):
        env = {**os.environ, "TMPDIR": str(self.dir)}
        return subprocess.run(["bash", os.path.join(HERE, "spawn_session.sh"), "--launch", "--roles", "coord,plan",
                               "--dry-run", "--cwd", str(self.root), *extra], capture_output=True, text=True, env=env,
                              timeout=60)

    def test_live_role_skipped_other_opened_force_opens(self):
        r = self.launch()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"жива: coord · pid {self.p.pid} fake-coord", r.stdout)
        self.assertNotIn("# coord: вставить", r.stdout)
        self.assertIn("# plan: вставить", r.stdout)
        self.assertIn("coord — жива, не открывал", r.stdout)
        self.assertIn("plan — команда напечатана", r.stdout)
        self.assertIn("нерв: не установлен", r.stdout)
        r = self.launch("--force")
        self.assertIn("# coord: вставить", r.stdout, r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
