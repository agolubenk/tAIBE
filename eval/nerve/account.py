# -*- coding: utf-8 -*-
"""Аккаунт Claude Code, на котором сейчас идёт команда: короткий id и множитель тарифа.

Зачем: квота окна 5 ч — медиана волн лимита. Волны одного аккаунта не годятся для другого: 18–19.11 после смены
Max 20x → Max 5x квота осталась ~$165 (медиана волн 20x), а окно кончалось на $28 и $45 — предвестник на 80 % не
сработал ни разу, 11 ролей съели окно за 15 мин. Волна теперь помнит аккаунт, квота берётся по своему аккаунту, а без
его волн — по волнам других, пересчитанным по множителю тарифа (`default_claude_max_20x` → 20, `…_5x` → 5).

Источник — `~/.claude.json`, поле `oauthAccount` (его пишет `/login`; путь — `$NERVE_CLAUDE_JSON`, для тестов). В
состояние Нерва идёт только sha256(accountUuid)[:12] и множитель: ни email, ни имени. Файла или поля нет — None:
квота считается по всем волнам, как до разделения.
"""
import hashlib
import json
import os
import re

import budget

ENV = "NERVE_CLAUDE_JSON"
CURRENT = object()  # значение по умолчанию у actions.quota5: прочитать аккаунт входа
TIER_RE = re.compile(r"(\d+)x(?:$|[^a-z0-9])")


def path():
    return os.environ.get(ENV) or os.path.expanduser("~/.claude.json")


def tier_mult(tier):
    """Множитель окна по `organizationRateLimitTier`: «…_max_20x» → 20, «…_max_5x» → 5, «…pro…» → 1, иначе None."""
    if not isinstance(tier, str):
        return None
    m = TIER_RE.search(tier.lower())
    if m:
        return int(m.group(1)) or None
    return 1 if "pro" in tier.lower() else None


def current(p=None):
    """{"id": 12 hex, "mult": int|None} аккаунта входа или None (файла нет, не JSON, нет accountUuid)."""
    try:
        with open(p or path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    a = data.get("oauthAccount") if isinstance(data, dict) else None
    if not isinstance(a, dict):
        return None
    uid = a.get("accountUuid")
    if not isinstance(uid, str) or not uid:
        return None
    return {"id": hashlib.sha256(uid.encode("utf-8")).hexdigest()[:12],
            "mult": tier_mult(a.get("organizationRateLimitTier"))}


def observe(st, now_ts, p=None):
    """Аккаунт входа и `since` — когда Нерв увидел его первым (st["acct_seen"]; mtime ~/.claude.json не годится:
    Claude Code пишет файл постоянно). Зовётся каждый проход бюджета, поэтому `since` точен до прохода: отказ не
    старше `since` — уже на этом аккаунте; старше — до смены входа, чей он — не знаем."""
    a = current(p)
    if not a:
        return None
    seen = st.get("acct_seen") or {}
    if seen.get("id") != a["id"]:
        seen = st["acct_seen"] = {"id": a["id"], "since": now_ts}
    return dict(a, since=seen["since"])


def quota(waves, n, acct):
    """Квота окна ($) по волнам [{usd, acct?, mult?}] и аккаунту входа; None — волн нет. Порядок:
    1) последние n волн этого аккаунта; 2) последние n волн с известным множителем, пересчитанные на множитель
    аккаунта; 3) последние n волн вообще (как до разделения по аккаунтам). Возвращает (квота, источник)."""
    ws = [w for w in waves if (w.get("usd") or 0) > 0]
    if acct:
        own = [w["usd"] for w in ws if w.get("acct") == acct["id"]][-n:]
        if own:
            return budget.median(own), "account"
        if acct.get("mult"):
            scaled = [w["usd"] * acct["mult"] / w["mult"] for w in ws if w.get("mult")][-n:]
            if scaled:
                return budget.median(scaled), "tier"
    allw = [w["usd"] for w in ws][-n:]
    return (budget.median(allw), "all") if allw else (None, "default")
