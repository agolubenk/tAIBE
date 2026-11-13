#!/usr/bin/env python3
"""Git and GitHub steps of the daily evolution run (`daily.py`): its own worktree, versions of a file, commits built
without a checkout, pull requests and the merge gate.

Nothing here touches a person's checkout: a commit is built from the base's tree in a temporary index, and the
run's worktree is refreshed only after `--show-toplevel` proves it is that worktree. The merge gate is the only place
that merges (review of PR #83, owner's bridge decision 06.11):

- **may merge by itself** — data (`eval/evolve/cases/*.jsonl`, `eval/evolve/verdicts.jsonl`, after the personal-data
  scan) and a revert of `.claude/skills/*/SKILL.md` or `eval/prompts/*` (not `lens-*`) to the exact blob of a
  version that is already in the base's history. Text a model wrote never merges by itself;
- **manual merge only** — rules, role cards, agents, commands, the genome with `antigens.json`, any `.py`/`.sh`,
  `eval/prompts/lens-*`, anything else;
- and only a PR this run opened (branch and head recorded in `prs.json`, `Evolve-Run:` trailer in the commit), with
  no deleted or renamed file (`git diff --name-status -M`), every check green, required checks configured on the
  base branch (none → closed), and `evolveAutoMerge` on. Stdlib only.
"""
import fnmatch
import functools
import json
import os
import subprocess
import tempfile
import time

DATA_PATHS = ('eval/evolve/cases/*.jsonl', 'eval/evolve/verdicts.jsonl')
REVERT_PATHS = ('.claude/skills/*/SKILL.md', 'eval/prompts/*.md', 'eval/prompts/*/*.md')
MANUAL_ONLY = ('eval/prompts/lens-*', '*.py', '*.sh', '.claude/rules/*', '*CLAUDE.md', '.claude/agents/*',
               '.claude/commands/*', 'eval/pipeline/genome/*', '.claude/hooks/*', '.claude/scripts/*',
               '.claude/settings*', '.claude/merge-guard*', '.github/*', 'eval/evolve/budget.json', '*.plist')
BRANCH_PREFIX = 'evolve/'
TRAILER = 'Evolve-Run: '
MAX_MERGE_FILES = 12
OPEN_PRS_LIMIT = 50       # SE-63: `gh pr list --limit`; a full list may hide an evolve PR — closed on doubt
OPEN_PRS_TRIES = 3        # one call and two retries before «GitHub did not answer»
OPEN_PRS_PAUSE_S = 5
NET_TIMEOUT_S = 60        # one gh or git-fetch call: a hung network call must not hold the night's lock (SE-49)


def run_net(cmd, **kw):
    """A network call (gh, git fetch) with `NET_TIMEOUT_S`; a hang becomes RuntimeError, so the step fails and the
    night goes on instead of holding `run.lock` until someone kills it."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=NET_TIMEOUT_S, **kw)
    except subprocess.TimeoutExpired:
        raise RuntimeError('%s: no answer in %d s' % (' '.join(cmd[:3]), NET_TIMEOUT_S)) from None


def git(repo, *args, env=None, check=True, data=None):
    run = run_net if args[:1] == ('fetch',) else functools.partial(subprocess.run, capture_output=True, text=True)
    out = run(['git', '-C', repo, *args], input=data, env=dict(os.environ, **env) if env else None)
    if check and out.returncode != 0:
        raise RuntimeError('git %s: %s' % (' '.join(args[:3]), out.stderr.strip()[:300]))
    return out.stdout if out.returncode == 0 else None


def main_repo(path):
    """The repository's main checkout (where `.git` lives), from any of its worktrees."""
    common = git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir').strip()
    return os.path.dirname(common)


def fetch(repo, base):
    git(repo, 'fetch', '--quiet', 'origin', base)
    return git(repo, 'rev-parse', 'origin/%s' % base).strip()


def own_worktree(path):
    """Is `path` the top of its own git worktree? (A folder inside another checkout answers with that checkout's
    top, and a checkout/clean there would hit a person's work.)"""
    top = git(path, 'rev-parse', '--show-toplevel', check=False)
    return bool(top) and os.path.realpath(top.strip()) == os.path.realpath(path)


def refresh_worktree(repo, rel, base):
    """The run's own worktree, detached on a fresh `origin/<base>`; created when missing. Returns its HEAD.
    Refuses (no checkout, no clean) when the folder is not its own worktree's top."""
    head = fetch(repo, base)
    path = os.path.join(repo, rel)
    if not os.path.isdir(path):
        git(repo, 'worktree', 'add', '--quiet', '--detach', path, head)
    else:
        if not own_worktree(path):
            raise RuntimeError('%s is not its own worktree — refusing to check out or clean there' % path)
        git(path, 'checkout', '--quiet', '--force', '--detach', head)
        git(path, 'clean', '-fdq')  # untracked leftovers of a session; ignored runtime files stay
    return head


def since_day_ago(repo, base):
    """The base as it was 24 hours ago: the first run's baseline when no state is kept yet."""
    out = git(repo, 'rev-list', '-1', '--before=24 hours ago', 'origin/%s' % base, check=False)
    return (out or '').strip() or git(repo, 'rev-parse', 'origin/%s~1' % base).strip()


def short(repo, rev):
    return git(repo, 'rev-parse', '--short', rev).strip()


def changed_files(repo, since, head):
    return [p for p in git(repo, 'diff', '--name-only', since, head).splitlines() if p]


def file_at(repo, rev, path):
    """The file's text at a revision, or None when it does not exist there."""
    return git(repo, 'show', '%s:%s' % (rev, path), check=False)


def last_commit_of(repo, rev, path):
    out = git(repo, 'log', '-1', '--format=%h %s', rev, '--', path, check=False)
    return (out or '').strip()


def commit_files(repo, parent, files, message):
    """A commit on top of `parent` whose tree is the parent's with `files` ({path: text}) replaced. Built in a
    temporary index: no checkout, no HEAD moves."""
    fd, index = tempfile.mkstemp(prefix='evolve-index-')
    os.close(fd)
    os.unlink(index)  # git creates it; an empty file is not a valid index
    env = {'GIT_INDEX_FILE': index}
    try:
        git(repo, 'read-tree', parent, env=env)
        for path, text in sorted(files.items()):
            blob = git(repo, 'hash-object', '-w', '--stdin', data=text).strip()
            git(repo, 'update-index', '--add', '--cacheinfo', '100644,%s,%s' % (blob, path), env=env)
        tree = git(repo, 'write-tree', env=env).strip()
        return git(repo, 'commit-tree', tree, '-p', parent, '-F', '-', data=message).strip()
    finally:
        if os.path.exists(index):
            os.unlink(index)


def gh(repo, *args, check=True):
    out = run_net(['gh', *args], cwd=repo)
    if check and out.returncode != 0:
        raise RuntimeError('gh %s: %s' % (' '.join(args[:3]), (out.stderr or out.stdout).strip()[:300]))
    return out.stdout


def open_data_cases(repo, base, sleep=time.sleep):
    """{cases file name: PR number} for the open evolve data PRs (SE-63). Their cases wait for the merge: a new run
    that wrote them again would open a PR that conflicts with them. None when GitHub does not answer after
    `OPEN_PRS_TRIES` calls, or the list is full (`OPEN_PRS_LIMIT` rows may hide one) — closed on doubt: the caller
    writes and publishes no cases that night."""
    prs = None
    for attempt in range(OPEN_PRS_TRIES):
        try:
            prs = json.loads(gh(repo, 'pr', 'list', '--base', base, '--state', 'open', '--limit',
                                str(OPEN_PRS_LIMIT), '--json', 'number,headRefName,files') or '[]')
            break
        except (RuntimeError, OSError, ValueError):
            if attempt + 1 < OPEN_PRS_TRIES:
                sleep(OPEN_PRS_PAUSE_S)
    if prs is None or len(prs) >= OPEN_PRS_LIMIT:
        return None
    found = {}
    for pr in sorted(prs, key=lambda p: p.get('number') or 0):
        if not str(pr.get('headRefName') or '').startswith(BRANCH_PREFIX + 'data-'):
            continue
        for f in pr.get('files') or []:
            path = str(f.get('path') or '')
            if fnmatch.fnmatchcase(path, DATA_PATHS[0]) and path.count('/') == DATA_PATHS[0].count('/'):
                found.setdefault(os.path.basename(path), pr['number'])
    return found


def blob_of(repo, rev, path):
    out = git(repo, 'rev-parse', '--verify', '--quiet', '%s:%s' % (rev, path), check=False)
    return (out or '').strip() or None


def open_run_pr(repo, base, parent, files, branch, title, body, run_id, kind, expected=None):
    """Commit `files` on `parent` with the run's trailer, push `branch`, open the PR, record it in `prs.json`
    (branch, head, kind, the blobs a revert must restore). Returns the PR's URL."""
    import daily_steps as steps  # the state folder lives there
    commit = commit_files(repo, parent, files, '%s\n\n%s%s\n' % (title, TRAILER, run_id))
    git(repo, 'push', '--quiet', 'origin', '%s:refs/heads/%s' % (commit, branch))
    url = gh(repo, 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body).strip()
    prs = steps.load_json('prs.json', {})
    prs[branch] = {'head': commit, 'run': run_id, 'kind': kind, 'url': url, 'expected': expected or {}}
    steps.save_json('prs.json', prs)
    return url


def name_status(repo, base, head):
    """[(status letter, path)] of head against its merge base with `base`, renames detected."""
    out = git(repo, 'diff', '--name-status', '-M', '%s...%s' % (base, head))
    rows = []
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) >= 2:
            rows.append((parts[0][:1], parts[-1]))
    return rows


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, p) and path.count('/') == p.count('/') for p in patterns) or \
        any(fnmatch.fnmatchcase(path, p) for p in patterns if p.startswith('*') or p.endswith('*'))


def merge_class(changes, record, repo=None, base_ref=None):
    """(ok, why) for a PR's changes [(status, path)] and its record from `prs.json`."""
    if not changes:
        return False, 'no files'
    if len(changes) > MAX_MERGE_FILES:
        return False, '%d files (at most %d)' % (len(changes), MAX_MERGE_FILES)
    bad = [p for st, p in changes if st not in ('M', 'A')]
    if bad:
        return False, 'deletes or renames %s — manual merge' % ', '.join(bad)
    kind = record.get('kind')
    for _, path in changes:
        if matches(path, MANUAL_ONLY) and not (kind == 'data' and matches(path, DATA_PATHS)):
            return False, '%s is manual merge only' % path
        if kind == 'data' and not matches(path, DATA_PATHS):
            return False, '%s is not data' % path
        if kind == 'revert':
            if not matches(path, REVERT_PATHS):
                return False, '%s may not be reverted by itself' % path
            want = (record.get('expected') or {}).get(path)
            if not want or not want.get('blob') or not want.get('from'):
                return False, '%s: no recorded version to restore' % path
            if repo and git(repo, 'merge-base', '--is-ancestor', want['from'], base_ref, check=False) is None:
                return False, '%s: the restored version is not in the base\'s history' % path
        if kind not in ('data', 'revert'):
            return False, 'a %s PR waits for a person' % (kind or 'unknown')
    return True, 'paths in the safe class'


def checks_green(checks):
    """(ok, why) from `gh pr checks --json name,bucket`: at least one check, every one passed or skipped."""
    if not checks:
        return False, 'no checks ran'
    bad = [c['name'] for c in checks if c.get('bucket') not in ('pass', 'skipping')]
    if bad:
        return False, 'not green: %s' % ', '.join(sorted(bad))
    if not any(c.get('bucket') == 'pass' for c in checks):
        return False, 'every check skipped'
    return True, '%d checks green' % len(checks)


def required_checks(repo, base):
    """Names of the status checks the base branch requires (branch protection or rulesets); [] — none."""
    slug = gh(repo, 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner', check=False).strip()
    if not slug:
        return []
    names = []
    out = gh(repo, 'api', 'repos/%s/branches/%s/protection/required_status_checks' % (slug, base), check=False)
    try:
        names += json.loads(out or '{}').get('contexts') or []
    except ValueError:
        pass
    out = gh(repo, 'api', 'repos/%s/rules/branches/%s' % (slug, base), check=False)
    try:
        for rule in json.loads(out or '[]'):
            if rule.get('type') == 'required_status_checks':
                names += [c.get('context') for c in (rule.get('parameters') or {}).get('required_status_checks', [])]
    except (ValueError, AttributeError):
        pass
    return sorted(n for n in set(names) if n)


def superseded(verdicts, body):
    """A revert PR whose verdict was later marked brak (a session review) must not merge."""
    marker = 'evolve-verdict: '
    vid = next((ln.split(marker, 1)[1].strip() for ln in (body or '').splitlines() if marker in ln), None)
    return bool(vid) and any(v.get('supersedes') == vid and v.get('status') != 'accepted' for v in verdicts)


def merge_ready(repo, base, verdicts, enabled, records, dry=False):
    """Merge the run's own open PRs that pass every gate, through `gh pr merge --auto --match-head-commit`.
    Returns one row per PR the run opened."""
    raw = gh(repo, 'pr', 'list', '--base', base, '--state', 'open', '--limit', '50',
             '--json', 'number,headRefName,headRefOid,isDraft,body,url')
    required = None
    rows = []
    for pr in json.loads(raw or '[]'):
        record = records.get(pr['headRefName'])
        if not pr['headRefName'].startswith(BRANCH_PREFIX) or not record:
            continue  # not this run's branch: never looked at
        row = {'pr': pr['url'], 'branch': pr['headRefName'], 'merged': False}
        rows.append(row)
        if pr.get('isDraft') or pr['headRefOid'] != record.get('head'):
            row['why'] = 'draft, or the head is not the commit this run pushed'
            continue
        git(repo, 'fetch', '--quiet', 'origin', base, pr['headRefName'], check=False)
        message = git(repo, 'log', '-1', '--format=%B', pr['headRefOid'], check=False) or ''
        if '%s%s' % (TRAILER, record.get('run')) not in message:
            row['why'] = 'the commit has no trailer of this run'
            continue
        changes = name_status(repo, 'origin/%s' % base, pr['headRefOid'])
        ok, why = merge_class(changes, record, repo, 'origin/%s' % base)
        if ok and record.get('kind') == 'revert':
            for path, want in (record.get('expected') or {}).items():
                if blob_of(repo, pr['headRefOid'], path) != want.get('blob'):
                    ok, why = False, '%s is not the recorded version' % path
        if ok and superseded(verdicts, pr.get('body')):
            ok, why = False, 'its verdict was marked brak later'
            if not dry:
                gh(repo, 'pr', 'close', str(pr['number']), '--comment', 'evolve: the verdict behind this PR was '
                   'marked brak on review — closed, nothing applied.', check=False)
        if ok:
            checks = json.loads(gh(repo, 'pr', 'checks', str(pr['number']), '--json', 'name,bucket',
                                   check=False) or '[]')
            ok, why = checks_green(checks)
        if ok:
            required = required_checks(repo, base) if required is None else required
            if not required:
                ok, why = False, 'the base branch requires no checks — auto-merge stays closed'
        if ok and not enabled:
            ok, why = False, 'evolveAutoMerge is off (or the settings could not be read) — waits for a person'
        if ok and dry:
            ok, why = False, 'would merge (dry run)'
        elif ok:
            try:
                out = run_net(['gh', 'pr', 'merge', str(pr['number']), '--auto', '--squash', '--delete-branch',
                               '--match-head-commit', pr['headRefOid']], cwd=repo)
                ok = out.returncode == 0
                why = 'merged (auto)' if ok else 'gh refused: %s' % (out.stderr or out.stdout).strip()[:200]
            except RuntimeError as e:  # no answer: the next night sees the PR again
                ok, why = False, str(e)
        row.update(merged=ok, why=why)
    return rows
