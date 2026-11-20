"""SE-174 and SE-187 in the Nerve: a lift (the reset, or an early lift before it) builds a wake queue (eval/nerve/wake.py).
coord goes first, then one role at a time in team_status.ORDER; after a role that got Enter the queue waits
budget.unstick_pause_s. A role without a task (TASK_KINDS) since budget.wake_task_lookback_s (4 h) before the limit
gets no Enter (D7); its line waits
in later, and the first task to the role puts it back into the queue. The owner's pause, the
5-hour window at budget.warn_at or a new limit hold the queue. Each line writes one `limit.unstick` with keys into the
journal of the pane's product, each product gets one summary (also an empty one), and a failure does not raise.
D2 (the session stands because of this limit) is read here, in the Nerve code. limit_unstick itself is a mock here:
its own tests are eval/tools/test_limit_unstick.py.

Run: python3 -I -m unittest discover -s eval/nerve -p 'test_unstick.py'
"""
import contextlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import actions  # noqa: E402
import budget  # noqa: E402
import limit_unstick  # noqa: E402 — eval/tools on sys.path through budget
import sources  # noqa: E402
import wake  # noqa: E402
from journal import read_from  # noqa: E402
from test_nerve import CFG, MSK, FakeCtx  # noqa: E402

RESET = "2026-10-28T14:40+03:00"
HIT = "2026-10-28T10:52+03:00"
LABEL = "сброс 28.10 14:40"
HOME = CFG["repo_root"]
NOW = datetime(2026, 10, 28, 14, 41, tzinfo=MSK)
PANES = [("r.ab12", "backend", "%7", "ttys001", HOME),
         ("r.cd34", "plan", "%8", "ttys002", HOME + "/worktrees/fix/x"),
         ("r.ef56", "release", "%9", "ttys003", HOME),
         ("r.co00", "coord", "%6", "ttys004", HOME)]
OUT = {"r.ab12": ("menu", "esc, enter", "a" * 64, True),
       "r.cd34": ("menu", "esc; menu stayed", "b" * 64, False),
       "r.ef56": (None, "no keys: status busy", "", False),
       "r.co00": ("menu", "esc, enter", "c" * 64, True)}
SID = "0123abcd-0000-4000-8000-00000000abcd"
LIMIT = "You've hit your session limit · resets 2:40pm (Europe/Moscow)"


class Ctx(FakeCtx):
    def __init__(self, d, deliver=True, unstick=True, root=None, slug="hr-helper", pause=180):
        super().__init__(d)
        self.cfg = dict(CFG, budget=dict(CFG["budget"], unstick=unstick, unstick_pause_s=pause), slug=slug,
                        repo_root=root or HOME)
        self.deliver = deliver
        self.mode = None

    def write_mode(self, mode):
        self.mode = mode


def recs(d, kind="limit.unstick"):
    return [r for r in read_from(os.path.join(d, "j.jsonl"), 0)[0] if kind is None or r["kind"] == kind]


def task(ctx, to, at=None, kind="assign"):
    """An assign or reply to the roles. at — a past time: the record goes straight to the file (the journal stamps now)."""
    if at is None:
        ctx.journal.emit(f"t:{kind}:{','.join(to)}:{len(recs(ctx.projects_root, None))}", kind, "nervous", to, "x",
                         "test")
        return
    with open(ctx.journal.path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"seq": 0, "ts": at, "key": f"old:{','.join(to)}", "kind": kind, "class": "nervous",
                            "to": to, "text": "x", "src": "test"}) + "\n")


class QueueBase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.d = tmp.name
        self.calls = []

    def fake(self, panes=PANES, out=OUT, paused=False, fail=None):
        def unstick(fresh, stuck=None, only=None, wake=True):
            self.calls.append((sorted(only), wake))
            if fail:
                raise fail
            got = []
            for line, role, pane, _tty, path in panes:
                if line in only and fresh(line):
                    kind, action, sha, woke = out[line]
                    if woke and not wake:  # as limit_unstick: Esc only, or no keys on the idle path
                        kind, action, woke = (kind, "esc; no open task", False) if kind == "menu" else (
                            None, "no keys: status idle, no open task", False)
                    got.append({"line": line, "role": role, "pane": pane, "path": path, "kind": kind,
                                "action": action, "sha256": sha, "woke": woke})
            return got
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(limit_unstick, "role_panes", return_value=list(panes)))
        stack.enter_context(mock.patch.object(limit_unstick, "unstick", side_effect=unstick))
        stack.enter_context(mock.patch.object(limit_unstick, "owner_paused", return_value=paused))
        return stack

    def asked(self):
        return [only[0] for only, _ in self.calls]


class QueueTest(QueueBase):
    def test_coord_first_then_the_order_and_a_pause_after_each_enter(self):  # owner 19.11 17:15, condition 3
        ctx, st = Ctx(self.d), {}
        task(ctx, ["backend", "plan", "release"])
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            self.assertEqual([x[0] for x in st["wake"]["lines"]], ["r.co00", "r.ef56", "r.ab12", "r.cd34"])
            wake.step(ctx, st, NOW, False)
            self.assertEqual(self.asked(), ["r.co00"])
            self.assertEqual(st["wake"]["next"], "2026-10-28T14:44:00+03:00")
            wake.step(ctx, st, NOW + timedelta(seconds=179), False)  # the pause holds
            self.assertEqual(self.asked(), ["r.co00"])
            wake.step(ctx, st, NOW + timedelta(seconds=180), False)  # release: no keys, no pause; backend: Enter
            self.assertEqual(self.asked(), ["r.co00", "r.ef56", "r.ab12"])
            wake.step(ctx, st, NOW + timedelta(seconds=360), False)
        self.assertEqual(self.asked(), ["r.co00", "r.ef56", "r.ab12", "r.cd34"])
        self.assertIsNone(st["wake"])
        got = recs(self.d)
        self.assertEqual([(r["key"], r["class"], r["to"]) for r in got],
                         [(f"limit:unstick:{RESET}:r.co00", "digest", ["coord"]),
                          (f"limit:unstick:{RESET}:r.ab12", "digest", ["coord"]),
                          (f"limit:unstick:{RESET}:r.cd34", "digest", ["coord"]),
                          (f"limit:unstick:{RESET}:summary", "digest", ["coord"])])
        self.assertEqual(got[1]["sha256"], "a" * 64)
        self.assertEqual(got[1]["text"], f"backend (r.ab12, панель %7), {LABEL}: меню лимита — esc, enter; sha256 "
                                         + "a" * 16)
        self.assertEqual(got[3]["text"], f"{LABEL}: панели ролей 4 — coord r.co00: esc, enter; release r.ef56: no "
                                         "keys: status busy; backend r.ab12: esc, enter; plan r.cd34: esc; menu stayed")

    def test_the_pause_comes_from_the_config(self):
        ctx, st = Ctx(self.d, pause=60), {}
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
        self.assertEqual(st["wake"]["next"], "2026-10-28T14:42:00+03:00")

    def test_a_role_without_an_open_task_gets_no_enter(self):  # D7
        ctx, st = Ctx(self.d), {}
        task(ctx, ["backend"])
        task(ctx, ["plan"], at="2026-10-28T03:40:00+00:00")  # 06:40 MSK, before hit − 4 h
        task(ctx, ["release"], kind="lease")  # not a task
        with self.fake(out={k: (v[0], v[1], v[2], False) for k, v in OUT.items()}):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
        self.assertEqual(self.calls, [(["r.co00"], True), (["r.ef56"], False), (["r.ab12"], True),
                                      (["r.cd34"], False)])

    def test_a_reply_to_all_and_a_task_within_five_minutes_before_the_hit_open_the_role(self):
        ctx, st = Ctx(self.d), {}
        task(ctx, ["all"], kind="reply")
        task(ctx, ["plan"], at="2026-10-28T07:48:00+00:00")  # 10:48 MSK, hit 10:52
        with self.fake(out={k: (v[0], v[1], v[2], False) for k, v in OUT.items()}):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
        self.assertEqual([w for _, w in self.calls], [True, True, True, True])

    def test_a_task_within_the_lookback_before_the_limit_opens_the_role(self):  # Контроль 08:38 on #496, B1
        # A role mid-task on an assign that came before the limit gets Enter after the reset, with no new event.
        for look, at, woke in ((None, "2026-10-28T03:53:00+00:00", True),  # 06:53 MSK: 3 h 59 min before the hit
                               (None, "2026-10-28T03:51:00+00:00", False),  # 06:51 MSK: 4 h 1 min before
                               (600, "2026-10-28T07:40:00+00:00", False),  # 10:40 MSK, the lookback is 10 min
                               (0, "2026-10-28T07:48:00+00:00", True)):  # 10:48 MSK: never less than MARGIN
            with self.subTest(look=look, at=at), tempfile.TemporaryDirectory() as d:
                self.calls = []
                ctx, st = Ctx(d), {}
                if look is not None:
                    ctx.cfg["budget"]["wake_task_lookback_s"] = look
                task(ctx, ["plan"], at=at)
                with self.fake(out={k: (v[0], v[1], v[2], False) for k, v in OUT.items()}):
                    wake.start(ctx, st, RESET, HIT, RESET, LABEL)
                    wake.step(ctx, st, NOW, False)
                self.assertEqual(self.calls[-1], (["r.cd34"], woke))

    def test_a_task_that_comes_during_the_queue_counts(self):  # the journal is read on, not once
        ctx, st = Ctx(self.d), {}
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
            task(ctx, ["release"])
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)
        self.assertEqual(self.calls[:3], [(["r.co00"], True), (["r.ef56"], True), (["r.ab12"], False)])

    def test_a_review_a_lens_or_a_task_opens_the_role(self):  # coord 01:52 on #496, acceptance 1
        for kind in ("review", "lens", "task"):
            with self.subTest(kind), tempfile.TemporaryDirectory() as d:
                self.calls = []
                ctx, st = Ctx(d), {}
                task(ctx, ["backend"], kind=kind)
                with self.fake():
                    wake.start(ctx, st, RESET, HIT, RESET, LABEL)
                    wake.step(ctx, st, NOW, False)
                    wake.step(ctx, st, NOW + timedelta(minutes=3), False)
                self.assertEqual(self.calls[:3], [(["r.co00"], True), (["r.ef56"], False), (["r.ab12"], True)])
                self.assertIn(f"limit:unstick:{RESET}:r.ab12", [r["key"] for r in recs(d)])

    def test_an_esc_only_role_gets_enter_after_a_task_comes(self):  # coord 01:52 on #496, acceptance 2
        ctx, st = Ctx(self.d), {}
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)  # coord: Enter
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)  # release, backend, plan: no task
            self.assertEqual(st["wake"]["lines"], [])
            self.assertEqual(st["wake"]["later"], [["r.ab12", "backend", "hr-helper"]])
            self.assertIn(f"limit:unstick:{RESET}:summary", [r["key"] for r in recs(self.d)])
            task(ctx, ["plan"], kind="review")  # not backend's
            wake.step(ctx, st, NOW + timedelta(minutes=6), False)
            self.assertEqual(len(self.calls), 4)
            task(ctx, ["backend"], kind="review")
            wake.step(ctx, st, NOW + timedelta(minutes=7), False)
            self.assertEqual(self.calls[4:], [(["r.ab12"], True)])
            self.assertEqual(st["wake"]["next"], "2026-10-28T14:51:00+03:00")  # the same pause after the Enter
            wake.step(ctx, st, NOW + timedelta(minutes=10), False)
        self.assertIsNone(st["wake"])
        self.assertEqual(len(self.calls), 5)
        got = [r for r in recs(self.d) if r["key"].endswith("r.ab12")]
        self.assertEqual([r["key"] for r in got], [f"limit:unstick:{RESET}:r.ab12", f"limit:unstick:{RESET}:task:r.ab12"])
        self.assertEqual(got[0]["text"], f"backend (r.ab12, панель %7), {LABEL}: меню лимита — esc; no open task; "
                                         "sha256 " + "a" * 16)
        self.assertEqual(got[1]["text"], f"backend (r.ab12, панель %7), {LABEL} (задание после подъёма): меню лимита — "
                                         "esc, enter; sha256 " + "a" * 16)
        self.assertEqual(len([r for r in recs(self.d) if r["key"].endswith("summary")]), 1)

    def test_a_task_during_the_pause_waits_for_the_pause(self):
        ctx, st = Ctx(self.d), {}
        task(ctx, ["release"])
        with self.fake(out=dict(OUT, **{"r.ef56": ("idle", "idle text, enter", "", True)})):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)  # coord
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)  # release: Enter, pause to 14:47
            self.assertEqual(self.asked(), ["r.co00", "r.ef56"])
            wake.step(ctx, st, NOW + timedelta(minutes=6), False)  # backend and plan: no task
            task(ctx, ["all"], kind="assign")
            wake.step(ctx, st, NOW + timedelta(minutes=7), False)  # a task to all: backend, Enter
            self.assertEqual(self.asked(), ["r.co00", "r.ef56", "r.ab12", "r.cd34", "r.ab12"])
            self.assertEqual(st["wake"]["later"], [])  # plan got "menu stayed": nothing to wake later
            wake.step(ctx, st, NOW + timedelta(minutes=9), False)  # the pause holds
            self.assertIsNotNone(st["wake"])
            wake.step(ctx, st, NOW + timedelta(minutes=10), False)
        self.assertIsNone(st["wake"])

    def test_a_later_line_without_its_pane_or_after_a_new_lift_is_dropped(self):
        ctx, st = Ctx(self.d), {}
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)  # the same lift again keeps the later line
            self.assertEqual(st["wake"]["later"], [["r.ab12", "backend", "hr-helper"]])
            self.assertEqual(st["wake"]["lines"], [])
        with self.fake(panes=[p for p in PANES if p[0] != "r.ab12"]):
            task(ctx, ["backend"])
            wake.step(ctx, st, NOW + timedelta(minutes=6), False)  # the session is gone: no line, no keys
        self.assertIsNone(st["wake"])
        self.assertFalse([r for r in recs(self.d) if ":task:" in r["key"]])

    def test_a_new_lift_drops_the_later_lines_and_writes_no_second_summary(self):
        ctx, st = Ctx(self.d), {}
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)
            self.assertTrue(st["wake"]["later"])
            wake.start(ctx, st, "early:x", HIT, RESET, "ранний подъём")
            self.assertEqual(st["wake"]["later"], [])
        self.assertEqual([r["key"] for r in recs(self.d) if r["key"].endswith("summary")],
                         [f"limit:unstick:{RESET}:summary"])

    def test_a_failure_drops_the_later_lines_too(self):  # tmux is gone: the roles wait for the owner
        ctx, st = Ctx(self.d), {}
        with self.fake(out=dict(OUT, **{"r.cd34": ("menu", "esc, enter", "b" * 64, True)})):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)
        self.assertEqual([x[0] for x in st["wake"]["later"]], ["r.ab12", "r.cd34"])
        task(ctx, ["backend"])  # backend goes back into the queue, plan still waits
        with self.fake(fail=OSError("tmux")):
            wake.step(ctx, st, NOW + timedelta(minutes=6), False)
        self.assertIsNone(st["wake"])
        self.assertEqual([r["key"] for r in recs(self.d, "nerve.error")], [f"limit:unstick:{RESET}:error"])

    def test_two_rows_of_one_line_both_get_a_summary_row(self):  # backend nit on #496: any() stopped at the first True
        panes = [("r.ab12", "backend", "%7", "ttys001", HOME), ("r.ab12", "backend", "%17", "ttys011", HOME)]
        ctx, st = Ctx(self.d), {}
        task(ctx, ["backend"])
        with self.fake(panes=panes):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)
        self.assertEqual([r["text"] for r in recs(self.d) if r["key"].endswith("summary")],
                         [f"{LABEL}: панели ролей 2 — backend r.ab12: esc, enter; backend r.ab12: esc, enter"])

    def test_the_owners_pause_the_warn_and_a_new_limit_hold_the_queue(self):
        for why in ("paused", "warn", "limit"):
            with self.subTest(why), tempfile.TemporaryDirectory() as d:
                self.calls = []
                ctx, st = Ctx(d), {}
                with self.fake(paused=why == "paused"):
                    wake.start(ctx, st, RESET, HIT, RESET, LABEL)
                    if why == "limit":
                        st["limit"] = {"kind": "session", "hit": "2026-10-28T14:41+03:00", "reset": "x", "resume": "x"}
                    wake.step(ctx, st, NOW, why == "warn")
                self.assertEqual(self.calls, [])
                self.assertEqual(len(st["wake"]["lines"]), 4)
                self.assertEqual(recs(d), [])

    def test_a_rebuilt_queue_skips_the_lines_it_did(self):  # condition 3: no second text after a crash
        ctx, st = Ctx(self.d), {}
        task(ctx, ["backend"])
        with self.fake():
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)  # coord got Enter
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)  # the same lift again (the reset and A in one pass)
            self.assertEqual([x[0] for x in st["wake"]["lines"]], ["r.ef56", "r.ab12", "r.cd34"])
            self.assertEqual(st["wake"]["next"], "2026-10-28T14:44:00+03:00")
            wake.step(ctx, st, NOW + timedelta(minutes=3), False)  # release: no keys, no key line; backend: Enter
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            self.assertEqual([x[0] for x in st["wake"]["lines"]], ["r.cd34"])
            st["wake"] = None  # the state is lost: only the journal keys are left
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            self.assertEqual([x[0] for x in st["wake"]["lines"]], ["r.ef56", "r.cd34"])
        self.assertEqual(self.asked(), ["r.co00", "r.ef56", "r.ab12"])
        self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(self.d)], ["r.co00", "r.ab12"])

    def test_a_line_keyed_after_the_start_is_not_asked(self):  # no ps and tmux for a line another pass did
        ctx, st = Ctx(self.d), {}
        with self.fake(out={k: (v[0], v[1], v[2], False) for k, v in OUT.items()}):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            ctx.emit(f"limit:unstick:{RESET}:r.ab12", "limit.unstick", "digest", ["coord"], "x", "budget")
            wake.step(ctx, st, NOW, False)
        self.assertEqual(self.asked(), ["r.co00", "r.ef56", "r.cd34"])

    def test_a_new_lift_writes_the_old_summary_first(self):
        ctx, st = Ctx(self.d), {}
        with self.fake():
            wake.start(ctx, st, f"early:{HIT}", HIT, RESET, "ранний подъём")
            wake.step(ctx, st, NOW, False)
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
        self.assertEqual([(r["key"], r["text"]) for r in recs(self.d)],
                         [(f"limit:unstick:early:{HIT}:r.co00", "coord (r.co00, панель %6), ранний подъём: меню "
                           "лимита — esc, enter; sha256 " + "c" * 16),
                          (f"limit:unstick:early:{HIT}:summary", "ранний подъём: панели ролей 1 — coord r.co00: esc, "
                           "enter")])
        self.assertEqual(st["wake"]["tag"], RESET)
        self.assertEqual(len(st["wake"]["lines"]), 4)

    def test_lines_and_summaries_go_to_the_product_of_the_pane(self):  # SE-187 B, C
        with tempfile.TemporaryDirectory() as pd:
            ctx, peer = Ctx(self.d), Ctx(pd, root="/x/tAIBE", slug="taibe")
            ctx.peers = {"taibe": peer}
            panes = [PANES[0][:4] + ("/x/tAIBE/worktrees/fix/y",), PANES[1][:4] + ("/x/tAIBE-old",),
                     PANES[2][:4] + ("",)]
            task(peer, ["backend"])
            with self.fake(panes):
                wake.start(ctx, st := {}, RESET, HIT, RESET, LABEL)
                wake.step(ctx, st, NOW, False)
                wake.step(ctx, st, NOW + timedelta(minutes=3), False)
            self.assertEqual(self.calls, [(["r.ef56"], False), (["r.ab12"], True), (["r.cd34"], False)])
            self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(pd)], ["r.ab12", "summary"])
            self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(self.d)], ["r.cd34", "summary"])
            self.assertEqual(recs(pd)[1]["text"], f"{LABEL}: панели ролей 1 — backend r.ab12: esc, enter")
            with self.fake(panes):  # a key in any product's journal: the line is not in the next queue
                wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            self.assertEqual([x[0] for x in st["wake"]["lines"]], ["r.ef56"])

    def test_a_product_without_panes_gets_an_empty_summary(self):  # coord 15:03: the empty case is a line
        with tempfile.TemporaryDirectory() as pd:
            ctx, peer = Ctx(self.d), Ctx(pd, root="/x/tAIBE", slug="taibe")
            ctx.peers = {"taibe": peer}
            with self.fake([]):
                wake.start(ctx, st := {}, f"early:{HIT}", HIT, RESET, "ранний подъём")
                wake.step(ctx, st, NOW, False)
            for d in (self.d, pd):
                self.assertEqual([(r["key"], r["text"]) for r in recs(d)],
                                 [(f"limit:unstick:early:{HIT}:summary", "ранний подъём: панели ролей 0")])
            self.assertIsNone(st["wake"])

    def test_an_idle_wake_names_the_role_and_the_lift(self):  # coord 15:10, product note 1
        out = dict(OUT, **{"r.co00": ("idle", "idle after limit: text, enter", "", True)})
        with self.fake([PANES[3]], out):
            wake.start(ctx := Ctx(self.d), st := {}, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
        self.assertEqual(recs(self.d)[0]["text"], f"coord (r.co00, панель %6), {LABEL}: ввод после лимита — idle "
                                                  "after limit: text, enter")

    def test_a_line_without_a_role_or_a_hash(self):
        out = dict(OUT, **{"r.co00": ("menu", "no keys: status menu, no screen", "", False)})
        with self.fake([("r.co00", "", "%6", "ttys004", HOME)], out):
            wake.start(ctx := Ctx(self.d), st := {}, RESET, HIT, RESET, LABEL)
            wake.step(ctx, st, NOW, False)
        self.assertEqual(recs(self.d)[0]["text"], f"роль (r.co00, панель %6), {LABEL}: меню лимита — no keys: status "
                                                  "menu, no screen")

    def test_a_failing_peer_journal_keeps_the_others(self):
        with tempfile.TemporaryDirectory() as pd:
            ctx, peer = Ctx(self.d), Ctx(pd, root="/x/tAIBE", slug="taibe")
            ctx.peers = {"taibe": peer}
            panes = [PANES[0][:4] + ("/x/tAIBE",)] + PANES[1:3]
            with self.fake(panes, out={k: (v[0], v[1], v[2], False) for k, v in OUT.items()}), \
                    mock.patch.object(peer, "emit", side_effect=OSError("disk")):
                wake.start(ctx, st := {}, RESET, HIT, RESET, LABEL)
                wake.step(ctx, st, NOW, False)
            self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(self.d)], ["r.cd34", "summary"])

    def test_off_without_delivery_or_the_switch(self):
        no_key = Ctx(self.d)
        no_key.cfg = dict(no_key.cfg, budget={k: v for k, v in CFG["budget"].items() if k != "unstick"})
        for ctx in (Ctx(self.d, deliver=False), Ctx(self.d, unstick=False), no_key):
            with self.subTest(deliver=ctx.deliver, unstick=ctx.cfg["budget"].get("unstick")), self.fake():
                st = {}
                wake.start(ctx, st, RESET, HIT, RESET, LABEL)
                wake.step(ctx, st, NOW, False)
                self.assertEqual(st, {})
        self.assertEqual((self.calls, recs(self.d, None)), ([], []))

    def test_a_failure_is_one_error_line_and_no_raise(self):
        ctx, st = Ctx(self.d), {}
        with mock.patch.object(limit_unstick, "role_panes", side_effect=OSError("tmux: no server")):
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
            wake.start(ctx, st, RESET, HIT, RESET, LABEL)
        self.assertEqual(st, {})
        self.assertEqual([(r["kind"], r["to"]) for r in recs(self.d, None)], [("nerve.error", ["release"])])
        with self.fake(fail=OSError("ps: denied")):
            wake.start(ctx, st, f"early:{HIT}", HIT, RESET, "ранний подъём")
            wake.step(ctx, st, NOW, False)
        self.assertIsNone(st["wake"])
        self.assertEqual([(r["kind"], r["key"].rsplit(":", 1)[1]) for r in recs(self.d, None)][1:],
                         [("nerve.error", "error"), ("limit.unstick", "summary")])

    def test_the_switch_and_the_pause_are_in_the_rendered_config(self):
        self.assertIs(CFG["budget"].get("unstick"), True)
        self.assertEqual(CFG["budget"].get("unstick_pause_s"), 180)
        self.assertEqual(CFG["budget"].get("wake_task_lookback_s"), 14400)


class StuckTest(unittest.TestCase):
    """SE-187 D2, condition 4: the last full assistant entry of the transcript is the limit error of this lift."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ctx = Ctx(tmp.name)
        os.makedirs(os.path.join(tmp.name, "-x-tAIBE"))
        self.path = os.path.join(tmp.name, "-x-tAIBE", SID + ".jsonl")
        self.stuck = wake.stuck_after(self.ctx, HIT, RESET)

    def write(self, *entries, head=b""):
        with open(self.path, "wb") as f:
            f.write(head + b"".join(json.dumps(e).encode() + b"\n" for e in entries))

    @staticmethod
    def assistant(at, text="ok", error=False):
        return {"type": "assistant", "timestamp": at, "isApiErrorMessage": error,
                "message": {"content": [{"type": "text", "text": text}]}}

    def test_the_limit_error_of_this_lift_is_stuck(self):
        err = self.assistant("2026-10-28T08:20:00Z", LIMIT, True)  # 11:20 MSK
        tail = [{"type": "user", "timestamp": "2026-10-28T08:21:00Z", "message": {"content": "/rate-limit-options"}},
                {"type": "system", "timestamp": "2026-10-28T08:21:01Z"}]
        self.write(self.assistant("2026-10-28T07:00:00Z"), err, *tail)
        self.assertEqual(self.stuck({"sessionId": SID}), "")

    def test_not_stuck_for_this_lift(self):
        cases = {"a normal answer after the error": [self.assistant("2026-10-28T08:20:00Z", LIMIT, True),
                                                     self.assistant("2026-10-28T08:30:00Z")],
                 "the error before hit - 5 min": [self.assistant("2026-10-28T07:46:00Z", LIMIT, True)],
                 "another API error": [self.assistant("2026-10-28T08:20:00Z", "API Error: 529 overloaded", True)],
                 "the error of another reset": [self.assistant("2026-10-28T08:20:00Z", LIMIT.replace("2:40pm", "7pm"),
                                                               True)]}
        for why, entries in cases.items():
            with self.subTest(why):
                self.write(*entries)
                self.assertIsNone(self.stuck({"sessionId": SID}))

    def test_no_transcript(self):
        self.write({"type": "user", "timestamp": "2026-10-28T08:20:00Z"})
        self.assertEqual(self.stuck({"sessionId": SID}), "no-transcript")  # no assistant entry in the tail
        self.assertEqual(self.stuck({"sessionId": "../" + SID[3:]}), "no-transcript")
        self.assertEqual(self.stuck({}), "no-transcript")
        self.write(self.assistant("2026-10-28T08:20:00Z", LIMIT, True))
        old = datetime(2026, 10, 28, 10, 40, tzinfo=MSK).timestamp()
        os.utime(self.path, (old, old))  # not written since the limit: a stale copy after --resume
        self.assertEqual(self.stuck({"sessionId": SID}), "no-transcript")
        os.remove(self.path)
        self.assertEqual(self.stuck({"sessionId": SID}), "no-transcript")

    def test_the_error_within_five_minutes_before_the_hit_counts(self):  # another role may hit a bit earlier
        self.write(self.assistant("2026-10-28T07:48:00Z", LIMIT, True))  # 10:48, hit 10:52
        self.assertEqual(self.stuck({"sessionId": SID}), "")

    def test_only_the_tail_is_read(self):
        cut = b'{"type": "assistant", "cut' * 20000 + b"\n"
        self.write(self.assistant("2026-10-28T08:20:00Z", LIMIT, True), head=cut)
        self.assertEqual(self.stuck({"sessionId": SID}), "")
        self.assertEqual(budget.last_assistant(self.path, tail=10), None)


class PollBudgetTest(unittest.TestCase):
    """The trigger is the lift in the daemon itself (S4): a `limit.resume` written by `nerve.py emit` calls nothing."""

    def poll(self, ctx, limit, at=datetime(2026, 10, 28, 14, 41, tzinfo=MSK), spent=0.0, keep=False):
        ctx.now = at.astimezone(timezone.utc)
        if not keep:
            ctx.state = {"budget": {"meter": {}, "waves": [], "limit": limit, "checked": "", "warned": "",
                                    "calibrated": "x"}}
        meter = mock.Mock()
        meter.update.return_value = []
        meter.total.return_value = spent
        with mock.patch.object(budget, "Meter", return_value=meter), \
                mock.patch.object(sources, "active_roles", return_value=["backend", "coord"]), \
                mock.patch.object(wake, "start") as start, mock.patch.object(wake, "step") as step:
            actions.poll_budget(ctx)
        self.steps = step.call_args_list
        return start

    def test_reset_starts_the_queue_once_and_every_pass_steps_it(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            limit = {"kind": "session", "hit": HIT, "reset": RESET, "resume": RESET}
            self.poll(ctx, limit).assert_called_once_with(ctx, ctx.state["budget"], RESET, HIT, RESET, LABEL)
            self.assertIsNone(ctx.state["budget"]["limit"])
            self.assertIsNotNone(ctx.mode)
            self.assertEqual(self.steps, [mock.call(ctx, ctx.state["budget"], NOW, False)])
            later = dict(limit, resume="2026-10-28T18:52+03:00")  # not yet
            self.poll(ctx, later).assert_not_called()
            self.assertEqual(len(self.steps), 1)

    def test_the_warn_share_holds_the_step(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            self.poll(ctx, None, spent=1e9)
            self.assertEqual(self.steps, [mock.call(ctx, ctx.state["budget"], NOW, True)])

    def test_an_early_lift_wakes_with_its_own_key_and_again_at_the_reset(self):  # SE-187 A
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            limit = {"kind": "weekly", "hit": HIT, "reset": RESET, "resume": RESET}
            start = self.poll(ctx, limit, at=datetime(2026, 10, 28, 12, 0, tzinfo=MSK), spent=1.0)
            start.assert_called_once_with(ctx, ctx.state["budget"], f"early:{HIT}", HIT, RESET,
                                          "ранний подъём (лимит 10:52, сброс 28.10 14:40)")
            self.assertIsNone(ctx.state["budget"]["limit"])
            self.assertEqual(ctx.state["budget"]["unstick_due"], [{"reset": RESET, "hit": HIT}])
            self.assertEqual([r["kind"] for r in recs(d, None)], ["limit.resume"])
            self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 0, tzinfo=MSK), keep=True).assert_not_called()
            start = self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 41, tzinfo=MSK), keep=True)
            start.assert_called_once_with(ctx, ctx.state["budget"], RESET, HIT, RESET, LABEL + " после раннего подъёма")
            self.assertEqual(ctx.state["budget"]["unstick_due"], [])
            self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 50, tzinfo=MSK), keep=True).assert_not_called()

    def test_a_newer_limit_drops_the_old_reset_without_a_wake(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            self.poll(ctx, {"kind": "weekly", "hit": HIT, "reset": RESET, "resume": RESET},
                      at=datetime(2026, 10, 28, 12, 0, tzinfo=MSK), spent=1.0)
            newer = "2026-10-28T19:00+03:00"
            ctx.state["budget"]["limit"] = {"kind": "session", "hit": "2026-10-28T14:00+03:00", "reset": newer,
                                            "resume": newer}
            self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 41, tzinfo=MSK), keep=True).assert_not_called()
            self.assertEqual(ctx.state["budget"]["unstick_due"], [])

    def test_a_night_reset_lifted_before_the_morning_starts_the_queue(self):  # Claude lens B1 on #483
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            reset = "2026-10-28T01:40+03:00"
            limit = {"kind": "session", "hit": "2026-10-28T00:50+03:00", "reset": reset,
                     "resume": "2026-10-28T08:30+03:00"}
            start = self.poll(ctx, limit, at=datetime(2026, 10, 28, 1, 42, tzinfo=MSK), spent=1.0)
            start.assert_called_once_with(ctx, ctx.state["budget"], reset, limit["hit"], reset, "сброс 28.10 01:40")
            self.assertIsNone(ctx.state["budget"]["limit"])
            self.assertNotIn("unstick_due", ctx.state["budget"])

    def test_a_manual_resume_event_calls_nothing(self):  # N3 (d)
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            ctx.journal.emit("manual:2026-10-28T11:41:00+00:00:backend:1", "limit.resume", "nervous", ["backend"],
                             "лимит снят", "manual")
            self.poll(ctx, None).assert_not_called()


if __name__ == "__main__":
    unittest.main()
