#!/usr/bin/env python3
"""The product's switches for the automated process, as tAI-Boards stores them (workspace settings →
«Pipeline & evolution»), for the layer's hooks and tools.

    python3 -I .claude/scripts/pipeline_settings.py                 # effective switches and where they came from
    python3 -I .claude/scripts/pipeline_settings.py fetch           # refresh the cache from the board now
    python3 -I .claude/scripts/pipeline_settings.py enabled swarm   # exit 0 — on, 1 — off (for shell scripts)

In code: `import pipeline_settings; pipeline_settings.enabled("successorAuto")`.

Where the switches come from:
1. the board — cached in `.claude/pipeline-settings.json` (gitignored, runtime), written by `fetch` and refreshed by
   itself at most every 10 minutes when the board's address (`boards.url` in `eval/nerve/config.json` or
   `T_BOARDS_URL`; https, or http only to localhost) and this install's own key (`T_BOARDS_PIPELINE_KEY`: env,
   else Keychain via `infra/scripts/dev-ai/mcp-secret.sh`) are known. A key per product (owner's decision
   d-tb-product-key-0411): the key must reach exactly one product, and that product is the one read. A key that
   reaches several (the boards MCP's `T_BOARDS_API_KEY` does) is refused, and there is no fallback to it.
   `boards.product` / `T_BOARDS_PRODUCT` (name or slug, as people see it) and `boards.workspace` /
   `T_BOARDS_WORKSPACE` (an id) only check that the key is for the expected product. The board
   answers `GET /api/pipeline-settings/workspace/{id}`. A cache of another workspace is ignored;
2. defaults — every switch on — when the board was never read;
3. on top of either, `TAIBE_PIPELINE` in the environment can only switch parts OFF — `off` (everything) or
   `swarm=off,abJudge=off` — never back on: a session cannot overrule the owner.
A failed read keeps the last known switches (an outage never re-enables what the owner switched off) and is not
retried for 10 minutes, so a board that is down costs one timeout per 10 minutes, not one per tool call. Only a
complete answer (automation and every switch, all booleans) is accepted; redirects are refused, so the key never
leaves for another host. Never raises into a hook. Stdlib only.
TLS: an interpreter without its own CA store (python.org's macOS build before «Install Certificates.command»)
verifies against the system bundle instead of failing every read (ОШИБКИ #634).

The keys are the board's (`boards/packages/permissions/src/pipeline-toggles.ts`); `test_pipeline_settings.py`
fails when the two lists differ.
"""
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CACHE = '.claude/pipeline-settings.json'
TTL_SECONDS = 600
TIMEOUT_SECONDS = 1.5  # hooks run on every prompt: a slow board must not slow the session
TOGGLES = ('abJudge', 'abJudgeClaude', 'askOnce', 'handoffDupes', 'evolveAutoMerge', 'promptBrief', 'successorAuto',
           'grillHint', 'nerveWakes', 'swarm', 'councilReview', 'cardAutofill')
# Off unless the owner turns them on: they spend the owner's own tokens (the board's `default: false`).
DEFAULT_OFF = ('abJudgeClaude',)
# Switches newer than the board that is deployed: a board from before them does not send them, and its answer is
# still whole without them (they take their default). A late switch that is sent must be a boolean. Drop a name
# from here once every board in use sends it.
LATE_TOGGLES = ('abJudgeClaude', 'evolveAutoMerge')
OFF = ('off', '0', 'false', 'no')
# This install's key: the env name and the Keychain account (service hr-helper-mcp) of `mcp-secret.sh`.
KEY_NAME = 'T_BOARDS_PIPELINE_KEY'
# The key goes only to hosts the person trusts: an address written in the repository (config.json, a PR can change
# it) is used only for these hosts or for `T_BOARDS_ALLOWED_HOSTS` from the person's own environment; `T_BOARDS_URL`
# set in the environment is the person's choice and is trusted as is.
KNOWN_HOSTS = ('d4dev.admin.hrhelper.space', 'localhost', '127.0.0.1', '::1')
# The system's CA bundle — macOS and BSD, Debian and Ubuntu, RHEL — for an interpreter that has no CA store of its own.
SYSTEM_CA_FILES = ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt')


def defaults():
    return {'automation': True, 'toggles': {name: name not in DEFAULT_OFF for name in TOGGLES}}


def normalize(value):
    """Known keys only, booleans only; anything else takes its default (mirrors normalizePipelineSettings)."""
    out = defaults()
    if not isinstance(value, dict):
        return out
    if isinstance(value.get('automation'), bool):
        out['automation'] = value['automation']
    toggles = value.get('toggles') if isinstance(value.get('toggles'), dict) else {}
    for name in TOGGLES:
        if isinstance(toggles.get(name), bool):
            out['toggles'][name] = toggles[name]
    return out


def apply_env(settings, text):
    """TAIBE_PIPELINE switches parts off on top of the board's settings: 'off' or 'name=off,…'. Never on."""
    text = (text or '').strip()
    if not text:
        return settings
    out = {'automation': settings['automation'], 'toggles': dict(settings['toggles'])}
    if text.lower() in OFF:
        out['automation'] = False
        return out
    for part in text.split(','):
        name, _, value = part.partition('=')
        if name.strip() in TOGGLES and value.strip().lower() in OFF:
            out['toggles'][name.strip()] = False
    return out


def complete(value):
    """The board's answer, only when it is whole: a gateway's `{}` must not reset an «off» to defaults."""
    if not isinstance(value, dict) or not isinstance(value.get('automation'), bool):
        return None
    toggles = value.get('toggles')
    if not isinstance(toggles, dict):
        return None
    if not all(isinstance(toggles.get(n), bool) or (n in LATE_TOGGLES and n not in toggles) for n in TOGGLES):
        return None
    return normalize(value)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # the key header would follow a redirect to any host
        return None


def _board_url(url):
    parts = urllib.parse.urlsplit(url)
    local = parts.hostname in ('localhost', '127.0.0.1', '::1')
    if parts.scheme == 'https' or (parts.scheme == 'http' and local):
        return url.rstrip('/')
    return None


def _tls_context():
    """None — the interpreter's own CA store works; else a verifying context on the system bundle.

    python.org's macOS Python has neither its CA file nor its CA directory until «Install Certificates.command» runs
    (`get_default_verify_paths()` → `cafile=None, capath=None`): every https read fails CERTIFICATE_VERIFY_FAILED and
    the switches silently stay at defaults. Verification stays on — certificate and host name — only the trust store
    changes. `SSL_CERT_FILE` / `SSL_CERT_DIR` from the environment show up as cafile/capath and keep the default."""
    paths = ssl.get_default_verify_paths()
    if paths.cafile or paths.capath:
        return None
    for cafile in SYSTEM_CA_FILES:
        if os.path.isfile(cafile):
            return ssl.create_default_context(cafile=cafile)
    return None


def _instance(root):
    """`boards` of the instance config (`eval/nerve/config.json`, or `supertick-eval/nerve/` over the host)."""
    for tree in ('eval', 'supertick-eval'):
        try:
            with open(os.path.join(root, tree, 'nerve', 'config.json'), encoding='utf-8') as f:
                return json.load(f).get('boards') or {}
        except (OSError, ValueError):
            continue
    return {}


def _workspace(root):
    """The workspace id the config expects (`T_BOARDS_WORKSPACE` or `boards.workspace`), or '' — a check on the
    key's product, not a choice."""
    return (os.environ.get('T_BOARDS_WORKSPACE', '').strip()
            or str(_instance(root).get('workspace') or '').strip())


def _product(root):
    """The product's name or slug as people see it (`T_BOARDS_PRODUCT` or `boards.product`), or '' — a check too."""
    return (os.environ.get('T_BOARDS_PRODUCT', '').strip()
            or str(_instance(root).get('product') or '').strip())


def pick_workspace(workspaces, product='', expected=''):
    """(id, error) from the key's workspaces. The key names the product: it must reach exactly one. `product`
    (name or slug) and `expected` (id) from the config only check that it is the right one."""
    rows = [w for w in workspaces if isinstance(w, dict) and w.get('id')]
    if not rows:
        return None, 'not connected: the key reaches no product'
    if len(rows) > 1:
        names = ', '.join(sorted(str(w.get('name', '?')) for w in rows))
        return None, ('not connected: the key reaches several products (%s) — issue a key limited to one product '
                      '(Settings → API keys → product) and keep it as %s' % (names, KEY_NAME))
    ws, name = str(rows[0]['id']), str(rows[0].get('name', '?'))
    if expected and ws != expected:
        return None, 'not connected: the key is for %r, not for the workspace %r of the config' % (name, expected)
    if product and product.casefold() not in (name.casefold(), str(rows[0].get('slug', '')).casefold()):
        return None, 'not connected: the key is for %r, the config names %r' % (name, product)
    return ws, None


def _key(root):
    """This install's own key: `T_BOARDS_PIPELINE_KEY` from the environment, else the Keychain entry of that name
    (mcp-secret.sh). Never the boards MCP's `T_BOARDS_API_KEY`, which reaches every product. Called only when a
    fetch is due (≤ once per 10 minutes)."""
    key = os.environ.get(KEY_NAME, '').strip()
    script = os.path.join(root, 'infra', 'scripts', 'dev-ai', 'mcp-secret.sh')
    if key or not os.path.isfile(script):
        return key
    try:
        out = subprocess.run(['bash', script, KEY_NAME], capture_output=True, text=True, timeout=3)
        return out.stdout.strip() if out.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def _read_cache(root):
    try:
        with open(os.path.join(root, CACHE), encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {'broken': True}


def _write_cache(root, data):
    path = os.path.join(root, CACHE)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _remember(root, error):
    """A refresh that stopped before the board is remembered like a failed read: the last known switches of this
    product stay, `lastAttempt` starts the TTL."""
    product, pinned = _product(root), _workspace(root)
    data = _read_cache(root)
    if data.get('broken') or data.get('product', product) != product \
            or (pinned and data.get('workspace') not in (None, pinned)):
        data = {}  # another product's switches are not this product's
    data.setdefault('workspace', pinned or None)
    data.update({'product': product, 'lastAttempt': time.time(), 'lastError': error})
    try:
        _write_cache(root, data)
    except OSError:
        pass


def fetch(root=ROOT, timeout=TIMEOUT_SECONDS):
    """Read the board, write the cache. Returns (settings, error); a failure is remembered (`lastAttempt`, `lastError`)
    and keeps the last known settings."""
    env_url = os.environ.get('T_BOARDS_URL', '').strip()
    raw_url = env_url or str(_instance(root).get('url') or '').strip()
    url = _board_url(raw_url)
    if url and not env_url:
        allowed = set(KNOWN_HOSTS) | {h.strip().lower() for h in
                                      os.environ.get('T_BOARDS_ALLOWED_HOSTS', '').split(',') if h.strip()}
        host = (urllib.parse.urlsplit(url).hostname or '').lower()
        if host not in allowed:
            return None, ('not connected: boards.url host %r is not trusted — the key is sent only to known hosts; '
                          'set T_BOARDS_URL or T_BOARDS_ALLOWED_HOSTS in your own environment' % host)
    if not raw_url:
        return None, 'not connected: set boards.url in eval/nerve/config.json (or T_BOARDS_URL)'
    if url is None:  # before the key: a URL the key is never sent to must not cost a Keychain call per prompt
        return None, 'T_BOARDS_URL must be https (http only to localhost)'
    key = _key(root)
    if not key:
        error = ('not connected: no %s — a key limited to this product (env or Keychain, '
                 'infra/scripts/dev-ai/mcp-secret.sh)' % KEY_NAME)
        _remember(root, error)  # until the owner adds the key, Keychain is asked once per TTL, not on every prompt
        return None, error
    opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=_tls_context()))

    deadline = time.monotonic() + timeout  # one budget for the whole refresh, however many calls it takes

    def get(path):
        req = urllib.request.Request(url + path, headers={'x-api-key': key, 'accept': 'application/json'})
        left = max(0.05, deadline - time.monotonic())
        with opener.open(req, timeout=left) as resp:  # noqa: S310 — the board's own URL, checked above
            return resp.status, json.loads(resp.read().decode('utf-8'))

    product = _product(root)
    data = _read_cache(root)
    if data.get('broken'):
        data = {}
    error, settings, ws = None, None, None
    try:
        # The key names the product. It is asked on every refresh, not taken from the cache, so a key swapped for
        # a wider one is refused within one TTL: two calls per 10 minutes.
        _, workspaces = get('/api/workspace')
        ws, error = pick_workspace(workspaces if isinstance(workspaces, list) else [], product, _workspace(root))
        if ws:
            status, body = get('/api/pipeline-settings/workspace/%s' % urllib.parse.quote(ws, safe=''))
            settings = complete(body)
            if settings is None:
                error = 'HTTP %s: incomplete settings in the answer' % status
    except urllib.error.HTTPError as e:
        error = 'HTTP %s' % e.code
    except Exception as e:  # noqa: BLE001 — any failure keeps the last known switches
        error = '%s: %s' % (type(e).__name__, str(e)[:120])
    # The product this cache is about: the key's, else the pinned one, else the one read before. A refused key keeps
    # the last known switches of that product: a wrong key never re-enables what the owner switched off.
    mine = ws or _workspace(root) or data.get('workspace')
    if data.get('workspace') not in (None, mine) or data.get('product', product) != product:
        data = {}  # another product's switches are not this product's
    # A failure is remembered too, so the board is asked once per TTL, not per hook.
    data.update({'workspace': mine, 'product': product, 'lastAttempt': time.time()})
    if settings is not None:
        data.update({'fetchedAt': data['lastAttempt'], 'settings': settings, 'lastError': None})
    else:
        data['lastError'] = error
    try:
        _write_cache(root, data)
    except OSError as e:
        return settings, error or 'cache not written: %s' % e
    return settings, error


def _base(root, refresh):
    """(settings, source) from the board's cache or defaults, before the environment."""
    data = _read_cache(root)
    ws = _workspace(root)
    if data.get('broken') or (ws and data.get('workspace') not in (None, ws)) \
            or (not ws and data.get('product', '') != _product(root)):
        data = {}  # another product's switches are not this product's
    try:
        last = max(float(data.get('lastAttempt') or 0), float(data.get('fetchedAt') or 0))
    except (TypeError, ValueError):
        last = 0.0
    if refresh and time.time() - last > TTL_SECONDS:
        fresh, _ = fetch(root)
        if fresh is not None:
            return fresh, 'board (just fetched)'
        data = _read_cache(root)
    cached = complete(data.get('settings'))
    note = ', last read failed: %s' % data['lastError'] if data.get('lastError') else ''
    if cached is not None:
        age = time.time() - float(data.get('fetchedAt') or 0)
        return cached, 'cache %s (%d s old%s)' % (CACHE, age, note)
    return defaults(), 'defaults (no board settings known%s)' % note


def load(root=ROOT, refresh=True):
    """(settings, source) — the board's switches (or defaults), with the environment's «off» on top."""
    settings, source = _base(root, refresh)
    env = os.environ.get('TAIBE_PIPELINE', '').strip()
    if env:
        return apply_env(settings, env), source + ' + env TAIBE_PIPELINE (off only)'
    return settings, source


def enabled(name, root=ROOT, refresh=True):
    """Is this automated part on? Unknown names are on (a new tool is not silently disabled); a switch that spends
    the owner's tokens (DEFAULT_OFF) is off when the settings cannot be read."""
    try:
        settings, _ = load(root, refresh)
    except Exception:  # noqa: BLE001 — a hook must never fail on settings
        return name not in DEFAULT_OFF
    if name not in TOGGLES:
        return True
    return settings['automation'] and settings['toggles'][name]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ['fetch']:
        settings, error = fetch(timeout=10)
        print('fetched' if settings and not error else 'not fetched: %s' % error)
        return 0 if settings else 1
    if argv[:1] == ['enabled'] and len(argv) == 2:
        return 0 if enabled(argv[1]) else 1
    settings, source = load()
    if source.startswith('defaults'):
        _, why = fetch(timeout=10)
        source += ' — %s' % why if why else ''
    print('pipeline settings — %s; automation %s' % (source, 'on' if settings['automation'] else 'OFF'))
    for name in TOGGLES:
        on = settings['automation'] and settings['toggles'][name]
        print('  %-14s %s' % (name, 'on' if on else 'off'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
