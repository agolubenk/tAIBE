# infra/ — роль: инженер ИИ-контура и контроля (DevOps слоя)

**Роль:** владелец сервисов, на которых держится процесс команды ИИ-сессий: консилиум-ревьюер, очередь владельца,
MCP-хаб, шлюз моделей, сжатие контекста, ops-консоль. Бизнес-логики досок здесь нет (она в `boards/`), измерений и
демонов пайплайна — тоже (они в `eval/`). Сервисы самостоятельны: свой рантайм, свои тесты, общий только слой
`.claude/`.

| Папка | Что | Рантайм · гейт |
|---|---|---|
| `ai-council/` | ИИ-консилиум: линзы моделей (Ollama/GLM/OpenRouter) над карточками и PR, дневной план, ревью «на ревью», обучение калибровки, MCP `council_*`. Роль — `ai-council/CLAUDE.md`, спека — `docs/specs/ai-council.md` | python stdlib (+ `mcp<2` для stdio-сервера) · `cd infra/ai-council && python3 selftest.py` |
| `owner-queue-mcp/` | MCP `oq_*` — очередь владельца для агентов (решения, мёржи, команды на сервере, ручные проверки, входящие) | node ≥ 20, без зависимостей · `node --test infra/owner-queue-mcp/test/*.test.mjs` |
| `owner-queue-bot/` | Telegram-бот очереди владельца: пункты, ответы, входящие из Telegram, графики | node, без зависимостей · `cd infra/owner-queue-bot && node --test test/*.test.mjs` |
| `ops-console/` | Ops-консоль: страница `/queue`, мониторинг, алерты, перезапуски, отчёты консилиуму. Роль — `ops-console/CLAUDE.md` | свой `package-lock.json` · `npm ci && npm run typecheck && npm test` |
| `mcp-hub/` | Общий MCP-хаб (1mcp, `:3050`) для всех ИИ-клиентов: Serena, DAMS-RAG, консилиум, headroom, доски через туннель | bash + node · `npm run mcp-hub:status` |
| `llm-gateway/` | OpenAI-совместимый шлюз `:8789` — ротация ключей и моделей OpenRouter / GLM Z.AI / Ollama для Continue, роя и консилиума | node, без зависимостей · `npm run llm-gateway:test` |
| `headroom/` | Сжатие контекста на входе/handoff задачи (`headroom_compress`/`headroom_retrieve`), проверка контракта | python · `runtime/contract_check.py` |
| `scripts/dev-ai/` | Запуск и обслуживание контура: хаб, секреты (`mcp-secret.sh`: env → Keychain), MCP досок (`mcp-t-boards.sh`), Ollama, Open WebUI | bash (macOS — хозяйская машина) |
| `scripts/split/` | Разделение HR / tAIBE на Mac владельца: шаги `1-preflight` … `6-verify`, `rollback`, снимок и перенос коммитов вложенных репозиториев. Инструкция — `docs/ops/split-hr-taibe.md` | bash 3.2 · `shellcheck -x` |
| `scripts/dev/wt-deps.sh` | Свои зависимости git worktree (pnpm досок / npm хоста) — для `make wt-*` и хука `PreToolUse` | bash |
| `checks/` | Детерминированные проверки репозитория без модели: секреты, гигиена, полнота данных (планы, журнал решений, журнал миграций drizzle), синтаксис; аудит зависимостей храповиком. Описание — `checks/README.md` | python stdlib · `make check-repo`, CI `checks-ci.yml` |
| `scripts/misc/done-index.py` | Таблица модулей `docs/plans/DONE.md` и проверка формата журнала закрытого | python stdlib |
| `scripts/prod/ops-deploy-event.py` | Событие деплоя → карточка «Деплои» ops-консоли (подпись агента хоста) | python stdlib |

Команды — корневой `package.json` (`npm run mcp-hub:*`, `llm-gateway:*`, `ai-council:*`, `ai-pipeline:*`, `done:index`)
и `Makefile` (`make check-infra`). CI — `.github/workflows/infra-ci.yml`.

## Логика решений

- **Сервис контроля не ломает поставку.** Очередь, консилиум и хаб — совещательные: их отказ не блокирует PR и
  мёрж, а молча не теряет пункт владельца (идемпотентность `ifVersion`, повтор — 409, а не дубль).
- **Секреты — только по цепочке env → Keychain** (`scripts/dev-ai/mcp-secret.sh`, service `hr-helper-mcp`); в git —
  только `*.env.example`. MCP- и API-ключи наружу — хэшем, ключ показывается один раз.
- **Локальные модели — строго последовательно** (лок `ollama.local_inference_slot`), облачные полосы — по квоте
  5-часового окна, а не по числу потоков.
- **Инстанс-зависимое — в конфиге, не в коде:** адрес очереди и роли — `eval/nerve/config.json`, модели и источники
  консилиума — `ai-council/config.toml`, домены и туннель досок — `scripts/dev-ai/mcp-t-boards.sh` (`T_BOARDS_URL`).
- **Рантайм-состояние не коммитится:** `.claude/council/` (SQLite консилиума), `llm-gateway/.state/`,
  `ops-console/data/`, `*.db`, `.env`.

## Адверсариальная проверка — ≥ 3 участника (обязательно)

x ≥ 3 независимых участника; базовые линзы, x по риску и формат результата — `.claude/memory/chunks/process/adversarial-review.md`. Линзы роли:

1. **Отказ и откат** — что при падении сервиса: работа команды продолжается, пункт владельца не теряется.
2. **Стоимость** — токены и квоты моделей, RAM машины владельца (Serena ~2 ГБ на копию), бесплатные тарифы хостинга.
3. **Безопасность** — секреты, открытые порты (только `127.0.0.1` или туннель), подписи вебхуков и агентов.

**Связи:** ↓ `ai-council/CLAUDE.md` · `ops-console/CLAUDE.md` · ↔ `eval/nerve/` (источник `queue`) · `boards/` (MCP досок) · знания — `docs/specs/`, `docs/ops/`, `docs/ai/`
