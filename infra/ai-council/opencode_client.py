#!/usr/bin/env python3
"""Клиент opencode для ревью PR по линзам (решение владельца 13.11: ревью — opencode, затем GLM, затем Claude).

Тот же интерфейс, что у облачного клиента консилиума: `chat(scope, purpose, model, messages, …)` → объект с полями
`ok`, `text`, `error`, `data`. Поэтому `glm_pr_review.run_review` гоняет те же линзы и части диффа, а отчёт
остаётся прежним (`--backend opencode`).

* Один процесс opencode на весь Mac: машинный flock `~/.local/state/taibe/review-chain/opencode.lock`.
  V2 поднимает свой сервер на каждый `opencode run`, а сессий на Mac 6–7 — параллельно память не выдержит.
* Агент `taibe-review` (`infra/opencode/agents/taibe-review.md`, ставит `infra/opencode/install.sh`) запрещает все
  инструменты: рецензент видит только дифф из промпта. Запуск — во временной папке, проектные AGENTS.md
  не грузятся (`OPENCODE_DISABLE_PROJECT_CONFIG=1`), лишних токенов на каждую линзу нет.
* Лимит определяется только по stderr и коду выхода, не по тексту модели: в диффе бывают «rate limit» и «429».
  Текст ошибки исчерпания у opencode не документирован (13.11) — шаблон шире, чем нужно, и это безопасно:
  ложная «квота» останавливает только этот прогон, следующий начинает с opencode снова (общей отметки нет).
* memguard не в «ok»/«warn» — opencode не запускается: память важнее ревью, линзы уходят к GLM.

Ошибки начинаются с меток, которые понимает `glm_pr_review.classify_failure`:
«квота подписки opencode» → quota, «облако выключено: opencode …» → config, «исчерпан запас памяти» → budget,
«HTTP 504 opencode» → provider (таймаут), остальное → other.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

STATE_DIR = Path(os.environ.get("REVIEW_CHAIN_STATE", "~/.local/state/taibe/review-chain")).expanduser()
MEMGUARD_STATE = Path(os.environ.get("MEMGUARD_STATE", "~/.claude/memguard/state.json")).expanduser()
MEMGUARD_OK = ("ok", "warn", "")
QUOTA_RE = re.compile(r"usage limit|limit (reached|exceeded)|quota|insufficient|allowance|billing|exceeded your|"
                      r"\b(402|429)\b|too many requests", re.I)
AUTH_RE = re.compile(r"not (logged|authenticated)|no (api )?key|unauthori[sz]ed|\b401\b|auth login|"
                     r"no provider|model .* not found|unknown model", re.I)
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
ENV_KEEP = ("HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM")


@dataclass
class Result:
    ok: bool
    text: str = ""
    error: str = ""
    data: dict | None = None


def memguard_level(path: Path | None = None) -> str:
    try:
        path = path or MEMGUARD_STATE
        return str(json.loads(path.read_text()).get("level", ""))
    except (OSError, ValueError):
        return ""


def classify_stderr(code: int, err: str) -> str:
    """Ошибка запуска opencode → строка с меткой для classify_failure."""
    tail = (err or "").strip()[-300:]
    if QUOTA_RE.search(err or ""):
        return f"квота подписки opencode: {tail}"
    if AUTH_RE.search(err or ""):
        return f"облако выключено: opencode без входа или модели ({tail})"
    return f"opencode код {code}: {tail}"


class OpencodeClient:
    def __init__(self, binary: str = "opencode", agent: str = "taibe-review", timeout: int = 330,
                 lock_path: Path | None = None, runner=subprocess.Popen, clock=time.monotonic, killer=None):
        self.binary = binary
        self.agent = agent
        self.timeout = timeout
        self.lock_path = lock_path or STATE_DIR / "opencode.lock"
        self.runner = runner
        self.clock = clock
        self.killer = killer or _kill_group
        self.max_retries = 0        # совместимость с облачным клиентом: повторы задаёт run_review по частям

    def chat(self, scope: str, purpose: str, model: str, messages: list, temperature: float = 0.2,
             max_tokens: int = 6000) -> Result:
        level = memguard_level()
        if level not in MEMGUARD_OK:
            return Result(False, error=f"исчерпан запас памяти: memguard {level}, opencode не запускаю")
        exe = shutil.which(self.binary)
        if not exe:
            return Result(False, error="облако выключено: opencode не установлен (пункт владельца s-opencode-1311)")
        prompt = "\n\n".join(f"[{m['role']}]\n{m['content']}" for m in messages)
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+") as lock:
            if not self._wait_lock(lock):
                return Result(False, error=f"HTTP 504 opencode: замок {self.lock_path} занят дольше {self.timeout} с")
            lock.seek(0)
            lock.truncate()
            lock.write(f"{os.getpid()} {purpose}\n")
            lock.flush()
            return self._run([exe, "run", "--agent", self.agent, "--model", model, prompt])

    def _wait_lock(self, lock) -> bool:
        deadline = self.clock() + self.timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                if self.clock() >= deadline:
                    return False
                time.sleep(0.5)

    def _run(self, argv: list) -> Result:
        # Только то, что нужно opencode: секреты сессии (ключи, токены) рецензенту не передаются.
        env = {k: v for k, v in os.environ.items() if k in ENV_KEEP or k.startswith(("XDG_", "OPENCODE_", "LC_"))}
        env.update(NO_COLOR="1", OPENCODE_DISABLE_PROJECT_CONFIG="1")
        with tempfile.TemporaryDirectory(prefix="oc-review-") as cwd:
            proc = self.runner(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               stdin=subprocess.DEVNULL, text=True, start_new_session=True)
            try:
                out, err = proc.communicate(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                self.killer(proc)
                return Result(False, error=f"HTTP 504 opencode: нет ответа за {self.timeout} с")
        out = ANSI_RE.sub("", out or "").strip()
        if proc.returncode != 0:
            return Result(False, text=out[:3000], error=classify_stderr(proc.returncode, err))
        if not out:
            if QUOTA_RE.search(err or ""):
                return Result(False, error=classify_stderr(0, err))
            return Result(False, error=f"opencode: пустой ответ ({(err or '').strip()[-200:]})")
        return Result(True, text=out)


def _kill_group(proc) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        proc.kill()
    proc.wait()
