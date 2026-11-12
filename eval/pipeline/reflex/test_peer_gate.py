"""Synthetic-data tests for peer_gate.py (SE-41). No network, no real session state.
Run: python3 -I -m unittest discover -s eval/pipeline/reflex -p 'test_peer_gate.py'
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import peer_gate  # noqa: E402

NOW = 1_800_000_000.0


class PeerGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.mode = os.path.join(self.dir, 'mode.json')
        self.transcript = os.path.join(self.dir, 't.jsonl')
        open(self.transcript, 'w').close()

    def set_mode(self, share5, age=60):
        at = datetime.fromtimestamp(NOW - age).astimezone().isoformat(timespec='minutes')
        with open(self.mode, 'w') as f:
            json.dump({'share5': share5, 'at': at}, f)

    def heard(self, name, ago, address='uds:/tmp/cc-socks/1.sock'):
        text = (f'Another Claude session sent a message:\n<cross-session-message from="{address}" from-name="{name}" '
                f'from-mode="prompting">\nGOAL: x\n</cross-session-message>')
        ts = datetime.fromtimestamp(NOW - ago, timezone.utc).isoformat().replace('+00:00', 'Z')
        with open(self.transcript, 'a') as f:
            f.write(json.dumps({'type': 'user', 'timestamp': ts, 'message': {'role': 'user', 'content': text}}) + '\n')

    def send(self, to, message='RESULT: PR #1 is ready at head abc1234.', at=NOW, session='s1'):
        event = {'session_id': session, 'transcript_path': self.transcript, 'tool_name': 'SendMessage',
                 'tool_input': {'to': to, 'message': message}}
        verdict = peer_gate.decide(event, at, self.dir, self.mode)[0]
        out = peer_gate.respond(event, at, self.dir, self.mode)
        return verdict, out

    def test_trivial_pass(self):
        self.assertEqual(self.send('main')[0], 'pass-trivial')
        self.assertEqual(self.send('peer-a', message='  ')[0], 'pass-trivial')
        self.assertEqual(peer_gate.decide({}, NOW, self.dir, self.mode)[0], 'pass-trivial')

    def test_ack_only_is_denied(self):
        verdict, out = self.send('peer-a', message='Принял, спасибо.')
        self.assertEqual(verdict, 'deny-ack')
        self.assertEqual(out['hookSpecificOutput']['permissionDecision'], 'deny')
        self.assertEqual(self.send('peer-b', message='Ack: is #610 in the chain?')[0], 'pass')
        self.assertEqual(self.send('peer-c', message='OK ' + 'x' * 300)[0], 'pass')

    def test_handoff_receipt_is_denied_unless_urgent(self):
        msg = 'RESULT: plan-6aza-23 is accepted by vpn-spec-b6 (gen 24). The lineage ack follows.'
        self.assertEqual(self.send('pred', message='plan gen 22 accepts handoff plan-21.md. RESULT: ok')[0],
                         'deny-handoff')
        self.assertEqual(self.send('pred', message=msg.replace('is accepted', 'handoff is accepted'))[0],
                         'deny-handoff')
        self.assertEqual(self.send('pred', message='URGENT: handoff accepted, but stop the deploy now.')[0],
                         'pass-urgent')

    def test_cooldown_to_same_recipient(self):
        self.assertEqual(self.send('peer-a', at=NOW)[0], 'pass')
        verdict, out = self.send('peer-a', at=NOW + 300)
        self.assertEqual(verdict, 'deny-cooldown')
        self.assertIn('URGENT:', out['hookSpecificOutput']['permissionDecisionReason'])
        self.assertEqual(self.send('peer-b', at=NOW + 300)[0], 'pass')
        self.assertEqual(self.send('peer-a', at=NOW + 301, message='BLOCKER: the deploy failed.')[0], 'pass-urgent')
        self.assertEqual(self.send('peer-a', at=NOW + 2000)[0], 'pass')

    def test_denied_send_does_not_start_a_cooldown(self):
        self.assertEqual(self.send('peer-a', message='ok')[0], 'deny-ack')
        self.assertEqual(self.send('peer-a', at=NOW + 10)[0], 'pass')

    def test_reply_passes_cooldown(self):
        self.send('hr-helper-v2-81', at=NOW - 400)
        self.heard('hr-helper-v2-81', ago=100)
        self.assertEqual(self.send('hr-helper-v2-81')[0], 'pass-reply')
        self.assertEqual(self.send('hr-helper-v2-81', at=NOW + 60)[0], 'deny-cooldown')

    def test_reply_found_behind_megabytes_of_work(self):
        self.send('peer-a', at=NOW - 400)
        self.heard('peer-a', ago=100)
        with open(self.transcript, 'a') as f:
            for _ in range(2000):
                f.write(json.dumps({'type': 'user', 'message': {'content': 'peer-a ' + 'x' * 1000}}) + '\n')
        self.assertEqual(self.send('peer-a')[0], 'pass-reply')

    def test_reply_by_from_address(self):
        self.send('uds:/tmp/cc-socks/9.sock', at=NOW - 400)
        self.heard('hr-helper-v2-81', ago=100, address='uds:/tmp/cc-socks/9.sock')
        self.assertEqual(self.send('uds:/tmp/cc-socks/9.sock')[0], 'pass-reply')

    def test_old_message_is_not_a_reply(self):
        self.heard('peer-a', ago=2 * 3600)
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
        self.assertIn('6 messages per hour', out['hookSpecificOutput']['permissionDecisionReason'])
        self.assertEqual(self.send('p9', at=NOW + 3601)[0], 'pass')

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
