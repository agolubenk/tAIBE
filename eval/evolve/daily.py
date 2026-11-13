#!/usr/bin/env python3
"""The daily evolution run: blind A/B of what changed in the layer since the last run, quality control that marks
false positives as brak, and corrections that only an accepted verdict may start (owner, 06.11: once a day, by
itself, «ложноположительные результаты — брак»). The judges are Claude models only (owner decision 06.11).

    bash eval/evolve/daily.sh run                    # launchd at 05:00: `nightly` (lock → merge → refresh → cycle)
    python3 -I eval/evolve/daily.py cycle [--force]  # run → session → publish → merge
    python3 -I eval/evolve/daily.py run [--target taibe|hr|all] [--since REV] [--judges claude:m1,claude:m2]
                                        [--no-pr] [--dry-run]
    python3 -I eval/evolve/daily.py session|publish|merge [--dry-run]
    python3 -I eval/evolve/daily.py status | cases [FILE…] | antigens

`run` refreshes its own worktree (`worktrees/evolve/daily`, detached on a fresh `origin/board-agents`; nobody's
checkout is touched), runs `catalog.py` and `dupes.py`, and takes the layer files changed since the last run
(`~/.claude/evolve/state.json`). For each one with cases (`cases/*.jsonl`, naming below) it judges the version
before its last edit against the current one. Judges: `--judges`, else the Claude candidates (`judges.py`) when
`abJudgeClaude` is on — the board, closed on doubt, or the owner's file `~/.claude/evolve/abJudgeClaude.on`. They are
calibrated first; with fewer than two that pass, nothing is judged and the artifacts stay pending. Artifacts are
judged one at a time by every judge, at most `resources.MAX_ARTIFACTS` a night, and only while the night's budget
covers the whole artifact. Every verdict passes `quality.py`. An accepted loss opens a revert PR of that edit; an
accepted win is pinned in `verdicts.jsonl`; brak and insufficient verdicts are written there as well and never act.
The state moves to head only when nothing is pending. No model, gateway or Ollama is started.

`session` is a headless Claude session (`daily_session.py`), `publish` opens the run's PRs, `merge` is the only step
that merges (`daily_git.merge_ready`; sessions keep their merge-guard). Stdlib only.

Cases per artifact: `.claude/skills/<n>/SKILL.md` → `cases/<n>.jsonl`; `.claude/rules/<f>.md` → `cases/rule-<f>.jsonl`;
agents, commands, prompts → `agent-`, `command-`, `prompt-<f>.jsonl`; a role card → `card-<dir with ->.jsonl`.
"""
import argparse
import glob
import hashlib
import subprocess
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab  # noqa: E402
import catalog  # noqa: E402
import daily_git as g  # noqa: E402
import daily_session as session  # noqa: E402
import daily_steps as steps  # noqa: E402
import judges as judging  # noqa: E402
from daily_steps import STATE_DIR, load_json, log, now, save_json, switch  # noqa: E402,F401
import quality  # noqa: E402
import resources  # noqa: E402

WORKTREE = 'worktrees/evolve/daily'
TARGETS = {
    'taibe': {'base': steps.BASE, 'auto_merge': True},
    'hr': {'base': 'main', 'auto_merge': False,
           'repo': os.path.expanduser(os.environ.get('EVOLVE_HR_REPO') or '~/Desktop/Development/HR_Helper-v2')},
}
AB_KINDS = ('skill', 'rule', 'agent', 'command', 'prompt', 'card')  # text instructions; hooks and genome are code
NIGHT = (3, 8)            # a scheduled run spends model time only between 03:00 and 08:00 local
DEADLINE_MIN = 180        # judging stops after 3 hours; what is left waits for the next night
UNKNOWN_PRS = 'open evolve PRs unknown'  # `waits` of a queue row when GitHub did not answer (SE-63)


def cases_path(path, cases_dir=os.path.join(HERE, 'cases')):
    parts = path.split('/')
    stem = os.path.splitext(parts[-1])[0]
    if parts[:2] == ['.claude', 'skills']:
        name = parts[2]
    elif parts[:2] in (['.claude', 'rules'], ['.claude', 'agents'], ['.claude', 'commands']):
        name = '%s-%s' % (parts[1].rstrip('s'), stem)
    elif parts[-1] == 'CLAUDE.md':
        name = 'card-%s' % ('-'.join(parts[:-1]) or 'root')
    else:
        name = 'prompt-%s' % stem
    return os.path.join(cases_dir, name + '.jsonl')


# --- plan and judge ----------------------------------------------------------------------------------------------

def last_edit_base(repo, since, head, path):
    """The parent of the last commit in (since, head] that changed `path`: A is the version just before the latest
    edit, so a lost A/B reverts that edit only, not everything the window holds."""
    last = g.git(repo, 'log', '-1', '--format=%H', '%s..%s' % (since, head), '--', path, check=False)
    return '%s^' % last.strip() if last and last.strip() else since


def plan(target, repo, since, head, cases_dir, pending=()):
    """(items to judge, items that need cases, notes) for the files changed between two revisions, plus the ones a
    previous night ran out of time for (`pending`: {path, a}), each against its own baseline."""
    items, need, notes = [], [], []
    changed = g.changed_files(repo, since, head)
    pairs = [(p, last_edit_base(repo, since, head, p)) for p in changed] + \
        [(p['path'], p['a']) for p in pending if p['path'] not in changed]
    for path, since in pairs:
        kind = catalog.kind_of(path, 'eval')
        if kind not in AB_KINDS:
            continue
        a, b = g.file_at(repo, since, path), g.file_at(repo, head, path)
        if b is None:
            notes.append('%s removed — nothing to judge' % path)
        elif not os.path.isfile(cases_path(path, cases_dir)):
            need.append({'target': target, 'path': path, 'kind': kind, 'since': g.short(repo, since),
                         'head': g.short(repo, head), 'cases': os.path.relpath(cases_path(path, cases_dir), HERE)})
        elif a is None:
            notes.append('%s is new — no previous version to judge against' % path)
        elif a != b:
            items.append({'target': target, 'path': path, 'a': g.short(repo, since), 'b': g.short(repo, head),
                          'b_blob': g.blob_of(repo, head, path), 'text_a': a, 'text_b': b,
                          'cases': cases_path(path, cases_dir)})
    return items, need, notes


def item_cost(it, n_judges):
    """(calls, tokens) one artifact costs with `n_judges` judges, estimated before it starts: canaries, every case
    and the repeat, both orders, each call at the size of the largest prompt (the length probe)."""
    cases, _ = quality.read_cases(it['cases'])
    asks = len(quality.canary_cases(cases)) + len(cases) + max(1, -(-len(cases) // 3))
    calls = 2 * asks * n_judges
    per_call = judging.call_estimate(None, '') + quality.largest_prompt_tokens(cases, it['text_a'], it['text_b'])
    return calls, calls * per_call


def judge(items, judges, factory, budget, deadline):
    """(verdicts, pending): item by item, every judge on the item before the next one starts. An item starts only
    when the budget covers it for all judges; one that does not fit, or comes after MAX_ARTIFACTS, stays pending."""
    run, judged, pending = {j: {} for j in judges}, [], []
    calls = {j: factory(j) for j in judges}
    for it in items:
        cost = item_cost(it, len(judges))
        if len(judged) >= resources.MAX_ARTIFACTS or time.time() > deadline or not budget.covers(*cost):
            pending.append(it)
            log('pending %s: %s' % (it['path'], 'artifact limit' if len(judged) >= resources.MAX_ARTIFACTS else
                                    'out of time' if time.time() > deadline else
                                    'budget does not cover %d calls / %d tokens' % cost))
            continue
        cases, canaries = quality.read_cases(it['cases'])
        for j in judges:
            log('judge %s · %s · %d cases' % (j, it['path'], len(cases)))
            run[j][it['path']] = quality.judge_artifact(calls[j], cases, it['text_a'], it['text_b'], canaries)
        judged.append(it)
    final = quality.finalize({j: by_path for j, by_path in run.items()})
    verdicts = []
    for it in judged:
        per = [(j, final[j][it['path']]) for j in judges]
        status, reasons, pick = quality.combine(per)
        verdicts.append(verdict_line(it, status, reasons, pick, [(j, run[j][it['path']], final[j][it['path']])
                                                                 for j in judges]))
    return verdicts, pending


def verdict_line(it, status, reasons, pick, per_judge):
    date = now().date().isoformat()
    key = '|'.join((date, it.get('run', ''), it['target'], it['path'], it['a'], it['b']))
    vid = hashlib.sha1(key.encode()).hexdigest()[:12]
    judges = []
    for model, judged, (j_status, j_reasons, j_pick) in per_judge:
        wins_a, wins_b, broken = quality.tally(judged)
        real = judged.get('results', [])
        judges.append({'model': model, 'status': j_status, 'reasons': j_reasons, 'pick': j_pick,
                       'wins_a': wins_a, 'wins_b': wins_b, 'broken': broken,
                       'ties': len(real) - wins_a - wins_b - broken,
                       'swap_disagree': sum(not r['consistent'] for r in real if r['winner'] != 'broken'),
                       'answers': [[r['id'], r['first'], r['second'], r['winner']] for r in real],
                       'canaries': [[c['kind'], c['want'], c['got'], c['ok']] for c in judged.get('canaries', [])],
                       'repeat': [[r['id'], r['was'], r['now']] for r in judged.get('repeat', [])]})
    first = per_judge[0][1] if per_judge else {}
    return {'id': vid, 'date': date, 'target': it['target'], 'path': it['path'], 'a': it['a'], 'b': it['b'],
            'mode': 'instructions', 'judge': 'daily:' + '+'.join(m for m, _, _ in per_judge),
            'status': status, 'reasons': reasons, 'pick': pick,
            'action': 'revert' if status == 'accepted' and pick == 'a' else 'pin' if status == 'accepted' else 'none',
            'cases': first.get('cases', 0), 'tokens_a': first.get('tokens_a', 0), 'tokens_b': first.get('tokens_b', 0),
            'judges': judges}


def no_judge_line(it, calibration):
    """A night with fewer than two calibrated judges: insufficient, nothing acts, the artifact stays pending."""
    tried = ', '.join('%s (%s)' % (r['model'], r['reasons'][0][:80]) for r in calibration['rows'])
    why = 'no judge: %d of %d candidates passed calibration (need %d) — %s' % (
        len(calibration['passed']), len(calibration['rows']), judging.WANT_JUDGES, tried or 'no candidates')
    v = verdict_line(it, 'insufficient', [why], None, [])
    v['calibration'] = [r['model'] for r in calibration['rows']]
    return v


def judge_names(args, code_root):
    """(names, why): tonight's candidates — `--judges` (the owner's own run), else the Claude candidates when
    `abJudgeClaude` is on. Only `claude:<model>` ids: local models are never started (owner rule 06.11)."""
    if args.judges:
        names = [j.strip() for j in args.judges.split(',') if j.strip()]
        bad = [j for j in names if not judging.is_claude(j)]
        if bad:
            return [], 'only Claude judges (owner decision 06.11), refused: %s' % ', '.join(bad)
        return names, 'given by --judges'
    if not steps.claude_judges_on(code_root):
        return [], 'abJudgeClaude is off (board, or the file ~/.claude/evolve/%s)' % steps.CLAUDE_OVERRIDE
    return judging.candidates(True), 'abJudgeClaude on'


def calibrate_judges(args, wt, deadline, names):
    """{candidates, passed, rows}: the candidates calibrated in turn until two pass."""
    with open(os.path.join(wt, judging.CALIBRATION_ARTIFACT), encoding='utf-8') as f:
        text = f.read()
    cases, _ = quality.read_cases(args.calibration_cases)
    factory = args.factory or judge_factory(args.budget)
    passed, rows = judging.select(names, factory, cases, text, log=log, stop=lambda: time.time() > deadline)
    return {'candidates': names, 'passed': passed, 'rows': rows}


def judge_factory(budget):
    """Every `claude:<model>` id → `judges.claude_call` with that model and the night's budget."""
    def factory(name):
        if not judging.is_claude(name):
            raise ValueError('not a Claude judge: %s' % name)
        return judging.claude_call(budget, model=judging.model_of(name))
    return factory


def revert(repo, target, v, text_a, no_pr, run_id=''):
    """An accepted loss of the merged version: a PR that puts back the version before the losing edit. A skill or a
    prompt (not a lens) is in the safe class and may merge by itself; anything else, and all of HR, waits for a
    person. Nothing is opened when the file changed again since the verdict."""
    cfg = TARGETS[target]
    head = g.git(repo, 'rev-parse', 'origin/%s' % cfg['base']).strip()
    if g.blob_of(repo, head, v['path']) != g.blob_of(repo, v['b'], v['path']):
        return 'not opened: %s changed again since %s' % (v['path'], v['b'])
    safe = cfg['auto_merge'] and g.matches(v['path'], g.REVERT_PATHS) and not g.matches(v['path'], g.MANUAL_ONLY)
    title = '%sevolve: revert %s to %s (A/B: the previous version wins)' % (
        '' if safe else '[manual merge] ', v['path'], v['a'])
    body = ('The daily evolution run judged the version of `%s` before its last edit (%s) better than the merged one '
            '(%s).\n\nStatus: **accepted** — %s.\n\n```json\n%s\n```\n\n%s\nevolve-verdict: %s\n'
            % (v['path'], v['a'], v['b'], '; '.join(v['reasons']), json.dumps(v, ensure_ascii=False, indent=1)[:6000],
               'Safe class (a revert to a version already in the base): merged by the run when checks are green, '
               'required checks exist and evolveAutoMerge is on.' if safe else
               '**Manual merge**: an owner or Control decision, never merged by the run.', v['id']))
    if no_pr:
        return 'not opened (--no-pr)'
    expected = {v['path']: {'blob': g.blob_of(repo, v['a'], v['path']),
                            'from': g.git(repo, 'rev-parse', v['a']).strip()}}
    return g.open_run_pr(repo, cfg['base'], head, {v['path']: text_a}, 'evolve/revert-%s-%s' % (v['id'], v['date']),
                         title, body, run_id, 'revert' if safe else 'manual', expected)


def cmd_run(args):
    code_root = os.path.abspath(os.path.join(HERE, '..', '..'))
    repo = g.main_repo(code_root)
    started, deadline = now(), time.time() + args.deadline_min * 60
    report = {'date': started.date().isoformat(), 'started': started.isoformat(timespec='seconds'), 'targets': {}}
    state, queue = load_json('state.json', {}), load_json('queue.json', [])
    queue = [q for q in queue if not os.path.isfile(os.path.join(HERE, q['cases']))]  # cases written since
    ab_on = switch('abJudge', code_root) and switch('automation', code_root)
    names, names_why = judge_names(args, code_root) if ab_on else ([], 'abJudge or automation is off')
    report['judges'] = {'candidates': names, 'why': names_why}
    calibration, posted = None, False
    for target in (TARGETS if args.target == 'all' else [args.target]):
        cfg = TARGETS[target]
        trepo = cfg.get('repo') or repo
        if not os.path.isdir(os.path.join(trepo, '.git')):
            report['targets'][target] = {'skipped': 'no repository at %s' % trepo}
            continue
        if target == 'taibe':
            head = g.refresh_worktree(trepo, args.worktree, cfg['base'])
            report['metrics'] = steps.layer_metrics(os.path.join(trepo, args.worktree))
            line = steps.audit_line(report['metrics'].get('context_audit'), report['date'])
            if line and not args.dry_run and not args.no_card:  # d-f63b-economy-0711: the owner sees the measure
                report['audit_card'] = steps.post_card(line)
        else:
            head = g.fetch(trepo, cfg['base'])
        old = state.get(target) or {}
        since = args.since or old.get('rev') or g.since_day_ago(trepo, cfg['base'])
        if g.git(trepo, 'rev-parse', '--verify', '--quiet', since + '^{commit}', check=False) is None:
            report['targets'][target] = {'skipped': 'no revision %s here' % since}
            continue
        items, need, notes = plan(target, trepo, since, head, args.cases, [] if args.since else old.get('pending', []))
        done = {} if args.since else dict(old.get('judged') or {})
        items = [it for it in items if done.get(it['path']) != it['b_blob']]  # judged at this version already
        t = {'since': g.short(trepo, since), 'head': g.short(trepo, head), 'judged': [], 'need_cases': len(need),
             'notes': notes}
        known = {(q['target'], q['path']) for q in queue}
        queue += [q for q in need if (q['target'], q['path']) not in known]
        pending = []
        if args.dry_run:
            t['judged'] = [{'path': it['path'], 'a': it['a'], 'b': it['b'], 'status': 'dry-run'} for it in items]
        elif items and not names:
            pending = items
            t['judged'] = [{'path': it['path'], 'status': 'skipped: %s' % names_why} for it in items]
        elif items:
            for it in items:
                it['run'] = report['started']
            if calibration is None:
                calibration = calibrate_judges(args, os.path.join(repo, args.worktree), deadline, names)
                report['calibration'] = calibration
            passed = calibration['passed'][:judging.WANT_JUDGES]
            if len(passed) >= judging.WANT_JUDGES:
                verdicts, pending = judge(items, passed, args.factory or judge_factory(args.budget), args.budget,
                                          deadline)
            else:  # fewer than two judges: a verdict could never be accepted — no A/B, the artifacts stay pending
                verdicts, pending = [no_judge_line(it, calibration) for it in items], list(items)
                if not posted and not args.no_card:
                    posted = steps.post_card('evolve %s: нет годного судьи — калибровку прошли %d из %d кандидатов '
                                             '(нужно 2: %s); A/B не выполнен, корректировок нет, артефакты ждут.' % (
                                                 report['date'], len(calibration['passed']), len(calibration['rows']),
                                                 ', '.join(r['model'] for r in calibration['rows']) or 'нет'))
                    report['card'] = posted
            by_path = {it['path']: it for it in items}
            for v in verdicts:
                it = by_path[v['path']]
                if v['judges'] and all(any('unavailable' in r for r in j['reasons']) for j in v['judges']):
                    pending.append(it)  # judges chosen but none reached: no verdict line, the report has it
                    t['judged'].append({'path': it['path'], 'status': 'not measured', 'reasons': v['reasons']})
                    continue
                if any(any('unavailable' in r for r in j['reasons']) for j in v['judges']):
                    pending.append(it)  # one judge not reached (limit, budget, error): measured again next night
                if v['action'] == 'revert':
                    try:
                        v['pr'] = revert(trepo, target, v, it['text_a'], args.no_pr, report['started'])
                    except Exception as e:  # noqa: BLE001 — the verdict is kept, the PR is retried by hand
                        v['pr'] = 'failed: %s' % e
                with open(args.verdicts, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(v, ensure_ascii=False) + '\n')
                if it not in pending:
                    done[it['path']] = it['b_blob']
                t['judged'].append({k: v.get(k) for k in ('id', 'path', 'a', 'b', 'status', 'pick', 'action', 'pr',
                                                          'reasons')})
            t['pending'] = sorted({it['path'] for it in pending})
        # State moves to head only when nothing is pending; a pending artifact keeps the night's baseline.
        if not args.dry_run and not args.keep_state:
            late = list({it['path']: {'path': it['path'], 'a': it['a']} for it in pending}.values())
            state[target] = {'rev': since if late else head, 'date': report['date'], 'pending': late,
                             'judged': done}
        report['targets'][target] = t
    report['budget'] = args.budget.report()
    mark_waiting(queue, g.open_data_cases(repo, steps.BASE) if queue else {})
    report['queue'] = queue
    report['finished'] = now().isoformat(timespec='seconds')
    report['summary'] = summary(report)
    if not args.dry_run:
        save_json('state.json', state)
        save_json('queue.json', queue)
        save_json('runs/%s.json' % report['date'], report)
        save_json('runs/latest.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


def mark_waiting(queue, open_cases):
    """SE-63: a queue row whose cases file an open evolve data PR already adds gets `waits` — the session skips it
    until that PR is merged (its file then exists, and the row leaves the queue) or closed (the row is free again).
    `open_cases` None (GitHub did not answer): every row waits, closed on doubt."""
    for q in queue:
        name = os.path.basename(q['cases'])
        if open_cases is None:
            q['waits'] = UNKNOWN_PRS
        elif name in open_cases:
            q['waits'] = 'PR #%s' % open_cases[name]
        else:
            q.pop('waits', None)


def summary(report):
    counts = {}
    for t in report['targets'].values():
        for v in t.get('judged', []):
            counts[v['status']] = counts.get(v['status'], 0) + 1
    shown = ', '.join('%s %d' % kv for kv in sorted(counts.items())) or 'nothing changed with cases'
    queue = report.get('queue', [])
    waiting = [q['waits'] for q in queue if q.get('waits')]
    if not waiting:
        tail = ''
    elif UNKNOWN_PRS in waiting:  # one run marks every row the same way (mark_waiting)
        tail = '; cases of %d wait: GitHub did not list the open evolve PRs' % len(waiting)
    else:
        tail = '; cases of %d wait for the merge of %s' % (len(waiting), ', '.join(sorted(set(waiting))))
    return 'evolve %s: A/B %s; cases needed for %d artifacts%s' % (report['date'], shown,
                                                                    len(queue) - len(waiting), tail)


def merge_switch(root, override=None):
    """evolveAutoMerge: the board (closed on doubt) or the owner's file `~/.claude/evolve/evolveAutoMerge.on`."""
    return steps.auto_merge_on(root, override)


def cmd_merge(args):
    code_root = os.path.abspath(os.path.join(HERE, '..', '..'))
    repo = g.main_repo(code_root)
    verdicts = []
    if os.path.isfile(args.verdicts):
        with open(args.verdicts, encoding='utf-8') as f:
            verdicts = [json.loads(ln) for ln in f if ln.strip()]
    verdicts = steps.with_kept_supersedes(verdicts)  # the brak marks a refresh wiped from the worktree
    enabled = merge_switch(code_root)
    rows = g.merge_ready(repo, TARGETS['taibe']['base'], verdicts, enabled, load_json('prs.json', {}), args.dry_run)
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


def cmd_cycle(args):
    """run → session → publish → merge under the one lock (handed over by `nightly`, or taken here)."""
    hour = now().hour
    if not args.force and not NIGHT[0] <= hour < NIGHT[1]:
        log('outside the night window %02d:00–%02d:00 — waits for the next night (--force to run now)' % NIGHT)
        return 0
    try:
        with resources.Lock(os.path.join(STATE_DIR, 'run.lock'), args.lock_fd):
            if not resources.wait_for_heavy(log):
                log('another heavy job is still running — the night is skipped')
                return 0
            for step in (cmd_run, session.cmd_session, session.cmd_publish, cmd_merge):
                try:
                    step(args)
                except Exception as e:  # noqa: BLE001 — one failed step must not keep the next from reporting
                    log('%s failed: %s' % (step.__name__, e))
    except RuntimeError as e:  # the lock is held by another run
        log(str(e))
    return 0


def cmd_nightly(args):
    """What launchd starts: take the lock, merge last night's PRs (green by now; their cases and `supersedes` lines
    join tonight's base, SE-49), refresh the run's worktree, run its fresh `cycle` with the lock handed over (the
    same open file, so nobody can start between the refresh and the cycle)."""
    repo = g.main_repo(HERE)
    try:
        with resources.Lock(os.path.join(STATE_DIR, 'run.lock')) as lock:
            try:  # before the refresh: HERE still holds last night's verdicts with the session's `supersedes` lines
                cmd_merge(args)
            except Exception as e:  # noqa: BLE001 — a failed merge must not cost the night
                log('merge before the run failed: %s' % e)
            g.refresh_worktree(repo, args.worktree, steps.BASE)
            fresh = os.path.join(repo, args.worktree, 'eval', 'evolve', 'daily.py')
            os.set_inheritable(lock.fd, True)
            cmd = [sys.executable, '-I', fresh, 'cycle', '--lock-fd', str(lock.fd)]
            cmd += ['--force'] if args.force else []
            return subprocess.run(cmd, pass_fds=(lock.fd,)).returncode
    except RuntimeError as e:
        log(str(e))
        return 0


def cmd_antigens(args):
    """The session's one check of its antigen proposal (data only; nothing it wrote runs)."""
    wt = os.path.abspath(os.path.join(HERE, '..', '..'))
    changed = {}
    for rel in (session.ANTIGENS, session.ANTIGEN_CASES):
        if os.path.isfile(os.path.join(wt, rel)):
            with open(os.path.join(wt, rel), encoding='utf-8') as f:
                changed[rel] = f.read()
    problems = session.antigen_problems(wt, 'origin/%s' % steps.BASE, changed)
    print(json.dumps(problems or 'ok', ensure_ascii=False, indent=1))
    return 1 if problems else 0


def cmd_cases(args):
    bad = 0
    for path in args.files or sorted(glob.glob(os.path.join(HERE, 'cases', '*.jsonl'))):
        problems = quality.check_cases(path)
        bad += bool(problems)
        print('%s: %s' % (path, '; '.join(problems) or 'ok'))
    return 1 if bad else 0


def cmd_status(args):
    print(json.dumps({'state': load_json('state.json', {}), 'queue': len(load_json('queue.json', [])),
                      'last': load_json('runs/latest.json', {}).get('summary')}, ensure_ascii=False, indent=1))
    return 0


def main(argv=None, factory=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('command', choices=('run', 'session', 'publish', 'merge', 'cycle', 'nightly', 'status', 'cases',
                                        'antigens'))
    ap.add_argument('files', nargs='*', help='cases: the files to check')
    ap.add_argument('--target', choices=('taibe', 'hr', 'all'), default='all')
    ap.add_argument('--since', help='baseline revision for every target (default: the last run, else a day ago)')
    ap.add_argument('--judges', help='comma-separated candidates to calibrate (default: judges.candidates)')
    ap.add_argument('--calibration-cases', default=judging.CALIBRATION_CASES)
    ap.add_argument('--no-card', action='store_true', help='post nothing to the card')
    ap.add_argument('--worktree', default=WORKTREE)
    ap.add_argument('--cases', default=os.path.join(HERE, 'cases'))
    ap.add_argument('--verdicts', default=os.path.join(HERE, ab.VERDICTS))
    ap.add_argument('--deadline-min', type=int, default=DEADLINE_MIN)
    ap.add_argument('--no-pr', action='store_true', help='record verdicts, open no revert PR')
    ap.add_argument('--keep-state', action='store_true', help='do not move the state forward')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force', action='store_true', help='cycle outside the night window')
    ap.add_argument('--lock-fd', type=int, help='the lock handed over by nightly')
    args = ap.parse_args(argv)
    args.factory = factory
    args.budget = resources.Budget()
    return {'run': cmd_run, 'session': session.cmd_session, 'publish': session.cmd_publish, 'merge': cmd_merge,
            'cycle': cmd_cycle, 'nightly': cmd_nightly, 'status': cmd_status, 'cases': cmd_cases,
            'antigens': cmd_antigens}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
