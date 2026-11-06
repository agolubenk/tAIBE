#!/usr/bin/env python3
"""Параметры бюджета окна: пути, окно сессии (настройки, пометка 1M, U больше окна), выученные W_eff / H / T —
чтение params.json и запасные значения. Решение и CLI сессии — ctx_budget.py, обучение — ctx_budget_learn.py.
Каталог бюджета — 0700, его файлы — 0600. Только stdlib.
"""
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
H_DEFAULT, T_DEFAULT = 0.04, 0.10
WEFF_FALLBACK = 213 / 250           # сжатие при окне 250K — от 213K (30.10)
DEFAULT_WINDOW = 200_000            # без autoCompactWindow, пометки 1M и U больше окна
ONE_M = 1_000_000
WINDOW_FIT = 1.02                   # U больше окна × 1,02 — окно определено неверно
H_RANGE, T_RANGE, CAL_RANGE = (0.02, 0.12), (0.01, 0.50), (1.0, 2.0)
MIN_N = 5                           # выборка меньше — запасное значение


# ---------------------------------------------------------------- места и параметры

def budget_dir():
    return Path(os.environ.get("CTX_BUDGET_DIR") or Path.home() / ".claude" / "ctx-budget")


def params_path():
    return budget_dir() / "params.json"


def projects_dir():
    return Path(os.environ.get("CTX_BUDGET_PROJECTS") or Path.home() / ".claude" / "projects")


def lineage_dir():
    return Path(os.environ.get("TAIBE_LINEAGE_DIR") or Path.home() / ".claude" / "lineage")


def private_dir(path):
    """Каталог бюджета: 0700 (журнал и состояние сессий — только владельцу), в том числе созданный раньше."""
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def load_params():
    try:
        data = json.loads(params_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def clamp(value, bounds):
    return min(max(value, bounds[0]), bounds[1])


def _n(entry):
    try:
        return int((entry or {}).get("n") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0


def _settings(project_dir):
    """Словари настроек сессии по старшинству: settings.local → settings проекта → пользовательские."""
    project = Path(project_dir or REPO_ROOT)
    for path in (project / ".claude/settings.local.json", project / ".claude/settings.json",
                 Path.home() / ".claude/settings.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            yield data


def configured_window(project_dir, use_env=True):
    """Настроенное окно или None: SUCCESSOR_WINDOW_TOKENS → CLAUDE_CODE_AUTO_COMPACT_WINDOW (env) → autoCompactWindow
    (или env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) в настройках. learn окружение не смотрит (use_env=False)."""
    values = [os.environ.get(k, "") for k in ("SUCCESSOR_WINDOW_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW")
              ] if use_env else []
    for data in _settings(project_dir):
        env = data.get("env") if isinstance(data.get("env"), dict) else {}
        values += [data.get("autoCompactWindow"), env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")]
    for value in values:
        try:
            value = int(str(value).strip())
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return None


def is_1m(model):
    """Пометка контекста 1M в имени модели: `opus[1m]`, `claude-…-1m`, `context-1m`."""
    return bool(model) and re.search(r"(?i)\[1m\]|(?:^|[-_.:\s])1m(?:$|[-_.:\]\s])", str(model)) is not None


def model_1m(project_dir, use_env=True):
    """Модель сессии из настроек с пометкой 1M: ANTHROPIC_MODEL → model в settings.local / settings / пользовательских.
    message.model в транскрипте пометки не несёт (06.11: ни одного из ~180K ответов), поэтому смотрим и сюда."""
    if use_env and os.environ.get("ANTHROPIC_MODEL"):
        return is_1m(os.environ["ANTHROPIC_MODEL"])
    for data in _settings(project_dir):
        if data.get("model"):
            return is_1m(data["model"])
    return False


def resolve_window(configured, one_m, u):
    """(окно, источник). U больше настроенного окна (×1,02) — окно определено неверно, а не сигнал передачи:
    настроенное, пока U в него влезает → модель 1M → U > окна → 1M → 200K."""
    if configured and (u is None or u <= configured * WINDOW_FIT):
        return configured, "настройки"
    if one_m:
        return ONE_M, "модель 1M"
    if u is not None and u > (configured or DEFAULT_WINDOW) * WINDOW_FIT:
        return ONE_M, "U больше окна"
    return DEFAULT_WINDOW, "по умолчанию"


def session_window(u=None, model=None, project_dir=None, use_env=True):
    """Окно живой сессии (или сессии из истории — use_env=False) по U и модели последнего ответа."""
    project = project_dir or (os.environ.get("CLAUDE_PROJECT_DIR") if use_env else None) or REPO_ROOT
    return resolve_window(configured_window(project, use_env), is_1m(model) or model_1m(project, use_env), u)


def window_tokens(project_dir=None, u=None, model=None):
    return session_window(u, model, project_dir)[0]


def w_eff(window, params):
    """(токены точки сжатия, источник): своя история окна (n ≥ 5) → доля W_eff/окно самого изученного окна
    (для 1M без истории — доля 250K, 216,9/250) → 213/250 окна."""
    table = params.get("w_eff") if isinstance(params.get("w_eff"), dict) else {}

    def fit(key, e):
        tokens = e.get("tokens") if isinstance(e, dict) else None
        return _n(e) >= MIN_N and isinstance(tokens, int) and str(key).isdigit() and 0.5 < tokens / int(key) <= 1
    if fit(window, table.get(str(window))):
        return table[str(window)]["tokens"], "история окна"
    known = [(_n(e), int(k), e["tokens"]) for k, e in table.items() if fit(k, e)]
    if known:
        _, key, tokens = max(known)
        return int(window * tokens / key), "доля %dK по истории" % (key // 1000)
    return int(window * WEFF_FALLBACK), "213/250 окна"


def _q(entry, key, bounds):
    try:
        return clamp(float(entry[key]), bounds)
    except (KeyError, TypeError, ValueError):
        return None


def handoff_cost(params):
    entry = params.get("handoff") or {}
    value = _q(entry, "p80", H_RANGE) if _n(entry) >= 3 else None
    return (value, "история") if value else (H_DEFAULT, "по умолчанию")


def task_estimate(role, params):
    """(доля W_eff, источник) для незаявленной задачи: медиана роли → медиана всех ролей → 10 %.

    Медиана, а не p80: по истории 06.11 p80 = 43 % — с ним любая незаявленная задача давала бы передачу ровно
    на 85 % (фиксированный порог), а хвост закрывает страховка s ≥ 0,985 − H."""
    tasks = params.get("tasks") or {}
    for key, src in (((role, "история роли " + role),) if role and role != "-" else ()) + (("*", "история"),):
        entry = tasks.get(key) or {}
        value = _q(entry, "median", T_RANGE) if _n(entry) >= MIN_N else None
        if value:
            return value, src
    return T_DEFAULT, "по умолчанию"


def calibration(params):
    """Множитель к заявленной оценке: медиана факт/оценка, только вверх (1–2), от 5 замеров."""
    entry = (params.get("calibration") or {}).get("declared") or {}
    try:
        return clamp(float(entry["median"]), CAL_RANGE) if _n(entry) >= MIN_N else 1.0
    except (KeyError, TypeError, ValueError):
        return 1.0


def pct(x):
    """Доля → «87», «98,5», «0,6» (проценты по-русски)."""
    v = round(x * 100, 1)
    return str(int(v)) if v == int(v) else ("%.1f" % v).replace(".", ",")
