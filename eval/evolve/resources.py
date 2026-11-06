#!/usr/bin/env python3
"""The machine's limits for the daily run (review of PR #83, resources lens): memory before a model loads, swap,
other heavy jobs, the Claude call ceiling, and the one lock every entry point shares. Stdlib only.

- A local model is loaded only when `size × MODEL_OVERHEAD` fits the available memory (free + inactive pages from
  `vm_stat`) minus RESERVE_GB for the person's own work.
- Swap used over SWAP_STOP of its total stops the night.
- HEAVY_JOBS (launchd labels of other nightly work, notebook sync at 04:17) running: the run waits for them.
- One lock (`flock` on `<state>/run.lock`) for `daily.sh run`, `daily.py nightly` and `daily.py cycle --force`: taken
  atomically by the kernel, released when the process dies, so there is no stale lock and no window between a check
  and a take. `nightly` keeps it across the refresh and hands the open descriptor to the fresh `cycle`.
"""
import fcntl
import json
import os
import re
import subprocess
import time
import urllib.request

MODEL_OVERHEAD = 1.2      # weights plus KV cache and runtime buffers
RESERVE_GB = 6            # left for the person's own work at any hour
SWAP_STOP = 0.8
HEAVY_JOBS = ('space.hrhelper.t-boards-notebook-sync', 'space.hrhelper.t-boards-backup')
HEAVY_WAIT_MIN = 30
CLAUDE_MAX_CALLS = 80     # Claude judge calls plus the session, per night
CLAUDE_MAX_TOKENS = 600_000


def _run(*cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return out.stdout if out.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def available_bytes(vm_stat=None):
    """Free + inactive memory in bytes from `vm_stat` (macOS); None when it cannot be read."""
    text = _run('vm_stat') if vm_stat is None else vm_stat
    page = re.search(r'page size of (\d+) bytes', text)
    pages = {k: int(v) for k, v in re.findall(r'Pages (free|inactive):\s+(\d+)', text)}
    if not page or 'free' not in pages:
        return None
    return (pages['free'] + pages.get('inactive', 0)) * int(page.group(1))


def swap_share(swapusage=None):
    """Used share of swap from `sysctl vm.swapusage`; 0 when there is no swap or it cannot be read."""
    text = _run('sysctl', '-n', 'vm.swapusage') if swapusage is None else swapusage
    total, used = (re.search(r'%s = ([\d.]+)M' % k, text) for k in ('total', 'used'))
    if not total or not used or float(total.group(1)) == 0:
        return 0.0
    return float(used.group(1)) / float(total.group(1))


def fits(size_bytes, available=None):
    """(ok, why) — may a model of this size load now?"""
    free = available_bytes() if available is None else available
    if free is None:
        return True, 'memory unknown'
    need = size_bytes * MODEL_OVERHEAD
    room = free - RESERVE_GB * 2 ** 30
    if need > room:
        return False, 'needs %.1f GB, %.1f GB available after the %d GB reserve' % (need / 2 ** 30, room / 2 ** 30,
                                                                                   RESERVE_GB)
    return True, 'fits'


def loaded(ollama):
    """Model names Ollama holds in memory now ([] when it does not answer)."""
    try:
        with urllib.request.urlopen(ollama.rstrip('/') + '/api/ps', timeout=10) as resp:  # noqa: S310 — local
            return [m['name'] for m in json.loads(resp.read().decode('utf-8')).get('models', [])]
    except Exception:  # noqa: BLE001
        return []


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
    """Claude calls and tokens spent tonight; `spend` raises once the ceiling is reached."""

    def __init__(self, calls=CLAUDE_MAX_CALLS, tokens=CLAUDE_MAX_TOKENS):
        self.max_calls, self.max_tokens, self.calls, self.tokens = calls, tokens, 0, 0

    def spend(self, tokens):
        if self.calls + 1 > self.max_calls or self.tokens + tokens > self.max_tokens:
            raise BudgetSpent('Claude ceiling for the night: %d calls, %d tokens' % (self.max_calls, self.max_tokens))
        self.calls += 1
        self.tokens += tokens

    def report(self):
        return {'calls': self.calls, 'tokens': self.tokens, 'max_calls': self.max_calls, 'max_tokens': self.max_tokens}


class BudgetSpent(OSError):
    """An OSError, so a judge that hits the ceiling is «unavailable», never brak."""
