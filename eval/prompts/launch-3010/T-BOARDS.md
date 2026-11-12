# t-boards для агентов — как заполнять и как работать (30.10)

t-boards — наш форк kaneo: доски задач и ошибок, а поверх них «лес» для агентов (состояние сессий, аренды карточек,
одобрения владельца). Инструменты доступны через хаб: `mcp__hub__t-boards_1mcp_*`. Схемы этих инструментов
отложенные — перед первым вызовом загрузи их через `ToolSearch` (`select:<имя>,<имя>`).

## Пространства и проекты

| Пространство | id | Проекты (ключ — id) | Что канон |
|---|---|---|---|
| HR Helper / Lavaeon | `jbza3jvj5qtkquur7mpaxzet` | ЗАДАЧИ — `w4j1rooly9tu1gbpnm0yd8io` · ОШИБКИ — `ii3wt6iqrdxbxh6cvp081vqi` · HRH — `y3ekj2la5re0ci2ynhzn9olj` · ADM (админка) — `dk3b7pu4yl3pnywvuj5gtnc0` · PEOPLE — `nhfai6est61n4njssvsnva0k` | **t-boards** (с 30.10, R-084): ЗАДАЧИ и ОШИБКИ — канон открытого, карточки из Notion перенесены (поле `notionPageId`); Notion — архив только для чтения |
| aiBoards&eval | `lth89qy6f8j1greiy4c5cn23` | TB (t-boards) — `mf6jpr5wftbgr3z93lvw807v` · SE (supertick-eval) — `tl3j7yc2mc7lyro1on059dmh` · OPS — `mjwiozcdb50f7imppo1n2emv` · IDEA — `gfr6adn3iw3y4dxzbsuotrhv` · GL (цели) — `czjtga2z1wdvfv3di7dxhm1x` | **t-boards** |

Колонки:
- TB, SE, OPS: `new` → `grilling` → `to-do` → `in-progress` → `in-review` → `confirmation` → `done` | `closed`;
- ОШИБКИ: `открыто` → `в-работе` → `на-ревью` → `закрыто`.

Слаги колонок проекта — `list_project_columns`. В статус передаётся слаг.

## Кто ты в лесе

- `session: "t3-<ключ>"` (`t3-coord`, `t3-plan`, `t3-frontend`, `t3-backend`, `t3-release`, `t3-boards`) — одинаково в
  каждом вызове. Ярлык привязан к роли, а не к сессии, поэтому наследник получает аренды и журнал предшественника.
- `harness: "claude-code"`.
- `forest_set_work_state` пишется в пространство своей карточки. Если карточки нет: роли 1–5 — HR Helper / Lavaeon,
  роль 6 — aiBoards&eval.

## Цикл работы с карточкой

1. **Состояние** — `forest_set_work_state {workspaceId, session, harness, step, branch?, taskId?, waiting?}` после
   каждого шага. Вызов заменяет прежнее состояние, пропущенные поля стираются — каждый раз шли полный набор.
2. **Аренда** — `forest_acquire_lease {workspaceId, taskId, session, ttlSeconds ≤ 1800}` → `fencingToken`. Без него
   правка существующей карточки отклоняется. Если ответ называет держателя аренды, не перебивай её: посмотри его
   состояние в `forest_list_work_state` и, если нужно, пиши Координатору. Связанные сессии делят аренду через общий
   `groupKey`.
3. **Правки** — `update_task_status`, `forest_set_card_meta`, `create_task_comment`. Передавай `session`,
   `fencingToken` и `expectedRevision`, если знаешь ревизию.
4. **Освобождение** — `forest_release_lease`, когда закончил. Иначе аренда истечёт по TTL.

## Что сервер требует при смене статуса (правила d-tb-card-fill)

| Переход | Что нужно | Что сервер сделает сам |
|---|---|---|
| → «в работе» (`in-progress`, `в-работе`) | `note` — с чего начал | ставит исполнителя и дату начала |
| → «на ревью» (`in-review`, `на-ревью`) | `link` — PR или коммит (передать или уже на карточке), `note` — что сделано, как проверено | — |
| → «готово» / «закрыто» | заявка `close_task` с `doneRef` (см. ниже); статус ставит сервер по «да» | ставит дату окончания |

`note` при смене статуса сразу становится комментарием на карточке и упоминает владельца. Пиши его для владельца:
что сделано, как проверено, что осталось.

## Поля карточки — `forest_set_card_meta`

Шли только то, что меняется; `null` стирает поле.

- `branch`, `pullRequests[]` (ссылки), `files[]` (`путь` или `путь:строка`).
- `contextPack` — до 2000 символов. Брать из `capsule.py` (`capsules/<ключ>.pack.txt`). Это всё, что нужно наследнику,
  чтобы продолжить по карточке.
- `tokens`, `costUsd` — сколько стоила работа по карточке, если знаешь.
- `kind: "bug"` — для ошибок (задачи — `task`), `severity`.
- `report` — до 20 000 символов, итоговый отчёт.
- `backlogId` — Backlog ID (у перенесённых из Notion карточек уже стоит), только на своих карточках.

## Что решает только владелец

- Закрыть, переоткрыть, сменить приоритет: `forest_request_approval {action: close_task | reopen_task | set_priority,
  targetId, value, reason}`. `close_task` требует `doneRef` (коммит или PR с записью в `docs/plans/done/`) или
  `doneReason: duplicate | obsolete | import`, иначе 400. Одобрение покрывает только названное `value`.
- Разовое право (TB-102 R-10): `create_label {label: {name, color}, taskIds}`, `attach_label {targetId: labelId,
  taskIds}`, `set_assignee {targetId: taskId, value: userId}` — тем же `forest_request_approval`.
- Свалить дерево или сектор (`fell_tree`, `fell_sector`) — тоже только через заявку.
- Владелец отвечает в UI t-boards или в очереди владельца. Пункт очереди ставит сервер t-boards сам — ручной пункт
  очереди на заявку t-boards не ставить (TB-102 R-14). По «да» сервер применяет действие сам, весь путь до цели
  (In review → Done → «Брёвна»). Правку не повторять; исход читать в `forest_list_approvals`: `consumed`, `rejected`,
  `failed` (`failReason`) или `expired`.
- Поле `half-baked` меняет только владелец. Карточку с ним в работу не брать.
- Сам агент доводит карточку максимум до «на ревью» — правило 17.

## Карточки ЗАДАЧИ и ОШИБКИ — канон с 30.10 (R-084)

- Постановка, статус, приоритет и обсуждение — на карточке t-boards; хард-стопы — `.claude/rules/17-notion-board.md`.
  Статус — `update_task_status` под арендой, закрытие и приоритет — только через заявку: её применяет сервер.
- Новая задача или ошибка HR Helper — `create_task` в ЗАДАЧИ или ОШИБКИ. Лимит частоты или t-boards недоступен —
  тексты в файл отложенных записей, применить позже. В Notion вместо t-boards не писать.
- Notion — архив только для чтения: старые обсуждения. Ссылка на страницу Notion (32 hex) в пусковом файле — это
  карточка t-boards с тем же `notionPageId`: найди её `search` по заголовку и сверь `notionPageId` в
  `forest_get_card_meta`. Не нашёл — сказать, не угадывать.

## Новые карточки в aiBoards&eval

`create_task {projectId, title, description, priority, status: "new"}`. Тип и детали — `forest_set_card_meta`.

Описание из четырёх блоков:
- **Проблема** — что не так или что нужно.
- **Ожидание** — что должно получиться.
- **Приёмка** — как проверить.
- **Ссылки** — `файл:строка`, PR, пункт очереди.

Секретов и ПДн в карточках нет.

## PR и линзы

Вердикт — комментарий в PR (правило Т3). На карточку PR — одна строка-комментарий на пару «PR × линза»: «линза
<роль>: ок | changes на <sha>». Так голова, которую ждут, не теряется после сжатия контекста.

## Чтение — дёшево

Все `list_*` и `get_*` принимают:
- `fields` — какие поля вернуть;
- `budget` — 150–2500 токенов, по умолчанию 2500;
- `format` — `toon` (компактно) или `json`;
- `summary: true`, `since: <ISO>`, `ifNoneMatch: <etag>` — без изменений ответ придёт без тела.

Списки всегда запрашивай с `fields` и `budget`. Найти по тексту — `search`, по номеру — `get_task_by_ticket_id`.

## Никогда

- `delete_task`: дубликаты помечаются, не удаляются.
- Push форка в upstream kaneo. Push форка вообще делает только владелец.
- Секреты в `note`, `report`, `contextPack`.
- Любая запись в Notion (страницы, свойства, комментарии): архив только для чтения с R-084.
