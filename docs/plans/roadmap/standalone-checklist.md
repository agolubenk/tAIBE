# Осталось до самостоятельного tAIBE — единый чек-лист

> **Статус (2026-11-04 07:15 МСК):** сведено ролью 2 по указанию владельца 03.11 21:10 («HR не зависит от `t-boards/`,
> `supertick-eval/`, `eval/` и ссылок; tAIBE собирается, тестируется и разворачивается сам; без потери данных») и
> порядку Координатора 04.11 02:03. Источники: отчёты ролей 3/4/6 в Нерве 03.11 21:12–21:16, замеры роли 2
> 03.11 21:13, 04.11 02:05–02:25 и 07:05–07:12, линза роли 6 на `45391d6b` (04.11 07:01). Сверено с HR `origin/main`
> `34a84a559` и tAIBE `board-agents` `6ed0fe19`.
> Фазы — [`multi-product.md`](multi-product.md), общий список — [`open-items.md`](open-items.md). Канон открытого —
> доски: при заведении карточки строка получает её ключ.

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
| Д2 | База консилиума `council.db` | `HR/.claude/council/council.db` — **1,09 ГБ, живая** (запись 04.11 02:04); там же снимок `council.db.before-unstamp-20261015-154319` (0,53 ГБ). Ключи облаков: zai и gemini — `HR/.continue/.env` (`cloud.py:55` `DOTENV_PATH = REPO_ROOT / ".continue/.env"`), Notion — `.claude/council/.notion-key` (600); файлов `.{zai,gemini,gateway}-key` нет | 4 | **Не копируем** (Координатор 04.11 02:11, выбор роли 4 в 02:09): `TAIBE_HOST_ROOT` — код консилиума и dams в tAIBE, данные остаются в `HR/.claude/council` продукта. Один писатель, 0 байт переноса, по M1. PR роли 4 — **с четырьмя условиями роли 6:** (1) `TAIBE_HOST_ROOT` покрывает все пути от `REPO_ROOT`: `store.py:25` (база) и `:570` (`git_sha`), `cloud.py:35,45,55` (ключи), `gateway.py:190,744,765`, `notion.py:146` — иначе база найдётся, а ключей не будет; (2) базы по пути хоста нет — ошибка с понятным текстом, создание только явным флагом, тест; после включения `tAIBE/.claude/council` не появился (`store.py:51` сейчас молча создаёт каталог и пустую базу — две живые базы); (3) HR-копия `infra/ai-council` заморожена до удаления, схема правится только в tAIBE и только добавлением (`_migrate()`, `store.py:94–100`, меняет схему при каждом подключении); `schema.sql` и `store.py` в HR и tAIBE пока совпадают, ещё 7 файлов уже разошлись; (4) перед первой записью кодом tAIBE — `sqlite3 HR/.claude/council/council.db ".backup <бэкап>/council-<дата>.db"` и `PRAGMA integrity_check` (свободно 108 ГиБ) | — | 🔲 |
| Д3 | Состояние Нерва (журнал, курсоры тапов) | `tAIBE/eval/nerve/state/` — физически уже в tAIBE (HR видит через ссылку) | — | Перед M2 — копия каталога | — | ✅ |
| Д4 | Кэш настроек пайплайна | `HR/.claude/pipeline-settings.json` (214 Б) — пересоздаётся запросом к доскам | — | Переносить не нужно. После переключения Нерва (С1) кэш появится в `tAIBE/.claude/` | — | ✅ |
| Д5 | Очередь владельца | ops-консоль на прод-сервере HR; MCP `owner-queue` запускается из `HR/infra/owner-queue-mcp` (С2, С4) | 5 | Хранилище на сервере не трогаем. Перенос — M6 (A2) | — | 🔲 M6 |
| Д6 | Mac-синк блокнота и реестра SSR на checkout tAIBE (D-008) | Поставлен 04.11 06:51: LaunchAgent `space.hrhelper.t-boards-notebook-sync` (раз в 900 с) и `…-notebook-worker`, скрипты в `~/.t-boards-notebook/` из `boards/deploy/vps/mac/`. Конфиг: стенд d4dev, `repoRoot` — HR (документы продукта), `extraRoots` — tAIBE, `evalRefs: "new"` | 6 | Первый синк 06:51 — 289 файлов, ок. На сервере не было ни одной SSR-сущности и doc-источника: закрывать записи `supertick-eval/…` не нужно, D-008 свёлся к настройке. Фиксы первого SSR-синка — tAIBE #37 (открыт) | — | 🔧 до влива #37 |
| Д7 | Секреты досок на Mac | `tAIBE/boards/.env` стр. 11, 13 → `tAIBE/boards/.secrets/{postgres_password,auth_secret}` (700/600, в gitignore) | 6 | Сделано 04.11 02:06: контейнер `t-boards-postgres-1` лежал с 03.11 18:51 (Exited 127, бинд на удалённый `HR/t-boards/app/.secrets`); `.secrets` скопированы из бэкапа разделения (cmp ок), `docker compose -f compose.t-boards.yml up -d --force-recreate` из `tAIBE/boards`. Том тот же, счётчики 63 таблиц до и после равны, `run-int.sh subtask-counts` 13/13, в 02:10 healthy. Бэкап `~/Backups/taibe-secrets-0411/` (`.env`, снимок тома 65 МБ, счётчики). Откат — вернуть `.env` и `--force-recreate` **из `tAIBE/boards`** (после Л2 пути `HR/t-boards/app` нет) | — | ✅ |
| Д8 | claude-mem, work_state claude-mem | `~/.claude-mem` | — | От репозиториев не зависит | — | ✅ |

## С. Сервисы Mac — на путь tAIBE

| № | Что | Где сейчас | Роль | Как и чем проверить | М0 | Статус |
|---|---|---|---|---|---|---|
| С1 | Нерв (демон) | LaunchAgent `space.hrhelper.nerve` → `HR_Helper-v2/supertick-eval/nerve/nerve.py` (pid 18210 с 02.11), `WorkingDirectory` и лог — тоже через ссылку; интерпретатор — `/Library/Frameworks/Python.framework/Versions/3.14/bin/python3`, тот самый без CA (С7). `state/` физически уже в tAIBE — переключение данные не двигает. Тапы ролей (`eval/nerve/nerve.py tap <роль>` из HR) тоже идут через ссылку — тексты команд в С6, проверка в Л1 | 6 | Правка plist на `tAIBE/eval/nerve/`, `launchctl bootout` → `bootstrap`; бэкап plist, откат — вернуть plist. Проверка: `nerve.py status` — свежий пульс, тапы ролей получают события. `repo_root` продукта в `eval/nerve/config.json` остаётся HR — это путь продукта, а не tAIBE | да (сервис всех ролей) | 🔲 |
| С2 | Хаб 1mcp :3050 | LaunchAgent `space.hrhelper.mcp-hub`, конфиг `~/.config/hr-helper-mcp-hub/mcp.json`, cwd — HR. Пять путей от cwd: `infra/ai-council/mcp_server.py`, `infra/owner-queue-mcp/server.mjs`, `infra/scripts/dev-ai/mcp-t-boards.sh` (→ `HR/t-boards/app/packages/mcp`, pid 69487), `infra/mcp-hub/dams_rag_server.py`, `infra/scripts/dev-ai/mcp-postgres.sh` | 4 | (a) копия на :3051 с временным конфигом и selftest консилиума → (b) команда переключения: бэкап конфига и plist, проверка, что 1mcp отдаёт tools, откат одной строкой → решение владельцу → (c) PR удаления из HR после суток без сбоев. **На tAIBE переходят только `ai-council`, `owner-queue` и `t-boards`.** `dams_rag` (индекс HR) и `postgres` (БД HR) — стек продукта, остаются на HR | да (рестарт хаба у всех сессий) | 🔧 (a) |
| С3 | MCP досок `t-boards` | `infra/scripts/dev-ai/mcp-t-boards.sh:3,16,38,40` — `t-boards/app/packages/mcp` через ссылку | 4 | Вместе с С2: путь `tAIBE/boards/packages/mcp` | вместе с С2 | 🔲 |
| С4 | **MCP проекта HR в каждой сессии** — новая находка 04.11 | `HR/.mcp.json` (в git): `ai-council` → `python3 infra/ai-council/mcp_server.py`, `owner-queue` → `node infra/owner-queue-mcp/server.mjs`, пути от cwd HR. Сейчас ≈ 22 пары процессов, по паре на сессию | 4 | Хаб (С2) это не покрывает: если удалить `infra/ai-council` из HR, у всех сессий упадут эти два MCP. Роль 4 — в том же PR, что `TAIBE_HOST_ROOT` (Д2), плюс отдельный PR путей в HR. **`.mcp.json` не попадает в `paths-ignore` деплоя — мёрж выкатит прод**: вливать вне окна `s-admin-domain-retry` | — | 🔲 |
| С5 | Консилиум (`glm_pr_review`, очередь карточек) | код в `HR/infra/ai-council`, база — Д2 | 4 | Без базы `glm_pr_review.py` откажется (`glm_pr_review.py:8`). С `TAIBE_HOST_ROOT` (Д2) код из tAIBE берёт базу продукта. Проверка — прогон одной линзы из tAIBE | — | 🔲 |
| С6 | Сессии ролей и наследники | `spawn_session.sh` и запуск `claude --settings supertick-eval/pipeline/genome/<роль>.json` из HR; в 10 геномах tAIBE 24 абсолютных пути `HR_Helper-v2/supertick-eval`, 30 — `HR_Helper-v2/worktrees` (пути продукта, законны), 2 прочих | 6 (+2 спека M1/M3) | **Геномы генерируются — `sed` по JSON не годится.** Их строит `build.py` из `eval/nerve/config.json`: `repo_root` + `product_tree`, `REFLEX = ROOT/TREE/pipeline/reflex` (`build.py:31–49`), так что пути хуков и worktrees растут из одного `repo_root`. Промежуточного шага нет: нужно разделить в генераторе корень слоя (`LOCAL_REFLEX`, `build.py:50`, уже есть) и корень продукта — это и есть M1, **реализация — только по спеке #34** (Т5), чтобы не появилось двух. Полностью — M3 (`build.py --product`, `taibe launch`). Команды в TEAM-0, handoff и `В ПЕРВУЮ ОЧЕРЕДЬ.md`, включая тапы Нерва (С1), — на путь tAIBE | — | 🔲 после #34 |
| С7 | Переключатели пайплайна не действуют на Mac (ОШИБКИ #634, medium) | python3 3.14 с python.org без файла CA → запрос настроек падает на SSL → все переключатели «вкл.» | 6 / 4 | Код: `ssl.create_default_context(cafile="/etc/ssl/cert.pem")`, если стандартного файла нет; тест на отсутствие CA | — | 🔲 |
| С8 | Serena, прокси памяти, бэкап досок | Serena `--project HR` — индекс кода продукта; `~/.t-boards-memory/memory-proxy.mjs` и `~/.t-boards-backup/pull-backup.sh` — в домашней папке, путей HR нет | — | Не трогать (Serena на продукт — решение M5) | — | ✅ |

## Х. Слой `.claude` и тексты HR

PR в HR только из `.claude/**` и `*.md`, `[skip ci]`. Деплой эти пути игнорирует (`deploy-contabo.yml:23-35`). По M4
канон слоя — tAIBE: правка в tAIBE и синк в HR, либо (до M4) зеркальный PR в оба репозитория.

| № | Что | Где | Роль | Статус |
|---|---|---|---|---|
| Х1 | Хук порога наследника зовёт `spawn_session.sh` через ссылку | `.claude/hooks/context-threshold.py:7,50,56`, тест `test_context_threshold.py:97-101`; в tAIBE `.claude/hooks` — 1 файл с путём HR | 6 | 🔲 |
| Х2 | Скилл successor-handoff — то же | `.claude/skills/successor-handoff/SKILL.md:68,71` | 6 | 🔲 |
| Х3 | Правило 17 грузится по `paths: t-boards/**` — каталога в HR нет | `.claude/rules/17-notion-board.md:9` | 6 | 🔲 |
| Х4 | Остальные файлы из «19» роли 4 — **не зависимость**: «t-boards» в них — имя доски и префикс MCP `t-boards_1mcp_*`, а не путь (проверено `git grep` по путям: всего 4 файла, Х1–Х3) | `.claude/rules/*`, `skills/grill-task/*`, `memory/*`, `skill-observations/log.md` | — | ✅ менять не нужно |
| Х5 | Тексты о путях | `CLAUDE.md:7` (словарь имён), `infra/mcp-hub/README.md:203`, `docs/ops/deploy-contabo.md:15` | 2 | 🔲 |
| Х6 | `paths-ignore` `supertick-eval/**`, `t-boards/**` — **не мёртвые**: на них держится откат разделения (revert #453 по `docs/ops/split-hr-taibe.md` и `infra/scripts/split/rollback.sh:39`). Без них такой revert и случайный мёрж старой ветки с этими папками пересоберут прод (502 на 148–347 с) | `.github/workflows/deploy-contabo.yml:33-34`; `.gitignore:192-193` (`.pnpm-store/` форка) | 5 | 🔲 убирать после Л2, когда закроется окно отката (M3 или «откат больше не нужен» владельца): HR #456 в черновике (changes роли 6 03.11 23:08 приняты) |
| Х7 | Код HR (`apps/`, `packages/`) | `git grep t-boards\|supertick-eval\|KANEO_\|@kaneo` — 0 файлов (роли 3 и 4) | — | ✅ |
| Х8 | Тесты ops-console: `t-boards` как пример чужого compose-проекта на хосте (рабочий код ops-console от досок не зависит, `git grep` вне тестов — 0) | `infra/ops-console/agent/test_hrh_ops_{collect,edge}.py`, `infra/ops-console/tests/inventory.test.ts` → `neighbour` | 5 | 🔧 HR #457 (`475b76d51`), m-457 стоит |

## Т. Сам tAIBE — собирается, тестируется, разворачивается

| № | Что | Где | Роль | Статус |
|---|---|---|---|---|
| Т1 | CI: `boards` (lint, typecheck, unit, build, i18n, openapi), `checks`, `eval` (unittest), `infra` (ops-console), `layer` (каталог слоя) | `.github/workflows/*.yml`; зелёные на `board-agents` 6ed0fe19 (03.11 21:30) | — | ✅ |
| Т2 | Стенд d4dev собран из tAIBE: образ `25d7363-b13`, миграции 82/82, включая A8 (0080, 0081) | `process/TRANSFER.md`, раздел «Стенд d4dev»; PR #32 | — | ✅ |
| Т3 | Деплой — ручной: `bundle.sh` → `install.sh`, workflow деплоя нет | `boards/deploy/vps/` | 6 | ✅ сборка из tAIBE; запуск — только по «да» владельца (М0) |
| Т4 | Пути HR внутри tAIBE: 48 файлов (`git grep -l HR_Helper-v2`, без `docs/plans/done`): `eval/pipeline` 14, `eval/prompts` 6, `infra` 11, `docs` 4, `eval/tools` 2, `eval/nerve` 2, `process/prompts` 2, прочие 7. Из них 24 — история (md, jsonl, txt), не трогаем; тесты — 3 (`test_context_threshold.py`, `tg-html.test.mjs`, `selftest_knowledge.py`) | — | 6 | 🔲 разбор: пути **продукта** (repo_root, worktrees, папка сессий) → `instances/hr-helper.json` (M1, спека #34); пути **к tAIBE через HR** (`HR/supertick-eval`, `HR/t-boards/app`, `HR/infra/ai-council`) → на tAIBE |
| Т5 | Спеки M1/M2 | tAIBE PR #34 (draft, f482afcc) | 2 | 🔧 линзы GLM x = 4 идут с 04.11 07:05 |
| Т6 | Связи подзадач E7 | tAIBE PR #33 (draft) | 6 | 🔧 линзы GLM |
| Т7 | merge-guard (бывший HR #433) | tAIBE `fix/merge-guard` bfd5a581 | 4 | 🔧 ждёт `d-taibe-push-433-0311` |

## Л. Снятие ссылок — последним

| № | Что | Роль | М0 | Статус |
|---|---|---|---|---|
| Л1 | Предусловия: С1, С2, С4, С6, Х1–Х3 сделаны; сутки без сбоев; `grep HR_Helper-v2/(supertick-eval\|eval\|boards\|t-boards)` по plist, конфигу хаба, `.mcp.json`, геномам, TEAM и handoff — 0; `ps` без процессов по этим путям, ни одного тапа Нерва через `HR/eval`; `docker inspect` всех контейнеров — ноль биндов и `working_dir` в `HR/(t-boards\|boards\|eval\|supertick-eval)` (04.11 02:10 — 0); `diff` `schema.sql` и `store.py` между HR и tAIBE `infra/ai-council` пуст (Д2) | 6 | — | 🔲 |
| Л2 | Снять ссылки `supertick-eval`, `eval`, `boards`, `t-boards/app` в checkout HR и строки 28–31 `.git/info/exclude` (`/supertick-eval`, `/eval`, `/boards`, `/t-boards/`; строку 32 `/.claude/pipeline-settings.json` оставить — это кэш продукта HR): `mv` в бэкап-каталог, не удаление; откат — `mv` обратно. **Имя ссылки — без завершающего `/`**: `mv eval/ …` или `rm -r eval/` перенесёт или удалит содержимое `tAIBE/eval`. Перед каждой командой `test -L`, после — число файлов в `tAIBE/eval` и `tAIBE/boards` то же, что до. После снятия `app` каталог `HR/t-boards/` пуст — `rmdir` | 6 | да (команда на Mac) | 🔲 |
| Л3 | Проверка после: роль стартует новой командой (M3), Нерв будит, хаб отдаёт tools, `glm_pr_review` идёт из tAIBE, сборка и тесты tAIBE зелёные | 6 + 5 | — | 🔲 |

## Решения владельца — одним пакетом через Координатора

1. **Хаб на путь tAIBE (С2/С3)** — команда роли 4 после проверки на :3051. Рестарт хаба у всех сессий.
2. **Нерв на путь tAIBE (С1)** — правка plist и перезапуск демона. Откат — старый plist.
3. **`TAIBE_HOST_ROOT`, PR роли 4 (Д2, С4, С5)** — код консилиума и dams из tAIBE, данные в `HR/.claude/council`;
   переноса нет; четыре условия роли 6 — в строке Д2, бэкап базы — до первой записи. Отдельный PR путей `.mcp.json`
   в HR деплоит прод — вливать вне окна `s-admin-domain-retry`.
4. **Push в tAIBE для merge-guard** — `d-taibe-push-433-0311` (уже стоит).
5. **Снятие ссылок (Л2)** — последним, после суток без сбоев.

Сняты из пакета 04.11: D-008 (Д6) — синк поставлен 06:51, записей `supertick-eval/…` на сервере не было, решать
нечего; `.secrets` досок (Д7) — сделано ролью 6 в 02:06 с бэкапом и откатом.

Пакет ставит Координатор, когда будет готовая команда хаба от роли 4. Так владельца не спросят дважды.

Без решения владельца идут: Д1 (скрипт счётчиков в git), С5–С7, Х1–Х5, Х8, Т4–Т7 — PR-ами, вливает Контроль по одному.
Х6 — после Л2.
