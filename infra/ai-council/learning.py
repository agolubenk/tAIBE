#!/usr/bin/env python3
"""AI Council — обучение без дообучения (§9, механизмы 2 и 4). Только stdlib.

Канон: docs/specs/ai-council.md §9, §13.

    python3 infra/ai-council/learning.py --once          # учесть вердикты, поискать дрейф
    python3 infra/ai-council/learning.py --watch         # то же по расписанию (сервис)
    python3 infra/ai-council/learning.py --stats         # таблица надёжности моделей
    python3 infra/ai-council/learning.py --recommend     # кому какую роль отдать
    python3 infra/ai-council/learning.py --suggestions   # предложения по рубрике

Из четырёх механизмов §9 два уже работали до этого модуля: ledger вердиктов (таблица
`verdicts`, ставится из UI и `supervisor.py verdict`) и few-shot экземпляры (принятые
результаты индексируются в корпус как `exemplar` в context_service.index_verdicts и
попадают в улики капсулы через retrieval.EXPERIENCE_KINDS). Здесь — оставшиеся два.

── Механизм 2: веса надёжности ─────────────────────────────────────────────────
Для тройки `(модель, роль, модуль)` — Beta(α, β), апостериорное среднее α/(α+β).
Приор Beta(1,1) даёт 0.5 без данных, то есть новая модель не наказана и не поощрена.

Начисление (идемпотентно, см. `learning_ledger`):

| сигнал                              | кому                                  | Δ           |
|-------------------------------------|---------------------------------------|-------------|
| вердикт `accept`                    | всем предложившим + арбитру прогона    | α += 1      |
| вердикт `reject`                    | им же                                  | β += 1      |
| вердикт `edit`                      | им же                                  | α,β += 0.5  |
| галлюцинация от верификатора        | автору конкретного предложения         | β += 1      |

`edit` — половина на половину сознательно: результат пошёл в дело, но не как есть, и
трактовать его как чистый accept значит поощрять модель за работу, которую переписал
владелец. Галлюцинации начисляются отдельно от вердикта: непроверенная привязка —
объективный факт от верификатора, он не ждёт ревью владельца и не зависит от него.

Модуль берётся из карточки; кроме строки по модулю всегда обновляется агрегат `*`.
Без агрегата статистика была бы бесполезна ровно там, где она нужнее всего — на
карточках без проставленных модулей, а таких на борде большинство.

Потребители веса — два, оба честные:
  1. `council.review` — оценки рецензентов усредняются ВЗВЕШЕННО (`learning.review_weighting`).
     Модель, чьи собственные результаты владелец принимает, весит больше как рецензент.
  2. Подбор роли — перестановка ролей МЕЖДУ моделями того же ростера профиля
     (`learning.role_selection`, по умолчанию выключено). Именно перестановка, а не выбор
     из внешнего пула: состав резидентных моделей не меняется, значит не ломается ни
     бюджет памяти §4, ни число свопов L-моделей. Рекомендация считается всегда и видна
     в UI — включать автоподбор или нет, решает владелец.

── Механизм 4: дрейф рубрики ───────────────────────────────────────────────────
Причины `reject`/`edit` кластеризуются локальной моделью; кластер, повторившийся
`learning.rubric_drift_suggest_after` раз, становится ПРЕДЛОЖЕНИЕМ дополнить промпт или
рубрику. Автоприменения нет по построению: промпты версионируются в git, их правка —
коммит, а не побочный эффект фонового сервиса.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import signal
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                              # noqa: E402
import ollama as ollama_mod                              # noqa: E402
import textutil                                           # noqa: E402
from store import Store, now, sha16                      # noqa: E402

# Роли, которые участвуют в подборе (механизм 2, потребитель 2). Служебные роли
# (extractor, embed) в перестановке не участвуют: они не оцениваются вердиктом.
PROPOSER_ROLES = ("proposer.code", "proposer.arch", "proposer.skeptic")

# Вердикт → (Δα, Δβ). Значения — не настройка: они определяют смысл шкалы, а
# конфигурируемость здесь дала бы несравнимые между собой числа в истории.
VERDICT_DELTAS = {
    "accept": (1.0, 0.0),
    "reject": (0.0, 1.0),
    "edit":   (0.5, 0.5),
}

GLOBAL_MODULE = "*"

# Мишень предложения — ровно одна: «p.code, p.arch, critic…» одной строкой делал дедуп по мишени бесполезным
# (6 строк «Система ушла не туда» с разными наборами мишеней, замер 2026-10-14).
CLUSTER_TARGETS = ("prompts/proposer.code", "prompts/proposer.arch", "prompts/proposer.skeptic",
                   "prompts/critic", "prompts/arbiter", "rubric", "mechanism")

# Паттерн-категория вместо дефекта («Проблемы с качеством решений и проработкой задачи», hits 77) и паттерн-
# список мишеней («[prompts/proposer.code, …]») — шум: владелец «прорабатывает» его, а править нечего.
# Это заголовки рубрики владельца: ими всегда помечена категория, а не дефект.
_RUBRIC_HEADING_RE = re.compile(r"^\s*(не\s*корректн\w*\s+проработк|система\s+ушла\s+не\s+туда)", re.IGNORECASE)
# Начала, с которых пишут и категорию, и дефект: «Проблема с таймаутом слота: дедлайн истекает до рецензий»,
# «Качество решения падает при обрезке постановки». Категория — только если дальше перечень тем без причины.
_TOPIC_START_RE = re.compile(
    r"^\s*(проблем\w*\s+с\b|качеств\w*\s+решени\w*|(не\s*корректн\w*\s+)?коммуникаци\w*(\s+модел\w*)?|"
    r"проработк\w*(\s+\w+)?|поиск\w*\s+продуктов\w*)", re.IGNORECASE)
# Конкретика: число, условие или глагол в личной форме / прошедшем времени.
_CONCRETE_DEFECT_RE = re.compile(
    r"\d|\b(при|когда|хотя|без|до|после|вместо|из-за|если)\b|"
    r"\b\w{2,}(ет|ют|ит|ят|ется|ются|ится|ятся|ался|ился|ала|ило)\b",
    re.IGNORECASE)
_TARGET_SYNONYMS = {"механизм": "mechanism", "рубрика": "rubric", "арбитр": "prompts/arbiter",
                    "критик": "prompts/critic", "скептик": "prompts/proposer.skeptic"}


def normalize_target(raw: str) -> str:
    """Одна мишень из ответа модели: первая валидная из списка через запятую; иначе `rubric`."""
    for part in re.split(r"[,;\s]+", raw or ""):
        part = part.strip().strip("[]`'\":.").casefold()
        part = _TARGET_SYNONYMS.get(part, part)
        if part in CLUSTER_TARGETS:
            return part
        if f"prompts/{part}" in CLUSTER_TARGETS:
            return f"prompts/{part}"
    return "rubric"


def _only_targets(pattern: str) -> bool:
    """Паттерн — перечень мишеней без слов («prompts/proposer.code, prompts/arbiter»)."""
    rest = pattern
    for target in sorted(CLUSTER_TARGETS, key=len, reverse=True):
        rest = rest.replace(target, " ")
    return len(re.sub(r"[\W_]+", "", rest)) < 4


def actionable_pattern(pattern: str) -> bool:
    """Паттерн называет конкретный дефект, а не категорию, тему карточки или список мишеней."""
    p = (pattern or "").strip()
    if len(p) < 10 or p.startswith("[") or _only_targets(p) or _RUBRIC_HEADING_RE.match(p):
        return False
    start = _TOPIC_START_RE.match(p)
    return start is None or bool(_CONCRETE_DEFECT_RE.search(p[start.end():]))


CLUSTER_SCHEMA = {
    "type": "object",
    "properties": {
        "clusters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "target": {"type": "string", "enum": list(CLUSTER_TARGETS)},
                    "suggestion": {"type": "string"},
                    "run_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["pattern", "target", "suggestion", "run_ids"],
            },
        }
    },
    "required": ["clusters"],
}

CLUSTER_SYSTEM = """Ты разбираешь причины, по которым владелец отклонил или правил
результаты проработки задач. Твоя работа — сгруппировать причины по ПОВТОРЯЮЩЕМУСЯ
дефекту и предложить, чем дополнить инструкцию модели, чтобы дефект не повторялся.

Правила:
- Кластер — это дефект, а не тема. «Нет тестов в критериях приёмки» — кластер;
  «про телеграм» — не кластер. Категории («проблемы с качеством решений», «система ушла
  не туда», «некорректная проработка») — тоже не кластер: назови, ЧТО именно сломалось
  («воздержание при расхождении файлов, хотя файл назван в постановке»).
- У каждой причины указан исход прогона (воздержание и его причина или выданный результат).
  Ищи дефект в механизме, который привёл к этому исходу, а не в теме карточки.
- Если дефект чинится не словами в инструкции, а механизмом (порог, раунд, таймаут, сверка) —
  `target` = `mechanism`.
- Одна причина попадает максимум в один кластер. Причину, не похожую на остальные,
  не кластеризуй вовсе — единичный случай не повод править промпт.
- Два кластера об одном дефекте — ошибка: «коммуникация на постороннем языке» и
  «модели пишут не по-русски» — это ОДИН кластер, а не два.
- Если во входе есть список уже известных дефектов — кластер, повторяющий известный,
  не возвращай: он уже на учёте.
- `target` — ОДНА мишень: `prompts/proposer.code`, `prompts/proposer.arch`,
  `prompts/proposer.skeptic`, `prompts/critic`, `prompts/arbiter`, `rubric` или `mechanism`.
- `suggestion` — одна конкретная формулировка, которую можно дописать в инструкцию.
  Не пересказ причины, а требование к будущему ответу.
- `run_ids` — идентификаторы прогонов, вошедших в кластер, ровно как они даны во входе.
Отвечай ТОЛЬКО JSON по схеме."""


def log(message: str) -> None:
    print(message, flush=True)


# ── модуль карточки ─────────────────────────────────────────────────────────
def modules_of(card: dict | None) -> list[str]:
    """Модули карточки + агрегат `*`. Порядок важен: первым идёт агрегат, чтобы
    он существовал даже у карточки без модулей."""
    if not card:
        return [GLOBAL_MODULE]
    raw = card.get("modules") or "[]"
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError, json.JSONDecodeError):
        parsed = []
    modules = [str(m).strip() for m in (parsed or []) if str(m).strip()]
    return [GLOBAL_MODULE] + modules


# ── чтение статистики ───────────────────────────────────────────────────────
def posterior(store: Store, model: str, role: str, module: str = GLOBAL_MODULE) -> float:
    """Апостериорное среднее Beta(α,β). Без данных — 0.5 (приор Beta(1,1))."""
    row = store.q1(
        "SELECT alpha, beta FROM model_stats WHERE model = ? AND role = ? AND module = ?",
        (model, role, module))
    if not row:
        return 0.5
    alpha, beta = float(row["alpha"]), float(row["beta"])
    total = alpha + beta
    return round(alpha / total, 4) if total > 0 else 0.5


def observations(store: Store, model: str, role: str, module: str = GLOBAL_MODULE) -> float:
    """Сколько сигналов легло в тройку (за вычетом приора Beta(1,1))."""
    row = store.q1(
        "SELECT alpha, beta FROM model_stats WHERE model = ? AND role = ? AND module = ?",
        (model, role, module))
    if not row:
        return 0.0
    return max(0.0, float(row["alpha"]) + float(row["beta"]) - 2.0)


def reliability_table(store: Store, module: str = "") -> list[dict]:
    """Вся статистика, отсортированная по надёжности. Для UI и `--stats`."""
    params: tuple = ()
    where = ""
    if module:
        where = "WHERE module = ?"
        params = (module,)
    rows = store.q(
        f"SELECT model, role, module, alpha, beta, updated_at FROM model_stats {where}", params)
    out = []
    for row in rows:
        alpha, beta = float(row["alpha"]), float(row["beta"])
        total = alpha + beta
        out.append({
            "model": row["model"], "role": row["role"], "module": row["module"],
            "alpha": round(alpha, 2), "beta": round(beta, 2),
            "reliability": round(alpha / total, 4) if total else 0.5,
            "observations": round(max(0.0, total - 2.0), 2),
            "updated_at": row["updated_at"],
        })
    out.sort(key=lambda r: (-r["observations"], -r["reliability"], r["model"]))
    return out


def _model_aggregate(store: Store, model: str, module: str) -> tuple[float, float]:
    """α/β модели по ВСЕМ ролям в модуле. Приор вычитается по одной строке, иначе
    модель с пятью строками выглядела бы наблюдавшейся впятеро чаще, чем она есть."""
    row = store.q1(
        "SELECT SUM(alpha) a, SUM(beta) b, COUNT(*) n FROM model_stats "
        "WHERE model = ? AND module = ?", (model, module))
    if not row or not row["n"]:
        return 1.0, 1.0
    rows = int(row["n"])
    return float(row["a"]) - (rows - 1), float(row["b"]) - (rows - 1)


def backoff_posterior(store: Store, model: str, role: str, module: str,
                      minimum: float) -> tuple[float, str]:
    """Надёжность с откатом: роль → модель целиком → приор.

    Без отката перестановка ролей предпочитала бы модель БЕЗ данных модели с плохой
    историей: у первой апостериорное 0.5 (приор), у второй — 0.2. Формально это
    оптимизм под неопределённостью, практически — рекомендация «поставь на роль того,
    о ком мы ничего не знаем», причём именно ту модель, которая уже показала себя хуже
    всех в соседней роли. Репутация модели должна переезжать за ней в новую роль.
    """
    if observations(store, model, role, module) >= minimum:
        return posterior(store, model, role, module), "role"
    for fallback in (module, GLOBAL_MODULE):
        alpha, beta = _model_aggregate(store, model, fallback)
        if alpha + beta - 2.0 >= minimum:
            return round(alpha / (alpha + beta), 4), ("model" if fallback == module
                                                      else "model_global")
    return 0.5, "prior"


def reviewer_weight(store: Store, cfg, model: str, role: str,
                    module: str = GLOBAL_MODULE) -> float:
    """Вес рецензента для взвешенного среднего в `council.review`.

    Отображение p∈[0,1] → [0.5, 1.5]: без данных p=0.5 даёт ровно 1.0, то есть
    включение механизма на пустой статистике НИЧЕГО не меняет в оценках. Пока
    сигналов меньше `learning.min_observations`, вес принудительно 1.0 — один
    вердикт не должен перекашивать ревью.
    """
    if not cfg.get("learning.enabled", True) or not cfg.get("learning.review_weighting", True):
        return 1.0
    minimum = float(cfg.get("learning.min_observations", 3) or 0)
    seen = observations(store, model, role, module)
    if seen < minimum:
        seen_global = observations(store, model, role, GLOBAL_MODULE)
        if module == GLOBAL_MODULE or seen_global < minimum:
            return 1.0
        module = GLOBAL_MODULE
    return round(0.5 + posterior(store, model, role, module), 3)


# ── начисление (механизм 2) ─────────────────────────────────────────────────
def _bump(store: Store, model: str, role: str, module: str,
          d_alpha: float, d_beta: float) -> None:
    store.x(
        "INSERT INTO model_stats (model, role, module, alpha, beta, updated_at) "
        "VALUES (?,?,?,1.0,1.0,?) ON CONFLICT(model, role, module) DO NOTHING",
        (model, role, module, now()))
    store.x(
        "UPDATE model_stats SET alpha = alpha + ?, beta = beta + ?, updated_at = ? "
        "WHERE model = ? AND role = ? AND module = ?",
        (d_alpha, d_beta, now(), model, role, module))


def _participants(store: Store, run_id: str) -> list[tuple[str, str]]:
    """Кто отвечает за результат прогона: предложившие + арбитр.

    Арбитра нет в `proposals` — он не предлагает, а сливает, поэтому берём его из
    транскрипта. Рецензенты сюда не входят намеренно: владелец судит СЛИТЫЙ результат,
    а не рецензию; надёжность рецензента наследуется от его же роли предложившего
    (см. reviewer_weight).
    """
    pairs = {(row["model"], row["role"])
             for row in store.q(
                 "SELECT DISTINCT model, role FROM proposals WHERE run_id = ?", (run_id,))
             if row.get("model") and row.get("role")}
    for row in store.q(
            "SELECT DISTINCT model, role FROM messages WHERE run_id = ? AND ok = 1 "
            "AND role IN ('arbiter', 'cloud_judge')", (run_id,)):
        if row.get("model"):
            pairs.add((row["model"], row["role"]))
    return sorted(pairs)


def _already(store: Store, kind: str, ref: str) -> bool:
    return store.q1("SELECT 1 one FROM learning_ledger WHERE kind = ? AND ref = ?",
                    (kind, str(ref))) is not None


def _remember(store: Store, kind: str, ref: str, run_id: str, detail: dict) -> None:
    store.x(
        "INSERT OR IGNORE INTO learning_ledger (kind, ref, run_id, detail, applied_at) "
        "VALUES (?,?,?,?,?)",
        (kind, str(ref), run_id, json.dumps(detail, ensure_ascii=False), now()))


def apply_verdicts(store: Store, run_id: str = "") -> dict:
    """Учесть вердикты (все или одного прогона) в model_stats. Идемпотентно."""
    sql = ("SELECT v.id, v.run_id, v.decision, r.card_id FROM verdicts v "
           "JOIN runs r ON r.id = v.run_id")
    params: tuple = ()
    if run_id:
        sql += " WHERE v.run_id = ?"
        params = (run_id,)
    applied, skipped = 0, 0
    for row in store.q(sql, params):
        deltas = VERDICT_DELTAS.get((row["decision"] or "").strip())
        if not deltas:
            continue
        if _already(store, "verdict", row["id"]):
            skipped += 1
            continue
        card = store.get_card(row["card_id"]) if row.get("card_id") else None
        modules = modules_of(card)
        participants = _participants(store, row["run_id"])
        for model, role in participants:
            for module in modules:
                _bump(store, model, role, module, deltas[0], deltas[1])
        _remember(store, "verdict", row["id"], row["run_id"],
                  {"decision": row["decision"], "modules": modules,
                   "participants": [f"{m}/{r}" for m, r in participants]})
        applied += 1
    return {"applied": applied, "skipped": skipped}


def apply_hallucinations(store: Store, run_id: str = "") -> dict:
    """β += 1 автору предложения за каждую верификацию с несуществующими привязками.

    Сигнал независим от вердикта: «модель сослалась на файл, которого нет» — факт,
    установленный кодом, и ждать ревью владельца, чтобы его учесть, незачем.
    """
    sql = ("SELECT vf.id, vf.run_id, vf.proposal_id, vf.hallucinations, r.card_id "
           "FROM verifications vf JOIN runs r ON r.id = vf.run_id "
           "WHERE vf.hallucinations IS NOT NULL AND vf.hallucinations NOT IN ('', '[]')")
    params: tuple = ()
    if run_id:
        sql += " AND vf.run_id = ?"
        params = (run_id,)
    applied, skipped = 0, 0
    for row in store.q(sql, params):
        if _already(store, "hallucination", row["id"]):
            skipped += 1
            continue
        proposal = store.q1(
            "SELECT model, role FROM proposals WHERE run_id = ? AND id = ?",
            (row["run_id"], f"{row['run_id']}:{row['proposal_id']}"))
        if not proposal:
            # Верификация слитого результата (`proposal_id = 'merged'`) автора не имеет:
            # это продукт арбитража, и он уже учтён вердиктом. Записываем в ledger,
            # чтобы не перебирать её на каждом проходе.
            _remember(store, "hallucination", row["id"], row["run_id"], {"skipped": "no_author"})
            continue
        card = store.get_card(row["card_id"]) if row.get("card_id") else None
        try:
            count = len(json.loads(row["hallucinations"]) or [])
        except (TypeError, ValueError, json.JSONDecodeError):
            count = 1
        for module in modules_of(card):
            _bump(store, proposal["model"], proposal["role"], module, 0.0, 1.0)
        _remember(store, "hallucination", row["id"], row["run_id"],
                  {"model": proposal["model"], "role": proposal["role"], "count": count})
        applied += 1
    return {"applied": applied, "skipped": skipped}


def apply_run(store: Store, run_id: str) -> dict:
    """Синхронный хук: вызывается сразу после записи вердикта (§9 — «обновляется
    мгновенно»). Фоновый сервис нужен для дрейфа рубрики и для добора пропущенного,
    а не для того, чтобы вердикт вступал в силу через полчаса."""
    verdicts = apply_verdicts(store, run_id)
    halluc = apply_hallucinations(store, run_id)
    return {"verdicts": verdicts, "hallucinations": halluc}


# ── подбор роли (механизм 2, потребитель 2) ─────────────────────────────────
def role_recommendation(cfg, store: Store, profile: str,
                        module: str = GLOBAL_MODULE, roster: dict | None = None) -> dict:
    """Лучшая перестановка ролей предложивших МЕЖДУ моделями ростера профиля.

    Состав моделей не меняется — меняется только, кто под каким промптом выступает.
    Поэтому рекомендация безопасна по памяти (§4): те же модели, то же число свопов.
    """
    try:
        roles = roster if roster is not None else cfg.roles(profile)
    except config_mod.ConfigError:
        return {"profile": profile, "module": module, "available": False,
                "reason": f"нет ростера для профиля `{profile}`"}

    current = {role: roles[role] for role in PROPOSER_ROLES if roles.get(role)}
    if len(current) < 2:
        return {"profile": profile, "module": module, "available": False,
                "reason": "в ростере меньше двух предлагающих ролей — переставлять нечего",
                "current": current}

    minimum = float(cfg.get("learning.min_observations", 3) or 0)
    role_names = list(current)
    models = list(current.values())
    cells = {(m, r): backoff_posterior(store, m, r, module, minimum)
             for m in models for r in role_names}
    if all(basis == "prior" for _, basis in cells.values()):
        return {"profile": profile, "module": module, "available": False,
                "reason": (f"наблюдений меньше {minimum:g} ни по одному сочетанию "
                           "модель×роль — переставлять не на основании чего"),
                "current": current}

    from itertools import permutations
    scored = []
    for candidate in permutations(models):
        assignment = dict(zip(role_names, candidate))
        score = sum(cells[(m, r)][0] for r, m in assignment.items())
        scored.append((round(score, 4), assignment))
    scored.sort(key=lambda item: -item[0])
    best_score, best = scored[0]
    current_score = round(sum(cells[(m, r)][0] for r, m in current.items()), 4)

    changed = {r: (current[r], best[r]) for r in role_names if current[r] != best[r]}
    return {
        "profile": profile, "module": module, "available": True,
        "current": current, "current_score": current_score,
        "recommended": best, "recommended_score": best_score,
        "changes": {r: {"from": a, "to": b} for r, (a, b) in changed.items()},
        "gain": round(best_score - current_score, 4),
        # На чём основана оценка каждой пары: прямая статистика роли, репутация модели
        # целиком или ничего (приор). Без этого владелец не отличит «данные говорят»
        # от «данных нет, но перестановка формально выигрышна».
        "basis": {f"{r}:{m}": {"score": cells[(m, r)][0], "from": cells[(m, r)][1]}
                  for m in models for r in role_names},
        "thin": [r for r, m in best.items() if cells[(m, r)][1] == "prior"],
        "applied": bool(cfg.get("learning.role_selection", False)) and bool(changed),
    }


# ── «Кому какая роль»: ростеры и кандидаты, локальные и облачные ─────────────
BOARD_ROLES = PROPOSER_ROLES + ("arbiter",)
BOARD_PROFILES = ("fast", "deep", "hybrid", "cloud")
GLM_PROFILE = "GLM 5.x"


def cloud_models(cfg) -> set[str]:
    """Модели облачных провайдеров (`models.cloud.providers.*.models`) и режима GLM 5.x — по ростеру, не по имени:
    `glm4:latest` — локальная модель Ollama, `glm-4.6` — облачная Z.AI (как Council.is_cloud_model)."""
    out: set[str] = set()
    for node in (cfg.get("models.cloud.providers", {}) or {}).values():
        if isinstance(node, dict):
            out.update(str(m) for m in node.get("models") or [])
    import glm_mode  # noqa: PLC0415 — только для карты моделей режима
    out.update(v for k, v in glm_mode.settings(cfg)["models"].items() if k in BOARD_ROLES or k == "default")
    return out


def board_rosters(cfg) -> dict[str, dict[str, str]]:
    """Кто какую роль играет сейчас: профили конфига и режим GLM 5.x."""
    rosters: dict[str, dict[str, str]] = {}
    for profile in BOARD_PROFILES:
        try:
            roles = cfg.roles(profile)
        except config_mod.ConfigError:
            continue
        rosters[profile] = {r: roles[r] for r in BOARD_ROLES if roles.get(r)}
    import glm_mode  # noqa: PLC0415
    glm = glm_mode.settings(cfg)["models"]
    rosters[GLM_PROFILE] = {r: glm[r] for r in BOARD_ROLES if glm.get(r)}
    return rosters


def _board_posterior(stats: dict, model: str, role: str, module: str, minimum: float) -> tuple[float, str, float]:
    """`backoff_posterior` по снимку `model_stats` в памяти: (оценка, основание, наблюдений по роли). Те же
    формулы — роль → модель целиком в модуле → модель целиком глобально → приор; без запроса на каждую пару."""
    row = stats.get((model, role, module))
    seen = max(0.0, row[0] + row[1] - 2.0) if row else 0.0
    if row and seen >= minimum:
        return round(row[0] / (row[0] + row[1]), 4), "role", seen
    for fallback, label in ((module, "model"), (GLOBAL_MODULE, "model_global")):
        rows = [v for (m, _r, mod), v in stats.items() if m == model and mod == fallback]
        if rows:
            alpha = sum(v[0] for v in rows) - (len(rows) - 1)
            beta = sum(v[1] for v in rows) - (len(rows) - 1)
            if alpha + beta - 2.0 >= minimum:
                return round(alpha / (alpha + beta), 4), label, seen
    return 0.5, "prior", seen


def _stats_snapshot(store: Store, module: str) -> dict:
    """α/β из `model_stats` модуля и агрегата `*` одним запросом — вход `_board_posterior`."""
    return {(r["model"], r["role"], r["module"]): (float(r["alpha"]), float(r["beta"]))
            for r in store.q("SELECT model, role, module, alpha, beta FROM model_stats WHERE module IN (?, ?)",
                             (module, GLOBAL_MODULE))}


def reliability_grid(cfg, store: Store, board: dict, module: str = GLOBAL_MODULE) -> list[dict]:
    """Таблица «Надёжность моделей» вкладки «Качество» — вся сетка «модель × роль», из которой выбирает совет.

    Строки — пары из `model_stats` и пары доски ролей `board` без наблюдений (`prior`, α/β 1/1).
    `reliability`, α/β и `observations` — по самой роли. `score` и `basis` — оценка, которой пользуется совет:
    роль → модель в модуле → модель в целом → приор, как у доски ролей. Без них пара без наблюдений по роли
    показывала 0.50, а совет и доска брали репутацию модели, например 0.25 (AUTO-125)."""
    minimum = float(cfg.get("learning.min_observations", 3) or 0)
    stats = _stats_snapshot(store, module)
    table = reliability_table(store, module)
    seen = {(row["model"], row["role"]) for row in table}
    for role, candidates in (board.get("roles") or {}).items():
        for cand in candidates:
            if (cand["model"], role) in seen:
                continue
            seen.add((cand["model"], role))
            table.append({"model": cand["model"], "role": role, "module": module,
                          "alpha": 1.0, "beta": 1.0, "reliability": 0.5, "observations": 0.0,
                          "updated_at": None, "prior": True})
    for row in table:
        row["score"], row["basis"], _seen = _board_posterior(stats, row["model"], row["role"], module, minimum)
    return table


def role_board(cfg, store: Store, module: str = GLOBAL_MODULE) -> dict:
    """Кандидаты на каждую роль среди ВСЕХ известных моделей — из ростеров и статистики, с отметкой
    «облако/локально» и тем, где модель играет эту роль сейчас. Список полный (моделей десятки): выборку
    «облачные/локальные» делает UI, и лучший в выборке не теряется усечением до фильтра. Статистика — одним
    запросом; оценка — та же, что у перестановки ролей (роль → модель → приор), без данных — в конце."""
    rosters = board_rosters(cfg)
    clouds = cloud_models(cfg)
    minimum = float(cfg.get("learning.min_observations", 3) or 0)
    stats = _stats_snapshot(store, module)
    models = {m for roster in rosters.values() for m in roster.values()} | {m for m, _r, _mod in stats}
    roles: dict[str, list[dict]] = {}
    for role in BOARD_ROLES:
        rows = []
        for model in sorted(models):
            score, basis, seen = _board_posterior(stats, model, role, module, minimum)
            rows.append({"model": model, "cloud": model in clouds, "score": score, "basis": basis,
                         "observations": seen,
                         "in": [p for p, roster in rosters.items() if roster.get(role) == model]})
        rows.sort(key=lambda r: (r["basis"] == "prior", -r["score"], -r["observations"], r["model"]))
        roles[role] = rows[:60]
    out = {"module": module, "roles": roles, "rosters": rosters,
           "cloud": sorted(m for m in models if m in clouds)}
    glm_roster = rosters.get(GLM_PROFILE) or {}
    if len([r for r in PROPOSER_ROLES if glm_roster.get(r)]) >= 2:
        # Ростер режима GLM 5.x — из [models.glm_all.models]: перестановка считается, но применяется только
        # вручную (отдельным полем, не среди профилей с автоприменением).
        swap = role_recommendation(cfg, store, GLM_PROFILE, module, roster=glm_roster)
        swap["applied"] = False
        out["glm_swap"] = swap
    return out


def roles_for_run(cfg, store: Store, profile: str, card: dict | None) -> dict:
    """Ростер ролей на прогон. При выключенном `learning.role_selection` — ровно то,
    что в конфиге: механизм существует, но молча менять состав ролей он не вправе."""
    roles = dict(cfg.roles(profile))
    if not (cfg.get("learning.enabled", True) and cfg.get("learning.role_selection", False)):
        return roles
    modules = modules_of(card)
    module = modules[1] if len(modules) > 1 else GLOBAL_MODULE
    rec = role_recommendation(cfg, store, profile, module)
    if not rec.get("available") or not rec.get("changes"):
        return roles
    roles.update(rec["recommended"])
    return roles


# ── дрейф рубрики (механизм 4) ──────────────────────────────────────────────
def _token_set(text: str) -> set[str]:
    """Значимые слова текста для сравнения предложений между собой. Токенизация
    со стеммингом русских окончаний — общая с council.py (textutil.tokens):
    кластеризатор формулирует один дефект в разных словоформах."""
    return textutil.tokens(text)


def suggestion_duplicate(store: Store, target: str, pattern: str, suggestion: str,
                         threshold: float = 0.55) -> dict | None:
    """Смысловой дубль среди существующих предложений ТОЙ ЖЕ мишени.

    Точный `cluster_key` ловит только дословное совпадение паттерна. Локальная модель
    формулирует один дефект десятью способами («коммуникация моделей», «не корректная
    коммуникация моделей», «коммуникация моделей не соответствует требованиям»), и без
    этой проверки вкладка превращается в простыню переформулировок — замер 2026-09-02:
    65 предложений, большинство — вариации четырёх тем. Дубль обязан обновлять строку
    (вес дефекта растёт), а не плодить новую.

    Мишень участвует в сравнении всегда: одно и то же возражение к `proposer.code` и к
    `critic` — два разных изменения двух разных промптов, дублями не являются.
    """
    new = _token_set(f"{pattern} {suggestion}")
    if not new:
        return None
    for row in store.q("SELECT id, cluster_key, pattern, suggestion, evidence "
                       "FROM rubric_suggestions WHERE target = ?", (target,)):
        old = _token_set(f"{row['pattern']} {row['suggestion']}")
        if not old:
            continue
        union = len(new | old)
        if union and len(new & old) / union >= threshold:
            return row
    return None


def _reject_reasons(store: Store, limit: int = 60) -> list[dict]:
    return store.q(
        "SELECT v.run_id, v.decision, v.comment, c.title, r.status run_status, r.outcome "
        "FROM verdicts v JOIN runs r ON r.id = v.run_id "
        "LEFT JOIN cards c ON c.card_id = r.card_id "
        "WHERE v.decision IN ('reject', 'edit') AND TRIM(COALESCE(v.comment, '')) <> '' "
        "ORDER BY v.id DESC LIMIT ?", (limit,))


def cluster_reject_reasons(cfg, store: Store, client=None, cloud_client=None) -> dict:
    """Кластеризовать причины отклонений и записать предложения по рубрике.

    Возвращает сводку; при недоступной модели — честный отказ, а не пустой результат:
    «предложений нет» и «спросить было некого» — разные состояния, и путать их значит
    показывать владельцу, что дрейфа нет, когда его просто не искали.

    Модель (M10, docs/ai/COUNCIL-DRIFT-DESIGN.md §2): облачная (`learning.cluster_cloud_model`) не чаще раза в
    `learning.cluster_cloud_every_hours` при доступной квоте подписки, иначе — локальная (`learning.cluster_model`).
    Почему проход ушёл в локальную модель — `cloud_skipped` в сводке.
    """
    threshold = int(cfg.get("learning.rubric_drift_suggest_after", 3) or 3)
    reasons = _reject_reasons(store)
    if len(reasons) < threshold:
        return {"ok": True, "clustered": 0, "suggestions": 0,
                "reason": f"причин {len(reasons)}, порог {threshold} — кластеризовать нечего"}
    lines_all = [f"- run_id={r['run_id']} · {r['decision']} · исход: {_run_ending(r)} · "
                 f"{(r['title'] or '')[:60]} · {(r['comment'] or '').strip()[:300]}" for r in reasons]
    known_block = _known_defects_block(store)
    asked = _ask_clusterer(cfg, store, lines_all, threshold, known_block, client, cloud_client)
    if asked.get("error"):
        return {"ok": False, "clustered": 0, "suggestions": 0, "reason": asked["error"],
                "cloud_skipped": asked.get("cloud_skipped", "")}
    used = reasons[:asked["used"]]
    out = _record_clusters(cfg, store, asked["data"], used, threshold, asked["model"])
    out.update({"reasons_dropped_for_context": asked["dropped"], "model": asked["model"], "via": asked["via"],
                "cloud_skipped": asked.get("cloud_skipped", ""), "reason": ""})
    return out


def _known_defects_block(store: Store) -> str:
    """Уже известные дефекты — в промпт модели: дешевле не создавать дубль, чем ловить
    его потом кодом. Ограничение 30 — не вся таблица, а активная часть."""
    known_rows = store.q("SELECT target, pattern FROM rubric_suggestions "
                         "WHERE status != 'dismissed' ORDER BY updated_at DESC LIMIT 30")
    if not known_rows:
        return ""
    listing = "\n".join(f"- [{r['target']}] {r['pattern'][:100]}" for r in known_rows)
    return ("\n\nУЖЕ ИЗВЕСТНЫЕ ДЕФЕКТЫ (на учёте; новый кластер обязан быть "
            "НОВЫМ дефектом, а не их переформулировкой)\n" + listing)


def _cluster_messages(lines: list[str], threshold: int, known_block: str) -> list[dict]:
    user = ("ПРИЧИНЫ ОТКЛОНЕНИЙ И ПРАВОК\n" + "\n".join(lines)
            + f"\n\nСгруппируй так, чтобы в кластере было не меньше {threshold} причин. "
              "Кластеры меньшего размера не возвращай вовсе."
              " Не создавай два кластера об одном дефекте." + known_block)
    return [{"role": "system", "content": CLUSTER_SYSTEM}, {"role": "user", "content": user}]


def _ask_clusterer(cfg, store: Store, lines_all: list[str], threshold: int, known_block: str,
                   client=None, cloud_client=None) -> dict:
    """Спросить кластеризатор: облако, если пора и можно (M10), иначе или при его отказе — локальную модель.

    Ответ: {data, model, via: cloud|local, used: сколько причин ушло в промпт, dropped, cloud_skipped} либо
    {error, cloud_skipped} — спросить было некого.
    """
    try:
        answer, skipped = _ask_cloud_clusterer(cfg, store, lines_all, threshold, known_block, cloud_client)
    except Exception as exc:  # noqa: BLE001 — сбой облачного пути не роняет локальную кластеризацию (ревью #325)
        # Только тип исключения: его текст может нести адрес, ключ или ответ провайдера. Взятая заявка остаётся до конца
        # окна — лучше реже, чем лишний вызов квоты.
        answer, skipped = None, f"облачная кластеризация упала ({type(exc).__name__}) — кластеризует локальная модель"
    if answer is not None:
        return answer

    model = cfg.get("learning.cluster_model", "") or cfg.roles("fast").get("extractor", "")
    if not model:
        return {"error": "не задана модель кластеризации (learning.cluster_model)", "cloud_skipped": skipped}
    client = client or ollama_mod.build(cfg, store, holder="learning")
    if not client.alive():
        return {"error": "Ollama не отвечает — дрейф рубрики не проверен", "cloud_skipped": skipped}
    # Окно модели: 60 причин с исходом — ~22 тыс. символов (замер 2026-10-15), с правилами и известными
    # дефектами ~8–9 тыс. токенов при num_ctx 8192 — Ollama молча обрезал бы начало, и кластеры строились
    # бы по хвосту. Причины берутся от свежих, пока влезают; сколько не влезло — в отчёте.
    lines, dropped = _fit_lines(lines_all, _prompt_budget_chars(cfg) - len(CLUSTER_SYSTEM) - len(known_block) - 400)
    result = client.chat(model, _cluster_messages(lines, threshold, known_block),
                         schema=CLUSTER_SCHEMA, temperature=0.1, max_tokens=_CLUSTER_MAX_TOKENS)
    if not (result.ok and isinstance(result.data, dict)):
        return {"error": f"модель {model} не дала валидного ответа: {result.error or '—'}", "cloud_skipped": skipped}
    return {"data": result.data, "model": model, "via": "local", "used": len(lines), "dropped": dropped,
            "cloud_skipped": skipped}


def _ask_cloud_clusterer(cfg, store: Store, lines_all: list[str], threshold: int, known_block: str,
                         cloud_client=None) -> tuple[dict | None, str]:
    """Облачная попытка M10: (ответ кластеризатора, '') или (None, почему локально). Исключения — наружу: их ловит
    _ask_clusterer и уходит в локальную модель."""
    # Клиент облака (ключи, провайдеры) собирается, только когда облаку пора: проход идёт каждые 30 мин, а облако —
    # раз в 12 ч; до этого достаточно дешёвой проверки по отметке в council_state.
    early = _cloud_too_early(cfg, store)
    if cloud_client is None and str(cfg.get("learning.cluster_cloud_model", "") or "").strip() and not early:
        cloud_client = _cloud_cluster_client(cfg, store)
    if cloud_client is None:
        return None, early or "облачная кластеризация выключена (learning.cluster_cloud_model)"
    cloud_model, skipped = cloud_cluster_due(cfg, store, cloud_client)
    if not cloud_model:
        return None, skipped
    claim, skipped = _claim_cloud_window(cfg, store, cloud_model)
    if claim is None:
        return None, skipped
    lines, dropped = _fit_lines(lines_all, _CLUSTER_CLOUD_CHARS - len(CLUSTER_SYSTEM) - len(known_block) - 400)
    result = cloud_client.chat("learning-drift", "cluster", cloud_model, _cluster_messages(lines, threshold, known_block),
                               schema=CLUSTER_SCHEMA, temperature=0.1, max_tokens=_CLUSTER_MAX_TOKENS)
    import queue_control  # noqa: PLC0415 — нужен только облачному пути
    not_asked = _cloud_not_asked(result)
    if not_asked:
        # Спросить было некого (нет ключа, отметка квоты, бюджет окна): квота не тронута — окно не израсходовано.
        _release_cloud_window(store, claim)
    else:
        # Попытка считается и при отказе: «не чаще раза в N ч» — про вызовы квоты, а не про удачные ответы.
        queue_control.set_state(store, CLUSTER_CLOUD_STATE, {"at": claim["at"], "model": cloud_model,
                                                             "ok": bool(result.ok), "why": (result.error or "")[:200]})
    if result.ok and isinstance(result.data, dict):
        return {"data": result.data, "model": cloud_model, "via": "cloud", "used": len(lines), "dropped": dropped,
                "cloud_skipped": ""}, ""
    if not_asked:
        # Запроса не было — «не дало ответа» ввело бы в заблуждение: облако не спрашивали (23.10: окно плана 157/100).
        return None, f"облако {cloud_model} не спрошено: {result.error or '—'}"
    return None, f"облако {cloud_model} не дало валидного ответа: {result.error or '—'}"


def _record_clusters(cfg, store: Store, data: dict, reasons: list[dict], threshold: int, model: str) -> dict:
    """Записать кластеры ответа как предложения по рубрике: тема и список мишеней отбрасываются, улики — только из
    входа, дубль (точный ключ или смысловой) обновляет строку, а не плодит новую."""
    known = {r["run_id"] for r in reasons}
    by_run = {r["run_id"]: r for r in reasons}
    written = 0
    skipped: list[str] = []
    clusters = [c for c in (data.get("clusters") or []) if isinstance(c, dict)]
    for cluster in clusters:
        pattern = str(cluster.get("pattern") or "").strip()
        suggestion = str(cluster.get("suggestion") or "").strip()
        target = normalize_target(str(cluster.get("target") or ""))
        if not actionable_pattern(pattern):
            skipped.append(pattern[:120])
            continue
        # Улики фильтруются по входу: модель охотно выдумывает run_id, которых не было.
        # Та же логика, что у верификатора в §5 — проверяемое не голосуется.
        run_ids = sorted({str(x).strip() for x in (cluster.get("run_ids") or [])
                          if str(x).strip() in known})
        if not pattern or not suggestion or len(run_ids) < threshold:
            continue
        evidence = [{"run_id": rid, "decision": by_run[rid]["decision"],
                     "comment": (by_run[rid]["comment"] or "")[:300]} for rid in run_ids]
        if _merge_into_existing(cfg, store, target, pattern, suggestion, evidence, model):
            continue
        cluster_key = sha16(f"{target}|{pattern.lower()}")
        store.x(
            "INSERT INTO rubric_suggestions (cluster_key, pattern, suggestion, target, "
            "hits, evidence, model, status, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,'new',?,?)",
            (cluster_key, pattern, suggestion, target, len(run_ids),
             json.dumps(evidence, ensure_ascii=False), model, now(), now()))
        store.event("rubric.suggestion", cluster_key, pattern[:120])
        written += 1
    if skipped:
        # Отброшенное фильтром тем — видно в ленте: эвристика может ошибиться, и потеря дефекта не должна быть тихой.
        store.event("rubric.skipped_generic", str(len(skipped)), json.dumps(skipped, ensure_ascii=False)[:2000])
    return {"ok": True, "clustered": len(clusters), "suggestions": written,
            "skipped_generic": len(skipped), "skipped_patterns": skipped}


def _merge_into_existing(cfg, store: Store, target: str, pattern: str, suggestion: str,
                         evidence: list[dict], model: str) -> bool:
    """Кластер уже на учёте (тот же ключ или смысловой дубль) — объединить улики и вернуть True."""
    cluster_key = sha16(f"{target}|{pattern.lower()}")
    existing = store.q1("SELECT id, status, evidence FROM rubric_suggestions "
                        "WHERE cluster_key = ?", (cluster_key,))
    # Точный ключ не сошёлся — ищем смысловый дубль (модель переформулировала
    # известный дефект). Дубль обновляет существующую строку, а не создаёт новую:
    # иначе одна и та же правка промпта лежит в нескольких пунктах, и владелец
    # «прорабатывает» её заново.
    if existing is None:
        dedup_threshold = float(cfg.get("learning.dedup_jaccard", 0.55) or 0.55)
        existing = suggestion_duplicate(store, target, pattern, suggestion, dedup_threshold)
    if not existing:
        return False
    # Решённое предложение повторной кластеризацией не воскрешается: владелец
    # уже ответил, и возвращать ему тот же пункт каждые полчаса — не обучение.
    # Улики объединяются по run_id: hits — размер кластера (уникальные прогоны),
    # а не число проходов сервиса мимо него.
    try:
        old_evidence = json.loads(existing.get("evidence") or "[]")
    except (TypeError, ValueError, json.JSONDecodeError):
        old_evidence = []
    by_ev = {e.get("run_id"): e for e in old_evidence if isinstance(e, dict)}
    for item in evidence:
        by_ev.setdefault(item["run_id"], item)
    merged_evidence = list(by_ev.values())
    store.x(
        "UPDATE rubric_suggestions SET hits = ?, evidence = ?, suggestion = ?, "
        "model = ?, updated_at = ? WHERE id = ?",
        (len(merged_evidence), json.dumps(merged_evidence, ensure_ascii=False),
         suggestion, model, now(), existing["id"]))
    return True


# ── дрейф рубрики: облачный кластеризатор (M10) ─────────────────────────────
# Локальные 7–9B не держат правило «кластер — дефект, а не тема» (42 «новых» предложения-темы, §1 дизайна);
# glm-5 держит, но квота Coding Plan — ~46 вызовов на 5 ч. Поэтому облако — не чаще раза в N ч (по умолчанию 12:
# ≤ 2 вызовов в сутки) и только при доступной квоте подписки; платный второй контур кластеризации не нужен.
CLUSTER_CLOUD_STATE = "learning.cluster_cloud"   # council_state: когда облако кластеризовало в последний раз
# Окно glm-5 велико: все 60 причин с исходом (~22 тыс. символов) уходят без обрезки, в отличие от локальной модели.
_CLUSTER_CLOUD_CHARS = 60_000


def _cloud_period(cfg) -> tuple[float, str]:
    """(часы, '') — период облачной кластеризации; (0, причина) — облако не зовётся. 0 — выключено; неверное значение
    тоже выключает, а не подменяется 12: лучше реже, чем чаще, — квота подписки общая с консилиумом."""
    raw = cfg.get("learning.cluster_cloud_every_hours", 12)
    try:
        hours = float(raw)
    except (TypeError, ValueError):
        hours = math.nan
    if hours == 0:
        return 0, "облачная кластеризация выключена (learning.cluster_cloud_every_hours = 0)"
    if not (math.isfinite(hours) and hours > 0):
        return 0, f"learning.cluster_cloud_every_hours = {raw!r} — нужно число часов больше 0, облако не зовётся"
    return hours, ""


def _cloud_too_early(cfg, store: Store, now_ts: float | None = None) -> str:
    """Причина «рано», если облако кластеризовало (или пробовало) меньше N ч назад, или облако выключено; '' — пора."""
    every_h, off = _cloud_period(cfg)
    if off:
        return off
    now_ts = time.time() if now_ts is None else now_ts
    import queue_control  # noqa: PLC0415
    last = float((queue_control.get_state(store, CLUSTER_CLOUD_STATE) or {}).get("at") or 0)
    if last and now_ts - last < every_h * 3600:
        return f"облако кластеризовало {int((now_ts - last) // 3600)} ч назад — не чаще раза в {every_h:g} ч"
    return ""


def _claim_cloud_window(cfg, store: Store, model: str) -> tuple[dict | None, str]:
    """Атомарная заявка на облачный вызов в окне (ревью #325): плановый проход раз в 30 мин и ручной `--once` оба
    могли увидеть «пора» и позвать облако дважды. BEGIN IMMEDIATE — отметка «сейчас» пишется, только если её нет или
    она старше окна. ({at, prev}, '') — заявка взята: время заявки и прежняя отметка, чтобы вернуть её, если облако так
    и не спросили; (None, причина) — окно занято другим проходом или база консилиума не записала заявку."""
    every_h, off = _cloud_period(cfg)
    if off:
        return None, off
    import queue_control  # noqa: PLC0415
    ts = int(time.time())
    try:
        store.conn.execute("BEGIN IMMEDIATE")
        prev = queue_control.get_state(store, CLUSTER_CLOUD_STATE)
        last = float((prev or {}).get("at") or 0)
        if last and ts - last < every_h * 3600:
            store.conn.execute("COMMIT")
            return None, "облако уже кластеризует другой проход — " + (_cloud_too_early(cfg, store) or "окно занято")
        queue_control.set_state(store, CLUSTER_CLOUD_STATE, {"at": ts, "model": model, "ok": None, "why": "вызов идёт"})
        store.conn.execute("COMMIT")
        return {"at": ts, "prev": prev}, ""
    except sqlite3.Error as exc:
        try:
            store.conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        return None, f"ошибка базы консилиума ({type(exc).__name__}) — заявка на облако не записана, кластеризует локальная"


def _release_cloud_window(store: Store, claim: dict) -> None:
    """Снять свою заявку: вернуть прежнюю отметку (или никакой). Только если отметка всё ещё наша."""
    import queue_control  # noqa: PLC0415
    try:
        store.conn.execute("BEGIN IMMEDIATE")
        cur = queue_control.get_state(store, CLUSTER_CLOUD_STATE) or {}
        if cur.get("at") == claim["at"] and cur.get("ok") is None:
            queue_control.set_state(store, CLUSTER_CLOUD_STATE, claim["prev"])
        store.conn.execute("COMMIT")
    except sqlite3.Error:
        try:
            store.conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass


def _cloud_not_asked(result) -> bool:
    """Отказ клиента без запроса к провайдеру: облако.chat() отвечает так без HTTP (нет ключа, отметка квоты подписки,
    бюджет окна) — ни времени ответа, ни токенов. Запрос, который ушёл и упал (503, таймаут), квоту тратит."""
    return not result.ok and not getattr(result, "ms", 0) and not (getattr(result, "tokens_in", 0)
                                                                   or getattr(result, "tokens_out", 0))


def _cloud_cluster_client(cfg, store: Store):
    """Клиент облака только с подпиской: второй (платный) контур для кластеризации снят."""
    import cloud as cloud_mod  # noqa: PLC0415 — облако нужно, только когда кластеризует оно
    client = cloud_mod.build(cfg, store)
    for node in client.providers.values():
        node["fallback"] = {}
    return client


def cloud_cluster_due(cfg, store: Store, client, now_ts: float | None = None) -> tuple[str, str]:
    """('<модель>', '') — пора кластеризовать облаком; ('', причина) — нет: модель не задана, рано, облако
    недоступно или квота подписки исчерпана. Причина уходит в сводку прохода: «почему локально» видно."""
    model = str(cfg.get("learning.cluster_cloud_model", "") or "").strip()
    if not model:
        return "", "облачная кластеризация выключена (learning.cluster_cloud_model)"
    early = _cloud_too_early(cfg, store, now_ts)
    if early:
        return "", early
    ok, why = client.available(model)
    if not ok:
        return "", why
    until = client.quota_until(client.provider_of(model))
    if until:
        return "", f"квота подписки исчерпана до {time.strftime('%d.%m %H:%M', time.localtime(until))}"
    return model, ""


# Кириллица в токенизаторах Qwen/GLM — ~3 символа на токен; 2.5 — с запасом, чтобы не упереться в окно.
_CHARS_PER_TOKEN = 2.5
_CLUSTER_MAX_TOKENS = 1400


def _prompt_budget_chars(cfg) -> int:
    """Символов на вход кластеризатора: окно модели минус ответ и служебный запас."""
    num_ctx = int(cfg.get("models.num_ctx", 8192) or 8192)
    return int((num_ctx - _CLUSTER_MAX_TOKENS - 300) * _CHARS_PER_TOKEN)


def _fit_lines(lines: list[str], budget: int) -> tuple[list[str], int]:
    """Префикс строк, укладывающийся в бюджет символов (не меньше одной), и сколько отброшено."""
    used, kept = 0, []
    for line in lines:
        if kept and used + len(line) + 1 > budget:
            break
        kept.append(line)
        used += len(line) + 1
    return kept, len(lines) - len(kept)


def _run_ending(row: dict) -> str:
    """Чем кончился прогон — коротко, для кластеризатора: дефект ищется в механизме исхода."""
    if row.get("run_status") == "abstained":
        return "воздержание: " + (row.get("outcome") or "причина не записана")[:140]
    return "результат выдан" if row.get("run_status") == "done" else (row.get("run_status") or "—")


def suggestions(store: Store, status: str = "") -> list[dict]:
    where, params = "", ()
    if status:
        where, params = "WHERE status = ?", (status,)
    rows = store.q(
        f"SELECT id, cluster_key, pattern, suggestion, target, hits, evidence, model, "
        f"status, created_at, updated_at, decided_at FROM rubric_suggestions {where} "
        f"ORDER BY (status = 'new') DESC, hits DESC, id DESC", params)
    for row in rows:
        try:
            row["evidence"] = json.loads(row["evidence"] or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            row["evidence"] = []
    return rows


def decide_suggestion(store: Store, suggestion_id: int, status: str) -> dict:
    """Решение владельца по предложению. `applied` означает «я внёс правку в промпт»,
    а не «система внесла»: правка промпта — коммит в git, здесь только отметка."""
    if status not in {"new", "applied", "dismissed"}:
        return {"ok": False, "error": f"недопустимый статус `{status}`"}
    row = store.q1("SELECT id FROM rubric_suggestions WHERE id = ?", (suggestion_id,))
    if not row:
        return {"ok": False, "error": f"предложения #{suggestion_id} нет"}
    store.x("UPDATE rubric_suggestions SET status = ?, decided_at = ?, updated_at = ? "
            "WHERE id = ?", (status, now(), now(), suggestion_id))
    store.event("rubric.decided", str(suggestion_id), status)
    return {"ok": True, "id": suggestion_id, "status": status}


# ── проход ──────────────────────────────────────────────────────────────────
def run_once(cfg, store: Store, verbose: bool = True) -> dict:
    if not cfg.get("learning.enabled", True):
        if verbose:
            log("обучение выключено (learning.enabled = false)")
        return {"enabled": False}
    verdicts = apply_verdicts(store)
    halluc = apply_hallucinations(store)
    drift = cluster_reject_reasons(cfg, store)
    stats = store.q1("SELECT COUNT(*) n FROM model_stats") or {"n": 0}
    if verbose:
        log(f"обучение: вердиктов учтено {verdicts['applied']} (уже было "
            f"{verdicts['skipped']}), галлюцинаций {halluc['applied']}, "
            f"троек в статистике {stats['n']}")
        if drift.get("reason"):
            log(f"  дрейф рубрики: {drift['reason']}")
        elif drift.get("suggestions"):
            log(f"  дрейф рубрики: +{drift['suggestions']} предложений "
                f"(кластеров {drift['clustered']})")
        if drift.get("via") or drift.get("cloud_skipped"):
            # Кто кластеризовал и почему не облако — в логе прохода, а не только в возвращаемой сводке (M10, 23.10).
            who = f"{drift.get('via', '—')} ({drift.get('model') or '—'})"
            log(f"  дрейф рубрики: кластеризовала {who}"
                + (f"; без облака: {drift['cloud_skipped']}" if drift.get("cloud_skipped") else ""))
    return {"enabled": True, "verdicts": verdicts, "hallucinations": halluc,
            "drift": drift, "triples": stats["n"]}


def watch(cfg, store: Store) -> int:
    every = max(1, int(cfg.get("learning.rebuild_minutes", 30) or 30))
    stopping = {"now": False}

    def on_signal(_sig, _frame):
        stopping["now"] = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, on_signal)

    log(f"обучение: режим сервиса, проход каждые {every} мин")
    while not stopping["now"]:
        started = time.time()
        try:
            run_once(cfg, store)
        except Exception as exc:                            # noqa: BLE001
            log(f"❌ цикл обучения не удался: {type(exc).__name__}: {exc}")
        deadline = started + every * 60
        while not stopping["now"] and time.time() < deadline:
            time.sleep(min(5.0, max(0.0, deadline - time.time())))
    log("обучение остановлено по сигналу")
    return 0


# ── печать ──────────────────────────────────────────────────────────────────
def _print_stats(store: Store, module: str) -> None:
    rows = reliability_table(store, module)
    if not rows:
        log("статистика пуста: ни одного вердикта ещё не учтено")
        return
    log(f"{'модель':42} {'роль':22} {'модуль':16} {'α':>6} {'β':>6} {'надёжн':>8} {'набл':>6}")
    for row in rows:
        log(f"{row['model']:42} {row['role']:22} {row['module']:16} "
            f"{row['alpha']:6.1f} {row['beta']:6.1f} {row['reliability']:8.3f} "
            f"{row['observations']:6.1f}")


def _print_recommendation(cfg, store: Store, profile: str, module: str) -> None:
    rec = role_recommendation(cfg, store, profile, module)
    if not rec.get("available"):
        log(f"профиль {profile}: {rec.get('reason')}")
        return
    log(f"профиль {profile}, модуль {module}: "
        f"текущая сумма {rec['current_score']}, лучшая {rec['recommended_score']} "
        f"(выигрыш {rec['gain']:+.4f})")
    if not rec["changes"]:
        log("  текущее распределение ролей уже лучшее — менять нечего")
        return
    for role, change in rec["changes"].items():
        basis = (rec.get("basis") or {}).get(f"{role}:{change['to']}", {})
        origin = {"role": "по этой же роли", "model": "по репутации модели",
                  "model_global": "по репутации модели (агрегат)",
                  "prior": "ДАННЫХ НЕТ"}.get(basis.get("from", ""), "")
        log(f"  {role:22} {change['from']} → {change['to']}   ({origin})")
    log("  автоподбор " + ("включён (learning.role_selection = true)"
                           if cfg.get("learning.role_selection", False)
                           else "выключен — это только рекомендация"))


def _print_suggestions(store: Store) -> None:
    rows = suggestions(store)
    if not rows:
        log("предложений по рубрике нет")
        return
    for row in rows:
        mark = {"new": "•", "applied": "✓", "dismissed": "✗"}.get(row["status"], "•")
        log(f"{mark} #{row['id']} [{row['target']}] {row['pattern']} — повторов {row['hits']}")
        log(f"    {row['suggestion']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — обучение (§9)")
    parser.add_argument("--once", action="store_true", help="один проход и выйти")
    parser.add_argument("--watch", action="store_true",
                        help="режим сервиса: проход каждые learning.rebuild_minutes")
    parser.add_argument("--stats", action="store_true", help="таблица надёжности моделей")
    parser.add_argument("--recommend", action="store_true", help="рекомендация по ролям")
    parser.add_argument("--suggestions", action="store_true", help="предложения по рубрике")
    parser.add_argument("--decide", type=int, default=0, metavar="ID",
                        help="отметить предложение: --decide ID --status applied|dismissed")
    parser.add_argument("--status", default="applied", help="статус для --decide")
    parser.add_argument("--profile", default="fast", help="профиль для --recommend")
    parser.add_argument("--module", default=GLOBAL_MODULE, help="модуль для --stats/--recommend")
    parser.add_argument("--json", action="store_true", help="машиночитаемый вывод")
    args = parser.parse_args()

    cfg = config_mod.load(strict=False)
    with Store() as store:
        if args.decide:
            result = decide_suggestion(store, args.decide, args.status)
            log(json.dumps(result, ensure_ascii=False))
            return 0 if result.get("ok") else 1
        if args.stats:
            if args.json:
                log(json.dumps(reliability_table(store, args.module),
                               ensure_ascii=False, indent=1))
            else:
                _print_stats(store, args.module)
            return 0
        if args.recommend:
            rec = role_recommendation(cfg, store, args.profile, args.module)
            if args.json:
                log(json.dumps(rec, ensure_ascii=False, indent=1))
            else:
                _print_recommendation(cfg, store, args.profile, args.module)
            return 0
        if args.suggestions:
            if args.json:
                log(json.dumps(suggestions(store), ensure_ascii=False, indent=1))
            else:
                _print_suggestions(store)
            return 0
        if args.watch:
            return watch(cfg, store)
        result = run_once(cfg, store, verbose=not args.json)
        if args.json:
            log(json.dumps(result, ensure_ascii=False, indent=1))
        return 0


if __name__ == "__main__":
    sys.exit(main())
