# Консилиум без Notion: карточки t-boards по запросу (OPS-26, AUTO-70)

> **Статус:** план v2, 07.11 12:30 МСК, линия r.jvhl.7ep7. v1 атаковали 4 линзы — все CHANGES; правки внесены (блок
> «Адверсариальная проверка» внизу). Удалить файл после закрытия OPS-26, итог — в `docs/plans/done/`.
> **Источник:** входящее владельца `i-20261105-144934-67e7` (05.11: «переключить всё, что связано с Notion, на
> задачи t-boards, связать с продуктами — очередь и консилиум»), часть «консилиум» — по поручению моста 07.11.
> Карточки: tAIBE OPS-26 `v70213t2q39ae45ii9mmy2pp`, HR AUTO-70 `po5t8p49bsjxd95mpyyohif0`.
> **Решения:** `d-ops23-forks-0511` Р0 (б) — фона нет, карточку читаем из t-boards по номеру или id в момент
> вызова; `d-tb-product-key-0411` — свой ключ на продукт; R-084 (`d-tb-canon-3010`) — Notion заморожен.

## Цель и приёмка

- В `infra/ai-council` нет пути чтения и записи Notion: ни клиента, ни синка, ни записи, ни настроек.
- `council_cards` и `council_queue_card` по ключу карточки (`OPS-26`) или id отдают текущие заголовок, описание и
  статус из t-boards; продукт карточки — воркспейс ключа, он закреплён за базой хоста.
- Нет ключа, ключ на другой продукт или на несколько — понятный отказ с командой, а не пустой список.
- MCP-инструменты чтения работают без запущенного шлюза `:8790`.
- `cd infra/ai-council && python3 selftest.py` и `selftest_*.py` проходят; живой прогон — после ключа владельца.

## Факты (07.11 08:40–09:20Z, GET на d4dev)

- Фона нет с 01.11: `:8790` никто не слушает; MCP `mcp_server.py` — 10 процессов. `council_cards`, `council_plan`,
  `council_run_detail` идут в шлюз и отдают «gateway недоступен» (`mcp_server.py:65`).
- REST: `GET /api/workspace`; `GET /api/project?workspaceId=`; `GET /api/task/{id}` и
  `GET /api/task/by-ticket-id/{KEY}?workspaceId=` (с `workspaceId`, без меток и без `updatedAt`); мета
  `GET /api/forest/{ws}/cards/{id}/meta` (`kind`, `severity`, `backlogId`, `halfBaked`, `report`, `notionPageId`);
  ошибки доски одним вызовом `GET /api/forest/{ws}/bugs?projectId=`; метки `GET /api/label/task/{id}`; комментарии
  `GET /api/comment/{id}`; поиск `GET /api/search?q=&type=tasks&workspaceId=`; список проекта
  `GET /api/task/tasks/{pid}?status=<slug>&limit=100`. gzip сервер отдаёт по `Accept-Encoding: gzip`.
- HR: 11 проектов, ~1180 карточек; страница доски с описаниями — до 1,1 МБ (AUTO); в APP есть колонки со slug
  `на-ревью`, `открыто` и др. без `isFinal`; колонки ревью — `in-review` и `на-ревью`.
- Лимит ключа — 100 запросов, счётчик сбрасывается после 60 с без запросов (better-auth). Ключ хаба
  `T_BOARDS_API_KEY` общий для всех сессий: 429 на 12-м запросе замера. Своего ключа консилиума нет.
- `notionPageId` перенесённой карточки — UUID с дефисами, тот же формат, что `cards.card_id` базы HR. База HR:
  cards 878 из Notion + 7 черновиков, прогоны по 477 карточкам, 399 `card_notes`, 80 `review_cards` с `in_queue=1`.

## Устройство

1. **`tboards.py` (новый, stdlib, только GET)** — `http.client.HTTPSConnection` на вызов инструмента (keep-alive,
   gzip, без прокси и редиректов), ответ ≤ 8 МиБ, бюджет ≤ 40 запросов на вызов, пауза на 429 ≤ 5 с, иначе отказ;
   401/403/404/409 — свои тексты; 503 — один повтор. Ошибки — тип и код HTTP, без `str(e)` запроса.
   Пути — только шаблоны выше; ключ карточки `^[A-ZА-Я][A-ZА-Я0-9]{0,9}-\d{1,7}$`, id `^[a-z0-9]{20,32}$`,
   сегменты через `quote(…, safe='')`.
2. **Ключ привязан к адресу и продукту.** Файл хоста `.claude/council/tboards.json` = `{url, key, workspace, slug,
   name}`. Пишет его только `pbpaste | TAIBE_HOST_ROOT="$PWD" python3 <tAIBE>/infra/ai-council/tboards.py set-key` из корня
   продукта (ключ из stdin): адрес —
   `boards.url` слоя, только из `KNOWN_HOSTS`; один `GET /api/workspace` — ключ должен видеть ровно один воркспейс;
   файл `0600`. Чтение: `O_NOFOLLOW`, обычный файл, владелец — текущий пользователь, нет прав группы и мира, путь под
   `<хост>/.claude/council/`, ключ по регулярке. Env с ключом нет; `T_BOARDS_URL` из env — только localhost (тесты).
   На каждой карточке — `task.workspaceId == workspace` файла, иначе отказ.
3. **Схема — только добавление.** `cards`: `origin` (`tboards`; NULL — снимок Notion или черновик), `ticket`,
   `board_task_id`, `is_final`; `review_cards`: `origin`, `ticket`, `board_task_id`. Однократно (маркер в
   `council_state`): `UPDATE review_cards SET in_queue = 0 WHERE origin IS NULL`.
4. **История не рвётся.** `card_id` перенесённой карточки = её `notionPageId`: строка снимка обновляется на месте,
   прогоны, заметки и ревью остаются при ней. Новая карточка — `card_id` = id t-boards.
5. **Поля.** `db` = `bugs` при `kind = bug`; `status` = slug колонки; `is_final` — `isFinal` колонки или slug из
   `sources.tboards.final_slugs`; `priority` `urgent/high/medium/low` → `P0…P3`; `severity`, `half_baked`, `report`,
   `backlog_id` — из меты; `modules` — метки ∩ канонические модули; `body`, `comments` (`[{id, text, at}]`, без
   автора) и `report` — через `knowledge_external.scrub()`; `url` = `<адрес>/<slug воркспейса>/task/<ключ>`;
   `content_hash` — по значимым полям, тело только из детали.
6. **По запросу (Р0 б).** `supervisor.py run --card <ключ|id>` — деталь, мета, метки, комментарии (4–5 запросов),
   upsert, в очередь. `next`/`all` — отказ с подсказкой «укажите ключ карточки; список — council_cards».
   `council_cards(query)`: ключ или id — одна карточка из t-boards; текст — поиск t-boards (1 запрос); пусто —
   карточки t-boards из базы, без сети. Ответ — строка на карточку `КЛЮЧ статус P1 bug:sev заголовок[:80]`, по умолчанию
   20, не больше 50, ≤ 6 КБ. `open_cards()` — только `origin = 'tboards'` не `is_final` и черновики.
7. **Ревью.** `sync_queue` по `--refresh`: проекты, `?status=` по `sources.tboards.review_slugs`, ошибки — маршрутом
   `bugs`; полный проход — снять с очереди ушедшие, неполный — ничего не снимать. Мета и комментарии — при постановке
   карточки. Автозапуск убран (Р0 б). Статус ревью сверяется по slug. Переход и комментарий наружу не пишутся:
   политика доски даёт рекомендацию или предложение; `decide approve` → состояние `approved` (только в базе,
   калибровка — «согласен»), перенос карточки делает агент под арендой или владелец.
8. **Чтение без шлюза.** `mcp_server._gateway_get`: шлюз не отвечает — `gateway.py --get <путь>` подпроцессом (тот же
   обработчик `do_GET` без сокета, таймаут 60 с). `TimeoutExpired` ловится во всех подпроцессах MCP.
9. **Удаляются:** `notion.py`, `notion_sync.py`, `notion_schema_migrate.py`, писатель `emit.py` (`est_bucket` —
   в `planner_service.py`), `[sources.notion]`, `[outputs.notion_writeback]` и их проверки в `config.py`, сервис
   `notion-sync`, `set_status` и операции `sync`/`emit`/`emit_apply` шлюза и их кнопки, npm `ai-council:sync|emit|
   emit-apply|night` (новый — `ai-council:cards`), проверка `.notion-key` в `ai-tooling-pipeline.sh`. Шлюз и UI —
   только удаления и подписи, нового UI нет. Таблицы `notion_writes`, `created_pages` остаются (только добавление).
10. **Документы:** `docs/specs/ai-council.md`, `infra/ai-council/CLAUDE.md`, комментарии `config.toml`.

## Вне этого PR (карточки)

- Итог консилиума комментарием на карточке t-boards по белому списку, выключено по умолчанию — AUTO-70 ч. 2.
- Ключ t-boards только на чтение (`metadata.access: read` в `scopedKeyMayCall`) — карточка досок.
- HR: npm `ai-council:sync|emit|emit-apply` зовут удалённые модули (`package.json:137-142` HR) — карточка HR.
- OpenExecutive — HR AUTO-175 `phjx12sdpji3kmde2qbd01p0`. Панель «Карточки Notion в плане» ops-консоли — очередь.
- Секция `council` в `instances/<slug>.json` (Ф2 OPS-23) — после #90. MCP Notion в `.mcp.json` — решает владелец.

## Действие владельца (пункт `s-` вместе с PR)

1. t-boards → Настройки → API-ключи → ключ, ограниченный продуктом HR Helper (у ключа полные права продукта;
   консилиум делает только GET).
2. Скопировать ключ и в терминале: `cd ~/Desktop/Development/HR_Helper-v2 && pbpaste | python3
   ~/Desktop/Development/tAIBE/infra/ai-council/tboards.py set-key` с `TAIBE_HOST_ROOT="$PWD"` перед `python3` —
   печатает продукт и путь файла (пункт `s-council-tboards-key-0711`).

## Проверка

- selftest: фейковый t-boards на `127.0.0.1` — разбор полей, `card_id` = `notionPageId`, отказы (нет файла, права
  0644, симлинк, ключ с `\n` — без ключа в тексте, 2 воркспейса, чужой `workspaceId`, не-GET, редирект, 429, бюджет),
  scrub e-mail и телефона, `next`/`all` — отказ, снимок Notion не в `open_cards`, однократный сброс `in_queue`.
- `git grep -i notion -- infra/ai-council ':!*.md'` — только история в схеме, миграции и комментариях.

## Адверсариальная проверка v1 (4 линзы, субагенты, 07.11 08:50–09:05Z)

| Линза | Вердикт | Главные возражения | Решение в v2 |
|---|---|---|---|
| Корректность и отказы | CHANGES, 1 блокер | `board` занят в `review_*`; `next`/`all` не успевают за 30 с; история по Notion-id рвётся; 80 карточек ревью висят в очереди; политика ревью хранит имена, а не slug; удаление `notion.py` роняет импорт воркера и шлюза | `origin`; `next`/`all` убраны; `card_id` = `notionPageId`; однократный сброс; сверка по slug, `approved`; список потребителей в п. 9 |
| Ресурсы (сервер, сеть, Mac, токены) | CHANGES | `next` = ~300 вызовов меты; лимит скользящий; без gzip 2,4 МБ на 3G; новый TLS на запрос; ответ `council_cards` 8–40 тыс. токенов | маршрут `bugs`, бюджет 40, gzip и keep-alive, строка на карточку, ≤ 6 КБ |
| Продукт и простота | CHANGES | итог не виден без шлюза; лишние колонки; ключ другого продукта не ловится; «открыто» шире прежнего | чтение без шлюза; продукт закреплён в файле ключа; `is_final` и `final_slugs`; итог наружу — AUTO-70 ч. 2 |
| Безопасность ключа и записи | CHANGES | `T_BOARDS_URL` из коммитнутого `.mcp.json` уводит ключ; файл ключа без проверки прав и симлинков; ключ в тексте исключения; GET с побочным эффектом (`/api/notebook/.../embed/work`); ПДн в облако | ключ привязан к адресу в файле, env-адрес только localhost; проверки файла; шаблоны путей; scrub, без автора; карточка «ключ только на чтение» |

Отклонено: общий ключ хаба (видит 3 продукта, общий лимит, против `d-tb-product-key-0411`); синк по расписанию
(против Р0 б); env-ключ (один экспорт служил бы всем хостам); Keychain (сервис `hr-helper-mcp` один на Mac, а
продуктов два — файл хоста и есть ключ на продукт).
