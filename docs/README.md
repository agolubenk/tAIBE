# Документация tAIBE — карта по ролям

Сквозная документация продукта: процесс команды, контроль, ИИ-инструменты разработки. Документация самих частей —
рядом с кодом: доски — [`../boards/docs/`](../boards/docs/README.md), пайплайн — [`../eval/README.md`](../eval/README.md),
слой — [`../process/README.md`](../process/README.md). Стандарт документа и «куда что класть» — [`CLAUDE.md`](CLAUDE.md).

| Роль | Папка | Канон здесь |
|---|---|---|
| Продуктовый аналитик | [`specs/`](specs/) | `owner-queue.md` (очередь владельца), `ai-council.md` (ИИ-консилиум); спека досок — `boards/docs/t-boards-spec.md` |
| Планировщик · менеджер | [`plans/`](plans/README.md) | `DONE.md` + `done/` (закрытое по модулям), `evolution-ideas.md` (идеи и вопросы развития), `notion-board.md` (архив связки с Notion) |
| DevOps / SRE | [`ops/`](ops/) | `owner-queue-cutover.md` — переезд очереди владельца в ops-консоль; `split-hr-taibe.md` — разделение HR и tAIBE на машине владельца (инструкция исполнителю) |
| AI/ML-инженер | [`ai/`](ai/README.md) | Локальные модели (Ollama), дрейф консилиума, TOON-формат |
| Техписатель · все роли | [`guides/`](guides/README.md) | Описания и инструкции: развёртывание слоя, worktrees, ИИ-контур, доски, Нерв |
| Архитектор · аналитик | [`integrations/`](integrations/README.md) | Аналитика встраивания внешних решений: единый реестр с вариантами и предложениями + разбор каждого инструмента в своей папке |
| Технический писатель | этот файл + [`CLAUDE.md`](CLAUDE.md) | Структура `docs/`, стандарт документа, гигиена ссылок |

## Вне `docs/`

| Что | Где |
|---|---|
| Открытые задачи и баги | доски tAI-Boards «Задачи» / «Ошибки» — хард-стопы `.claude/rules/17-notion-board.md`; Notion — архив только для чтения |
| Законы для агента (Never/Always) | `.claude/rules/` — `paths:` в frontmatter грузит правило по месту работы |
| Роли по коду | `CLAUDE.md` в `boards/`, `infra/`, `infra/ai-council/`, `infra/ops-console/`, `process/model/` |
| Память агента (DAMS: чанки, RAG-индекс) | [`.claude/README.md`](../.claude/README.md) |
| Откуда что перенесено | [`process/TRANSFER.md`](../process/TRANSFER.md) |

## Поиск по документации

```bash
python3 .claude/scripts/rag_query.py "<запрос>" --type spec --full
python3 .claude/scripts/rag_query.py "<тема>" --type done_entry --full    # «делали ли уже»
python3 .claude/scripts/docs_linkcheck.py                                # висячие ссылки
```
