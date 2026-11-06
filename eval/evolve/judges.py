#!/usr/bin/env python3
"""Who may judge tonight: Claude models only (owner decision 06.11 — the judge is Claude; local models are never
started; `memory/no-local-ollama.md`). Every daily run starts with a calibration, and only a model that passes it
judges.

Candidates, in this order: `claude:claude-sonnet-5-5`, `claude:claude-haiku-5-5`, then `claude:claude-opus-5-5` as a
fallback. The first two that pass judge; the two-judge rule of `quality.combine` needs two different models. Nightly
judges run only if `abJudgeClaude` is on (`daily_steps.claude_judges_on`); the owner may pass `--judges` to `daily.py
run` by hand. Every `claude:<model>` id goes to `claude_call` (`claude -p --model <model> --output-format json`, no
tools, MCP, hooks or session file, an empty folder): the answering model is checked in `modelUsage`, the real tokens
are charged to the night's `resources.Budget`, and a limit message, a wrong model, an error or an empty answer is
«unavailable» — never brak.

Calibration on the reference artifact (`CALIBRATION_ARTIFACT` with its cases): the text against itself must be a
tie in both orders (TIE, TIE — a judge that answers «X» twice reads positions, not texts); against its first 30 % and
against itself with a harmful paragraph it must win in both orders. CALIBRATION_PER_KIND cases per kind, every ask
right — the same canaries the run then repeats on each artifact. Stdlib only.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ab  # noqa: E402
import quality  # noqa: E402
from daily_steps import QUOTA  # noqa: E402
from tokens import est_tokens  # noqa: E402

CLAUDE_CANDIDATES = ('claude:claude-sonnet-5-5', 'claude:claude-haiku-5-5', 'claude:claude-opus-5-5')
WANT_JUDGES = 2           # quality.combine needs two sound judges of two different models for «accepted»
MAX_CANDIDATES = len(CLAUDE_CANDIDATES)
CALIBRATION_ARTIFACT = '.claude/skills/grill-task/SKILL.md'
CALIBRATION_CASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases', 'grill-task.jsonl')
CALIBRATION_PER_KIND = 2
CALIBRATION_CALLS = 3 * CALIBRATION_PER_KIND * 2   # three canary kinds, both orders
CLAUDE_MODEL = 'claude-sonnet-5-5'
CLAUDE_JUDGE = 'claude:' + CLAUDE_MODEL
SYSTEM = 'You are a strict, impartial judge. Answer exactly as asked.'
# Per call beyond the prompt: the system prompt, what the CLI adds and a reasoned answer (assumed until measured;
# the real usage is charged and `Budget.ratio` scales the next estimates).
CALL_EXTRA_TOKENS = 1000


def is_claude(name):
    return name.startswith('claude:') and len(name) > len('claude:')


def model_of(name):
    """`claude:claude-haiku-5-5` → `claude-haiku-5-5`."""
    return name.split(':', 1)[1]


def candidates(claude_on):
    """Tonight's candidates in order; none when `abJudgeClaude` is off."""
    return list(CLAUDE_CANDIDATES) if claude_on else []


def answering_model(data):
    """The model that wrote the answer: the `modelUsage` entry of `claude -p --output-format json` with the most
    output tokens; None when the CLI reported no model."""
    usage = (data or {}).get('modelUsage') or {}
    ranked = sorted(usage.items(), key=lambda kv: -int((kv[1] or {}).get('outputTokens') or 0))
    return ranked[0][0] if ranked else None


def same_model(got, want):
    """`claude-sonnet-5-5` is answered by `claude-sonnet-5-5`, a dated build of it or its `[1m]` variant."""
    return bool(got) and re.fullmatch(re.escape(want) + r'(?:-\d{8})?(?:\[[^\]]*\])?', got, re.I) is not None


def used_tokens(data):
    """Real tokens of one call (input, cache writes and reads, output) over every model the CLI used; 0 when the CLI
    reported none."""
    per_model = (data or {}).get('modelUsage') or {}
    total = sum(int((u or {}).get(k) or 0) for u in per_model.values()
                for k in ('inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'))
    if total:
        return total
    usage = (data or {}).get('usage') or {}
    return sum(int(usage.get(k) or 0) for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens',
                                                 'cache_creation_input_tokens'))


def call_estimate(system, user):
    """Tokens one judge call is booked at before it runs."""
    return est_tokens(system or SYSTEM) + est_tokens(user) + CALL_EXTRA_TOKENS


def claude_call(budget, model=CLAUDE_MODEL, timeout=600):
    """A judge call through the Claude Code CLI: no tools, no MCP, no hooks, no session file, an empty folder (no
    project instructions). The prompt goes on stdin; the answer format is ab.py's (last line X, Y or TIE).

    `budget` (resources.Budget) refuses a call whose estimate does not fit tonight and is charged the real tokens the
    CLI reports. Every failure is an OSError, so the judge is «unavailable», never brak: a non-zero exit or an error
    result; a limit message (QUOTA) at any exit code when the result is no answer; an answer written by another model
    than `model` (`modelUsage`)."""
    settings = json.dumps({'disableAllHooks': True})

    def call(system, user):
        estimate = call_estimate(system, user)
        budget.check(estimate)
        cmd = ['claude', '-p', '--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config',
               '{"mcpServers":{}}', '--settings', settings, '--no-session-persistence', '--output-format', 'json',
               '--system-prompt', system or SYSTEM]
        res = subprocess.run(cmd, input=user, cwd=tempfile.gettempdir(), capture_output=True, text=True,
                             timeout=timeout)
        try:
            data = json.loads(res.stdout or '')
        except ValueError:
            data = None
        data = data if isinstance(data, dict) else None
        budget.charge(used_tokens(data) or estimate, estimate)  # no usage reported: the estimate is booked
        text = data.get('result') or '' if data else res.stdout or ''
        said = ('%s\n%s' % (text, res.stderr or '')).strip()
        # The CLI's own limit message, at any exit code: in stderr, or as the result instead of an answer. A judge's
        # reasoning that mentions a quota but ends with X, Y or TIE is an answer.
        if QUOTA.search(res.stderr or '') or (QUOTA.search(text) and ab.parse_answer(text) is None):
            raise OSError('claude -p: limit reached: %s' % said[-200:])
        if res.returncode != 0 or data is None or data.get('is_error'):
            raise OSError('claude -p exit %d: %s' % (res.returncode, said[-200:]))
        got = answering_model(data)
        if not same_model(got, model):
            raise OSError('claude -p: answered by %s, not %s' % (got or 'an unknown model', model))
        if not text.strip():  # an empty answer is the CLI failing, not the judge breaking the format
            raise OSError('claude -p: empty answer')
        return text
    return call


def calibrate(call, cases, text):
    """{passed, reasons, asks, swap_disagree} of one candidate on the reference text."""
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


def select(names, factory, cases, text, want=WANT_JUDGES, limit=MAX_CANDIDATES, log=lambda *a: None,
           stop=lambda: False):
    """(passed names, [calibration row]) — candidates one at a time until `want` pass or `limit` are tried."""
    passed, rows = [], []
    for name in names[:limit]:
        if len(passed) >= want or stop():
            break
        log('calibrate %s' % name)
        row = dict(calibrate(factory(name), cases, text), model=name)
        rows.append(row)
        log('calibrate %s: %s — %s' % (name, 'passed' if row['passed'] else 'failed', '; '.join(row['reasons'])))
        if row['passed']:
            passed.append(name)
    return passed, rows


def main(argv=None):
    """Print tonight's candidates (no call to any judge)."""
    import daily_steps as steps
    print(json.dumps(candidates(steps.claude_judges_on()), indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
