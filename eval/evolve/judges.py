#!/usr/bin/env python3
"""Who may judge tonight. Every daily run starts with a calibration, and only a model that passes it judges.

Candidates (in this order, cheapest for the owner and the machine first):
1. cloud models the llm-gateway lists (`vendor/model` ids; they appear when OpenRouter keys are in
   `infra/llm-gateway/.env`; pools such as `auto` or `free` are not one judge and are left out);
2. local Ollama models above MIN_LOCAL_PARAMS_B, smallest first, one per set of weights (the same weights under two
   tags are one judge);
3. Claude (`claude -p --model claude-sonnet-5-5`, the same prompt and answer format) — only when the product switch
   `abJudgeClaude` is on (off by default: it spends the owner's tokens).

Calibration on the reference artifact (`CALIBRATION_ARTIFACT` with its cases): the text against itself must be a
tie in both orders (TIE, TIE — a judge that answers «X» twice reads positions, not texts); against its first 30 % and
against itself with a harmful paragraph it must win in both orders. CALIBRATION_PER_KIND cases per kind, every ask
right — the same canaries the run then repeats on each artifact, so a looser bar here would only move the brak one
step later. Candidates are calibrated one at a time (one model in memory) until WANT_JUDGES pass. Stdlib only.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quality  # noqa: E402
from tokens import est_tokens  # noqa: E402

# 06.11, first run: qwen2.5:7b (7.6B) and glm4 (9.4B) failed the truncate and harm canaries, glm4 also answered «X»
# in both orders on every case. 7B-class models are not tried again; above that, calibration decides.
MIN_LOCAL_PARAMS_B = 8.0
WANT_JUDGES = 2           # quality.combine needs two sound judges for «accepted»
MAX_CANDIDATES = 6        # calibrations per night: ~12 calls each, minutes on this Mac
CALIBRATION_ARTIFACT = '.claude/skills/grill-task/SKILL.md'
CALIBRATION_CASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases', 'grill-task.jsonl')
CALIBRATION_PER_KIND = 2
CLAUDE_MODEL = 'claude-sonnet-5-5'
CLAUDE_JUDGE = 'claude:' + CLAUDE_MODEL
POOLS = ('auto', 'free', 'cascade', 'glm')
NOT_A_JUDGE = re.compile(r'embed|nomic|bert|fim|minicpm-o', re.I)


def params_b(text):
    """'35.5B' → 35.5, '136.73M' → 0.13673; unknown → 0."""
    m = re.match(r'\s*([\d.]+)\s*([BMK])', text or '', re.I)
    if not m:
        return 0.0
    return float(m.group(1)) * {'B': 1.0, 'M': 1e-3, 'K': 1e-6}[m.group(2).upper()]


def ollama_tags(url):
    """{name: {params, family, size, weights}} from Ollama (/api/tags, /api/show); {} when it does not answer.
    `weights` is the model's FROM blob: two tags over one blob (`glm4` and `hr-helper-agent`) are one judge."""
    def get(path, body=None):
        req = urllib.request.Request(url.rstrip('/') + path, data=json.dumps(body).encode() if body else None,
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 — local Ollama URL
            return json.loads(resp.read().decode('utf-8'))
    try:
        listed = get('/api/tags').get('models', [])
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    for m in listed:
        details = m.get('details') or {}
        info = {'params': params_b(details.get('parameter_size')), 'family': details.get('family') or '',
                'size': m.get('size') or 0, 'weights': m.get('digest', '')}
        if info['params'] >= MIN_LOCAL_PARAMS_B:
            try:
                found = re.search(r'^FROM (\S+)', get('/api/show', {'model': m['name']}).get('modelfile', ''), re.M)
                info['weights'] = found.group(1).rsplit('/', 1)[-1] if found else info['weights']
            except Exception:  # noqa: BLE001 — the tag's own digest then
                pass
        out[m['name']] = info
    return out


def candidates(gateway_models, tags, claude_on, min_params=MIN_LOCAL_PARAMS_B):
    """[model id] to calibrate, in order: cloud, local above `min_params` smallest first, Claude when on."""
    cloud = [m for m in gateway_models if '/' in m and not m.startswith('local/') and m not in POOLS
             and not NOT_A_JUDGE.search(m)]
    local, weights = [], set()
    # Of the tags over one blob, the shortest name: the plain model, not a product's tag with its own SYSTEM prompt.
    for model in sorted(gateway_models, key=len):
        name = model[len('local/'):] if model.startswith('local/') else None
        info = tags.get(name) if name else None
        if not info or NOT_A_JUDGE.search(name) or NOT_A_JUDGE.search(info['family']) or info['params'] < min_params:
            continue
        key = info.get('weights') or (info['family'], info['params'], info['size'])
        if key not in weights:
            weights.add(key)
            local.append((info['params'], model))
    out = cloud + [m for _, m in sorted(local)]
    return out + [CLAUDE_JUDGE] if claude_on else out


def claude_call(budget, model=CLAUDE_MODEL, timeout=600):
    """A judge call through the Claude Code CLI: no tools, no MCP, no hooks, no session file, an empty folder (no
    project instructions). The prompt goes on stdin; the answer format is ab.py's (last line X, Y or TIE). Every call
    is charged to `budget` (resources.Budget) first: past the night's ceiling the judge is unavailable."""
    settings = json.dumps({'disableAllHooks': True})

    def call(system, user):
        budget.spend(est_tokens(user) + 600)  # the prompt plus a short reasoned answer
        cmd = ['claude', '-p', '--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config',
               '{"mcpServers":{}}', '--settings', settings, '--no-session-persistence', '--output-format', 'text',
               '--system-prompt', system or 'You are a strict, impartial judge. Answer exactly as asked.']
        res = subprocess.run(cmd, input=user, cwd=tempfile.gettempdir(), capture_output=True, text=True,
                             timeout=timeout)
        if res.returncode != 0:
            raise OSError('claude -p exit %d: %s' % (res.returncode, (res.stderr or res.stdout).strip()[-200:]))
        return res.stdout
    return call


def calibrate(call, cases, text, window=None):
    """{passed, reasons, asks, swap_disagree} of one candidate on the reference text."""
    if window and quality.largest_prompt_tokens(cases, text, text) > quality.WINDOW_SHARE * window:
        return {'passed': False, 'reasons': ['the reference does not fit the window %d' % window], 'asks': []}
    asks, n = [], CALIBRATION_PER_KIND
    pairs = [('identity', text, 'tie')] * n + [('truncate', quality.truncated(text), 'a')] * n + \
        [('harm', quality.harmful(text), 'a')] * n
    try:
        for i, (kind, other, want) in enumerate(pairs):
            case = cases[i % len(cases)]
            got = quality.ask(call, case, text, other)
            ok = got['winner'] == want and got['consistent']
            asks.append({'kind': kind, 'case': case.get('id', ''), 'want': want, 'answers': [got['first'],
                         got['second']], 'got': got['winner'], 'ok': ok})
    except Exception as e:  # noqa: BLE001 — unreachable, too slow, or the CLI refused: not a judge tonight
        return {'passed': False, 'reasons': ['unavailable: %s: %s' % (type(e).__name__, str(e)[:160])], 'asks': asks}
    failed = ['%s/%s %s→%s' % (a['kind'], a['case'], '/'.join(str(x) for x in a['answers']), a['got'])
              for a in asks if not a['ok']]
    flips = sum(1 for a in asks if None not in a['answers'] and
                {'X': 'a', 'Y': 'b'}.get(a['answers'][0], 'tie') != {'X': 'b', 'Y': 'a'}.get(a['answers'][1], 'tie'))
    reasons = ['failed %d of %d: %s' % (len(failed), len(asks), '; '.join(failed))] if failed else \
        ['%d of %d right in both orders' % (len(asks), len(asks))]
    return {'passed': not failed, 'reasons': reasons, 'asks': asks, 'swap_disagree': flips}


def select(names, factory, cases, text, windows=None, want=WANT_JUDGES, limit=MAX_CANDIDATES,
           after=lambda name: None, log=lambda *a: None, stop=lambda: False, admit=lambda name: (True, '')):
    """(passed names, [calibration row]) — candidates one at a time until `want` pass or `limit` are tried. A
    candidate `admit` refuses (not enough memory) is not loaded; every loaded one is unloaded, whatever happens."""
    passed, rows = [], []
    for name in names[:limit]:
        if len(passed) >= want or stop():
            break
        ok, why = admit(name)
        if not ok:
            rows.append({'model': name, 'passed': False, 'reasons': ['not loaded: %s' % why], 'asks': []})
            log('calibrate %s: skipped — %s' % (name, why))
            continue
        log('calibrate %s' % name)
        try:
            row = dict(calibrate(factory(name), cases, text, (windows or {}).get(name)), model=name)
        finally:
            after(name)
        rows.append(row)
        log('calibrate %s: %s — %s' % (name, 'passed' if row['passed'] else 'failed', '; '.join(row['reasons'])))
        if row['passed']:
            passed.append(name)
    return passed, rows


def main(argv=None):
    """Print tonight's candidates from the gateway and Ollama (no calls to any judge)."""
    import daily_steps as steps
    found = steps.models(*steps.gateway(steps.g.main_repo(os.path.dirname(os.path.abspath(__file__))))) or {}
    print(json.dumps(candidates(list(found), ollama_tags(steps.OLLAMA), steps.switch('abJudgeClaude')),
                     indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
