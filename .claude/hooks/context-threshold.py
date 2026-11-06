#!/usr/bin/env python3
"""
Бюджет окна наследника — PostToolUse hook (решение владельца 06.11; фиксированный порог 80 % от 30.10 снят).

Для каждой сессии на лету считает потолок контекста: 100 % — точка автосжатия W_eff (по истории; иначе 213/250
окна — при окне 250K сжатие на 213–221K), передачи до 85 % нет; дальше — «передай сейчас», если контекст +
остаток задачи + цена передачи не влезают в 98,5 %, и страховка на 98,5 % − H при любых оценках. Логика, CLI
сессии (`next` / `done` / `status`) и learn — `ctx_budget.py`: в каноническом доме `eval/tools/`, в инстансе HR —
`.claude/scripts/`; spawn_session.sh — рядом с ним или в checkout tAIBE (`$TAIBE_ROOT`).

Тексты: `<successor-budget>` — «можно закончить текущую / взять следующую», `<successor-threshold>` — «передай
сейчас» с шагами (метку читает learn: от неё считается цена передачи). Печать — только при смене решения;
после сжатия или /clear (резкое падение контекста) состояние сбрасывается. Контекст больше настроенного окна —
окно определено неверно (сессия 1M), а не сигнал передачи: окно 1M по пометке модели или по самому U.

Цена: хук срабатывает на каждый вызов инструмента — транскрипт читается, только когда вырос на 24 KB (с 80 % —
на 6 KB) или на границе незаявленной задачи (git commit, gh pr create, смена статуса карточки), и только хвост
400 KB. Состояние — `~/.claude/ctx-budget/sessions/<sid>.json` под flock: из параллельных вызовов печатает один.
Выключить: SUCCESSOR_AUTO=off (или переключатель продукта successorAuto). Fail-safe: ошибка → пусто, exit 0.
"""
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BUDGET_PATHS = ("eval/tools/ctx_budget.py", ".claude/scripts/ctx_budget.py")
GATE_BYTES, GATE_BYTES_HIGH = 24_000, 6_000
GIT_COMMIT_RE = re.compile(r"\bgit\b(?:\s+-[Cc]\s+\S+)*\s+commit\b")
GH_PR_RE = re.compile(r"\bgh\s+pr\s+create\b")
CARD_TOOLS = ("update_task_status", "move_task")


def load_budget():
    for rel in BUDGET_PATHS:
        path = REPO_ROOT / rel
        if path.is_file():
            spec = importlib.util.spec_from_file_location("ctx_budget", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod, rel
    return None, None


def spawn_cmd(role):
    local = REPO_ROOT / "eval/tools/spawn_session.sh"
    base = ("bash eval/tools/spawn_session.sh" if local.exists()
            else "bash ${TAIBE_ROOT:-$HOME/Desktop/Development/tAIBE}/eval/tools/spawn_session.sh")
    role_arg = (" --role " + role) if role and role != "-" else " [--role <ключ реестра> — роль Т3]"
    return base + " --handoff <файл>" + role_arg


def steps(role):
    return (
        "1) доведи текущий шаг до точки сохранения: WIP — коммитом в свою ветку, не в main;\n"
        "2) состояние: work_state_write (now / waiting / next / blockers); роль Т3 — ещё forest_set_work_state;\n"
        "3) handoff по скиллу successor-handoff в постоянный файл (не scratchpad): снимок на сейчас, ids — PR, "
        "ветка@голова, пункты очереди, карточки; команды прямо в тексте;\n"
        "4) наследник (если эта сессия его ещё не открыла — второго не открывай): `%s` из своей рабочей папки "
        "(наследник откроется в ней же; другая — `--cwd`) — новое окно Terminal с claude (без окна: "
        "`--terminal print` печатает команду);\n"
        "5) дождись от наследника подтверждения приёма (SendMessage), передай ему свои пункты очереди и остановись.\n"
        % spawn_cmd(role))


def render(cb, v, role, cli):
    if v["kind"] == "ok":
        tail = ("Объяви её: `%s next \"<задача>\" --size S|M|L|<n%%>`." % cli) if v["boundary"] else (
            "Закончишь — `%s done`; новую — только через `%s next \"<задача>\" --size …`." % (cli, cli))
        return "<successor-budget>Бюджет окна: %s. %s</successor-budget>" % (cb.line(v), tail)
    if v["kind"] == "safety" and v["handoff_said"]:
        return ("<successor-threshold>%s. Если наследник ещё не открыт — handoff и `%s` из своей папки сейчас, "
                "до следующего шага.</successor-threshold>" % (cb.line(v), spawn_cmd(role)))
    return ("<successor-threshold>%s (100 %% — точка автосжатия ≈ %dK, окно %dK). Новых шагов не начинай. "
            "По порядку:\n%sБюджет: `%s status`. Выключить: SUCCESSOR_AUTO=off.</successor-threshold>" % (
                cb.line(v), v["weff"] // 1000, v["window"] // 1000, steps(role), cli))


def auto_boundary(payload):
    """Граница незаявленной задачи по вызову инструмента: карточка, PR, коммит; None — не граница."""
    name = str(payload.get("tool_name") or "")
    if name.endswith(CARD_TOOLS) and "boards" in name:
        return "card"
    if name == "Bash":
        cmd = str((payload.get("tool_input") or {}).get("command") or "")
        if "ctx_budget.py" in cmd:
            return None  # next/done двигают границу сами
        if GH_PR_RE.search(cmd):
            return "pr"
        if GIT_COMMIT_RE.search(cmd):
            return "commit"
    return None


def pipeline_on(name):
    """The product's switch (tAI-Boards → workspace settings → «Pipeline & evolution»); errors → on."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
        import pipeline_settings
        return pipeline_settings.enabled(name, refresh=False)
    except Exception:  # noqa: BLE001 — a hook never fails on settings
        return True


def check(cb, cli, payload, now):
    sid = cb.safe_sid(payload.get("session_id"))
    transcript = Path(payload.get("transcript_path") or "")
    if not sid or not transcript.is_file():
        return None
    size = transcript.stat().st_size
    boundary = auto_boundary(payload)
    peek = cb.load_state(sid)
    gate = GATE_BYTES_HIGH if float(peek.get("s") or 0) >= 0.8 else GATE_BYTES
    if not boundary and abs(size - int(peek.get("size") or 0)) < gate:
        return None
    if not peek:
        cb.prune(now)
    with cb.session_lock(sid):
        st = cb.load_state(sid)
        st["size"], st["transcript"] = size, str(transcript)
        # After the cheap exits, and from the cache only: this hook runs on every tool call; the prompt hook refreshes.
        u, model = cb.last_answer(transcript) if pipeline_on("successorAuto") else (None, None)
        if u is None:
            cb.save_state(sid, st)
            return None
        params, window = cb.load_params(), cb.window_for(st, u, model)[0]
        weff = cb.refresh(st, sid, u, window, params, now)
        task = st["task"]
        if boundary and not task.get("explicit") and (u - task["u0"]) / weff >= cb.BOUNDARY_PHASE:
            t, src = cb.task_estimate(st["role"], params)
            cb.start_task(st, sid, u, weff, t, src, False, now)
        v = cb.verdict(st, u, window, params)
        text = None
        if v["key"] and v["key"] not in st["printed"] and not (v["kind"] == "ok" and v["handoff_said"]):
            text = render(cb, v, st["role"], cli)
            st["printed"].append(v["key"])
        cb.remember(st, v, now)
        cb.save_state(sid, st)
        return text


def main():
    if os.environ.get("SUCCESSOR_AUTO", "").lower() in ("off", "0", "false"):
        return
    payload = json.load(sys.stdin)
    cb, rel = load_budget()
    if cb is None or not isinstance(payload, dict):
        return
    text = check(cb, "python3 " + rel, payload, time.time())
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}},
                         ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-safe: бюджет — подсказка, а не гейт
    sys.exit(0)
