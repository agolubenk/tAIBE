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
CLAUDE_OVERRIDE = 'abJudgeClaude.on'  # in STATE_DIR: the owner's local «on» for nightly Claude judges
BASE = 'board-agents'  # tAIBE's default branch: where the run's PRs go


def now():
    return datetime.datetime.now().astimezone()


def log(*parts):
    print('[evolve %s]' % now().strftime('%H:%M:%S'), *parts, flush=True)


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


def claude_judges_on(root=ROOT, override=None):
    """Nightly Claude judges: on only if the owner said so — `abJudgeClaude` read from the board (closed on doubt), or
    the owner's local file `~/.claude/evolve/abJudgeClaude.on` (the deployed board has no such switch yet).
    `TAIBE_PIPELINE` with `off` or `abJudgeClaude=off` turns it off over both."""
    env = os.environ.get('TAIBE_PIPELINE', '').replace(' ', '').lower()
    if env in ('off', '0', 'false', 'no') or 'abjudgeclaude=off' in env.split(','):
        return False
    path = override or os.path.join(STATE_DIR, CLAUDE_OVERRIDE)
    return closed_switch('abJudgeClaude', root) or os.path.isfile(path)


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


def layer_metrics(wt):
    out = {}
    for name, cmd in (('catalog', ['catalog.py', '--root', wt, '--json']), ('dupes', ['dupes.py', '--root', wt,
                                                                                      '--l1', '--json'])):
        res = subprocess.run([sys.executable, '-I', os.path.join(wt, 'eval/evolve', cmd[0]), *cmd[1:]],
                             capture_output=True, text=True, timeout=300)
        try:
            data = json.loads(res.stdout)
        except ValueError:
            out[name] = {'error': (res.stderr or res.stdout).strip()[:300]}
            continue
        out[name] = ({'l1': {r: v['total'] for r, v in data['l1'].items()}, 'budget': data['budget'],
                      'over': data['over']} if name == 'catalog' else
                     {'clusters': len(data['clusters']), 'l1_waste': data['l1_waste']})
    tool = os.path.join(wt, 'eval/tools/ctx_budget.py')
    if os.path.isfile(tool):
        res = subprocess.run([sys.executable, '-I', tool, 'learn'], capture_output=True, text=True, timeout=600)
        out['ctx_budget'] = {'exit': res.returncode, 'tail': (res.stdout + res.stderr).strip()[-300:]}
    else:
        out['ctx_budget'] = 'skipped: eval/tools/ctx_budget.py is not in this revision'
    out['context_audit'] = context_audit(wt)
    return out


def context_audit(wt):
    """The last 24 h of every session of the instance (d-f63b-economy-0711, item 4): money, the cause of each cold
    call and the generation cost by window size. Read-only over transcripts; the full JSON stays in the run dir."""
    tool = os.path.join(wt, 'eval/tools/context_audit.py')
    if not os.path.isfile(tool):
        return {'skipped': 'eval/tools/context_audit.py is not in this revision'}
    path = os.path.join(STATE_DIR, 'runs', 'context-audit-%s.json' % now().strftime('%Y%m%d'))
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):  # a second run of the day must not report the first one's numbers
            os.remove(path)
        res = subprocess.run([sys.executable, '-I', tool, '--hours', '24', '--all', '--json', path],
                             capture_output=True, text=True, timeout=600)
        for old in sorted(glob.glob(os.path.join(STATE_DIR, 'runs', 'context-audit-*.json')))[:-AUDIT_KEEP]:
            os.remove(old)
    except (OSError, subprocess.TimeoutExpired) as e:  # the night's other metrics and the A/B run go on
        return {'exit': None, 'error': str(e)[-300:]}
    try:
        if res.returncode != 0:
            raise ValueError('exit %d' % res.returncode)
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {'exit': res.returncode, 'error': (res.stderr or res.stdout).strip()[-300:]}
    return {'exit': res.returncode, 'file': path, 'usd': data.get('total'),
            'cold': {k: {'n': v['n'], 'usd': round(v['usd'], 2)} for k, v in (data.get('cold') or {}).items()},
            'generations': data.get('generations')}


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
