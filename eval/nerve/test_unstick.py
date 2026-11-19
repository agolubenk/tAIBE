"""SE-174 and SE-187 in the Nerve: on a lift (the reset, or an early lift before it) the budget pass calls
limit_unstick once, writes one `limit.unstick` per line with keys (sha256 of the menu lines, not the screen) into the
journal of the pane's product, one summary line per product (also an empty one), and keeps going on a failure.
D2 (the session stands because of the limit) is read here, in the Nerve code. limit_unstick itself is a mock here:
its own tests are eval/tools/test_limit_unstick.py.

Run: python3 -I -m unittest discover -s eval/nerve -p 'test_unstick.py'
"""
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
from journal import read_from  # noqa: E402
from test_nerve import CFG, MSK, FakeCtx  # noqa: E402

RESET = "2026-10-28T14:40+03:00"
HIT = "2026-10-28T10:52+03:00"
LABEL = "сброс 28.10 14:40"
HOME = CFG["repo_root"]
ROWS = [{"line": "r.ab12", "role": "backend", "pane": "%7", "path": HOME, "kind": "menu", "action": "esc, enter",
         "sha256": "a" * 64},
        {"line": "r.cd34", "role": "plan", "pane": "%8", "path": HOME + "/worktrees/fix/x", "kind": "menu",
         "action": "esc; menu stayed", "sha256": "b" * 64},
        {"line": "r.ef56", "role": "release", "pane": "%9", "path": HOME, "kind": None,
         "action": "no keys: status busy", "sha256": ""}]
SID = "0123abcd-0000-4000-8000-00000000abcd"
LIMIT = "You've hit your session limit · resets 2:40pm (Europe/Moscow)"


class Ctx(FakeCtx):
    def __init__(self, d, deliver=True, unstick=True, root=None):
        super().__init__(d)
        self.cfg = dict(CFG, budget=dict(CFG["budget"], unstick=unstick), **({"repo_root": root} if root else {}))
        self.deliver = deliver
        self.mode = None

    def write_mode(self, mode):
        self.mode = mode


def recs(d):
    return read_from(os.path.join(d, "j.jsonl"), 0)[0]


class UnstickRolesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.d = tmp.name
        self.asked = []

    def fake(self, rows=ROWS):
        def unstick(fresh, stuck=None):
            self.asked.append([d["line"] for d in rows if fresh(d["line"])])
            return [d for d in rows if fresh(d["line"])]
        return mock.patch.object(limit_unstick, "unstick", side_effect=unstick)

    def test_one_line_per_pane_with_keys_and_one_summary(self):
        ctx = Ctx(self.d)
        with self.fake():
            actions.unstick_roles(ctx, RESET, HIT, LABEL)
            actions.unstick_roles(ctx, RESET, HIT, LABEL)  # the same lift again: no line is fresh, no second summary
        self.assertEqual(self.asked, [["r.ab12", "r.cd34", "r.ef56"], ["r.ef56"]])
        got = recs(self.d)
        self.assertEqual([(r["key"], r["kind"], r["class"], r["to"]) for r in got],
                         [(f"limit:unstick:{RESET}:r.ab12", "limit.unstick", "digest", ["coord"]),
                          (f"limit:unstick:{RESET}:r.cd34", "limit.unstick", "digest", ["coord"]),
                          (f"limit:unstick:{RESET}:summary", "limit.unstick", "digest", ["coord"])])
        self.assertEqual(got[0]["sha256"], "a" * 64)
        self.assertEqual(got[0]["text"], f"backend (r.ab12, панель %7), {LABEL}: меню лимита — esc, enter; sha256 "
                                         + "a" * 16)
        self.assertEqual(got[2]["text"], f"{LABEL}: панели ролей 3 — backend r.ab12: esc, enter; plan r.cd34: esc; "
                                         "menu stayed; release r.ef56: no keys: status busy")

    def test_lines_and_summaries_go_to_the_product_of_the_pane(self):  # SE-187 B, C
        with tempfile.TemporaryDirectory() as pd:
            ctx, peer = Ctx(self.d), Ctx(pd, root="/x/tAIBE")
            ctx.peers = {"taibe": peer}
            rows = [dict(ROWS[0], path="/x/tAIBE/worktrees/fix/y"), dict(ROWS[1], path="/x/tAIBE-old"),
                    dict(ROWS[2], path="")]
            with self.fake(rows):
                actions.unstick_roles(ctx, RESET, HIT, LABEL)
            self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(pd)], ["r.ab12", "summary"])
            self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(self.d)], ["r.cd34", "summary"])
            self.assertEqual(recs(pd)[1]["text"], f"{LABEL}: панели ролей 1 — backend r.ab12: esc, enter")
            with self.fake(rows):  # a key in any product's journal: the line is not fresh any more
                actions.unstick_roles(ctx, RESET, HIT, LABEL)
            self.assertEqual(self.asked[-1], ["r.ef56"])

    def test_a_product_without_panes_gets_an_empty_summary(self):  # coord 15:03: the empty case is a line
        with tempfile.TemporaryDirectory() as pd:
            ctx, peer = Ctx(self.d), Ctx(pd, root="/x/tAIBE")
            ctx.peers = {"taibe": peer}
            with self.fake([]):
                actions.unstick_roles(ctx, f"early:{HIT}", HIT, "ранний подъём")
            for d in (self.d, pd):
                self.assertEqual([(r["key"], r["text"]) for r in recs(d)],
                                 [(f"limit:unstick:early:{HIT}:summary", "ранний подъём: панели ролей 0")])

    def test_an_idle_wake_names_the_role_and_the_lift(self):  # coord 15:10, product note 1
        with self.fake([dict(ROWS[0], kind="idle", action="idle after limit: text, enter", sha256="")]):
            actions.unstick_roles(Ctx(self.d), RESET, HIT, LABEL)
        self.assertEqual(recs(self.d)[0]["text"], f"backend (r.ab12, панель %7), {LABEL}: ввод после лимита — idle "
                                                  "after limit: text, enter")

    def test_a_line_without_a_hash_has_no_hash_part(self):
        with self.fake([dict(ROWS[0], role="", action="no keys: status menu, no screen", sha256="")]):
            actions.unstick_roles(Ctx(self.d), RESET, HIT, LABEL)
        self.assertEqual(recs(self.d)[0]["text"], f"роль (r.ab12, панель %7), {LABEL}: меню лимита — no keys: status "
                                                  "menu, no screen")

    def test_a_failing_peer_journal_keeps_the_others(self):
        with tempfile.TemporaryDirectory() as pd:
            ctx, peer = Ctx(self.d), Ctx(pd, root="/x/tAIBE")
            ctx.peers = {"taibe": peer}
            with self.fake([dict(ROWS[0], path="/x/tAIBE")] + ROWS[1:]), \
                    mock.patch.object(peer, "emit", side_effect=OSError("disk")):
                actions.unstick_roles(ctx, RESET, HIT, LABEL)
            self.assertEqual([r["key"].rsplit(":", 1)[1] for r in recs(self.d)], ["r.cd34", "summary"])

    def test_off_without_delivery_or_the_switch(self):
        no_key = Ctx(self.d)
        no_key.cfg = dict(CFG, budget={k: v for k, v in CFG["budget"].items() if k != "unstick"})
        for ctx in (Ctx(self.d, deliver=False), Ctx(self.d, unstick=False), no_key):
            with self.subTest(deliver=ctx.deliver, unstick=ctx.cfg["budget"].get("unstick")), self.fake() as m:
                actions.unstick_roles(ctx, RESET, HIT, LABEL)
                m.assert_not_called()
        self.assertEqual(recs(self.d), [])

    def test_a_failure_is_one_error_line_and_no_raise(self):
        ctx = Ctx(self.d)
        with mock.patch.object(limit_unstick, "unstick", side_effect=OSError("tmux: no server")):
            actions.unstick_roles(ctx, RESET, HIT, LABEL)
            actions.unstick_roles(ctx, RESET, HIT, LABEL)
        self.assertEqual([(r["kind"], r["to"]) for r in recs(self.d)], [("nerve.error", ["release"])])

    def test_the_switch_is_on_in_the_rendered_config(self):
        self.assertIs(CFG["budget"].get("unstick"), True)


class StuckTest(unittest.TestCase):
    """SE-187 D2: the last assistant entry of the session's transcript is a limit error at or after hit − 5 min."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ctx = Ctx(tmp.name)
        os.makedirs(os.path.join(tmp.name, "-x-tAIBE"))
        self.path = os.path.join(tmp.name, "-x-tAIBE", SID + ".jsonl")
        self.stuck = actions.stuck_after(self.ctx, HIT)

    def write(self, *entries, head=b""):
        with open(self.path, "wb") as f:
            f.write(head + b"".join(json.dumps(e).encode() + b"\n" for e in entries))

    @staticmethod
    def assistant(at, text="ok", error=False):
        return {"type": "assistant", "timestamp": at, "isApiErrorMessage": error,
                "message": {"content": [{"type": "text", "text": text}]}}

    def test_the_limit_error_after_the_hit_is_stuck(self):
        err = self.assistant("2026-10-28T08:20:00Z", LIMIT, True)  # 11:20 MSK
        tail = [{"type": "user", "timestamp": "2026-10-28T08:21:00Z", "message": {"content": "/rate-limit-options"}},
                {"type": "system", "timestamp": "2026-10-28T08:21:01Z"}]
        self.write(self.assistant("2026-10-28T07:00:00Z"), err, *tail)
        self.assertTrue(self.stuck({"sessionId": SID}))

    def test_not_stuck(self):
        cases = {"a normal answer after the error": [self.assistant("2026-10-28T08:20:00Z", LIMIT, True),
                                                     self.assistant("2026-10-28T08:30:00Z")],
                 "the error before hit - 5 min": [self.assistant("2026-10-28T07:46:00Z", LIMIT, True)],
                 "another API error": [self.assistant("2026-10-28T08:20:00Z", "API Error: 529 overloaded", True)],
                 "no assistant entry": [{"type": "user", "timestamp": "2026-10-28T08:20:00Z"}]}
        for why, entries in cases.items():
            with self.subTest(why):
                self.write(*entries)
                self.assertFalse(self.stuck({"sessionId": SID}))
        self.assertFalse(self.stuck({"sessionId": "../" + SID[3:]}))
        self.assertFalse(self.stuck({}))
        os.remove(self.path)
        self.assertFalse(self.stuck({"sessionId": SID}))

    def test_the_error_within_five_minutes_before_the_hit_counts(self):  # another role may hit a bit earlier
        self.write(self.assistant("2026-10-28T07:48:00Z", LIMIT, True))  # 10:48, hit 10:52
        self.assertTrue(self.stuck({"sessionId": SID}))

    def test_only_the_tail_is_read(self):
        cut = b'{"type": "assistant", "cut' * 20000 + b"\n"
        self.write(self.assistant("2026-10-28T08:20:00Z", LIMIT, True), head=cut)
        self.assertTrue(self.stuck({"sessionId": SID}))
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
                mock.patch.object(actions, "unstick_roles") as un:
            actions.poll_budget(ctx)
        return un

    def test_reset_calls_unstick_once(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            limit = {"kind": "session", "hit": HIT, "reset": RESET, "resume": RESET}
            self.poll(ctx, limit).assert_called_once_with(ctx, RESET, HIT, LABEL)
            self.assertIsNone(ctx.state["budget"]["limit"])
            self.assertIsNotNone(ctx.mode)
            later = dict(limit, resume="2026-10-28T18:52+03:00")  # not yet
            self.poll(ctx, later).assert_not_called()

    def test_an_early_lift_unsticks_with_its_own_key_and_again_at_the_reset(self):  # SE-187 A
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            limit = {"kind": "weekly", "hit": HIT, "reset": RESET, "resume": RESET}
            un = self.poll(ctx, limit, at=datetime(2026, 10, 28, 12, 0, tzinfo=MSK), spent=1.0)
            un.assert_called_once_with(ctx, f"early:{HIT}", HIT, "ранний подъём (лимит 10:52, сброс 28.10 14:40)")
            self.assertIsNone(ctx.state["budget"]["limit"])
            self.assertEqual(ctx.state["budget"]["unstick_due"], [{"reset": RESET, "hit": HIT}])
            self.assertEqual([r["kind"] for r in recs(d)], ["limit.resume"])
            self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 0, tzinfo=MSK), keep=True).assert_not_called()
            un = self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 41, tzinfo=MSK), keep=True)
            un.assert_called_once_with(ctx, RESET, HIT, LABEL + " после раннего подъёма")
            self.assertEqual(ctx.state["budget"]["unstick_due"], [])
            self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 50, tzinfo=MSK), keep=True).assert_not_called()

    def test_a_newer_limit_drops_the_old_reset_without_keys(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            self.poll(ctx, {"kind": "weekly", "hit": HIT, "reset": RESET, "resume": RESET},
                      at=datetime(2026, 10, 28, 12, 0, tzinfo=MSK), spent=1.0)
            newer = "2026-10-28T19:00+03:00"
            ctx.state["budget"]["limit"] = {"kind": "session", "hit": "2026-10-28T14:00+03:00", "reset": newer,
                                            "resume": newer}
            self.poll(ctx, None, at=datetime(2026, 10, 28, 14, 41, tzinfo=MSK), keep=True).assert_not_called()
            self.assertEqual(ctx.state["budget"]["unstick_due"], [])

    def test_a_night_reset_lifted_before_the_morning_calls_unstick(self):  # Claude lens B1 on #483
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            reset = "2026-10-28T01:40+03:00"
            limit = {"kind": "session", "hit": "2026-10-28T00:50+03:00", "reset": reset,
                     "resume": "2026-10-28T08:30+03:00"}
            un = self.poll(ctx, limit, at=datetime(2026, 10, 28, 1, 42, tzinfo=MSK), spent=1.0)
            un.assert_called_once_with(ctx, reset, limit["hit"], "сброс 28.10 01:40")
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
