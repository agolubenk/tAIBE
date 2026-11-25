# -*- coding: utf-8 -*-
"""Наблюдатель claude-mem: сбой дольше ALERT_AFTER — одна тревога координатору каждого продукта, восстановление —
одна строка.

Зачем: наблюдатель claude-mem не записывал память с 20.11 21:35 до 23.11 ~21:00 (`auth_invalid`, аккаунт на
проверке). Наблюдений 21.11 — 39, 22.11 — 0; трое суток этого никто не видел.

Источник — `~/.claude-mem/observer-health.json` (путь — `$NERVE_MEM_HEALTH`, для тестов). Читаются только ключи KEYS:
в файле есть ещё текст ошибки, URL и id запроса — в журнал они не идут. `settings.json` claude-mem не читается.

Наблюдатель общий для Mac, поэтому событие идёт через `emit_account`: координатору продукта по умолчанию и каждого
активного продукта, с одним ключом. Ключ тревоги — начало сбоя (`mem:down:<начало>`), строки восстановления —
`mem:up:<начало>`: повторный проход и перезапуск демона второй строки не пишут. Сбой открыт, пока файл не покажет
`consecutiveFailures: 0` или успех позже начала сбоя; новое начало без успеха (наблюдатель переписал
`failingSinceAt`) — тот же сбой, второй тревоги нет. Сбой без `failingSinceAt` отсчитывается от прохода, который
увидел его первым (`mem_health.seen` в `state.json`). Файла нет или он не JSON — проход ничего не пишет и состояние
не трогает: claude-mem мог не стоять или писать файл в этот миг.

Порог 45 мин: проход раз в 60 с, ночью раз в 5 мин, поэтому тревога приходит не позже ~50 мин от начала сбоя
(карточка: «в пределах часа»). Короткие сбои (сеть, кулдаун квоты) короче порога тревоги не дают.
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone

from journal import DIGEST, NERVOUS

ENV = "NERVE_MEM_HEALTH"
KEYS = ("consecutiveFailures", "failingSinceAt", "lastSuccessAt", "lastErrorKind")
ALERT_AFTER = timedelta(minutes=45)
KIND_RE = re.compile(r"[A-Za-z0-9_.-]{1,40}")
KIND = "sys.mem"


def path():
    return os.environ.get(ENV) or os.path.expanduser("~/.claude-mem/observer-health.json")


def read(p=None):
    """Только ключи KEYS файла здоровья или None: файла нет, не JSON, не объект."""
    try:
        with open(p or path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return {k: data.get(k) for k in KEYS} if isinstance(data, dict) else None


def when(v):
    """Время из файла: эпоха в мс (так пишет claude-mem) или в с, либо ISO-строка. Иначе None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        try:
            return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(v, str) and v:
        try:
            t = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    return None


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _recovered(h, since):
    ok = when(h["lastSuccessAt"])
    return _count(h["consecutiveFailures"]) == 0 or (ok is not None and ok > since)


def poll_mem_health(ctx):
    h = read()
    if h is None:
        return
    st = ctx.state.setdefault("mem_health", {})
    down = when(st.get("down"))
    if down is not None:
        if not _recovered(h, down):
            return                                    # тот же сбой: одна тревога на сбой
        ctx.emit_account(f"mem:up:{st['down']}", KIND, DIGEST, ["coord"],
                         f"claude-mem: наблюдатель снова пишет память (сбой с {_local(ctx, down)})", "system")
        st.pop("down", None)
    fails = _count(h["consecutiveFailures"])
    if not fails or fails < 0:
        st.pop("seen", None)
        return
    start = when(h["failingSinceAt"])
    since = start or when(st.get("seen"))
    # Начала сбоя в файле нет: с первого прохода, увидевшего сбой. Успех после него и снова сбой — новый сбой:
    # отсчёт заново, иначе _recovered навсегда глушит тревогу (SE-199).
    if since is None or (start is None and _recovered(h, since)):
        st["seen"] = ctx.now.isoformat(timespec="seconds")
        return
    if ctx.now - since < ALERT_AFTER or _recovered(h, since):
        return
    key = since.isoformat(timespec="seconds")
    kind = h["lastErrorKind"] if isinstance(h["lastErrorKind"], str) and KIND_RE.fullmatch(h["lastErrorKind"]) else "?"
    ctx.emit_account(f"mem:down:{key}", KIND, NERVOUS, ["coord"],
                     f"claude-mem: наблюдатель не пишет память с {_local(ctx, since)} ({fails} сбоев подряд, {kind}) — "
                     "память сессий не копится; поставь пункт владельцу (вход claude-mem)", "system")
    st["down"] = key


def _local(ctx, t):
    return t.astimezone(ctx.tz).strftime("%d.%m %H:%M")
