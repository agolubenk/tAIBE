#!/usr/bin/env python3
"""AI Council — сервис ревью: очередь из колонок ревью t-boards (по запросу), постановка, dry-run, итог.

Один код для трёх входов — вкладка «Ревью» (gateway), CLI/MCP (review_cli.py) и council_worker. Записи на доску
нет (OPS-26): итог и предложенный политикой доски переход живут в базе консилиума; перенос карточки делает агент
под арендой t-boards или владелец. Комментарий итогом на карточке — отдельная карточка (AUTO-70 ч. 2).
"""
from __future__ import annotations

import json

import review_catalog as cat
import tboards
from review_context import REVIEW_COMMENT_MARK, build_dossier, card_comments
from review_plan import build_plan
from review_store import ReviewStore
from store import sha16

VERDICT_KEY = {"ACCEPT": "on_accept", "FAIL": "on_fail", "INCONCLUSIVE": "on_inconclusive",
               "NEEDS_HUMAN": "on_needs_human"}
VERDICT_RU = {"ACCEPT": "ПРИНЯТО", "FAIL": "НА ДОРАБОТКУ", "NEEDS_HUMAN": "НУЖЕН ЧЕЛОВЕК",
              "INCONCLUSIVE": "НЕОДНОЗНАЧНО"}
SYNC_BUDGET = 95             # обновление очереди: проекты + колонки ревью + 3 запроса на новую или изменённую карточку


def review_slugs(cfg) -> tuple[str, ...]:
    return tuple(cfg.get("sources.tboards.review_slugs", tboards.REVIEW_SLUGS) or tboards.REVIEW_SLUGS)


def cloud_models(cfg) -> set[str]:
    if not cfg.cloud_enabled():
        return set()
    out: set[str] = set()
    for node in (cfg.get("models.cloud.providers", {}) or {}).values():
        out.update(node.get("models") or [])
    return out


def board_statuses(cfg, board: str, client=None) -> tuple[list[str], str]:  # noqa: ARG001 — подпись вызовов шлюза
    """Статусы для политики доски: slug колонок t-boards и имена, перенесённые из Notion (каталог)."""
    return list(cat.KNOWN_STATUSES[board]), "catalog"


def review_hash(card: dict) -> str:
    """Без собственных комментариев ревью: иначе наш же итог на карточке выглядел бы
    «изменением» и автозапуск ревьюил бы карточку по кругу."""
    own_free = "|".join(c.get("text", "") for c in card_comments(card, include_own=False))
    return sha16("|".join([card.get("title") or "", card.get("body") or "", card.get("report") or "",
                           card.get("priority") or "", card.get("severity") or "", own_free]))


# ── очередь ─────────────────────────────────────────────────────────────────
def _unchanged(prev: dict | None, task: dict) -> bool:
    """Строка очереди совпадает со списком доски: мета и комментарии не перечитываются (экономия 3 запросов)."""
    if not prev or task.get("descriptionDeferred"):
        return False
    from knowledge_external import scrub
    return (prev.get("title") == (task.get("title") or "") and prev.get("status") == task.get("status")
            and prev.get("priority") == tboards.PRIORITY.get(str(task.get("priority") or ""))
            and prev.get("body") == scrub(str(task.get("description") or "")))


def _review_card(cfg, rs: ReviewStore, client, task: dict, project: dict, stats: dict) -> dict:
    prev = rs.card_by_task(task["id"])
    if prev is not None and _unchanged(prev, task):
        return dict(prev)
    if task.get("descriptionDeferred"):
        task = client.task(task["id"])
    else:
        task = {**task, "workspaceId": client.workspace}
    meta, labels, comments = client.meta(task["id"]), client.labels(task["id"]), client.comments(task["id"])
    stats["fetched"] += 1
    finals = tuple(cfg.get("sources.tboards.final_slugs", tboards.FINAL_SLUGS))
    base = tboards.task_to_card(task, meta, labels, comments, project, client, finals)
    card = {**base, "board": base["db"]}
    card["review_hash"] = review_hash(card)
    return card


def sync_queue(cfg, rs: ReviewStore, client=None, boards: list[str] | None = None,
               verbose: bool = False) -> dict:
    """Карточки колонок ревью (`sources.tboards.review_slugs`) по проектам продукта — только по запросу
    (`--refresh`, кнопка вкладки). Новым и изменённым — мета, метки, комментарии. Полный проход снимает с очереди
    ушедшие; неполный (бюджет, лимит ключа, сбой) не снимает ничего — повтор продолжит."""
    stats = {"seen": 0, "fetched": 0, "left": 0, "errors": 0, "partial": False}
    wanted = [b for b in (boards or list(cat.BOARDS)) if rs.boards().get(b, {}).get("enabled")]
    seen: dict[str, set[str]] = {b: set() for b in cat.BOARDS}
    own = client is None
    try:
        client = client or tboards.build(cfg, budget=SYNC_BUDGET)
        tboards.check_pin(rs.s, client.workspace)
        slugs = review_slugs(cfg)
        for project in client.projects().values():
            tasks, columns = client.board(project["id"], slugs[0])
            present = {c.get("slug") for c in columns}
            for slug in slugs[1:]:
                if slug in present:
                    tasks += client.board(project["id"], slug)[0]
            for task in tasks:
                stats["seen"] += 1
                card = _review_card(cfg, rs, client, task, project, stats)
                # Кэшируем и карточки других досок: иначе `--board tasks` перечитывал бы мету ошибок на каждом
                # проходе. С очереди ушедших снимаем только у выбранных досок; выключенная политикой — не в очереди.
                rs.upsert_card(card)
                if not rs.boards().get(card["board"], {}).get("enabled"):
                    rs.s.x("UPDATE review_cards SET in_queue = 0 WHERE card_id = ?", (card["card_id"],))
                if card["board"] in wanted:
                    seen[card["board"]].add(card["card_id"])
    except tboards.TBoardsError as exc:
        stats["errors"] += 1
        stats["partial"] = True
        stats["error"] = str(exc)
        if verbose:
            print(f"  ✗ ревью: {exc}")
    finally:
        if own and client is not None:
            client.close()
    if not stats["partial"]:
        for board in wanted:
            stats["left"] += rs.mark_left_queue(board, seen[board])
    if verbose:
        print(f"  ревью: в колонках ревью {stats['seen']}, перечитано {stats['fetched']}, ушло {stats['left']}"
              + (" (неполный проход — с очереди ничего не снято)" if stats["partial"] else ""))
    rs.s.event("review.synced", "", json.dumps(stats, ensure_ascii=False))
    return stats


def refresh_card(cfg, rs: ReviewStore, card: dict, client=None) -> dict:
    """Карточка очереди на сейчас: деталь, мета, метки, комментарии (5 запросов). Исполнитель мог обновить отчёт или
    ответить в комментарии, не меняя описания, — ревью по старым данным было бы ревью не того. Ушла из колонки ревью —
    снимается с очереди. Снимок Notion (без board_task_id) не перечитывается."""
    if not card.get("board_task_id"):
        return card
    own = client is None
    client = client or tboards.build(cfg, budget=8)
    try:
        task = client.task(card["board_task_id"])
        meta, labels = client.meta(task["id"]), client.labels(task["id"])
        comments = client.comments(task["id"])
        project = client.projects().get(task.get("projectId")) or {}
    finally:
        if own:
            client.close()
    finals = tuple(cfg.get("sources.tboards.final_slugs", tboards.FINAL_SLUGS))
    base = tboards.task_to_card(task, meta, labels, comments, project, client, finals)
    fresh = {**base, "board": base["db"]}
    fresh["review_hash"] = review_hash(fresh)
    rs.upsert_card(fresh)
    if fresh["status"] not in review_slugs(cfg):
        rs.s.x("UPDATE review_cards SET in_queue = 0 WHERE card_id = ?", (fresh["card_id"],))
    return rs.card(fresh["card_id"]) or fresh


def resolve_cards(rs: ReviewStore, ref: str, board: str = "") -> list[dict]:
    ref = (ref or "next").strip()
    if ref in ("all", "next"):
        queue = [c for c in rs.queue(board) if not c.get("half_baked")]
        if ref == "next":
            fresh = [c for c in queue if not c.get("last_run")]
            return (fresh or queue)[:1]
        return queue
    found = rs.find_card(ref)
    return [found] if found else []


def enqueue(cfg, rs: ReviewStore, ref: str, profile_ref: str = "", requested_by: str = "ui",
            request: dict | None = None, board: str = "", priority: int = 5,
            force: bool = False, client=None) -> dict:
    request = {k: v for k, v in (request or {}).items() if v not in (None, "", [], {})}
    cards = resolve_cards(rs, ref, board)
    if not cards:
        return {"ok": False, "error": f"карточка «{ref}» не найдена в очереди ревью — "
                                      "обновите очередь из t-boards (council_review_queue refresh=True) или "
                                      "укажите ключ карточки в колонке ревью", "queued": []}
    queued, skipped, warnings = [], [], []
    policies = rs.boards()
    if len(cards) <= 3:                            # «all» идёт по данным очереди: 5 запросов на карточку не по карману
        fresh = []
        for card in cards:
            try:
                card = refresh_card(cfg, rs, card, client)
            except tboards.TBoardsError as exc:
                warnings.append(f"{card.get('ticket') or card['card_id']}: данные очереди, не перечитаны ({exc})")
            if card.get("status") in review_slugs(cfg) or not card.get("board_task_id"):
                fresh.append(card)
            else:
                skipped.append({"card_id": card["card_id"], "title": card.get("title"),
                                "why": f"ушла из колонки ревью: «{card.get('status')}»"})
        cards = fresh
    for card in cards:
        active = rs.active_run(card["card_id"])
        if active and not force:
            skipped.append({"card_id": card["card_id"], "title": card.get("title"),
                            "why": f"уже {active['status']} ({active['id']})"})
            continue
        prof = rs.profile(profile_ref or policies[card["board"]].get("profile_id") or None) \
            or rs.profile(None)
        if not prof:
            return {"ok": False, "error": "нет ни одного профиля ревью", "queued": queued}
        run_id = rs.enqueue(card, prof, requested_by, request,
                            priority + (1 if card["board"] == "bugs" else 0))
        queued.append({"run_id": run_id, "card_id": card["card_id"], "title": card.get("title"),
                       "profile": prof["name"]})
    return {"ok": True, "queued": queued, "skipped": skipped, **({"warnings": warnings} if warnings else {})}


# ── dry-run ─────────────────────────────────────────────────────────────────
def prepare(cfg, rs: ReviewStore, ref: str, profile_ref: str = "", request: dict | None = None,
            live: bool = True) -> dict:
    import ollama as ollama_mod
    request = request or {}
    cards = resolve_cards(rs, ref)
    if not cards:
        return {"ok": False, "checks": [{"ok": False, "text": f"карточка «{ref}» не в очереди ревью"}]}
    card = cards[0]
    policy = rs.boards()[card["board"]]
    prof = rs.profile(profile_ref or policy.get("profile_id") or None) or rs.profile(None)
    checks: list[dict] = []
    add = lambda ok, text, level="": checks.append({"ok": ok, "text": text, "level": level})  # noqa: E731
    if not prof:
        add(False, "нет профиля ревью")
        return {"ok": False, "checks": checks}
    client_o = ollama_mod.build(cfg)
    alive = client_o.alive()
    installed = set(client_o.installed_models()) if alive else set()
    clouds = cloud_models(cfg)
    plan = build_plan(card, prof, request, rs.agents(), rs.settings(),
                      int(cfg.get("models.num_ctx", 8192)),
                      client_o.context_length if alive else (lambda m: None),
                      lambda m: m in clouds)
    slugs = review_slugs(cfg)
    status_ok = card.get("status") in slugs
    if live and card.get("board_task_id"):
        try:
            card = refresh_card(cfg, rs, card)
            status_ok = card.get("status") in slugs
            add(status_ok, f"карточка перечитана из t-boards, колонка «{card.get('status')}»"
                + ("" if status_ok else f" — ожидалась колонка ревью ({', '.join(slugs)})"))
        except tboards.TBoardsError as exc:
            add(True, f"карточка не перечитана ({exc}) — по очереди «{card.get('status')}»", "warn")
    else:
        add(status_ok, f"статус по очереди: «{card.get('status')}»"
            + ("" if card.get("board_task_id") else " (карточка из снимка Notion — архив)"))
    add(True, f"профиль «{prof['name']}» v{prof['version']}, метод {plan['method_label']}")
    if card.get("half_baked"):
        add(True, "карточка Half-baked — автозапуск её пропускает; ручной запуск — на ваше усмотрение", "warn")
    add(bool(plan["participants"]), f"участники: {len(plan['participants'])} "
        f"({', '.join(plan['participants']) or 'никого'})")
    add(alive, "Ollama отвечает" if alive else "Ollama не отвечает — локальные агенты не запустятся")
    for key, a in plan["agents"].items():
        if a["cloud"]:
            add(True, f"{key}: облачная модель {a['model']} (тратит окно подписки)", "warn")
        elif alive and a["model"] not in installed:
            add(False, f"{key}: модель {a['model']} не установлена в Ollama")
    if policy.get("allow_transition"):
        statuses, _ = board_statuses(cfg, card["board"])
        for vkey in VERDICT_KEY.values():
            target = policy.get(vkey)
            if target:
                add(target in statuses, f"{vkey}: «{target}»" + ("" if target in statuses else " — нет в каталоге"))
        add(True, "переход будет предложен; на доску консилиум не пишет — карточку переносит агент или владелец",
            "warn")
    else:
        add(True, "перевод статуса выключен политикой доски — итог будет рекомендацией", "")
    for w in plan["warnings"]:
        add(True, w, "warn")
    budget = min((a["input_budget"] for a in plan["agents"].values()), default=4000)
    text, meta = build_dossier(card, plan["spec"].get("context") or cat.DEFAULT_CONTEXT, budget, None)
    add(True, f"досье ≈ {meta['tokens']} токенов при бюджете {budget}; коммитов найдено: "
        f"{len(meta.get('commits') or [])}" + ("; DONE.md: есть" if meta.get("done_md") else ""))
    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "checks": checks, "card": {k: card.get(k) for k in
            ("card_id", "board", "title", "url", "status", "backlog_id")},
            "profile": {"id": prof["id"], "name": prof["name"]}, "plan": plan,
            "dossier_preview": text[:6000], "dossier_meta": meta}


# ── итог на карточку ────────────────────────────────────────────────────────
REASON_RU = {
    "veto": "вето с уликами",
    "critical": "critical с опорой в диффе от голосующего fail или оппонента, подтверждён коллегой",
    "threshold": "порог голосов", "insufficient_evidence": "недостаточно доказательств",
    "unsupported_veto": "вето без улик — решение за человеком",
    "unverified_critical": "critical не подтверждён коллегой — решение за человеком",
    "open_evidence_gap": "critical-пробел аудитора доказательств не закрыт и не вернул карточку в работу — "
                         "решение за человеком",
    "critical_author_not_fail": "critical, но автор голосует не fail (часто подтверждение исправления) — "
                                "проверить, решение за человеком",
    "control_skipped": "оппонент/судья не успели", "major": "висят major-находки",
    "judge_against": "судья против принятия", "low_confidence": "низкая уверенность",
    "judge_vs_majority": "судья против большинства", "judge_tiebreak": "ничья, решил судья",
    "judge_fail_on_notes": "ничья, судья за FAIL, но опора только у находок голосующих не fail — "
                           "решение за человеком",
    "tie": "перевеса нет", "insufficient": "мало валидных выводов",
}
STANCE_RU = {"confirms": "подтвердил", "refutes": "оспорил", "unclear": "не смог решить"}


def _finding_mark(f: dict, notes=frozenset()) -> str:
    if f.get("grounding") in ("card", "none") and f.get("severity") == "critical":
        return " (без опоры в диффе)"
    if f.get("disputed"):
        return " (оспорено коллегой)"
    if f.get("confirmed_by"):
        # notes — подтверждённые critical, автор которых голосует не fail (review_policy._defect_claim)
        tail = "; автор голосует не fail — проверить, не подтверждение ли" if f.get("id") in notes else ""
        return f" (подтвердил {', '.join(f['confirmed_by'])}{tail})"
    return ""



def _comment_text(run: dict, transition_line: str) -> str:
    res, snap = run.get("result") or {}, run.get("snapshot") or {}
    verdict = run.get("verdict") or "—"
    lines = [f"{REVIEW_COMMENT_MARK} — {VERDICT_RU.get(verdict, verdict)} ({verdict}, "
             f"уверенность {run.get('confidence') or 0:.2f})",
             f"Профиль «{run.get('profile_name')}» · метод {cat.METHODS.get(snap.get('method') or '', {}).get('label', snap.get('method'))}"
             f" · модели: {', '.join(sorted({a['model'] for a in (snap.get('agents') or {}).values()}))}",
             f"Итог: {run.get('summary') or '—'}"]
    policy = res.get("policy") or {}
    if policy.get("verdict_reason"):
        # Все сработавшие основания NEEDS_HUMAN (review_policy.decide, verdict_reasons; нет у прогонов до 20.10),
        # иначе владелец видит одно из них и не видит, что, например, FAIL снят из-за заметки автора.
        codes = policy.get("verdict_reasons") or [policy["verdict_reason"]]
        why = "; ".join(REASON_RU.get(c, c) for c in codes)
        legacy = policy.get("legacy_verdict")
        lines.append(f"Основание: {why}" + (f" (прежняя политика: {legacy})"
                                             if legacy and legacy != verdict else ""))
    top = [f for f in res.get("findings") or [] if not f.get("refuted")
           and f.get("severity") in ("critical", "major")][:6]
    notes = frozenset((policy.get("flags") or {}).get("crit_notes") or ())  # нет у прогонов до 20.10
    if top:
        lines.append("Главное:")
        lines += [f"• [{f['severity']}] {f['title']}" + _finding_mark(f, notes)
                  + (f" — {f['recommendation']}" if f.get("recommendation") else "")
                  for f in top]
    # Переписка — по строке на обращение; полный текст ответов — только в UI («Переписка агентов»).
    talk = [c for c in res.get("consults") or [] if c.get("stance")][:4]
    if talk:
        lines.append("Переписка агентов: " + "; ".join(
            f"{c.get('about') or ''} {c.get('from')} → {c.get('to')}: {STANCE_RU.get(c['stance'], c['stance'])}"
            .strip() for c in talk))
    judge = res.get("judge") or {}
    if judge.get("dissent"):
        lines.append(f"Особое мнение: {judge['dissent']}")
    if judge.get("next_steps"):
        lines.append("Шаги: " + "; ".join(judge["next_steps"][:5]))
    votes = res.get("votes") or {}
    if votes:
        lines.append("Голоса: " + ", ".join(f"{k}={v.get('vote')} ({(v.get('confidence') or 0):.2f})"
                                            for k, v in votes.items()))
    lines.append(f"Статус: {transition_line}")
    lines.append(f"run: {run['id']} · подробности — AI Council, вкладка «Ревью»")
    return "\n".join(lines)


def after_run(cfg, rs: ReviewStore, run_id: str, client=None, log=print) -> dict:  # noqa: ARG001 — подпись воркера
    """Политика доски по вердикту: рекомендация или предложение перехода. На доску консилиум не пишет (OPS-26):
    переход, даже без подтверждения по политике, остаётся предложением, комментарий — `skipped`."""
    run = rs.run(run_id)
    if not run or run["status"] != "done" or not run.get("verdict"):
        return {"ok": False}
    card = rs.card(run["card_id"]) or {}
    policy = rs.boards().get(run["board"], {})
    target = policy.get(VERDICT_KEY.get(run["verdict"], ""), "")
    if not target:
        rs.set_transition(run_id, "none", "", f"для {run['verdict']} переход не настроен", "ai")
        line = "переход для этого вердикта не настроен — решает человек"
    elif not policy.get("allow_transition"):
        rs.set_transition(run_id, "none", target, "перевод выключен политикой доски — рекомендация", "ai")
        line = f"рекомендация «{policy['review_status']}» → «{target}» (автоперевод выключен)"
    else:
        rs.set_transition(run_id, "proposed", target, "ждёт подтверждения; карточку переносит агент или владелец", "ai")
        rs.audit(run_id, run["card_id"], "transition.proposed", "ai", policy["review_status"], target)
        line = f"предложен переход «{policy['review_status']}» → «{target}», ждёт подтверждения"
    rs.set_comment_state(run_id, "skipped")
    log(f"    ✎ {line}" + (f" · card «{(card.get('title') or '')[:40]}»" if card else ""))
    return {"ok": True, "transition": line}


def decide_transition(cfg, rs: ReviewStore, run_id: str, approve: bool, actor: str,  # noqa: ARG001
                      comment: str = "") -> dict:
    """Решение человека по предложенному переходу: `approved` или `rejected` — только в базе консилиума (калибровка
    по согласию владельца). На доску консилиум не пишет: одобренный переход делает агент под арендой t-boards или
    владелец. Рекомендацию (прогон прошёл, пока перевод был выключен) одобряет только владелец из UI."""
    run = rs.run(run_id)
    if not run:
        return {"ok": False, "error": "прогон не найден"}
    state, target = run.get("transition_state"), run.get("transition_target") or ""
    if not target:
        return {"ok": False, "error": "у прогона нет цели перехода"}
    if state not in ("proposed", "none", "failed", "skipped"):
        return {"ok": False, "error": f"переход уже в состоянии «{state}»"}
    policy = rs.boards().get(run["board"], {})
    if approve and not policy.get("allow_transition"):
        return {"ok": False, "error": "перевод статуса выключен политикой доски — сначала "
                                      "разрешите его во вкладке «Ревью» → «Доски и переходы»"}
    if approve and state != "proposed" and actor != "ui":
        return {"ok": False, "error": "применить рекомендацию (без предложения политики) можно "
                                      "только из UI владельцем"}
    if not approve:
        rs.set_transition(run_id, "rejected", target, comment or "отклонено", actor)
        rs.audit(run_id, run["card_id"], "transition.rejected", actor, policy.get("review_status", ""),
                 target, comment)
        return {"ok": True, "state": "rejected"}
    rs.set_transition(run_id, "approved", target, comment or "подтверждено; перенос карточки — на доске", actor)
    rs.audit(run_id, run["card_id"], "transition.approved", actor, policy.get("review_status", ""), target, comment)
    card = rs.card(run["card_id"]) or {}
    return {"ok": True, "state": "approved",
            "next": f"перенесите карточку {card.get('ticket') or run['card_id']} в «{target}» на доске t-boards"}
