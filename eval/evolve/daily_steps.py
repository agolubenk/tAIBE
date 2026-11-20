#!/usr/bin/env python3
"""Steps of the daily evolution run around the judging (`daily.py`): state files, switches (closed on doubt for
the ones that spend the owner's tokens or merge), the card comment and the layer's cost metrics. No model, gateway
or Ollama is started here (owner rule `memory/no-local-ollama.md`; the judges are Claude, `judges.py`). Stdlib
only."""
import datetime
import glob
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PAID = ('abJudgeClaude', 'evolveAutoMerge')  # off when the settings cannot be read
sys.path.insert(0, HERE)
import daily_git as g  # noqa: E402

SESSION_TURNS = 60
SESSION_BUDGET_USD = '4'
SESSION_TIMEOUT_MIN = 45
# «You've hit your limit · resets 4am» is what the CLI prints today; the rest are older and API wordings.
QUOTA = re.compile(r"you(?:'|’)ve hit your (?:usage )?limit|hit your limit|usage limit|rate.?limit|quota|"
                   r'credit balance|limit (?:reached|exceeded)|out of (?:extra )?usage', re.I)
HUB = os.path.expanduser(os.environ.get('EVOLVE_HUB') or
                         '~/Desktop/Development/handoff/2026-11-06-restart/tools/hub.mjs')
CARD, WORKSPACE = 'SE-49', 'lth89qy6f8j1greiy4c5cn23'
STATE_DIR = os.path.expanduser(os.environ.get('EVOLVE_STATE_DIR') or '~/.claude/evolve')
AUDIT_KEEP = 30  # nightly context-audit files kept in runs/ (one a night)
SPEND_KEEP = 60  # nightly spend reports kept in spend/ (one a day): the weekly GL-1 table reads them
UNATTRIBUTED = ('unattributed', 'не отнесено')  # key and label of budget.SHARE_LABELS (eval/nerve, SE-66)
CLAUDE_OVERRIDE = 'abJudgeClaude.on'  # in STATE_DIR: the owner's local «on» for nightly Claude judges
MERGE_OVERRIDE = 'evolveAutoMerge.on'  # in STATE_DIR: the owner's local «on» for the run's auto-merge of safe PRs
BASE = 'board-agents'  # tAIBE's default branch: where the run's PRs go


def now():
    return datetime.datetime.now().astimezone()


def log(*parts):
    print('[evolve %s]' % now().strftime('%H:%M:%S'), *parts, flush=True)


def merge_before_run(merge, args):
    """`nightly`'s first step (SE-49): last night's PRs, before the refresh wipes their verdicts and the session's
    `supersedes` lines from the run's worktree. A failed merge is logged and must not cost the night."""
    try:
        merge(args)
    except Exception as e:  # noqa: BLE001
        log('merge before the run failed: %s' % e)


def load_json(name, default):
    try:
        with open(os.path.join(STATE_DIR, name), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(name, data):
    path = os.path.join(STATE_DIR, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(path + '.tmp', path)


def with_kept_supersedes(verdicts):
    """`supersedes … brak` lines live in the run's worktree until their data PR merges, and `refresh_worktree`
    (checkout --force) wipes them. Each merge step keeps the ones it sees in `supersedes.json` and reads both, so a
    revert PR whose verdict was marked brak never merges after a refresh (SE-49)."""
    kept = load_json('supersedes.json', {})
    seen = {v['supersedes']: v.get('status') for v in verdicts if v.get('supersedes')}
    if any(kept.get(vid) != status for vid, status in seen.items()):
        kept.update(seen)
        save_json('supersedes.json', kept)
    return verdicts + [{'supersedes': vid, 'status': status} for vid, status in kept.items() if vid not in seen]


def closed_switch(name, root=ROOT):
    """A switch that is closed on doubt: on only if the board's answer was read (fresh, or cached with no failed
    read since) and says on. Defaults, a failed read or any error — off."""
    try:
        sys.path.insert(0, os.path.join(root, '.claude', 'scripts'))
        import pipeline_settings as ps
        settings, source = ps.load(root)
    except Exception:  # noqa: BLE001
        return False
    if not (source.startswith('board') or source.startswith('cache')) or 'failed' in source:
        return False
    return bool(settings['automation'] and settings['toggles'].get(name))


def owner_switch(name, filename, root=ROOT, override=None):
    """A paid switch: on only if the owner said so — `name` read from the board (closed on doubt), or the owner's
    local file `~/.claude/evolve/<filename>` (the board cannot be read without this install's own key).
    `TAIBE_PIPELINE` with `off` or `<name>=off` turns it off over both."""
    env = os.environ.get('TAIBE_PIPELINE', '').replace(' ', '').lower()
    if env in ('off', '0', 'false', 'no') or name.lower() + '=off' in env.split(','):
        return False
    path = override or os.path.join(STATE_DIR, filename)
    return closed_switch(name, root) or os.path.isfile(path)


def claude_judges_on(root=ROOT, override=None):
    """Nightly Claude judges (`abJudgeClaude`, file `abJudgeClaude.on`)."""
    return owner_switch('abJudgeClaude', CLAUDE_OVERRIDE, root, override)


def auto_merge_on(root=ROOT, override=None):
    """The run's auto-merge of its safe PRs (`evolveAutoMerge`, file `evolveAutoMerge.on`). GitHub still decides:
    `daily_git.merge_ready` refuses a base branch without required checks."""
    return owner_switch('evolveAutoMerge', MERGE_OVERRIDE, root, override)


def switch(name, root=ROOT):
    """The product's switch (`.claude/scripts/pipeline_settings.py`); `automation` is the master switch. A failed
    read is «on» (the module's own rule), except a switch that spends the owner's tokens."""
    try:
        sys.path.insert(0, os.path.join(root, '.claude', 'scripts'))
        import pipeline_settings as ps
        if name == 'automation':
            return ps.load(root)[0]['automation']
        return ps.enabled(name, root)
    except Exception:  # noqa: BLE001
        return name not in PAID


def post_card(line):
    """One comment on the card through the boards hub; returns what happened (never raises)."""
    def hub(tool, payload):
        res = subprocess.run(['node', HUB, tool, json.dumps(payload, ensure_ascii=False)], capture_output=True,
                             text=True, timeout=120)
        if res.returncode != 0:
            raise RuntimeError((res.stderr or res.stdout).strip()[:200])
        return res.stdout
    try:
        task = json.loads(hub('get_task_by_ticket_id', {'ticketId': CARD, 'workspaceId': WORKSPACE}))['data']['id']
        hub('create_task_comment', {'taskId': task, 'content': line, 'harness': 'claude-code'})
        return 'posted to %s' % CARD
    except Exception as e:  # noqa: BLE001 — the run report still has the line
        return 'not posted: %s' % e


def num(x, empty=False):
    """A number of a report for the run report and the day's lines; None only if `empty`. Any other value raises
    TypeError: summarize() makes it the metric's error, and the lines never format a string (#485, backend B1)."""
    if x is None and empty:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise TypeError('not a number: %r' % (x,))
    return x


def summarize(shape, data, **extra):
    """shape(data) for the run report, or `extra` with the error: a report of another form (the run worktree's tool
    ahead of this code) must not stop the night's A/B run and judges (#478, Control N1, N2)."""
    try:
        return shape(data)
    except (AttributeError, KeyError, TypeError, ValueError) as e:
        return dict(extra, error=('report of another form: %s: %s' % (type(e).__name__, e))[:300])


def layer_metrics(wt):
    """The night's layer metrics. Each one fails alone: a tool that cannot start, hangs or reports another form
    gives its own error, and the next metric and the A/B run go on."""
    out = {}
    for name, cmd in (('catalog', ['catalog.py', '--root', wt, '--json']), ('dupes', ['dupes.py', '--root', wt,
                                                                                      '--l1', '--json'])):
        try:
            res = subprocess.run([sys.executable, '-I', os.path.join(wt, 'eval/evolve', cmd[0]), *cmd[1:]],
                                 capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as e:
            out[name] = {'error': str(e)[-300:]}
            continue
        try:
            data = json.loads(res.stdout)
        except ValueError:
            out[name] = {'error': (res.stderr or res.stdout).strip()[:300]}
            continue
        out[name] = summarize(lambda d, n=name: (
            {'l1': {r: v['total'] for r, v in d['l1'].items()}, 'budget': d['budget'], 'over': d['over']}
            if n == 'catalog' else {'clusters': len(d['clusters']), 'l1_waste': d['l1_waste']}), data)
    tool = os.path.join(wt, 'eval/tools/ctx_budget.py')
    if os.path.isfile(tool):
        try:
            res = subprocess.run([sys.executable, '-I', tool, 'learn'], capture_output=True, text=True, timeout=600)
            out['ctx_budget'] = {'exit': res.returncode, 'tail': (res.stdout + res.stderr).strip()[-300:]}
        except (OSError, subprocess.TimeoutExpired) as e:
            out['ctx_budget'] = {'exit': None, 'error': str(e)[-300:]}
    else:
        out['ctx_budget'] = 'skipped: eval/tools/ctx_budget.py is not in this revision'
    out['context_audit'] = context_audit(wt)
    out['spend'] = spend_night(wt)
    return out


def nightly_json(tool, args, path, keep_glob, keep, timeout=600):
    """Runs a read-only report tool of the run worktree into path, keeps the last `keep` files of keep_glob and
    returns (data, None) or (None, the failure for the run report). A failure never stops the night's other steps."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):  # a second run of the day must not report the first one's numbers
            os.remove(path)
        res = subprocess.run([sys.executable, '-I', tool, *args, '--json', path],
                             capture_output=True, text=True, timeout=timeout)
        for old in sorted(glob.glob(keep_glob))[:-keep]:
            os.remove(old)
    except (OSError, subprocess.TimeoutExpired) as e:  # the night's other metrics and the A/B run go on
        return None, {'exit': None, 'error': str(e)[-300:]}
    try:
        if res.returncode != 0:
            raise ValueError('exit %d' % res.returncode)
        with open(path, encoding='utf-8') as f:
            return json.load(f), None
    except (OSError, ValueError):
        return None, {'exit': res.returncode, 'error': (res.stderr or res.stdout).strip()[-300:]}


def context_audit(wt):
    """The last 24 h of every session of the instance (d-f63b-economy-0711, item 4): money, the cause of each cold
    call and the generation cost by window size. Read-only over transcripts; the full JSON stays in the run dir."""
    tool = os.path.join(wt, 'eval/tools/context_audit.py')
    if not os.path.isfile(tool):
        return {'skipped': 'eval/tools/context_audit.py is not in this revision'}
    path = os.path.join(STATE_DIR, 'runs', 'context-audit-%s.json' % now().strftime('%Y%m%d'))
    data, err = nightly_json(tool, ['--hours', '24', '--all'], path,
                             os.path.join(STATE_DIR, 'runs', 'context-audit-*.json'), AUDIT_KEEP)
    if err:
        return err
    return summarize(lambda d: {
        'exit': 0, 'file': path, 'usd': num(d.get('total'), True),
        'cold': {k: {'n': v['n'], 'usd': round(num(v['usd']), 2)} for k, v in (d.get('cold') or {}).items()},
        'generations': {k: dict(v, life_min=num(v['life_min']), call_usd=num(v['call_usd']),
                                handoff_share=num(v.get('handoff_share'), True))
                        for k, v in (d.get('generations') or {}).items()}}, data, exit=0, file=path)


def spend_night(wt, day=None):
    """GL-1 (plan v1.1 on the card, PR 3): yesterday's spend by the API price list — sessions, roles, products,
    window bands, the target of each call and the PRs merged that day (`eval/tools/spend.py --attribution`). Reads
    transcripts and `gh pr list`; the report stays in spend/<day>.json (SPEND_KEEP days) for the weekly table."""
    tool = os.path.join(wt, 'eval/tools/spend.py')
    if not os.path.isfile(tool):
        return {'skipped': 'eval/tools/spend.py is not in this revision'}
    day = day or now().date() - datetime.timedelta(days=1)
    span = [d.strftime('%Y-%m-%d 00:00') for d in (day, day + datetime.timedelta(days=1))]
    path = os.path.join(STATE_DIR, 'spend', '%s.json' % day.isoformat())
    data, err = nightly_json(tool, span + ['--attribution'], path, os.path.join(STATE_DIR, 'spend', '*.json'),
                             SPEND_KEEP, timeout=900)
    extra = {'exit': 0, 'file': path, 'day': day.isoformat()}
    return err or summarize(lambda d: dict(spend_summary(d), **extra), data, **extra)


def spend_summary(rep):
    """The day's figures for the line: $, calls, $ per merged PR (all spend / merged PRs, like the base $68 → $37),
    shares of $ by target kind, product and window band; context per call is reference only (plan v1.2)."""
    usd = num(rep.get('usd'), True) or 0.0
    def shares(pairs):
        out = {}
        for key, value in pairs:
            out[key] = out.get(key, 0.0) + num(value)
        return {k: round(v / usd, 3) for k, v in out.items()} if usd else {}
    merged = sum(num(n) for n in (rep.get('merged') or {}).values())
    return {'usd': round(usd, 2), 'calls': rep.get('calls'), 'sessions': rep.get('sessions'), 'merged': merged,
            'per_pr': round(usd / merged, 2) if merged else None,
            'targets': shares((r['kind'], r['usd']) for r in rep.get('attribution') or ()),
            'products': shares((g['product'], g['usd']) for g in rep.get('by_product') or ()),
            'bands': shares((k, v['usd']) for k, v in (rep.get('bands') or {}).items()),
            'ctx_median': num(rep.get('ctx_median'), True), 'ctx_p90': num(rep.get('ctx_p90'), True)}


def spend_line(s):
    """The day's one line for the coordinator (GL-1 plan v1.1, «Где видно» 1); '' without money."""
    if not isinstance(s, dict) or not s.get('usd'):
        return ''
    def pct(d, key):
        return '%.0f' % (d.get(key, 0.0) * 100)
    def label(key):
        return UNATTRIBUTED[1] if key == UNATTRIBUTED[0] else key
    day = datetime.date.fromisoformat(s['day']).strftime('%d.%m') if s.get('day') else '—'
    per_pr = '$%.0f (%d PR)' % (s['per_pr'], s['merged']) if s.get('per_pr') else 'нет влитых PR'
    t = s.get('targets') or {}
    products = ' · '.join('%s %s %%' % (label(k), pct(s['products'], k))
                          for k in sorted(s.get('products') or {}, key=lambda k: -s['products'][k]))
    bands = ' / '.join(pct(s.get('bands') or {}, k) for k in s.get('bands') or {})
    return ('GL-1 расход %s: $%.0f, вызовов %s, сессий %s; $ на влитый PR — %s, цель ≈ $20; PR / карточки / %s — '
            '%s / %s / %s %%; продукты: %s (решение 60/40); контекст вызова — медиана %.0fK, p90 %.0fK (справочно); '
            'доля $ по полосам окна %s — %s %%') % (
        day, s['usd'], s.get('calls'), s.get('sessions'), per_pr, UNATTRIBUTED[1], pct(t, 'pr'), pct(t, 'task'),
        pct(t, UNATTRIBUTED[0]), products or '—', (s.get('ctx_median') or 0) / 1000, (s.get('ctx_p90') or 0) / 1000,
        ' / '.join(s.get('bands') or {}) or '—', bands or '—')


def spend_nerve(repo, summary):
    """The line as one event to the tAIBE coordinator, through the main checkout's Nerve: an emit from a worktree
    lands in that worktree's own journal (SE-171). One line a day: a second run of the day (`cycle --force`) sends
    nothing. Returns what happened (never raises)."""
    line = spend_line(summary)
    if not line:
        return 'no line'
    if load_json('spend-sent.json', {}).get('day') == summary.get('day'):
        return 'already sent for %s' % summary.get('day')
    try:
        res = subprocess.run([sys.executable, '-I', os.path.join(repo, 'eval/nerve/nerve.py'), 'emit', '--product',
                              'taibe', '--kind', 'report', 'coord', line], cwd=repo, capture_output=True, text=True,
                             timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 'not emitted: %s' % e
    if res.returncode != 0:
        return 'not emitted: %s' % (res.stderr or res.stdout).strip()[-200:]
    try:
        save_json('spend-sent.json', {'day': summary.get('day')})
    except OSError as e:  # the line went out; a rerun may send it again
        return 'emitted; not marked: %s' % e
    return 'emitted'


def audit_line(audit, date):
    """The night's one line for the owner (card SE-49): money of 24 h, cold calls with the top cause, and per window
    band the handoff share, the call price and the life; '' when the audit gave no money."""
    if not isinstance(audit, dict) or not audit.get('usd'):
        return ''
    usd, cold = audit['usd'], audit.get('cold') or {}
    cold_usd = sum(v['usd'] for v in cold.values())
    top = max(cold.items(), key=lambda kv: kv[1]['usd'], default=(None, None))
    bands = '; '.join('%s — передача %s, ход $%.2f, жизнь %.0f мин' % (
        k, '—' if v.get('handoff_share') is None else '%.0f %%' % (v['handoff_share'] * 100), v['call_usd'],
        v['life_min']) for k, v in (audit.get('generations') or {}).items())
    return 'контекст %s, 24 ч: $%.0f; холодные вызовы $%.0f (%.0f %%)%s; окна: %s' % (
        date, usd, cold_usd, cold_usd / usd * 100,
        ', больше всего — %s $%.0f' % (top[0], top[1]['usd']) if top[0] else '', bands or '—')
