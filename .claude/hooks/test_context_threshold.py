#!/usr/bin/env python3
"""Хук бюджета окна (context-threshold.py) и пусковой скрипт spawn_session.sh — без сети и без окон.

Правила бюджета (примеры владельца 06.11, сброс, learn) проверяет test_ctx_budget.py рядом с ctx_budget.py;
здесь — сам хук: модуль найден, границы задач, окно, текст передачи, гонки, выключатель, состояние вне репозитория.
Запуск: python3 -I .claude/hooks/test_context_threshold.py  (exit 1 при расхождении).
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).resolve().parent
REPO = HOOKS.parents[1]
spec = importlib.util.spec_from_file_location("ct", HOOKS / "context-threshold.py")
ct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ct)
cb, rel = ct.load_budget()
bad = []
done = [0]


def check(name, got, want):
    done[0] += 1
    if got != want:
        bad.append((name, got, want))


def line(kind, tokens, sidechain=False):
    usage = {"input_tokens": 2, "cache_read_input_tokens": tokens - 102, "cache_creation_input_tokens": 50,
             "output_tokens": 50}
    return json.dumps({"type": kind, "isSidechain": sidechain, "message": {"usage": usage}}) + "\n"


def bash(cmd):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}}


check("модуль бюджета найден", rel in ct.BUDGET_PATHS, True)
# границы незаявленной задачи: коммит, PR, статус карточки; CLI бюджета и прочее — не граница
check("граница: git commit", ct.auto_boundary(bash("git -C wt commit -m 'x'")), "commit")
check("граница: gh pr create", ct.auto_boundary(bash("git push && gh pr create --base main")), "pr")
check("граница: карточка", ct.auto_boundary({"tool_name": "mcp__hub__t-boards_1mcp_update_task_status"}), "card")
check("не граница: git status", ct.auto_boundary(bash("git status && git log -1")), None)
check("не граница: CLI бюджета", ct.auto_boundary(bash("python3 eval/tools/ctx_budget.py next 'git commit' --size S")),
      None)

for knob in ("SUCCESSOR_WINDOW_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "SUCCESSOR_AUTO", "T3_ROLE_KEY",
             "TAIBE_LINEAGE", "TAIBE_PIPELINE", "CTX_BUDGET_DIR"):
    os.environ.pop(knob, None)  # экспортированные в оболочке ручки не должны менять ожидания теста

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    tr = tmp / "t.jsonl"
    # последний ответ основной цепочки, а не субагента и не реплика пользователя
    tr.write_text(line("assistant", 120_000) + line("assistant", 205_000) + line("assistant", 30_000, True)
                  + json.dumps({"type": "user", "message": {"content": "x"}}) + "\n", encoding="utf-8")
    check("usage основной цепочки", cb.last_context_tokens(tr), 205_000)
    (tmp / "garbage.jsonl").write_text('{"usage": oops\n', encoding="utf-8")
    check("битый хвост", cb.last_context_tokens(tmp / "garbage.jsonl"), None)

    # окно из настроек проекта, env-ручки сверху
    (tmp / ".claude").mkdir()
    (tmp / ".claude/settings.local.json").write_text('{"autoCompactWindow": 300000}', encoding="utf-8")
    os.environ["CLAUDE_PROJECT_DIR"] = str(tmp)
    check("окно из settings.local", cb.session_window()[0], 300_000)
    os.environ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = "250000"
    check("окно из env Claude Code", cb.session_window()[0], 250_000)
    os.environ["SUCCESSOR_WINDOW_TOKENS"] = "200000"
    check("окно из env хука", cb.session_window()[0], 200_000)
    del os.environ["SUCCESSOR_WINDOW_TOKENS"], os.environ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]

    # хук целиком (окно 300K, без params.json: W_eff 255,6K, H 4 %): 245K = 95,9 % ≥ 98,5 − 4 — страховка с шагами;
    # тишина без прироста; выключатель; 6 параллельных вызовов — один текст
    big = tmp / "big.jsonl"
    big.write_text(("x" * 30_000) + "\n" + line("assistant", 245_000), encoding="utf-8")
    sids = ["test-ct-%d-%d" % (os.getpid(), i) for i in range(3)]
    budget = tmp / "budget"

    def start(sid):
        return subprocess.Popen([sys.executable, "-I", str(HOOKS / "context-threshold.py")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                env=dict(os.environ, CLAUDE_PROJECT_DIR=str(tmp), CTX_BUDGET_DIR=str(budget)))

    def run(sid):
        proc = start(sid)
        return proc.communicate(json.dumps({"session_id": sid, "transcript_path": str(big)}), timeout=10)[0]

    if True:  # состояние — в tmp (CTX_BUDGET_DIR): живые сессии тест не задевает
        first = run(sids[0])
        check("хук: передача на 95,9 %", ("<successor-threshold>" in first, "95,9 %" in first, "По порядку" in first,
                                          "spawn_session.sh --handoff" in first, "80 %" in first),
              (True, True, True, True, False))
        check("хук: повтор без прироста — тишина", run(sids[0]), "")
        os.environ["SUCCESSOR_AUTO"] = "off"
        check("хук: выключатель", run(sids[1]), "")
        del os.environ["SUCCESSOR_AUTO"]
        procs = [start(sids[2]) for _ in range(6)]
        outs = [pr.communicate(json.dumps({"session_id": sids[2], "transcript_path": str(big)}), timeout=10)[0]
                for pr in procs]
        check("хук: 6 параллельных вызовов — один текст", sum("successor-threshold" in o for o in outs), 1)
        check("хук: состояние в CTX_BUDGET_DIR", (budget / "sessions" / (sids[0] + ".json")).is_file(), True)
        check("хук: состояние не в репозитории",
              any((REPO / ".claude/memory/session/successor").glob("test-ct-%d-*" % os.getpid())), False)

    # spawn_session.sh: dry-run печатает пусковой скрипт, ничего не открывает
    spawn = REPO / "supertick-eval/tools/spawn_session.sh"  # инстанс HR_Helper-v2
    if not spawn.exists():
        spawn = REPO / "eval/tools/spawn_session.sh"  # канонический дом продукта
    tree = spawn.parent.parent.name
    handoff = tmp / "handoff.md"
    handoff.write_text("# handoff\n", encoding="utf-8")
    (tmp / tree / "pipeline/genome").mkdir(parents=True)
    (tmp / tree / "pipeline/genome/release.json").write_text("{}", encoding="utf-8")
    (tmp / "roles").mkdir()
    (tmp / "roles/5-release.md").write_text("x", encoding="utf-8")

    def sh(*args, env=None):
        return subprocess.run(["/bin/bash", str(spawn), "--cwd", str(tmp), "--dry-run", *args],
                              capture_output=True, text=True, timeout=10, env=env)

    r = sh("--handoff", str(handoff))
    check("spawn: наследник без роли", (r.returncode, "Наследник сессии" in r.stdout, "--settings" in r.stdout),
          (0, True, False))
    check("spawn: пусковая папка удаляется после чтения текста", "; rm -rf '" in r.stdout, True)
    odd = tmp / "a\\b"
    odd.mkdir()
    r2 = subprocess.run(["/bin/bash", str(spawn), "--cwd", str(odd), "--dry-run", "--handoff", str(handoff)],
                        capture_output=True, text=True, timeout=10)
    check("spawn: обратный слэш в пути — отказ", r2.returncode, 2)
    r2 = subprocess.run(["/bin/bash", str(spawn), "--help"], capture_output=True, text=True, timeout=10)
    check("spawn: --help без строки кода", (r2.returncode, "set -euo" in r2.stdout), (0, False))
    r = sh("--handoff", str(handoff), "--role", "release")
    check("spawn: наследник роли", (r.returncode, "ключ реестра release, роль 5, наследник" in r.stdout,
                                     "genome/release.json" in r.stdout), (0, True, True))
    r = sh("--launch", "--role", "release", "--prompt-dir", str(tmp / "roles"))
    check("spawn: запуск роли", (r.returncode, "Пусковой файл" in r.stdout), (0, True))
    check("spawn: неизвестная роль", sh("--handoff", str(handoff), "--role", "nope").returncode, 2)
    check("spawn: нет handoff", sh("--handoff", str(tmp / "missing.md")).returncode, 2)
    check("spawn: нет генома", sh("--launch", "--role", "coord", "--prompt-dir", str(tmp / "roles")).returncode, 2)
    no_tmpdir = {k: v for k, v in os.environ.items() if k != "TMPDIR"}
    check("spawn: без TMPDIR", sh("--handoff", str(handoff), env=no_tmpdir).returncode, 0)
    r = subprocess.run(["/bin/bash", str(spawn), "--dry-run", "--handoff", str(handoff)], cwd=tmp,
                       capture_output=True, text=True, timeout=10)
    check("spawn: по умолчанию — текущая папка", "cd '%s'" % tmp.resolve() in r.stdout or "cd '%s'" % tmp in r.stdout,
          True)

for b in bad:
    print("MISMATCH", b)
print("context_threshold: %d/%d" % (done[0] - len(bad), done[0]))
sys.exit(1 if bad else 0)
