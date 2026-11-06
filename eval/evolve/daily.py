#!/usr/bin/env python3
"""The daily evolution run: blind A/B of what changed in the layer since the last run, quality control that marks
false positives as brak, and corrections that only an accepted verdict may start (owner, 06.11: once a day, by
itself, «ложноположительные результаты — брак»).

    bash eval/evolve/daily.sh run                    # what launchd starts at 04:30: refresh, then `cycle`
    python3 -I eval/evolve/daily.py cycle [--force]  # gateway → run → session → publish → merge
    python3 -I eval/evolve/daily.py run [--target taibe|hr|all] [--since REV] [--judges m1,m2] [--no-pr] [--dry-run]
    python3 -I eval/evolve/daily.py session|publish|merge [--dry-run]
    python3 -I eval/evolve/daily.py status

`run` is deterministic and makes no Claude call: it raises the llm-gateway when it is down, refreshes its own
worktree (`worktrees/evolve/daily`, detached on a fresh `origin/board-agents`; nobody's checkout is touched), runs
`catalog.py` and `dupes.py`, takes the layer files changed since the last run (`~/.claude/evolve/state.json`),
judges each one that has cases (`cases/*.jsonl`, naming below) previous version against current with two different
local judges, one after the other, and passes every verdict through `quality.py`. The rest go to the queue for
cases. `eval/tools/ctx_budget.py learn` runs when it exists. An accepted loss of the merged version opens a revert
PR (tAIBE; HR — the same PR, never merged by the run); an accepted win is pinned in `verdicts.jsonl`; brak and
insufficient verdicts are written there as well and never act.

`session` is a headless Claude session (`claude -p`, `daily-prompt.md`, turns and budget capped, quiet exit when
the quota is spent): it writes missing cases, re-reads the fresh verdicts for false positives, proposes antigens
and posts one line to SE-49. It does not commit, push or merge. `publish` commits what the run and the session wrote
(verdicts, cases, antigens with their test passing) as PRs from `evolve/…` branches. `merge` is the only step that
merges: the run's own PRs, paths from the explicit list (`daily_git.AUTO_MERGE_PATHS`), green checks, the switch
`evolveAutoMerge`, `gh pr merge --auto --match-head-commit`. Sessions keep their merge-guard: this is the
owner's scheduled job, not a session. Stdlib only.

Cases per artifact: `.claude/skills/<n>/SKILL.md` → `cases/<n>.jsonl`; `.claude/rules/<f>.md` → `cases/rule-<f>.jsonl`;
agents, commands, prompts → `agent-`, `command-`, `prompt-<f>.jsonl`; a role card → `card-<dir with ->.jsonl`.
"""
import argparse
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab  # noqa: E402
import catalog  # noqa: E402
import daily_git as g  # noqa: E402
import daily_steps as steps  # noqa: E402
import judges as judging  # noqa: E402
from daily_steps import STATE_DIR, load_json, log, now, save_json, switch  # noqa: E402,F401
import quality  # noqa: E402

WORKTREE = 'worktrees/evolve/daily'
TARGETS = {
    'taibe': {'base': steps.BASE, 'auto_merge': True},
    'hr': {'base': 'main', 'auto_merge': False,
           'repo': os.path.expanduser(os.environ.get('EVOLVE_HR_REPO') or '~/Desktop/Development/HR_Helper-v2')},
}
AB_KINDS = ('skill', 'rule', 'agent', 'command', 'prompt', 'card')  # text instructions; hooks and genome are code
NIGHT = (3, 8)            # a scheduled run spends model time only between 03:00 and 08:00 local
DEADLINE_MIN = 180        # judging stops after 3 hours; what is left waits for the next night


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

def plan(target, repo, since, head, cases_dir, pending=()):
    """(items to judge, items that need cases, notes) for the files changed between two revisions, plus the ones a
    previous night ran out of time for (`pending`: {path, a}), each against its own baseline."""
    items, need, notes = [], [], []
    changed = g.changed_files(repo, since, head)
    pairs = [(p, since) for p in changed] + [(p['path'], p['a']) for p in pending if p['path'] not in changed]
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
                          'text_a': a, 'text_b': b, 'cases': cases_path(path, cases_dir)})
    return items, need, notes


def judge(items, judges, factory, windows, deadline, after_judge=lambda j: None):
    """[verdict] for each item: every judge in turn over every item (one model loaded at a time, unloaded after),
    then `quality.finalize` and `quality.combine`."""
    run = {j: {} for j in judges}
    for j in judges:
        call = factory(j)
        for it in items:
            key = it['path']
            if time.time() > deadline:
                run[j][key] = {'cases': 0, 'tokens_a': 0, 'tokens_b': 0, 'unavailable': 'out of time this night'}
                continue
            cases, canaries = quality.read_cases(it['cases'])
            log('judge %s · %s · %d cases' % (j, key, len(cases)))
            run[j][key] = quality.judge_artifact(call, cases, it['text_a'], it['text_b'], canaries,
                                                 (windows or {}).get(j))
        after_judge(j)
    final = quality.finalize(run)
    out = []
    for it in items:
        per = [(j, final[j][it['path']]) for j in judges]
        status, reasons, pick = quality.combine(per)
        out.append(verdict_line(it, status, reasons, pick, [(j, run[j][it['path']], final[j][it['path']])
                                                           for j in judges]))
    return out


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
    """A verdict of a night without a fit judge: insufficient, nothing acts, the file is tried again next night."""
    tried = ', '.join('%s (%s)' % (r['model'], r['reasons'][0][:80]) for r in calibration['rows']) or 'no candidates'
    v = verdict_line(it, 'insufficient', ['no fit judge: calibration passed none of %d candidates — %s'
                                          % (len(calibration['rows']), tried)], None, [])
    v['calibration'] = [r['model'] for r in calibration['rows']]
    return v


def calibrate_judges(args, repo, wt, windows, deadline):
    """{candidates, passed, rows}: tonight's candidates, each calibrated in turn until two pass."""
    code_root = os.path.abspath(os.path.join(HERE, '..', '..'))
    names = [j for j in args.judges.split(',') if j] if args.judges else judging.candidates(
        list(windows or {}), judging.ollama_tags(steps.OLLAMA), switch('abJudgeClaude', code_root))
    with open(os.path.join(wt, judging.CALIBRATION_ARTIFACT), encoding='utf-8') as f:
        text = f.read()
    cases, _ = quality.read_cases(args.calibration_cases)
    factory = args.factory or judge_factory(repo)
    after = steps.unload if not args.factory else (lambda name: None)
    passed, rows = judging.select(names, factory, cases, text, windows, after=after, log=log,
                                  stop=lambda: time.time() > deadline)
    return {'candidates': names, 'passed': passed, 'rows': rows}


def judge_factory(repo):
    revive = lambda: steps.ensure_gateway(repo)  # noqa: E731

    def factory(model):
        if model == judging.CLAUDE_JUDGE:
            return judging.claude_call()
        return steps.retrying(ab.gateway_call(repo, model, timeout=900), revive)
    return factory


def revert(repo, target, v, text_a, no_pr):
    """An accepted loss of the merged version: a PR that puts the previous version back."""
    cfg = TARGETS[target]
    head = g.git(repo, 'rev-parse', 'origin/%s' % cfg['base']).strip()
    title = 'evolve: revert %s to %s (A/B: the previous version wins)' % (v['path'], v['a'])
    body = ('The daily evolution run judged the previous version of `%s` (%s) better than the merged one (%s).\n\n'
            'Status: **accepted** — %s.\n\n```json\n%s\n```\n\n%s\nevolve-verdict: %s\n'
            % (v['path'], v['a'], v['b'], '; '.join(v['reasons']), json.dumps(v, ensure_ascii=False, indent=1)[:6000],
               'Merged by the run when checks are green and evolveAutoMerge is on.' if cfg['auto_merge'] else
               'HR: the run never merges this — Control does.', v['id']))
    if no_pr:
        return 'not opened (--no-pr)'
    commit = g.commit_files(repo, head, {v['path']: text_a}, title + '\n\nevolve-verdict: %s\n' % v['id'])
    return g.open_pr(repo, cfg['base'], commit, 'evolve/revert-%s-%s' % (v['id'], v['date']), title, body)


def cmd_run(args):
    code_root = os.path.abspath(os.path.join(HERE, '..', '..'))
    repo = g.main_repo(code_root)
    started, deadline = now(), time.time() + args.deadline_min * 60
    report = {'date': started.date().isoformat(), 'started': started.isoformat(timespec='seconds'), 'targets': {}}
    state, queue = load_json('state.json', {}), load_json('queue.json', [])
    queue = [q for q in queue if not os.path.isfile(os.path.join(HERE, q['cases']))]  # cases written since
    ab_on = switch('abJudge', code_root) and switch('automation', code_root)
    windows, calibration, posted = None, None, False
    if ab_on and not args.dry_run:
        windows = steps.ensure_gateway(repo, [j for j in (args.judges or '').split(',') if j.startswith('local/')])
        report['gateway'] = 'up, %d models' % len(windows) if windows is not None else 'down'
    for target in (TARGETS if args.target == 'all' else [args.target]):
        cfg = TARGETS[target]
        trepo = cfg.get('repo') or repo
        if not os.path.isdir(os.path.join(trepo, '.git')):
            report['targets'][target] = {'skipped': 'no repository at %s' % trepo}
            continue
        if target == 'taibe':
            head = g.refresh_worktree(trepo, args.worktree, cfg['base'])
            report['metrics'] = steps.layer_metrics(os.path.join(trepo, args.worktree))
        else:
            head = g.fetch(trepo, cfg['base'])
        since = args.since or (state.get(target) or {}).get('rev') or g.since_day_ago(trepo, cfg['base'])
        if g.git(trepo, 'rev-parse', '--verify', '--quiet', since + '^{commit}', check=False) is None:
            report['targets'][target] = {'skipped': 'no revision %s here' % since}
            continue
        pending = (state.get(target) or {}).get('pending', []) if not args.since else []
        items, need, notes = plan(target, trepo, since, head, args.cases, pending)
        t = {'since': g.short(trepo, since), 'head': g.short(trepo, head), 'judged': [], 'need_cases': len(need),
             'notes': notes}
        known = {(q['target'], q['path']) for q in queue}
        queue += [q for q in need if (q['target'], q['path']) not in known]
        late, judged_any = [], False
        if args.dry_run:
            t['judged'] = [{'path': it['path'], 'a': it['a'], 'b': it['b'], 'status': 'dry-run'} for it in items]
        elif not ab_on:
            t['judged'] = [{'path': it['path'], 'status': 'skipped: abJudge or automation is off'} for it in items]
        elif windows is None:
            t['judged'] = [{'path': it['path'], 'status': 'skipped: the gateway is down'} for it in items]
        elif items:
            judged_any = True
            for it in items:
                it['run'] = report['started']
            if calibration is None:
                calibration = calibrate_judges(args, repo, os.path.join(repo, args.worktree), windows, deadline)
                report['calibration'] = calibration
            passed = calibration['passed'][:judging.WANT_JUDGES]
            if passed:
                verdicts = judge(items, passed, args.factory or judge_factory(repo), windows, deadline,
                                 after_judge=steps.unload if not args.factory else lambda j: None)
            else:
                verdicts = [no_judge_line(it, calibration) for it in items]
                if not posted and not args.no_card:
                    posted = steps.post_card('evolve %s: нет годного судьи — калибровку не прошёл ни один из %d '
                                             'кандидатов (%s); A/B не выполнен, корректировок нет.' % (
                                                 report['date'], len(calibration['rows']),
                                                 ', '.join(r['model'] for r in calibration['rows']) or 'нет'))
                    report['card'] = posted
            for v, it in zip(verdicts, items):
                measured = [j for j in v['judges'] if not any('unavailable' in r for r in j['reasons'])]
                if len(measured) < len(v['judges']) or not v['judges']:  # not reached / no judge: retried next night
                    late.append({'path': it['path'], 'a': it['a']})
                if v['judges'] and not measured:  # judges chosen but none reached: no verdict, the report has it
                    t['judged'].append({'path': it['path'], 'status': 'not measured', 'reasons': v['reasons']})
                    continue
                if v['action'] == 'revert':
                    try:
                        v['pr'] = revert(trepo, target, v, it['text_a'], args.no_pr)
                    except Exception as e:  # noqa: BLE001 — the verdict is kept, the PR is retried by hand
                        v['pr'] = 'failed: %s' % e
                with open(args.verdicts, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(v, ensure_ascii=False) + '\n')
                t['judged'].append({k: v.get(k) for k in ('id', 'path', 'a', 'b', 'status', 'pick', 'action', 'pr',
                                                          'reasons')})
        # Nothing judged because the judge was off or down: the state stays, the next night takes the same range.
        if not args.dry_run and not args.keep_state and (judged_any or not items):
            state[target] = {'rev': head, 'date': report['date'], 'pending': late}
        report['targets'][target] = t
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


def summary(report):
    counts = {}
    for t in report['targets'].values():
        for v in t.get('judged', []):
            counts[v['status']] = counts.get(v['status'], 0) + 1
    shown = ', '.join('%s %d' % kv for kv in sorted(counts.items())) or 'nothing changed with cases'
    return 'evolve %s: A/B %s; cases needed for %d artifacts' % (report['date'], shown, len(report.get('queue', [])))


def cmd_merge(args):
    code_root = os.path.abspath(os.path.join(HERE, '..', '..'))
    repo = g.main_repo(code_root)
    verdicts = []
    if os.path.isfile(args.verdicts):
        with open(args.verdicts, encoding='utf-8') as f:
            verdicts = [json.loads(ln) for ln in f if ln.strip()]
    enabled = switch('evolveAutoMerge', code_root)
    rows = g.merge_ready(repo, TARGETS['taibe']['base'], verdicts, enabled, args.dry_run)
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


def cmd_cycle(args):
    hour = now().hour
    if not args.force and not NIGHT[0] <= hour < NIGHT[1]:
        log('outside the night window %02d:00–%02d:00 — waits for the next night (--force to run now)' % NIGHT)
        return 0
    for step in (cmd_run, steps.cmd_session, steps.cmd_publish, cmd_merge):
        try:
            step(args)
        except Exception as e:  # noqa: BLE001 — one failed step must not keep the next from reporting
            log('%s failed: %s' % (step.__name__, e))
    return 0


def cmd_cases(args):
    bad = 0
    for path in args.files:
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
    ap.add_argument('command', choices=('run', 'session', 'publish', 'merge', 'cycle', 'status', 'cases'))
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
    args = ap.parse_args(argv)
    args.factory = factory
    return {'run': cmd_run, 'session': steps.cmd_session, 'publish': steps.cmd_publish, 'merge': cmd_merge,
            'cycle': cmd_cycle, 'status': cmd_status, 'cases': cmd_cases}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
