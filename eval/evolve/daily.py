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
import glob
import hashlib
import re
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
NOT_OURS = re.compile(r'embed|nomic', re.I)  # what may stay loaded after the night
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
                          'text_a': a, 'text_b': b, 'cases': cases_path(path, cases_dir)})
    return items, need, notes


def judge(items, judges, factory, windows, deadline, after_judge=lambda j: None, admit=lambda j: (True, '')):
    """[verdict] for each item: every judge in turn over every item (one model loaded at a time, unloaded after),
    then `quality.finalize` and `quality.combine`."""
    run = {j: {} for j in judges}
    for j in judges:
        call = factory(j)
        ok, why = admit(j)
        try:
            for it in items:
                key = it['path']
                if not ok or time.time() > deadline or swap_stop():
                    reason = 'not loaded: %s' % why if not ok else 'out of time or swap this night'
                    run[j][key] = {'cases': 0, 'tokens_a': 0, 'tokens_b': 0, 'unavailable': reason}
                    continue
                cases, canaries = quality.read_cases(it['cases'])
                log('judge %s · %s · %d cases' % (j, key, len(cases)))
                run[j][key] = quality.judge_artifact(call, cases, it['text_a'], it['text_b'], canaries,
                                                     (windows or {}).get(j))
        finally:
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
    tags = judging.ollama_tags(steps.OLLAMA) if not args.factory else {}
    names = [j for j in args.judges.split(',') if j] if args.judges else judging.candidates(
        list(windows or {}), tags, switch('abJudgeClaude', code_root))
    with open(os.path.join(wt, judging.CALIBRATION_ARTIFACT), encoding='utf-8') as f:
        text = f.read()
    cases, _ = quality.read_cases(args.calibration_cases)
    factory = args.factory or judge_factory(repo, args.budget)
    after = steps.unload if not args.factory else (lambda name: None)
    passed, rows = judging.select(names, factory, cases, text, windows, after=after, log=log,
                                  stop=lambda: time.time() > deadline or swap_stop(), admit=admit_local(tags))
    return {'candidates': names, 'passed': passed, 'rows': rows, 'tags': tags}


def admit_local(tags):
    """(ok, why) per candidate: a local model loads only if it fits the memory left after the reserve."""
    def admit(name):
        info = tags.get(name[len('local/'):]) if name.startswith('local/') else None
        return resources.fits(info['size']) if info else (True, 'not local')
    return admit


def swap_stop():
    share = resources.swap_share()
    if share > resources.SWAP_STOP:
        log('swap %.0f%% used — the night stops here' % (share * 100))
        return True
    return False


def judge_factory(repo, budget):
    revive = lambda: steps.ensure_gateway(repo)  # noqa: E731

    def factory(model):
        if model == judging.CLAUDE_JUDGE:
            return judging.claude_call(budget)
        return steps.retrying(steps.stream_call(repo, model), revive)
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
                verdicts = judge(items, passed, args.factory or judge_factory(repo, args.budget), windows, deadline,
                                 after_judge=steps.unload if not args.factory else lambda j: None,
                                 admit=admit_local(calibration.get('tags', {})))
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
                        v['pr'] = revert(trepo, target, v, it['text_a'], args.no_pr, report['started'])
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


def merge_switch(root):
    """evolveAutoMerge, closed on doubt: on only when the board's answer was read (fresh or cached without a failed
    read since) and says on. Defaults, a failed read or any error — off."""
    try:
        sys.path.insert(0, os.path.join(root, '.claude', 'scripts'))
        import pipeline_settings as ps
        settings, source = ps.load(root)
    except Exception:  # noqa: BLE001
        return False
    if not (source.startswith('board') or source.startswith('cache')) or 'failed' in source:
        return False
    return bool(settings['automation'] and settings['toggles'].get('evolveAutoMerge'))


def cmd_merge(args):
    code_root = os.path.abspath(os.path.join(HERE, '..', '..'))
    repo = g.main_repo(code_root)
    verdicts = []
    if os.path.isfile(args.verdicts):
        with open(args.verdicts, encoding='utf-8') as f:
            verdicts = [json.loads(ln) for ln in f if ln.strip()]
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
            if not resources.wait_for_heavy(log) or swap_stop():
                log('another heavy job or swap — the night is skipped')
                return 0
            for step in (cmd_run, session.cmd_session, session.cmd_publish, cmd_merge):
                try:
                    step(args)
                except Exception as e:  # noqa: BLE001 — one failed step must not keep the next from reporting
                    log('%s failed: %s' % (step.__name__, e))
            for name in resources.loaded(steps.OLLAMA):
                if not NOT_OURS.search(name):
                    steps.unload('local/' + name)
            log('loaded after the night: %s' % (resources.loaded(steps.OLLAMA) or 'nothing'))
    except RuntimeError as e:  # the lock is held by another run
        log(str(e))
    return 0


def cmd_nightly(args):
    """What launchd starts: take the lock, refresh the run's worktree, run its fresh `cycle` with the lock handed
    over (the same open file, so nobody can start between the refresh and the cycle)."""
    repo = g.main_repo(HERE)
    try:
        with resources.Lock(os.path.join(STATE_DIR, 'run.lock')) as lock:
            g.refresh_worktree(repo, args.worktree, steps.BASE)
            fresh = os.path.join(repo, args.worktree, 'eval', 'evolve', 'daily.py')
            os.set_inheritable(lock.fd, True)
            cmd = [sys.executable, '-I', fresh, 'cycle', '--lock-fd', str(lock.fd)] + (['--force'] if args.force else [])
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
