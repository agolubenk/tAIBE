# S5, K-4, K-5 и переоткрытие — импорт Notion, память карточки, «да» на возврат в работу

Обновлено: 2026-10-28 15:47. Код — в локальных коммитах `boards`: `63bc00d` (K-4, S5, K-5) и `3eacffa` (переоткрытие). Не
пушится.

## K-4 — импортёр Notion (`packages/importers/src/notion`)

| Файл | Что делает |
|---|---|
| `client.ts`, `api-types.ts` | Чтение API Notion: база, страницы, тело |
| `source.ts` | База Notion → `ImportedProject`: колонки из Status, задачи, метки |
| `mapping.ts` | Свойства страницы → поля карточки и `extraFields`: Status, Priority/Severity, Backlog ID, Half-baked idea, Type |
| `body.ts` | Блоки страницы → markdown описания |
| `idempotency.ts` | Ключ задачи `hr:notion:<pageId>` |
| `reconcile.ts` | Сверка количества: Notion против доски (AC-002) |

Тесты: `mapping`, `source`, `reconcile`. Реальный Notion из тестов не вызывается — только синтетика.

## S5 — запись импорта как зеркала (`apps/api/src/import/notion-mirror`)

- Повторный импорт той же базы не создаёт копию, а обновляет проект. План — `plan-notion-sync.ts`:
  - новые страницы создаются;
  - страницы с более новым `last_edited_time` переписываются;
  - остальные пропускаются.
- Поля агента в `card_meta` (исполнитель, ветка, PR и т. д.) переживают повторный импорт.
- Зеркальные поля Notion пишутся в `card_meta`: kind, backlogId, notionStatus, `notion_edited_at`.
- Номера: свободный номер из Notion сохраняется, занятый — продолжает после последнего (`numberFreshTasks`).
- Страницы, которые уже зеркалит другой workspace, — отказ.
- Backlog ID, который уже занят картой вне импорта, — карточка остаётся без него, с предупреждением.
- История карточки (R-023) пишет правку зеркала как `meta` и `task`.
- Миграция `0071_t_boards_notion_edited_at.sql`: `ALTER TABLE "card_meta" ADD COLUMN "notion_edited_at" timestamp;`.
- Web: в диалоге импорта ID баз берутся из ссылок Notion (`notion-database-ids.ts`).

Тесты: unit `plan-notion-sync`, `notion-card-meta`, `position-allocator`; интеграция
`tests/api-integration/notion-mirror.test.ts` (3 теста). Полный интеграционный набор после S5 — 1655 из 1655, pass.

### Ограничения S5 — что не делает

1. Метки и связи уже существующих карточек при повторном импорте не пересинхронизируются, только у новых.
2. Удалённые в Notion страницы на доске остаются; их показывает только сверка `reconcile`.
3. Карточка, которую передвинули на доске, сохраняет своё место; колонка меняется только при правке статуса в Notion.
4. Два одновременных импорта одной базы могут упасть с `SAVE_FAILED` — повторный запуск проходит.
5. Ежедневной сверки по расписанию (AC-002, AC-003) пока нет — только по запуску импорта.

## K-5 — память карточки из claude-mem

- `packages/claude-mem-reader`: только чтение HTTP API воркера claude-mem, `127.0.0.1:3777` по умолчанию.
  - Порт и хост берутся из `CLAUDE_MEM_WORKER_PORT/HOST` или настроек claude-mem.
  - Файл `~/.claude-mem/claude-mem.db` не открывается; в claude-mem ничего не пишется (R-040, N-001).
  - Есть кэш и привязка `bind.ts`.
- Привязка с 13.11 (TB-113, `apps/api/src/forest/memory/card-memory-keys.ts`) — точные ключи карточки, до 6:
  - id;
  - номер `<SLUG>-<number>`;
  - Backlog ID;
  - пункты очереди её запросов «да», новые первыми.
  - Ветка больше не ключ: «main» называет тысячи чужих наблюдений. Ключ вне трёх форм (кириллица, «B-6») не ищется.
- Поиск — маршрут прокси на Mac `GET /api/card-memory` прямо по `claude-mem.db`, только чтение (исключение R-040,
  `deploy/vps/README.md`, «Card memory route»). Прежний просмотр окна 200 последних наблюдений через воркер снят.
- API: `GET /api/forest/{workspaceId}/cards/{taskId}/memory` и `GET /api/forest/{workspaceId}/memory?ticketKey=|queueItemId=`
  (`memory-routes.ts`). Пункт очереди ищется, только если пространство связано с очередью и пункт существует.
  Кэш: минута свежий, до 24 часов «копия» (`find-card-memory.ts`). `CLAUDE_MEM_PROJECT` больше не читается.
- Web: раздел «Память» в боковой панели карточки (`card-memory.tsx`, `use-card-memory.ts`).
- Живая проба 28.10: из 200 просмотренных наблюдений 3 привязались к PRB-1.
- MCP-инструмент для агентов — `forest_get_card_memory` (29.10, `impl-r037-work-state.md`).

## Переоткрытие закрытой карточки агентом (d-tb-reopen)

Владелец 28.10 07:33: «Только с «да», как закрытие».

- Новое действие согласования `reopen_task`. Оно нужно, когда текущий статус закрывает карточку (финальная колонка или
  архив), а новый — нет.
- Как у `close_task`:
  - согласование привязано к целевому статусу;
  - тратится один раз, живёт 24 ч;
  - при неудачной записи возвращается.
- Переоткрытие вместе со сменой приоритета — отказ: два согласования по очереди.
- `POST /approvals` с `reopen_task` отвечает 400, если карточка уже открыта или целевой статус тоже закрывает её.
- Файлы:
  - `decide-task-write.ts` (факт `reopens`), `task-guard.ts`;
  - `approval-params.ts`, `task-approval-target.ts`, `task-scope.ts` (отдаёт статус);
  - описание в `routes/schema.ts` и `openapi.json`;
  - MCP `write-tools.ts`, `agent-write.ts`;
  - web `approval-summary.tsx`, i18n `forest.approvals.action.reopenTask`.
- Проверки 28.10 15:46:
  - unit `agent-guard` и `approval` — 20 из 20;
  - интеграция `forest-agent-rights` и `forest-approval-list` — 12 из 12;
  - `packages/mcp` — 104 из 104;
  - typecheck api, web, mcp — pass;
  - `vp check` по всему репозиторию (pre-commit) — pass.
