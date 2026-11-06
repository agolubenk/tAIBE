"""П2: «антиген → урок». PreToolUse hook from the genome.

When a tool call matches a known trap, the lesson goes into the context once
per session; the memory files stay where they are, only MEMORY.md shrinks to
the bio. Table: genome/antigens.json. Silent when nothing matches. It is a hint, not a block: the call runs.
Row keys: id, tool (fullmatch on the tool name), pattern, lesson, memory; optional `field` — the pattern sees only
that string of the input (Bash: the command itself, with real newlines, not its description), otherwise the whole
input as JSON (owner-queue rows look for keys like "cmd"); optional `unless` — a match is dropped when this regex
matches the same text; optional `dormant` — why a row that has not fired lately is kept.
Run: python3 -I antigen.py  (hook JSON on stdin)
"""

import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, '..', 'genome', 'antigens.json')
FLAGS = re.S | re.M


def load_table(path=TABLE):
    with open(path, encoding='utf-8') as f:
        rows = json.load(f)
    return [dict(row, tool_re=re.compile(row['tool']), input_re=re.compile(row['pattern'], FLAGS),
                 unless_re=re.compile(row['unless'], FLAGS) if row.get('unless') else None) for row in rows]


def subject(row, tool_input):
    field = row.get('field')
    if not field:
        return json.dumps(tool_input, ensure_ascii=False)
    value = tool_input.get(field) if isinstance(tool_input, dict) else None
    return value if isinstance(value, str) else ''


def matches(table, tool_name, tool_input):
    hits = []
    for row in table:
        if not row['tool_re'].fullmatch(tool_name):
            continue
        text = subject(row, tool_input)
        if row['input_re'].search(text) and not (row['unless_re'] and row['unless_re'].search(text)):
            hits.append(row)
    return hits


def state_file(session_id, state_dir=None):
    safe = re.sub(r'[^A-Za-z0-9_-]', '_', session_id or 'unknown')
    root = state_dir or os.path.join(tempfile.gettempdir(), 'supertick-antigen')
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, safe)


def fresh_lessons(hits, path):
    seen = set()
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            seen = {line.strip() for line in f}
    new = [row for row in hits if row['id'] not in seen]
    if new:
        with open(path, 'a', encoding='utf-8') as f:
            f.writelines(row['id'] + '\n' for row in new)
    return new


def respond(event, state_dir=None, table=None):
    hits = matches(table or load_table(), event.get('tool_name', ''), event.get('tool_input', {}))
    if not hits:
        return None
    new = fresh_lessons(hits, state_file(event.get('session_id', ''), state_dir))
    if not new:
        return None
    text = ' '.join(f"Урок «{row['id']}»: {row['lesson']}" for row in new)
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'additionalContext': text}}


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    out = respond(event)
    if out:
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
