"""П2: «антиген → урок». PreToolUse hook from the genome.

When a tool call matches a known trap, the lesson goes into the context once
per session; the memory files stay where they are, only MEMORY.md shrinks to
the bio. Table: genome/antigens.json. Silent when nothing matches. It is a hint, not a block: the call runs.
Row keys: id, tool (fullmatch on the tool name), pattern, lesson, memory; optional `field` — the pattern sees only
that string of the input (Bash: the command itself, with real newlines, not its description), otherwise the whole
input as JSON (owner-queue rows look for keys like "cmd"); optional `unless` — a match is dropped when this regex
matches the same text; optional `dormant` — why a row that has not fired lately is kept; optional `min_context` — the
row fires only when the last answer's context (transcript tail, `ctx_budget.last_context_tokens`) is at least this many
tokens, read only when such a row matched (d-f63b-economy-0711: ToolSearch in a big window rewrites the whole cache).
`{CMD}` in a pattern is the start of a command: line start, `;` `&&` `|` `(` `$(` backtick, then/do/else, the
string after `bash -c` / `ssh host` / `eval`, then prefixes time/sudo/env/command/nohup/exec/xargs and VAR=x.
Only the first MAX_TEXT characters are matched: the hook has a 10 s timeout, a 100 KB heredoc must not reach it
(review of #82: a backreference row took 9.6 s on 80 KB).
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
MAX_TEXT = 20000
# Quantifiers are bounded and whitespace after a command start is [ \t] only: an unbounded `\S*` or `\s*` from every
# `;` or line start of a 20 KB command is quadratic (100 KB of newlines took 66 s before this).
_WRAP = (r"""\b(?:ba|z|da|k)?sh[ \t]+(?:-[A-Za-z]{1,8}[ \t]+){0,4}-[A-Za-z]{0,8}c[ \t]+["']?"""
         r"""|\bssh[ \t]+(?:-[A-Za-z]{1,8}(?:[ \t]+[^-\s]\S{0,200})?[ \t]+){0,6}[^-\s'"]\S{0,200}[ \t]+["']?"""
         r"""|\beval[ \t]+["']?""")
_SUDO = r"sudo(?:[ \t]+-[A-Za-z]{1,8}(?:[ \t]+[^-\s]\S{0,60})?){0,4}"
_PREFIX = (r"(?:(?:[A-Za-z_]\w{0,60}=\S{0,200}|time|" + _SUDO + r"|command|env|nohup|exec|builtin|noglob|xargs"
           r"|-\S{1,60})[ \t]+){0,8}")
# No backtick start: in these sessions `…` is markdown in heredocs far more often than command substitution.
CMD = r"(?:(?:^|(?<=[;&|(\n{])|\$\(|\b(?:then|do|else|elif)\b)[ \t]*|" + _WRAP + ")" + _PREFIX


def load_table(path=TABLE):
    with open(path, encoding='utf-8') as f:
        rows = json.load(f)
    def rx(p):
        return re.compile(p.replace('{CMD}', CMD), FLAGS)
    return [dict(row, tool_re=re.compile(row['tool']), input_re=rx(row['pattern']),
                 unless_re=rx(row['unless']) if row.get('unless') else None) for row in rows]


def subject(row, tool_input):
    field = row.get('field')
    if not field:
        return json.dumps(tool_input, ensure_ascii=False)
    value = tool_input.get(field) if isinstance(tool_input, dict) else None
    return value if isinstance(value, str) else ''


def context_tokens(event):
    """Context of the last main-chain answer in tokens; None when unknown — a `min_context` row then stays quiet."""
    path = event.get('transcript_path')
    if not path:
        return None
    tools = os.path.normpath(os.path.join(HERE, '..', '..', 'tools'))
    if tools not in sys.path:
        sys.path.insert(0, tools)
    try:
        from pathlib import Path
        from ctx_budget import last_context_tokens
        return last_context_tokens(Path(path))
    except Exception:  # the hook never breaks a call: no reading — no lesson
        return None


def matches(table, tool_name, tool_input, context=None):
    """Rows that fire. `context` — tokens, or a function returning them, called at most once and only for a
    `min_context` row whose pattern matched."""
    hits = []
    for row in table:
        if not row['tool_re'].fullmatch(tool_name):
            continue
        text = subject(row, tool_input)[:MAX_TEXT]
        if not row['input_re'].search(text) or (row['unless_re'] and row['unless_re'].search(text)):
            continue
        if 'min_context' in row:
            if callable(context):
                context = context()
            if (context or 0) < row['min_context']:
                continue
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
    hits = matches(table or load_table(), event.get('tool_name', ''), event.get('tool_input', {}),
                   lambda: context_tokens(event))
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
