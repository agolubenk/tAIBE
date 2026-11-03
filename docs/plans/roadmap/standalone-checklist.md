# Осталось до самостоятельного tAIBE — единый чек-лист

> **Статус (2026-11-04 02:10 МСК):** сведено ролью 2 по указанию владельца 03.11 21:10 («HR не зависит от `t-boards/`,
> `supertick-eval/`, `eval/` и ссылок; tAIBE собирается, тестируется и разворачивается сам; без потери данных») и
> порядку Координатора 04.11 02:03. Источники: отчёты ролей 3/4/6 в Нерве 03.11 21:12–21:16, замеры роли 2
> 03.11 21:13 и 04.11 02:05–02:25. Сверено с HR `origin/main` `34a84a559` и tAIBE `board-agents` `6ed0fe19`.
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
| Д1 | Карточки, комментарии, лес и work_state досок, документы блокнота | БД досок на VPS (`/opt/t-boards`, стенд d4dev) | 6 | Дамп каждые ~2 ч: LaunchAgent `space.hrhelper.t-boards-backup` → `~/t-boards-backups/` (последний 03.11 22:36Z, 4,16 МБ, ok); `install.sh` сам пишет `pre-<tag>-*.dump`. Счётчики до/после (tasks, comments, projects, work_state) — `tb_snapshot.py` из import-check роли 2: перенести в `boards/tools/import-check/` PR-ом | — | 🔧 бэкап ✅, скрипт счётчиков вне git |
| Д2 | База консилиума `council.db` | `HR/.claude/council/council.db` — **1,09 ГБ, живая** (запись 04.11 02:04); там же снимок `council.db.before-unstamp-20261015-154319` (0,53 ГБ) и ключи облаков `.claude/council/.{zai,gemini,gateway}-key` | 6 | Копия в tAIBE — через `sqlite3 .backup` при остановленном консилиуме, затем `PRAGMA integrity_check` и число строк по таблицам в обеих копиях; ключи — `cp -p` с правами 600, без вывода. HR-копию не удалять до подтверждения | да (остановка консилиума у всех сессий) | 🔲 |
| Д3 | Состояние Нерва (журнал, курсоры тапов) | `tAIBE/eval/nerve/state/` — физически уже в tAIBE (HR видит через ссылку) | — | Перед M2 — копия каталога | — | ✅ |
| Д4 | Кэш настроек пайплайна | `HR/.claude/pipeline-settings.json` (214 Б) — пересоздаётся запросом к доскам | — | Переносить не нужно. После переключения Нерва (С1) кэш появится в `tAIBE/.claude/` | — | ✅ |
| Д5 | Очередь владельца | ops-консоль на прод-сервере HR; MCP `owner-queue` запускается из `HR/infra/owner-queue-mcp` (С2, С4) | 5 | Хранилище на сервере не трогаем. Перенос — M6 (A2) | — | 🔲 M6 |
| Д6 | Mac-синк блокнота и реестра SSR на checkout tAIBE (D-008) | `boards/deploy/vps/mac/notebook-sync.mjs`, `ssr-sync.mjs` | 6 | Ключ сущности SSR — путь: записи `supertick-eval/…` закрыть или переименовать (решение D-008) | да (синк блокнота) | 🔲 |
| Д7 | Секреты досок на Mac | `tAIBE/boards/.env` → `tAIBE/boards/.secrets/{postgres_password,auth_secret}` (пути уже в tAIBE) | 6 | Перемонтирование контейнера — по решению владельца. Сверка: API досок стартует, вход работает | — | 🔧 |
| Д8 | claude-mem, work_state claude-mem | `~/.claude-mem` | — | От репозиториев не зависит | — | ✅ |

## С. Сервисы Mac — на путь tAIBE

| № | Что | Где сейчас | Роль | Как и чем проверить | М0 | Статус |
|---|---|---|---|---|---|---|
| С1 | Нерв (демон) | LaunchAgent `space.hrhelper.nerve` → `HR_Helper-v2/supertick-eval/nerve/nerve.py` (pid 18210 с 02.11), `WorkingDirectory` и лог — тоже через ссылку | 6 | Правка plist на `tAIBE/eval/nerve/`, `launchctl bootout` → `bootstrap`; бэкап plist, откат — вернуть plist. Проверка: `nerve.py status` — свежий пульс, тапы ролей получают события. `repo_root` продукта в `eval/nerve/config.json` остаётся HR — это путь продукта, а не tAIBE | да (сервис всех ролей) | 🔲 |
| С2 | Хаб 1mcp :3050 | LaunchAgent `space.hrhelper.mcp-hub`, конфиг `~/.config/hr-helper-mcp-hub/mcp.json`, cwd — HR. Пять путей от cwd: `infra/ai-council/mcp_server.py`, `infra/owner-queue-mcp/server.mjs`, `infra/scripts/dev-ai/mcp-t-boards.sh` (→ `HR/t-boards/app/packages/mcp`, pid 69487), `infra/mcp-hub/dams_rag_server.py`, `infra/scripts/dev-ai/mcp-postgres.sh` | 4 | (a) копия на :3051 с временным конфигом и selftest консилиума → (b) команда переключения: бэкап конфига и plist, проверка, что 1mcp отдаёт tools, откат одной строкой → решение владельцу → (c) PR удаления из HR после суток без сбоев. **На tAIBE переходят только `ai-council`, `owner-queue` и `t-boards`.** `dams_rag` (индекс HR) и `postgres` (БД HR) — стек продукта, остаются на HR | да (рестарт хаба у всех сессий) | 🔧 (a) |
| С3 | MCP досок `t-boards` | `infra/scripts/dev-ai/mcp-t-boards.sh:3,16,38,40` — `t-boards/app/packages/mcp` через ссылку | 4 | Вместе с С2: путь `tAIBE/boards/packages/mcp` | вместе с С2 | 🔲 |
| С4 | **MCP проекта HR в каждой сессии** — новая находка 04.11 | `HR/.mcp.json` (в git): `ai-council` → `python3 infra/ai-council/mcp_server.py`, `owner-queue` → `node infra/owner-queue-mcp/server.mjs`, пути от cwd HR. Сейчас ≈ 22 пары процессов, по паре на сессию | 4 | Хаб (С2) это не покрывает: если удалить `infra/ai-council` из HR, у всех сессий упадут эти два MCP. Перевести на абсолютные пути tAIBE или на хаб. **`.mcp.json` не попадает в `paths-ignore` деплоя — его мёрж в main выкатит прод.** Поэтому сначала отдельный PR добавляет `.mcp.json` в `paths-ignore` (`.github/**` деплой не запускает), потом PR с путями | — | 🔲 |
| С5 | Консилиум (`glm_pr_review`, очередь карточек) | код в `HR/infra/ai-council`, база — Д2 | 4 | Из worktree tAIBE `glm_pr_review.py` без базы откажется (`glm_pr_review.py:8`). Порядок: Д2 → С2 → проверка прогоном одной линзы из tAIBE | — | 🔲 |
| С6 | Сессии ролей и наследники | `spawn_session.sh` и запуск `claude --settings supertick-eval/pipeline/genome/<роль>.json` из HR; в геномах tAIBE 24 абсолютных пути `HR_Helper-v2/supertick-eval` (ещё 30 — `HR_Helper-v2/worktrees`: это пути продукта, они законны) | 6 (+2 спека M3) | Промежуточно: в геномах `HR_Helper-v2/supertick-eval` → `tAIBE/eval` PR-ом в tAIBE, `build.py --check` зелёный. Полностью — M3 (`build.py --product`, `taibe launch`). Команды в TEAM-0, handoff и `В ПЕРВУЮ ОЧЕРЕДЬ.md` — на путь tAIBE | — | 🔲 |
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
| Х6 | Мёртвые `paths-ignore` `supertick-eval/**`, `t-boards/**` | `.github/workflows/deploy-contabo.yml:33-34`; `.gitignore:192-193` (`.pnpm-store/` форка) | 5 | 🔲 безвредно; `.github/**` деплой не запускает |
| Х7 | Код HR (`apps/`, `packages/`) | `git grep t-boards\|supertick-eval\|KANEO_\|@kaneo` — 0 файлов (роли 3 и 4) | — | ✅ |

## Т. Сам tAIBE — собирается, тестируется, разворачивается

| № | Что | Где | Роль | Статус |
|---|---|---|---|---|
| Т1 | CI: `boards` (lint, typecheck, unit, build, i18n, openapi), `checks`, `eval` (unittest), `infra` (ops-console), `layer` (каталог слоя) | `.github/workflows/*.yml`; зелёные на `board-agents` 6ed0fe19 (03.11 21:30) | — | ✅ |
| Т2 | Стенд d4dev собран из tAIBE: образ `25d7363-b13`, миграции 82/82, включая A8 (0080, 0081) | `process/TRANSFER.md`, раздел «Стенд d4dev»; PR #32 | — | ✅ |
| Т3 | Деплой — ручной: `bundle.sh` → `install.sh`, workflow деплоя нет | `boards/deploy/vps/` | 6 | ✅ сборка из tAIBE; запуск — только по «да» владельца (М0) |
| Т4 | Пути HR внутри tAIBE: 48 файлов (`git grep -l HR_Helper-v2`, без `docs/plans/done`): `eval/pipeline` 14, `eval/prompts` 6, `infra` 11, `docs` 4, `eval/tools` 2, `eval/nerve` 2, `process/prompts` 2, прочие 7 | — | 6 | 🔲 разбор: пути **продукта** (repo_root, worktrees, папка сессий) → `instances/hr-helper.json` (M1, спека #34); пути **к tAIBE через HR** (`HR/supertick-eval`, `HR/t-boards/app`, `HR/infra/ai-council`) → на tAIBE |
| Т5 | Спеки M1/M2 | tAIBE PR #34 (draft, f482afcc) | 2 | 🔧 линзы GLM — квота zai до 04.11 05:03 |
| Т6 | Связи подзадач E7 | tAIBE PR #33 (draft) | 6 | 🔧 линзы GLM |
| Т7 | merge-guard (бывший HR #433) | tAIBE `fix/merge-guard` bfd5a581 | 4 | 🔧 ждёт `d-taibe-push-433-0311` |

## Л. Снятие ссылок — последним

| № | Что | Роль | М0 | Статус |
|---|---|---|---|---|
| Л1 | Предусловия: С1, С2, С4, С6, Х1–Х3 сделаны; сутки без сбоев; `grep HR_Helper-v2/(supertick-eval\|eval\|boards\|t-boards)` по plist, конфигу хаба, `.mcp.json`, геномам, TEAM и handoff — 0; `ps` без процессов по этим путям | 6 | — | 🔲 |
| Л2 | Снять ссылки `supertick-eval`, `eval`, `boards`, `t-boards/app` в checkout HR и строки 28–31 `.git/info/exclude`: `mv` в бэкап-каталог, не удаление; откат — `mv` обратно | 6 | да (команда на Mac) | 🔲 |
| Л3 | Проверка после: роль стартует новой командой (M3), Нерв будит, хаб отдаёт tools, `glm_pr_review` идёт из tAIBE, сборка и тесты tAIBE зелёные | 6 + 5 | — | 🔲 |

## Решения владельца — одним пакетом через Координатора

1. **Хаб на путь tAIBE (С2/С3)** — команда роли 4 после проверки на :3051. Рестарт хаба у всех сессий.
2. **Нерв на путь tAIBE (С1)** — правка plist и перезапуск демона. Откат — старый plist.
3. **Копия `council.db` и ключей консилиума в tAIBE (Д2)** — короткая остановка консилиума; HR-копия остаётся.
4. **D-008 (Д6)** — синк блокнота и SSR на checkout tAIBE и судьба записей `supertick-eval/…` в SSR.
5. **Перемонтирование контейнера досок с `.secrets` tAIBE (Д7)** — по черновику роли 6.
6. **Push в tAIBE для merge-guard** — `d-taibe-push-433-0311` (уже стоит).
7. **Снятие ссылок (Л2)** — последним, после суток без сбоев.

Без решения владельца идут: Д1 (скрипт счётчиков в git), С4 (два PR: `paths-ignore`, затем пути), С5–С7, Х1–Х7,
Т4–Т7 — PR-ами, вливает Контроль по одному.
