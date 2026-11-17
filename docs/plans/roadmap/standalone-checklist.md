# Осталось до самостоятельного tAIBE — единый чек-лист

> **05.11 13:49 МСК: ссылки в HR сняты (Л2), HR от tAIBE не зависит.** Остаток — M1–M6 по `multi-product.md`. **Обновлено 2026-11-04 23:15 МСК** (development-3a, по факту: (b), С1, b15, #33/#34/#39/#44/#45 влиты; порядок
> оставшегося — [`docs/ops/taibe-extraction-runbook.md`](../../ops/taibe-extraction-runbook.md)). **Статус (2026-11-04 19:10 МСК):** сведено ролью 2 по указанию владельца 03.11 21:10 («HR не зависит от `t-boards/`,
> `supertick-eval/`, `eval/` и ссылок; tAIBE собирается, тестируется и разворачивается сам; без потери данных») и
> порядку Координатора 04.11 02:03. Источники: отчёты ролей 3/4/6 в Нерве 03.11 21:12–21:16, замеры роли 2
> 03.11 21:13, 04.11 02:05–02:25 и 07:05–07:12, линзы роли 6 на `45391d6b` и `e3fc834a` (04.11 07:01, 07:08), линза
> роли 4 на `e3fc834a` (04.11 19:01). Сверено с HR `origin/main` `45ffdfe2a`, tAIBE `board-agents` `debdc6c6`, #39
> `719c41b9`, #43 `be6c0162`.
> Фазы — [`multi-product.md`](multi-product.md). Канон открытого — доски: при заведении карточки строка получает её
> ключ (общая сводка `open-items.md` удалена 14.11 — каждая открытая строка сверена с доской).

Колонки: **роль** — исполнитель (1 Координатор, 2 план, 3 фронт, 4 бэкенд и ИИ-контур, 5 Контроль, 6 доски).
**М0** — шаг под запретом M0: идёт только решением владельца через Координатора, с бэкапом и откатом.
Статус: ✅ сделано · 🔧 в работе · 🔲 не начато.

## Порядок

1. Данные: бэкап и счётчики **до** любого переключения (раздел Д).
2. Сервисы Mac на путь tAIBE (раздел С). Каждый — решением владельца, по одному, с откатом одной строкой.
3. Слой `.claude` и тексты HR (раздел Х): PR в HR только из `.claude/**` и `*.md` — прод не деплоит.
4. Сам tAIBE: пути HR внутри, CI, стенд (раздел Т).
5. Снятие ссылок в checkout HR — **последним** (раздел Л), после суток без сбоев.

## Д. Данные — бэкап и сверка до переключения

| № | Что | Где | Роль | Бэкап / сверка | М0 | Статус |
|---|---|---|---|---|---|---|
| Д1 | Карточки, комментарии, лес и work_state досок, документы блокнота | БД досок на VPS (`/opt/t-boards`, стенд d4dev); отдельно — локальная БД досок на Mac (том `t-boards_t_boards_pg`, 63 таблицы) | 6 | Дамп каждые ~2 ч: LaunchAgent `space.hrhelper.t-boards-backup` → `~/t-boards-backups/` (последний `t-boards-20261103T2236Z.dump`, 4,16 МБ, `pull.log` 04.11 01:36); `install.sh` сам пишет `pre-<tag>-*.dump`. Локальная БД Mac — снимок тома и `counts.sql` в бэкапе Д7. Счётчики до/после (tasks, comments, projects, work_state) — `tb_snapshot.py` из import-check роли 2 (основа — `counts.sql` роли 6): перенести в `boards/tools/import-check/` PR-ом | — | ✅ бэкап · 🔲 скрипт счётчиков в git |
| Д2 | База консилиума `council.db` | `HR/.claude/council/council.db` — **1,09 ГБ, живая** (запись 04.11 02:04); там же снимок `council.db.before-unstamp-20261015-154319` (0,53 ГБ). Ключи облаков: zai и gemini — `HR/.continue/.env` (`cloud.py:55` `DOTENV_PATH = REPO_ROOT / ".continue/.env"`), Notion — `.claude/council/.notion-key` (600); файлов `.{zai,gemini,gateway}-key` нет | ✅ #39 и HR #459 влиты; `.backup` и `integrity_check` — шаг 2 команды (b), 04.11 22:46 | **Не копируем** (Координатор 04.11 02:11, выбор роли 4 в 02:09): `TAIBE_HOST_ROOT` — код консилиума и dams в tAIBE, данные остаются в `HR/.claude/council` продукта. Один писатель, 0 байт переноса, по M1. PR роли 4 — **с четырьмя условиями роли 6:** (1) `TAIBE_HOST_ROOT` покрывает все пути от `REPO_ROOT`: `store.py:25` (база) и `:570` (`git_sha`), `cloud.py:35,45,55` (ключи), `gateway.py:190,744,765`, `notion.py:146` — иначе база найдётся, а ключей не будет; (2) базы по пути хоста нет — ошибка с понятным текстом, создание только явным флагом, тест; после включения `tAIBE/.claude/council` не появился (`store.py:51` сейчас молча создаёт каталог и пустую базу — две живые базы); (3) HR-копия `infra/ai-council` заморожена до удаления, схема правится только в tAIBE и только добавлением (`_migrate()`, `store.py:94–100`, меняет схему при каждом подключении); `schema.sql` и `store.py` в HR и tAIBE пока совпадают, ещё 7 файлов уже разошлись; (4) перед первой записью кодом tAIBE — `sqlite3 HR/.claude/council/council.db ".backup <бэкап>/council-<дата>.db"` и `PRAGMA integrity_check` (свободно 108 ГиБ). **Где закрыты (линза роли 4, 19:01):** (1) и (2) — в коде #39
`719c41b9`: один корень `host_root()` для базы, ключей, шлюза, графа, `dams_common.py`, `glm_client.py`; базы нет —
`CouncilDbMissing`, создание только с `AI_COUNCIL_INIT_DB=1`, тест `selftest_host_root.py`; (3) — сторона tAIBE в
#39 (`infra/ai-council/CLAUDE.md`, только `ADDED_COLUMNS`), **сторона HR — HR #459** (`85a033b3d`, только md, `[skip ci]`, открыт); (4) — шаг 2 команды (b) (С2): `.backup` и `integrity_check` до любой правки конфигов, не ok — стоп | — | 🔧 #39 · условие 3 HR — #459 |
| Д3 | Состояние Нерва (журнал, курсоры тапов) | `tAIBE/eval/nerve/state/` — физически уже в tAIBE (HR видит через ссылку) | — | Перед M2 — копия каталога | — | ✅ |
| Д4 | Кэш настроек пайплайна | `HR/.claude/pipeline-settings.json` (214 Б) — пересоздаётся запросом к доскам | — | Переносить не нужно. После переключения Нерва (С1) кэш появится в `tAIBE/.claude/` | — | ✅ |
| Д5 | Очередь владельца | ops-консоль на прод-сервере HR; MCP `owner-queue` запускается из `HR/infra/owner-queue-mcp` (С2, С4) | 5 | Хранилище на сервере не трогаем. Перенос — M6 (A2) | — | 🔲 M6 |
| Д6 | Mac-синк блокнота и реестра SSR на checkout tAIBE (D-008) | Поставлен 04.11 06:51: LaunchAgent `space.hrhelper.t-boards-notebook-sync` и `…-notebook-worker`. С 04.11 23:05 синк идёт раз в сутки, в 04:17, без запуска при загрузке. До этого был раз в 900 с; переведён по решению владельца d-notebook-sync-0411. Запуск по запросу: `launchctl kickstart gui/$(id -u)/space.hrhelper.t-boards-notebook-sync`. Скрипты в `~/.t-boards-notebook/` из `boards/deploy/vps/mac/`. Конфиг: стенд d4dev, `repoRoot` — HR (документы продукта), `extraRoots` — tAIBE, `evalRefs: "new"`. С 05.11 (TB-75, #65) один воркер обслуживает два блокнота: aiBoards&eval и Lavaeon. У Lavaeon свой дом синка `~/.t-boards-notebook-lavaeon` (`repoRoot` — HR_Helper-v2, 04:47). Основной дом переходит на `repoRoot` tAIBE после индексации Lavaeon | 6 | Первый синк 06:51 — 289 файлов, ок. На сервере не было ни одной SSR-сущности и doc-источника: закрывать записи `supertick-eval/…` не нужно, D-008 свёлся к настройке. Фиксы первого SSR-синка — tAIBE #37 (влит 04.11 07:14); отклонённый черновик SSR — #41 | — | ✅ |
| Д7 | Секреты досок на Mac | `tAIBE/boards/.env` стр. 11, 13 → `tAIBE/boards/.secrets/{postgres_password,auth_secret}` (700/600, в gitignore) | 6 | Сделано 04.11 02:06: контейнер `t-boards-postgres-1` лежал с 03.11 18:51 (Exited 127, бинд на удалённый `HR/t-boards/app/.secrets`); `.secrets` скопированы из бэкапа разделения (cmp ок), `docker compose -f compose.t-boards.yml up -d --force-recreate` из `tAIBE/boards`. Том тот же, счётчики 63 таблиц до и после равны, `run-int.sh subtask-counts` 13/13, в 02:10 healthy. Бэкап `~/Backups/taibe-secrets-0411/` (`.env`, снимок тома 65 МБ, счётчики). Откат — вернуть `.env` и `--force-recreate` **из `tAIBE/boards`** (после Л2 пути `HR/t-boards/app` нет) | — | ✅ |
| Д8 | claude-mem, work_state claude-mem | `~/.claude-mem` | — | От репозиториев не зависит | — | ✅ |

## С. Сервисы Mac — на путь tAIBE

| № | Что | Где сейчас | Роль | Как и чем проверить | М0 | Статус |
|---|---|---|---|---|---|---|
| С1 | Нерв (демон) | LaunchAgent `space.hrhelper.nerve` → `HR_Helper-v2/supertick-eval/nerve/nerve.py` (pid 18210 с 02.11), `WorkingDirectory` и лог — тоже через ссылку; интерпретатор — `/Library/Frameworks/Python.framework/Versions/3.14/bin/python3`, тот самый без CA (С7). `state/` физически уже в tAIBE — переключение данные не двигает. Тапы ролей (`eval/nerve/nerve.py tap <роль>` из HR) тоже идут через ссылку — тексты команд в С6, проверка в Л1 | 6 | Правка plist на `tAIBE/eval/nerve/`, `launchctl bootout` → `bootstrap`; бэкап plist, откат — вернуть plist. Проверка: `nerve.py status` — свежий пульс, тапы ролей получают события. `repo_root` продукта в `eval/nerve/config.json` остаётся HR — это путь продукта, а не tAIBE | да (сервис всех ролей) | ✅ 04.11 23:07 (development-3a): plist на `tAIBE/eval/nerve`, пульс свежий; бэкап — `~/Backups/nerve-plist-0411/` |
| С2 | Хаб 1mcp :3050 | LaunchAgent `space.hrhelper.mcp-hub`, конфиг `~/.config/hr-helper-mcp-hub/mcp.json`, cwd — HR. Пять путей от cwd: `infra/ai-council/mcp_server.py`, `infra/owner-queue-mcp/server.mjs`, `infra/scripts/dev-ai/mcp-t-boards.sh` (→ `HR/t-boards/app/packages/mcp`, pid 69487), `infra/mcp-hub/dams_rag_server.py`, `infra/scripts/dev-ai/mcp-postgres.sh` | 4 | (a) копия на :3051 с временным конфигом и selftest консилиума → (b) команда переключения: бэкап конфига, plist и базы (Д2.4), проверка, что 1mcp отдаёт tools, откат одной строкой → решение владельцу → (c) PR удаления из HR после суток без сбоев. **Код слоя — `ai-council`, `dams-rag`, `owner-queue`, `t-boards` — из tAIBE:** первые два — `cwd=tAIBE`, `env TAIBE_HOST_ROOT=HR` (решение Координатора 02:09); `owner-queue` и `t-boards` — за `HR_HELPER_ROOT` хаба, это `SERVE_ROOT` = основной checkout tAIBE (#43 `mcp-hub.sh:47,152`). **Данные — `council.db`, `rag/index.db`, ключи, индекс serena — у хоста HR** через `TAIBE_HOST_ROOT`. `postgres-readonly` (`cwd=HR`) и `git` (аргумент — HR) смотрят на HR | да (рестарт хаба у всех сессий) | (a) ✅ · (b) ✅ 04.11 22:47 (`s-hub-switch-b-0411`, 0 провалов); `mcp-hub.sh sync` не запускать до шаблона `${TAIBE_HOST_ROOT}` |
| С3 | MCP досок `t-boards` | `infra/scripts/dev-ai/mcp-t-boards.sh:3,16,38,40` — `t-boards/app/packages/mcp` через ссылку | 4 | Закрывается командой (b) вместе с С2: в tAIBE `mcp-t-boards.sh:16-19` уже берёт `boards/packages/mcp` (`dist` собран 04.11 06:48) | вместе с С2 | ✅ с (b) |
| С4 | **MCP проекта HR в каждой сессии** — новая находка 04.11 | `HR/.mcp.json` (в git): `ai-council` → `python3 infra/ai-council/mcp_server.py`, `owner-queue` → `node infra/owner-queue-mcp/server.mjs`, пути от cwd HR. Сейчас ≈ 22 пары процессов, по паре на сессию | 4 | Хаб (С2) это не покрывает: если удалить `infra/ai-council` из HR, у всех сессий упадут эти два MCP. **Только HR PR роли 4** (#39 `.mcp.json` HR не трогает): `${TAIBE_ROOT:-<путь tAIBE на Mac>}/infra/ai-council/mcp_server.py` и `env TAIBE_HOST_ROOT` — Claude Code раскрывает `${VAR:-default}` в `.mcp.json`. **`.mcp.json` не попадает в `paths-ignore` деплоя — мёрж выкатит прод**: после (b) и суток без сбоев, вне окна `s-admin-domain-retry`. До С4 у консилиума две копии кода: хаб (tAIBE) и сессионные MCP (HR) читают разные `infra/ai-council/config.toml` — `gateway.update_setting` (#39 `gateway.py:1048`) правит конфиг своего слоя, вторая копия настройку не увидит | — | ✅ HR #461 влит 05.11 (без деплоя) |
| С5 | Консилиум (`glm_pr_review`, очередь карточек) | код в `HR/infra/ai-council`, база — Д2 | 4 | Без базы `glm_pr_review.py` откажется (`glm_pr_review.py:6-8`). С `TAIBE_HOST_ROOT` (Д2) код из tAIBE берёт базу продукта. Проверка — `selftest_host_root.py --live HR` (шаг 6 команды (b)); прогон одной линзы из tAIBE тратит квоту GLM — один раз после (b), не заранее. Настройки — см. оговорку о `config.toml` в С4 | — | 🔧 хаб ✅ (b); сессии — с С4 |
| С6 | Сессии ролей и наследники | `spawn_session.sh` и запуск `claude --settings supertick-eval/pipeline/genome/<роль>.json` из HR; в 10 геномах tAIBE 24 абсолютных пути `HR_Helper-v2/supertick-eval`, 30 — `HR_Helper-v2/worktrees` (пути продукта, законны), 2 прочих | 6 (+2 спека M1/M3) | **Геномы генерируются — `sed` по JSON не годится.** Их строит `build.py` из `eval/nerve/config.json`: `repo_root` + `product_tree`, `REFLEX = ROOT/TREE/pipeline/reflex` (`build.py:31–49`), так что пути хуков и worktrees растут из одного `repo_root`. Промежуточного шага нет: нужно разделить в генераторе корень слоя (`LOCAL_REFLEX`, `build.py:50`, уже есть) и корень продукта — это и есть M1, **реализация — только по спеке #34** (Т5), чтобы не появилось двух. Полностью — M3 (`build.py --product`, `taibe launch`). Команды в TEAM-0, handoff и `В ПЕРВУЮ ОЧЕРЕДЬ.md`, включая тапы Нерва (С1), — на путь tAIBE | — | ✅ tAIBE #59 (05.11): геномы и `spawn_session.sh` — из дома слоя `tAIBE/eval`; роли перезапущены, старых сессий 0 |
| С7 | Переключатели пайплайна не действуют на Mac (ОШИБКИ #634, medium) | python3 3.14 с python.org без файла CA → запрос настроек падает на SSL → все переключатели «вкл.» | 6 / 4 | Код: `_tls_context()` — системный бандл, если у python нет ни cafile, ни capath; тесты 19/19 на 3.14 и 3.9. Вторая причина (линза роли 6): ключ видит три продукта, а `boards.product` в `eval/nerve/config.json` не задан — переключатели не заработают и после TLS-фикса; зависит от `instances/<slug>.json` (M1, #34) | — | 🔧 TLS ✅ (#38 влит); `boards.product` — M1 |
| С8 | Serena, прокси памяти, бэкап досок | Serena `--project HR` — индекс кода продукта; `~/.t-boards-memory/memory-proxy.mjs` и `~/.t-boards-backup/pull-backup.sh` — в домашней папке, путей HR нет | — | Не трогать (Serena на продукт — решение M5) | — | ✅ |

## Х. Слой `.claude` и тексты HR

PR в HR только из `.claude/**` и `*.md`, `[skip ci]`. Деплой эти пути игнорирует (`deploy-contabo.yml:23-35`). По M4
канон слоя — tAIBE: правка в tAIBE и синк в HR, либо (до M4) зеркальный PR в оба репозитория.

Х1–Х3 — как С6, по спеке M3 (`multi-product.md:39`: хук порога наследника и капсулы берут пути из конфига продукта),
до Л2. До Л2 они работают через ссылки; промежуточный путь стал бы третьим механизмом (линза роли 6).

| № | Что | Где | Роль | Статус |
|---|---|---|---|---|
| Х1 | Хук порога наследника зовёт `spawn_session.sh` через ссылку | `.claude/hooks/context-threshold.py:7,50,56`, тест `test_context_threshold.py:97-101`; в tAIBE `.claude/hooks` — 1 файл с путём HR | 6 | ✅ HR #462 (05.11) |
| Х2 | Скилл successor-handoff — то же | `.claude/skills/successor-handoff/SKILL.md:68,71` | 6 | ✅ HR #462 (05.11) |
| Х3 | Правило 17 грузится по `paths: t-boards/**` — каталога в HR нет | `.claude/rules/17-notion-board.md:9` | 6 | ✅ HR #462 (05.11) |
| Х4 | Остальные файлы из «19» роли 4 — **не зависимость**: «t-boards» в них — имя доски и префикс MCP `t-boards_1mcp_*`, а не путь (проверено `git grep` по путям: всего 4 файла, Х1–Х3) | `.claude/rules/*`, `skills/grill-task/*`, `memory/*`, `skill-observations/log.md` | — | ✅ менять не нужно |
| Х5 | Тексты о путях | `CLAUDE.md:7` (словарь имён), `infra/mcp-hub/README.md:203`, `docs/ops/deploy-contabo.md:15` | 2 | 🔲 |
| Х6 | `paths-ignore` `supertick-eval/**`, `t-boards/**` — **не мёртвые**: на них держится откат разделения (revert #453 по `docs/ops/split-hr-taibe.md` и `infra/scripts/split/rollback.sh:39`). Без них такой revert и случайный мёрж старой ветки с этими папками пересоберут прод (502 на 148–347 с) | `.github/workflows/deploy-contabo.yml:33-34`; `.gitignore:192-193` (`.pnpm-store/` форка) | 5 | 🔲 убирать после Л2, когда закроется окно отката (M3 или «откат больше не нужен» владельца): HR #456 в черновике (changes роли 6 03.11 23:08 приняты) |
| Х7 | Код HR (`apps/`, `packages/`) | `git grep t-boards\|supertick-eval\|KANEO_\|@kaneo` — 0 файлов (роли 3 и 4) | — | ✅ |
| Х8 | Тесты ops-console: `t-boards` как пример чужого compose-проекта на хосте (рабочий код ops-console от досок не зависит, `git grep` вне тестов — 0) | `infra/ops-console/agent/test_hrh_ops_{collect,edge}.py`, `infra/ops-console/tests/inventory.test.ts` → `neighbour` | 5 | ✅ HR #457 влит (`45ffdfe2a`, `[skip ci]`) |

## Т. Сам tAIBE — собирается, тестируется, разворачивается

| № | Что | Где | Роль | Статус |
|---|---|---|---|---|
| Т1 | CI: `boards` (lint, typecheck, unit, build, i18n, openapi), `checks`, `eval` (unittest), `infra` (ops-console), `layer` (каталог слоя) | `.github/workflows/*.yml`; зелёные на `board-agents` 6ed0fe19 (03.11 21:30) | — | ✅ |
| Т2 | Стенд d4dev собран из tAIBE: образ `25d7363-b13`, миграции 82/82, включая A8 (0080, 0081) | `process/TRANSFER.md`, раздел «Стенд d4dev»; PR #32 | — | ✅ сейчас `f216280-b15` (04.11) |
| Т3 | Деплой — ручной: `bundle.sh` → `install.sh`, workflow деплоя нет | `boards/deploy/vps/` | 6 | ✅ сборка из tAIBE; запуск — только по «да» владельца (М0) |
| Т4 | Пути HR внутри tAIBE: 48 файлов (`git grep -l HR_Helper-v2`, без `docs/plans/done`): `eval/pipeline` 14, `eval/prompts` 6, `infra` 11, `docs` 4, `eval/tools` 2, `eval/nerve` 2, `process/prompts` 2, прочие 7. Из них 24 — история (md, jsonl, txt), не трогаем; тесты — 3 (`test_context_threshold.py`, `tg-html.test.mjs`, `selftest_knowledge.py`) | — | 6 | 🔲 разбор: пути **продукта** (repo_root, worktrees, папка сессий) → `instances/hr-helper.json` (M1, спека #34); пути **к tAIBE через HR** (`HR/supertick-eval`, `HR/t-boards/app`, `HR/infra/ai-council`) → на tAIBE |
| Т5 | Спеки M1/M2 | tAIBE PR #34 (ready, `39397149`, v1.3); развилки Р1–Р4 решены владельцем 04.11 18:55 (`d-taibe-m1m2-0411`: `instances/` в git tAIBE, slug `hr-helper`, один Нерв, база консилиума — M5) | 2 | ✅ #34 влит 04.11 |
| Т6 | Связи подзадач E7 | tAIBE PR #33 (`30facef6`) | 6 | ✅ #33 влит, на d4dev с b15 |
| Т7 | merge-guard (бывший HR #433) | tAIBE PR #40 (`b9754c51`). Push в свои ветки — правило (`d-taibe-push-433-0311`). HR #433 не закрывать: после мёржа #40 обновить копией головы (Координатор 17:17). Список Контроля `merge-guard.local.json` — у каждого продукта свой, в основной папке, вне git | 4 | ✅ tAIBE #40 влит 05.11; HR #433 — копия, мёрж после деплоя HR |

## Л. Снятие ссылок — последним

| № | Что | Роль | М0 | Статус |
|---|---|---|---|---|
| Л1 | Предусловия: С1, С2, С4, С6, Х1–Х3 сделаны; сутки без сбоев; `grep HR_Helper-v2/(supertick-eval\|eval\|boards\|t-boards)` по plist, конфигу хаба, `.mcp.json`, геномам, TEAM и handoff — 0; `ps` без процессов по этим путям, ни одного тапа Нерва через `HR/eval`; `docker inspect` всех контейнеров — ноль биндов и `working_dir` в `HR/(t-boards\|boards\|eval\|supertick-eval)` (04.11 02:10 — 0); `diff` `schema.sql` и `store.py` между HR и tAIBE `infra/ai-council` пуст (Д2) | 6 | — | ✅ 05.11 13:49 — все проверки 0 |
| Л2 | Снять ссылки `supertick-eval`, `eval`, `boards`, `t-boards/app` в checkout HR и строки 28–31 `.git/info/exclude` (`/supertick-eval`, `/eval`, `/boards`, `/t-boards/`; строку 32 `/.claude/pipeline-settings.json` оставить — это кэш продукта HR): `mv` в бэкап-каталог, не удаление; откат — `mv` обратно. **Имя ссылки — без завершающего `/`**: `mv eval/ …` или `rm -r eval/` перенесёт или удалит содержимое `tAIBE/eval`. Перед каждой командой `test -L`, после — число файлов в `tAIBE/eval` и `tAIBE/boards` то же, что до. После снятия `app` каталог `HR/t-boards/` пуст — `rmdir` | 6 | да (команда на Mac) | ✅ 05.11 13:49 — `mv` в `~/Backups/hr-links-20261105-134927/` (+ `ROLLBACK.sh`), файлы tAIBE целы |
| Л3 | Проверка после: роль стартует новой командой (M3), Нерв будит, хаб отдаёт tools, `glm_pr_review` идёт из tAIBE, сборка и тесты tAIBE зелёные | 6 + 5 | — | ✅ 05.11 — Нерв, хаб (16 серверов), запуск ролей из HR, 20 сессий на геномах tAIBE |

## Решения владельца — одним пакетом через Координатора

1. **Команда (b) — хаб на путь tAIBE** (С2, С3, Д2 вживую; бэкап базы — её шаг 2), после мёржа #39 и #43. Рестарт
   хаба у всех сессий.
2. **Нерв на путь tAIBE (С1)** — правка plist и перезапуск демона. Откат — старый plist.
3. **С4 — HR PR `.mcp.json`** — деплой прода, после суток без сбоев (b), вне окна `s-admin-domain-retry`.
4. **Снятие ссылок (Л2)** — последним, после суток без сбоев.

Сняты из пакета 04.11: D-008 (Д6) — синк поставлен 06:51, записей `supertick-eval/…` на сервере не было, решать
нечего; `.secrets` досок (Д7) — сделано ролью 6 в 02:06 с бэкапом и откатом; push в tAIBE для merge-guard —
владелец ответил «правило» (`d-taibe-push-433-0311`, 07:05); `TAIBE_HOST_ROOT` (#39) отдельным решением — мёрж #39 и
#43 живое не меняет (хаб и `.mcp.json` смотрят на HR до (b)), переключает только (b), затем С4.

Пакет ставит Координатор после мёржа #39 и #43: команда (b) v2 уже принята (17:23). Так владельца не спросят дважды.

Без решения владельца идут PR-ами, вливает Контроль по одному: Д1 (скрипт счётчиков в git), Д2-код (#39) и условие 3
в HR (md-PR роли 4), С5, С7, Х5, Т4–Т7. По спекам: С6 — M1 (#34), Х1–Х3 — M3, до Л2. Х6 — после Л2.
