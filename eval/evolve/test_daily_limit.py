#!/usr/bin/env python3
"""SE-49: a night that meets the account limit at the start waits once for the reset and calibrates again (coord
25.11, variant A). The clock and the sleep are replaced: no test waits.
Run: python3 -I -m unittest discover -s eval/evolve -p 'test_*.py'"""
import datetime
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import judges as judging  # noqa: E402
from test_daily import CASES, NEW, judge  # noqa: E402

SONNET, HAIKU, OPUS = judging.CLAUDE_CANDIDATES
MSK = datetime.timezone(datetime.timedelta(hours=3))
START = datetime.datetime(2026, 11, 24, 5, 0, 20, tzinfo=MSK)   # the launchd run at 05:00
LIMIT = "claude -p exit 1: You've hit your 5-hour limit · resets %s (Europe/Minsk)"   # as in runs/2026-11-24.json


class LimitRetryTest(unittest.TestCase):
    def setUp(self):
        self.now, self.slept = [START], []

        def sleep(seconds):
            self.slept.append(seconds)
            self.now[0] += datetime.timedelta(seconds=seconds)
        for name, value in (('CLOCK', lambda: self.now[0]), ('SLEEP', sleep)):
            p = mock.patch.object(judging, name, value)
            p.start()
            self.addCleanup(p.stop)

    def factory(self, said=LIMIT % '7am', until=None, own=None):
        """Every call answers `said` (an OSError) until the clock reaches `until`, then an honest judge; `own` —
        judges of their own by name."""
        def make(name):
            if own and name in own:
                return own[name]
            honest = judge()

            def call(system, user):
                if until is None or self.now[0] < until:
                    raise OSError(said)
                return honest(system, user)
            return call
        return make

    def run_select(self, make, deadline=None):
        return judging.select_after_limit(judging.candidates(True), make, CASES, NEW, deadline=deadline)

    def test_waits_for_the_reset_and_calibrates_again(self):
        reset = START.replace(hour=7, minute=0, second=0)
        passed, rows, retry = self.run_select(self.factory(until=reset))
        self.assertEqual(self.slept, [7480.0])                   # 05:00:20 → 07:05:00
        self.assertEqual(passed, [SONNET, HAIKU])
        self.assertEqual([r['model'] for r in rows], [SONNET, HAIKU, OPUS])   # one row per model
        self.assertEqual([r.get('retry', False) for r in rows], [True, True, False])
        self.assertIn('unavailable', rows[2]['reasons'][0])      # opus is not needed after two passed
        self.assertEqual(retry, {'reset': '2026-11-24T07:00+03:00', 'woke': '2026-11-24T07:05+03:00',
                                 'models': [SONNET, HAIKU, OPUS], 'passed': [SONNET, HAIKU]})

    def test_one_passed_retries_only_the_blocked(self):
        reset = START.replace(hour=5, minute=10, second=0)
        passed, rows, retry = self.run_select(self.factory(LIMIT % '5:10am', until=reset, own={SONNET: judge()}))
        self.assertEqual(self.slept, [880.0])                    # 05:00:20 → 05:15:00
        self.assertEqual(passed, [SONNET, HAIKU])
        self.assertEqual([r.get('retry', False) for r in rows], [False, True, False])
        self.assertEqual(retry['models'], [HAIKU, OPUS])

    def test_limit_again_after_the_reset_is_still_not_measured(self):
        passed, rows, retry = self.run_select(self.factory())
        self.assertEqual(len(self.slept), 1)                      # one retry, never a second
        self.assertEqual(passed, [])
        self.assertTrue(all(r['reasons'][0].startswith('unavailable') and r['retry'] for r in rows))
        self.assertEqual(retry['passed'], [])

    def test_no_retry(self):
        late = self.factory(LIMIT % '8am')                        # 25.11: the weekly limit resets at 08:00
        cases = {
            'reset after 07:45': late,
            'reset already passed': self.factory(LIMIT % '4am'),
            'reset with a date': self.factory("claude -p exit 1: You've hit your weekly limit · resets Nov 27, 8am"),
            'no reset time': self.factory("claude -p exit 1:  Your account can't receive replies from Claude"),
            'a real failure': self.factory(own={SONNET: lambda s, u: 'X'}),
            'wake after the deadline': self.factory(),
        }
        for why, make in cases.items():
            with self.subTest(why):
                self.now[0], self.slept[:] = START, []
                deadline = (START + datetime.timedelta(hours=1)).timestamp() if 'deadline' in why else None
                passed, rows, retry = self.run_select(make, deadline=deadline)
                self.assertEqual((self.slept, retry, passed), ([], None, []))
                self.assertEqual(len(rows), 3)

    def test_two_passed_never_wait(self):
        passed, rows, retry = self.run_select(self.factory(own={SONNET: judge(), HAIKU: judge()}))
        self.assertEqual((passed, retry, self.slept), ([SONNET, HAIKU], None, []))

    def test_reset_time_forms(self):
        row = lambda said: {'passed': False, 'reasons': ['unavailable: OSError: ' + said]}  # noqa: E731
        at = lambda h, m=0: START.replace(hour=h, minute=m, second=0)  # noqa: E731
        for said, want in ((LIMIT % '5:10am', at(5, 10)), (LIMIT % '7 AM', at(7)), (LIMIT % '12am', at(0)),
                           (LIMIT % '12pm', at(12)), (LIMIT % '2:40pm', at(14, 40)), (LIMIT % '13am', None),
                           (LIMIT % '7:75am', None), ('claude -p: empty answer', None)):
            with self.subTest(said):
                self.assertEqual(judging.limit_reset(row(said), START), want)
        self.assertIsNone(judging.limit_reset({'passed': True, 'reasons': [LIMIT % '7am']}, START))


if __name__ == '__main__':
    unittest.main()
