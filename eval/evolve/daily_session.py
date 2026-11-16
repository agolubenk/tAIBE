#!/usr/bin/env python3
"""The headless session of the daily run and what is published after it (`daily.py session`, `daily.py publish`).

The session (`claude -p`) gets an input file the deterministic code prepares — the run's verdicts as labels and
reasons, the queued artifacts with their diffs, the day's incidents as scrubbed command templates — and may read
only the run's worktree and write only data: cases, `supersedes` lines in `verdicts.jsonl`, antigen rows and their
fire/quiet cases as JSON. Its only commands are two exact checks (`daily.py cases`, `daily.py antigens`). It writes
and runs no code, has no git, no gh, no hub, no MCP. Its last line is the card comment, posted by this code after the
personal-data scan.

`publish` runs nothing the model wrote: it checks the data with `quality.check_cases`, `guard.check_antigens` and
`guard.scan`, refuses what fails, and opens at most two PRs — data (cases, verdicts: may merge by itself) and
antigens (genome: manual merge). Every commit carries the run's trailer and is recorded in `prs.json`, so `merge`
touches only what this run made. A cases file that an open evolve data PR already adds waits for that PR: the
session does not get its queue row, and `publish` refuses it (SE-63). Stdlib only.
"""
import fnmatch
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daily_git as g  # noqa: E402
import daily_steps as steps  # noqa: E402
import guard  # noqa: E402
import quality  # noqa: E402

INPUT = 'eval/evolve/.session/input.json'   # inside the run's worktree; `git clean` removes it next night
CASES = 'eval/evolve/cases/*.jsonl'
VERDICTS = 'eval/evolve/verdicts.jsonl'
ANTIGENS = 'eval/pipeline/genome/antigens.json'
ANTIGEN_CASES = 'eval/pipeline/genome/antigen_cases.json'
MAX_QUEUE = 3
COMMENT_MAX = 600


def allowed_tools():
    """Exact rules: read the worktree, write four data paths, run two exact checks. Nothing else."""
    return ['Read(./**)', 'Edit(./eval/evolve/cases/**)', 'Edit(./%s)' % VERDICTS, 'Edit(./%s)' % ANTIGENS,
            'Edit(./%s)' % ANTIGEN_CASES, 'Bash(python3 -I eval/evolve/daily.py cases)',
            'Bash(python3 -I eval/evolve/daily.py antigens)']


def session_command(prompt):
    return ['claude', '-p', prompt, '--max-turns', str(steps.SESSION_TURNS), '--max-budget-usd',
            steps.SESSION_BUDGET_USD, '--permission-mode', 'dontAsk', '--allowedTools', *allowed_tools(),
            '--disallowedTools', 'Agent', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'NotebookEdit',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks": true}',
            '--no-session-persistence', '--output-format', 'json']


def build_input(wt, report, base):
    """The session's whole view of the night, scrubbed."""
    judged = [v for t in report.get('targets', {}).values() for v in t.get('judged', [])]
    queue = [q for q in report.get('queue', []) if q.get('target') == 'taibe' and not q.get('waits')][:MAX_QUEUE]
    for q in queue:
        q['text'] = guard.scrub(g.file_at(wt, 'HEAD', q['path']) or '')
        q['diff'] = guard.scrub(g.git(wt, 'diff', q['since'], q['head'], '--', q['path'], check=False) or '')[:20000]
    accepted = []
    for v in judged:
        if v.get('status') == 'accepted':
            diff = g.git(wt, 'diff', v['a'], v['b'], '--', v['path'], check=False) or ''
            accepted.append(dict(v, diff=guard.scrub(diff)[:20000]))
    return {'date': report.get('date'), 'verdicts': judged, 'accepted': accepted,
            'calibration': [{k: r.get(k) for k in ('model', 'passed', 'reasons')}
                            for r in (report.get('calibration') or {}).get('rows', [])],
            'queue': queue, 'incidents': guard.incident_cut(wt, 'origin/%s' % steps.BASE),
            'card_already_posted': bool(report.get('card'))}


def comment_from(result_text):
    """(line or None, why): the session's last line, if it is one clean line for the card."""
    lines = [ln.strip() for ln in (result_text or '').strip().splitlines() if ln.strip()]
    if not lines:
        return None, 'no line'
    line = lines[-1]
    if len(line) > COMMENT_MAX:
        return None, 'longer than %d characters' % COMMENT_MAX
    found = guard.scan(line)
    if found:
        return None, 'personal data or paths: %s' % ', '.join(k for k, _ in found)
    return line, 'ok'


def cmd_session(args):
    """The headless Claude session with its own limits (turns, dollars, minutes). Quiet exit (0) when the quota is
    spent or the master switch is off."""
    wt = os.path.join(g.main_repo(HERE), args.worktree)
    report = steps.load_json('runs/latest.json', {})
    if not steps.switch('automation'):
        steps.log('automation is off — no session')
        return 0
    path = os.path.join(wt, INPUT)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(build_input(wt, report, 'origin/%s' % steps.BASE), f, ensure_ascii=False, indent=1)
    with open(os.path.join(HERE, 'daily-prompt.md'), encoding='utf-8') as f:
        prompt = f.read().replace('__INPUT__', INPUT)
    cmd = session_command(prompt)
    if args.dry_run:
        print(json.dumps(cmd[:2] + ['<daily-prompt.md>'] + cmd[3:]))
        return 0
    env = dict(os.environ, WT_DEPS_CHECK='0',
               TAIBE_PIPELINE='successorAuto=off,nerveWakes=off,swarm=off,promptBrief=off,councilReview=off')
    try:
        res = subprocess.run(cmd, cwd=wt, env=env, capture_output=True, text=True,
                             timeout=steps.SESSION_TIMEOUT_MIN * 60)
    except subprocess.TimeoutExpired:
        record_session('timeout', None, 'stopped after %d min' % steps.SESSION_TIMEOUT_MIN)
        steps.log('session: stopped after %d min' % steps.SESSION_TIMEOUT_MIN)
        return 0
    try:
        data = json.loads(res.stdout)
    except ValueError:
        data = None
    data = data if isinstance(data, dict) else {}
    text = (res.stdout or '') + (res.stderr or '')
    if res.returncode != 0 and steps.QUOTA.search(text):
        record_session(res.returncode, data.get('total_cost_usd'), 'quota spent')
        steps.log('session: quota spent — quiet exit')
        return 0
    result = data.get('result', '')
    line, why = comment_from(result)
    posted = steps.post_card(line) if line and not report.get('card') and not args.no_card else 'not posted: %s' % (
        why if not line else 'the run already posted' if report.get('card') else '--no-card')
    record_session(res.returncode, data.get('total_cost_usd'), posted)
    steps.log('session: exit %d, card %s' % (res.returncode, posted))
    return 0


def record_session(exit_code, usd, comment):
    """runs/session-latest.json: the Nerve counts the session as overhead of the 5 h window (SE-66) — no transcript
    has it. Written on every exit after the session started: a timeout or a spent quota also cost dollars, and usd None
    makes the Nerve name the session «без $» instead of dropping it (SE-81)."""
    steps.save_json('runs/session-latest.json', {'exit': exit_code, 'comment': comment, 'usd': usd,
                                                 'finished': datetime.now(timezone.utc).isoformat(timespec='seconds')})


def verdict_lines_ok(base_text, text, run_ids, today_ids):
    """Problems of the new verdicts.jsonl: the base kept byte for byte, new lines only the run's own verdicts or
    `supersedes … brak` lines of today's verdicts."""
    if not text.startswith(base_text):
        return ['lines before this run were changed or removed']
    problems = []
    for n, raw in enumerate(text[len(base_text):].splitlines(), 1):
        if not raw.strip():
            continue
        try:
            v = json.loads(raw)
        except ValueError:
            problems.append('new line %d is not JSON' % n)
            continue
        if v.get('supersedes'):
            if v.get('status') != 'brak' or v['supersedes'] not in today_ids:
                problems.append('new line %d: a review may only mark one of today\'s verdicts brak' % n)
        elif v.get('id') not in run_ids:
            problems.append('new line %d is not a verdict of this run' % n)
    return problems


def cmd_publish(args):
    """Data (cases, verdicts) → one PR that may merge by itself; antigens → one PR for a person. Refuses, with the
    reason in the output, whatever fails a check."""
    repo = g.main_repo(HERE)
    wt = os.path.join(repo, args.worktree)
    report = steps.load_json('runs/latest.json', {})
    run_id = report.get('started', '')
    head = g.git(wt, 'rev-parse', 'HEAD').strip()
    dirty = [ln[3:] for ln in (g.git(wt, 'status', '--porcelain', '--untracked-files=all') or '').splitlines()]
    rows, files = [], {'data': {}, 'antigens': {}}
    run_ids = {v.get('id') for t in report.get('targets', {}).values() for v in t.get('judged', [])}
    open_cases = g.open_data_cases(repo, steps.BASE) if any(fnmatch.fnmatchcase(p, CASES) for p in dirty) else {}
    for p in dirty:
        kind = 'data' if p == VERDICTS or fnmatch.fnmatchcase(p, CASES) else \
            'antigens' if p in (ANTIGENS, ANTIGEN_CASES) else None
        if kind is None:
            if not p.startswith('eval/evolve/.session/'):
                rows.append({'not_published': p, 'why': 'outside what the run publishes'})
            continue
        waits = cases_wait(p, open_cases)
        if waits:
            rows.append({'refused': p, 'why': waits})
            continue
        with open(os.path.join(wt, p), encoding='utf-8') as f:
            text = f.read()
        problems = ['personal data or paths: %s' % ', '.join(sorted({k for k, _ in guard.scan(text)}))] \
            if guard.scan(text) else []
        if fnmatch.fnmatchcase(p, CASES):
            problems += quality.check_cases(os.path.join(wt, p))
        if p == VERDICTS:
            problems += verdict_lines_ok(g.file_at(wt, head, p) or '', text, run_ids, run_ids)
        if problems:
            rows.append({'refused': p, 'why': '; '.join(problems)})
            continue
        files[kind][p] = text
    if files['antigens']:
        problems = antigen_problems(wt, head, files['antigens'])
        if problems:
            rows.append({'refused': 'antigens', 'why': json.dumps(problems, ensure_ascii=False)[:600]})
            files['antigens'] = {}
    date = report.get('date', steps.now().date().isoformat())
    for kind, title in (('data', 'evolve: verdicts and cases of %s' % date),
                        ('antigens', '[manual merge] evolve: antigens proposed %s' % date)):
        if not files[kind]:
            continue
        body = ('The daily evolution run (`eval/evolve/daily.py publish`), %s.\n\nFiles: %s\n\n%s\n\n%s' % (
            date, ', '.join('`%s`' % p for p in sorted(files[kind])), report.get('summary', ''),
            'Merged by the run when its checks are green and evolveAutoMerge is on.' if kind == 'data' else
            '**Manual merge** (genome): an owner or Control decision, never merged by the run.'))
        if args.dry_run:
            rows.append({'would_open': title, 'files': sorted(files[kind])})
            continue
        branch = 'evolve/%s-%s' % (kind, date)
        url = g.open_run_pr(repo, steps.BASE, head, files[kind], branch, title, body, run_id,
                            'data' if kind == 'data' else 'manual')
        rows.append({'pr': url, 'kind': kind})
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


def cases_wait(path, open_cases):
    """Why a cases file is not published now (SE-63), or ''. An open evolve data PR already adds this file: a second
    PR would conflict with it, and merged together they would double the cases. `open_cases` None — GitHub did not
    answer, closed on doubt."""
    if not fnmatch.fnmatchcase(path, CASES):
        return ''
    if open_cases is None:
        return 'GitHub did not list the open evolve PRs — cases are not published on doubt'
    pr = open_cases.get(os.path.basename(path))
    return 'its cases wait for the merge of PR #%s' % pr if pr else ''


def antigen_problems(wt, head, changed):
    """guard.check_antigens on the proposed table against the base's."""
    def load(text, default):
        try:
            return json.loads(text) if text else default
        except ValueError:
            return None
    rows = load(changed.get(ANTIGENS) or g.file_at(wt, head, ANTIGENS), [])
    cases = load(changed.get(ANTIGEN_CASES) or g.file_at(wt, head, ANTIGEN_CASES), {})
    if not isinstance(rows, list) or not isinstance(cases, dict):
        return {'(table)': ['antigens.json must be a list and antigen_cases.json an object']}
    return guard.check_antigens(rows, cases, load(g.file_at(wt, head, ANTIGENS), []) or [])
