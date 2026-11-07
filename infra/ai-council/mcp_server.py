#!/usr/bin/env python3
"""AI Council — MCP-фасад, общий для Claude Code и Continue.

Канон: docs/specs/ai-council.md §3, §10, §12.

Даёт обоим клиентам ОДИНАКОВЫЙ доступ к трём вещам, которые раньше были доступны
только руками из терминала или только внутри Claude Code:

  1. Консилиум над карточками t-boards — чтение через gateway.py (:8790, тот же HTTP API,
     что у дашборда; шлюз не запущен — тот же обработчик подпроцессом `gateway.py --get`),
     карточки — из t-boards в момент вызова (tboards.py, OPS-26), постановка в очередь —
     только через supervisor.py CLI. На доску консилиум не пишет.
  2. Жизненный цикл пайплайна (start/stop/status/doctor) — обёртка над
     infra/scripts/dev-ai/ai-tooling-pipeline.sh, тем же канон-скриптом, что и
     `npm run ai-pipeline:*`.
  3. `task_brief` — GLM RU→EN структуризация задачи. На Claude Code она уже работает
     автоматически через UserPromptSubmit-хук (.claude/hooks/user-prompt-submit.py);
     здесь — тот же .claude/scripts/glm_client.py, тот же отдельный ключ
     (.claude/rag/.glm-key / env GLM_API_KEY, General API glm-4.5-flash), но вызываемый
     ЯВНО — единственный способ получить эквивалент для Continue, у которого хуков нет
     (см. .continue/rules/00-task-ingress.md). Ключ и биллинговый маршрут у этого вызова
     — НЕ те же, что у Council (Coding Plan, .continue/.env ZAI_API_KEY): task_brief не
     расходует и не проверяет бюджет консилиума, поэтому не участвует ни в каких future
     capability-lease/router лимитах на инструменты консилиума.

Только stdlib + пакет `mcp` (уже используется локально, см. transcribe-local/briefme).
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent / ".claude" / "scripts"))

import config as config_mod  # noqa: E402
import glm_client  # noqa: E402

# Код слоя — от своего пути; cwd дочерних процессов — корень хоста (TAIBE_HOST_ROOT).
REPO_ROOT = config_mod.REPO_ROOT
PIPELINE_SCRIPT = config_mod.LAYER_ROOT / "infra" / "scripts" / "dev-ai" / "ai-tooling-pipeline.sh"
SUPERVISOR = HERE / "supervisor.py"

mcp = FastMCP("AI Council")


def _cfg():
    return config_mod.load(strict=False)


def _gateway_base() -> str:
    cfg = _cfg()
    host = cfg.get("gateway.host", "127.0.0.1")
    port = cfg.get("gateway.port", 8790)
    return f"http://{host}:{port}"


def _run(argv: list[str], timeout: int, json_out: bool = False) -> str:
    """Подпроцесс инструмента: stdout+stderr или понятный отказ по таймауту (а не исключение в клиент MCP).
    json_out — ответ JSON: при коде 0 только stdout, чтобы диагностика в stderr не ломала разбор."""
    try:
        proc = subprocess.run(argv, cwd=REPO_ROOT, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return json.dumps({"error": f"{Path(argv[1]).name}: не уложился в {timeout} с — сузьте запрос"},
                          ensure_ascii=False)
    if json_out and proc.returncode == 0 and (proc.stdout or "").strip():
        return proc.stdout.strip()
    out = (proc.stdout or "") + (proc.stderr or "")
    return out.strip() or f"(нет вывода, exit={proc.returncode})"


def _gateway_get(path: str) -> str:
    """GET на gateway.py — тот же READ API, что у дашборда. Никогда не пишет. Шлюз не запущен (фона нет с 01.11,
    Р0 б) — тот же обработчик подпроцессом `gateway.py --get <путь>`, без сокета. Шлюз запущен, но ответил ошибкой
    или не уложился — это ответ, второй раз тот же запрос подпроцессом не повторяется."""
    url = _gateway_base() + path
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return json.dumps({"error": f"AI Council gateway: HTTP {exc.code}"}, ensure_ascii=False)
    except urllib.error.URLError as exc:
        if not isinstance(exc.reason, ConnectionRefusedError):
            return json.dumps({"error": f"AI Council gateway недоступен: {type(exc.reason).__name__}"},
                              ensure_ascii=False)
    except ConnectionRefusedError:
        pass
    except OSError as exc:
        return json.dumps({"error": f"AI Council gateway: {type(exc).__name__}"}, ensure_ascii=False)
    return _run([sys.executable, str(HERE / "gateway.py"), "--get", path], timeout=60, json_out=True)


def _run_pipeline(*args: str, timeout: int = 120) -> str:
    return _run(["bash", str(PIPELINE_SCRIPT), *args], timeout)


def _run_supervisor(*args: str, timeout: int = 60) -> str:
    return _run([sys.executable, str(SUPERVISOR), *args], timeout)


# ── Headroom — сжатие длинных ответов инструментов (план §P4/Ф2) ───────────
# Тот же /health-check-с-30с-кэшем, что у cloud._headroom_alive() — не второй
# независимый контур доступности прокси. `POST /v1/compress` (без слэша, ровно
# так, как зовёт код ниже) на живом Headroom v0.34.0 отдаёт 404 — маршрута с
# таким путём в этой версии нет вовсе (не «нужен только auth»: это была неверная
# заметка, живой ретест — review-p4.md, находка #2 — показал 404 без слэша и
# 401 только с добавленным `/`, то есть тот же generic auth-error транспарентного
# LLM-прокси у `/v1/models`/`/v1/chat/completions`, не отдельный REST-сервис
# сжатия текста). Итог для этого кода одинаков в обоих случаях — сжатие сегодня
# недостижимо ни при каком Bearer-токене, который можно было бы сюда прокинуть.
# Оставлено как best-effort no-op с честным `uncompressed: true`, а не убрано —
# если в будущей версии Headroom появится реальный `/v1/compress`, поведение
# включится само; до тех пор любая неудача (сеть, таймаут, не-200, неожиданная
# форма ответа) — тихий откат на сырой текст, тот же fail-safe контракт, что в
# остальном консилиуме.
_headroom_ok = False
_headroom_checked_until = 0.0


def _headroom_alive() -> bool:
    global _headroom_ok, _headroom_checked_until
    now_ts = time.time()
    if now_ts < _headroom_checked_until:
        return _headroom_ok
    cfg = _cfg()
    if not cfg.get("models.cloud.headroom.enabled", False):
        _headroom_ok = False
    else:
        url = str(cfg.get("models.cloud.headroom.url", "http://127.0.0.1:8787")).rstrip("/")
        try:
            with urllib.request.urlopen(url + "/health", timeout=3) as resp:
                _headroom_ok = 200 <= resp.status < 300
        except (urllib.error.URLError, OSError):
            _headroom_ok = False
    _headroom_checked_until = now_ts + 30
    return _headroom_ok


def _maybe_compress(text: str) -> dict:
    """Длинный ответ инструмента → попытка Headroom, иначе сырой текст с флагом."""
    cfg = _cfg()
    threshold = int(cfg.get("sources.mcp.compress_threshold_chars", 4000))
    if len(text) <= threshold or not _headroom_alive():
        return {"text": text, "uncompressed": True}
    url = str(cfg.get("models.cloud.headroom.url", "http://127.0.0.1:8787")).rstrip("/")
    body = json.dumps({"messages": [{"role": "user", "content": text}]}).encode("utf-8")
    req = urllib.request.Request(url + "/v1/compress", data=body, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError):
        return {"text": text, "uncompressed": True}
    if not isinstance(data, dict):
        # review-p4.md, находка N1: валидный, но не-dict JSON (`[]`/`"ok"`/число)
        # раньше падал AttributeError на .get() ниже — сегодня недостижимо (Headroom
        # отдаёт 404/401 раньше этой строки, находка #2), но код должен переживать
        # и такой ответ, если/когда путь к Headroom будет исправлен.
        return {"text": text, "uncompressed": True}
    compressed = data.get("compressed") or data.get("content") or data.get("text")
    if not compressed or not isinstance(compressed, str):
        return {"text": text, "uncompressed": True}
    return {"text": compressed, "uncompressed": False}


# ── Жизненный цикл пайплайна ────────────────────────────────────────────────

@mcp.tool()
def ai_pipeline_status() -> str:
    """Статус AI-пайплайна (Ollama, Council, HEADROOM, dashboard)."""
    return _run_pipeline("status")


@mcp.tool()
def ai_pipeline_doctor() -> str:
    """Read-only диагностика готовности пайплайна (CORE/REQUIRED/SESSION/OPTIONAL)."""
    return _run_pipeline("doctor")


@mcp.tool()
def ai_pipeline_start() -> str:
    """Поднять AI-пайплайн (HEADROOM, Ollama-проверка, Council, dashboard)."""
    return _run_pipeline("start", timeout=180)


@mcp.tool()
def ai_pipeline_stop() -> str:
    """Остановить Council и dashboard (Ollama и session-scope MCP не трогает)."""
    return _run_pipeline("stop")


# ── Консилиум над карточками t-boards — чтение ─────────────────────────────

@mcp.tool()
def council_cards(db: str = "", query: str = "", limit: int = 20) -> str:
    """Карточки t-boards продукта этого хоста, строкой на карточку. query: ключ (OPS-26) или id — карточка из
    t-boards на сейчас (с описанием); текст — поиск t-boards; пусто — карточки, уже прочитанные консилиумом
    (без сети). db: bugs|tasks — для прочитанных. limit: до 50 (по умолчанию 20), ответ ≤ 6 КБ."""
    args = ["cards", "--limit", str(max(1, min(int(limit or 20), 50)))]
    if query:
        args.append(f"--q={query}")              # запрос, начинающийся с «-», argparse иначе принял бы за флаг
    if db in ("bugs", "tasks"):
        args += ["--db", db]
    return _run([sys.executable, str(HERE / "tboards.py"), *args], timeout=60)


@mcp.tool()
def council_run_detail(run_id: str) -> str:
    """Детали прогона консилиума по карточке: предложения, рецензии, вердикт верификатора."""
    return _gateway_get(f"/api/runs/{run_id}")


@mcp.tool()
def council_plan() -> str:
    """Текущий план/приоритизация (P4) — что консилиум считает следующим в работу."""
    return _gateway_get("/api/plan")


@mcp.tool()
def council_cloud_budget() -> str:
    """Расход облачного яруса (Coding Plan + платный fallback) за текущее окно/сутки."""
    return _gateway_get("/api/cloud")


@mcp.tool()
def council_knowledge_search(q: str, kind: str = "") -> str:
    """FTS5-поиск по корпусу консилиума: опыт (карточки, закрытое, принятые проработки,
    прошлые сессии) и единые знания ИИ-сервисов (правила, роли CLAUDE.md, правила Continue,
    память Claude Code и решения claude-mem — уже без секретов/PII). kind: необязательный
    фильтр — card|done_md|exemplar|session|rule|agent|skill|chunk|graph_node|role|
    client_rule|memory|mem_obs; пусто = все виды."""
    from urllib.parse import urlencode
    qs = urlencode({"q": q, "kind": kind, "page_size": 20})
    body = _gateway_get(f"/api/knowledge?{qs}")
    result = _maybe_compress(body)
    return result["text"] if result["uncompressed"] else json.dumps(result, ensure_ascii=False)


@mcp.tool()
def council_session_context(session_id: str = "") -> str:
    """Сводка рабочей сессии владельца (план §P4/Ф2): пусто — последняя ЗАКРЫТАЯ
    сессия (summary + её прогоны); session_id — конкретная сессия по id."""
    if session_id:
        body = _gateway_get(f"/api/sessions/{session_id}")
    else:
        listing = _gateway_get("/api/sessions?limit=5")
        try:
            sessions = json.loads(listing)
        except (json.JSONDecodeError, ValueError):
            return listing
        if not isinstance(sessions, list):
            return listing              # _gateway_get вернул {"error": ...} — не список сессий
        closed = next((s for s in sessions if s.get("status") == "closed"), None)
        if not closed:
            return json.dumps({"error": "нет ни одной закрытой сессии"}, ensure_ascii=False)
        body = _gateway_get(f"/api/sessions/{closed['id']}")
    result = _maybe_compress(body)
    return result["text"] if result["uncompressed"] else json.dumps(result, ensure_ascii=False)


@mcp.tool()
def council_card_runs(card_id: str) -> str:
    """Прогоны консилиума по карточке: статусы, readiness, open questions, вердикт.
    card_id — внутренний id ИЛИ человекочитаемый backlog_id (B-24, TAI-3, ...)."""
    from urllib.parse import urlencode
    qs = urlencode({"card_id": card_id, "limit": 50})
    body = _gateway_get(f"/api/runs?{qs}")
    result = _maybe_compress(body)
    return result["text"] if result["uncompressed"] else json.dumps(result, ensure_ascii=False)


@mcp.tool()
def council_graph_neighbors(node: str, hops: int = 1, limit: int = 50) -> str:
    """Окружение узла графа кода (graphify) на N шагов — по id или человекочитаемому
    label (файл/символ). Не путать с council_run_detail: это структура кода, не
    прогон консилиума."""
    from urllib.parse import urlencode
    qs = urlencode({"node": node, "hops": hops, "limit": limit})
    body = _gateway_get(f"/api/graph/neighbors?{qs}")
    result = _maybe_compress(body)
    return result["text"] if result["uncompressed"] else json.dumps(result, ensure_ascii=False)


# ── Постановка в очередь (только supervisor.py CLI) ────────────────────────

@mcp.tool()
def council_queue_card(card: str, profile: str = "", glm: bool = False) -> str:
    """Поставить карточку в очередь консилиума. card: ключ t-boards (OPS-26), id t-boards или id черновика —
    карточка перечитывается из t-boards в момент вызова; next/all больше нет (снимка нет, Р0 б). profile:
    fast|deep|hybrid|cloud (пусто = профиль из конфига). glm=True — режим «всё на GLM 5.x» для этой постановки:
    все роли в подписку Z.AI Coding Plan (модели 5.x), локально только эмбеддинги; нужно включённое облако.
    Ставит в очередь — исполняет воркер (`council_worker.py --once` или демон под супервизором), не этот вызов."""
    args = ["run", "--card", card]
    if profile:
        args += ["--profile", profile]
    if glm:
        args.append("--glm")
    return _run_supervisor(*args)


# ── Управление очередью — queue_control.py (пауза / продолжение с того же места) ─

def _run_queue(*args: str) -> str:
    return _run([sys.executable, str(HERE / "queue_control.py"), *args, "--source", "mcp"], timeout=60)


@mcp.tool()
def council_queue_status() -> str:
    """Состояние очереди консилиума: пауза, прогоны по статусам и профилям, ревью,
    профили, ждущие память (memory-guard), сколько снятого можно вернуть."""
    return _run_queue("status")


@mcp.tool()
def council_queue_pause(batch: str = "", reason: str = "") -> str:
    """Пауза очереди. Без batch — глобально: текущий прогон доделывается, новые не берутся,
    порядок очереди не меняется. С batch — только эта серия (queued → paused)."""
    args = ["pause"] + (["--batch", batch] if batch else []) + (["--reason", reason] if reason else [])
    return _run_queue(*args)


@mcp.tool()
def council_queue_resume(batch: str = "", restore_cancelled: bool = False,
                         restore_expired: bool = False) -> str:
    """Продолжить с того же места: снять паузу (глобально или серии). restore_cancelled /
    restore_expired — вернуть снятые владельцем / просроченные и НЕ начатые прогоны на
    прежние места (дубли по карточке пропускаются)."""
    args = ["resume"] + (["--batch", batch] if batch else [])
    if restore_cancelled:
        args.append("--cancelled")
    if restore_expired:
        args.append("--expired")
    return _run_queue(*args)


# ── Ревью карточек «на ревью» (вкладка «Ревью») — review_cli.py ────────────
# Тот же принцип, что у council_queue_card: инструмент ставит в очередь и читает итог,
# исполняет council_worker под супервизором — локальные модели, без токенов агента.
# На доску консилиум не пишет: переход по итогу — предложение, карточку переносит агент или владелец.

def _run_review(*args: str, timeout: int = 120) -> str:
    return _run([sys.executable, str(HERE / "review_cli.py"), "--json", "--source", "mcp", *args], timeout)


@mcp.tool()
def council_review_queue(board: str = "", refresh: bool = False) -> str:
    """Карточки колонок ревью t-boards и итог их последнего ревью. board: bugs|tasks|"" (обе). refresh=True —
    сначала перечитать очередь из t-boards (до 95 запросов: новым и изменённым карточкам — мета и комментарии)."""
    args = ["queue"] + (["--board", board] if board else []) + (["--refresh"] if refresh else [])
    return _maybe_compress(_run_review(*args, timeout=300))["text"]


@mcp.tool()
def council_review_start(card: str = "next", profile: str = "", agents: str = "",
                         method: str = "", note: str = "", refresh: bool = False,
                         force: bool = False, glm: bool = False) -> str:
    """Поставить ревью карточки в очередь локального консилиума. card: ключ t-boards (OPS-26) | id |
    Backlog ID | часть названия | next (первая без ревью) | all (все без half-baked) — из очереди ревью.
    profile — имя/id профиля (пусто = профиль доски/по умолчанию); agents — ключи через
    запятую (ручной состав на этот запуск); method — ADVERSARIAL|DIVERGENT|CONVERGENT|PAIR|
    BLOCKING|COGNITIVE|ASCENDING|EVALUATIVE|TEST_ORIENTED|CASCADING|COMBINED; note — указание
    консилиуму; glm=True — все агенты этого прогона на GLM Coding API (5.x), расход — облачное
    окно. Возвращает run_id — итог через council_review_result. Исполнение идёт фоном."""
    args = ["start", "--card", card] + (["--glm"] if glm else [])
    for flag, value in (("--profile", profile), ("--agents", agents), ("--method", method),
                        ("--note", note)):
        if value:
            args += [flag, value]
    if refresh:
        args.append("--refresh")
    if force:
        args.append("--force")
    return _run_review(*args, timeout=300)


@mcp.tool()
def council_review_prepare(card: str, profile: str = "", agents: str = "", method: str = "") -> str:
    """Dry-run ревью: проверки (статус в t-boards, модели установлены, переходы), состав с
    причинами автоподбора, эффективные num_ctx/выход на агента, размер досье. Ничего не пишет."""
    args = ["prepare", "--card", card]
    for flag, value in (("--profile", profile), ("--agents", agents), ("--method", method)):
        if value:
            args += [flag, value]
    return _maybe_compress(_run_review(*args, timeout=180))["text"]


@mcp.tool()
def council_review_result(run_id: str = "", card: str = "", full: bool = False) -> str:
    """Итог ревью: вердикт ACCEPT|FAIL|NEEDS_HUMAN|INCONCLUSIVE, голоса, находки (снятые
    оппонентом помечены), судья, трасса политики, состояние перехода. По run_id или по
    карточке (последний прогон). full=True — плюс список вызовов моделей."""
    args = ["result"] + ([run_id] if run_id else ["--card", card]) + (["--full"] if full else [])
    return _maybe_compress(_run_review(*args))["text"]


@mcp.tool()
def council_review_decide(run_id: str, approve: bool, comment: str = "") -> str:
    """Решение по ПРЕДЛОЖЕННОМУ политикой доски переходу статуса (transition_state=proposed).
    approve=True — отметить согласие в базе (`approved`; на доску консилиум не пишет — карточку переносит агент
    под арендой t-boards или владелец), False — отклонить. Вызывать только по явному решению
    пользователя в диалоге (rules/17 §6). Рекомендацию без предложения политики MCP не
    применяет — только владелец из UI."""
    args = ["decide", run_id, "--approve" if approve else "--reject"]
    if comment:
        args += ["--comment", comment]
    return _run_review(*args)


@mcp.tool()
def council_review_stats(what: str = "agents", limit: int = 0) -> str:
    """Вклад ролей ревью (what=agents): вызовы, находки, доля снятых, уникальные, решающие,
    вопросы коллегам, согласие владельца. what=replay — пересчёт вердиктов сохранённых
    прогонов текущей политикой (без моделей): матрица прежний→новый вердикт, причины."""
    what = what if what in ("agents", "replay") else "agents"
    args = ["stats", what] + (["--limit", str(int(limit))] if limit else [])
    return _maybe_compress(_run_review(*args, timeout=180))["text"]


@mcp.tool()
def council_review_config() -> str:
    """Профили ревью, агенты (модель, право вето), политики досок (переходы), настройки
    и счётчики очереди ревью."""
    return _maybe_compress(_run_review("config"))["text"]


# ── GLM RU→EN task-brief — отдельный ключ, вне бюджета консилиума ──────────

@mcp.tool()
def task_brief(prompt: str) -> str:
    """Сырую задачу (RU/смешанный текст) → компактный GOAL/CONSTRAINTS/ACCEPTANCE брифинг
    на английском для агента. НЕ заменяет исходный текст пользователя — использовать как
    дополнительный контекст рядом с оригиналом, при разночтении источник истины — оригинал.
    Отдельный ключ/маршрут от Council (General API glm-4.5-flash, не Coding Plan) — вызов
    не расходует и не ограничен бюджетом консилиума. Fail-safe: при недоступности GLM
    возвращает явное сообщение, не исключение — вызывающий обязан работать и без брифинга."""
    if not glm_client.enabled():
        return "DAMS_GLM=off — предобработка отключена, используй исходный текст как есть."
    brief = glm_client.structure_task(prompt)
    if not brief:
        return "GLM-брифинг недоступен (нет ключа/сеть/таймаут) — используй исходный текст как есть."
    return brief


if __name__ == "__main__":
    mcp.run()
