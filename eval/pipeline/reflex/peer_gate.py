"""SE-41: budget for peer messages — a PreToolUse hook on SendMessage from the genome.

Every cross-session message wakes the recipient for a full turn at its whole context. Baseline 12.11 11:39 (ccaudit,
24 h): turns started by peer messages are 38 % of all spend (~$296 of ~$775). In the same day, 784 SendMessage calls:
30 % went to the same recipient less than 10 min after the previous one, 10 % were handoff receipts to a predecessor
that its watchdog closes anyway (lineage.py ack).

Rules, in order (the first that applies decides):
1. `to` is "main" (a subagent to its parent) or the message is empty (a pure notify_when_idle subscription) — pass.
2. The first line starts with URGENT: / BLOCKER: / СРОЧНО: — pass (logged, so misuse is visible in `report`).
3. Only an acknowledgement (≤ 200 chars, starts with «принял», «ок», «ack», «thanks» …, no question) — deny.
4. A handoff receipt to the predecessor — deny: the receipt is `lineage.py ack`, the watchdog closes the predecessor.
5. A reply — the recipient wrote to this session after this session last wrote to it, less than 1 h ago — pass.
6. The same recipient got a message from this session less than COOLDOWN ago — deny: merge it into the next one.
7. The session sent CAP messages in the last hour, CAP by the nerve's share5 (mode.json) — deny.
Otherwise pass. Any error — pass (the hook never breaks a call). PEER_GATE=off — pass; PEER_GATE=log — log, never deny.

State: <tmp>/supertick-peer-gate/<session>.jsonl (this session's sends), journal-<YYYY-MM-DD>.jsonl (every verdict).
Run: python3 -I peer_gate.py  (hook JSON on stdin) · python3 -I peer_gate.py report [--hours N]
"""

import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = os.path.join(HERE, '..', '..', 'nerve', 'state', 'mode.json')
STATE = os.path.join(tempfile.gettempdir(), 'supertick-peer-gate')
COOLDOWN = 600
REPLY_WINDOW = 3600
MODE_FRESH = 1200
# (share5 from, messages per hour): below the first band there is no hourly cap.
CAPS = ((0.85, 3), (0.6, 6))
TAIL_BYTES = 16 * 1024 * 1024
URGENT = re.compile(r'^\s*(URGENT|BLOCKER|СРОЧНО)\s*:', re.I)
ACK = re.compile(r'^\W*(принял[аио]?|принято|ок|ok|okay|спасибо|thanks|thank you|received|ack|acknowledged|понял[аио]?'
                 r'|got it|noted|подтверждаю)\b', re.I)
HANDOFF = re.compile(r'accepts? (the )?handoff|handoff\b[^.\n]{0,60}\baccepted|accepted by [\w-]+ \(gen'
                     r'|(приём|принял[аи]?) handoff|подтверждаю приём', re.I)


def deny(reason):
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                   'permissionDecisionReason': reason}}


def hhmm(ts):
    return datetime.fromtimestamp(ts).strftime('%H:%M')


def safe(name):
    return re.sub(r'[^A-Za-z0-9_-]', '_', name or 'unknown')


def read_jsonl(path):
    try:
        with open(path, encoding='utf-8') as f:
            return [json.loads(line) for line in f if line.strip()]
    except (OSError, ValueError):
        return []


def append(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')


def share5(path=MODE, now=None):
    """share5 from the nerve's mode.json; None when the file is missing, broken or older than MODE_FRESH."""
    try:
        with open(path, encoding='utf-8') as f:
            mode = json.load(f)
        at = datetime.fromisoformat(mode['at']).timestamp()
        if (now or time.time()) - at > MODE_FRESH:
            return None
        return float(mode['share5'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def cap_for(s5):
    if s5 is None:
        return None
    for start, cap in CAPS:
        if s5 >= start:
            return cap
    return None


def last_heard(transcript, peer):
    """Time of the last cross-session message from `peer` (its name or its `from` address) in the transcript tail."""
    if not transcript or not peer:
        return None
    try:
        with open(transcript, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            data = f.read()
    except OSError:
        return None
    # One hour of a busy session is several MB of transcript (12.11: 0.7 MB in 8 min) — search bytes, not lines.
    mark = re.compile(rb'from(?:-name)?=\\"' + re.escape(peer.encode('utf-8')) + rb'\\"')
    for m in reversed(list(mark.finditer(data))):
        start = data.rfind(b'\n', 0, m.start()) + 1
        end = data.find(b'\n', m.end())
        line = data[start:end if end >= 0 else len(data)]
        if b'<cross-session-message' not in line:
            continue
        try:
            return datetime.fromisoformat(json.loads(line)['timestamp'].replace('Z', '+00:00')).timestamp()
        except (ValueError, KeyError, TypeError):
            continue
    return None


def decide(event, now=None, state_dir=None, mode_path=MODE):
    """(verdict, reason, hook output or None). verdict: pass | deny-<rule>."""
    now = now or time.time()
    inp = event.get('tool_input') or {}
    to = (inp.get('to') or '').split(' [')[0].strip()
    msg = inp.get('message') or ''
    if to == 'main' or not msg.strip():
        return 'pass-trivial', '', None
    if URGENT.search(msg):
        return 'pass-urgent', '', None
    if len(msg) <= 200 and ACK.search(msg) and '?' not in msg:
        return 'deny-ack', '', deny(
            'Not sent: the message is only an acknowledgement, and each peer message wakes the recipient for a full '
            'turn (SE-41). Do not send it. If you must record a fact, write it to work_state.')
    if HANDOFF.search(msg):
        return 'deny-handoff', '', deny(
            'Not sent: the handoff receipt is `lineage.py ack`, and the watchdog of the predecessor closes it (SE-41). '
            'A message wakes a window at 85 % context. If the predecessor must act, start the first line with URGENT:.')
    sends = read_jsonl(os.path.join(state_dir or STATE, safe(event.get('session_id')) + '.jsonl'))
    mine = [s for s in sends if s.get('to') == to]
    last_to = max((s['ts'] for s in mine), default=0)
    heard = last_heard(event.get('transcript_path'), to)
    if heard and heard > last_to and now - heard < REPLY_WINDOW:
        return 'pass-reply', '', None
    if last_to and now - last_to < COOLDOWN:
        return 'deny-cooldown', '', deny(
            f'Not sent: you wrote to {to} at {hhmm(last_to)}, and each message wakes it for a full turn (SE-41). '
            f'Put this text into your next message to {to} after {hhmm(last_to + COOLDOWN)}. If {to} must act now, '
            f'start the first line with URGENT:.')
    cap = cap_for(share5(mode_path, now))
    hour = [s for s in sends if now - s.get('ts', 0) < 3600]
    if cap is not None and len(hour) >= cap:
        free = hhmm(min(s['ts'] for s in hour) + 3600)
        return 'deny-cap', '', deny(
            f'Not sent: the peer budget is {cap} messages per hour while share5 is high (nerve mode.json), and you '
            f'sent {len(hour)} (SE-41). Write the fact to work_state, or send one merged message after {free}. '
            f'A reply to a message from {to} and a line that starts with URGENT: are not limited.')
    return 'pass', '', None


def respond(event, now=None, state_dir=None, mode_path=MODE):
    now = now or time.time()
    verdict, _, out = decide(event, now, state_dir, mode_path)
    soft = os.environ.get('PEER_GATE') == 'log'
    root = state_dir or STATE
    inp = event.get('tool_input') or {}
    to = (inp.get('to') or '').split(' [')[0].strip()
    append(os.path.join(root, 'journal-' + datetime.fromtimestamp(now).strftime('%Y-%m-%d') + '.jsonl'),
           {'ts': round(now), 'session': event.get('session_id'), 'to': to, 'len': len(inp.get('message') or ''),
            'verdict': verdict, 'soft': soft})
    if out and not soft:
        return out
    if verdict != 'pass-trivial':
        append(os.path.join(root, safe(event.get('session_id')) + '.jsonl'), {'ts': round(now), 'to': to})
    return None


def report(hours=24, state_dir=None, now=None):
    now = now or time.time()
    root = state_dir or STATE
    rows = []
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        if name.startswith('journal-'):
            rows += [r for r in read_jsonl(os.path.join(root, name)) if now - r.get('ts', 0) < hours * 3600]
    count = {}
    for r in rows:
        count[r['verdict']] = count.get(r['verdict'], 0) + 1
    total = len(rows) or 1
    lines = [f'peer_gate, last {hours} h: {len(rows)} calls']
    lines += [f'  {k}: {v} ({100 * v // total} %)' for k, v in sorted(count.items(), key=lambda kv: -kv[1])]
    return '\n'.join(lines)


def main(argv):
    if argv[:1] == ['report']:
        hours = int(argv[argv.index('--hours') + 1]) if '--hours' in argv else 24
        print(report(hours))
        return 0
    if os.environ.get('PEER_GATE') == 'off':
        return 0
    try:
        event = json.load(sys.stdin)
        out = respond(event)
    except Exception:  # the hook never breaks a call
        return 0
    if out:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
