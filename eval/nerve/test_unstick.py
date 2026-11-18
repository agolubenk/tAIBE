"""SE-174 in the Nerve: at the limit reset the budget pass calls limit_unstick once, writes one `limit.unstick` per
line (sha256 of the menu lines, not the screen), and keeps going on a failure. limit_unstick itself is a mock here:
its own tests are eval/tools/test_limit_unstick.py.

Run: python3 -I -m unittest discover -s eval/nerve -p 'test_unstick.py'
"""
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
DONE = [{"line": "r.ab12", "role": "backend", "pane": "%7", "action": "esc, enter", "sha256": "a" * 64},
        {"line": "r.cd34", "role": "plan", "pane": "%8", "action": "esc; menu stayed", "sha256": "b" * 64}]


class Ctx(FakeCtx):
    def __init__(self, d, deliver=True, unstick=True):
        super().__init__(d)
        self.cfg = dict(CFG, budget=dict(CFG["budget"], unstick=unstick))
        self.deliver = deliver
        self.mode = None

    def write_mode(self, mode):
        self.mode = mode


class UnstickRolesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.d = tmp.name
        self.asked = []

    def fake(self, done=DONE):
        def unstick(fresh):
            self.asked.append([d["line"] for d in done if fresh(d["line"])])
            return [d for d in done if fresh(d["line"])]
        return mock.patch.object(limit_unstick, "unstick", side_effect=unstick)

    def records(self):
        return read_from(os.path.join(self.d, "j.jsonl"), 0)[0]

    def test_one_line_per_pane_with_the_hash_only(self):
        ctx = Ctx(self.d)
        with self.fake():
            actions.unstick_roles(ctx, RESET)
            actions.unstick_roles(ctx, RESET)  # a second call in the same reset: no pane is fresh any more
        self.assertEqual(self.asked, [["r.ab12", "r.cd34"], []])
        recs = self.records()
        self.assertEqual([(r["key"], r["kind"], r["class"], r["to"]) for r in recs],
                         [(f"limit:unstick:{RESET}:r.ab12", "limit.unstick", "digest", ["coord"]),
                          (f"limit:unstick:{RESET}:r.cd34", "limit.unstick", "digest", ["coord"])])
        self.assertEqual(recs[0]["sha256"], "a" * 64)
        self.assertEqual(recs[0]["text"], "backend (r.ab12, панель %7): меню лимита — esc, enter; sha256 строк меню "
                                          + "a" * 16)

    def test_off_without_delivery_or_the_switch(self):
        no_key = Ctx(self.d)
        no_key.cfg = dict(CFG, budget={k: v for k, v in CFG["budget"].items() if k != "unstick"})
        for ctx in (Ctx(self.d, deliver=False), Ctx(self.d, unstick=False), no_key):
            with self.subTest(deliver=ctx.deliver, unstick=ctx.cfg["budget"].get("unstick")), self.fake() as m:
                actions.unstick_roles(ctx, RESET)
                m.assert_not_called()
        self.assertEqual(self.records(), [])

    def test_a_failure_is_one_error_line_and_no_raise(self):
        ctx = Ctx(self.d)
        with mock.patch.object(limit_unstick, "unstick", side_effect=OSError("tmux: no server")):
            actions.unstick_roles(ctx, RESET)
            actions.unstick_roles(ctx, RESET)
        self.assertEqual([(r["kind"], r["to"]) for r in self.records()], [("nerve.error", ["release"])])

    def test_the_switch_is_on_in_the_rendered_config(self):
        self.assertIs(CFG["budget"].get("unstick"), True)


class PollBudgetTest(unittest.TestCase):
    """The trigger is the reset in the daemon itself (S4): a `limit.resume` written by `nerve.py emit` calls nothing."""

    def poll(self, ctx, limit):
        ctx.now = datetime(2026, 10, 28, 14, 41, tzinfo=MSK).astimezone(timezone.utc)
        ctx.state = {"budget": {"meter": {}, "waves": [], "limit": limit, "checked": "", "warned": "",
                                "calibrated": "x"}}
        meter = mock.Mock()
        meter.update.return_value = []
        meter.total.return_value = 0.0
        with mock.patch.object(budget, "Meter", return_value=meter), \
                mock.patch.object(sources, "active_roles", return_value=["backend", "coord"]), \
                mock.patch.object(actions, "unstick_roles") as un:
            actions.poll_budget(ctx)
        return un

    def test_reset_calls_unstick_once(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            hit = datetime(2026, 10, 28, 10, 52, tzinfo=MSK)
            limit = {"kind": "session", "hit": actions._iso(hit), "reset": RESET, "resume": RESET}
            un = self.poll(ctx, limit)
            un.assert_called_once_with(ctx, RESET)
            self.assertIsNone(ctx.state["budget"]["limit"])
            self.assertIsNotNone(ctx.mode)
            later = dict(limit, resume=actions._iso(hit + timedelta(hours=8)))  # not yet
            self.poll(ctx, later).assert_not_called()

    def test_a_manual_resume_event_calls_nothing(self):  # N3 (d)
        with tempfile.TemporaryDirectory() as d:
            ctx = Ctx(d)
            ctx.journal.emit("manual:2026-10-28T11:41:00+00:00:backend:1", "limit.resume", "nervous", ["backend"],
                             "лимит снят", "manual")
            self.poll(ctx, None).assert_not_called()


if __name__ == "__main__":
    unittest.main()
