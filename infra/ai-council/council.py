#!/usr/bin/env python3
"""AI Council — протокол консилиума. Только stdlib.

Канон: docs/specs/ai-council.md §5.

    R0  retrieve   капсула задачи (retrieval.py)
    R1  propose    три роли с РАЗНЫМ входом (код / архитектура+граф / история)
    R2  review     каждый рецензирует ЧУЖИЕ предложения, анонимно и в случайном порядке
    R3  verify     детерминированная проверка фактов (verifier.py), право вето
    R4  arbitrate  слияние лучшего с обязательной трассировкой источника
    R5  spiral     адверсариальная спираль: атака на слияние → ревизия → конвергенция
    R4' cloud      облачный арбитр — только разрешение тупика (§4а)
    R5' emit       запись результата

Что делает результат небессмысленным (иначе однородные модели просто соглашаются друг
с другом): разный вход по ролям, анонимизация, вето верификатора над всем проверяемым,
право воздержаться вместо выдуманного победителя и спираль, где решение обязано выдержать
целенаправленную атаку перед выдачей владельцу.
"""
from __future__ import annotations

import json
import random
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import debt as debt_mod                                # noqa: E402
import glm_mode                                        # noqa: E402
import learning as learning_mod                        # noqa: E402
import tournament as tournament_mod                     # noqa: E402
import textutil                                        # noqa: E402
from retrieval import Capsule                          # noqa: E402
from store import new_id, sha16                        # noqa: E402
import council_clean                                   # noqa: E402
from verifier import Verification, Verifier, looks_like_path   # noqa: E402
from council_rounds import (ExtraRounds, LanguageGate, abstain_kind,  # noqa: E402,F401
                            statement_files)
from council_infra import UNMERGED_CONFIDENCE, InfraRounds   # noqa: E402

PROMPTS = HERE / "prompts"
RUBRIC_KEYS = ("grounded", "complete", "decomposed", "risk_aware", "faithful_to_card")
MAX_RUBRIC = 3 * len(RUBRIC_KEYS)          # 15

# ── схемы structured output ─────────────────────────────────────────────────
_STR_ARRAY = {"type": "array", "items": {"type": "string"}}

_TOUCHED = {
    "type": "object",
    "properties": {"files": _STR_ARRAY, "routes": _STR_ARRAY,
                   "prisma_models": _STR_ARRAY, "rpcs": _STR_ARRAY, "modules": _STR_ARRAY},
    "required": ["files", "routes", "prisma_models", "rpcs", "modules"],
}

_STEP = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "what": {"type": "string"},
        "files": _STR_ARRAY,
        "est": {"type": "string", "enum": ["S", "M", "L", "XL"]},
        "depends_on": _STR_ARRAY,
    },
    "required": ["id", "what", "files", "est"],
}

_RISK = {
    "type": "object",
    "properties": {"what": {"type": "string"}, "severity": {"type": "string"},
                   "mitigation": {"type": "string"}},
    "required": ["what", "mitigation"],
}

# Проработка идеи обязана оставлять след рассмотренного и отвергнутого, а не только
# принятое решение — иначе это не проработка, а угадывание с одной попытки. Одно поле,
# не список: список превращается в формальность («накидай ещё вариантов»), одно —
# заставляет назвать РЕАЛЬНУЮ альтернативу. Вырожденный случай (approach ≈ переформулировка
# своего же goal) ловится дёшево в propose() через Jaccard — см. _looks_like_degenerate_alternative.
_ALTERNATIVE = {
    "type": "object",
    "properties": {
        "approach": {"type": "string"},
        "why_rejected": {"type": "string"},
    },
    "required": ["approach", "why_rejected"],
}

PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "goal": {"type": "string"},
        "non_goals": _STR_ARRAY,
        "decomposition": {"type": "array", "items": _STEP},
        "touched": _TOUCHED,
        "risks": {"type": "array", "items": _RISK},
        "acceptance": _STR_ARRAY,
        "verification_cmd": {"type": "string"},
        "open_questions": _STR_ARRAY,
        "alternative_considered": _ALTERNATIVE,
    },
    "required": ["goal", "decomposition", "touched", "acceptance",
                 "verification_cmd", "open_questions", "alternative_considered"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "object",
            "properties": {k: {"type": "integer"} for k in RUBRIC_KEYS},
            "required": list(RUBRIC_KEYS),
        },
        "blocking_objections": _STR_ARRAY,
        "best_part": {"type": "string"},
    },
    "required": ["scores", "blocking_objections", "best_part"],
}

_MERGED_STEP = dict(_STEP)
_MERGED_STEP["properties"] = dict(_STEP["properties"], **{"from": _STR_ARRAY})
_MERGED_STEP["required"] = ["id", "what", "files", "est", "from"]

MERGED_SCHEMA = {
    "type": "object",
    "properties": {
        "abstain": {"type": "boolean"},
        "goal": {"type": "string"},
        "non_goals": _STR_ARRAY,
        "decomposition": {"type": "array", "items": _MERGED_STEP},
        "touched": _TOUCHED,
        "risks": {"type": "array", "items": _RISK},
        "acceptance": _STR_ARRAY,
        "verification_cmd": {"type": "string"},
        "open_questions": _STR_ARRAY,
        "confidence": {"type": "number"},
    },
    "required": ["abstain", "goal", "decomposition", "touched", "acceptance",
                 "verification_cmd", "open_questions", "confidence"],
}

# R5: адверсариальная спираль. Адверсарий атакует текущее решение; всё, что не мешает
# брать его в работу, обязано уйти в minor — иначе спираль не сходится никогда.
ADVERSARIAL_SCHEMA = {
    "type": "object",
    "properties": {
        "blocking_objections": {"type": "array", "items": {"type": "string"}},
        "minor_objections": {"type": "array", "items": {"type": "string"}},
        "converged": {"type": "boolean"},
    },
    "required": ["blocking_objections", "minor_objections", "converged"],
}


@dataclass
class Proposal:
    id: str
    role: str
    model: str
    payload: dict
    verification: Verification | None = None
    review_score: float = 0.0
    objections: list[str] = field(default_factory=list)
    # Дополнительный раунд (M2 сверка / M3 дожим), после которого предложение такое, какое есть: «согласовано
    # в сверке» владелец должен видеть — согласие, достигнутое показом чужих ответов, не равно согласию с нуля.
    extra_round: str = ""
    # После сверки не осталось ни одного файла постановки — не участвует в воротах и арбитраже (council_rounds).
    excluded: bool = False

    @property
    def grounded(self) -> float:
        return self.verification.grounded_ratio if self.verification else 0.0

    @property
    def total_score(self) -> float:
        return self.review_score


@dataclass
class Outcome:
    status: str                      # done | abstained | failed | deferred (M4: сбой инфраструктуры, воркер отложит)
    reason: str = ""
    payload: dict | None = None
    confidence: float = 0.0
    readiness: float = 0.0
    proposals: list[Proposal] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)


# Слот → файл промпта ([prompts.bindings] config.toml, Настройки → «Модели и промпты»).
# Пусто/не задан — файл с именем слота. Заполняется в Council.__init__ из конфига процесса.
_PROMPT_BINDINGS: dict[str, str] = {}


def load_prompt(name: str) -> str:
    target = _PROMPT_BINDINGS.get(name) or name
    if not re.match(r"^[a-z][a-z0-9_.-]{1,60}$", target):
        target = name                      # мусор в конфиге — не повод читать путь за prompts/
    path = PROMPTS / f"{target}.md"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _role_slot(role: str) -> str:
    """Слот карты облачных моделей эскалации по метке роли в транскрипте:
    critic(proposer.code) рецензирует моделью proposer.code, arbiter(revise) — арбитр."""
    m = re.match(r"^critic\((.+)\)$", role or "")
    return m.group(1) if m else (role or "").split("(", 1)[0]


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def norm_objection_tokens(text: str) -> set[str]:
    """Нормализованный набор значимых слов возражения — для сравнения между раундами
    спирали. Токенизация со стеммингом русских окончаний — общая с learning.py
    (textutil.tokens): адверсарий переформулирует одно возражение в разных словоформах,
    и без приведения форм повтор не распознаётся."""
    return textutil.tokens(text)


def objections_repeat(current: list[str], previous_rounds: list[list[str]],
                      threshold: float = 0.6) -> bool:
    """Стоп-критерий спирали №2: возражения перестали меняться.

    Ревизёр уже попытался устранить эти возражения и не смог — третий круг по тому же
    списку ничего не добавит, это цикл, а не сужение. Повтором считается раунд, в котором
    не меньше половины текущих возражений совпали (по Жаккару токенов) с каким-то из
    прошлых раундов.
    """
    cur = [norm_objection_tokens(o) for o in current if str(o).strip()]
    if not cur or not previous_rounds:
        return False
    for prev_round in previous_rounds:
        prev = [norm_objection_tokens(o) for o in prev_round if str(o).strip()]
        if not prev:
            continue
        matched = sum(1 for c in cur if any(jaccard(c, p) >= threshold for p in prev))
        if matched >= max(1, len(cur) // 2):
            return True
    return False


def norm_files(payload: dict) -> set[str]:
    """Набор файлов предложения — основа проверки согласия моделей о скоупе.

    Не-пути (команды, обрывки shebang) отбрасываются: попав в множество, они не
    пересекаются ни с чем и занижают Jaccard, из-за чего согласные по сути предложения
    объявлялись расхождением («постановка сырая») и прогон воздерживался.
    """
    files = set()
    for ref in (payload.get("touched") or {}).get("files") or []:
        files.add(re.sub(r":\d+.*$", "", str(ref).strip().strip("`'\"").lstrip("./")))
    for step in payload.get("decomposition") or []:
        if isinstance(step, dict):
            for ref in step.get("files") or []:
                files.add(re.sub(r":\d+.*$", "", str(ref).strip().strip("`'\"").lstrip("./")))
    return {f for f in files if f and looks_like_path(f)}


def _looks_like_degenerate_alternative(payload: dict, threshold: float = 0.6) -> bool:
    """`alternative_considered` для галочки: approach/why_rejected почти совпадают по
    словам с собственным `goal` предложения — модель не рассмотрела реальный другой
    путь, а переформулировала основной план, чтобы закрыть обязательное поле схемы.

    Только лог-сигнал сейчас (видно в транскрипте прогона), не штраф в model_stats —
    штраф через debt.py требует отдельного решения, что это тот же класс сигнала, что
    delivery_failure (таймаут/невалидный JSON), а не смежный: сознательно не смешиваем.
    """
    alt = payload.get("alternative_considered") or {}
    approach = str(alt.get("approach") or "").strip()
    why = str(alt.get("why_rejected") or "").strip()
    if not approach:
        return False
    goal_tokens = textutil.tokens(str(payload.get("goal") or ""))
    alt_tokens = textutil.tokens(f"{approach} {why}")
    if not goal_tokens or not alt_tokens:
        return False
    return jaccard(goal_tokens, alt_tokens) >= threshold


def compute_readiness(payload: dict, verification: Verification) -> float:
    """Считается КОДОМ, не моделью: попроси модель оценить собственную готовность —
    получишь 0.9 всегда. Это поле управляет приоритизацией (§8), ему нельзя плыть."""
    steps = payload.get("decomposition") or []
    decomposed = len(steps) >= 2 and all(
        isinstance(s, dict) and s.get("files") for s in steps)
    acceptance = [a for a in (payload.get("acceptance") or []) if len(str(a).strip()) > 10]
    cmd_ok = any(c.kind == "command" and c.ok for c in verification.checks)
    no_questions = not (payload.get("open_questions") or [])

    return round(
        0.30 * (1.0 if decomposed else 0.0)
        + 0.25 * verification.grounded_ratio
        + 0.20 * (1.0 if len(acceptance) >= 2 else 0.0)
        + 0.15 * (1.0 if no_questions else 0.0)
        + 0.10 * (1.0 if cmd_ok else 0.0),
        3,
    )


class Council(LanguageGate, ExtraRounds, InfraRounds):
    """Протокол консилиума; доп. раунд (M2/M3) и языковой гейт (M6) — миксины из council_rounds.py."""

    def __init__(self, cfg, store, ollama_client, retriever, logger=None, cloud_client=None):
        self.cfg = cfg
        _PROMPT_BINDINGS.clear()
        _PROMPT_BINDINGS.update({str(k): str(v) for k, v in
                                 (cfg.get("prompts.bindings", {}) or {}).items() if v})
        self.store = store
        self.ollama = ollama_client
        self.retriever = retriever
        self.cloud = cloud_client            # None = облачного яруса нет, всё локально
        self.verifier = Verifier(cfg, store)
        self.log = logger or (lambda msg: None)
        # Облачная эскалация текущего прогона (cloud_escalation.Escalation) или None.
        # Ставит воркер на время прогона, протокол консилиума о ней не знает: меняются
        # только модели в ростере и маршрут облачного вызова (_ask).
        self.escalation = None
        # Прогон в режиме «всё на GLM 5.x» (glm_mode.py, §17.6) — ставит воркер на время
        # прогона. Меняет одно: облачный арбитр не выключает адверсариальную спираль (в режиме
        # облако — это весь консилиум с собственным бюджетом, а не спасатель тупика).
        self.glm_mode = False
        # Текст постановки и улик текущего прогона: слова оттуда — цитата, а не нарушение языкового гейта (M6).
        self._lang_allowed = ""
        # Роли, чей ответ остался на чужом языке после повтора, — в provenance прогона (видно владельцу).
        self._lang_failed: list[str] = []
        self._extra_kind = ""                # вид доп. раунда текущего прогона (M2 «сверка» / M3 «дожим»)
        self._infra: list[str] = []          # сбои инфраструктуры в локальных вызовах прогона (M4, council_infra)
        self._merge_mode = ""                # M5: "" — полный пакет арбитра, "compact" — повтор, "none" — без слияния

    def close(self) -> None:
        self.verifier.close()

    # ── вызов модели с логированием в транскрипт ─────────────────────────────
    def is_cloud_model(self, model: str) -> bool:
        """Модель обслуживается облачным провайдером, а не Ollama.

        Различие идёт по РОСТЕРУ провайдеров (`models.cloud.providers.*.models`), а не по
        имени: `glm4:latest` — локальная модель Ollama, `glm-4.6` — облачная Z.AI. Имена
        похожи, спутать их значит отправить локальный тег в HTTP-API и получить 404.
        """
        return self.cloud is not None and bool(self.cloud.provider_of(model))

    def _ask(self, run_id: str, round_no: int, role: str, model: str, system: str,
             user: str, schema: dict, temperature: float, max_tokens: int = 1600,
             timeout: int | None = None):
        started = time.time()
        result = self._ask_once(run_id, round_no, role, model, system, user, schema, temperature,
                                max_tokens, timeout)
        # Повтор идёт в остаток того же таймаута: арбитру таймаут считается от дедлайна карточки, и полный
        # таймаут на повтор вывел бы прогон за max_wall_seconds_per_card (ревью #159).
        left = None if timeout is None else int(timeout - (time.time() - started))
        return self._language_gate(run_id, round_no, role, model, system, schema, temperature,
                                   max_tokens, left, result)

    def _ask_once(self, run_id: str, round_no: int, role: str, model: str, system: str,
                  user: str, schema: dict, temperature: float, max_tokens: int = 1600,
                  timeout: int | None = None):
        started = time.time()
        messages = [{"role": "system", "content": system},
                    {"role": "user", "content": user}]
        if self.is_cloud_model(model) and self.escalation is not None:
            # Эскалация (задача ждала памяти дольше порога): отказ провайдера по доступности
            # → тот же запрос следующему провайдеру; отказали все → CloudUnavailable, прогон
            # уходит в очередь целиком, а не воздерживается из-за молчащего облака.
            prompt = system + "\n\n---\n\n" + user

            def failed_attempt(used_model, res):
                self.store.log_message(run_id, round_no, role, used_model, prompt,
                                       res.text or "", False, res.ms or 0,
                                       res.tokens_in, res.tokens_out)
            result = self.escalation.chat(run_id, role, model, messages, schema=schema,
                                          temperature=temperature, slot=_role_slot(role),
                                          on_fail=failed_attempt)
        elif self.is_cloud_model(model):
            # Облачная модель в роли участника — тот же протокол, тот же транскрипт.
            # Бюджет и лимиты частоты держит сам CloudClient: отказ приходит как
            # Completion(ok=False) с причиной, поэтому раунд деградирует так же, как
            # при молчании локальной модели, а не падает.
            # Потолок токенов НЕ берётся из локального аргумента: у GLM «мысли» идут в
            # счёт output и съедают лимит ДО ответа, поэтому 700 токенов на рецензию
            # (норма для Ollama) возвращают пустой content. Облаку даём его собственный
            # бюджетный потолок — на подписке цена вызова не зависит от длины ответа,
            # так что резать его нечем оправдать.
            result = self.cloud.chat(run_id, role, model, messages,
                                     schema=schema, temperature=temperature,
                                     max_tokens=None)
        else:
            result = self.ollama.chat(
                model, messages,
                schema=schema, temperature=temperature, max_tokens=max_tokens, retries=1,
                timeout=timeout,
            )
            self._note_infra(role, result, timeout)
        self.store.log_message(
            run_id, round_no, role, getattr(result, "model", "") or model,
            system + "\n\n---\n\n" + user,
            result.text or "", result.ok and result.data is not None,
            result.ms or int((time.time() - started) * 1000),
            result.tokens_in, result.tokens_out,
        )
        return result

    def _maybe_locked(self, model: str):
        """Контекст модельного лока: для L-модели эксклюзивно, для S — no-op."""
        return self.ollama.large_model(model)

    # ── R1: предложения ──────────────────────────────────────────────────────
    def propose(self, run_id: str, capsule: Capsule, roles: dict, track: str,
                round_no: int = 1) -> list[Proposal]:
        temperature = self.cfg.get("council.temperature_proposer", 0.3)
        self_consistency = self.cfg.get("council.self_consistency", {}) or {}
        proposals: list[Proposal] = []

        # Для half-baked трека роль одна и промпт другой: цель не «как сделать»,
        # а «что нужно решить, чтобы это стало задачей» (§7а).
        role_names = ["proposer.arch"] if track == "half_baked" else [
            "proposer.code", "proposer.arch", "proposer.skeptic"]

        for role in role_names:
            model = roles.get(role)
            if not model:
                continue
            prompt_name = "half_baked" if track == "half_baked" else role
            system = load_prompt(prompt_name)
            if not system:
                self.log(f"    ! нет промпта {prompt_name}, роль пропущена")
                continue
            user = self._proposer_user(capsule)

            samples = int(self_consistency.get(role, 1))
            candidates: list[dict] = []
            with self._maybe_locked(model):
                for i in range(max(samples, 1)):
                    result = self._ask(run_id, round_no, role, model, system, user,
                                       PROPOSAL_SCHEMA,
                                       temperature if samples == 1 else 0.6)
                    if result.ok and isinstance(result.data, dict):
                        candidates.append(result.data)

            if not candidates:
                self.log(f"    ✗ {role}: не дал валидного ответа")
                continue
            payload = _majority_by_files(candidates) if len(candidates) > 1 else candidates[0]
            proposal = Proposal(id=f"p{len(proposals) + 1}", role=role,
                                model=model, payload=payload)
            proposals.append(proposal)
            if _looks_like_degenerate_alternative(payload):
                self.log(f"    ! {role}: alternative_considered формальный "
                         "(почти совпадает с goal) — для галочки, не для дела")
            self.log(f"    ✓ {role} ({model}): {len(payload.get('decomposition') or [])} пунктов, "
                     f"{len(norm_files(payload))} файлов")
        return proposals

    # ── R3: верификация (до ревью — её результат идёт рецензентам) ───────────
    def verify(self, run_id: str, proposals: list[Proposal]) -> None:
        for proposal in proposals:
            # M7: маски — не пути, pytest/jest для TS — не та команда; чистка до верификатора (council_clean).
            for note in council_clean.clean_payload(proposal.payload):
                self.log(f"    ✂ {proposal.id}: {note}")
            verification = self.verifier.verify(proposal.payload, proposal.id)
            proposal.verification = verification
            self.store.x(
                "INSERT INTO verifications (run_id, proposal_id, checked, hallucinations, "
                "passed, created_at) VALUES (?,?,?,?,?,?)",
                (run_id, proposal.id,
                 json.dumps([c.as_dict() for c in verification.checks], ensure_ascii=False),
                 json.dumps([c.as_dict() for c in verification.hallucinations],
                            ensure_ascii=False),
                 1 if verification.passed else 0, int(time.time())),
            )
            mark = "✓" if verification.passed else "✗"
            self.log(f"    {mark} verify {proposal.id}: grounded={verification.grounded_ratio:.2f}"
                     f" ({len(verification.hallucinations)} несуществующих)")

    # ── R2: ревью ────────────────────────────────────────────────────────────
    def review(self, run_id: str, capsule: Capsule, proposals: list[Proposal],
               roles: dict, round_no: int = 2, module: str = "*",
               only: set[str] | None = None) -> None:
        """`only` — рецензировать заново только эти предложения (доп. раунд): остальные оценки не трогаются, а
        предложение из `only` без единой рецензии оценку не получает (без отката к верификатору — решает вызывающий).
        Возвращает, сколько рецензий дошло до каждого предложения."""
        if len(proposals) < 2:
            for proposal in proposals:                 # рецензировать нечем — только верификатор
                proposal.review_score = 3.0 * len(RUBRIC_KEYS) * proposal.grounded
            return {}

        system = load_prompt("critic")
        temperature = self.cfg.get("council.temperature_critic", 0.1)
        by_id = {p.id: p for p in proposals}
        # (оценка, вес рецензента). Вес — апостериорная надёжность модели по §9: рецензент,
        # чьи собственные результаты владелец отклоняет, весит меньше того, чьи принимает.
        # На пустой статистике все веса ровно 1.0, то есть механизм не искажает ничего,
        # пока данных нет (learning.reviewer_weight).
        collected: dict[str, list[tuple[float, float]]] = {p.id: [] for p in proposals}

        for reviewer in proposals:
            targets = [p for p in proposals if p.id != reviewer.id and (only is None or p.id in only)]
            # Анонимизация и перемешивание: рецензент не знает ни авторства, ни порядка —
            # иначе побеждает не лучшее предложение, а первое или «своё».
            random.shuffle(targets)
            model = roles.get(reviewer.role) or reviewer.model
            weight = learning_mod.reviewer_weight(self.store, self.cfg, model,
                                                  reviewer.role, module)
            with self._maybe_locked(model):
                for target in targets:
                    user = (f"ПОСТАНОВКА\n{capsule.pinned}\n\n"
                            f"ПРЕДЛОЖЕНИЕ НА РЕЦЕНЗИЮ\n"
                            f"{json.dumps(target.payload, ensure_ascii=False, indent=1)[:6000]}")
                    result = self._ask(run_id, round_no, f"critic({reviewer.role})", model,
                                       system, user, REVIEW_SCHEMA, temperature, max_tokens=700)
                    if not (result.ok and isinstance(result.data, dict)):
                        continue
                    scores = result.data.get("scores") or {}
                    total = sum(_clamp(scores.get(k, 0)) for k in RUBRIC_KEYS)
                    collected[target.id].append((float(total), weight))
                    objections = [o for o in (result.data.get("blocking_objections") or [])
                                  if str(o).strip()][:2]
                    by_id[target.id].objections += objections
                    self.store.x(
                        "INSERT INTO reviews (run_id, reviewer_model, reviewer_role, "
                        "target_proposal, scores, objections, weight, created_at) "
                        "VALUES (?,?,?,?,?,?,?,?)",
                        (run_id, model, reviewer.role, target.id,
                         json.dumps(scores, ensure_ascii=False),
                         json.dumps(objections, ensure_ascii=False), weight, int(time.time())),
                    )

        for proposal in proposals:
            if only is not None and proposal.id not in only:
                continue
            weighted = collected[proposal.id]
            if only is not None and not weighted:
                continue
            marks = [mark for mark, _ in weighted]
            if weighted:
                total_weight = sum(w for _, w in weighted)
                base = (sum(mark * w for mark, w in weighted) / total_weight
                        if total_weight > 0 else sum(marks) / len(marks))
            else:
                # Ни одной рецензии — значит рецензент СЛОМАЛСЯ (таймаут, потолок токенов,
                # невалидный JSON), а не оценил предложение плохо. Ноль здесь означал бы,
                # что отказ чужой модели молча топит чужую работу: замер 2026-08-13 —
                # предложение с grounded=1.00 и 4 пунктами декомпозиции получило 0.0/15
                # только потому, что его единственный рецензент упёрся в max_tokens_out,
                # и карточка воздержалась. Откатываемся к тому же, чем оценивается
                # предложение-одиночка: к верификатору, который не падает.
                base = 3.0 * len(RUBRIC_KEYS) * proposal.grounded
                self.log(f"    ! {proposal.id}: рецензий нет (рецензент не ответил) — "
                         f"оценка по верификатору")
            # Вето верификатора: непроверенные привязки обнуляют `grounded` независимо от
            # того, что поставили рецензенты. Проверяемое не голосуется.
            if proposal.verification and proposal.verification.hallucinations:
                base = min(base, MAX_RUBRIC * 0.6)
            proposal.review_score = round(base, 2)
            spread = {round(w, 2) for _, w in weighted}
            self.log(f"    · {proposal.id} ({proposal.role}): рецензии {marks} → "
                     f"{proposal.review_score}/{MAX_RUBRIC}"
                     + (f" (веса {sorted(spread)})" if spread and spread != {1.0} else "")
                     + (f", возражений {len(proposal.objections)}" if proposal.objections else ""))
        return {pid: len(marks) for pid, marks in collected.items()}

    # ── условия воздержания ──────────────────────────────────────────────────
    def should_abstain(self, proposals: list[Proposal]) -> tuple[bool, str]:
        if not proposals:
            return True, "ни одна модель не дала валидного предложения"
        active = [p for p in proposals if not p.excluded]
        if not active:
            return True, "после сверки ни одно предложение не сохранило файлов из постановки"
        proposals = active

        threshold = self.cfg.get("council.abstain_threshold", 9)
        best = max(p.total_score for p in proposals)
        if best < threshold:
            return True, (f"лучшая оценка {best:.1f} ниже порога {threshold} из {MAX_RUBRIC} — "
                          "ни одно предложение не годится в работу")

        # Счёт ведётся по ЛУЧШЕМУ предложению, а не суммой по всем. Сумма означала, что
        # один разболтавшийся proposer накрывает вето весь прогон, включая чистые
        # предложения коллег, — хотя в работу пойдёт ровно одно предложение, и вопрос
        # только в том, есть ли среди них пригодное. Замер 2026-08-13: 6 воздержаний из
        # 8 прогонов, при этом почти во всех был вариант без единой выдумки.
        max_hall = self.cfg.get("council.max_hallucinations", 2)
        counts = [len(p.verification.hallucinations) for p in proposals if p.verification]
        cleanest = min(counts) if counts else 0
        if cleanest > max_hall:
            best_proposal = min(
                (p for p in proposals if p.verification),
                key=lambda p: len(p.verification.hallucinations))
            refs = [c.ref for c in best_proposal.verification.hallucinations][:5]
            return True, (f"даже в самом чистом предложении {cleanest} несуществующих "
                          f"ссылок (порог {max_hall}): {', '.join(refs)}")

        if len(proposals) >= 2:
            min_agreement = self.cfg.get("council.scope_agreement_min", 0.25)
            files = [norm_files(p.payload) for p in proposals]
            pairs = [jaccard(files[i], files[j])
                     for i in range(len(files)) for j in range(i + 1, len(files))]
            agreement = max(pairs) if pairs else 0.0
            if agreement < min_agreement:
                return True, (f"модели поняли задачу по-разному (совпадение файлов "
                              f"{agreement:.2f} < {min_agreement}) — постановка сырая")

            # Расхождение по файлам ловит разные РЕШЕНИЯ. Не ловит: скоуп формально
            # совпал, а ЦЕЛЬ каждый proposer понял по-своему — это более фундаментальная
            # сырость постановки (см. config.toml council.goal_agreement_min), потому что
            # значит, что модели решали разные задачи и совпадение файлов случайно.
            min_goal_agreement = self.cfg.get("council.goal_agreement_min", 0.15)
            goals = [textutil.tokens(str(p.payload.get("goal") or "")) for p in proposals]
            goal_pairs = [jaccard(goals[i], goals[j])
                         for i in range(len(goals)) for j in range(i + 1, len(goals))]
            goal_agreement = max(goal_pairs) if goal_pairs else 0.0
            if goal_agreement < min_goal_agreement:
                return True, (f"модели разошлись в понимании ЦЕЛИ (совпадение goal "
                              f"{goal_agreement:.2f} < {min_goal_agreement}) — постановка "
                              "неоднозначна на уровне «что делать», не только «как»")
        return False, ""

    # ── R4: арбитраж ─────────────────────────────────────────────────────────
    def _arbitration_package(self, capsule: Capsule, proposals: list[Proposal]) -> str:
        proposals = [p for p in proposals if not p.excluded] or proposals
        anonymous = [{"id": p.id,
                      "предложение": p.payload,
                      "оценка_рецензентов": f"{p.total_score}/{MAX_RUBRIC}",
                      "возражения": p.objections,
                      "верификатор": p.verification.summary() if p.verification else "не проверено"}
                     for p in proposals]
        random.shuffle(anonymous)
        return (f"ПОСТАНОВКА\n{capsule.pinned}\n\n"
                f"ПРЕДЛОЖЕНИЯ, РЕЦЕНЗИИ И ОТЧЁТ ВЕРИФИКАТОРА\n"
                f"{json.dumps(anonymous, ensure_ascii=False, indent=1)[:12000]}")

    def arbitrate(self, run_id: str, capsule: Capsule, proposals: list[Proposal],
                  roles: dict, round_no: int = 4, deadline: float | None = None) -> dict | None:
        model = roles.get("arbiter")
        if not model:
            return None
        user = self._arbitration_package(capsule, proposals)
        # Бюджет времени на карточку должен действовать и здесь. Без этого `max_wall_seconds_
        # per_card` — декларация: раунд арбитража ничем не ограничен, и прогон по 125 карточкам
        # растягивается непредсказуемо (замер 2026-08-13: 7+ минут на одной карточке).
        timeout = None
        if deadline is not None:
            timeout = max(30, int(deadline - time.time()))
        with self._maybe_locked(model):
            result = self._ask(run_id, round_no, "arbiter", model, load_prompt("arbiter"), user,
                               MERGED_SCHEMA, self.cfg.get("council.temperature_arbiter", 0.2),
                               max_tokens=2000, timeout=timeout)
        if not (result.ok and isinstance(result.data, dict)):
            self.log("    ✗ арбитр не дал валидного ответа")
            return None
        return result.data

    # ── R4′: облачный арбитр (§4а) ───────────────────────────────────────────
    def should_escalate_cloud(self, card: dict, profile: str, track: str,
                              local: dict | None, reason: str) -> tuple[bool, str]:
        """Облако — разрешение тупика, а не улучшайзер. Поэтому обязательных условий
        два (тяжёлый профиль и не сырая постановка), а достаточное — любое из признаков
        того, что локальный контур не справился."""
        if self.cloud is None or not self.cfg.cloud_enabled():
            return False, ""
        esc = self.cfg.get("models.cloud.escalate_when", {}) or {}

        required_profile = esc.get("require_profile", "deep")
        if required_profile and profile != required_profile:
            return False, ""
        if track in (esc.get("never_for_tracks") or []):
            return False, ""

        if local is None:
            if esc.get("local_abstained", True):
                return True, reason or "локальный консилиум воздержался"
            return False, ""

        confidence = float(local.get("confidence") or 0.0)
        threshold = float(esc.get("confidence_lt", 0.45))
        if confidence < threshold:
            return True, f"локальная уверенность {confidence:.2f} ниже порога {threshold}"

        # Критичность и ширина изменения — признаки цены ошибки, а не признаки того, что
        # локальный контур не справился. Если он справился уверенно, платить (и жечь RPD
        # бесплатного яруса) не за что: облако не сделает подтверждённый результат
        # подтверждённее. Иначе КАЖДАЯ critical-карточка = облачный вызов.
        comfort = float(esc.get("skip_if_confidence_gte", 0.75))
        if confidence >= comfort:
            return False, ""

        severity = str(card.get("severity") or card.get("priority") or "").lower()
        if severity and severity in {str(s).lower() for s in (esc.get("severity_in") or [])}:
            return True, (f"severity={severity} при уверенности {confidence:.2f} — "
                          "цена ошибки выше цены вызова")

        modules = len((local.get("touched") or {}).get("modules") or [])
        if modules > int(esc.get("modules_gt", 99)):
            return True, f"затронуто модулей: {modules} при уверенности {confidence:.2f}"
        return False, ""

    def cloud_arbitrate(self, run_id: str, capsule: Capsule, proposals: list[Proposal],
                        reason: str, round_no: int = 6) -> tuple[dict | None, str]:
        """Обход лестницы моделей снизу вверх, начиная со ступени `judge`.

        Подписка Coding Plan тратится числом вызовов, поэтому «взять сразу самую сильную»
        не экономит ничего, а вот дешёвая ступень часто закрывает вопрос за один вызов.
        Вверх поднимаемся только когда предыдущая ступень не дала валидного ответа —
        и не дальше одной ступени за раз, ограничение `max_calls_per_run` всё равно
        обрежет обход."""
        ladder = list(self.cfg.get("models.cloud.roles.ladder", []) or [])
        start = self.cfg.cloud_role("judge")
        if self.glm_mode:
            # Режим «всё на GLM 5.x» (§17.6): судья тупика — модель режима, а не лестница
            # [models.cloud.roles] (там же 4.x; владелец мог поставить и judge = glm-4.6).
            candidates = [glm_mode.model_for(self.cfg, "judge")]
        elif ladder:
            index = ladder.index(start) if start in ladder else 0
            candidates = ladder[index:]
        else:
            candidates = [start]

        system = load_prompt("cloud_judge") or load_prompt("arbiter")
        user = (self._arbitration_package(capsule, proposals)
                + f"\n\nПОЧЕМУ ЛОКАЛЬНЫЙ КОНТУР НЕ СПРАВИЛСЯ\n{reason}")

        for model in [m for m in candidates if m]:
            result = self.cloud.chat(
                run_id, "judge.cloud", model,
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                schema=MERGED_SCHEMA,
                temperature=self.cfg.get("council.temperature_arbiter", 0.2),
            )
            self.store.log_message(run_id, round_no, "judge.cloud", model,
                                   system + "\n\n---\n\n" + user, result.text or "",
                                   result.ok and result.data is not None, result.ms,
                                   result.tokens_in, result.tokens_out)
            if result.ok and isinstance(result.data, dict):
                return result.data, model
            self.log(f"    ✗ облачный арбитр {model}: {result.error[:120]}")
            # Бюджет общий на все облачные модели: если упёрлись в потолок, платная
            # упрётся в тот же — второй отказ не добавит ничего, кроме строки в учёте.
            if not self.cloud.check_budget(run_id, model)[0]:
                break
        return None, ""

    # ── R5: адверсариальная спираль (дивергенция → конвергенция) ─────────────
    def adversarial_spiral(self, run_id: str, capsule: Capsule, merged: dict,
                           roles: dict, deadline: float | None = None) -> tuple[dict, dict]:
        """Дожим слияния раундами «атака → ревизия» до конвергентного состояния.

        Дивергентная фаза: адверсарий (промпт `adversary.md`, отдельная модель — скептик
        профиля, иначе арбитр) атакует решение по убыванию цены промаха: дрейф цели,
        полнота, скрытые допущения, потери при слиянии, путь сбоя. Конвергентная фаза:
        ревизёр (арбитр) переписывает слияние, устраняя блокирующие возражения. Спираль
        сходится по одному из правил — и все они проверяются КОДОМ, а не моделью:

        1. адверсарий не нашёл блокирующих возражений (или объявил converged);
        2. возражения перестали меняться между раундами (`objections_repeat`) —
           ревизор не может устранить устойчивый дефект, это вопрос владельцу, не цикл;
        3. исчерпан лимит раундов / бюджет времени.

        Что не сошлось — не выбрасывается: остаточные блокирующие возражения уходят в
        `open_questions` с префиксом «адверсарий:», владелец видит, что именно не сошлось.
        Любой сбой (нет промпта, модель молчит) оставляет прошлую версию решения — спираль
        улучшает или оставляет как есть, ухудшить правом не обладает.
        """
        adv_cfg = self.cfg.get("council.adversarial", {}) or {}
        report: dict = {"enabled": bool(adv_cfg.get("enabled", True)), "rounds": 0,
                        "converged": False, "stop_reason": "", "objections": [],
                        "models": {}}
        if not report["enabled"]:
            report["stop_reason"] = "выключено в конфиге"
            return merged, report

        system = load_prompt("adversary")
        if not system:
            report["stop_reason"] = "нет промпта adversary"
            return merged, report

        rev_model = roles.get("arbiter") or ""
        adv_role = str(adv_cfg.get("role", "proposer.skeptic"))
        adv_model = roles.get(adv_role) or rev_model
        if not adv_model or not rev_model:
            report["stop_reason"] = "нет моделей для спирали"
            return merged, report
        # Облачный ревизёр = платные вызовы на каждый раунд. Облако в этой системе
        # разрешает тупик, а не улучшает подтверждённый результат (§4а), поэтому спираль
        # работает только на локальном арбитре. Исключение — режим GLM 5.x: там владелец
        # явно отдал облаку весь прогон и поднял потолок вызовов под него (models.glm_all),
        # а без спирали проработка в режиме была бы слабее локального deep.
        if self.is_cloud_model(rev_model) and not self.glm_mode:
            report["stop_reason"] = "арбитр облачный — спираль не расходует бюджет"
            report["models"] = {"reviser": rev_model}
            return merged, report
        report["models"] = {"adversary": adv_model, "reviser": rev_model}
        if adv_model == rev_model:
            self.log("    ! адверсарий = ревизёр (нет скептика в профиле): атака слабее, "
                     "но разный промпт и разная задача сохраняются")

        max_rounds = max(1, int(adv_cfg.get("max_rounds", 2)))
        max_blocking = max(1, int(adv_cfg.get("max_blocking", 3)))
        repeat_threshold = float(adv_cfg.get("repeat_jaccard", 0.6))
        temp_adversary = float(adv_cfg.get("temperature", 0.4))
        temp_revise = float(adv_cfg.get("temperature_revise", 0.2))

        current = merged
        history: list[list[str]] = []

        for round_no in range(1, max_rounds + 1):
            if deadline is not None and time.time() >= deadline - 30:
                report["stop_reason"] = "бюджет времени исчерпан"
                break

            # ── дивергентная фаза: атака ────────────────────────────────────
            prev_block = ""
            if history:
                listing = "\n".join(f"- {o}" for o in history[-1])
                prev_block = (f"\n\nВОЗРАЖЕНИЯ ПРЕДЫДУЩЕГО РАУНДА (проверь: устранены "
                              f"или заметены)\n{listing}")
            user = (f"ПОСТАНОВКА\n{capsule.pinned}\n\n"
                    f"РЕШЕНИЕ НА АТАКУ (раунд {round_no})\n"
                    f"{json.dumps(current, ensure_ascii=False, indent=1)[:12000]}"
                    + prev_block)
            with self._maybe_locked(adv_model):
                attack = self._ask(run_id, 5, "adversary", adv_model, system, user,
                                   ADVERSARIAL_SCHEMA, temp_adversary, max_tokens=900,
                                   timeout=max(30, int(deadline - time.time()))
                                   if deadline is not None else None)
            if not (attack.ok and isinstance(attack.data, dict)):
                report["stop_reason"] = "адверсарий не дал валидного ответа"
                break
            blocking = [str(o).strip() for o in (attack.data.get("blocking_objections") or [])
                        if str(o).strip()][:max_blocking]
            history.append(blocking)
            report["rounds"] = round_no
            report["objections"].append(blocking)

            if attack.data.get("converged") or not blocking:
                report["converged"] = True
                report["stop_reason"] = ("возражений нет" if not blocking
                                         else "адверсарий подтвердил сходимость")
                self.log(f"    ✥ спираль: сходится на раунде {round_no}"
                         f" ({len(blocking)} блокирующих)")
                break

            # Проверка цикла — раньше лимита раундов: повтор возражений точнее
            # объясняет остановку («ревизор не может устранить»), чем «кончились раунды».
            if objections_repeat(blocking, history[:-1], repeat_threshold):
                report["stop_reason"] = "возражения перестали меняться (цикл)"
                break
            if round_no >= max_rounds:
                report["stop_reason"] = "достигнут лимит раундов"
                break

            # ── конвергентная фаза: ревизия ─────────────────────────────────
            rev_system = load_prompt("arbiter")
            rev_user = (f"ПОСТАНОВКА\n{capsule.pinned}\n\n"
                        f"ТЕКУЩЕЕ РЕШЕНИЕ (твоя прошлая версия слияния)\n"
                        f"{json.dumps(current, ensure_ascii=False, indent=1)[:12000]}\n\n"
                        f"БЛОКИРУЮЩИЕ ВОЗРАЖЕНИЯ АДВЕРСАРИЯ\n"
                        + "\n".join(f"- {o}" for o in blocking)
                        + "\n\nУстрани КАЖДОЕ возражение: поправь пункты декомпозиции, "
                          "риски, acceptance. Сохрани трассировку `from` по каждому "
                          "пункту. Новых фактов о коде не вноси: возражение, которое "
                          "нельзя устранить без новых данных, вынеси в open_questions "
                          "и не выдумывай.")
            with self._maybe_locked(rev_model):
                revision = self._ask(run_id, 5, "arbiter(revise)", rev_model, rev_system,
                                     rev_user, MERGED_SCHEMA, temp_revise, max_tokens=2000,
                                     timeout=max(30, int(deadline - time.time()))
                                     if deadline is not None else None)
            if not (revision.ok and isinstance(revision.data, dict)) \
                    or revision.data.get("abstain"):
                report["stop_reason"] = "ревизия не удалась — оставлена прошлая версия"
                break
            current = revision.data
            self.log(f"    ✥ спираль: раунд {round_no} — {len(blocking)} блокирующих, "
                     f"ревизия применена")

        # Не сошлось — остаточные возражения обязаны стать видимыми владельцу.
        if not report["converged"] and report["objections"] and report["objections"][-1]:
            open_qs = list(dict.fromkeys(
                [str(q) for q in (current.get("open_questions") or []) if str(q).strip()]
                + [f"адверсарий: {o[:220]}" for o in report["objections"][-1]]))
            current["open_questions"] = open_qs[:12]

        return current, report

    # ── постобработка слияния ────────────────────────────────────────────────
    def sanitize(self, merged: dict, proposals: list[Proposal]) -> tuple[dict, list[str]]:
        """Арбитр физически не должен вносить непроверенные факты. Всё, что он назвал,
        прогоняется верификатором ещё раз, и непрошедшее вырезается, а не «отмечается»."""
        removed: list[str] = []
        verification = self.verifier.verify(merged, "merged")
        bad = {c.ref for c in verification.hallucinations}

        touched = merged.get("touched") or {}
        for key in ("files", "routes", "prisma_models", "rpcs"):
            kept = []
            for ref in touched.get(key) or []:
                clean = re.sub(r":\d+.*$", "", str(ref).strip().strip("`'\"").lstrip("./"))
                if clean in bad or str(ref).strip() in bad:
                    removed.append(f"{key}: {ref}")
                else:
                    kept.append(ref)
            touched[key] = kept
        merged["touched"] = touched

        known_ids = {p.id for p in proposals}
        steps = []
        for step in merged.get("decomposition") or []:
            if not isinstance(step, dict):
                continue
            sources = [s for s in (step.get("from") or []) if s in known_ids]
            if not sources:
                removed.append(f"пункт без источника: {str(step.get('what'))[:60]}")
                continue
            step["from"] = sources
            step["files"] = [f for f in (step.get("files") or [])
                             if re.sub(r":\d+.*$", "", str(f).strip().strip("`'\"").lstrip("./"))
                             not in bad]
            steps.append(step)
        merged["decomposition"] = steps
        return merged, removed

    def _finalize(self, merged: dict, proposals: list[Proposal]):
        """Общий хвост для любого арбитра — локального и облачного. Вырезание
        непроверенного, повторная верификация и расчёт readiness/confidence обязаны
        применяться к облачному ответу ровно так же: у облака нет доступа к репозиторию,
        поэтому его ссылки заведомо менее надёжны, а не более."""
        cleaned = council_clean.clean_payload(merged)          # M7: маски и команда проверки — до верификатора
        merged, removed = self.sanitize(merged, proposals)
        removed = cleaned + removed
        if removed:
            self.log(f"    ✂ вырезано непроверенного: {len(removed)}")
        verification = self.verifier.verify(merged, "merged")
        readiness = compute_readiness(merged, verification)
        confidence = float(merged.get("confidence") or 0.0)
        # Уверенность не может превышать долю подтверждённого: модель систематически
        # переоценивает себя, верификатор — нет.
        confidence = round(min(confidence, 0.25 + 0.75 * verification.grounded_ratio), 3)
        return merged, removed, verification, readiness, confidence

    # ── полный прогон по карточке ────────────────────────────────────────────
    def roster(self, profile: str, card: dict) -> dict:
        """Ростер ролей на прогон. Может быть переставлен по статистике §9
        (learning.role_selection); при выключенном механизме — ровно то, что в конфиге."""
        return learning_mod.roles_for_run(self.cfg, self.store, profile, card)

    def run_card(self, run_id: str, card: dict, capsule: Capsule, profile: str,
                 track: str = "elaborate", roles_override: dict | None = None) -> Outcome:
        # roles_override — облачная эскалация (§17.4): тот же ростер, только L-модели
        # заменены облачными. Профиль, трек, промпты и пороги остаются от исходного прогона.
        roles = roles_override or self.roster(profile, card)
        configured = self.cfg.roles(profile)
        if roles_override:
            swapped = {r: f"{configured.get(r)}→{m}" for r, m in roles.items()
                       if configured.get(r) != m}
            self.log(f"    ☁ ростер {'GLM 5.x' if self.glm_mode else 'эскалации'}: {swapped}")
        elif roles != configured:
            swapped = {r: f"{configured.get(r)}→{m}" for r, m in roles.items()
                       if configured.get(r) != m}
            self.log(f"    ⇄ роли переставлены по статистике: {swapped}")
        modules = learning_mod.modules_of(card)
        module = modules[1] if len(modules) > 1 else learning_mod.GLOBAL_MODULE
        started = time.time()
        deadline = started + self.cfg.get("council.max_wall_seconds_per_card", 420)
        self._lang_allowed = (capsule.pinned or "") + "\n" + capsule.evidence_text()
        self._lang_failed, self._extra_kind = [], ""
        self._infra, self._merge_mode = [], ""
        # Повтор того же прогона (отложен M4, ждал памяти или квоты, подхвачен после рестарта воркера): строки прошлой
        # попытки сталкивались на proposals.id — 2 прогона упали с «UNIQUE constraint failed: proposals.id».
        self.store.clear_attempt(run_id)

        proposals = self.propose(run_id, capsule, roles, track)
        if not proposals:
            if self._infra:
                return Outcome("deferred", self.infra_reason("ни одного предложения"))
            return Outcome("abstained", "ни одна модель не дала валидного предложения")

        self.verify(run_id, proposals)
        for proposal in proposals:
            self.store.x(
                "INSERT INTO proposals (id, run_id, role, model, payload, grounded_score, "
                "review_score, total_score, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (f"{run_id}:{proposal.id}", run_id, proposal.role, proposal.model,
                 json.dumps(proposal.payload, ensure_ascii=False), proposal.grounded,
                 0.0, 0.0, int(time.time())),
            )

        if time.time() < deadline:
            self.review(run_id, capsule, proposals, roles, module=module)
        elif self._infra:
            return Outcome("deferred", self.infra_reason("рецензий не было — время ушло на сбой"),
                           proposals=proposals)
        else:
            self.log("    ! бюджет времени исчерпан до раунда рецензий")

        merged: dict | None = None
        abstain_reason = ""
        questions: list[str] = []
        cloud_note: dict = {}

        # Half-baked трек не воздерживается: неполнота там — ожидаемый результат (§7а).
        if track != "half_baked":
            abstain, reason = self.should_abstain(proposals)
            if abstain:
                abstain, reason = self._extra_round(run_id, capsule, proposals, roles, module, reason,
                                                    started, deadline)
            if abstain:
                abstain_reason = reason
                questions = sorted({q for p in proposals
                                    for q in (p.payload.get("open_questions") or [])}
                                   | {o for p in proposals for o in p.objections})
                self.log(f"    ⊘ воздержание: {reason}")

        if not abstain_reason:
            # Для профиля deep используем турнир (цикличный адверсариальный отбор)
            if self.cfg.get("council.enable_tournament", False) and profile == "deep":
                self.log("    ▶ запуск турнира (deep-профиль)")

                tournament = tournament_mod.TournamentEngine(self.cfg, self.store, self)
                tournament_result = tournament.run(
                    run_id, capsule, proposals, roles, deadline=deadline,
                )

                if tournament_result.status == "done":
                    # Турнир прошёл успешно — используем 3 финальных решения как merged
                    # Берем первые 3 из final_proposals (если меньше — используем все)
                    final = tournament_result.final_proposals[:3] if tournament_result.final_proposals else []
                    if final:
                        # Объединяем все финальные решения в один merged
                        merged = {}
                        for f in final:
                            if isinstance(f, dict):
                                merged = {**merged, **f}
                        self.log(f"    ✓ турнир завершён: {len(final)} финальных решений")
                    else:
                        abstain_reason = "турнир не дал финальных решений"
                elif tournament_result.status == "abstained":
                    abstain_reason = tournament_result.explanation or "турнир не дал решений"
                else:  # failed
                    abstain_reason = "турнир не прошёл (ошибка)"
                    # Fallback на обычный arbitrate
                    self.log("    ! турнир не прошёл — fallback на arbitrate")

            if not merged:
                infra_before = len(self._infra)      # сбой до арбитра (например, у одного proposer) — не про арбитра
                merged = self.arbitrate(run_id, capsule, proposals, roles, deadline=deadline)
                if merged is None:           # M5: повтор с компактным пакетом
                    merged = self.arbitrate_compact(run_id, capsule, proposals, roles, deadline)
                if merged is None and len(self._infra) > infra_before:
                    return Outcome("deferred", self.infra_reason("арбитр не ответил"), proposals=proposals)
                if merged is None:           # M5: лучшее предложение, прошедшее ворота, без слияния
                    merged = self.unmerged_best(proposals)
                if merged is None:
                    abstain_reason = "арбитр не дал валидного ответа"
                elif merged.get("abstain"):
                    abstain_reason = "арбитр воздержался: постановка не готова"
                    questions = [q for q in (merged.get("open_questions") or []) if str(q).strip()]
                    merged = None
                    self.log("    ⊘ арбитр воздержался")

        # Тупик — единственный законный повод потратить облачный вызов на этой стадии.
        if abstain_reason:
            escalate, why = self.should_escalate_cloud(card, profile, track, None, abstain_reason)
            if escalate:
                self.log(f"    ☁ эскалация в облако: {why}")
                cloud_merged, cloud_model = self.cloud_arbitrate(run_id, capsule, proposals, why)
                if cloud_merged is not None and not cloud_merged.get("abstain"):
                    merged = cloud_merged
                    cloud_note = {"model": cloud_model, "reason": why, "resolved_deadlock": True}
                    abstain_reason = ""
                    self.log(f"    ☁ облачный арбитр разрешил тупик ({cloud_model})")
                elif cloud_merged is not None:
                    questions = [q for q in (cloud_merged.get("open_questions") or [])
                                 if str(q).strip()] or questions
                    abstain_reason += f" (облачный арбитр {cloud_model} тоже воздержался)"

        if merged is None:
            return Outcome("abstained", abstain_reason, open_questions=list(questions)[:8],
                           proposals=proposals)

        # R5: адверсариальная спираль — только над ЛОКАЛЬНЫМ слиянием. Облачный результат
        # получен в обход бюджета (`max_calls_per_run`), дожимать его спиралью — значит
        # платить за то, что облако уже сделало; устойчивые дефекты облаку и останутся.
        spiral_note: dict = {}
        if self._merge_mode == "none":       # M5: ревизор спирали — тот же арбитр, что не ответил дважды
            spiral_note = {"stop_reason": "без слияния — спираль пропущена"}
        elif not cloud_note:
            merged, spiral_note = self.adversarial_spiral(run_id, capsule, merged, roles,
                                                          deadline=deadline)

        merged, removed, final_verification, readiness, confidence = self._finalize(
            merged, proposals)
        if self._merge_mode == "none":
            confidence = min(confidence, UNMERGED_CONFIDENCE)

        # Второй повод: результат есть, но он слабый по критичной карточке.
        if not cloud_note:
            escalate, why = self.should_escalate_cloud(
                card, profile, track,
                {"confidence": confidence, "touched": merged.get("touched") or {}}, "")
            if escalate:
                self.log(f"    ☁ эскалация в облако: {why}")
                cloud_merged, cloud_model = self.cloud_arbitrate(run_id, capsule, proposals, why)
                if cloud_merged is not None and not cloud_merged.get("abstain"):
                    alt = self._finalize(cloud_merged, proposals)
                    # Берём облачный вариант, только если он ОБЪЕКТИВНО подтверждённее:
                    # «звучит увереннее» решением не является — сравниваем долю
                    # подтверждённых верификатором привязок, уверенность вторична.
                    better = (alt[3], alt[4]) > (readiness, confidence)
                    cloud_note = {"model": cloud_model, "reason": why, "accepted": better,
                                  "local": {"readiness": readiness, "confidence": confidence},
                                  "cloud": {"readiness": alt[3], "confidence": alt[4]}}
                    if better:
                        merged, removed, final_verification, readiness, confidence = alt
                        self.log(f"    ☁ принят облачный вариант ({cloud_model}): "
                                 f"readiness {readiness}, confidence {confidence}")
                    else:
                        self.log(f"    ☁ облачный вариант отклонён — не подтверждённее "
                                 f"локального ({alt[3]}/{alt[4]} против {readiness}/{confidence})")

        payload = {
            "card_id": card["card_id"],
            "db": card["db"],
            "card_hash": card.get("content_hash") or "",
            "track": track,
            "profile": profile,
            "normalized_title": card.get("title") or "",
            "statement": {"goal": merged.get("goal") or "",
                          "non_goals": merged.get("non_goals") or []},
            "decomposition": merged.get("decomposition") or [],
            "touched": merged.get("touched") or {},
            "risks": merged.get("risks") or [],
            "acceptance": merged.get("acceptance") or [],
            "verification_cmd": merged.get("verification_cmd") or "",
            "open_questions": merged.get("open_questions") or [],
            "readiness": readiness,
            "confidence": confidence,
            "removed_by_verifier": removed,
            "provenance": {
                "run_id": run_id,
                "models": sorted({p.model for p in proposals}),
                "roles": {p.id: p.role for p in proposals},
                "scores": {p.id: p.total_score for p in proposals},
                # M2/M3: какие предложения переписаны в дополнительном раунде («сверка» — после показа чужих ответов),
                # и вид раунда на уровне прогона — срез вердиктов reject/edit по «сверка/дожим/нет».
                "extra_round": {p.id: p.extra_round for p in proposals if p.extra_round},
                "extra_round_kind": self._extra_kind,
                # M6: роли, чей ответ остался на чужом языке после повтора.
                "language_retry_failed": sorted(set(self._lang_failed)),
                # M5: "" — слияние по полному пакету, "compact" — арбитр ответил на повтор, "none" — без слияния.
                "merge": self._merge_mode,
                "verifier": final_verification.as_dict(),
                # Пусто = карточка проработана целиком локально. Непусто — видно, за что
                # именно заплачено и приняли ли облачный ответ.
                "cloud": cloud_note,
                # R5: путь слияния через спираль — сколько раундов, сошлось ли, что
                # осталось несошедшимся. Пустой rounds = спираль выключена/пропущена.
                "adversarial": spiral_note,
                "prompt_shas": {name: sha16(load_prompt(name))
                                for name in ("proposer.code", "proposer.arch",
                                             "proposer.skeptic", "critic", "arbiter",
                                             "adversary", "cloud_judge")},
            },
        }
        self.log(f"    ✓ слияние: readiness={readiness}, confidence={confidence}, "
                 f"{len(payload['decomposition'])} пунктов")
        return Outcome("done", "", payload, confidence, readiness, proposals,
                       payload["open_questions"])


def _clamp(value, low: int = 0, high: int = 3) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return 0


def _majority_by_files(candidates: list[dict]) -> dict:
    """Self-consistency для reasoning-модели: берём тот сэмпл, чей набор файлов ближе
    к остальным. Дёшево и заметно снижает разброс без второй модели."""
    sets = [norm_files(c) for c in candidates]
    best_index, best_score = 0, -1.0
    for i, current in enumerate(sets):
        score = sum(jaccard(current, other) for j, other in enumerate(sets) if i != j)
        if score > best_score:
            best_index, best_score = i, score
    return candidates[best_index]
