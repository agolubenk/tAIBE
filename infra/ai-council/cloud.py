#!/usr/bin/env python3
"""AI Council — облачный ярус: Z.AI (GLM) и Gemini. Только stdlib.

Канон: docs/specs/ai-council.md §4а.

Это не «ещё один провайдер рядом с Ollama», а **бюджетный шлюз**. Локальный контур
бесплатен и его можно гонять сколько угодно; облако — платное, поэтому каждый вызов
здесь проходит через жёсткие лимиты (вызовы за прогон / за сутки, токены за сутки,
деньги за сутки). При исчерпании любого лимита `chat()` возвращает `Completion(ok=False)`,
а не бросает: консилиум обязан доработать на локальных моделях, а не упасть.

Три независимых стопа, потому что каждый ловит свой класс аварии:
  • по вызовам  — защита от цикла «модель не дала JSON → retry → retry → …»;
  • по токенам  — защита от одной карточки с гигантской капсулой;
  • по деньгам  — верхняя граница, но она зависит от прайса, а прайс меняется.
Прайс живёт в конфиге (`[models.cloud.pricing]`) и по умолчанию занижен-не-выставлен,
поэтому лимиты по вызовам и токенам работают даже когда цифры цены устарели.

Право писать в файлы/Notion облаку не выдаётся нигде и никогда — оно возвращает текст.
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from config import REPO_ROOT  # noqa: E402 — ключи и .continue/.env лежат у хоста

from netutil import SSL_CTX   # noqa: E402  — python.org на macOS не видит системные CA
from ollama import Completion  # noqa: E402  — один тип результата на оба яруса

DOWN_TTL = 300           # сек: после сетевого сбоя не долбим провайдера на каждом вызове
MAX_RETRIES_429 = 3      # экспоненциальный backoff + jitter (лимиты у обоих провайдеров — RPM)

# Где искать ключи: env → файл ключа → .continue/.env (там же их читает Continue).
KEY_SOURCES = {
    "zai": ("ZAI_API_KEY", ".claude/council/.zai-key"),
    "gemini": ("GEMINI_API_KEY", ".claude/council/.gemini-key"),
    # ИИ-шлюз продукта (ИИ-совет → Интеграции и доступ): ключ hrhx_… выпускает админка, хранится только хэш.
    "gateway": ("HRH_GATEWAY_KEY", ".claude/council/.gateway-key"),
    # Локальный llm-gateway (:8789, infra/llm-gateway) — пулы free/auto бесплатного OpenRouter
    # на личном ключе владельца (OPENROUTER_KEY_1 в infra/llm-gateway/.env). Консилиуму нужен
    # только клиентский токен шлюза (совпадает с Continue: .continue/.env LLM_GATEWAY_TOKEN).
    "local_gateway": ("LLM_GATEWAY_TOKEN", "infra/llm-gateway/.state/token"),
}
DOTENV_PATH = REPO_ROOT / ".continue/.env"


def read_key(provider: str) -> str:
    """env > файл ключа > .continue/.env. Пусто = провайдер выключен, не исключение."""
    env_name, key_file = KEY_SOURCES.get(provider, ("", ""))
    return read_key_from(env_name, key_file)


def read_key_from(env_name: str, key_file: str) -> str:
    """То же, но по явно названным источникам: у одного провайдера может быть два
    ключа (у Z.AI подписка Coding Plan и General API — это разные контуры биллинга
    с разными ключами, см. `providers.zai.fallback` в config.toml)."""
    if not env_name:
        return ""
    value = os.environ.get(env_name, "").strip()
    if value:
        return value
    try:
        value = (REPO_ROOT / key_file).read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    try:
        for line in DOTENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(f"{env_name}=") and not line.startswith("#"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


# ── бюджет ──────────────────────────────────────────────────────────────────
@dataclass
class Budget:
    """Лимиты. 0 или отрицательное значение = «стоп», а не «безлимит» — по умолчанию
    облако должно молчать, включается оно явно.

    Главный стоп — по ВЫЗОВАМ за скользящее окно: подписка Coding Plan тратится числом
    обращений, а не объёмом. Токены и деньги остаются предохранителями для аномалий и
    для pay-as-you-go провайдеров (Gemini)."""
    enabled: bool = False
    max_calls_per_run: int = 2
    # Профили, где облако не «разрешает тупик», а само ведёт консилиум (`models.roles.cloud`,
    # `models.roles.hybrid`): там 2 вызова на карточку — это остановка посреди раунда
    # предложений. Потолок на прогон задаётся отдельно на профиль; лимиты окна и суток
    # общие и НЕ переопределяются — иначе профиль становится дырой в бюджете подписки.
    max_calls_per_run_by_profile: dict = field(default_factory=dict)
    window_hours: int = 5
    max_calls_per_window: int = 30
    max_calls_per_day: int = 60
    max_tokens_per_day: int = 800_000
    max_usd_per_day: float = 1.0
    max_tokens_out: int = 4000     # включая reasoning-токены GLM: они идут в счёт output
    # Режим «всё на GLM 5.x» (glm_mode.apply_budget, §17.6): потолок на прогон поверх
    # профильного. В режиме облако — это ВЕСЬ консилиум (8-агентное ревью + оспаривание +
    # судья, или три предложения + рецензии + арбитр + спираль), и профильные 2/8 вызовов
    # обрывали бы его на середине. 0 = не действует, считается по профилю как обычно.
    run_cap: int = 0
    # Лимиты сейчас — режима GLM 5.x. Заодно закрывает платный контур General API: режим —
    # это «всё в подписку Coding Plan», доплата вторым кошельком в него не входит.
    glm_mode: bool = False

    @classmethod
    def from_cfg(cls, cfg) -> "Budget":
        node = cfg.get("models.cloud", {}) or {}
        limits = node.get("budget", {}) or {}
        # env-переключатель нужен, чтобы включить облако на один прогон, не правя конфиг
        env_flag = os.environ.get("AI_COUNCIL_CLOUD", "").strip().lower()
        enabled = bool(node.get("enabled", False))
        if env_flag in {"1", "true", "on"}:
            enabled = True
        elif env_flag in {"0", "false", "off"}:
            enabled = False
        return cls(
            enabled=enabled,
            max_calls_per_run=int(limits.get("max_calls_per_run", 2)),
            max_calls_per_run_by_profile={
                str(k): int(v)
                for k, v in (limits.get("max_calls_per_run_by_profile", {}) or {}).items()
            },
            window_hours=int(limits.get("window_hours", 5)),
            max_calls_per_window=int(limits.get("max_calls_per_window", 30)),
            max_calls_per_day=int(limits.get("max_calls_per_day", 60)),
            max_tokens_per_day=int(limits.get("max_tokens_per_day", 800_000)),
            max_usd_per_day=float(limits.get("max_usd_per_day", 1.0)),
            max_tokens_out=int(limits.get("max_tokens_out", 4000)),
        )


def classify_429(code: int, detail: str) -> str:
    """`429` от Z.AI значит три разные вещи, и лечатся они по-разному:

    * `no_balance` — запрос ушёл на General API, где у ключа нет пакета. Это ошибка
      конфигурации, а не лимита: повторять бессмысленно, надо чинить base_url.
    * `overloaded` — временная перегрузка модели: один-два повтора с backoff уместны.
    * `quota` — кончилось окно подписки: повторы только жгут время, нужно локально.
    """
    if code != 429:
        return ""
    low = detail.lower()
    if "insufficient balance" in low or "resource package" in low:
        return "no_balance"
    if "overload" in low or "try again later" in low:
        return "overloaded"
    # Z.AI: 1302 — слишком много одновременных запросов, 1303 — слишком часто, 1305 — модель
    # перегружена. Это не окно подписки: с параллельными полосами воркера (`--lane cloud`)
    # «квота» отложила бы прогоны до сброса окна, хотя через секунды запрос пройдёт.
    if any(f'"{code}"' in low for code in ("1302", "1303", "1305")) or "concurren" in low:
        return "overloaded"
    return "quota"


def _reset_hint(headers, raw: str) -> str:
    """Подсказка о сбросе лимита из ответа провайдера — компактно, для текста ошибки:
    Retry-After (секунды), retryDelay Gemini, «reset at …» Z.AI (1308/1310)."""
    value = ""
    try:
        value = str((headers or {}).get("Retry-After") or "").strip()
    except Exception:                                           # noqa: BLE001
        value = ""
    if value.isdigit():
        return f"retry_after={value}"
    m = re.search(r'"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"', raw or "")
    if m:
        return f"retry_after={m.group(1)}"
    m = re.search(r"reset at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})", raw or "", re.I)
    if m:
        return f"reset_at={m.group(1)}"
    return ""


# Отметка «квота подписки исчерпана» (Z.AI 1308 — 5-часовое окно, 1310 — недельное) — общая для всех
# процессов консилиума (council_state): воркер, облачные полосы, ревью и шлюз видят одно и то же время сброса.
QUOTA_STATE_PREFIX = "cloud_quota:"
QUOTA_UNKNOWN_RESET_SECONDS = 1800      # провайдер не назвал время сброса — повтор через полчаса
# Время сброса из ответа без зоны (эвристика cloud_escalation._reset_candidates): потолок — перепроверка одним вызовом
# каждые 6 ч (недельная 1310 сбрасывается через дни — это несколько отказных вызовов, не простой при ошибке разбора).
QUOTA_MAX_WAIT_SECONDS = 6 * 3600
QUOTA_RESUME_GRACE_SECONDS = 60         # прогон берётся не раньше сброса + запас: Z.AI открывает окно не секунда в секунду
QUOTA_ERROR_MARK = "исчерпана квота окна плана"   # хвост, который _post пишет к 429 вида quota (единственный источник)


class CloudQuotaWait(Exception):
    """Режим GLM 5.x: квота подписки исчерпана — прогон ждёт сброса на своём месте в очереди, а не идёт дальше
    без голосов (14.10.2026: 28 ревью подряд закончились NEEDS_HUMAN с нулевой уверенностью, 284 отказа 1308).
    Бросает `chat()` клиента с `raise_on_quota` (клиент воркера): любой путь прогона в облако прерывается одинаково.
    Остальные клиенты (шлюз, скрипты) по-прежнему получают Completion(ok=False)."""

    def __init__(self, until: float, why: str):
        self.until = float(until)
        self.why = why
        super().__init__(why)


def _when(ts: float) -> str:
    """Время сброса квоты для логов и причин: с датой — недельная 1310 сбрасывается через дни."""
    return time.strftime("%d.%m %H:%M", time.localtime(ts))


def day_start(ts: float | None = None) -> int:
    """Начало текущих локальных суток — окно, по которому считаются дневные лимиты."""
    lt = time.localtime(ts or time.time())
    return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))


def estimate_usd(pricing: dict, model: str, tokens_in: int, tokens_out: int) -> float:
    """Цена за 1M токенов из конфига. Нет модели в прайсе → 0.0 и лимит по деньгам
    для неё не срабатывает; лимиты по вызовам и токенам продолжают работать."""
    entry = (pricing or {}).get(model) or {}
    price_in = float(entry.get("in_per_mtok", 0.0))
    price_out = float(entry.get("out_per_mtok", 0.0))
    return round(tokens_in / 1e6 * price_in + tokens_out / 1e6 * price_out, 6)


# ── клиент ──────────────────────────────────────────────────────────────────
@dataclass
class CloudClient:
    providers: dict = field(default_factory=dict)   # {"zai": {...}, "gemini": {...}}
    pricing: dict = field(default_factory=dict)
    rate_limits: dict = field(default_factory=dict)  # {"gemini": {"max_calls_per_2min": 4, …}}
    budget: Budget = field(default_factory=Budget)
    store: object | None = None
    request_timeout: int = 180
    logger: object = None
    # Профиль текущего прогона. Влияет ТОЛЬКО на потолок вызовов внутри прогона:
    # в `cloud`/`hybrid` облако ведёт консилиум, а не спасает его, и двух вызовов там
    # не хватает даже на раунд предложений. Окно и сутки от профиля не зависят.
    profile: str = ""
    # {"enabled": bool, "url": str, "providers": [str]} — прокси оптимизации контекста.
    headroom: dict = field(default_factory=dict)
    # Воркер прогонов: в режиме GLM 5.x исчерпанная квота подписки — исключение CloudQuotaWait из chat(), а не
    # Completion(ok=False): прогон возвращается на место до сброса, ни один путь не идёт дальше без голоса.
    raise_on_quota: bool = False
    # Повторы `_post` на 5xx и перегрузку (1302/1303/1305). Воркеру — умолчание; разовый скрипт (ревью PR) ставит 1:
    # Z.AI рвёт длинную генерацию 502 через ~300 с, и четыре попытки — это 20 мин на один вызов (14–15.10).
    max_retries: int = MAX_RETRIES_429
    _calls_this_run: dict = field(default_factory=dict)
    _down_until: dict = field(default_factory=dict)
    # Каким контуром биллинга ушёл последний вызов: пусто = основным. Нужен, чтобы в
    # журнале платный General API не смешивался с подпиской — иначе «сколько осталось
    # по подписке» и «сколько потрачено денег» считаются по одной и той же строке.
    _contour_of_last_call: str = ""
    _headroom_ok: bool = False
    _headroom_checked_until: float = 0.0

    def log(self, msg: str) -> None:
        if callable(self.logger):
            self.logger(msg)

    # ── квота подписки (общая отметка процессов) ─────────────────────────────
    def quota_until(self, provider: str) -> float:
        """До какого времени квота подписки провайдера исчерпана; 0 — не исчерпана или отметки нет."""
        if self.store is None or not provider:
            return 0.0
        import queue_control      # noqa: PLC0415 — queue_control тянет store; держим cloud лёгким
        state = queue_control.get_state(self.store, QUOTA_STATE_PREFIX + provider) or {}
        until = float(state.get("until") or 0)
        return until if until > time.time() else 0.0

    def _mark_quota(self, provider: str, error: str) -> float:
        from cloud_escalation import provider_reset   # noqa: PLC0415 — cloud_escalation импортирует cloud
        now_ts = time.time()
        until = provider_reset(error, now_ts) or (now_ts + QUOTA_UNKNOWN_RESET_SECONDS)
        until = min(max(until, now_ts + QUOTA_RESUME_GRACE_SECONDS), now_ts + QUOTA_MAX_WAIT_SECONDS)
        if self.store is None:
            self.log(f"    ⚠ {provider}: квота подписки исчерпана, но клиент без базы — отметка не сохранена, "
                     "следующие вызовы снова уйдут в сеть")
            return until
        import queue_control  # noqa: PLC0415
        # Отметку только продлеваем: процесс, не разобравший время сброса, не должен укоротить чужую.
        until = max(until, self.quota_until(provider))
        queue_control.set_state(self.store, QUOTA_STATE_PREFIX + provider,
                                {"until": int(until), "why": (error or "")[:300], "at": int(now_ts)})
        self.log(f"    ⏸ {provider}: квота подписки исчерпана — вызовы режима GLM 5.x ждут до {_when(until)}")
        return until

    def quota_wait(self, model: str) -> "CloudQuotaWait | None":
        """Режим GLM 5.x и исчерпанная квота подписки провайдера модели → исключение для движка прогона."""
        if not self.budget.glm_mode:
            return None
        provider = self.provider_of(model)
        until = self.quota_until(provider)
        if not until:
            return None
        return CloudQuotaWait(until, f"квота подписки {provider} исчерпана до {_when(until)} — прогон ждёт сброса")

    def run_allowance(self) -> int:
        """Сколько облачных вызовов позволено одной карточке в текущем профиле."""
        if self.budget.run_cap > 0:           # режим GLM 5.x — свой потолок, мимо профиля
            return int(self.budget.run_cap)
        return int(self.budget.max_calls_per_run_by_profile.get(
            self.profile, self.budget.max_calls_per_run))

    # ── доступность ──────────────────────────────────────────────────────────
    def provider_of(self, model: str) -> str:
        for name, node in self.providers.items():
            if model in (node.get("models") or []):
                return name
        return ""

    def available(self, model: str) -> tuple[bool, str]:
        if not self.budget.enabled:
            return False, "облако выключено (models.cloud.enabled=false, AI_COUNCIL_CLOUD не задан)"
        provider = self.provider_of(model)
        if not provider:
            return False, f"модель {model} не объявлена ни в одном провайдере models.cloud.providers"
        if not self.providers[provider].get("key"):
            # Ключа основного контура нет, но второй (General API) настроен — это рабочая
            # конфигурация, а не поломка: подписки может не быть вовсе. Кроме режима GLM 5.x:
            # он идёт только в подписку, и без её ключа прогон завершается с причиной.
            fallback = self.fallback_of(provider)
            if not fallback or self.budget.glm_mode:
                env_name = (KEY_SOURCES.get(provider) or ("?", ""))[0]
                return False, (f"нет ключа для {provider} (env {env_name})"
                               + ("; режим GLM 5.x идёт только в подписку Coding Plan — платный "
                                  "контур не используется" if fallback else ""))
        if time.time() < self._down_until.get(provider, 0):
            return False, f"{provider} недоступен (кэш-маркер сбоя)"
        return True, ""

    # ── бюджетные стопы ──────────────────────────────────────────────────────
    def _used_since(self, since: int) -> dict:
        if self.store is None:
            return {"calls": sum(self._calls_this_run.values()), "tokens": 0, "usd": 0.0}
        row = self.store.q1(
            "SELECT COUNT(*) calls, COALESCE(SUM(tokens_in + tokens_out), 0) tokens, "
            "COALESCE(SUM(usd), 0) usd FROM cloud_usage WHERE created_at >= ? AND ok = 1",
            (since,),
        ) or {}
        return {"calls": int(row.get("calls") or 0),
                "tokens": int(row.get("tokens") or 0),
                "usd": float(row.get("usd") or 0.0)}

    def spent_today(self) -> dict:
        """{"calls": n, "tokens": n, "usd": x} за текущие сутки."""
        return self._used_since(day_start())

    def spent_in_window(self) -> dict:
        """То же за скользящее окно плана — главная метрика на подписке."""
        return self._used_since(int(time.time()) - self.budget.window_hours * 3600)

    def check_budget(self, run_id: str, model: str) -> tuple[bool, str]:
        b = self.budget
        used_run = self._calls_this_run.get(run_id, 0)
        allowance = self.run_allowance()
        if used_run >= allowance:
            return False, (f"исчерпан лимит облачных вызовов на прогон "
                           f"({used_run}/{allowance}"
                           + (f", профиль {self.profile}" if self.profile else "") + ")")

        # Скользящее окно — первый стоп: именно им тарифицируется подписка Coding Plan.
        window = self.spent_in_window()
        if window["calls"] >= b.max_calls_per_window:
            return False, (f"исчерпано окно плана: {window['calls']}/{b.max_calls_per_window} "
                           f"вызовов за последние {b.window_hours} ч")

        day = self.spent_today()
        if day["calls"] >= b.max_calls_per_day:
            return False, f"исчерпан суточный лимит вызовов ({day['calls']}/{b.max_calls_per_day})"
        if day["tokens"] >= b.max_tokens_per_day:
            return False, (f"исчерпан суточный лимит токенов "
                           f"({day['tokens']}/{b.max_tokens_per_day})")

        # Денежный стоп работает только для моделей вне подписки: у покрытых планом
        # прайс = 0, и по ним считается окно, а не доллары.
        if b.max_usd_per_day > 0 and day["usd"] >= b.max_usd_per_day:
            return False, f"исчерпан суточный бюджет (${day['usd']:.4f}/${b.max_usd_per_day})"
        worst = estimate_usd(self.pricing, model, 8000, b.max_tokens_out)
        if b.max_usd_per_day > 0 and worst > 0 and day["usd"] + worst > b.max_usd_per_day:
            return False, (f"вызов оценочно стоит до ${worst:.4f}, а до потолка осталось "
                           f"${b.max_usd_per_day - day['usd']:.4f}")

        # Внешние лимиты частоты провайдера (Gemini): считаем локально, в заголовках их нет.
        ok, why = self._check_rate_limit(model)
        if not ok:
            return False, why
        return True, ""

    def _check_rate_limit(self, model: str) -> tuple[bool, str]:
        """Ограничения вида «не чаще N раз за M минут». Считаются по своему же журналу:
        провайдер остаток не отдаёт, а превышение стоит 429 и потерянного времени."""
        provider = self.provider_of(model)
        limits = (self.rate_limits or {}).get(provider) or {}
        if not limits or self.store is None:
            return True, ""
        now_ts = int(time.time())
        for key, minutes in (("max_calls_per_2min", 2), ("max_calls_per_30min", 30)):
            # Отсутствие ключа = лимит не задан. Заданный ноль = запрет, как и везде
            # в бюджете; трактовать 0 как «безлимит» — способ случайно снять потолок.
            if limits.get(key) is None:
                continue
            cap = int(limits[key])
            if cap <= 0:
                return False, f"лимит частоты {provider}: вызовы запрещены ({key}={cap})"
            row = self.store.q1(
                "SELECT COUNT(*) n FROM cloud_usage WHERE provider = ? AND ok = 1 "
                "AND created_at >= ?", (provider, now_ts - minutes * 60),
            ) or {}
            used = int(row.get("n") or 0)
            if used >= cap:
                return False, (f"лимит частоты {provider}: {used}/{cap} вызовов за "
                               f"последние {minutes} мин")
        return self._check_daily_requests(provider, limits, now_ts)

    def _check_daily_requests(self, provider: str, limits: dict, now_ts: int) -> tuple[bool, str]:
        """Суточный потолок запросов провайдера — скользящие 24 ч, все ушедшие в сеть запросы, удачные и нет: у
        бесплатных моделей OpenRouter дневной лимит считает запросы, а не ответы. Отказ несёт retry_after — когда
        старейший запрос окна выйдет из него: эскалация ждёт ровно столько, а не бьётся в 429 весь день."""
        if limits.get("max_requests_per_24h") is None:
            return True, ""
        cap = int(limits["max_requests_per_24h"])
        if cap <= 0:
            return False, f"лимит частоты {provider}: вызовы запрещены (max_requests_per_24h={cap})"
        row = self.store.q1(
            "SELECT COUNT(*) n, MIN(created_at) first FROM cloud_usage WHERE provider = ? "
            "AND (refused IS NULL OR refused = '') AND created_at >= ?", (provider, now_ts - 86400),
        ) or {}
        used = int(row.get("n") or 0)
        if used < cap:
            return True, ""
        wait = max(60, int(row.get("first") or now_ts) + 86400 - now_ts)
        return False, (f"лимит частоты {provider}: {used}/{cap} запросов за 24 ч — "
                       f"retry_after={wait}")

    def pricing_of(self, contour: str) -> dict:
        """Прайс того контура, которым вызов реально ушёл.

        Одна и та же модель на подписке стоит 0 (тарифицируется вызов в окне), а на
        General API — деньги. Считать оба маршрута по одному прайсу нельзя ни в одну
        сторону: по общему платный вызов записался бы как бесплатный (и денежный стоп
        никогда бы не срабатывал), по прайсу General API подписка выглядела бы тратой.
        """
        if contour.endswith(":fallback"):
            node = self.providers.get(contour.split(":", 1)[0]) or {}
            return (node.get("fallback") or {}).get("pricing") or {}
        return self.pricing

    def record(self, run_id: str, role: str, model: str, contour: str,
               result: Completion, refused: str = "") -> None:
        """`contour` — провайдер (`zai`) либо его второй контур (`zai:fallback`): в
        журнале это разные строки, иначе «сколько осталось по подписке» и «сколько
        потрачено денег» считались бы по одним и тем же записям."""
        provider = contour
        usd = estimate_usd(self.pricing_of(contour), model, result.tokens_in, result.tokens_out)
        if result.ok:
            self._calls_this_run[run_id] = self._calls_this_run.get(run_id, 0) + 1
        if self.store is None:
            return
        try:
            self.store.x(
                "INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, "
                "usd, ms, ok, refused, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, role, provider, model, result.tokens_in, result.tokens_out, usd,
                 result.ms, 1 if result.ok else 0, refused, result.error, int(time.time())),
            )
        except Exception as exc:                        # noqa: BLE001 — учёт не роняет прогон
            self.log(f"    ! не удалось записать cloud_usage: {exc}")

    # ── HTTP ─────────────────────────────────────────────────────────────────
    def _post(self, provider: str, url: str, body: dict, headers: dict,
              timeout: int) -> tuple[dict | None, str, int]:
        """Возвращает (данные, ошибка, http_code). 429/5xx → повтор с backoff + jitter."""
        payload = json.dumps(body).encode("utf-8")
        last_error, last_code = "", 0
        for attempt in range(self.max_retries + 1):
            req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
                    return json.loads(resp.read().decode("utf-8", "replace")), "", resp.status
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", "replace")
                detail = raw[:300]
                # Время сброса квоты — до обрезки тела: у Gemini retryDelay в конце длинного
                # ответа, а эскалация (cloud_escalation) назначает повтор именно по нему.
                hint = _reset_hint(exc.headers, raw)
                last_error = f"HTTP {exc.code}: {detail}" + (f" [{hint}]" if hint else "")
                last_code = exc.code
                kind = classify_429(exc.code, detail)
                # 429 бывает трёх разных смыслов, и повторять имеет смысл только один.
                if kind == "no_balance":
                    return None, (f"{last_error} — обращение ушло на pay-as-you-go контур. "
                                  "Проверить base_url: подпиской покрыт только "
                                  "https://api.z.ai/api/coding/paas/v4"), last_code
                if kind == "quota":
                    return None, (f"{last_error} — {QUOTA_ERROR_MARK}. Повторы не "
                                  "помогут, дорабатывать локально"), last_code
                if (kind == "overloaded" or exc.code in (500, 502, 503, 504)) \
                        and attempt < self.max_retries:
                    delay = (2 ** attempt) + random.uniform(0, 1.0)
                    self.log(f"    · {provider} {exc.code}, повтор через {delay:.1f}s")
                    time.sleep(delay)
                    continue
                return None, last_error, last_code
            except (urllib.error.URLError, OSError, TimeoutError) as exc:
                self._down_until[provider] = time.time() + DOWN_TTL
                return None, f"сеть/{provider}: {exc}", 0
            except json.JSONDecodeError as exc:
                return None, f"невалидный JSON от {provider}: {exc}", 0
        return None, last_error, last_code

    # ── генерация ────────────────────────────────────────────────────────────
    def chat(self, run_id: str, role: str, model: str, messages: list[dict], *,
             schema: dict | None = None, temperature: float = 0.15,
             max_tokens: int | None = None) -> Completion:
        """Один облачный вызов. Отказ по бюджету — тоже `Completion(ok=False)` с
        человекочитаемой причиной в `.error`, чтобы она попала в транскрипт."""
        ok, why = self.available(model)
        if not ok:
            return Completion(False, "", None, model, 0, 0, 0, why)
        if self.budget.glm_mode:
            wait = self.quota_wait(model)
            if wait is not None:
                # Без HTTP: на исчерпанной квоте каждый запрос — гарантированный 429 (13.10: 2481 подряд).
                result = Completion(False, "", None, model, 0, 0, 0, wait.why)
                self.record(run_id, role, model, self.provider_of(model), result, refused=wait.why)
                if self.raise_on_quota:
                    raise wait
                return result
        ok, why = self.check_budget(run_id, model)
        if not ok:
            self.log(f"    ⊘ облако не вызвано: {why}")
            result = Completion(False, "", None, model, 0, 0, 0, why)
            self.record(run_id, role, model, self.provider_of(model), result, refused=why)
            return result

        provider = self.provider_of(model)
        cap = min(max_tokens or self.budget.max_tokens_out, self.budget.max_tokens_out)
        started = time.time()
        self._contour_of_last_call = ""
        if provider == "gemini":
            result = self._gemini(model, messages, schema, temperature, cap)
        else:
            result = self._openai_compatible(provider, model, messages, schema, temperature, cap)
        result.ms = result.ms or int((time.time() - started) * 1000)
        contour = self._contour_of_last_call or provider
        self.record(run_id, role, model, contour, result)
        if (not result.ok and self.budget.glm_mode and contour == provider
                and QUOTA_ERROR_MARK in (result.error or "")):
            until = self._mark_quota(provider, result.error or "")
            if self.raise_on_quota:
                raise CloudQuotaWait(until, f"квота подписки {provider} исчерпана до {_when(until)} — "
                                            "прогон ждёт сброса")
        if result.ok:
            window = self.spent_in_window()
            fallback = self.fallback_of(provider)
            spent = self.fallback_spent_today(provider) if contour.endswith(":fallback") else {}
            where = (f", {fallback.get('label', 'второй контур')} "
                     f"{spent['calls']}/{fallback.get('max_calls_per_day', 0)} вызовов и "
                     f"${spent['usd']:.4f}/${fallback.get('max_usd_per_day', 0)} за сутки"
                     if spent else "")
            self.log(f"    ☁ {model} ({role}): {result.tokens_in}+{result.tokens_out} tok, "
                     f"окно {window['calls']}/{self.budget.max_calls_per_window} "
                     f"за {self.budget.window_hours} ч{where}")
        return result

    # ── второй контур биллинга (Z.AI: подписка → General API) ────────────────
    def fallback_of(self, provider: str) -> dict:
        """Контур, на который можно уйти, когда основной отказал по деньгам/квоте.

        У Z.AI один провайдер и два раздельных биллинговых контура: подписка Coding Plan
        (`/api/coding/paas/v4`, тарифицируется вызовами в окне) и General API
        (`/api/paas/v4`, pay-as-you-go, отдельный ключ и отдельный кошелёк). Модели там
        одни и те же, поэтому это не «второй провайдер» — это второй платёжный маршрут
        к тем же моделям, и переключаться между ними имеет смысл ровно в двух случаях:
        кончилось окно подписки (`quota`) или ключ подписки на этот маршрут не годится
        (`no_balance`). Всё остальное (перегрузка, сеть, 5xx) вторым кошельком не лечится.
        """
        node = self.providers.get(provider) or {}
        fallback = node.get("fallback") or {}
        return fallback if fallback.get("base_url") and fallback.get("key") else {}

    def fallback_spent_today(self, provider: str) -> dict:
        """{"calls": n, "usd": x} по второму контуру за сутки — отдельно от подписки."""
        if self.store is None:
            return {"calls": 0, "usd": 0.0}
        row = self.store.q1(
            "SELECT COUNT(*) n, COALESCE(SUM(usd), 0) usd FROM cloud_usage "
            "WHERE provider = ? AND ok = 1 AND created_at >= ?",
            (f"{provider}:fallback", day_start())) or {}
        return {"calls": int(row.get("n") or 0), "usd": float(row.get("usd") or 0.0)}

    def fallback_used_today(self, provider: str) -> int:
        return self.fallback_spent_today(provider)["calls"]

    def _fallback_allowed(self, provider: str, kind: str,
                          model: str = "") -> tuple[dict, str]:
        """(контур, причина отказа). Пустой контур + пустая причина = его просто нет.

        Платный маршрут держат два независимых потолка — вызовы и деньги. Только вызовов
        мало: подписка тарифицируется обращениями, General API — токенами, и десять
        вызовов с раздутой капсулой стоят непредсказуемо дороже десяти обычных.
        """
        fallback = self.fallback_of(provider)
        if not fallback:
            return {}, ""
        if self.budget.glm_mode:
            return {}, (f"{fallback.get('label', 'второй контур')}: режим GLM 5.x идёт только в "
                        "подписку Coding Plan — платный контур не используется")
        # `no_key` в `when` не перечисляют: это не класс отказа провайдера, а отсутствие
        # первого контура вообще — тогда второй работает как основной.
        if kind != "no_key" and kind not in (fallback.get("when") or []):
            return {}, ""
        cap = int(fallback.get("max_calls_per_day") or 0)
        if cap <= 0:
            return {}, (f"{fallback['label']}: суточный потолок не задан или равен нулю "
                        "(models.cloud.providers.*.fallback.max_calls_per_day)")
        spent = self.fallback_spent_today(provider)
        if spent["calls"] >= cap:
            return {}, (f"{fallback['label']}: исчерпан суточный потолок "
                        f"({spent['calls']}/{cap})")

        # Деньги. Ноль = запрет, как и везде в бюджете: платный контур не включается
        # молчанием конфига.
        budget_usd = float(fallback.get("max_usd_per_day") or 0.0)
        if budget_usd <= 0:
            return {}, (f"{fallback['label']}: денежный потолок не задан или равен нулю "
                        "(models.cloud.providers.*.fallback.max_usd_per_day)")
        if spent["usd"] >= budget_usd:
            return {}, (f"{fallback['label']}: исчерпан суточный бюджет "
                        f"(${spent['usd']:.4f}/${budget_usd})")
        pricing = fallback.get("pricing") or {}
        worst = estimate_usd(pricing, model, 8000, self.budget.max_tokens_out) if model else 0.0
        if model and worst <= 0:
            # Прайса на модель нет → цена вызова неизвестна → денежный потолок ничего не
            # держит. Уходить в этом состоянии на платный маршрут нельзя.
            return {}, (f"{fallback['label']}: нет прайса на {model} "
                        f"(models.cloud.providers.{provider}.fallback.pricing.\"{model}\") — "
                        "цена вызова неизвестна, платный контур не используется")
        if worst > 0 and spent["usd"] + worst > budget_usd:
            return {}, (f"{fallback['label']}: вызов оценочно стоит до ${worst:.4f}, "
                        f"а до потолка осталось ${budget_usd - spent['usd']:.4f}")
        return fallback, ""

    def contours_of(self, provider: str) -> list[dict]:
        """Биллинговые контуры провайдера как список для проверки и показа.

        Возвращает и незаполненные (без ключа) — «ключа нет» это тоже ответ на вопрос
        «почему не работает», и он должен быть виден, а не выпадать из списка.
        """
        node = self.providers.get(provider) or {}
        env_name = (KEY_SOURCES.get(provider) or ("—", ""))[0]
        # У Z.AI основной контур — именно подписка (тарифицируется вызовами в окне);
        # у остальных провайдеров основной ключ никакой подписки не подразумевает.
        primary_label = "подписка Coding Plan" if provider == "zai" else "основной контур"
        out = [{"contour": "primary", "tag": provider, "label": primary_label,
                "base_url": node.get("base_url", ""), "has_key": bool(node.get("key")),
                "key_source": env_name}]
        fallback = (node.get("fallback") or {})
        if fallback.get("base_url"):
            spent = self.fallback_spent_today(provider)
            out.append({
                "contour": "fallback", "tag": f"{provider}:fallback",
                "label": fallback.get("label", "второй контур"),
                "base_url": fallback.get("base_url", ""),
                "has_key": bool(fallback.get("key")),
                "key_source": fallback.get("key_env", ""),
                "when": list(fallback.get("when") or []),
                "calls_today": spent["calls"],
                "max_calls_per_day": fallback.get("max_calls_per_day", 0),
                "usd_today": round(spent["usd"], 4),
                "max_usd_per_day": fallback.get("max_usd_per_day", 0),
                "priced_models": sorted((fallback.get("pricing") or {}).keys()),
            })
        return out

    def ping(self, model: str, *, contour: str = "primary",
             run_id: str = "ping") -> tuple[bool, str]:
        """Живая проверка ОДНОГО контура: до первой карточки, а не в середине прогона.

        Контуры проверяются раздельно намеренно: у них разные ключи, разные endpoint'ы и
        разные кошельки, поэтому «облако работает» — не ответ. Обычный вызов сам уходит на
        второй контур только когда первый отказал по квоте, и до этого момента платный
        маршрут остаётся непроверенным — а узнать, что в нём опечатка, в момент, когда
        подписка уже кончилась, дороже всего.

        Проверка — настоящий вызов: на подписке она тратит обращение из окна, на General
        API — деньги. Поэтому она идёт через те же бюджетные стопы и попадает в журнал.
        Успех — это ответ провайдера (HTTP 200), а не непустой текст: 16 токенов GLM
        может целиком израсходовать на reasoning, и пустой `content` при живом ключе
        означает «связь есть», а не «связи нет».
        """
        provider = self.provider_of(model)
        if not provider:
            return False, f"модель {model} не объявлена ни в одном провайдере"
        if not self.budget.enabled:
            return False, "облако выключено (models.cloud.enabled=false)"
        node = self.providers[provider]
        if contour == "fallback":
            # `no_key` вместо класса отказа: пинг проверяет контур сам по себе, а не
            # «сработает ли переход» — но потолки вызовов и денег остаются в силе.
            target, refusal = self._fallback_allowed(provider, "no_key", model)
            if not target:
                spec = node.get("fallback") or {}
                if spec.get("base_url") and not spec.get("key"):
                    # Контур описан, но ключа нет — это не «его нет», а «его нечем открыть»:
                    # разные причины требуют разных действий владельца.
                    return False, (f"нет ключа второго контура "
                                   f"(env {spec.get('key_env') or '—'})")
                return False, (refusal
                               or f"у {provider} не настроен второй контур биллинга")
            tag = f"{provider}:fallback"
        else:
            if not node.get("key"):
                env_name = (KEY_SOURCES.get(provider) or ("?", ""))[0]
                return False, f"нет ключа основного контура (env {env_name})"
            target, tag = node, provider
        ok, why = self.check_budget(run_id, model)
        if not ok:
            return False, why

        # Уникальный хвост в промпте — обязателен: Headroom кэширует префиксы, и на
        # повторной проверке ответ приходит из кэша за 20 мс. Такая «проверка» говорит
        # только о том, что прокси помнит прошлый ответ, а не о том, что ключ ещё жив.
        messages = [{"role": "user",
                     "content": f"Ответь одним словом: ok (проверка {int(time.time())})"}]
        started = time.time()
        if provider == "gemini":
            if contour == "fallback":
                return False, "у gemini нет второго контура биллинга"
            result = self._gemini(model, messages, None, 0.0, 16)
        else:
            url, headers = self._route(provider, target)
            data, error, _code = self._post(
                provider, url,
                {"model": model, "messages": messages, "stream": False,
                 "temperature": 0.0, "max_tokens": 16},
                headers, node.get("timeout", self.request_timeout))
            usage = (data or {}).get("usage") or {}
            result = Completion(
                data is not None, "", None, model, 0,
                int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0),
                "" if data is not None else error)
        result.ms = int((time.time() - started) * 1000)
        self.record(run_id, "doctor", model, tag, result)
        if not result.ok:
            return False, result.error
        detail = f"ответ за {result.ms} мс, {result.tokens_in}+{result.tokens_out} токенов"
        if contour == "fallback":
            usd = estimate_usd(self.pricing_of(tag), model,
                              result.tokens_in, result.tokens_out)
            detail += f", записано ${usd:.4f}"
        return True, detail

    # ── маршрут: напрямую к провайдеру или через Headroom ────────────────────
    def _route(self, provider: str, node: dict) -> tuple[str, dict]:
        """Куда physically уходит HTTP-запрос и с какими заголовками.

        Headroom (127.0.0.1:8787) — прокси оптимизации контекста: он сжимает промпт,
        кэширует префиксы и ведёт учёт экономии в своём дашборде. Пропуская облачные
        вызовы через него, консилиум получает и сжатие, и общую с остальным проектом
        картину расхода — иначе трафик GLM в дашборде не виден вовсе.

        Две тонкости, обе выяснены экспериментом 2026-08-13 (прокси 0.34.0):
          • `x-headroom-base-url` задаёт upstream, но прокси приклеивает к нему СВОЙ
            путь `/v1/chat/completions`. У Z.AI Coding Plan путь `/v4/chat/completions`,
            поэтому без второго заголовка получается `/v4/v1/chat/completions` → 404;
          • `x-headroom-original-path` переопределяет этот суффикс. Он принимается,
            только если оканчивается на `/chat/completions` — иначе прокси молча
            возвращается к дефолту, и 404 повторяется.

        Ключ провайдера уходит в Authorization как обычно: прокси его не подменяет,
        он его пересылает. Наружу, кроме самого провайдера, ничего не уходит —
        Headroom слушает петлю.
        """
        direct = node["base_url"].rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {node['key']}"}
        if not self.headroom.get("enabled") or provider not in (
                self.headroom.get("providers") or []):
            return direct, headers
        if not self._headroom_alive():
            return direct, headers

        base = str(self.headroom.get("url", "")).rstrip("/")
        headers["x-headroom-base-url"] = node["base_url"].rstrip("/")
        headers["x-headroom-original-path"] = "/chat/completions"
        return f"{base}/v1/chat/completions", headers

    def _headroom_alive(self) -> bool:
        """Живость прокси с коротким кэшем. Без проверки первый же вызов при потушенном
        Headroom стоил бы полного таймаута — и это на платной карточке. Результат
        кэшируется, чтобы не дёргать /health перед каждым обращением."""
        now_ts = time.time()
        if now_ts < self._headroom_checked_until:
            return self._headroom_ok
        url = str(self.headroom.get("url", "")).rstrip("/") + "/health"
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                self._headroom_ok = 200 <= response.status < 300
        except Exception:                                       # noqa: BLE001
            self._headroom_ok = False
        if not self._headroom_ok:
            self.log("    ⚠ Headroom не отвечает — облачные вызовы идут напрямую")
        self._headroom_checked_until = now_ts + 30
        return self._headroom_ok

    def _openai_compatible(self, provider: str, model: str, messages: list[dict],
                           schema: dict | None, temperature: float,
                           max_tokens: int) -> Completion:
        node = self.providers[provider]
        body: dict = {
            "model": model,
            "messages": self._with_schema_hint(messages, schema),
            "stream": False,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if schema is not None:
            # Z.AI General API — OpenAI-совместимый: json_object есть, строгой схемы нет,
            # поэтому саму схему дублируем в system-сообщение (см. _with_schema_hint).
            body["response_format"] = {"type": "json_object"}

        timeout = node.get("timeout", self.request_timeout)
        # Основного ключа может не быть вовсе (подписки нет, есть только General API) —
        # тогда второй контур не запасной, а единственный, и идём сразу на него.
        contour, only_fallback = node, False
        if not node.get("key"):
            fallback, refusal = self._fallback_allowed(provider, "no_key", model)
            if not fallback:
                return Completion(False, "", None, model, 0, 0, 0,
                                  refusal or f"нет ключа для {provider}")
            contour, only_fallback = fallback, True
            self._contour_of_last_call = f"{provider}:fallback"
        url, headers = self._route(provider, contour)
        data, error, code = self._post(provider, url, body, headers, timeout)
        if data is None and only_fallback:
            return Completion(False, "", None, model, 0, 0, 0,
                              f"{contour.get('label', 'второй контур')}: {error}")

        # Отказ по деньгам/квоте на основном контуре — единственный случай, когда есть
        # смысл повторить тот же запрос вторым ключом (General API). Повтор ровно один
        # и только при явно заданном суточном потолке: второй контур платный, и «тихо
        # доплатить» вместо «доработать локально» — не поведение по умолчанию.
        if data is None:
            kind = classify_429(code, error)
            fallback, refusal = self._fallback_allowed(provider, kind, model)
            if refusal:
                self.log(f"    ⊘ {refusal} — остаёмся на основном контуре")
            if fallback:
                self.log(f"    ↪ {provider}: {kind} на подписке → повтор через "
                         f"{fallback['label']} ({fallback['base_url']})")
                url, headers = self._route(provider, fallback)
                data, fb_error, _ = self._post(provider, url, body, headers, timeout)
                if data is None:
                    return Completion(False, "", None, model, 0, 0, 0,
                                      f"{error}; {fallback['label']}: {fb_error}")
                self._contour_of_last_call = f"{provider}:fallback"
        if data is None:
            return Completion(False, "", None, model, 0, 0, 0, error)
        choices = data.get("choices") or []
        message = (choices[0].get("message") or {}) if choices else {}
        text = (message.get("content") or "").strip()
        usage = data.get("usage") or {}
        tokens_in = int(usage.get("prompt_tokens") or 0)
        tokens_out = int(usage.get("completion_tokens") or 0)

        # GLM-4.x/5.x — reasoning-модели: «мысли» тарифицируются как completion и съедают
        # max_tokens ДО того, как появится ответ. При тесном лимите приходит пустой content
        # при непустом reasoning_content — молча принимать это за пустой ответ нельзя,
        # иначе платный вызов выглядит успешным и ничего не даёт.
        if not text and message.get("reasoning_content"):
            reasoning = int((usage.get("completion_tokens_details") or {})
                            .get("reasoning_tokens") or tokens_out)
            return Completion(
                False, "", None, model, 0, tokens_in, tokens_out,
                f"модель израсходовала весь лимит на reasoning ({reasoning} токенов) и не "
                f"успела ответить — поднять models.cloud.budget.max_tokens_out "
                f"(сейчас {self.budget.max_tokens_out})")
        return self._finish(model, text, schema, tokens_in, tokens_out)

    def _gemini(self, model: str, messages: list[dict], schema: dict | None,
                temperature: float, max_tokens: int) -> Completion:
        node = self.providers["gemini"]
        system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
        turns = [{"role": "user" if m.get("role") != "assistant" else "model",
                  "parts": [{"text": m.get("content") or ""}]}
                 for m in messages if m.get("role") != "system"]
        body: dict = {
            "contents": turns,
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if schema is not None:
            body["generationConfig"]["responseMimeType"] = "application/json"
            body["generationConfig"]["responseSchema"] = _to_gemini_schema(schema)

        url = (node["base_url"].rstrip("/") + f"/models/{model}:generateContent")
        data, error, code = self._post(
            "gemini", url, body,
            {"Content-Type": "application/json", "x-goog-api-key": node["key"]},
            node.get("timeout", self.request_timeout),
        )
        if data is None and code == 400 and schema is not None:
            # Схема не переварилась (Gemini принимает подмножество OpenAPI) — повтор без неё,
            # требование JSON остаётся в тексте промпта.
            body["generationConfig"].pop("responseSchema", None)
            data, error, code = self._post(
                "gemini", url, body,
                {"Content-Type": "application/json", "x-goog-api-key": node["key"]},
                node.get("timeout", self.request_timeout),
            )
        if data is None:
            return Completion(False, "", None, model, 0, 0, 0, error)
        candidates = data.get("candidates") or []
        parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
        text = "".join(p.get("text", "") for p in parts).strip()
        usage = data.get("usageMetadata") or {}
        return self._finish(model, text, schema,
                            int(usage.get("promptTokenCount") or 0),
                            int(usage.get("candidatesTokenCount") or 0))

    @staticmethod
    def _with_schema_hint(messages: list[dict], schema: dict | None) -> list[dict]:
        if schema is None:
            return messages
        hint = ("Ответ — ТОЛЬКО валидный JSON по схеме, без markdown-обёртки и пояснений.\n"
                f"JSON Schema:\n{json.dumps(schema, ensure_ascii=False)}")
        return messages + [{"role": "system", "content": hint}]

    @staticmethod
    def _finish(model: str, text: str, schema: dict | None,
                tokens_in: int, tokens_out: int) -> Completion:
        parsed = None
        if schema is not None and text:
            parsed = _parse_json_loose(text)
            if parsed is None:
                return Completion(False, text, None, model, 0, tokens_in, tokens_out,
                                  "ответ не распарсился как JSON")
        return Completion(True, text, parsed, model, 0, tokens_in, tokens_out)


def _parse_json_loose(text: str) -> dict | None:
    """Облачные модели любят обернуть JSON в ```json — на повторный платный вызов
    из-за трёх обратных кавычек денег не тратим."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    candidate = fenced.group(1) if fenced else text
    start, end = candidate.find("{"), candidate.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(candidate[start:end + 1])
        except json.JSONDecodeError:
            return None
    return None


_GEMINI_ALLOWED = {"type", "properties", "required", "items", "enum", "description", "nullable"}


def _to_gemini_schema(schema: dict) -> dict:
    """Gemini принимает подмножество OpenAPI: типы в верхнем регистре, лишние ключи —
    400. Чистим рекурсивно; при неудаче вызывающий код повторит запрос без схемы."""
    if not isinstance(schema, dict):
        return schema
    out: dict = {}
    for key, value in schema.items():
        if key not in _GEMINI_ALLOWED:
            continue
        if key == "type" and isinstance(value, str):
            out["type"] = value.upper()
        elif key == "properties" and isinstance(value, dict):
            out["properties"] = {k: _to_gemini_schema(v) for k, v in value.items()}
        elif key == "items":
            out["items"] = _to_gemini_schema(value)
        else:
            out[key] = value
    return out


def build(cfg, store=None, logger=None) -> CloudClient:
    """Собрать клиент из config.Config. Ключи читаются здесь — не хранятся в конфиге."""
    node = cfg.get("models.cloud", {}) or {}
    providers: dict = {}
    for name, spec in (node.get("providers") or {}).items():
        fallback_spec = spec.get("fallback") or {}
        fallback: dict = {}
        if fallback_spec.get("enabled"):
            fallback = {
                "base_url": str(fallback_spec.get("base_url", "")),
                "key": read_key_from(str(fallback_spec.get("key_env", "")),
                                     str(fallback_spec.get("key_file", ""))),
                "key_env": str(fallback_spec.get("key_env", "")),
                "when": list(fallback_spec.get("when") or ["quota"]),
                "max_calls_per_day": int(fallback_spec.get("max_calls_per_day", 0)),
                "max_usd_per_day": float(fallback_spec.get("max_usd_per_day", 0.0)),
                # Свой прайс: на подписке те же модели стоят 0 (расход держит окно), а
                # здесь за них платят деньгами. Общий models.cloud.pricing тут не годится —
                # по нему платный вызов выглядел бы бесплатным.
                "pricing": fallback_spec.get("pricing", {}) or {},
                "label": str(fallback_spec.get("label", "второй контур")),
            }
        providers[name] = {
            "base_url": spec.get("base_url", ""),
            "models": list(spec.get("models") or []),
            "timeout": int(spec.get("timeout_seconds", 180)),
            "key": read_key(name),
            "fallback": fallback,
        }
    return CloudClient(
        providers=providers,
        pricing=node.get("pricing", {}) or {},
        rate_limits=node.get("rate_limits", {}) or {},
        budget=Budget.from_cfg(cfg),
        store=store,
        request_timeout=int(node.get("request_timeout_seconds", 180)),
        logger=logger,
        headroom={
            "enabled": bool(cfg.get("models.cloud.headroom.enabled", False)),
            "url": str(cfg.get("models.cloud.headroom.url", "http://127.0.0.1:8787")),
            # Только OpenAI-совместимые провайдеры: у Gemini свой протокол, и его
            # запросы прокси по этому маршруту не понимает.
            "providers": list(cfg.get("models.cloud.headroom.providers", ["zai"]) or []),
        },
    )


def _report(cfg, store) -> int:
    import glm_mode   # noqa: PLC0415 — glm_mode сам импортирует cloud (Budget.from_cfg)
    client = build(cfg, store)
    # Тумблер «всё на GLM 5.x» в шапке UI: пока он действует (включён И облако включено), окно и
    # сутки — лимиты режима, и отчёт обязан показывать ту же цифру, по которой воркер отказывает.
    glm_on = store is not None and glm_mode.effective(store, cfg)
    glm_mode.apply_budget(client, cfg, glm_on)
    b = client.budget
    day = client.spent_today()
    print(f"облако:   {'ВКЛЮЧЕНО' if b.enabled else 'выключено'} "
          f"(models.cloud.enabled / AI_COUNCIL_CLOUD)")
    if glm_on:
        g = glm_mode.settings(cfg)
        print(f"режим:    ВСЁ НА GLM 5.x (тумблер в шапке) — "
              + ", ".join(f"{r}={m}" for r, m in sorted(g["models"].items()))
              + f"; embed локально; {g['max_calls_per_run']} вызовов на прогон; "
                "платный контур закрыт")
    elif store is not None and glm_mode.is_on(store):
        print("режим:    GLM 5.x включён в шапке, но НЕ ДЕЙСТВУЕТ — облако выключено")
    for name, node in sorted(client.providers.items()):
        env_name = (KEY_SOURCES.get(name) or ("?", ""))[0]
        key_state = "ключ есть" if node["key"] else f"НЕТ КЛЮЧА ({env_name})"
        print(f"  {name:8} {key_state:32} {', '.join(node['models']) or '— моделей нет'}")
        fb = node.get("fallback") or {}
        if fb:
            used, cap = client.fallback_used_today(name), fb.get("max_calls_per_day", 0)
            state = ("ключ есть" if fb.get("key")
                     else f"НЕТ КЛЮЧА ({fb.get('key_env') or '—'})")
            print(f"    └ {fb.get('label', 'второй контур'):26} {state:26} "
                  f"{used}/{cap} вызовов за сутки · при {', '.join(fb.get('when') or [])}")
    window = client.spent_in_window()
    print(f"\nокно плана ({b.window_hours} ч): {window['calls']}/{b.max_calls_per_window} "
          f"вызовов  ← главный лимит подписки")
    print(f"за сутки: {day['calls']}/{b.max_calls_per_day} вызовов · "
          f"{day['tokens']}/{b.max_tokens_per_day} токенов · "
          f"${day['usd']:.4f}/${b.max_usd_per_day} (деньги — только вне подписки)")
    print(f"на прогон: не более {client.run_allowance()} вызовов, "     # в режиме — его потолок
          f"{b.max_tokens_out} токенов на ответ")
    if glm_on:                          # потолок режима один на все профили — профильные не действуют
        print(f"в режиме GLM 5.x: не меньше ≈{b.max_calls_per_window // max(client.run_allowance(), 1)} "
              f"карточек за окно (по потолку прогона), профильные потолки не действуют")
    elif b.max_calls_per_run_by_profile:
        per_profile = ", ".join(f"{name}={cap}"
                                for name, cap in sorted(b.max_calls_per_run_by_profile.items()))
        capacity = ", ".join(
            f"{name}≈{b.max_calls_per_window // cap} карточек за окно"
            for name, cap in sorted(b.max_calls_per_run_by_profile.items()) if cap > 0)
        print(f"на прогон по профилям: {per_profile}  ({capacity})")
    ladder = cfg.get("models.cloud.roles.ladder", []) or []
    if ladder:
        print(f"лестница: {' → '.join(ladder)}")
    _window_label = {"max_calls_per_2min": "за 2 мин", "max_calls_per_30min": "за 30 мин"}
    for provider, limits in (client.rate_limits or {}).items():
        parts = [f"{v} {_window_label.get(k, k)}" for k, v in limits.items()]
        print(f"частота {provider}: не более " + ", ".join(parts))
    if store is None:
        return 0
    rows = store.q(
        "SELECT created_at, role, model, tokens_in, tokens_out, usd, ok, refused "
        "FROM cloud_usage ORDER BY id DESC LIMIT 10")
    if rows:
        print("\nпоследние вызовы:")
        for r in rows:
            stamp = time.strftime("%m-%d %H:%M", time.localtime(r["created_at"]))
            mark = "✓" if r["ok"] else "⊘"
            tail = r["refused"] or f"{r['tokens_in']}+{r['tokens_out']} tok, ${r['usd']:.4f}"
            print(f"  {mark} {stamp} {r['role']:16} {r['model']:18} {tail}")
    else:
        print("\nвызовов ещё не было")
    return 0


if __name__ == "__main__":
    # Бюджет и доступность: python3 infra/ai-council/cloud.py [--ping]
    import config as config_mod   # noqa: E402
    from store import Store       # noqa: E402

    cfg = config_mod.load(strict=False)
    with Store() as store:
        code = _report(cfg, store)
        if "--ping" in sys.argv:
            # Каждый контур проверяется отдельным вызовом: у подписки и General API свои
            # ключи и свои кошельки, и «облако отвечает» ничего не говорит о втором из них.
            client = build(cfg, store, logger=print)
            print("\nпроверка связи (каждая строка — настоящий вызов и настоящий расход):")
            for provider, node in sorted(client.providers.items()):
                for model in node["models"][:1]:
                    for contour in client.contours_of(provider):
                        ok, why = client.ping(model, contour=contour["contour"])
                        mark = "✓" if ok else "✗"
                        print(f"  {mark} {provider}/{contour['label']} {model}: {why}")
    sys.exit(code)
