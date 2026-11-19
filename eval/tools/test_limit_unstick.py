"""SE-174: limit_unstick closes the Claude Code limit menu in role panes, under the Control conditions S1–S6.

tmux is a fake (TAIBE_TMUX): capture-pane answers the screen of the pane by the number of keys already sent to it,
send-keys writes the session files that the key changes. Line records, session files and processes are fakes too.

Run: python3 -I eval/tools/test_limit_unstick.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lineage as L  # noqa: E402
import limit_unstick as U  # noqa: E402
from test_lineage import FakeSys, P  # noqa: E402

FAKE = r"""#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
a = sys.argv[3:]  # after -L <socket>
with open(os.path.join(here, "calls.log"), "a") as f:
    f.write(json.dumps(a) + "\n")
spec = json.load(open(os.path.join(here, "spec.json")))
calls = [json.loads(x) for x in open(os.path.join(here, "calls.log"))]
if a[0] == "capture-pane":
    pane = a[a.index("-t") + 1]
    n = sum(1 for c in calls if c[0] == "send-keys" and c[2] == pane)
    if spec.get("by_capture"):  # by the number of earlier snapshots: the owner types between two snapshots
        n = sum(1 for c in calls[:-1] if c[0] == "capture-pane" and c[c.index("-t") + 1] == pane)
    screens = spec["screens"].get(pane, [""])
    shown = screens[min(n, len(screens) - 1)]
    if shown is None:  # capture-pane failed
        sys.exit(1)
    sys.stdout.write(shown)
    sys.exit(0)
if a[0] == "send-keys":
    for path, data in spec.get("on_key", {}).get(a[2], []):
        open(path, "w").write(json.dumps(data))
    sys.exit(spec.get("send_rc", 0))
if a[0] == "display-message" and a[-1] == "#{pane_in_mode}":  # mode of the pane by the number of keys already sent
    pane = a[a.index("-t") + 1]
    n = sum(1 for c in calls if c[0] == "send-keys" and c[2] == pane)
    modes = spec.get("in_mode", {}).get(pane, ["0"])
    mode = modes[min(n, len(modes) - 1)]
    if mode is None:  # display-message failed
        sys.exit(1)
    if mode == "0!":  # failed, yet printed 0: the return code decides
        sys.stdout.write("0\n")
        sys.exit(1)
    sys.stdout.write(mode + "\n")
    sys.exit(0)
out, rc = spec.get(a[0], ["", 0])
sys.stdout.write(out)
sys.exit(rc)
"""
SERVER = "100:200"
# The menu as the 2.1.326 source builds it: the title of the dialog, numbered options, the key guide. Assumed layout
# (frame, pointer, guide text): the live capture is still to come (N2 on SE-174).
# Живой снимок владельца 18.11 (пункт taibe-c-limit-menu-1811, панель %13, Claude Code 2.1.327); текст переписки
# заменён. Пустые строки снимок отбросил (grep -v), capture-pane их даёт — bottom() их тоже отбрасывает.
MENU = """  Роль ждёт задачу.
⏺ Automatic continue stopped after repeated usage limit hits · This task will not
  resume on its own (/rate-limit-options to try again)

❯ /rate-limit-options
───────────────────────────────────────────────────────────────────────────────────────────────
  What do you want to do?

  ❯ 1. Stop and wait for limit to reset
    2. Wait here, then continue automatically shortly
    3. Add funds to continue with usage credits
    4. Upgrade your plan

  Enter to confirm · Esc to cancel
───────────────────────────────────────────────────────────────────────────── taibe-plan-czc6 ─
"""
EMPTY = """  resume on its own (/rate-limit-options to try again)

───────────────────────────────────────────────────────────────────────────── taibe-plan-czc6 ─
❯ 
───────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)                 ✔ Update installed · /restart to apply
                                                        new task? /clear to save 170.5k tokens
"""
PREFILLED = EMPTY.replace("❯ ", "❯ continue")
DRAFT = EMPTY.replace("❯ ", "❯ исправь тест")
TYPED = PREFILLED.replace("continue", U.TEXT)        # the input line after send-keys -l TEXT
MIXED = PREFILLED.replace("continue", "ab" + U.TEXT)  # the owner typed «ab» between the snapshot and the text
# Раскладка в рамке — предположение до снимка; матч её тоже принимает.
BOXED = """  ⎿  Automatic continue stopped after repeated usage limit hits · This task will not resume on its own

╭────────────────────────────────────────────────────────────╮
│ What do you want to do?                                    │
│                                                            │
│ ❯ 1. Stop and wait for limit to reset                      │
│   2. Wait here, then continue automatically at 5pm         │
│                                                            │
│ Enter to confirm · Esc to cancel                           │
╰────────────────────────────────────────────────────────────╯
"""
PERMISSION = MENU + """
╭────────────────────────────────────────────────────────────╮
│ Bash command                                               │
│   rm -rf build                                             │
│ Do you want to proceed?                                    │
│ ❯ 1. Yes                                                   │
│   2. Yes, and don't ask again for rm commands              │
│   3. No, and tell Claude what to do differently (esc)      │
╰────────────────────────────────────────────────────────────╯
"""


class Base(unittest.TestCase):
    PANE, TTY, PID, LINE = "%7", "/dev/ttys005", 700, "r.ab12"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        fake = d / "tmux"
        fake.write_text(FAKE, encoding="utf-8")
        fake.chmod(0o755)
        self.log, self.spec_file, self.sess, self.lin = d / "calls.log", d / "spec.json", d / "sess", d / "lineage"
        self.sess.mkdir()
        self.lin.mkdir()
        self.env = mock.patch.dict(os.environ, {
            "TAIBE_TMUX": str(fake), "TAIBE_TMUX_SOCKET": "agents-test", "TAIBE_TMUX_SERVICE": "off",
            "CLAUDE_SESSIONS_DIR": str(self.sess), "TAIBE_LINEAGE_DIR": str(self.lin)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.tmp.cleanup)
        self.slept = []
        self.record(self.LINE, "backend", self.PANE, self.TTY, "4242")
        self.session(self.PID, "waiting", "dialog open")
        self.sx = FakeSys([P(4242, 1, 4242, "ttys005", "-zsh"), P(self.PID, 4242, self.PID, "ttys005", "claude")])

    def record(self, line, role, pane, tty, pane_pid, server=SERVER):
        L.write_json(L.lfile(line, ".json"), {"line": line, "terminal": "tmux", "role": role, "pane": pane, "tty": tty,
                                              "pane_pid": pane_pid, "server": server})

    def session(self, pid, status, waiting=None, kind="interactive", **extra):
        L.write_json(self.sess / f"{pid}.json", dict(self.sess_data(pid, status, waiting, kind), **extra))

    def sess_data(self, pid, status, waiting=None, kind="interactive"):
        return {"pid": pid, "kind": kind, "status": status, **({"waitingFor": waiting} if waiting else {})}

    def spec(self, screens, panes="%7 /dev/ttys005 4242\n", on_key=True, **kw):
        idle = [[str(self.sess / f"{self.PID}.json"), self.sess_data(self.PID, "idle")]]
        spec = {"list-panes": [panes, 0], "display-message": [SERVER + "\n", 0], "screens": screens,
                "on_key": {self.PANE: idle} if on_key else {}, **kw}
        self.spec_file.write_text(json.dumps(spec))

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def keys(self):
        return [c[3:] for c in self.calls() if c[0] == "send-keys"]

    def run_unstick(self, fresh=lambda line: True, stuck=None, **kw):
        return U.unstick(fresh, self.sx, self.slept.append, stuck, **kw)

    def outcomes(self, **kw):
        return [(d["kind"], d["action"]) for d in self.run_unstick(**kw)]


class MatchTest(Base):
    def test_menu_at_the_bottom_is_matched(self):
        lines = U.menu_lines(MENU)
        self.assertEqual(U.tidy(lines[0]), U.TITLE)
        self.assertIsNone(U.menu_lines(PERMISSION))
        self.assertIsNotNone(U.menu_lines(BOXED))
        typed = MENU.replace("  Enter to confirm", "❯ continue\n  Enter to confirm")  # a menu text in the transcript
        for screen in (PREFILLED, MENU.replace("2. Wait here", "2. Use extra usage"), MENU + "\nuser text\n",
                       MENU.replace("What do you want to do?", "What do you want to do now?"), MENU + "❯\n",
                       typed, MENU + "  ⏵⏵ auto mode on (shift+tab to cycle)\n"):
            with self.subTest(screen[-60:]):
                self.assertIsNone(U.menu_lines(screen))

    def test_a_long_block_is_not_the_menu(self):
        options = "".join(f"    {i}. Stop and wait for limit to reset\n" for i in range(5, 5 + U.MENU_MAX))
        self.assertIsNone(U.menu_lines(MENU.replace("  Enter to confirm", options + "  Enter to confirm")))

    def test_options_in_another_order_and_armed_wait_match(self):
        other = MENU.replace("1. Stop and wait for limit to reset", "1. Upgrade your plan") \
            .replace("4. Upgrade your plan", "4. Stop and wait for limit to reset")
        self.assertIsNotNone(U.menu_lines(other))
        armed = MENU.replace("Wait here, then continue automatically shortly", "Don’t continue automatically")
        self.assertIsNotNone(U.menu_lines(armed))

    def test_draft_of_the_input_line(self):
        self.assertEqual(U.draft(PREFILLED), "continue")
        self.assertEqual(U.draft(EMPTY), "")
        self.assertEqual(U.draft(DRAFT), "исправь тест")
        boxed = "╭──────────────────────────╮\n│ > continue               │\n╰──────────────────────────╯\n"
        self.assertEqual(U.draft(boxed), "continue")
        self.assertIsNone(U.draft(MENU))
        self.assertIsNone(U.draft("> continue\n"))  # no rule above: text in the transcript, not the input


class UnstickTest(Base):
    def test_prefilled_continue_gets_one_esc_and_enter(self):
        self.spec({self.PANE: [MENU, PREFILLED]})
        done = self.run_unstick()
        self.assertEqual(self.keys(), [["Escape"], ["Enter"]])
        self.assertEqual([(d["line"], d["role"], d["pane"], d["action"]) for d in done],
                         [(self.LINE, "backend", self.PANE, "esc, enter")])
        self.assertEqual(done[0]["sha256"], U.digest(U.menu_lines(MENU)))
        self.assertEqual(self.slept, [U.SETTLE])

    def test_empty_input_gets_the_constant_text(self):
        self.spec({self.PANE: [MENU, EMPTY, TYPED]})
        self.assertEqual(self.run_unstick()[0]["action"], "esc, text, enter")
        self.assertEqual(self.keys(), [["Escape"], ["-l", U.TEXT], ["Enter"]])

    def test_input_with_other_text_gets_only_esc(self):
        self.spec({self.PANE: [MENU, DRAFT]})
        self.assertEqual(self.run_unstick()[0]["action"], "esc; input not empty")
        self.assertEqual(self.keys(), [["Escape"]])

    def test_a_menu_text_above_a_permission_dialog_gets_nothing(self):  # N3 (a)
        self.session(self.PID, "waiting", "permission prompt")
        self.spec({self.PANE: [PERMISSION]})
        self.assertEqual(self.outcomes(), [(None, "no keys: status waiting (permission prompt)")])
        self.assertEqual(self.keys(), [])

    def test_menu_with_a_permission_status_gets_nothing(self):  # N3 (b)
        for status, waiting in (("waiting", "permission prompt"), ("waiting", None), ("busy", None), ("idle", None)):
            with self.subTest(status=status, waiting=waiting):
                self.session(self.PID, status, waiting)
                self.spec({self.PANE: [MENU, PREFILLED]})
                self.assertEqual(self.outcomes(), [(None, f"no keys: status {status}"
                                                          + (f" ({waiting})" if waiting else ""))])
                self.assertEqual(self.keys(), [])

    def test_menu_that_stays_gets_no_text(self):  # N3 (c)
        self.spec({self.PANE: [MENU, MENU]})
        self.assertEqual(self.run_unstick()[0]["action"], "esc; menu stayed")
        self.assertEqual(self.keys(), [["Escape"]])

    def test_another_dialog_after_esc_gets_no_text(self):
        self.spec({self.PANE: [MENU, PREFILLED]}, on_key=False)  # the session file still says «waiting»
        self.assertEqual(self.run_unstick()[0]["action"], "esc; another dialog")
        self.assertEqual(self.keys(), [["Escape"]])

    def test_failed_key_stops_the_pane(self):
        self.spec({self.PANE: [MENU, PREFILLED]}, send_rc=1)
        self.assertEqual(self.run_unstick()[0]["action"], "esc failed")
        self.assertEqual(self.keys(), [["Escape"]])

    def test_no_second_esc_in_the_same_reset(self):  # S4
        self.spec({self.PANE: [MENU, PREFILLED]})
        self.assertEqual(self.run_unstick(fresh=lambda line: line != self.LINE), [])
        self.assertEqual([c[0] for c in self.calls()], ["list-panes", "display-message"])  # no screen, no key

    def test_status_menu_but_another_screen_is_a_line_without_keys(self):  # Claude lens non-blocker 1 on #483
        for screen in (EMPTY, PERMISSION):
            with self.subTest(screen[-40:]):
                self.log.unlink(missing_ok=True)
                self.spec({self.PANE: [screen]})
                done = self.run_unstick()
                self.assertEqual([(d["action"], d["sha256"]) for d in done],
                                 [(U.NO_MATCH, U.digest(U.bottom(screen)[-U.MENU_MAX:]))])
                self.assertEqual(self.keys(), [])
        self.log.unlink()
        self.spec({self.PANE: [None]})
        self.assertEqual([(d["action"], d["sha256"]) for d in self.run_unstick()], [(U.NO_SCREEN, "")])
        self.assertEqual(self.keys(), [])

    def test_no_screen_is_read_when_the_status_is_not_the_menu(self):  # one capture only where the status says menu
        self.session(self.PID, "busy")
        self.spec({self.PANE: [MENU]})
        self.assertEqual(self.outcomes(stuck=lambda s: True), [(None, "no keys: status busy")])
        self.assertEqual([c[0] for c in self.calls()], ["list-panes", "display-message"])

    def test_a_failure_on_one_pane_keeps_the_others(self):  # backend N2 on #483
        self.record("r.cd34", "plan", "%8", "/dev/ttys006", "4300")
        self.spec({}, panes="%7 /dev/ttys005 4242\n%8 /dev/ttys006 4300\n")
        with mock.patch.object(U, "unstick_pane", side_effect=[U.row("menu", "esc, enter", "a" * 64, True), OSError("ps")]):
            done = self.run_unstick()
        self.assertEqual([(d["line"], d["action"], d["sha256"]) for d in done],
                         [(self.LINE, "esc, enter", "a" * 64), ("r.cd34", "error: OSError", "")])

    def test_only_role_panes_of_this_server(self):  # S5
        screens = {p: [MENU, PREFILLED] for p in ("%7", "%8", "%9", "%10")}
        panes = "%7 /dev/ttys005 4242\n%8 /dev/ttys006 4300\n%9 /dev/ttys007 4400\n%10 /dev/ttys008 4500\n"
        self.record("r.cd34", "plan", "%8", "/dev/ttys006", "9999")                  # other launch shell
        self.record("r.ef56", "coord", "%9", "/dev/ttys007", "4400", server="1:1")   # server restarted
        L.write_json(L.lfile("r.gh78", ".json"), {"line": "r.gh78", "terminal": "terminal", "tty": "/dev/ttys008"})
        self.spec(screens, panes=panes)                                               # %10 — the owner's window
        self.assertEqual([d["pane"] for d in self.run_unstick()], [self.PANE])
        self.assertEqual({c[c.index("-t") + 1] for c in self.calls() if "-t" in c}, {self.PANE})

    def test_one_interactive_session_per_pane(self):
        self.sx.p[701] = P(701, 4242, 701, "ttys005", "claude")
        self.session(701, "busy", kind="bg")
        self.spec({self.PANE: [MENU, PREFILLED]})
        self.assertEqual(len(self.run_unstick()), 1, "a child claude -p of the pane is not counted")
        self.session(701, "waiting", "dialog open")
        self.session(self.PID, "waiting", "dialog open")  # the first run's Esc made it idle
        self.log.unlink()
        self.assertEqual(self.outcomes(), [(None, "no keys: 2 claude sessions")],
                         "two interactive sessions on one tty: whose menu is it?")
        self.assertEqual(self.keys(), [])
        for pid in (701, self.PID):
            (self.sess / f"{pid}.json").unlink()
        self.assertEqual(self.outcomes(), [(None, "no keys: no claude session")])

    def test_the_pane_path_comes_with_the_pane(self):  # SE-187 B: the Nerve picks the product's journal by it
        self.session(self.PID, "busy")
        for panes, path in (("%7 /dev/ttys005 4242 /Users/a/My Dir/tAIBE\n", "/Users/a/My Dir/tAIBE"),
                            ("%7 /dev/ttys005 4242\n", "")):
            with self.subTest(path):
                self.spec({}, panes=panes)
                self.assertEqual(U.role_panes(), [(self.LINE, "backend", self.PANE, self.TTY, path)])
                self.assertEqual(self.run_unstick()[0]["path"], path)

    def test_menu_keys_do_not_ask_stuck(self):
        asked = []
        self.spec({self.PANE: [MENU, PREFILLED]})
        self.assertEqual(self.outcomes(stuck=asked.append), [("menu", "esc, enter")])
        self.assertEqual(asked, [])

    def test_copy_mode_before_esc_gets_no_keys(self):  # SE-187 condition 2: the owner scrolls the pane with the wheel
        for mode in ("1", None, "0!"):  # in a mode, no answer from tmux, a failed call that printed 0
            with self.subTest(mode=mode):
                self.log.unlink(missing_ok=True)
                self.spec({self.PANE: [MENU, PREFILLED]}, in_mode={self.PANE: [mode]})
                done = self.run_unstick()
                self.assertEqual([(d["action"], d["sha256"]) for d in done],
                                 [(U.IN_MODE, U.digest(U.menu_lines(MENU)))])
                self.assertEqual(self.keys(), [])
                self.assertEqual(self.slept, [])

    def test_copy_mode_after_esc_gets_no_more_keys(self):  # the #483 path: Esc, then Enter or the text
        cases = (([MENU, PREFILLED], ["0", "1"], "esc; in-mode, no enter", [["Escape"]]),
                 ([MENU, EMPTY, TYPED], ["0", "1"], "esc; in-mode, no text", [["Escape"]]),
                 ([MENU, EMPTY, TYPED], ["0", "0", "1"], "esc, text; in-mode, no enter", [["Escape"], ["-l", U.TEXT]]))
        for screens, modes, action, sent in cases:
            with self.subTest(action):
                self.log.unlink(missing_ok=True)
                self.session(self.PID, "waiting", "dialog open")
                self.spec({self.PANE: screens}, in_mode={self.PANE: modes})
                self.assertEqual(self.run_unstick()[0]["action"], action)
                self.assertEqual(self.keys(), sent)

    def test_the_mode_is_read_before_each_key(self):
        self.spec({self.PANE: [MENU, EMPTY, TYPED]})
        self.run_unstick()
        seq = [c[0] if c[0] == "send-keys" else "mode" for c in self.calls()
               if c[0] == "send-keys" or c[-1] == "#{pane_in_mode}"]
        self.assertEqual(seq, ["mode", "send-keys"] * 3)

    def test_no_cli(self):  # S6: a role cannot reach the keys through python3 eval/tools/limit_unstick.py
        src = (HERE / "limit_unstick.py").read_text(encoding="utf-8")
        self.assertNotIn("__main__", src)
        self.assertNotIn("argparse", src)
        self.spec({self.PANE: [MENU, PREFILLED]})
        r = subprocess.run([sys.executable, str(HERE / "limit_unstick.py"), "unstick", "%7", "rm -rf /"],
                           capture_output=True, text=True, env=dict(os.environ), timeout=30)
        self.assertEqual((r.returncode, self.calls()), (0, []))


class IdleTest(Base):
    """SE-187 D: a session idle after a limit error (the owner's Esc closed the menu, the input is empty) gets TEXT and
    Enter, no Esc. «Stands because of the limit» comes from the Nerve (stuck); here — status, screen and keys."""

    def setUp(self):
        super().setUp()
        self.session(self.PID, "idle", sessionId="s1")
        self.asked = []

    def stuck(self, answer=""):  # '' — stands because of this limit; None — not; 'no-transcript' — cannot tell
        return lambda sess: self.asked.append(sess.get("sessionId")) or answer

    def test_an_idle_session_after_the_limit_gets_the_text(self):
        self.spec({self.PANE: [EMPTY, TYPED]})
        self.assertEqual(self.outcomes(stuck=self.stuck()), [("idle", U.IDLE + "text, enter")])
        self.assertEqual(self.keys(), [["-l", U.TEXT], ["Enter"]])
        self.assertEqual((self.asked, self.slept), (["s1"], [U.SETTLE / 3]))

    def test_no_keys_without_the_limit_or_for_another_session(self):
        cases = {"not stuck": ({}, None), "no stuck at all": ({}, "absent"), "sdk session": ({"entrypoint": "sdk-cli"},
                 ""), "busy": ({"status": "busy"}, ""), "a dialog": ({"status": "waiting", "waitingFor":
                 "permission prompt"}, "")}
        for why, (extra, answer) in cases.items():
            with self.subTest(why):
                self.log.unlink(missing_ok=True)
                self.session(self.PID, **dict({"status": "idle"}, **extra), sessionId="s1")
                self.spec({self.PANE: [EMPTY, TYPED]})
                got = self.outcomes(stuck=None if answer == "absent" else self.stuck(answer))
                self.assertEqual(got[0][0], None)
                self.assertEqual(self.keys(), [])
        self.assertEqual(self.asked, ["s1"], "stuck is asked only for one idle cli session")

    def test_a_screen_that_does_not_fit_gets_a_line_without_keys(self):
        for screen, why in ((DRAFT, "no keys, input not empty"), (MENU, "no keys, menu on screen"),
                            ("Роль ждёт задачу.\n", "no keys, no input line"), (None, "no keys, no screen")):
            with self.subTest(why):
                self.log.unlink(missing_ok=True)
                self.spec({self.PANE: [screen]})
                self.assertEqual(self.outcomes(stuck=self.stuck()), [("idle", U.IDLE + why)])
                self.assertEqual(self.keys(), [])

    def test_woke_after_the_enter(self):  # the wake queue pauses after this role
        self.spec({self.PANE: [EMPTY, TYPED]})
        self.assertEqual([(d["kind"], d["woke"]) for d in self.run_unstick(stuck=self.stuck())], [("idle", True)])

    def test_a_failed_key_stops(self):
        self.spec({self.PANE: [EMPTY, TYPED]}, send_rc=1)
        self.assertEqual(self.outcomes(stuck=self.stuck()), [("idle", U.IDLE + "text failed")])
        self.assertEqual(self.keys(), [["-l", U.TEXT]])

    def test_no_transcript_gets_no_keys(self):  # condition 4: no full assistant record, or no path pid → transcript
        self.spec({self.PANE: [EMPTY, TYPED]})
        self.assertEqual(self.outcomes(stuck=self.stuck("no-transcript")),
                         [(None, "no keys: status idle, no-transcript")])
        self.assertEqual(self.keys(), [])

    def test_a_role_without_an_open_task_gets_no_text(self):  # D7: the next tap event wakes it
        self.spec({self.PANE: [EMPTY, TYPED]})
        got = self.run_unstick(stuck=self.stuck(), wake=False)
        self.assertEqual([(d["kind"], d["action"], d["woke"]) for d in got],
                         [(None, "no keys: status idle, no open task", False)])
        self.assertEqual(self.keys(), [])

    def test_the_owner_types_between_the_snapshot_and_enter(self):  # condition 1: Enter only on exactly TEXT
        self.spec({self.PANE: [EMPTY, MIXED]}, by_capture=True)
        got = self.run_unstick(stuck=self.stuck())
        self.assertEqual([(d["action"], d["woke"]) for d in got], [(U.IDLE + "text; typed, no enter", False)])
        self.assertEqual(self.keys(), [["-l", U.TEXT]])
        self.assertEqual([d["woke"] for d in self.run_unstick(stuck=self.stuck())], [False], "the line is not empty")


class QueueStepTest(Base):
    """SE-187 condition 1 on the menu path, D7 on the menu path, and one line per call for the wake queue."""

    def test_enter_on_continue_only_if_the_input_is_still_continue(self):
        self.spec({self.PANE: [MENU, PREFILLED, PREFILLED.replace("continue", "continuex")]}, by_capture=True)
        self.assertEqual([(d["action"], d["woke"]) for d in self.run_unstick()], [("esc; typed, no enter", False)])
        self.assertEqual(self.keys(), [["Escape"]])

    def test_enter_after_the_text_only_if_the_input_is_the_text(self):
        self.spec({self.PANE: [MENU, EMPTY, MIXED]})
        self.assertEqual(self.run_unstick()[0]["action"], "esc, text; typed, no enter")
        self.assertEqual(self.keys(), [["Escape"], ["-l", U.TEXT]])

    def test_no_screen_before_enter_gets_no_enter(self):  # condition 1: Enter only after a snapshot shows the line
        for screens, action, sent in (([MENU, PREFILLED, None], "esc; no screen, no enter", [["Escape"]]),
                                      ([MENU, EMPTY, None], "esc, text; no screen, no enter",
                                       [["Escape"], ["-l", U.TEXT]])):
            with self.subTest(action):
                self.log.unlink(missing_ok=True)
                self.session(self.PID, "waiting", "dialog open")
                self.spec({self.PANE: screens}, by_capture=True)
                self.assertEqual([(d["action"], d["woke"]) for d in self.run_unstick()], [(action, False)])
                self.assertEqual(self.keys(), sent)

    def test_woke_only_after_an_enter(self):
        for screens, woke in (([MENU, PREFILLED], True), ([MENU, EMPTY, TYPED], True), ([MENU, DRAFT], False)):
            with self.subTest(screens[-1][-40:]):
                self.log.unlink(missing_ok=True)
                self.session(self.PID, "waiting", "dialog open")
                self.spec({self.PANE: screens})
                self.assertEqual(self.run_unstick()[0]["woke"], woke)

    def test_a_role_without_an_open_task_gets_only_esc(self):  # D7: Esc closes the menu, the next tap event wakes it
        self.spec({self.PANE: [MENU, PREFILLED]})
        got = self.run_unstick(wake=False)
        self.assertEqual([(d["kind"], d["action"], d["woke"]) for d in got], [("menu", "esc; no open task", False)])
        self.assertEqual(self.keys(), [["Escape"]])

    def test_only_the_asked_line(self):
        self.record("r.cd34", "plan", "%8", "/dev/ttys006", "4300")
        self.sx.p[4300] = P(4300, 1, 4300, "ttys006", "-zsh")
        self.sx.p[800] = P(800, 4300, 800, "ttys006", "claude")
        self.session(800, "waiting", "dialog open")
        self.spec({"%7": [MENU, PREFILLED], "%8": [MENU, PREFILLED]}, panes="%7 /dev/ttys005 4242\n%8 /dev/ttys006 4300\n")
        self.assertEqual([(d["line"], d["kind"]) for d in self.run_unstick(only={"r.cd34"})], [("r.cd34", "menu")])
        self.assertEqual({c[c.index("-t") + 1] for c in self.calls() if "-t" in c}, {"%8"})

    def test_owner_pause_files(self):  # the same files as the role watchdog (team_plan.py pause / «pause» in the queue)
        conf = Path(self.tmp.name) / "conf"
        conf.mkdir()
        with mock.patch.dict(os.environ, {"TAIBE_TMUX_CONF_DIR": str(conf)}):
            self.assertFalse(U.owner_paused())
            for name in ("team-pause", "team-pause-queue"):
                with self.subTest(name):
                    (conf / name).write_text("x")
                    self.assertTrue(U.owner_paused())
                    (conf / name).unlink()


if __name__ == "__main__":
    unittest.main()
