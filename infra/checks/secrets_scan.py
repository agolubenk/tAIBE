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

# A provider key also starts after `_` or `-` (TOKEN_glpat-…, x_sk-ant-…): `\b` does not fire after `_`, so these
# rules start where no letter or digit precedes, as the live rules of `boards/packages/redact` do (OPS-71). A start
# after `_` stays linear: a body has no `_`, no end check or a fixed length, and in `xox…-` the `-` gives `\b` a place
# to stop. `github_pat_` keeps `\b`: its body is word characters only, so before `é` the end fails at every length,
# and a start after every `_` of a long `github_pat_github_pat_…` rescans it to the end (16 s on 256 000 characters).
START = r'(?<![A-Za-z0-9])'

PATTERNS = [
    ('aws-access-key', re.compile(START + r'(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('github-token', re.compile(r'(?:' + START + r'gh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{60,})\b')),
    ('gitlab-token', re.compile(START + r'glpat-[A-Za-z0-9_-]{20,}')),
    ('slack-token', re.compile(START + r'xox[abposr]-[A-Za-z0-9-]{10,}\b')),
    # PEM ends in "KEY-----", a PGP key block in "KEY BLOCK-----".
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----')),
    ('anthropic-key', re.compile(START + r'sk-ant-[A-Za-z0-9_-]{20,}')),
    ('openrouter-key', re.compile(START + r'sk-or-v1-[a-f0-9]{40,}')),
    # As `sk-` of redact: the body takes `_` and `-` (sk-proj-…, Claude lens #349). The body is the end check's class,
    # so the first start takes the whole run. A key the two rules above report is not reported twice.
    ('openai-key', re.compile(START + r'sk-(?!ant-|or-v1-[a-f0-9]{40})[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])')),
    ('google-api-key', re.compile(START + r'AIza[0-9A-Za-z_-]{35}\b')),
    # Also inside a Bot API URL (.../bot<token>/...): only a digit may not precede it.
    ('telegram-bot-token', re.compile(r'(?<![0-9])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])')),
    ('stripe-key', re.compile(START + r'[sr]k_live_[A-Za-z0-9]{20,}\b')),
    # The board's own API keys since TB-136 (`defaultPrefix` in boards/apps/api/src/auth.ts): tbk_ + 64 letters.
    ('t-boards-key', re.compile(START + r'tbk_[A-Za-z0-9]{32,}\b')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    # A scheme has at most 32 characters: an open one scanned from every word of a long `a.a.a…` line.
    ('url-credentials', re.compile(r'\b[a-z][a-z0-9+.-]{0,31}://[^/\s:@"\'`]+:([^@\s/"\'`]{6,})@[^\s"\'`]+', re.I)),
    ('bearer-token', re.compile(r'(?i)\bAuthorization["\']?[ \t]*:[ \t]*["\']?Bearer[ \t]+([^\s"\'`]{12,})')),
]
# TB-199, as redact: the separator is `=`, `:`, `:=` (Go, Pascal) or `=>` (PHP, Ruby, Perl); `==` and `===` compare.
# A name right after `${` is a shell reference (${PASSWORD:?not set}), not an assignment.
SEPARATOR = r'(?::=|=>|=(?!=)|:)'
# A credential name in any case, also as the end of a longer name (x-api-key, "api_key" in JSON); quotes optional.
ASSIGNED = re.compile(r'(?i)(?<!\$\{)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token'
                      r'|private[_-]?key)\b["\']?[ \t]*' + SEPARATOR + r'[ \t]*["\'`]?([^"\'`\s,;]{12,})')
# Environment style, uppercase only: any NAME ending in API_KEY, TOKEN, SECRET or PASSWORD (T_BOARDS_API_KEY=,
# GITHUB_TOKEN:). `\b` does not fire after `_`, so ASSIGNED misses these names. The name starts where a run of
# [A-Z0-9_] starts, also after a lowercase prefix (foo_API_KEY, app_CLIENT_SECRET), and has at most 64 characters
# before the suffix: an open [A-Z0-9_]* that may start after every `_` made a long run of `_` quadratic (64 000
# characters: 12 s, TB-136 security lens).
ENV_ASSIGNED = re.compile(r'(?<![A-Z0-9_])(?<!\$\{)([A-Z0-9_]{0,64}(?:API_KEY|TOKEN|SECRET|PASSWORD))'
                          r'["\']?[ \t]*' + SEPARATOR + r'[ \t]*["\'`]?([^"\'`\s,;]{12,})')
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
# A type name: capitalized words, no digit (apiKey: ApiKeyUsageRow,). Since the value ends at `,` and `;` (#283 B2),
# the comma no longer drops it. Unlike redact, the scanner drops it in any context for key and token names: with the
# context rule of redact (TB-193) a locale label ("accessToken": "<one German word>",) and a type line with no `;`
# (apiKey: <type>) became two new errors in HR_Helper-v2 (measured on 15.11).
TYPE_NAME = re.compile(r'^(?:[A-Z][a-z]+)+$')
# TB-193 B, TB-195: a password or a secret is chosen by a person and may be words, capitalized
# (CorrectHorseBatteryStaple) or lowercase (correcthorsebatterystaple). For these names neither the type name nor
# lowercase words drop the value; a camelCase name with a capital inside (jwtSecret) and `undefined` stay code. The
# passwordAssignment of redact has no filter, its passphrase rule drops the same code.
PASSWORD_NAME = re.compile(r'(?i)(?:password|passwd|pwd|secret)$')
HUMPED_WORD = re.compile(r'^[a-z]+(?:[A-Z][a-z0-9]*)+$')
# Words carry less entropy than a key (correcthorsebatterystaple: 3.36). After a password name a letters-only value of
# 20+ characters needs 3.0; a shorter one is mostly a word or a placeholder (passwordhash: 2.86) and needs 3.5.
PASSPHRASE = re.compile(r'^[A-Za-z]{20,}$')
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
    punctuation, and is not a dotted name, words joined by _ or -, or a short camelCase or type name."""
    if not secret_chars(value):
        return False
    return not (len(value) < 32 and (CAMEL_WORD.match(value) or TYPE_NAME.match(value)))


def looks_like_password(value):
    """TB-193 B, TB-195: the filter for password and secret names, as `looksLikePassphrase` of redact but with no
    type name rule. Code stays out (a camelCase name with a capital inside, `undefined`, a dotted name, code
    punctuation); capitalized or lowercase words are caught."""
    if not secret_chars(value) or value == 'undefined':
        return False
    return len(value) >= 32 or not HUMPED_WORD.match(value)


def secret_chars(value):
    """8+ printable ASCII characters, no code punctuation, not a dotted name or words joined by _ or -."""
    if len(value) < 8 or not PRINTABLE.match(value) or CODE_CHARS.search(value):
        return False
    return not (DOTTED_NAME.match(value) or JOINED_WORDS.match(value))


# A character that drops every value holding it in `secret_chars`. A `>` right after `=` is the separator `=>` of
# an inner name, not code.
DROPS_VALUE = re.compile(r'[(){}\[\];,<\\]|(?<!=)>|[^\x21-\x7e]')
NAME_CHARS = frozenset('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')
# A name of at most 64 + 11 characters, a separator and a key of at most ~170 characters.
INNER_TAIL = 256


def resume_offset(value, reported):
    """TB-198, as `collectGroup` of redact: where in the value the search for the next name goes on, or None.

    - A rejected value: after its last DROPS_VALUE character, which drops every inner value too. With no such
      character, in its last INNER_TAIL characters: unlike redact, a part of the value may pass where the whole
      failed (the entropy floor, a placeholder word in its first part). An inner name with a key fits in the tail.
      An inner match may end after the outer value, its separator past a space or a quote
      (A_TOKEN=x(B_TOKEN = LONGER_C_TOKEN = <v>): the restart counts from the inner value, so the name in it is
      read. From the value's start a run of `A_TOKEN:=` nested one inner value per name: 64 000 characters took
      20 s.
    - A reported value: at the run of name characters that ends it (a final `:` or `=` aside). That name has its
      separator after the value, past a space or a quote (A_SECRET=fooB_SECRET: <v>)."""
    if not reported:
        last = None
        for m in DROPS_VALUE.finditer(value):
            last = m.end()
        return last or max(0, len(value) - INNER_TAIL)
    end = len(value) - 1 if value.endswith((':', '=')) else len(value)
    start = end
    while start > 0 and value[start - 1] in NAME_CHARS:
        start -= 1
    return start if start < end else None


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
        m = rx.search(line)
        while m:
            value = m.group(2)
            if PASSWORD_NAME.search(m.group(1)):
                shaped, floor = looks_like_password(value), 3.0 if PASSPHRASE.match(value) else 3.5
            else:
                shaped, floor = looks_like_secret(value), 3.5
            reported = not (covered(m, 2) or PLACEHOLDER.search(value) or not shaped or entropy(value) < floor)
            if reported:
                found.append(('literal %s' % m.group(1).lower(), value))
                spans.append(m.span(2))
            offset = resume_offset(value, reported)
            m = rx.search(line, m.end() if offset is None else max(m.start() + 1, m.start(2) + offset))
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
