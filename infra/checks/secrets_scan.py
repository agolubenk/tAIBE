"""Secrets in tracked files: provider key formats, private keys, JWTs, credentials in URLs, high-entropy base64 and
literal credentials.

A line can carry the marker `checks: allow-secret` (a test fixture, a documented fake). Values that look like
placeholders (`example`, `changeme`, `xxx`, `${…}`, `<…>`, `***`) are skipped. The patterns follow the common
public formats of each provider; the same family of patterns redacts text in `boards/packages/redact` (TypeScript)
— that one cleans what leaves the product, this one stops what enters git. Both sets read one corpus,
`boards/packages/redact/fixtures/secrets-corpus.json`: every kind in it must be caught by both (TB-136).
"""
import math
import re

from common import Finding

PATTERNS = [
    ('aws-access-key', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('github-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b')),
    ('gitlab-token', re.compile(r'\bglpat-[A-Za-z0-9_-]{20,}')),
    ('slack-token', re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}\b')),
    # PEM ends in "KEY-----", a PGP key block in "KEY BLOCK-----".
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----')),
    ('anthropic-key', re.compile(r'\bsk-ant-[A-Za-z0-9_-]{20,}')),
    ('openrouter-key', re.compile(r'\bsk-or-v1-[a-f0-9]{40,}')),
    ('openai-key', re.compile(r'\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b')),
    ('google-api-key', re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b')),
    # Also inside a Bot API URL (.../bot<token>/...): only a digit may not precede it.
    ('telegram-bot-token', re.compile(r'(?<![0-9])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])')),
    ('stripe-key', re.compile(r'\b[sr]k_live_[A-Za-z0-9]{20,}\b')),
    # The board's own API keys since TB-136 (`defaultPrefix` in boards/apps/api/src/auth.ts): tbk_ + 64 letters.
    ('t-boards-key', re.compile(r'\btbk_[A-Za-z0-9]{32,}\b')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    # A scheme has at most 32 characters: an open one scanned from every word of a long `a.a.a…` line.
    ('url-credentials', re.compile(r'\b[a-z][a-z0-9+.-]{0,31}://[^/\s:@"\'`]+:([^@\s/"\'`]{6,})@[^\s"\'`]+', re.I)),
    ('bearer-token', re.compile(r'(?i)\bAuthorization["\']?[ \t]*:[ \t]*["\']?Bearer[ \t]+([^\s"\'`]{12,})')),
]
# A credential name in any case, also as the end of a longer name (x-api-key, "api_key" in JSON); quotes optional.
ASSIGNED = re.compile(r'(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)'
                      r'\b["\']?[ \t]*[:=][ \t]*["\'`]?([^"\'`\s]{12,})')
# Environment style, uppercase only: any NAME ending in API_KEY, TOKEN, SECRET or PASSWORD (T_BOARDS_API_KEY=,
# GITHUB_TOKEN:). `\b` does not fire after `_`, so ASSIGNED misses these names. The name starts after a non-name
# character and has at most 64 characters before the suffix: an open [A-Z0-9_]* that may start after every `_` made
# a long run of `_` quadratic (64 000 characters: 12 s, TB-136 security lens).
ENV_ASSIGNED = re.compile(r'(?<![A-Za-z0-9_])([A-Z0-9_]{0,64}(?:API_KEY|TOKEN|SECRET|PASSWORD))["\']?[ \t]*[:=][ \t]*'
                          r'["\'`]?([^"\'`\s]{12,})')
# Long runs of the base64 alphabet mixing upper, lower and digits with high entropy: encoded key material. The same
# thresholds as the base64 rule in redact; hex digests are single-case and never reach it.
BASE64 = re.compile(r'[A-Za-z0-9+/]{64,}={0,2}')
# A PascalCase name (routeTree.gen.ts: LayoutAuthenticated…Char123…Route) is not key material. Each character has
# one way to match, so a long run never backtracks.
IDENTIFIER = re.compile(r'[a-z]*(?:[A-Z][a-z]+|[A-Z](?![a-z])|[0-9])+')
# A data: URI is media and an SRI hash (integrity="sha384-…") is public: neither is key material.
NOT_KEY_PREFIXES = ('base64,', 'sha256-', 'sha384-', 'sha512-')
PATH_WORD = re.compile(r'[a-z]{3,}')
PRINTABLE = re.compile(r'^[\x21-\x7e]+$')
CODE_CHARS = re.compile(r'[(){}\[\];,<>\\]')
DOTTED_NAME = re.compile(r'^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$')
JOINED_WORDS = re.compile(r'^[A-Za-z]+(?:[_-][A-Za-z]+)+$')
CAMEL_WORD = re.compile(r'^[a-z]+(?:[A-Z][a-z0-9]*)*$')
PLACEHOLDER = re.compile(r'(?i)example|changeme|change-me|placeholder|dummy|sample|your[_-]|xxx|\*\*\*|<[^>]*>|\$\{|'
                         r'\{\{|\[[^\]]*\]|redacted|test|fake|ci-only|not-a-|secret123|password123|^\$|'
                         r'^(?:pass(?:word)?|secret|postgres|root|admin|user|kaneo)$')
MARKER = 'checks: allow-secret'
SKIP_SUFFIX = ('.lock', 'pnpm-lock.yaml', 'package-lock.json', '.svg', '.map', '.example', '.sample', '.template')
# Fixture code: fake keys of real formats are what tests are for. Findings there are warnings — visible, never a
# failed build; a real key pasted into a test still shows up in every run's output.
FIXTURE = re.compile(r'(^|/)(tests?|e2e|fixtures?|__mocks__|__tests__)/|(^|/)test_[^/]*$|\.test\.|\.spec\.|'
                     r'(^|/)[^/]*selftest[^/]*$|(^|/)scripts/ci/')


def entropy(s):
    counts = {c: s.count(c) for c in set(s)}
    return -sum(n / len(s) * math.log2(n / len(s)) for n in counts.values())


def looks_like_secret(value):
    """`looksLikeSecret` of redact: a value given to a credential name in code is mostly code (options.apiKey,
    z.string(), apiKey) or a placeholder (your_secure_password). A key has 8+ printable ASCII characters, no code
    punctuation, and is not a dotted name, words joined by _ or -, or a short camelCase name."""
    if len(value) < 8 or not PRINTABLE.match(value) or CODE_CHARS.search(value):
        return False
    if DOTTED_NAME.match(value) or JOINED_WORDS.match(value):
        return False
    return not (len(value) < 32 and CAMEL_WORD.match(value))


def is_base64_key(line, m):
    """`isBase64Key` of redact: mixed case and digits, high entropy; not a name, a data: URI, an SRI hash or a URL
    path (two or more lowercase-word segments: /dashboard/workspace/<id>/…)."""
    token = m.group(0)
    if not (re.search('[a-z]', token) and re.search('[A-Z]', token) and re.search('[0-9]', token)):
        return False
    if entropy(token) < 4.5 or IDENTIFIER.fullmatch(token):
        return False
    if line[max(0, m.start() - 7):m.start()].endswith(NOT_KEY_PREFIXES):
        return False
    return sum(1 for segment in token.split('/') if PATH_WORD.fullmatch(segment)) < 2


def scan_line(line):
    """(rule, value) pairs of one line. A value inside a provider-format match is reported once, by its format."""
    found, spans = [], []
    for name, rx in PATTERNS:
        for m in rx.finditer(line):
            group = 1 if m.groups() else 0
            value = m.group(group)
            if name != 'private-key' and PLACEHOLDER.search(value):
                continue
            if name == 'bearer-token' and (not looks_like_secret(value) or entropy(value) < 3.5):
                continue
            found.append((name, value))
            spans.append(m.span(group))

    def covered(m, g):
        return any(m.start(g) < end and start < m.end(g) for start, end in spans)

    for rx in (ASSIGNED, ENV_ASSIGNED):
        for m in rx.finditer(line):
            value = m.group(2)
            if (covered(m, 2) or PLACEHOLDER.search(value) or not looks_like_secret(value)
                    or entropy(value) < 3.5):
                continue
            found.append(('literal %s' % m.group(1).lower(), value))
            spans.append(m.span(2))
    for m in BASE64.finditer(line):
        if not covered(m, 0) and is_base64_key(line, m):
            found.append(('base64-blob', m.group(0)))
    return found


def scan_text(path, text):
    out = []
    level = 'warning' if FIXTURE.search(path) else 'error'
    for n, line in enumerate(text.splitlines(), 1):
        if MARKER in line or len(line) > 4000:
            continue
        for name, value in scan_line(line):
            shown = 4 if name.startswith('literal ') else 6
            out.append(Finding('secrets', level, path, n, '%s: %s…' % (name, value[:shown])))
    return out


def run(root, files, read_text):
    out = []
    for path in files:
        if path.endswith(SKIP_SUFFIX):
            continue
        text = read_text(root, path)
        if text:
            out += scan_text(path, text)
    return out
