"""Synthetic-data tests for peer_gate.py (SE-41). No network, no real session state.
Run: python3 -I -m unittest discover -s eval/pipeline/reflex -p 'test_peer_gate.py'
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

import peer_gate  # noqa: E402

NOW = 1_800_000_000.0


class PeerGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        work = tempfile.mkdtemp()
        self.mode = os.path.join(work, 'mode.json')
        self.transcript = os.path.join(work, 't.jsonl')
        open(self.transcript, 'w').close()

    def set_mode(self, share5, age=60):
        at = datetime.fromtimestamp(NOW - age).astimezone().isoformat(timespec='minutes')
        with open(self.mode, 'w') as f:
            json.dump({'share5': share5, 'at': at}, f)

    def heard(self, name, ago, address='uds:/tmp/cc-socks/1.sock', body='GOAL: x'):
        text = (f'Another Claude session sent a message:\n<cross-session-message from="{address}" from-name="{name}" '
                f'from-mode="prompting">\n{body}\n</cross-session-message>')
        ts = datetime.fromtimestamp(NOW - ago, timezone.utc).isoformat().replace('+00:00', 'Z')
        with open(self.transcript, 'a') as f:
            f.write(json.dumps({'type': 'user', 'timestamp': ts, 'message': {'role': 'user', 'content': text}}) + '\n')

    def filler(self, lines, ago=None):
        ts = {} if ago is None else {
            'timestamp': datetime.fromtimestamp(NOW - ago, timezone.utc).isoformat().replace('+00:00', 'Z')}
        with open(self.transcript, 'a') as f:
            for _ in range(lines):
                f.write(json.dumps({'type': 'user', **ts, 'message': {'content': 'peer-a ' + 'x' * 1000}}) + '\n')

    def send(self, to, message='RESULT: PR #1 is ready at head abc1234.', at=NOW, session='s1'):
        event = {'session_id': session, 'transcript_path': self.transcript, 'tool_name': 'SendMessage',
                 'tool_input': {'to': to, 'message': message}}
        verdict = peer_gate.decide(event, at, self.dir, self.mode)[0]
        out = peer_gate.respond(event, at, self.dir, self.mode)
        return verdict, out

    def reason(self, out):
        return out['hookSpecificOutput']['permissionDecisionReason']

    def test_trivial_pass(self):
        self.assertEqual(self.send('main')[0], 'pass-trivial')
        self.assertEqual(self.send('peer-a', message='  ')[0], 'pass-trivial')
        self.assertEqual(peer_gate.decide({}, NOW, self.dir, self.mode)[0], 'pass-trivial')

    def test_ack_only_is_denied(self):
        verdict, out = self.send('peer-a', message='Принял, спасибо.')
        self.assertEqual(verdict, 'deny-ack')
        self.assertEqual(out['hookSpecificOutput']['permissionDecision'], 'deny')
        for msg in ('ok', 'Thanks!', 'ok 👍', 'Понял, принял', 'ACK.', 'Окей'):
            self.assertEqual(self.send('peer-z', message=msg)[0], 'deny-ack', msg)
        self.assertEqual(self.send('peer-b', message='Ack: is #610 in the chain?')[0], 'pass')
        self.assertEqual(self.send('peer-c', message='OK ' + 'x' * 300)[0], 'pass')

    def test_ack_with_a_fact_passes(self):
        """F1 (GLM run 1): a short fact that starts with an acknowledgement word is not an acknowledgement."""
        self.assertEqual(self.send('peer-a', message='Ok, деплой прошёл, run 77341')[0], 'pass')
        self.assertEqual(self.send('peer-b', message='Принял: PR #132 смёржен в head 60470a0')[0], 'pass')
        self.assertEqual(self.send('peer-c', message='ok, merge #132')[0], 'pass')

    def test_ack_that_answers_a_question_passes(self):
        self.send('ctl', at=NOW - 900)
        self.heard('ctl', ago=60, body='Can I merge #132 now?')
        self.assertEqual(self.send('ctl', message='ok')[0], 'pass-reply')
        self.send('author', at=NOW - 900)
        self.heard('author', ago=60, body='RESULT: #132 head 60470a0 is ready.')
        self.assertEqual(self.send('author', message='Принял, спасибо.')[0], 'deny-ack')

    def test_handoff_receipt_is_denied_unless_urgent(self):
        msg = 'RESULT: plan-6aza-23 is accepted by vpn-spec-b6 (gen 24). The lineage ack follows.'
        verdict, out = self.send('pred', message='plan gen 22 accepts handoff plan-21.md. RESULT: ok')
        self.assertEqual(verdict, 'deny-handoff')
        self.assertNotIn('URGENT', self.reason(out))
        self.assertEqual(self.send('pred', message=msg.replace('is accepted', 'handoff is accepted'))[0],
                         'deny-handoff')
        self.assertEqual(self.send('pred', message='URGENT: handoff accepted, but stop the deploy now.')[0],
                         'pass-urgent')

    def test_status_that_mentions_a_handoff_passes(self):
        """F2 (GLM run 1): a fact about another role's handoff, or a long status, is not a receipt."""
        status = 'role 3 successor handoff accepted at 12:00; HR #613 needs GLM run 2 before the merge.'
        self.assertEqual(self.send('coord', message=status)[0], 'pass')
        long = 'STATUS: handoff accepted by the role 3 successor. ' + 'Facts for the coordinator follow. ' * 6
        self.assertEqual(self.send('coord-2', message=long)[0], 'pass')
        self.assertEqual(self.send('coord-3', message='handoff accepted — should I take lane P?')[0], 'pass')

    def test_requested_receipt_is_a_reply(self):
        """F2: the reply rule runs before the receipt rule — a receipt that the recipient asked for passes."""
        self.heard('hr-helper-v2-81', ago=120, body='RETURN: "lane P taken" plus your line.')
        self.assertEqual(self.send('hr-helper-v2-81', message='Handoff accepted: lane P taken, line r.8gac.')[0],
                         'pass-reply')

    def test_cooldown_to_same_recipient(self):
        self.assertEqual(self.send('peer-a', at=NOW)[0], 'pass')
        verdict, out = self.send('peer-a', at=NOW + 300)
        self.assertEqual(verdict, 'deny-cooldown')
        self.assertNotIn('URGENT', self.reason(out))
        self.assertIn('work_state', self.reason(out))
        self.assertEqual(self.send('peer-b', at=NOW + 300)[0], 'pass')
        self.assertEqual(self.send('peer-a', at=NOW + 301, message='BLOCKER: the deploy failed.')[0], 'pass-urgent')
        self.assertEqual(self.send('peer-a', at=NOW + 2000)[0], 'pass')

    def test_urgent_has_its_own_hourly_limit(self):
        """P1 (GLM run 1): URGENT: is not a free bypass — max URGENT_CAP per hour, and deny texts do not teach it."""
        for i in range(peer_gate.URGENT_CAP):
            self.assertEqual(self.send(f'p{i}', at=NOW + i, message='URGENT: stop the deploy.')[0], 'pass-urgent')
        verdict, out = self.send('p9', at=NOW + 10, message='СРОЧНО: стоп деплоя.')
        self.assertEqual(verdict, 'deny-urgent')
        self.assertIn(str(peer_gate.URGENT_CAP), self.reason(out))
        self.assertEqual(self.send('p9', at=NOW + 10)[0], 'pass')
        self.assertEqual(self.send('p8', at=NOW + 3601, message='URGENT: stop the deploy.')[0], 'pass-urgent')

    def test_denied_send_does_not_start_a_cooldown(self):
        self.assertEqual(self.send('peer-a', message='ok')[0], 'deny-ack')
        self.assertEqual(self.send('peer-a', at=NOW + 10)[0], 'pass')

    def test_reply_passes_cooldown(self):
        self.send('hr-helper-v2-81', at=NOW - 400)
        self.heard('hr-helper-v2-81', ago=100)
        self.assertEqual(self.send('hr-helper-v2-81')[0], 'pass-reply')
        self.assertEqual(self.send('hr-helper-v2-81', at=NOW + 60)[0], 'deny-cooldown')

    def test_report_after_a_long_wait_is_a_reply(self):
        """P2 (GLM run 1): Control reports a merge 2 h after the author asked — still a reply, past cooldown and cap."""
        self.set_mode(0.9)
        for i, to in enumerate(['p1', 'p2', 'p3']):
            self.send(to, at=NOW - 100 + i)
        self.heard('author', ago=2 * 3600, body='GOAL: run GLM on #132 and merge it.')
        self.assertEqual(self.send('author', message='RESULT: merged #132 at 1a2b3c4, probe ok.')[0], 'pass-reply')

    def test_reply_found_behind_megabytes_of_work(self):
        self.send('peer-a', at=NOW - 400)
        self.heard('peer-a', ago=100)
        self.filler(2000)
        self.assertEqual(self.send('peer-a')[0], 'pass-reply')

    def test_search_stops_at_a_tail_older_than_the_window(self):
        """R1 (GLM run 1): the gate reads the smallest tail; it does not read further than REPLY_WINDOW."""
        # Out of order on purpose: a fresh mark before the old part is found only if the search reads past it.
        self.heard('peer-a', ago=30)
        self.filler(300, ago=peer_gate.REPLY_WINDOW + 300)
        self.filler(300, ago=60)
        tails = (100_000, 400_000, 10_000_000)
        self.assertIsNone(peer_gate.last_heard(self.transcript, 'peer-a', NOW - peer_gate.REPLY_WINDOW, tails))
        self.heard('peer-a', ago=30)
        self.assertEqual(peer_gate.last_heard(self.transcript, 'peer-a', NOW - 3600, tails)[1], False)

    def test_reply_by_from_address(self):
        self.send('uds:/tmp/cc-socks/9.sock', at=NOW - 400)
        self.heard('hr-helper-v2-81', ago=100, address='uds:/tmp/cc-socks/9.sock')
        self.assertEqual(self.send('uds:/tmp/cc-socks/9.sock')[0], 'pass-reply')

    def test_old_message_is_not_a_reply(self):
        self.heard('peer-a', ago=peer_gate.REPLY_WINDOW + 60)
        self.set_mode(0.9)
        for i, to in enumerate(['p1', 'p2', 'p3']):
            self.send(to, at=NOW - 100 + i)
        self.assertEqual(self.send('peer-a')[0], 'deny-cap')

    def test_cap_follows_share5(self):
        self.set_mode(0.7)
        for i in range(6):
            self.assertEqual(self.send(f'p{i}', at=NOW + i)[0], 'pass')
        verdict, out = self.send('p9', at=NOW + 10)
        self.assertEqual(verdict, 'deny-cap')
        self.assertIn('6 new messages per hour', self.reason(out))
        self.assertNotIn('URGENT', self.reason(out))
        self.assertEqual(self.send('p9', at=NOW + 3601)[0], 'pass')

    def test_replies_and_urgent_do_not_count_in_the_cap(self):
        """M1 (GLM run 1): the deny-cap text says replies are not limited — the count matches the text."""
        self.set_mode(0.9)
        for i in range(3):
            self.heard(f'asker{i}', ago=50 - i)
            self.assertEqual(self.send(f'asker{i}', at=NOW + i)[0], 'pass-reply')
        self.assertEqual(self.send('p0', at=NOW + 5, message='URGENT: stop the deploy.')[0], 'pass-urgent')
        for i in range(3):
            self.assertEqual(self.send(f'q{i}', at=NOW + 10 + i)[0], 'pass')
        self.assertEqual(self.send('q9', at=NOW + 20)[0], 'deny-cap')

    def test_cap_bands(self):
        self.assertIsNone(peer_gate.cap_for(None))
        self.assertIsNone(peer_gate.cap_for(0.59))
        self.assertEqual(peer_gate.cap_for(0.6), 6)
        self.assertEqual(peer_gate.cap_for(0.85), 3)

    def test_stale_or_broken_mode_means_no_cap(self):
        self.set_mode(0.95, age=3600)
        self.assertIsNone(peer_gate.share5(self.mode, NOW))
        with open(self.mode, 'w') as f:
            f.write('{broken')
        self.assertIsNone(peer_gate.share5(self.mode, NOW))
        self.assertIsNone(peer_gate.share5(os.path.join(self.dir, 'missing.json'), NOW))

    def test_broken_line_keeps_the_rest_of_the_state(self):
        """M2 (GLM run 1): one broken line does not reset the cooldown, and report shows it."""
        self.assertEqual(self.send('peer-a', at=NOW)[0], 'pass')
        path = os.path.join(self.dir, 'session-s1.jsonl')
        with open(path, 'a') as f:
            f.write('{broken\n')
        self.assertEqual(self.send('peer-a', at=NOW + 60)[0], 'deny-cooldown')
        os.utime(path, (NOW + 60, NOW + 60))
        self.assertIn('broken lines skipped: 1', peer_gate.report(24, self.dir, NOW + 61))
        # Minor 6 (GLM run 2): report reads only session files that changed within the window.
        self.assertNotIn('broken lines', peer_gate.report(24, self.dir, NOW + 2 * 86400))

    def test_old_state_is_pruned(self):
        """M3 (GLM run 1): journals older than JOURNAL_DAYS and idle session files go; a big session file shrinks."""
        old_day = (datetime.fromtimestamp(NOW) - timedelta(days=peer_gate.JOURNAL_DAYS + 1)).strftime('%Y-%m-%d')
        old_journal = os.path.join(self.dir, f'journal-{old_day}.jsonl')
        idle = os.path.join(self.dir, 'session-gone.jsonl')
        for path in (old_journal, idle):
            open(path, 'w').close()
        os.utime(idle, (NOW - 3 * 86400, NOW - 3 * 86400))
        self.send('peer-a', at=NOW)
        self.assertFalse(os.path.exists(old_journal))
        self.assertFalse(os.path.exists(idle))
        path = os.path.join(self.dir, 'session-s1.jsonl')
        with open(path, 'a') as f:
            for i in range(2000):
                f.write(json.dumps({'ts': NOW - 86400 + i, 'to': 'old', 'kind': 'pass'}) + '\n')
        self.send('peer-b', at=NOW + 1)
        rows = peer_gate.read_jsonl(path)
        self.assertEqual([r['to'] for r in rows], ['peer-a', 'peer-b'])

    def test_log_mode_keeps_would_be_denied_sends_out_of_the_cap(self):
        """Minor 1 (GLM run 2): in PEER_GATE=log a send that the gate would deny is kind «soft» — it is not a «pass»,
        so turning the gate on later does not start with a cap that the log mode filled."""
        self.set_mode(0.9)
        with mock.patch.dict(os.environ, {'PEER_GATE': 'log'}):
            for i in range(3):
                self.send(f'p{i}', at=NOW + i)
            verdict, out = self.send('p9', at=NOW + 10)
        self.assertEqual(verdict, 'deny-cap')
        self.assertIsNone(out)
        kinds = [r['kind'] for r in peer_gate.read_jsonl(os.path.join(self.dir, 'session-s1.jsonl'))]
        self.assertEqual(kinds, ['pass', 'pass', 'pass', 'soft'])
        self.assertEqual(self.send('p9', at=NOW + 20)[0], 'deny-cooldown')
        self.assertEqual(self.send('p8', at=NOW + 3601)[0], 'pass')

    def test_tails_are_read_once(self):
        """Minor 2 (GLM run 2): each tail step reads only the bytes before the previous tail."""
        self.heard('peer-a', ago=600)
        self.filler(300, ago=60)
        reads = []
        real_open = open

        def counting_open(*a, **k):
            f = real_open(*a, **k)
            real_read = f.read
            f.read = lambda n=-1: reads.append(n) or real_read(n)
            return f
        size = os.path.getsize(self.transcript)
        with mock.patch('builtins.open', counting_open):
            self.assertIsNotNone(peer_gate.last_heard(self.transcript, 'peer-a', 0, (50_000, 200_000, 10_000_000)))
        self.assertEqual(sum(reads), size)

    def test_mark_on_a_tail_boundary_is_found(self):
        """The first tail starts inside the mark: the next step reads the rest of it and finds the message."""
        self.heard('peer-a', ago=600, body='Can I merge #132?')
        self.filler(100, ago=60)
        size = os.path.getsize(self.transcript)
        with open(self.transcript, 'rb') as f:
            cut = f.read().index(b'from-name=\\"peer-a') + 3
        heard = peer_gate.last_heard(self.transcript, 'peer-a', 0, (size - cut, size))
        self.assertIsNotNone(heard)
        self.assertTrue(heard[1])

    def test_oldest_stamp_reads_the_json_field(self):
        """Minor 4 (GLM run 2): a nested «timestamp» (a tool result) does not stop the search early."""
        no_field = json.dumps({'type': 'summary', 'message': {'content': 'x'}})
        nested = json.dumps({'toolUseResult': {'timestamp': '2000-01-01T00:00:00Z'}, 'type': 'user',
                             'timestamp': '2027-01-15T08:00:00Z'})
        data = b'tail of a line\n' + no_field.encode() + b'\n' + nested.encode() + b'\n'
        self.assertEqual(peer_gate.oldest_stamp(data), datetime(2027, 1, 15, 8, tzinfo=timezone.utc).timestamp())
        self.assertIsNone(peer_gate.oldest_stamp(b'no newline at all'))

    def test_urgent_after_blank_lines_and_wording(self):
        """Minor 5 and 7 (GLM run 2): the first non-empty line counts; deny-urgent does not list the prefixes."""
        self.assertEqual(self.send('p0', message='\n\nURGENT: stop the deploy.')[0], 'pass-urgent')
        for i in range(1, peer_gate.URGENT_CAP):
            self.send(f'p{i}', at=NOW + i, message='BLOCKER: x')
        verdict, out = self.send('p9', at=NOW + 10, message='СРОЧНО: x')
        self.assertEqual(verdict, 'deny-urgent')
        for prefix in ('URGENT', 'BLOCKER', 'СРОЧНО'):
            self.assertNotIn(prefix, self.reason(out))

    def test_compaction_keeps_what_the_rules_read(self):
        """Minor 3 (GLM run 2): after compaction the file is far below the threshold — no rewrite on the next call."""
        path = os.path.join(self.dir, 'session-s1.jsonl')
        with open(path, 'w') as f:
            for i in range(1500):
                f.write(json.dumps({'ts': NOW - 5 * 3600 + i, 'to': f'old{i % 3}', 'kind': 'pass'}) + '\n')
            f.write(json.dumps({'ts': NOW - 300, 'to': 'peer-a', 'kind': 'pass'}) + '\n')
        os.utime(path, (NOW, NOW))
        open(os.path.join(self.dir, datetime.fromtimestamp(NOW).strftime('journal-%Y-%m-%d.jsonl')), 'w').close()
        self.send('peer-b', at=NOW)
        rows = peer_gate.read_jsonl(path)
        self.assertEqual(sorted(r['to'] for r in rows), ['old0', 'old1', 'old2', 'peer-a', 'peer-b'])
        self.assertLess(os.path.getsize(path), peer_gate.SESSION_MAX_BYTES // 10)
        self.assertEqual(self.send('peer-a', at=NOW + 1)[0], 'deny-cooldown')
        before = os.stat(path).st_ino
        self.send('peer-c', at=NOW + 2)
        self.assertEqual(os.stat(path).st_ino, before)

    def test_log_mode_never_denies_but_records(self):
        with mock.patch.dict(os.environ, {'PEER_GATE': 'log'}):
            verdict, out = self.send('peer-a', message='ok')
        self.assertEqual(verdict, 'deny-ack')
        self.assertIsNone(out)
        self.assertIn('deny-ack: 1', peer_gate.report(24, self.dir, NOW + 1))

    def test_sessions_are_separate(self):
        self.send('peer-a', session='s1')
        self.assertEqual(self.send('peer-a', at=NOW + 10, session='s2')[0], 'pass')

    def test_report_counts_verdicts(self):
        self.send('peer-a')
        self.send('peer-a', at=NOW + 5)
        text = peer_gate.report(24, self.dir, NOW + 10)
        self.assertIn('2 calls', text)
        self.assertIn('pass: 1', text)
        self.assertIn('deny-cooldown: 1', text)


if __name__ == '__main__':
    unittest.main()
