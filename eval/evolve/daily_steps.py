#!/usr/bin/env python3
"""Steps of the daily evolution run around the judging (`daily.py`): state files, switches, the llm-gateway, the
layer's cost metrics, the headless Claude session and publishing what the run wrote. Stdlib only."""
import datetime
import fnmatch
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PAID = ('abJudgeClaude',)  # off when the settings cannot be read
sys.path.insert(0, HERE)
import ab  # noqa: E402
import daily_git as g  # noqa: E402
import quality  # noqa: E402

SESSION_TURNS = 60
SESSION_BUDGET_USD = '4'
SESSION_TIMEOUT_MIN = 45
QUOTA = re.compile(r'usage limit|rate.?limit|quota|credit balance|limit (?:reached|exceeded)|out of (?:extra )?usage',
                   re.I)
HUB = os.path.expanduser(os.environ.get('EVOLVE_HUB') or
                         '~/Desktop/Development/handoff/2026-11-06-restart/tools/hub.mjs')
CARD, WORKSPACE = 'SE-49', 'lth89qy6f8j1greiy4c5cn23'
PUBLISH = ('eval/evolve/verdicts.jsonl', 'eval/evolve/cases/*.jsonl')
ANTIGENS = ('eval/pipeline/genome/antigens.json', 'eval/pipeline/reflex/test_reflex.py')
STATE_DIR = os.path.expanduser(os.environ.get('EVOLVE_STATE_DIR') or '~/.claude/evolve')
OLLAMA = os.environ.get('OLLAMA_HOST_URL', 'http://127.0.0.1:11434')
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


def gateway(repo):
    base = os.environ.get('LLM_GATEWAY_URL', ab.GATEWAY).rstrip('/')
    token = os.environ.get('LLM_GATEWAY_TOKEN')
    if not token:
        try:
            with open(os.path.join(repo, ab.TOKEN_FILE), encoding='utf-8') as f:
                token = f.read().strip()
        except OSError:
            token = ''
    return base, token


def models(base, token):
    """{model id: window in tokens} from the gateway, or None when it does not answer."""
    req = urllib.request.Request(base + '/models', headers={'Authorization': 'Bearer %s' % token})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 — local gateway URL
            data = json.loads(resp.read().decode('utf-8'))
    except Exception:  # noqa: BLE001
        return None
    return {m['id']: m.get('context_length') or 0 for m in data.get('data', [])}


def ensure_gateway(repo, judges=()):
    """The gateway's models; the gateway is started from the main checkout's script (its data lives there) when
    down, and Ollama (the judges' backend, which does not restart by itself) when no judge is listed."""
    base, token = gateway(repo)
    found = models(base, token)
    if found is None:
        log('gateway down — starting it')
        subprocess.run(['bash', os.path.join(repo, 'infra/llm-gateway/bin/llm-gateway.sh'), 'start'],
                       capture_output=True, text=True, timeout=120)
        found = wait(lambda: models(*gateway(repo)))
        base, token = gateway(repo)  # a first start writes the token
    no_local = found is not None and not any(m.startswith('local/') for m in found)
    if found is not None and (no_local or not all(j in found for j in judges)):
        if not ollama_up():  # never reopen a running Ollama.app: on 06.11 a second `open` quit it
            log('Ollama down — starting it')
            start_ollama()
            wait(lambda: True if ollama_up() else None, tries=45)

        def ready():
            m = models(base, token)
            return m if m and any(k.startswith('local/') for k in m) and all(j in m for j in judges) else None
        found = wait(ready, tries=45) or models(base, token)
    if found is not None:
        os.environ['LLM_GATEWAY_TOKEN'] = token
    return found


def wait(probe, tries=30, pause=2):
    for _ in range(tries):
        got = probe()
        if got is not None:
            return got
        time.sleep(pause)
    return None


def ollama_up():
    try:
        with urllib.request.urlopen(OLLAMA + '/api/version', timeout=5):  # noqa: S310 — local Ollama URL
            return True
    except Exception:  # noqa: BLE001
        return False


def start_ollama():
    """Ollama.app on macOS, else `ollama serve` detached. On 06.11 the app quit by itself four times in two
    hours, once in the middle of a judge call: the retry in `retrying` brings it back."""
    if subprocess.run(['open', '-ga', 'Ollama'], capture_output=True).returncode != 0:
        subprocess.Popen(['ollama', 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)


def unload(model):
    """Free a local judge's memory before the next one loads: two 7–9B models at once is too much here."""
    name = model.split('/', 1)[1] if model.startswith('local/') else None
    if not name:
        return
    body = json.dumps({'model': name, 'keep_alive': 0}).encode('utf-8')
    req = urllib.request.Request(OLLAMA + '/api/generate', data=body, headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=60).read()  # noqa: S310 — local Ollama URL
    except Exception:  # noqa: BLE001 — best effort
        pass


def stream_call(repo, model, timeout=900):
    """ab.gateway_call with `stream: true`. The gateway gives up on a call whose first byte takes over 120 s
    (GW_FIRST_BYTE_TIMEOUT_MS); without streaming the first byte is the whole answer, and on 06.11 every artifact
    prompt of the 35B judge died there while the shorter calibration prompts passed. Streamed, the first byte
    comes after the prefill."""
    def call(system, user):
        base, token = gateway(repo)
        messages = ([{'role': 'system', 'content': system}] if system else []) + [{'role': 'user', 'content': user}]
        body = json.dumps({'model': model, 'messages': messages, 'temperature': 0, 'stream': True}).encode('utf-8')
        req = urllib.request.Request(base + '/chat/completions', data=body, method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer %s' % token})
        parts = []
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — local gateway URL
            for raw in resp:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:') or line[5:].strip() == '[DONE]':
                    continue
                chunk = json.loads(line[5:].strip())
                if chunk.get('error'):
                    raise OSError('gateway: %s' % str(chunk['error'])[:200])
                parts.append(((chunk.get('choices') or [{}])[0].get('delta') or {}).get('content') or '')
        return ''.join(parts)
    return call


def retrying(call, revive, attempts=3, pause=20):
    """A judge call that survives a busy or restarting backend (HTTP 5xx, refused connection): `revive` raises
    what fell, then the same call again. The last failure propagates — the judge is then unavailable."""
    def wrapped(system, user):
        for n in range(attempts):
            try:
                return call(system, user)
            except (OSError, ValueError) as e:  # urllib's HTTPError and URLError are OSError
                if n == attempts - 1:
                    raise
                log('judge call failed (%s) — retry in %ds' % (str(e)[:80], pause))
                revive()
                time.sleep(pause)
    return wrapped


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
    return out


def cmd_session(args):
    """The headless Claude session. Quiet exit (0) when the quota is spent or the master switch is off."""
    wt = os.path.join(g.main_repo(HERE), args.worktree)
    if not switch('automation', wt):
        log('automation is off — no session')
        return 0
    with open(os.path.join(HERE, 'daily-prompt.md'), encoding='utf-8') as f:
        prompt = f.read()
    for key, value in (('__REPORT__', os.path.join(STATE_DIR, 'runs/latest.json')), ('__HUB__', HUB),
                       ('__CARD__', CARD), ('__WORKSPACE__', WORKSPACE)):
        prompt = prompt.replace(key, value)
    env = dict(os.environ, WT_DEPS_CHECK='0',
               TAIBE_PIPELINE='successorAuto=off,nerveWakes=off,swarm=off,promptBrief=off,councilReview=off')
    # Edit rules cover every tool that writes a file: the session can write these paths and nothing else.
    allowed = ['Read', 'Glob', 'Grep', 'Edit(eval/evolve/cases/**)', 'Edit(eval/evolve/verdicts.jsonl)',
               'Edit(eval/pipeline/genome/antigens.json)', 'Edit(eval/pipeline/reflex/test_reflex.py)',
               'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(python3 -I eval/evolve/:*)',
               'Bash(python3 -I -m unittest:*)', 'Bash(node %s:*)' % HUB]
    cmd = ['claude', '-p', prompt, '--max-turns', str(SESSION_TURNS), '--max-budget-usd', SESSION_BUDGET_USD,
           '--permission-mode', 'dontAsk', '--allowedTools', *allowed,
           '--disallowedTools', 'Agent', 'WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(git push:*)',
           'Bash(git commit:*)', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
           '--add-dir', STATE_DIR, os.path.expanduser('~/.claude/projects'),
           '--no-session-persistence', '--output-format', 'json']
    if args.dry_run:
        print(json.dumps(cmd[:2] + ['<daily-prompt.md>'] + cmd[3:]))
        return 0
    try:
        res = subprocess.run(cmd, cwd=wt, env=env, capture_output=True, text=True, timeout=SESSION_TIMEOUT_MIN * 60)
    except subprocess.TimeoutExpired:
        log('session: stopped after %d min' % SESSION_TIMEOUT_MIN)
        return 0
    text = (res.stdout or '') + (res.stderr or '')
    if QUOTA.search(text) and res.returncode != 0:
        log('session: quota spent — quiet exit')
        return 0
    save_json('runs/session-latest.json', {'exit': res.returncode, 'tail': text[-4000:]})
    log('session: exit %d' % res.returncode)
    return 0


def cmd_publish(args):
    """Verdicts and cases (one PR), antigens with their test green (another PR), from the run's worktree."""
    repo = g.main_repo(HERE)
    wt = os.path.join(repo, args.worktree)
    base = BASE
    head = g.git(wt, 'rev-parse', 'HEAD').strip()
    dirty = [ln[3:] for ln in (g.git(wt, 'status', '--porcelain', '--untracked-files=all') or '').splitlines()]
    date = now().date().isoformat()
    rows = []
    groups = (('verdicts', [p for p in dirty if any(fnmatch.fnmatchcase(p, x) for x in PUBLISH)]),
              ('antigens', [p for p in dirty if p in ANTIGENS]))
    for name, paths in groups:
        if not paths:
            continue
        files = {}
        for p in paths:
            with open(os.path.join(wt, p), encoding='utf-8') as f:
                files[p] = f.read()
            problems = quality.check_cases(os.path.join(wt, p)) if p.startswith('eval/evolve/cases/') else []
            if problems:
                files.pop(p)
                rows.append({'skipped': p, 'why': '; '.join(problems)})
        if name == 'antigens':
            res = subprocess.run([sys.executable, '-I', '-m', 'unittest', 'discover', '-s',
                                  os.path.join(wt, 'eval/pipeline/reflex'), '-p', 'test_reflex.py'],
                                 capture_output=True, text=True, timeout=300)
            if res.returncode != 0:
                rows.append({'skipped': 'antigens', 'why': 'test_reflex.py is red: %s' % res.stderr[-300:]})
                continue
        if not files:
            continue
        title = 'evolve: %s of %s' % ('verdicts and cases' if name == 'verdicts' else 'antigens', date)
        body = 'The daily evolution run (`eval/evolve/daily.py publish`), %s.\n\nFiles: %s\n\n%s' % (
            date, ', '.join('`%s`' % p for p in sorted(files)), load_json('runs/latest.json', {}).get('summary', ''))
        if args.dry_run:
            rows.append({'would_open': title, 'files': sorted(files)})
            continue
        commit = g.commit_files(repo, head, files, title)
        rows.append({'pr': g.open_pr(repo, base, commit, 'evolve/%s-%s' % (name, date), title, body)})
    others = [p for p in dirty if p not in sum((ps for _, ps in groups), [])]
    if others:
        rows.append({'not_published': others, 'why': 'outside what the run publishes'})
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0

