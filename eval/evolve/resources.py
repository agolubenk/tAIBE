#!/usr/bin/env python3
"""The machine's and the owner's limits for the daily run: other heavy jobs, the one lock every entry point shares,
and the Claude judge ceiling. No local model is ever loaded (owner rule `memory/no-local-ollama.md`), so there is no
memory or swap gate. Stdlib only.

- HEAVY_JOBS (launchd labels of other nightly work, notebook sync at 04:17) running: the run waits for them.
- One lock (`flock` on `<state>/run.lock`) for `daily.sh run`, `daily.py nightly` and `daily.py cycle --force`: taken
  atomically by the kernel, released when the process dies, so there is no stale lock and no window between a check
  and a take. `nightly` keeps it across the refresh and hands the open descriptor to the fresh `cycle`.
- `Budget`: Claude judge calls and tokens per night (calibration and A/B together). The headless session keeps its
  own limits (turns, dollars, minutes in `daily_steps`).
"""
import fcntl
import os
import re
import subprocess
import time

HEAVY_JOBS = ('space.hrhelper.t-boards-notebook-sync', 'space.hrhelper.t-boards-backup')
HEAVY_WAIT_MIN = 30
# Judge ceiling per night (council of 06.11): about 137 calls for a full first night with two artifacts.
JUDGE_MAX_CALLS = 160
JUDGE_MAX_TOKENS = 1_200_000
MAX_ARTIFACTS = 2         # artifacts judged per night; the rest stay pending
CLAUDE_MAX_CALLS, CLAUDE_MAX_TOKENS = JUDGE_MAX_CALLS, JUDGE_MAX_TOKENS  # the Budget defaults


def _run(*cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return out.stdout if out.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def heavy_running(labels=HEAVY_JOBS):
    """Labels of other heavy launchd jobs running now."""
    uid = os.getuid()
    return [label for label in labels if re.search(r'^\s+state = running', _run('launchctl', 'print',
                                                                                  'gui/%d/%s' % (uid, label)), re.M)]


def wait_for_heavy(log, minutes=HEAVY_WAIT_MIN, probe=heavy_running, pause=60):
    """True when no heavy job runs (now or within `minutes`); False — the night is skipped."""
    for _ in range(max(1, minutes)):
        busy = probe()
        if not busy:
            return True
        log('waiting for %s' % ', '.join(busy))
        time.sleep(pause)
    return not probe()


class Lock:
    """The run's one lock: `with Lock(path):` or `Lock(path, fd=n)` for a descriptor handed over by `nightly`."""

    def __init__(self, path, fd=None):
        self.path, self.fd = path, fd

    def __enter__(self):
        if self.fd is None:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # the same open file description: re-taking is a no-op
        except BlockingIOError:
            os.close(self.fd)
            self.fd = None
            raise RuntimeError('another evolve run holds %s' % self.path) from None
        os.ftruncate(self.fd, 0)
        os.write(self.fd, str(os.getpid()).encode())
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


class Budget:
    """Claude judge calls and tokens spent tonight. `check` refuses a call whose estimate does not fit; `charge` books
    the real tokens of a call and keeps the worst ratio of real to estimated tokens seen tonight, which `covers` then
    applies to an estimate of many calls."""

    def __init__(self, calls=CLAUDE_MAX_CALLS, tokens=CLAUDE_MAX_TOKENS):
        self.max_calls, self.max_tokens, self.calls, self.tokens, self.ratio = calls, tokens, 0, 0, 1.0

    def covers(self, calls, tokens):
        """True when `calls` more calls of `tokens` estimated tokens in all still fit tonight's ceiling."""
        return self.calls + calls <= self.max_calls and self.tokens + tokens * self.ratio <= self.max_tokens

    def check(self, tokens):
        if not self.covers(1, tokens):
            raise BudgetSpent('Claude ceiling for the night: %d calls, %d tokens' % (self.max_calls, self.max_tokens))

    def charge(self, tokens, estimate=0):
        self.calls += 1
        self.tokens += tokens
        if estimate:
            self.ratio = max(self.ratio, tokens / estimate)

    def spend(self, tokens):
        self.check(tokens)
        self.charge(tokens)

    def report(self):
        return {'calls': self.calls, 'tokens': self.tokens, 'max_calls': self.max_calls, 'max_tokens': self.max_tokens,
                'ratio': round(self.ratio, 2)}


class BudgetSpent(OSError):
    """An OSError, so a judge that hits the ceiling is «unavailable», never brak."""
