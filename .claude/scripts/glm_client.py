#!/usr/bin/env python3
"""
DAMS — GLM-клиент (V3-слой: query rewriting + session summary). Только stdlib.

Ключ: env GLM_API_KEY или файл .claude/rag/.glm-key (gitignored, chmod 600).
Модель/эндпоинт: env GLM_MODEL / GLM_FALLBACK_MODEL ('' — без запасной) / GLM_ENDPOINT. Маршрут через
dev-прокси Headroom: env GLM_HEADROOM_URL ('' — напрямую). Отключить слой: DAMS_GLM=off.

Все функции fail-safe: сеть недоступна / таймаут / нет ключа → None,
вызывающий код обязан иметь локальный фолбэк. Данные уходят во внешний
сервис (Z.ai) — наружу передаём только минимум: текст промпта (rewrite)
или тему+пути+итог сессии (summary).
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_root import host_root  # noqa: E402

REPO_ROOT = host_root()  # ключ и маркер «сеть лежит» — у хоста (TAIBE_HOST_ROOT)
KEY_PATH = REPO_ROOT / ".claude/rag/.glm-key"
DOWN_MARKER = REPO_ROOT / ".claude/rag/.glm-down"
DOWN_TTL = 600  # сек: после сетевого сбоя не дёргаем API (офлайн ≠ +30s к каждому промпту)


def _ssl_context():
    """python.org-сборки на macOS не видят системные CA — каскад источников.
    Проверку сертификата НЕ отключаем ни при каком фолбэке."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    if Path("/etc/ssl/cert.pem").exists():
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


_SSL_CTX = _ssl_context()

# Ходим к GLM напрямую, мимо системных/env-прокси: локальный прокси
# (https_proxy=localhost:*) отдаёт 403 на CONNECT-туннель к api.z.ai,
# из-за чего urllib падал мгновенно, а DOWN_MARKER глушнил GLM на 10 минут.
_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=_SSL_CTX),
)

DEFAULT_ENDPOINT = "https://api.z.ai/api/paas/v4/chat/completions"
# Замер 2026-10-15 (бриф до 220 токенов, thinking выключен, 3 прогона): glm-4.7-flash — 2,0 с, перевод
# верный; glm-4.5-flash — 1,6 с, но путает термины («консилиум» → «Consortium»); glm-4.7 — 5,5 с (до 7,2),
# платная, ~$0,001 за бриф. Основная — flash; запасная — glm-4.7, когда flash недоступна: 429 лимита
# бесплатного яруса, 5xx, таймаут, пустой или бесформенный ответ.
DEFAULT_MODEL = "glm-4.7-flash"
DEFAULT_FALLBACK_MODEL = "glm-4.7"
# Через dev-прокси Headroom с меткой dams-glm — расход виден в `npm run ai-pipeline:status` рядом с
# консилиумом и Continue (+0,1 с). Прокси не отвечает (отказ соединения) — тот же вызов напрямую.
DEFAULT_HEADROOM_URL = "http://127.0.0.1:8787/p/dams-glm"
# Основной модели — не больше max(4 с, 40 % бюджета): медленная flash не съедает время запасной.
PRIMARY_MIN_CAP_S = 4.0
PRIMARY_CAP_SHARE = 0.4
# Запасную зовём, только если на неё осталось не меньше её худшего замера: иначе она лишь сжигает бюджет.
FALLBACK_MIN_S = 7.5


def enabled():
    return os.environ.get("DAMS_GLM", "").lower() not in ("off", "0", "false")


def load_key():
    key = os.environ.get("GLM_API_KEY", "").strip()
    if key:
        return key
    try:
        return KEY_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _network_down():
    try:
        return (time.time() - DOWN_MARKER.stat().st_mtime) < DOWN_TTL
    except OSError:
        return False


def _headroom_url():
    url = os.environ.get("GLM_HEADROOM_URL", DEFAULT_HEADROOM_URL).strip().rstrip("/")
    # Bearer-ключ по http — только на петлю: дальше прокси сам идёт к провайдеру по https
    host = urllib.parse.urlsplit(url).hostname if url else None
    return url if host in ("127.0.0.1", "localhost", "::1") else ""


def _is_timeout(exc):
    return isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError)


def _post(url, body, headers, timeout):
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with _OPENER.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _request(model, messages, max_tokens, temperature, timeout, key, endpoint):
    """Один вызов одной модели: через Headroom, при отказе соединения с ним — напрямую.

    → (content | None, можно_пробовать_дальше). False — сеть лежит: запасная модель не поможет.
    """
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "thinking": {"type": "disabled"},  # reasoning-модели без этого думают секунды
    }).encode("utf-8")
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    started = time.monotonic()
    data = None
    proxy = _headroom_url()
    if proxy:
        upstream = endpoint[:-len("/chat/completions")] if endpoint.endswith("/chat/completions") else endpoint
        try:
            data = _post(proxy + "/v1/chat/completions", body, {
                **headers,
                # куда прокси идёт дальше; без original-path он клеит свой /v1/chat/completions → 404 у Z.AI
                "x-headroom-base-url": upstream,
                "x-headroom-original-path": "/chat/completions",
            }, timeout)
        except urllib.error.HTTPError:
            return None, True  # ответ провайдера через прокси (429/5xx/4xx) — дело запасной модели
        except ValueError:
            return None, True  # 200, но не JSON — сбой этой попытки, а не всей цепочки
        except (urllib.error.URLError, OSError) as exc:
            if not isinstance(getattr(exc, "reason", exc), ConnectionRefusedError):
                return None, True  # прокси жив, но не успел — остаток бюджета решает, звать ли запасную
            data = None  # прокси не поднят — идём напрямую
    if data is None:
        try:
            data = _post(endpoint, body, headers, max(0.5, timeout - (time.monotonic() - started)))
        except urllib.error.HTTPError:
            return None, True  # 4xx/5xx от API — не «сеть лежит», маркер не ставим
        except ValueError:
            return None, True
        except (urllib.error.URLError, OSError) as exc:
            # Таймаут ≠ офлайн: медленный API не глушим на 10 минут — у других
            # вызовов (MCP task_brief) бюджет больше, пусть пробуют сами.
            if _is_timeout(exc):
                return None, True
            try:
                DOWN_MARKER.touch()
            except OSError:
                pass
            return None, False
    DOWN_MARKER.unlink(missing_ok=True)
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    return (content or "").strip() or None, True


def glm_chat(messages, max_tokens=200, timeout=45, temperature=0.2, model=None, validate=None):
    """GLM-вызов с запасной моделью в пределах ОБЩЕГО бюджета `timeout` (секунды на всю цепочку).

    Ответ, не прошедший `validate`, считается сбоем основной модели. content или None (никогда не бросает).
    """
    try:
        if not enabled() or _network_down():
            return None
        key = load_key()
        if not key:
            return None
        endpoint = os.environ.get("GLM_ENDPOINT", DEFAULT_ENDPOINT)
        if not endpoint.startswith("https://"):
            return None  # Bearer-ключ не уходит на http/произвольную схему
        primary = model or os.environ.get("GLM_MODEL", DEFAULT_MODEL)
        fallback = os.environ.get("GLM_FALLBACK_MODEL", DEFAULT_FALLBACK_MODEL).strip()
        chain = [primary] + ([fallback] if fallback and fallback != primary else [])
        deadline = time.monotonic() + timeout
        for i, name in enumerate(chain):
            left = deadline - time.monotonic()
            if i > 0 and left < FALLBACK_MIN_S:
                break
            last = i == len(chain) - 1
            cap = left if last else min(left, max(PRIMARY_MIN_CAP_S, PRIMARY_CAP_SHARE * timeout))
            content, go_on = _request(name, messages, max_tokens, temperature, cap, key, endpoint)
            if content and (validate is None or validate(content)):
                return content
            if not go_on:
                break
        return None
    except Exception:
        return None


def rewrite_query(prompt, timeout=25):
    """Задача на русском → английские BM25-термины. None при любой проблеме."""
    content = glm_chat(
        [
            {"role": "system", "content": (
                "Ты преобразуешь задачу разработчика в поисковые термины для BM25-поиска "
                "по кодовой базе HR-системы (NestJS, Prisma, PostgreSQL, Redis, BullMQ, "
                "Connect RPC/proto, React, Telegram MTProto). Ответь ТОЛЬКО 3-6 английскими "
                "терминами через запятую: имена сущностей, API, доменные слова. Без пояснений.")},
            {"role": "user", "content": prompt[:600]},
        ],
        max_tokens=60, timeout=timeout,
    )
    if not content:
        return None
    terms = []
    for raw in re.split(r"[,\n;]+", content):
        t = re.sub(r"^\d+[.)]\s*", "", raw.strip())  # нумерованные списки от LLM
        t = t.strip("*_`'\". ").lower()              # markdown-обёртки
        # только простые термины: слово / идентификатор / kebab-case;
        # многословные сводим к первому слову, дедуп — по итоговому значению
        if not re.fullmatch(r"[a-z][a-z0-9_.\- ]{1,30}", t):
            continue
        term = t.split()[0] if " " in t else t
        if term not in terms:
            terms.append(term)
    return terms[:6] or None


def structure_task(prompt, timeout=45):
    """Сырая задача (RU/смешанный текст, потенциально длинная и рыхлая) → компактный
    структурированный EN-брифинг для агента. Не заменяет исходный текст пользователя —
    инжектится рядом как доп. контекст (см. user-prompt-submit.py). None при любой проблеме."""
    content = glm_chat(
        [
            {"role": "system", "content": (
                "You turn a raw developer task (often Russian, informal, possibly rambling) into "
                "a compact structured English brief for an AI coding agent working on a NestJS/"
                "Prisma/React/Telegram HR system. Output EXACTLY this format, nothing else:\n"
                "GOAL: <one sentence>\n"
                "CONSTRAINTS: <comma-separated, or 'none stated'>\n"
                "ACCEPTANCE: <comma-separated checks, or 'none stated'>\n"
                "Under 80 words total. Never invent requirements absent from the input.")},
            {"role": "user", "content": prompt[:2000]},
        ],
        max_tokens=220, timeout=timeout,
        validate=lambda text: "GOAL:" in text,  # не по формату — пусть попробует запасная модель
    )
    if not content:
        return None
    content = re.sub(r"<[^>]{0,200}>", "", content).strip()  # та же защита, что и в summarize_session
    return content or None


def summarize_session(topic, files, last_text, timeout=45):
    """Сжатое резюме сессии для session/latest.md. None → фолбэк на экстракцию."""
    content = glm_chat(
        [
            {"role": "system", "content": (
                "Сожми итог рабочей сессии над кодом в 2-3 предложения на русском: что "
                "сделано и что осталось/важно помнить. Без вступлений и списков.")},
            {"role": "user", "content": (
                "Тема: %s\nФайлы: %s\nПоследний вывод ассистента: %s" % (
                    topic[:300], ", ".join(files[:15])[:600], last_text[:1200]))},
        ],
        max_tokens=220, timeout=timeout,
    )
    if content:
        # ответ LLM персистится в always-инжектируемый latest.md —
        # срезаем tag-подобные конструкции (минимальная защита от инъекций разметки)
        content = re.sub(r"<[^>]{0,200}>", "", content).strip() or None
    return content


if __name__ == "__main__":
    # Диагностика: python3 .claude/scripts/glm_client.py "текст задачи"
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "поправь зависание отправки сообщений"
    print("enabled:", enabled(), "| key:", "есть" if load_key() else "НЕТ")
    print("rewrite_query(%r) ->" % q, rewrite_query(q))
    print("structure_task(%r) ->\n%s" % (q, structure_task(q)))
