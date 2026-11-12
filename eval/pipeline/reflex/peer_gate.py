"""SE-41: budget for peer messages — a PreToolUse hook on SendMessage from the genome.

Every cross-session message wakes the recipient for a full turn at its whole context. Baseline 12.11 11:39 (ccaudit,
24 h): turns started by peer messages are 38 % of all spend (~$296 of ~$775). In the same day, 784 SendMessage calls:
30 % went to the same recipient less than 10 min after the previous one, 10 % were handoff receipts to a predecessor
that its watchdog closes anyway (lineage.py ack).

Rules, in order (the first that applies decides):
1. `to` is "main" (a subagent to its parent) or the message is empty (a pure notify_when_idle subscription) — pass.
2. The first non-empty line starts with URGENT: / BLOCKER: / СРОЧНО: — pass, max URGENT_CAP per hour per session
   (one limit for all three prefixes).
3. Only an acknowledgement (≤ 200 chars, nothing but «принял», «ок», «ack», «thanks» … and punctuation) — deny,
   except an answer to a question: the last message from the recipient (after this session last wrote to it) has «?».
4. A reply — the recipient wrote to this session after this session last wrote to it, less than REPLY_WINDOW ago —
   pass. One message from the peer allows one reply, so the window can be long (a GLM wait is 2 h and more).
5. Only a handoff receipt (≤ 200 chars, the receipt in the first non-empty line, no «?», no #N) — deny: the receipt is
   `lineage.py ack`, the watchdog closes the predecessor.
6. The same recipient got a message from this session less than COOLDOWN ago — deny: merge it into the next one.
7. The session sent CAP new messages in the last hour, CAP by the nerve's share5 (mode.json) — deny. Replies and
   urgent lines do not count here.
Otherwise pass. Any error — pass (the hook never breaks a call). PEER_GATE=off — pass; PEER_GATE=log — log, never deny
(a send that the gate would deny is kept as kind «soft»: it starts a cooldown, the recipient woke, but not the cap).

State: PEER_GATE_DIR or ~/.local/state/taibe/peer-gate: session-<id>.jsonl (this session's sends: the last hour in full,
older — the last send per recipient within REPLY_WINDOW)
and journal-<YYYY-MM-DD>.jsonl (every verdict, kept 30 days). A broken line is skipped and counted in `report`.
Run: python3 -I peer_gate.py  (hook JSON on stdin) · python3 -I peer_gate.py report [--hours N]
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = os.path.join(HERE, '..', '..', 'nerve', 'state', 'mode.json')
STATE = os.environ.get('PEER_GATE_DIR') or os.path.join(os.path.expanduser('~'), '.local', 'state', 'taibe',
                                                        'peer-gate')
COOLDOWN = 600
REPLY_WINDOW = 6 * 3600
MODE_FRESH = 1200
URGENT_CAP = 3
# (share5 from, new messages per hour): below the first band there is no hourly cap.
CAPS = ((0.85, 3), (0.6, 6))
# Transcript tails to search for the peer's last message, smallest first. A busy session writes ~5 MB/h (12.11:
# 0.7 MB in 8 min), so 64 MB covers REPLY_WINDOW; the search stops early when the tail is older than the window.
# Each step reads only the bytes before the previous tail: the worst case reads the largest tail once.
TAILS = (2 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024)
SESSION_MAX_BYTES = 64 * 1024
JOURNAL_DAYS = 30
SESSION_DAYS = 2

URGENT = re.compile(r'^\s*(URGENT|BLOCKER|СРОЧНО)\s*:', re.I)
ACK_WORD = (r'(?:принял[аио]?|принято|окей|ок|ok|okay|спасибо|thanks|thank you|received|ack|acknowledged|понял[аио]?'
            r'|понятно|got it|noted|roger|подтверждаю)')
ACK_ONLY = re.compile(r'[\W_]*' + ACK_WORD + r'(?:[\W_]+' + ACK_WORD + r')*[\W_]*', re.I)
HANDOFF = re.compile(r'accepts? (the )?handoff|handoff\b[^.\n]{0,60}\baccepted|accepted by [\w-]+ \(gen'
                     r'|(приём|принял[аи]?) handoff|подтверждаю приём', re.I)
REF = re.compile(r'#\d')


def deny(reason):
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                   'permissionDecisionReason': reason}}


def hhmm(ts):
    return datetime.fromtimestamp(ts).strftime('%H:%M')


def safe(name):
    return re.sub(r'[^A-Za-z0-9_-]', '_', name or 'unknown')


def session_file(root, event):
    return os.path.join(root, 'session-' + safe(event.get('session_id')) + '.jsonl')


def read_jsonl(path, broken=None):
    """Rows of a JSONL file. A broken line is skipped (not the whole file) and counted in broken[0]."""
    rows = []
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    row = None
                if isinstance(row, dict):
                    rows.append(row)
                elif broken is not None:
                    broken[0] += 1
    except OSError:
        pass
    return rows


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


def oldest_stamp(data, lines=50):
    """Time of the first full transcript line with a `timestamp` field (the tail starts mid-line); None when the first
    `lines` full lines have none."""
    pos = data.find(b'\n') + 1
    for _ in range(lines):
        if not pos or pos >= len(data):
            return None
        end = data.find(b'\n', pos)
        line = data[pos:end if end >= 0 else len(data)]
        pos = end + 1 if end >= 0 else 0
        try:
            row = json.loads(line)
            if isinstance(row, dict) and isinstance(row.get('timestamp'), str):
                return datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00')).timestamp()
        except ValueError:
            continue
    return None


def find_heard(data, mark, limit, since, width):
    """(time, asked) of the last marked cross-session message whose mark starts before `limit` in `data`; False when
    the newest such message is not newer than `since`; None when there is none. `width` — the longest mark in bytes:
    a mark that starts before `limit` may end after it."""
    for m in reversed(list(mark.finditer(data, 0, min(len(data), limit + width)))):
        if m.start() >= limit:
            continue
        start = data.rfind(b'\n', 0, m.start()) + 1
        end = data.find(b'\n', m.end())
        line = data[start:end if end >= 0 else len(data)]
        if b'<cross-session-message' not in line:
            continue
        try:
            at = datetime.fromisoformat(json.loads(line)['timestamp'].replace('Z', '+00:00')).timestamp()
        except (ValueError, KeyError, TypeError):
            continue
        if at <= since:
            return False
        close = data.find(b'</cross-session-message>', m.end(), start + len(line))
        return at, b'?' in data[m.end():close if close >= 0 else start + len(line)]
    return None


def last_heard(transcript, peer, since=0, tails=TAILS):
    """(time, asked) of the last cross-session message from `peer` (its name or its `from` address) newer than `since`,
    or None. `asked` — the message has «?». Reads the smallest tail that holds it or that is older than `since`."""
    if not transcript or not peer:
        return None
    name = peer.encode('utf-8')
    mark = re.compile(rb'from(?:-name)?=\\"' + re.escape(name) + rb'\\"')
    width = len(name) + 16
    try:
        with open(transcript, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            data, done = b'', size
            for tail in tails:
                start = max(0, size - tail)
                if start >= done:
                    continue
                f.seek(start)
                chunk = f.read(done - start)
                done = start
                # Marks that start in the new chunk; their lines may run into the bytes already read.
                data = chunk + data
                found = find_heard(data, mark, len(chunk), since, width)
                if found is not None:
                    return found or None
                oldest = oldest_stamp(data)
                if start == 0 or (oldest is not None and oldest <= since):
                    return None
    except OSError:
        return None
    return None


def decide(event, now=None, state_dir=None, mode_path=MODE):
    """(verdict, reason, hook output or None). verdict: pass | pass-<why> | deny-<rule>."""
    now = now or time.time()
    inp = event.get('tool_input') or {}
    to = (inp.get('to') or '').split(' [')[0].strip()
    msg = inp.get('message') or ''
    if to == 'main' or not msg.strip():
        return 'pass-trivial', '', None
    sends = read_jsonl(session_file(state_dir or STATE, event))
    hour = [s for s in sends if now - s.get('ts', 0) < 3600]
    if URGENT.search(msg):
        urgent = [s for s in hour if s.get('kind') == 'urgent']
        if len(urgent) < URGENT_CAP:
            return 'pass-urgent', '', None
        free = hhmm(min(s['ts'] for s in urgent) + 3600)
        return 'deny-urgent', '', deny(
            f'Not sent: you sent {len(urgent)} urgent messages in the last hour, and the limit is {URGENT_CAP} (SE-41). '
            f'Remove the urgent prefix and send a usual message, or send it after {free}.')
    last_to = max((s.get('ts', 0) for s in sends if s.get('to') == to), default=0)
    since = max(last_to, now - REPLY_WINDOW)
    heard = last_heard(event.get('transcript_path'), to, since)
    if len(msg) <= 200 and ACK_ONLY.fullmatch(msg) and not (heard and heard[1]):
        return 'deny-ack', '', deny(
            'Not sent: the message is only an acknowledgement, and each peer message wakes the recipient for a full '
            'turn (SE-41). Do not send it. If you agree to a request, write what you agree to (for example «ok, merge '
            '#132»). Write other facts to work_state.')
    if heard:
        return 'pass-reply', '', None
    first = msg.strip().split('\n', 1)[0]
    if len(msg) <= 200 and HANDOFF.search(first) and '?' not in msg and not REF.search(msg):
        return 'deny-handoff', '', deny(
            'Not sent: the message is only a handoff receipt. The receipt is `lineage.py ack`, and the watchdog of the '
            'predecessor closes it (SE-41). If the recipient must act, write the action and the PR or card number.')
    if last_to and now - last_to < COOLDOWN:
        return 'deny-cooldown', '', deny(
            f'Not sent: you wrote to {to} at {hhmm(last_to)}, and each message wakes it for a full turn (SE-41). '
            f'Put this text into your next message to {to} after {hhmm(last_to + COOLDOWN)}, or write it to '
            f'work_state.')
    cap = cap_for(share5(mode_path, now))
    new = [s for s in hour if s.get('kind', 'pass') == 'pass']
    if cap is not None and len(new) >= cap:
        free = hhmm(min(s['ts'] for s in new) + 3600)
        return 'deny-cap', '', deny(
            f'Not sent: the peer budget is {cap} new messages per hour while share5 is high (nerve mode.json), and you '
            f'sent {len(new)} (SE-41). Write the fact to work_state, or send one merged message after {free}. '
            f'A reply to a message from {to} does not count in this budget.')
    return 'pass', '', None


def prune(root, now):
    """Remove journals older than JOURNAL_DAYS and session files idle for SESSION_DAYS. Runs once a day."""
    oldest = (datetime.fromtimestamp(now) - timedelta(days=JOURNAL_DAYS)).strftime('%Y-%m-%d')
    for name in os.listdir(root):
        path = os.path.join(root, name)
        try:
            if name.startswith('journal-'):
                if name[8:18] < oldest:
                    os.remove(path)
            elif name.startswith('session-') and now - os.path.getmtime(path) > SESSION_DAYS * 86400:
                os.remove(path)
        except OSError:
            continue


def keep_recent(path, now):
    """Compact a session file over SESSION_MAX_BYTES: the last hour in full (cap, urgent), older rows — only the last
    send per recipient within REPLY_WINDOW (cooldown, reply). The result is far below the threshold, so the file is
    not rewritten again on the next call."""
    try:
        if os.path.getsize(path) <= SESSION_MAX_BYTES:
            return
    except OSError:
        return
    rows = read_jsonl(path)
    recent = [r for r in rows if now - r.get('ts', 0) < 3600]
    last = {}
    for r in rows:
        if 3600 <= now - r.get('ts', 0) < REPLY_WINDOW and r.get('ts', 0) >= last.get(r.get('to'), {}).get('ts', 0):
            last[r.get('to')] = r
    keep = sorted(last.values(), key=lambda r: r.get('ts', 0)) + recent
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + '\n' for r in keep)
    os.replace(tmp, path)


def respond(event, now=None, state_dir=None, mode_path=MODE):
    now = now or time.time()
    verdict, _, out = decide(event, now, state_dir, mode_path)
    soft = os.environ.get('PEER_GATE') == 'log'
    root = state_dir or STATE
    inp = event.get('tool_input') or {}
    to = (inp.get('to') or '').split(' [')[0].strip()
    journal = os.path.join(root, 'journal-' + datetime.fromtimestamp(now).strftime('%Y-%m-%d') + '.jsonl')
    new_day = not os.path.exists(journal)
    append(journal, {'ts': round(now), 'session': event.get('session_id'), 'to': to,
                     'len': len(inp.get('message') or ''), 'verdict': verdict, 'soft': soft})
    if new_day:
        prune(root, now)
    if out and not soft:
        return out
    if verdict != 'pass-trivial':
        kind = 'soft' if out else {'pass-reply': 'reply', 'pass-urgent': 'urgent'}.get(verdict, 'pass')
        path = session_file(root, event)
        append(path, {'ts': round(now), 'to': to, 'kind': kind})
        keep_recent(path, now)
    return None


def report(hours=24, state_dir=None, now=None):
    now = now or time.time()
    root = state_dir or STATE
    first = (datetime.fromtimestamp(now - hours * 3600)).strftime('%Y-%m-%d')
    rows, broken = [], [0]
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        if name.startswith('journal-') and name[8:18] >= first:
            rows += [r for r in read_jsonl(os.path.join(root, name), broken) if now - r.get('ts', 0) < hours * 3600]
        elif name.startswith('session-'):
            path = os.path.join(root, name)
            try:
                fresh = now - os.path.getmtime(path) < hours * 3600
            except OSError:
                fresh = False
            if fresh:
                read_jsonl(path, broken)
    count = {}
    for r in rows:
        count[r.get('verdict', '?')] = count.get(r.get('verdict', '?'), 0) + 1
    total = len(rows) or 1
    lines = [f'peer_gate, last {hours} h: {len(rows)} calls']
    lines += [f'  {k}: {v} ({100 * v // total} %)' for k, v in sorted(count.items(), key=lambda kv: -kv[1])]
    if broken[0]:
        lines.append(f'  broken lines skipped: {broken[0]} (state {root})')
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
