#!/usr/bin/env python3
"""What the daily run checks before anything leaves the machine or reaches the layer (review of PR #83, 06.11).

- `scan(text)`: personal data and machine paths — e-mail, phone, full Russian name, `/Users/…`, UUID, tokens. A
  file with a finding is refused, never published, never cleaned up by guessing.
- `check_antigens(rows, cases, base_rows)`: an antigen proposal is data only (`antigens.json` rows plus
  `antigen_cases.json` with the commands each one must fire on and stay quiet on). New or changed rows pass a format
  whitelist (`lesson` ≤ 400 characters, one line, no «ignore / bypass»-style wording, no links or tags), a strict
  shape for `id`, `tool` and `memory`, their own cases, and a time limit: the pattern must search 100 KB in under
  50 ms, measured in a child process that is killed after 2 s (a catastrophic pattern cannot hang the run).
- `incident_cut(repo, base)`: the session's view of the day's incidents — subjects of fix commits and command
  templates from the memory notes changed in the last day, with paths, numbers, quoted strings and anything `scan`
  finds replaced by placeholders. The session never reads the notes themselves.
Stdlib only.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

PII = (
    ('email', re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+')),
    ('phone', re.compile(r'(?<![\w.])\+?\d[\d ()-]{9,}\d(?![\w.])')),
    ('name', re.compile(r'\b[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+(?:вич|вна|ична|инична)\b')),
    ('path', re.compile(r'/(?:Users|home)/[\w.-]+')),
    ('uuid', re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I)),
    ('token', re.compile(r'\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|xox[abp]-[\w-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}|'
                         r'[0-9a-f]{40,}|AKIA[0-9A-Z]{16})\b')),
)
LESSON_MAX = 400
LESSON_BANNED = re.compile(
    r'игнорир|обойд|обход|отключ|пропуст|без (?:ревью|проверк|тест)|удали(?:ть)? тест|'
    r'ignore|bypass|override|disable|skip|--no-verify|--force|without (?:review|check|test)|jailbreak', re.I)
LESSON_FORMAT = re.compile(r'https?://|<[a-z/!]|```|\n', re.I)
ID = re.compile(r'^[a-z0-9][a-z0-9-]{2,39}$')
TOOL = re.compile(r'^[A-Za-z_][\w|().*-]{0,79}$')
MEMORY = re.compile(r'^(?:|[\w.-]{1,80}\.md)$')
PATTERN_MS = 50
PATTERN_KB = 100
TIMING = r'''
import json, re, sys, time
pattern = sys.stdin.read()
rx = re.compile(pattern, re.S)
texts = ["a" * 102400, ("git -C /a/b status && npm run test -- --watch=false; " * 2000)[:102400],
         json.dumps({"command": "x" * 102390})]
start = time.perf_counter()
for t in texts:
    rx.search(t)
print(json.dumps({"ms": (time.perf_counter() - start) * 1000 / len(texts)}))
'''


def scan(text):
    """[(kind, sample)] of personal data and machine paths in `text`; [] when clean."""
    found = []
    for kind, rx in PII:
        for m in rx.finditer(text or ''):
            found.append((kind, m.group(0)[:12] + '…'))
    return found


def scrub(text):
    """The text with every `scan` finding replaced by its kind: for the session's input, never for publishing."""
    for kind, rx in PII:
        text = rx.sub('<%s>' % kind, text)
    return text


def pattern_ms(pattern, timeout=2.0):
    """Average milliseconds of one search over 100 KB, in a child process; None when it did not finish."""
    try:
        res = subprocess.run([sys.executable, '-I', '-c', TIMING], input=pattern, capture_output=True, text=True,
                             timeout=timeout)
        return json.loads(res.stdout)['ms'] if res.returncode == 0 else None
    except (subprocess.TimeoutExpired, ValueError, KeyError):
        return None


def check_row(row):
    """Problems of one antigen row's shape and lesson; [] when it passes."""
    problems = []
    if not ID.match(str(row.get('id', ''))):
        problems.append('id must be 3–40 lowercase letters, digits and dashes')
    if not TOOL.match(str(row.get('tool', ''))):
        problems.append('tool must be a tool name pattern')
    if not MEMORY.match(str(row.get('memory', ''))):
        problems.append('memory must be empty or a .md file name')
    lesson = str(row.get('lesson', ''))
    if not lesson or len(lesson) > LESSON_MAX:
        problems.append('lesson must be 1–%d characters' % LESSON_MAX)
    if LESSON_FORMAT.search(lesson):
        problems.append('lesson must be one line without links, tags or code fences')
    if LESSON_BANNED.search(lesson):
        problems.append('lesson has wording that weakens a safeguard (%s)' % LESSON_BANNED.search(lesson).group(0))
    if scan(lesson):
        problems.append('lesson has personal data or a machine path')
    try:
        re.compile(str(row.get('pattern', '')), re.S)
        re.compile(str(row.get('tool', '')))
    except re.error as e:
        problems.append('pattern does not compile: %s' % e)
    return problems


def check_antigens(rows, cases, base_rows=(), timing=pattern_ms):
    """{id: [problem]} for every new or changed row; {} when the proposal may go to a (manually merged) PR."""
    base = {r.get('id'): r for r in base_rows}
    out = {}
    ids = [r.get('id') for r in rows]
    if len(ids) != len(set(ids)):
        out['(table)'] = ['ids are not unique']
    removed = sorted(set(base) - set(ids))
    if removed:
        out['(table)'] = out.get('(table)', []) + ['rows removed: %s — a proposal only adds' % ', '.join(removed)]
    for row in rows:
        if base.get(row.get('id')) == row:
            continue
        problems = check_row(row)
        own = cases.get(row.get('id')) or {}
        fires, quiet = own.get('fires') or [], own.get('quiet') or []
        if not fires or not quiet:
            problems.append('needs at least one case it fires on and one it stays quiet on')
        if not problems:
            rx, tool_rx = re.compile(row['pattern'], re.S), re.compile(row['tool'])
            for case in fires:
                if not (tool_rx.fullmatch(case.get('tool', '')) and rx.search(json.dumps(case.get('input', {}),
                                                                                          ensure_ascii=False))):
                    problems.append('does not fire on %s' % json.dumps(case, ensure_ascii=False)[:80])
            for case in quiet:
                if tool_rx.fullmatch(case.get('tool', '')) and rx.search(json.dumps(case.get('input', {}),
                                                                                    ensure_ascii=False)):
                    problems.append('fires on its quiet case %s' % json.dumps(case, ensure_ascii=False)[:80])
            ms = timing(row['pattern'])
            if ms is None or ms >= PATTERN_MS:
                problems.append('pattern takes %s on %d KB (limit %d ms)' % (
                    'over 2 s' if ms is None else '%.0f ms' % ms, PATTERN_KB, PATTERN_MS))
        if problems:
            out[row.get('id')] = problems
    return out


TEMPLATE = (
    (re.compile(r'"[^"\n]*"|\'[^\'\n]*\''), '"<str>"'),
    (re.compile(r'(?:~|/)[\w.@/-]+'), '<path>'),
    (re.compile(r'\b[0-9a-f]{7,40}\b'), '<sha>'),
    (re.compile(r'\b\d+\b'), '<n>'),
)


def template(command):
    """A command reduced to its shape: `git -C <path> show <sha>:"<str>"`."""
    for rx, repl in TEMPLATE:
        command = rx.sub(repl, command)
    return scrub(command)[:200]


def incident_cut(repo, base, memory_glob='~/.claude/projects/*/memory/feedback_*.md', hours=30):
    """{fix_commits: [subject], command_templates: [[template, count]]} — scrubbed, for the session."""
    out = subprocess.run(['git', '-C', repo, 'log', '--since=%d hours ago' % hours, '--format=%s', base],
                         capture_output=True, text=True)
    subjects = [scrub(s)[:160] for s in out.stdout.splitlines() if re.match(r'(fix|revert)\b', s)]
    counts = {}
    for path in glob.glob(os.path.expanduser(memory_glob)):
        if time.time() - os.path.getmtime(path) > hours * 3600:
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            for command in re.findall(r'`([^`\n]{4,200})`', f.read()):
                shape = template(command)
                counts[shape] = counts.get(shape, 0) + 1
    shapes = sorted(counts.items(), key=lambda kv: -kv[1])[:40]
    return {'fix_commits': subjects[:40], 'command_templates': [list(kv) for kv in shapes]}
