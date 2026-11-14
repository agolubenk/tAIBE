# boards/docs — карта документов tAI-Boards

Внутренняя замена Notion для ИИ-агентов («фабрика для ИИ», control plane задач). Код — родительская папка
`boards/` (форк Kaneo). Спека — `t-boards-spec.md` (версия — в её шапке); при расхождении архитектуры со спекой действует спека.

> Перенесено из подпроекта-инкубатора `t-boards/` (там код жил в `t-boards/app`, локально). Соответствие путей:
> `t-boards/<doc>` → `boards/docs/<doc>` · `t-boards/app/<path>` → `boards/<path>` · `t-boards/tools/` → `boards/tools/` ·
> `supertick-eval/<path>` → `eval/<path>`. Таблица целиком — [`process/TRANSFER.md`](../../process/TRANSFER.md).

## Живые документы

| Файл | Что |
|---|---|
| `t-boards-spec.md` | спека: правила R-…, запреты N-…, приёмка AC-…, вопросы Q-…, решения D-… |
| `architecture-overview2.0.md` | архитектурный контракт ContextFlow (шесть контрактов); при расхождении со спекой действует спека |
| `pipeline-settings.md` | переключатели автоматики процесса в настройках продукта: что выключает каждый и где это соблюдается (R-110) |
| `impl-progress.md` | ход реализации: что сделано, коммиты, проверки, стенд |
| `impl-remaining.md` | что осталось до перехода, решения владельца, субдомен |
| `kimi-tasks.md` | задачи для Kimi: волна 1 закрыта; K-6 сделала команда 01.11 (`impl/impl-k6-measurements.md`), K-7 не сделан (там же, «Ограничения замера»; сверка 14.11) |

Линза Kimi на архитектуру 2.0 и сверка спеки — `../../eval/t-boards/`.

## Папки

- `impl/` — детали сделанных шагов (`impl-s*`, `impl-r*`, `impl-b*`, `impl-ui`); на них ссылаются `impl-progress.md`
  и `impl-remaining.md`.
- `migration/` — перенос TB-120 Notion → доски по продуктам: разбивка по проектам, виды и оформление, перманентные
  задачи, чек-лист недостающего (`tb120-*.md`, решения владельца 30.10).
- `archive/` — заменённое и отменённое: ранние черновики архитектуры 26.10 (`architecture-overview.md` v1,
  `evolutionary-task-management.md`, `async-dialog-processing.md`, `context-management-strategy.md`,
  `intelligent-queue-system.md`, `protocol-compatibility.md` — заменены `architecture-overview2.0.md`, спека §19),
  отменённый `handoff-2026-10-28.md` (актуальный — `../../eval/HANDOFF-2026-10-28.md`), исходник спеки
  `t-boards-grill-answers.json` и наброски Kimi по K-4/K-5 (`kimi-partial-k4-k5/`; код вошёл в
  `packages/importers/src/notion/` и `packages/claude-mem-reader/`). Архив исключён из `vp check`.
- `kimi-reports/` — отчёты Kimi (K-1…K-3).
- Пробы стенда и прогон интеграционных тестов — `../tools/` (`run-int.sh`, `mcp-probe*.mjs`, `history-probe.mjs`,
  `mcp-wire-measure.mjs`, `tool-scope-probe.mjs`; нужен поднятый API `:1337` и собранный `packages/agent-format`).

## Словарь идентификаторов

| Префикс | Что | Где живёт |
|---|---|---|
| `R-…`, `N-…`, `AC-…`, `Q-…`, `D-…` | правило, запрет, критерий приёмки, вопрос, решение спеки | `t-boards-spec.md` |
| `TB-…`, `SE-…`, `OPS-…`, `IDEA-…`, `GL-…` | карточки досок продукта (доски, пайплайн, эксплуатация, идеи, цели) | доски tAI-Boards; в старых файлах `impl-tb119-…` — ключ плана, а не номер карточки |
| `K-…` | задачи, когда-то отданные Kimi (теперь делает Claude) | `kimi-tasks.md` |
| `П1…П11`, `Ф0…Ф3` | механизмы и фазы пайплайна | `../../eval/pipeline/PIPELINE.md`, `R4-PLAN-2026-10-30.md` |
| `d-…`, `m-…`, `s-…`, `c-…`, `i-…` | пункты очереди владельца: решение, мёрж, команда на сервере, ручная проверка, входящее | очередь (MCP `oq_*`), `../../docs/specs/owner-queue.md` |
| `b7`, `b12`, … | бандлы (выкатки) стенда | `impl-remaining.md`, `deploy/vps/README.md` |

## Где что искать

- «Делали ли уже X» — `impl-progress.md`, затем `impl/`, затем `../../docs/plans/done/`.
- «Что осталось / что ждёт владельца» — `impl-remaining.md`, очередь владельца (MCP `oq_*`, `../../infra/owner-queue-mcp/`).
- Передача между сессиями — `../../eval/HANDOFF-2026-10-28.md` и капсулы `../../eval/pipeline/capsules/`.
