#!/usr/bin/env python3
"""AI Council — каталог ревью-оркестрации: методы, встроенные агенты, параметры моделей.

Канон: docs/specs/ai-council.md §17 (ревью) · .claude/rules/17-notion-board.md (доска t-boards).

Одиннадцать методов ревью — НЕ одиннадцать движков. Каждый метод раскладывается на
стадии из восьми типов (review_engine.STAGE_RUNNERS): кто участвует, видят ли участники
друг друга, кто атакует, кто сводит. «Блокирующее» — не алгоритм, а оверлей политики
вердикта (вето ролей с can_block). «Комбинированное» — тот же набор стадий, только
список задаёт профиль.

Здесь же — белый список параметров Ollama. Всё, чего нет в PARAM_SPEC, в запрос не
уходит: UI не должен превращаться в прокси произвольного JSON к демону.
"""
from __future__ import annotations

import hashlib
import json
import re

VERDICTS = ("ACCEPT", "FAIL", "NEEDS_HUMAN", "INCONCLUSIVE")
VOTES = ("accept", "fail", "needs_human")
SEVERITIES = ("critical", "major", "minor", "info")
AGENT_KINDS = ("reviewer", "adversary", "judge")
PARTICIPANT_MODES = ("AUTO", "MANUAL", "HYBRID")
AUTO_STRATEGIES = ("rules", "llm")
BOARDS = ("bugs", "tasks")

# ── стадии ──────────────────────────────────────────────────────────────────
# independent — каждый ревьюер сам по себе, ответы друг друга не видит (защита от
#               эффекта толпы — главный риск консилиума из моделей одного корпуса)
# cross       — ревьюеры видят выводы коллег и пересматривают голос (конвергенция)
# challenge   — оппонент атакует находки: снимает необоснованные, ищет пропущенные
# pair_check  — второй участник пары проверяет первого
# chain       — каскад: каждый получает структурированный вывод предыдущего
# escalate    — восходящее: старший получает выжимку узких специалистов
# rubric      — оценка по рубрике (эвалюционное)
# judge       — сведение: вердикт, ограниченный политикой (код, не модель, решает вето)
# consult     — агенты обращаются друг к другу: вопрос ревьюера адресату по имени (§17.5)
# crosscheck  — встречная проверка: решающую находку (critical, основание вето) КОД отдаёт
#               названному коллеге автора — подтвердить или оспорить до судьи
STAGE_TYPES = ("independent", "cross", "challenge", "pair_check", "chain",
               "escalate", "rubric", "consult", "crosscheck", "judge")
VOTING_STAGES = ("independent", "chain", "rubric", "escalate")
FLAVORS = ("", "divergent", "cognitive", "test")

METHODS: dict[str, dict] = {
    "ADVERSARIAL": {
        "label": "Адверсариальное",
        "about": "Независимые ревьюеры → оппонент атакует их находки и ищет пропущенное → судья. "
                 "Дефолт для багов, безопасности и рискованных изменений.",
        "stages": [{"type": "independent"}, {"type": "challenge"}, {"type": "judge"}],
    },
    "DIVERGENT": {
        "label": "Дивергентное",
        "about": "Каждый ищет максимально непохожие гипотезы и риски, затем синтез. "
                 "Для неясных инцидентов и продуктовых вопросов.",
        "stages": [{"type": "independent", "flavor": "divergent"}, {"type": "judge"}],
    },
    "CONVERGENT": {
        "label": "Конвергентное",
        "about": "Независимая фаза → участники видят выводы друг друга и пересматривают голос → "
                 "судья. Несогласие сохраняется как особое мнение.",
        "stages": [{"type": "independent"}, {"type": "cross"}, {"type": "judge"}],
    },
    "PAIR": {
        "label": "Парное",
        "about": "Ревьюер + проверяющий. Быстрый дешёвый gate; не единственный контур для "
                 "security-критичного.",
        "stages": [{"type": "independent", "limit": 1}, {"type": "pair_check"}, {"type": "judge"}],
    },
    "BLOCKING": {
        "label": "Блокирующее",
        "about": "Независимое ревью + право вето у ролей с «может блокировать». FAIL такой роли "
                 "не перекрывается большинством.",
        "stages": [{"type": "independent"}, {"type": "judge"}],
        "force_blocking": True,
    },
    "COGNITIVE": {
        "label": "Когнитивное",
        "about": "Ревьюеры проверяют искажения: подтверждение, ложная причинность, «готово» "
                 "без доказательств; оппонент-аудитор оспаривает.",
        "stages": [{"type": "independent", "flavor": "cognitive"},
                   {"type": "challenge", "flavor": "cognitive"}, {"type": "judge"}],
    },
    "ASCENDING": {
        "label": "Восходящее",
        "about": "Сначала узкие специалисты, затем старший получает их структурированные выводы "
                 "(не сырой текст), затем судья.",
        "stages": [{"type": "independent", "exclude_senior": True}, {"type": "escalate"},
                   {"type": "judge"}],
    },
    "EVALUATIVE": {
        "label": "Эвалюционное",
        "about": "Оценка по рубрике критериев (0–3) с порогом. Для спецификаций и acceptance "
                 "criteria. Версия рубрики — в снимке запуска.",
        "stages": [{"type": "rubric"}, {"type": "judge"}],
    },
    "TEST_ORIENTED": {
        "label": "Тест-ориентированное",
        "about": "Роли строят сценарии, граничные случаи и регрессии и проверяют, покрыты ли они "
                 "отчётом. Гипотеза ≠ воспроизведённый дефект.",
        "stages": [{"type": "independent", "flavor": "test"}, {"type": "judge"}],
    },
    "CASCADING": {
        "label": "Каскадное",
        "about": "Вывод каждого этапа — структурированный вход следующего. Для расследований и "
                 "длинных процессов.",
        "stages": [{"type": "chain"}, {"type": "judge"}],
    },
    "COMBINED": {
        "label": "Комбинированное",
        "about": "Конструктор: стадии задаёт профиль. По умолчанию независимое → атака → "
                 "конвергенция → судья.",
        "stages": [{"type": "independent"}, {"type": "challenge"}, {"type": "cross"},
                   {"type": "judge"}],
        "custom": True,
    },
}

DEFAULT_RUBRIC = [
    "Цель карточки достигнута (acceptance criteria выполнены)",
    "Есть доказательства: изменённые файлы, коммит, команды проверки и их результат",
    "Нет нарушений правил проекта (.claude/rules, антипаттерны)",
    "Учтены граничные случаи и регрессии; тесты добавлены или обоснованно не нужны",
    "Нет открытых рисков безопасности/PII/данных без плана",
]

# ── параметры моделей (Ollama options) ──────────────────────────────────────
# type: float | int | bool | list ; top-level = уходит не в options, а в тело запроса.
PARAM_SPEC: dict[str, dict] = {
    "temperature":       {"type": "float", "min": 0.0, "max": 2.0, "label": "Temperature",
                          "hint": "вариативность; для строгого ревью 0.1–0.3"},
    "top_p":             {"type": "float", "min": 0.0, "max": 1.0, "label": "Top P",
                          "hint": "отсечение хвоста вероятностей; 0.8–0.95"},
    "top_k":             {"type": "int", "min": 0, "max": 500, "label": "Top K",
                          "hint": "пул следующих токенов; 20–50"},
    "min_p":             {"type": "float", "min": 0.0, "max": 1.0, "label": "Min P",
                          "hint": "отсечение крайне маловероятных токенов; 0.03–0.1"},
    "typical_p":         {"type": "float", "min": 0.0, "max": 1.0, "label": "Typical P"},
    "repeat_penalty":    {"type": "float", "min": 0.5, "max": 2.5, "label": "Repeat penalty",
                          "hint": "против зацикливания; 1.05–1.15"},
    "repeat_last_n":     {"type": "int", "min": -1, "max": 4096, "label": "Repeat last N"},
    "presence_penalty":  {"type": "float", "min": -2.0, "max": 2.0, "label": "Presence penalty"},
    "frequency_penalty": {"type": "float", "min": -2.0, "max": 2.0, "label": "Frequency penalty"},
    "seed":              {"type": "int", "min": -1, "max": 2**31 - 1, "label": "Seed",
                          "hint": "фиксированный — повторяемые прогоны"},
    "num_ctx":           {"type": "int", "min": 2048, "max": 262144, "label": "Контекст (num_ctx)",
                          "hint": "окно входа+выхода; смена = перезагрузка модели в Ollama"},
    "num_predict":       {"type": "int", "min": -1, "max": 65536, "label": "Макс. выход (num_predict)",
                          "hint": "-1 — без искусственного лимита (в пределах контекста)"},
    "mirostat":          {"type": "int", "min": 0, "max": 2, "label": "Mirostat (0/1/2)"},
    "mirostat_tau":      {"type": "float", "min": 0.0, "max": 10.0, "label": "Mirostat tau"},
    "mirostat_eta":      {"type": "float", "min": 0.0, "max": 1.0, "label": "Mirostat eta"},
    "num_thread":        {"type": "int", "min": 1, "max": 64, "label": "Потоки CPU"},
    "stop":              {"type": "list", "label": "Stop-последовательности"},
    "think":             {"type": "bool", "top_level": True, "label": "Reasoning (think)",
                          "hint": "для reasoning-моделей; false — без «мыслей» в выходе"},
    "keep_alive":        {"type": "str", "top_level": True, "label": "Keep alive",
                          "hint": "сколько держать модель в памяти после вызова, напр. 10m"},
    "timeout":           {"type": "int", "min": 10, "max": 7200, "local": True,
                          "label": "Таймаут вызова, с"},
    "retries":           {"type": "int", "min": 0, "max": 5, "local": True, "label": "Повторы"},
}

# ── встроенные агенты ───────────────────────────────────────────────────────
# model "" = наследовать от профиля (default_model) → настройки ревью → профиль fast.
# triggers — сигналы автоподбора; причина подбора показывается в UI рядом с агентом.
_SEC_WORDS = ["auth", "token", "jwt", "permission", "rbac", "pii", "secret", "webhook",
              "hmac", "ssrf", "xss", "csrf", "upload", "oauth", "cookie", "password",
              "безопасн", "уязвим", "ключ", "доступ", "права", "персональн"]
# Фокус — коротко: у 7B-моделей длинная инструкция вытесняет досье. Граница роли («не
# подменяй X») важнее перечня: без неё архитектор, код-ревьюер и оппонент пишут одно и то
# же разными словами. max_severity — потолок важности находок агента, применяет КОД.
BUILTIN_AGENTS: list[dict] = [
    {"key": "code_reviewer", "label": "Code reviewer", "kind": "reviewer",
     "focus": "Локальная корректность изменённого кода: ветвления, типы, ошибки, ресурсы, "
              "конкурентный доступ, антипаттерны проекта (body: unknown, raw fetch, findMany без "
              "take, $transaction без timeout, process.env вне config). Только по строкам диффа: "
              "«размер файла» — лишь для файла из диффа > 500 строк с числом; нет коммитов — это "
              "missing_evidence, не находка. Архитектуру не подменяй.",
     "model": "", "params": {"temperature": 0.2}, "can_block": False,
     "triggers": {"always": True}},
    {"key": "dod_auditor", "label": "DoD-аудитор", "kind": "reviewer",
     "focus": "Definition of Done: каждому критерию готовности — артефакт проверки (изменённые "
              "файлы, коммит/PR, команда узкого чека С РЕЗУЛЬТАТОМ, названные риски, запись в "
              "docs/plans/done/). Нет доказательства — пиши в missing_evidence и голосуй "
              "needs_human, а не заводи находку. Результат «0 ошибок/passed» в досье — это "
              "выполненная проверка. Дефекты кода — не твоя роль.",
     "model": "", "params": {"temperature": 0.1}, "can_block": False, "max_severity": "major",
     "audits_evidence": True, "triggers": {"always": True}},
    {"key": "architecture_reviewer", "label": "Архитектор", "kind": "reviewer",
     "focus": "Границы модулей, владение данными, направление зависимостей, контракты packages/, "
              "Connect RPC vs REST, WebSocket vs SSE, обратная совместимость. Соответствие "
              "существующей архитектуре; переписывание — только с доказанной необходимостью. "
              "Строчные дефекты — дело code reviewer.",
     "model": "", "params": {"temperature": 0.35}, "can_block": False,
     "triggers": {"keywords": ["schema", "prisma", "migration", "миграц", "module", "модул",
                               "rpc", "proto", "refactor", "рефактор", "архитект", "контракт",
                               "packages/", "dto"],
                  "modules": ["backend", "db/queues", "realtime"]}},
    {"key": "security_reviewer", "label": "Security reviewer", "kind": "reviewer",
     "focus": "Последствия ЭТОГО изменения: authz/IDOR, секреты, PII, недоверенный ввод, "
              "инъекции, SSRF, XSS, HMAC/timingSafeEqual, загрузка файлов (@UploadPolicy), токены "
              "в URL, опасные инструменты агентов. Сценарий атаки — конкретный. Не превращай "
              "задачу в перестройку безопасности целиком.",
     "model": "", "params": {"temperature": 0.1}, "can_block": True,
     "triggers": {"keywords": _SEC_WORDS, "modules": ["security/auth"]}},
    {"key": "qa_tester", "label": "QA / тест-дизайнер", "kind": "reviewer",
     "focus": "Пробелы покрытия: сценарии, граничные случаи, инварианты, регрессии; какие "
              "проверки могут опровергнуть корректность. Добавлены ли тесты и прогнаны ли (с "
              "результатом). Написанный тест ≠ прогнанный.",
     "model": "", "params": {"temperature": 0.25}, "can_block": False,
     "triggers": {"boards": ["bugs"], "keywords": ["test", "тест", "регресс", "падает",
                                                    "crash", "ошибк", "edge"]}},
    {"key": "bug_reproducer", "label": "Воспроизведение бага", "kind": "reviewer",
     "focus": "Для ошибок: условия → минимальные шаги → ожидаемое → фактическое. Найдена ли "
              "первопричина, а не симптом; закрывает ли фикс шаги воспроизведения; нет ли соседних "
              "путей с тем же дефектом. Без запуска — «гипотеза» (evidence_kind=hypothesis), а не "
              "«воспроизведено».",
     "model": "", "params": {"temperature": 0.2}, "can_block": False,
     "triggers": {"boards": ["bugs"]}},
    {"key": "product_reviewer", "label": "Product / UX", "kind": "reviewer",
     "focus": "Решил ли пользователь свою задачу: сценарий целиком, понятны ли последствия "
              "действий, acceptance criteria, desktop/mobile, i18n (defaultValue {{var}}, "
              "перегенерация ru-бандла). Состояния и доступность — детально у UI-аудитора.",
     "model": "", "params": {"temperature": 0.45}, "can_block": False,
     "triggers": {"keywords": ["ui", "ux", "экран", "страниц", "кнопк", "модалк", "вкладк",
                               "i18n", "перевод", "верстк", "дизайн", "mobile", "мобильн"],
                  "modules": ["frontend", "ux", "i18n", "mobile"]}},
    {"key": "performance_reviewer", "label": "Производительность", "kind": "reviewer",
     "focus": "Отличай измеренную деградацию от потенциального риска. N+1, take ≤ 100, индексы "
              "под новые WHERE, кэш и инвалидация, бандл и ленивые импорты, ре-рендеры, штормы "
              "запросов. К риску — нагрузочный сценарий и способ измерения.",
     "model": "", "params": {"temperature": 0.2}, "can_block": False,
     "triggers": {"keywords": ["performance", "медлен", "n+1", "cache", "кэш", "bundle",
                               "оптимиз", "запрос", "шторм", "долго", "таймаут", "timeout"]}},
    {"key": "hr_domain_reviewer", "label": "HR-эксперт", "kind": "reviewer",
     "focus": "HR-логика: смысл сущностей и статусов, переходы этапов и их предусловия, связь "
              "кандидат—вакансия—отклик—оценка—решение, исключения и ручное вмешательство, "
              "история и объяснимость действий, настраиваемые процессы компании. Распространённая "
              "HR-практика ≠ обязательное правило; правило неизвестно — вопрос, не находка.",
     "model": "", "params": {"temperature": 0.3}, "can_block": False,
     "triggers": {"keywords": ["кандидат", "candidate", "ваканс", "vacancy", "отклик", "оффер",
                               "offer", "интервью", "interview", "воронк", "этап подбор", "найм",
                               "рекрут", "ats", "hiring", "онбординг", "onboarding"],
                  "modules": ["recruiting/ats", "huntflow", "hh.ru"]}},
    {"key": "data_integrity_reviewer", "label": "Целостность данных", "kind": "reviewer",
     "focus": "Связи и ограничения сущностей, область действия ID, изоляция данных компаний "
              "(companyId), транзакционность связанных изменений, повтор и дубли, конкурентные "
              "изменения, сохранение исходных и ручных данных, миграции, удаление. Ищи: одна "
              "операция прошла, следующая упала или запущена повторно. Потеря данных — только с "
              "конкретным путём; к риску — проверка состояния до/после.",
     "model": "", "params": {"temperature": 0.2}, "can_block": False,
     "triggers": {"keywords": ["migration", "миграц", "prisma", "schema.prisma", "транзакц",
                               "transaction", "дедупл", "dedup", "дубл", "импорт", "import",
                               "массов", "bulk", "удален", "companyid", "outbox"],
                  "modules": ["db/queues"]}},
    {"key": "contract_integration_reviewer", "label": "Контракты и интеграции", "kind": "reviewer",
     "focus": "Изменённый контракт от производителя до потребителей: backend, frontend, воркер, "
              "очередь, внешний сервис, MCP-инструмент. Обязательность, типы и смысл полей; absent "
              "vs null vs empty; ошибки; версии и обратная совместимость; сериализация; timeout, "
              "retry, повторная доставка. Назови конкретного потребителя, который ломается.",
     "model": "", "params": {"temperature": 0.2}, "can_block": False,
     "triggers": {"keywords": ["dto", "proto", "connect", "контракт", "contract", "webhook",
                               "huntflow", "hh.ru", "rabota.by", "интеграц", "integration",
                               "packages/types", "openapi", "mcp"],
                  "modules": ["huntflow", "hh.ru", "telegram", "extension", "realtime"]}},
    {"key": "ai_behavior_reviewer", "label": "AI-поведение", "kind": "reviewer",
     "focus": "AI-функции: достаточность и происхождение контекста, факт vs интерпретация, "
              "поведение без данных, валидация структурированного вывода, недоверенные инструкции "
              "внутри документов, ограничения инструментов и автономных действий, подтверждение "
              "значимых действий (HITL), отказ/timeout/обрезанный ответ и fallback. Негативный "
              "сценарий + проверяемый ожидаемый результат.",
     "model": "", "params": {"temperature": 0.25}, "can_block": False,
     "triggers": {"keywords": ["промпт", "prompt", "llm", "агент", "agent", "rag", "эмбеддинг",
                               "embedding", "ollama", "glm", "openai", "gemini", "claude",
                               "hitl", "tool call", "модел"],
                  "modules": ["ai-tooling/mcp"]}},
    {"key": "workflow_reliability_reviewer", "label": "Надёжность процессов", "kind": "reviewer",
     "focus": "Жизненный цикл задания: создание, выполнение, ожидание, ошибка, повтор, отмена, "
              "завершение. Дубли побочных действий, зависание без конечного состояния, потеря "
              "работы после перезапуска, частичный успех, рассинхрон UI и исполнения, ручное "
              "восстановление. Для замечания: точка отказа → состояние → последствия повтора.",
     "model": "", "params": {"temperature": 0.2}, "can_block": False,
     "triggers": {"keywords": ["queue", "очеред", "bullmq", "worker", "воркер", "cron", "retry",
                               "повтор", "идемпотент", "idempot", "фонов", "background",
                               "workflow", "оркестр", "таймаут", "отмен"],
                  "modules": ["db/queues", "ops/ci"]}},
    {"key": "ui_accessibility_reviewer", "label": "Интерфейс и доступность", "kind": "reviewer",
     "focus": "Обязательный сценарий: вход → действие → обратная связь → результат → "
              "восстановление после ошибки. Состояния empty/loading/error/success/partial, "
              "клавиатура и фокус, подписи и сообщения, длинный контент и большие списки, "
              "сохранение введённого, подтверждение опасных действий. Без скриншотов — только "
              "статическая проверка; редизайн вне задачи не предлагай.",
     "model": "", "params": {"temperature": 0.3}, "can_block": False,
     "triggers": {"keywords": ["форм", "form", "модалк", "modal", "таблиц", "table", "фокус",
                               "focus", "клавиатур", "keyboard", "a11y", "доступност", "aria",
                               "loading", "empty state", "скелетон"],
                  "modules": ["ux"]}},
    {"key": "cognitive_auditor", "label": "Когнитивный аудитор", "kind": "adversary",
     "focus": "Проверяет выводы ДРУГИХ агентов: выдуманные файлы и строки, неподтверждённые "
              "тесты, потерянные требования, логические противоречия, выдача гипотезы за факт, "
              "«готово» без улик.",
     "model": "", "params": {"temperature": 0.3}, "can_block": False,
     "triggers": {}},
    {"key": "devils_advocate", "label": "Оппонент", "kind": "adversary",
     "focus": "Строит конкретные контрпримеры: повтор события, нестандартный ввод, частичный "
              "отказ, конфликт действий. Снимает замечания без опоры на улики, ищет пропущенные "
              "дефекты. Абстрактных претензий не создаёт, по умолчанию не соглашается.",
     "model": "glm4:latest", "params": {"temperature": 0.4}, "can_block": False,
     "triggers": {}},
    {"key": "judge", "label": "Судья", "kind": "judge",
     "focus": "Разрешает конфликты по доказательствам, убирает дубли, формирует решение и "
              "перечень обязательных исправлений. Новых претензий без улик не придумывает; "
              "невыполненную проверку успешной не объявляет; особое мнение сохраняет.",
     "model": "", "params": {"temperature": 0.15}, "can_block": False,
     "triggers": {}},
]

# Хэши прежних стандартных спецификаций встроенных агентов (sha256[:16] канонического JSON
# после validate_agent). Засев обновляет строку агента до нового стандарта, ТОЛЬКО если она
# совпадает с одним из прежних стандартов, — то есть владелец её не правил. Правленую строку
# засев не трогает (её возвращает к стандарту только явный «Сбросить встроенных»). При
# каждом изменении BUILTIN_AGENTS сюда добавляется хэш уходящей версии.
PREVIOUS_DEFAULT_HASHES: dict[str, set[str]] = {
    "code_reviewer": {"96943f3e206cca11"},
    "dod_auditor": {"be60b800ff1812ca"},
    "architecture_reviewer": {"7e47bf2405eaa2de"},
    "security_reviewer": {"ef116c892309bd9c"},
    "qa_tester": {"a432bba832191b28"},
    "bug_reproducer": {"3388b1e04cf6e38f"},
    "product_reviewer": {"34cc3e20d844f8bd"},
    "performance_reviewer": {"eebf41ee0e8c9494"},
    "cognitive_auditor": {"a45e40a8a4e5e23b"},
    "devils_advocate": {"4199f2fd3042d55e"},
    "judge": {"20b38c28c3d37b73"},
}


def spec_hash(spec: dict) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


# Ревью читает дифф — 8192 общего окна (досье ≈ 3.8k) мало. 10k входа + 2.5k выхода ≈
# num_ctx 13.9k: одна перезагрузка модели на прогон (окно общее для всех агентов профиля),
# KV-кэш 7B/MoE-моделей на этом окне укладывается в бюджет 24 GB.
DEFAULT_TOKENS = {"input_mode": "limit", "input_limit": 10000,
                  "output_mode": "limit", "output_limit": 2500, "compress": True}
# major_needs_human: большинство за accept, а неснятая major-находка (в т.ч. найденная
# оппонентом) висит — это не «принято», а вопрос человеку. Замер 2026-10-04: 4/4 accept
# при major «не реализовано для списка диалогов» от оппонента давали ACCEPT 1.00.
# evidence_gate (§17.5): FAIL дают только находки с опорой в диффе (patch|file), посчитанной
# кодом, и подтверждённые не автором; без опоры — NEEDS_HUMAN, никогда не ACCEPT.
DEFAULT_VERDICT = {"blocking": True, "reject_on_critical": True, "major_needs_human": True,
                   "evidence_gate": True, "accept_threshold": 0.66,
                   "fail_threshold": 0.5, "allow_inconclusive": True, "judge_tiebreak": True,
                   "min_confidence": 0.5}
DEFAULT_CONTEXT = {"use_rag": True, "use_git": True, "include_comments": True,
                   "include_council_block": True}

# Переписка агентов (§17.5). ask — сколько вопросов коллегам за прогон (0 = выключено:
# в парном ревью единственный адресат — тот же проверяющий, что стадией позже и так читает
# вывод, вопрос дублирует его за лишний вызов). cross_check — потолок встречных проверок
# решающих находок; вызов тратится только если такая находка есть и её не подтвердил уже
# кто-то кроме автора. outside_roster — можно спросить специалиста вне состава (он
# отвечает на модели спрашивающего: без свопа L-моделей и без лишней памяти).
DEFAULT_CONSULT = {"ask": 0, "cross_check": 3, "outside_roster": True}
CONSULT_LIMITS = {"ask": 4, "cross_check": 6}

DEFAULT_PROFILES: list[dict] = [
    {"name": "Быстрое ревью (локально)", "is_default": True, "spec": {
        "description": "Парное ревью на S-моделях: минуты на карточку. Для разбора завала.",
        "method": "PAIR", "participant_mode": "MANUAL",
        "agents": ["code_reviewer", "dod_auditor"], "judge": "judge",
        "default_model": "qwen2.5:7b", "judge_model": "glm4:latest", "max_agents": 2}},
    {"name": "Баг — строгое", "is_default": False, "spec": {
        "description": "Адверсариальное: воспроизведение + QA + code review, оппонент атакует.",
        "method": "ADVERSARIAL", "participant_mode": "HYBRID",
        "agents": ["bug_reproducer", "code_reviewer"], "judge": "judge",
        "adversary": "devils_advocate", "max_agents": 4,
        "default_model": "qwen2.5:7b", "judge_model": "glm4:latest"}},
    {"name": "Автоподбор по задаче", "is_default": False, "spec": {
        "description": "Состав подбирается по сигналам карточки; причины видны в прогоне.",
        "method": "ADVERSARIAL", "participant_mode": "AUTO", "auto_strategy": "rules",
        "agents": [], "judge": "judge", "adversary": "devils_advocate", "max_agents": 4,
        "default_model": "qwen2.5:7b", "judge_model": "glm4:latest"}},
    {"name": "Security + архитектура (блокирующее)", "is_default": False, "spec": {
        "description": "Вето security-ревьюера; для auth/PII/миграций/интеграций.",
        "method": "BLOCKING", "participant_mode": "MANUAL",
        "agents": ["security_reviewer", "architecture_reviewer", "code_reviewer"],
        "judge": "judge", "max_agents": 3,
        "default_model": "glm4:latest", "judge_model": "qwen2.5:7b"}},
    {"name": "Высокий риск — команда с перепиской", "is_default": False, "spec": {
        "description": "Профильные специалисты по сигналам карточки + вопросы друг другу → "
                       "оппонент → когнитивный аудит выводов → встречная проверка → судья.",
        "method": "COMBINED", "participant_mode": "HYBRID", "auto_strategy": "rules",
        "agents": ["code_reviewer", "dod_auditor"], "judge": "judge",
        "adversary": "devils_advocate", "max_agents": 5,
        "consult": {"ask": 2, "cross_check": 3, "outside_roster": True},
        "stages": [{"type": "independent"}, {"type": "consult"}, {"type": "challenge"},
                   {"type": "challenge", "flavor": "cognitive", "agents": ["cognitive_auditor"]},
                   {"type": "crosscheck"}, {"type": "judge"}],
        "default_model": "", "judge_model": ""}},
]
# Имена профилей, засеянных хоть раз (реестр — в review_settings, ключ SEEDED_KEY): удалённый
# или переименованный владельцем профиль засев не возвращает.
SEEDED_KEY = "_seeded_profiles"

# Безопасные дефолты досок: перевод выключен, при включении — с подтверждением человека.
DEFAULT_BOARDS = {
    "bugs": {"enabled": True, "review_status": "на ревью", "profile_id": "", "auto_run": False,
             "allow_transition": False, "require_human_approval": True,
             "on_accept": "закрыто", "on_fail": "в работе", "on_inconclusive": "",
             "on_needs_human": "", "post_comment": True},
    "tasks": {"enabled": True, "review_status": "на ревью", "profile_id": "", "auto_run": False,
              "allow_transition": False, "require_human_approval": True,
              "on_accept": "выполненные", "on_fail": "в работе", "on_inconclusive": "",
              "on_needs_human": "", "post_comment": True},
}
# Статусы для политики доски: slug колонок t-boards и имена колонок, перенесённых из Notion (rules/17
# «Пайплайн завершения»). Колонку ревью карточки сверяет sources.tboards.review_slugs, а не эти имена.
TBOARDS_SLUGS = ["new", "grilling", "to-do", "in-progress", "in-review", "confirmation", "done", "closed"]
KNOWN_STATUSES = {
    "tasks": ["задача от пользователя", "прожаренные явные задачи", "в работе", "на ревью",
              "выполненные", "завершённые"] + TBOARDS_SLUGS,
    "bugs": ["открыто", "в работе", "на ревью", "закрыто"] + TBOARDS_SLUGS,
}

DEFAULT_SETTINGS = {
    "default_model": "qwen2.5:7b",     # если ни агент, ни профиль модель не задали
    "judge_model": "glm4:latest",
    "max_num_ctx": 32768,              # потолок «до максимума модели»: 24 GB, L-модель + KV-кэш
    "max_wall_seconds": 2400,          # бюджет одного прогона ревью
    "priority_over_elaboration": True,  # воркер берёт ревью раньше проработок
    "worker_enabled": True,
}

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")


class ValidationError(ValueError):
    pass


def clean_params(raw: dict | None) -> dict:
    """Белый список и приведение типов. Пустые значения = «наследовать» — выкидываются."""
    out: dict = {}
    for name, value in (raw or {}).items():
        spec = PARAM_SPEC.get(name)
        if spec is None or value is None or value == "":
            continue
        kind = spec["type"]
        try:
            if kind == "float":
                value = float(value)
            elif kind == "int":
                value = int(value)
            elif kind == "bool":
                value = value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes", "да")
            elif kind == "list":
                value = [str(v) for v in (value if isinstance(value, list) else str(value).split("|")) if str(v)]
                if not value:
                    continue
            else:
                value = str(value)[:40]
        except (TypeError, ValueError) as exc:
            raise ValidationError(f"параметр {name}: {exc}") from exc
        if kind in ("float", "int"):
            lo, hi = spec.get("min"), spec.get("max")
            if (lo is not None and value < lo) or (hi is not None and value > hi):
                raise ValidationError(f"параметр {name}={value} вне [{lo}, {hi}]")
        out[name] = value
    return out


def validate_agent(key: str, spec: dict) -> dict:
    if not _KEY_RE.match(key or ""):
        raise ValidationError("ключ агента: латиница/цифры/_, 2–41 символ, с буквы")
    kind = spec.get("kind") or "reviewer"
    if kind not in AGENT_KINDS:
        raise ValidationError(f"kind: одно из {AGENT_KINDS}")
    label = str(spec.get("label") or "").strip()
    if not label:
        raise ValidationError("у агента должно быть название")
    trig = spec.get("triggers") or {}
    cap = str(spec.get("max_severity") or "")
    if cap and cap not in SEVERITIES:
        raise ValidationError(f"max_severity: одно из {SEVERITIES}")
    out_cap = {"max_severity": cap} if cap else {}
    if spec.get("audits_evidence"):
        # Роль проверяет доказательства, а не код: её находки — пробелы DoD (нет коммита,
        # нет результата проверки). Без опровержения они возвращают карточку в работу
        # (FAIL insufficient_evidence), а не требуют опоры в диффе (§17.5).
        out_cap["audits_evidence"] = True
    return {
        **out_cap,
        "label": label[:80], "kind": kind,
        "focus": str(spec.get("focus") or "").strip()[:2000],
        "model": str(spec.get("model") or "").strip()[:120],
        "params": clean_params(spec.get("params")),
        "can_block": bool(spec.get("can_block")),
        "enabled": spec.get("enabled", True) is not False,
        "triggers": {
            "always": bool(trig.get("always")),
            "boards": [b for b in (trig.get("boards") or []) if b in BOARDS],
            "keywords": [str(k).lower()[:40] for k in (trig.get("keywords") or []) if str(k).strip()][:60],
            "modules": [str(m)[:40] for m in (trig.get("modules") or []) if str(m).strip()][:20],
        },
    }


def validate_profile(spec: dict, agent_keys: set[str]) -> dict:
    method = spec.get("method") or "ADVERSARIAL"
    if method not in METHODS:
        raise ValidationError(f"метод: одно из {', '.join(METHODS)}")
    mode = spec.get("participant_mode") or "MANUAL"
    if mode not in PARTICIPANT_MODES:
        raise ValidationError(f"participant_mode: одно из {PARTICIPANT_MODES}")
    agents = [a for a in (spec.get("agents") or []) if a in agent_keys]
    unknown = [a for a in (spec.get("agents") or []) if a not in agent_keys]
    if unknown:
        raise ValidationError(f"неизвестные агенты: {', '.join(unknown)}")
    if mode == "MANUAL" and not agents:
        raise ValidationError("ручной состав: выберите хотя бы одного агента")
    stages = spec.get("stages") or []
    for st in stages:
        if st.get("type") not in STAGE_TYPES:
            raise ValidationError(f"тип стадии: одно из {STAGE_TYPES}")
        if st.get("flavor", "") not in FLAVORS:
            raise ValidationError(f"оттенок стадии: одно из {FLAVORS}")
        bad = [a for a in (st.get("agents") or []) if a not in agent_keys]
        if bad:
            raise ValidationError(f"стадия {st['type']}: неизвестные агенты {bad}")
    tokens = {**DEFAULT_TOKENS, **(spec.get("tokens") or {})}
    if tokens["input_mode"] not in ("inherit", "limit", "max"):
        raise ValidationError("tokens.input_mode: inherit | limit | max")
    if tokens["output_mode"] not in ("inherit", "limit", "unlimited"):
        raise ValidationError("tokens.output_mode: inherit | limit | unlimited")
    tokens["input_limit"] = max(2048, min(int(tokens.get("input_limit") or 16384), 262144))
    tokens["output_limit"] = max(256, min(int(tokens.get("output_limit") or 3000), 65536))
    tokens["compress"] = bool(tokens.get("compress", True))
    verdict = {**DEFAULT_VERDICT, **(spec.get("verdict") or {})}
    for k in ("accept_threshold", "fail_threshold", "min_confidence"):
        verdict[k] = max(0.0, min(float(verdict[k]), 1.0))
    for k in ("blocking", "reject_on_critical", "major_needs_human", "allow_inconclusive",
              "judge_tiebreak", "evidence_gate"):
        verdict[k] = bool(verdict[k])
    overrides = {}
    for key, ov in (spec.get("overrides") or {}).items():
        if key not in agent_keys:
            continue
        clean = {"model": str((ov or {}).get("model") or "").strip()[:120],
                 "params": clean_params((ov or {}).get("params"))}
        if "can_block" in (ov or {}):
            clean["can_block"] = bool(ov["can_block"])
        if clean["model"] or clean["params"] or "can_block" in clean:
            overrides[key] = clean
    judge = spec.get("judge") or ""
    adversary = spec.get("adversary") or ""
    for name, value in (("judge", judge), ("adversary", adversary)):
        if value and value not in agent_keys:
            raise ValidationError(f"{name}: неизвестный агент {value}")
    rubric = [str(r).strip()[:200] for r in (spec.get("rubric") or []) if str(r).strip()][:12]
    consult = consult_spec(spec)
    return {
        "description": str(spec.get("description") or "")[:500],
        "method": method, "participant_mode": mode,
        "auto_strategy": spec.get("auto_strategy") if spec.get("auto_strategy") in AUTO_STRATEGIES else "rules",
        "agents": agents, "judge": judge, "adversary": adversary,
        "max_agents": max(1, min(int(spec.get("max_agents") or 4), 8)),
        "default_model": str(spec.get("default_model") or "").strip()[:120],
        "judge_model": str(spec.get("judge_model") or "").strip()[:120],
        "stages": [{"type": s["type"], "flavor": s.get("flavor", ""),
                    "agents": list(s.get("agents") or [])} for s in stages],
        "rubric": rubric or list(DEFAULT_RUBRIC),
        "tokens": tokens, "verdict": verdict, "overrides": overrides, "consult": consult,
        "context": {**DEFAULT_CONTEXT, **{k: bool(v) for k, v in (spec.get("context") or {}).items()
                                          if k in DEFAULT_CONTEXT}},
        "note": str(spec.get("note") or "")[:2000],
    }


def validate_board(board: str, spec: dict, statuses: list[str] | None = None) -> dict:
    if board not in BOARDS:
        raise ValidationError(f"доска: одно из {BOARDS}")
    base = {**DEFAULT_BOARDS[board], **(spec or {})}
    known = set(statuses or KNOWN_STATUSES[board])
    review_status = str(base.get("review_status") or "").strip()
    if review_status not in known:
        raise ValidationError(f"статус ревью «{review_status}» не найден на доске")
    out = {"enabled": bool(base.get("enabled")), "review_status": review_status,
           "profile_id": str(base.get("profile_id") or ""),
           "auto_run": bool(base.get("auto_run")),
           "allow_transition": bool(base.get("allow_transition")),
           "require_human_approval": bool(base.get("require_human_approval", True)),
           "post_comment": bool(base.get("post_comment", True))}
    for key in ("on_accept", "on_fail", "on_inconclusive", "on_needs_human"):
        target = str(base.get(key) or "").strip()
        if target and target not in known:
            raise ValidationError(f"{key}: статуса «{target}» нет на доске")
        if target and target == review_status:
            raise ValidationError(f"{key}: переход в тот же статус «{target}» бессмыслен")
        out[key] = target
    return out


def consult_spec(spec: dict) -> dict:
    """Настройки переписки; профиль, сохранённый до §17.5, ключа не имеет — берутся
    дефолты (встречная проверка вкл., вопросы выкл.)."""
    raw = {**DEFAULT_CONSULT, **(spec.get("consult") or {})}
    out = {"outside_roster": bool(raw.get("outside_roster", True))}
    for key, hi in CONSULT_LIMITS.items():
        try:
            out[key] = max(0, min(int(raw.get(key) or 0), hi))
        except (TypeError, ValueError) as exc:
            raise ValidationError(f"consult.{key}: целое 0–{hi}") from exc
    return out


def method_stages(profile: dict) -> list[dict]:
    """Стадии метода. Переписка вставляется кодом: вопросы — после первой голосующей
    стадии (только в стандартных списках — свой список владельца не меняем), встречная
    проверка — перед судьёй всегда, если включена и её нет в списке явно."""
    method = METHODS[profile["method"]]
    custom = bool(method.get("custom") and profile.get("stages"))
    stages = [dict(s) for s in (profile["stages"] if custom else method["stages"])]
    consult = consult_spec(profile)
    if consult["ask"] and not custom and not any(s["type"] == "consult" for s in stages):
        first = next((i for i, s in enumerate(stages) if s["type"] in VOTING_STAGES), None)
        if first is not None:
            stages.insert(first + 1, {"type": "consult"})
    if not any(s["type"] == "judge" for s in stages):
        stages.append({"type": "judge"})
    if consult["cross_check"] and not any(s["type"] == "crosscheck" for s in stages):
        at = next(i for i, s in enumerate(stages) if s["type"] == "judge")
        stages.insert(at, {"type": "crosscheck"})
    return stages
