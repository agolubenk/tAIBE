#!/usr/bin/env python3
"""AI Council — загрузка и валидация конфига. Только stdlib (`tomllib`, Python 3.11+).

Канон значений: config.toml + docs/specs/ai-council.md §11.

Валидация не косметическая: часть инвариантов подсистемы (потолок 24 GB, нет записи наружу,
источник карточек — t-boards) выражается именно тут. Плохой конфиг должен падать
на старте с внятным текстом, а не проявляться галлюцинацией в проработанной карточке.
"""
from __future__ import annotations

import os
import sys
import tomllib
from pathlib import Path
from typing import Any

_SCRIPTS = Path(__file__).resolve().parents[2] / ".claude" / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.append(str(_SCRIPTS))

from host_root import HostRootError, LAYER_ROOT, host_root  # noqa: E402,F401

# Единственный корень данных консилиума: council.db, логи, ключи, корпус знаний, код хоста для
# поиска и сверки. Остальные модули берут его отсюда. Код слоя (config.toml, schema.sql, промпты)
# читается от своего пути: CONFIG_PATH и HERE в модулях. TAIBE_HOST_ROOT без council.db — ошибка.
COUNCIL_DB_REL = ".claude/council/council.db"
REPO_ROOT = host_root(require=COUNCIL_DB_REL)
CONFIG_PATH = Path(__file__).resolve().parent / "config.toml"

# Словарь модулей карточки (метки t-boards ∩ словарь → cards.modules) — ключи `council.modules` продукта
# (instances/<slug>.json, Ф2 OPS-23): product.current().modules.

VALID_PROFILES = {"adaptive", "fast", "deep"}

# Провайдеры, для которых в cloud.py есть реализация транспорта. Список закрытый:
# «просто добавь base_url» не работает — у Gemini другой протокол, не OpenAI-совместимый.
# gateway — ИИ-шлюз продукта (OpenAI-совместимый, модели executive.*): маршруты внутренней компании ведут на
# OpenRouter :free (решение владельца d-council-openrouter = fallback-free, 23.10).
# local_gateway — локальный llm-gateway :8789 (OpenAI-совместимый; «модели» free/auto — пулы
# бесплатного OpenRouter с авторотацией на личном ключе, гибрид-арбитр с 2026-10-28).
CLOUD_PROVIDERS = {"zai", "gemini", "gateway", "local_gateway"}


class ConfigError(Exception):
    pass


class Config:
    def __init__(self, data: dict, path: Path):
        self.data = data
        self.path = path

    # ── доступ ───────────────────────────────────────────────────────────────
    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def require(self, dotted: str) -> Any:
        value = self.get(dotted, None)
        if value is None:
            raise ConfigError(f"{self.path.name}: отсутствует обязательный ключ `{dotted}`")
        return value

    def path_of(self, dotted: str, default: str = "") -> Path:
        """Пути в конфиге — относительно корня репозитория, не CWD процесса."""
        raw = self.get(dotted, default)
        if not raw:
            return Path()
        p = Path(raw)
        return p if p.is_absolute() else REPO_ROOT / p

    # ── профили моделей ──────────────────────────────────────────────────────
    def roles(self, profile: str) -> dict:
        roles = self.get(f"models.roles.{profile}")
        if not roles:
            raise ConfigError(f"{self.path.name}: нет ростера ролей для профиля `{profile}`")
        return roles

    def large_models(self) -> dict:
        return self.get("models.large", {}) or {}

    def is_large(self, model: str) -> bool:
        return model in self.large_models()

    # ── облачный ярус ────────────────────────────────────────────────────────
    def cloud_enabled(self) -> bool:
        """Конфиг + env-переключатель на один прогон (AI_COUNCIL_CLOUD=1|0)."""
        flag = os.environ.get("AI_COUNCIL_CLOUD", "").strip().lower()
        if flag in {"1", "true", "on"}:
            return True
        if flag in {"0", "false", "off"}:
            return False
        return bool(self.get("models.cloud.enabled", False))

    def cloud_role(self, role: str) -> str:
        return str(self.get(f"models.cloud.roles.{role}", "") or "")

    def config_hash(self) -> str:
        from store import sha16
        return sha16(repr(sorted(_flatten(self.data).items())))


def _flatten(node: Any, prefix: str = "") -> dict:
    out: dict = {}
    if isinstance(node, dict):
        for k, v in node.items():
            out.update(_flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.update(_flatten(v, f"{prefix}[{i}]"))
    else:
        out[prefix] = node
    return out


FALLBACK_TRIGGERS = {"quota", "no_balance", "overloaded"}


def _validate_cloud_fallback(provider: str, spec: dict, models: list) -> list[str]:
    """Второй биллинговый контур провайдера (у Z.AI — General API рядом с подпиской).
    Проверяется даже выключенным: включать платный маршрут в момент, когда основной уже
    упёрся в квоту, — худший момент узнать, что в нём опечатка."""
    if not spec:
        return []
    base = f"models.cloud.providers.{provider}.fallback"
    problems: list[str] = []
    if not str(spec.get("base_url") or "").startswith("https://"):
        problems.append(f"{base}.base_url должен быть https")
    if not str(spec.get("key_env") or "").strip():
        problems.append(f"{base}.key_env не задан — откуда брать второй ключ, неизвестно")
    cap = spec.get("max_calls_per_day")
    if not isinstance(cap, int) or cap < 0:
        problems.append(f"{base}.max_calls_per_day должен быть целым ≥ 0 "
                        "(0 = второй контур не используется)")
    # Деньги — второй, независимый потолок платного маршрута. Подписка тарифицируется
    # вызовами, General API — токенами: десять раздутых обращений стоят непредсказуемо
    # дороже десяти обычных, поэтому одного лимита по вызовам недостаточно.
    money = spec.get("max_usd_per_day")
    if not isinstance(money, (int, float)) or isinstance(money, bool) or money < 0:
        problems.append(f"{base}.max_usd_per_day должен быть числом ≥ 0 "
                        "(0 = второй контур не используется)")
    elif isinstance(cap, int) and cap > 0 and money == 0:
        problems.append(
            f"{base}: max_calls_per_day={cap}, но max_usd_per_day=0 — маршрут платный, "
            "и без денежного потолка его держал бы только счётчик вызовов")
    # Прайс контура. Общий models.cloud.pricing здесь не годится: там те же модели стоят 0,
    # как покрытые подпиской, и платный вызов записался бы в журнал бесплатным.
    pricing = spec.get("pricing") or {}
    if isinstance(cap, int) and cap > 0:
        missing = [m for m in models if not (pricing.get(m) or {})]
        if missing:
            problems.append(
                f"{base}.pricing: нет прайса на {missing} — цена вызова неизвестна, "
                "денежный потолок по этим моделям ничего не держит (cloud.py уводит их "
                "с платного маршрута, то есть второй контур для них не работает)")
    for model, entry in pricing.items():
        for field_name in ("in_per_mtok", "out_per_mtok"):
            value = (entry or {}).get(field_name)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                problems.append(f'{base}.pricing."{model}".{field_name} должен быть '
                                "положительным числом (цена за 1M токенов)")
    unknown = sorted(set(spec.get("when") or []) - FALLBACK_TRIGGERS)
    if unknown:
        problems.append(
            f"{base}.when: {unknown} — неизвестные классы отказа, допустимы "
            f"{sorted(FALLBACK_TRIGGERS)} (классификация — classify_429 в cloud.py)")
    return problems


def _validate_cloud(cfg: Config) -> list[str]:
    """Облачный ярус (§4а). Валидируется всегда, даже когда выключен: конфиг с дырой
    не должен «оживать» в момент, когда его включат на реальной карточке."""
    problems: list[str] = []
    node = cfg.get("models.cloud")
    if not node:
        return problems

    declared: set[str] = set()
    providers = node.get("providers") or {}
    if not providers:
        problems.append("models.cloud.providers пуст — включать облако нечем")
    for name, spec in providers.items():
        if name not in CLOUD_PROVIDERS:
            problems.append(
                f"models.cloud.providers.{name}: неизвестный провайдер, поддерживаются "
                f"{sorted(CLOUD_PROVIDERS)} (реализация — infra/ai-council/cloud.py)"
            )
            continue
        base = str(spec.get("base_url") or "")
        # http разрешён только loopback-адресам (локальный llm-gateway :8789): всё внешнее — https.
        loopback = base.startswith(("http://127.0.0.1", "http://localhost", "http://[::1]"))
        if not base.startswith("https://") and not loopback:
            problems.append(f"models.cloud.providers.{name}.base_url должен быть https")
        # Ключ живёт на подписке Coding Plan; на General API у него нет пакета и любой
        # запрос вернёт 429 «Insufficient balance». Проверено живыми вызовами 2026-08-13.
        if name == "zai" and "/api/coding/" not in base:
            problems.append(
                f"models.cloud.providers.zai.base_url=`{base}` — это General API "
                "(pay-as-you-go), у ключа там нет пакета: 429 Insufficient balance на всех "
                "моделях. Нужен endpoint подписки https://api.z.ai/api/coding/paas/v4"
            )
        models = spec.get("models") or []
        if not models:
            problems.append(f"models.cloud.providers.{name}.models пуст")
        declared |= set(models)
        problems += _validate_cloud_fallback(name, spec.get("fallback") or {}, list(models))

    roles = node.get("roles") or {}
    ladder = roles.get("ladder") or []
    for role, model in roles.items():
        if role == "ladder":
            for step in ladder:
                if step not in declared:
                    problems.append(
                        f"models.cloud.roles.ladder: ступень `{step}` не объявлена ни в "
                        "одном models.cloud.providers.*.models"
                    )
            continue
        if model not in declared:
            problems.append(
                f"models.cloud.roles.{role}=`{model}` не объявлена ни в одном "
                "models.cloud.providers.*.models"
            )
    # Стартовая ступень обязана быть НА лестнице, иначе обход начнётся не с той модели
    # и «дешёвый шаг сначала» тихо перестанет работать.
    if ladder and roles.get("judge") and roles["judge"] not in ladder:
        problems.append(
            f"models.cloud.roles.judge=`{roles['judge']}` отсутствует в ladder {ladder} — "
            "обход лестницы начнётся с первой ступени, а не с заявленной"
        )

    budget = node.get("budget") or {}
    if not budget:
        problems.append("models.cloud.budget отсутствует — облако без потолка не включается")
    for key in ("max_calls_per_run", "max_calls_per_day", "max_tokens_per_day",
                "max_tokens_out", "window_hours", "max_calls_per_window"):
        value = budget.get(key)
        if not isinstance(value, int) or value < 0:
            problems.append(f"models.cloud.budget.{key} должен быть целым ≥ 0")
    # Окно — главный стоп на подписке. Если суточный лимит меньше оконного, окно
    # никогда не сработает и настройка вводит в заблуждение.
    if isinstance(budget.get("max_calls_per_day"), int) \
            and isinstance(budget.get("max_calls_per_window"), int) \
            and budget["max_calls_per_day"] < budget["max_calls_per_window"]:
        problems.append(
            f"models.cloud.budget: суточный лимит ({budget['max_calls_per_day']}) меньше "
            f"оконного ({budget['max_calls_per_window']}) — окно никогда не сработает"
        )
    usd = budget.get("max_usd_per_day")
    if not isinstance(usd, (int, float)) or usd < 0:
        problems.append("models.cloud.budget.max_usd_per_day должен быть числом ≥ 0")

    # Облачная модель в локальном ростере = платный вызов на каждой из 125 карточек. Только триаж:
    # deep с 2026-10-23 облачный (локальных L-моделей нет), и в него поднимаются лишь critical/P0.
    for prof in ("fast",):
        for role, model in (cfg.get(f"models.roles.{prof}") or {}).items():
            if model in declared:
                problems.append(
                    f"models.roles.{prof}.{role}=`{model}` — облачная модель в локальном "
                    "ростере: она будет вызвана на КАЖДОЙ карточке. Облако подключается "
                    "только через models.cloud.escalate_when"
                )

    esc = node.get("escalate_when") or {}
    profile = esc.get("require_profile", "deep")
    if profile not in VALID_PROFILES:
        problems.append(
            f"models.cloud.escalate_when.require_profile=`{profile}` — допустимо: "
            f"{sorted(VALID_PROFILES)}"
        )
    confidence = esc.get("confidence_lt", 0.45)
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        problems.append("models.cloud.escalate_when.confidence_lt должен быть в 0..1")

    return problems


def _validate_escalation(cfg: Config) -> list[str]:
    """Облачная эскалация (§17.4): провайдеры объявлены, модели карты — у своего провайдера.
    Опечатка в модели иначе всплыла бы через два часа ожидания, отказом посреди прогона."""
    node = cfg.get("models.cloud_escalation", {}) or {}
    if not node or not node.get("enabled"):
        return []
    problems: list[str] = []
    declared = {name: set(spec.get("models") or [])
                for name, spec in (cfg.get("models.cloud.providers", {}) or {}).items()}
    for provider in node.get("providers") or []:
        if provider not in declared:
            problems.append(f"models.cloud_escalation.providers: `{provider}` не объявлен в "
                            f"models.cloud.providers")
    for provider, mapping in (node.get("models") or {}).items():
        if provider not in declared:
            problems.append(f"models.cloud_escalation.models.{provider}: неизвестный провайдер")
            continue
        for slot, model in (mapping or {}).items():
            if model not in declared[provider]:
                problems.append(f"models.cloud_escalation.models.{provider}.{slot}=`{model}` — "
                                f"нет в models.cloud.providers.{provider}.models")
    for key in ("after_seconds", "quota_margin_seconds", "overload_retry_seconds"):
        value = node.get(key)
        if value is not None and (not isinstance(value, int) or value < 0):
            problems.append(f"models.cloud_escalation.{key}: целое число секунд ≥ 0")
    return problems


GLM5_MODEL_PREFIX = "glm-5"      # 5-е поколение: glm-5, glm-5.2, glm-5-turbo, glm-5.3-flash…
GLM_ALL_LIMITS = ("window_hours", "max_calls_per_window", "max_calls_per_day",
                  "max_calls_per_run", "max_tokens_per_day")


def _is_glm5(model: str) -> bool:
    return model == GLM5_MODEL_PREFIX or model.startswith((GLM5_MODEL_PREFIX + ".",
                                                           GLM5_MODEL_PREFIX + "-"))


def _validate_glm(cfg: Config) -> list[str]:
    """Режим «всё на GLM 5.x» (§17.6). Валидируется, даже пока тумблер выключен: он
    переключается в рантайме без рестарта, и опечатка в карте всплыла бы отказом посреди
    прогона, где облачная — КАЖДАЯ роль."""
    node = cfg.get("models.glm_all", {}) or {}
    if not node:
        return []
    problems: list[str] = []
    zai = set(cfg.get("models.cloud.providers.zai.models", []) or [])
    models = node.get("models") or {}
    if not models.get("default"):
        problems.append("models.glm_all.models.default не задан — агентам ревью и прочим "
                        "ролям без своей строки некуда уйти")
    for role, model in models.items():
        if role == "embed":
            problems.append("models.glm_all.models.embed: эмбеддинги остаются локальными — у "
                            "Coding API их нет, а вектор другой модели несовместим с корпусом")
            continue
        if not _is_glm5(str(model)):
            problems.append(f"models.glm_all.models.{role}=`{model}` — не модель 5-го поколения "
                            f"(ожидается {GLM5_MODEL_PREFIX}, {GLM5_MODEL_PREFIX}.x, …)")
        elif model not in zai:
            problems.append(f"models.glm_all.models.{role}=`{model}` нет в "
                            f"models.cloud.providers.zai.models — режим идёт только в подписку "
                            "Coding Plan")
    proposers = [str(m) for r, m in models.items() if str(r).startswith("proposer.")]
    if len(proposers) != len(set(proposers)):
        problems.append(f"models.glm_all.models: одна модель на нескольких ролях proposer.* "
                        f"({proposers}) — независимых мнений это не даёт")
    for key in GLM_ALL_LIMITS:
        value = node.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            problems.append(f"models.glm_all.{key} должен быть целым ≥ 1")
    day, window = node.get("max_calls_per_day"), node.get("max_calls_per_window")
    if isinstance(day, int) and isinstance(window, int) and day < window:
        problems.append(f"models.glm_all: суточный лимит ({day}) меньше оконного ({window}) — "
                        "окно никогда не сработает")
    # Прогон режима начинается, только если окно вмещает его потолок (glm_mode.preflight):
    # потолок больше окна — каждый прогон ждал бы полностью пустого окна.
    run = node.get("max_calls_per_run")
    if isinstance(run, int) and isinstance(window, int) and run > window:
        problems.append(f"models.glm_all: потолок прогона ({run}) больше окна ({window}) — прогон "
                        "режима ждал бы пустого окна")
    return problems


def _validate_tboards(cfg: Config) -> list[str]:
    """Источник карточек t-boards (tboards.py). Записи наружу у консилиума нет: секции Notion удалены (R-084, OPS-26),
    а их появление в конфиге — ошибка, а не молчаливо игнорируемая настройка."""
    problems: list[str] = []
    for gone in ("sources.notion", "outputs.notion_writeback"):
        if cfg.get(gone) is not None:
            problems.append(f"{gone}: Notion заморожен (R-084), источник карточек — t-boards ([sources.tboards])")
    for key in ("review_slugs", "final_slugs"):
        value = cfg.get(f"sources.tboards.{key}", [])
        if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
            problems.append(f"sources.tboards.{key} — список slug колонок t-boards")
    budget = cfg.get("sources.tboards.call_budget", 40)
    if not isinstance(budget, int) or isinstance(budget, bool) or not 1 <= budget <= 95:
        problems.append("sources.tboards.call_budget — целое 1..95 (лимит ключа t-boards — 100 запросов)")
    weight = cfg.get("sources.tboards.bug_weight", 2.0)
    if not isinstance(weight, (int, float)) or isinstance(weight, bool) or weight <= 0:
        problems.append("sources.tboards.bug_weight — число > 0")
    return problems


def _validate(cfg: Config) -> list[str]:
    """Возвращает список проблем. Пустой список = конфиг пригоден."""
    problems: list[str] = []

    profile = cfg.get("models.profile", "adaptive")
    if profile not in VALID_PROFILES:
        problems.append(f"models.profile=`{profile}` — допустимо: {sorted(VALID_PROFILES)}")

    # C1: потолок памяти. >1 резидентной L-модели на 24 GB — гарантированный своп/OOM.
    resident = cfg.get("models.max_resident_large", 1)
    if not isinstance(resident, int) or resident < 1:
        problems.append("models.max_resident_large должен быть целым ≥ 1")
    elif resident > 1:
        largest = sorted(cfg.large_models().values(), reverse=True)[:resident]
        problems.append(
            f"models.max_resident_large={resident}: {resident} тяжёлых модели — это "
            f"~{sum(largest):.1f} GB одновременно. Машина 24 GB (см. спеку C1). "
            "Поднимать только если железо сменилось."
        )

    for prof in ("fast", "deep"):
        roles = cfg.get(f"models.roles.{prof}")
        if not roles:
            problems.append(f"models.roles.{prof} отсутствует")
            continue
        # skeptic обязателен только в тяжёлом проходе: в триаже допустимо два предлагающих,
        # если третьей НЕЗАВИСИМОЙ S-модели на машине нет. Две роли на одной модели —
        # хуже, чем две роли: это фальшивый консилиум, который согласен сам с собой.
        required_roles = ["proposer.code", "proposer.arch", "arbiter", "extractor", "embed"]
        if prof == "deep":
            required_roles.append("proposer.skeptic")
        for required in required_roles:
            if required not in roles:
                problems.append(f"models.roles.{prof}: нет роли `{required}`")
        proposers = [roles[r] for r in roles if r.startswith("proposer.")]
        if len(proposers) != len(set(proposers)):
            problems.append(
                f"models.roles.{prof}: одна модель на нескольких ролях proposer.* "
                f"({proposers}) — независимых мнений это не даёт"
            )
        if prof == "fast":
            heavy = [m for m in roles.values() if cfg.is_large(m)]
            if heavy:
                problems.append(
                    f"models.roles.fast содержит тяжёлые модели {heavy} — профиль fast "
                    "должен целиком помещаться в память вместе с S-тиром"
                )

    problems += _validate_cloud(cfg)
    problems += _validate_escalation(cfg)
    problems += _validate_glm(cfg)
    # Источники знаний (виды, потолки, запреты приватности) — проверки живут рядом с кодом.
    from knowledge_sources import validate as _validate_knowledge
    problems += _validate_knowledge(cfg)

    problems += _validate_tboards(cfg)

    ratio = cfg.get("planner.window.focus_ratio", 0.7)
    if not isinstance(ratio, (int, float)) or not 0 < ratio <= 1:
        problems.append("planner.window.focus_ratio должен быть в диапазоне (0, 1]")

    for bucket in ("S", "M", "L", "XL"):
        if not cfg.get(f"planner.effort_minutes.{bucket}"):
            problems.append(f"planner.effort_minutes.{bucket} не задан")

    plan_file = cfg.get("outputs.plan_file", "")
    if not plan_file:
        problems.append("outputs.plan_file не задан")
    elif not cfg.get("outputs.plan_marker"):
        problems.append("outputs.plan_marker не задан — без маркера план некуда писать безопасно")

    threshold = cfg.get("council.abstain_threshold", 9)
    if not isinstance(threshold, (int, float)) or not 0 <= threshold <= 15:
        problems.append("council.abstain_threshold должен быть в диапазоне 0..15")

    enable_tournament = cfg.get("council.enable_tournament", False)
    if not isinstance(enable_tournament, bool):
        problems.append("council.enable_tournament должен быть boolean")

    return problems


def load(path: Path | str = CONFIG_PATH, strict: bool = True) -> Config:
    p = Path(path)
    try:
        with p.open("rb") as fh:
            data = tomllib.load(fh)
    except OSError as exc:
        raise ConfigError(f"не удалось прочитать {p}: {exc}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{p.name}: синтаксическая ошибка TOML — {exc}") from exc

    cfg = Config(data, p)
    problems = _validate(cfg)
    if problems and strict:
        raise ConfigError(
            f"{p.name}: конфиг непригоден\n" + "\n".join(f"  • {m}" for m in problems)
        )
    cfg.problems = problems  # type: ignore[attr-defined]
    return cfg


if __name__ == "__main__":
    # Диагностика: python3 infra/ai-council/config.py
    import sys

    try:
        cfg = load(strict=False)
    except ConfigError as exc:
        print("❌", exc)
        sys.exit(1)

    problems = getattr(cfg, "problems", [])
    print(f"конфиг:   {cfg.path}")
    print(f"hash:     {cfg.config_hash()}")
    print(f"профиль:  {cfg.get('models.profile')}")
    print("карточки: t-boards по запросу (ключ продукта — python3 infra/ai-council/tboards.py status)")
    if cfg.cloud_enabled():
        budget = cfg.get("models.cloud.budget", {}) or {}
        print(f"облако:   ВКЛЮЧЕНО — judge={cfg.cloud_role('judge')}, "
              f"потолок ${budget.get('max_usd_per_day')}/сут, "
              f"{budget.get('max_calls_per_day')} вызовов/сут "
              f"(детали: npm run ai-council:cloud)")
    else:
        print("облако:   выключено (models.cloud.enabled=false)")
    print(f"план:     {cfg.get('outputs.plan_file')} "
          f"[{cfg.get('outputs.plan_marker')}]")
    print("запись:   наружу — нет (итог в базе консилиума)")
    if problems:
        print("\nпроблемы:")
        for m in problems:
            print(f"  • {m}")
        sys.exit(1)
    print("\n✓ валиден")
