"""Транспорт HTTP для доски и очереди (R-1 п. 1, R-5). Метод — константа GET, параметра метода и тела запроса нет.
Переадресацию транспорт не выполняет: она могла бы увести запрос на другой хост. Хосты: `127.0.0.1` по http, по https —
только хост доски (`T_BOARDS_URL`, иначе адрес по умолчанию из `infra/scripts/dev-ai/mcp-t-boards.sh`) и хост очереди
(`queue.url` в `instances/_shared.json`). Тайм-аут — 2 с на вызов (R-7)."""
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

from . import NotAllowed, SourceDown

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
METHOD = "GET"
TIMEOUT = 2.0
MAX_BYTES = 4 * 1024 * 1024
SESSION_HEADER = "x-t-boards-session"
BOARD_URL = "https://d4dev.admin.hrhelper.space"   # как KANEO_API_URL по умолчанию в mcp-t-boards.sh
LOCAL = "127.0.0.1"


def session_ok(label):
    """Метка сессии в форме SESSION_LABEL_PATTERN доски (`boards/apps/api/src/forest/actor.ts`): буквы, цифры,
    пробел и `._:/#-`, 1–80 символов. Другую метку сервер молча не принял бы."""
    return isinstance(label, str) and 1 <= len(label) <= 80 and all(
        ch.isalnum() or ch in " ._:/#-" for ch in label)


def allowed_hosts(root=ROOT, env=None):
    """Хосты для https: доска и очередь. 127.0.0.1 разрешён всегда (и по http)."""
    env = os.environ if env is None else env
    hosts = {urllib.parse.urlsplit(env.get("T_BOARDS_URL") or BOARD_URL).hostname}
    try:
        with open(os.path.join(root, "instances", "_shared.json"), encoding="utf-8") as f:
            hosts.add(urllib.parse.urlsplit(json.load(f)["queue"]["url"]).hostname)
    except (OSError, ValueError, KeyError, TypeError):
        pass   # нет конфига очереди — к очереди транспорт не пойдёт
    return {h for h in hosts if h}


def check_url(url, hosts):
    """NotAllowed, если URL ведёт не туда: другой хост, http не на 127.0.0.1, учётные данные в URL."""
    parts = urllib.parse.urlsplit(url)
    if parts.username or parts.password:
        raise NotAllowed("net: учётные данные в URL не принимаются")
    host = parts.hostname
    if parts.scheme == "http" and host == LOCAL:
        return
    if parts.scheme == "https" and (host == LOCAL or host in hosts):
        return
    raise NotAllowed(f"net: {parts.scheme}://{host} вне списка хостов (R-5)")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None   # urllib превращает 3xx в HTTPError: переадресация — отказ источника, не новый хост


def _opener():
    handlers = [urllib.request.ProxyHandler({}), _NoRedirect()]
    try:   # тот же выбор хранилища сертификатов, что у очереди (queue_focus.py): проверка остаётся включённой
        sys.path.insert(0, os.path.join(ROOT, ".claude", "scripts"))
        import pipeline_settings
        ctx = pipeline_settings._tls_context()
        if ctx is not None:
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
    except Exception:  # noqa: BLE001 — хранилище по умолчанию тоже проверяет сертификат
        pass
    finally:
        sys.path.remove(os.path.join(ROOT, ".claude", "scripts"))
    return urllib.request.build_opener(*handlers)


def _timed_out(exc):
    return isinstance(exc, (TimeoutError, socket.timeout)) or (
        isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, (TimeoutError, socket.timeout)))


def get(url, *, source, session=None, token=None, timeout=TIMEOUT, hosts=None, opener=None):
    """JSON ответа на GET. Отказ источника — SourceDown(source, причина); неверный URL или метка — NotAllowed /
    ValueError (ошибка вызывающего). Токен уходит только заголовком Authorization и в текст ошибки не попадает."""
    check_url(url, allowed_hosts() if hosts is None else hosts)
    headers = {"Accept": "application/json"}
    if session is not None:
        if not session_ok(session):
            raise ValueError(f"net: метка сессии не в форме доски: {session[:40]!r}")
        headers[SESSION_HEADER] = session
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method=METHOD)
    try:
        with (opener or _opener()).open(req, timeout=timeout) as r:
            body = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise SourceDown(source, f"HTTP {e.code}") from None
    except (urllib.error.URLError, OSError) as e:
        if _timed_out(e):
            raise SourceDown(source, f"тайм-аут {timeout:g} с") from None
        reason = getattr(e, "reason", e)
        raise SourceDown(source, f"нет связи ({type(reason).__name__})") from None
    if len(body) > MAX_BYTES:
        raise SourceDown(source, f"ответ больше {MAX_BYTES // (1024 * 1024)} МБ")
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise SourceDown(source, "ответ не JSON") from None
