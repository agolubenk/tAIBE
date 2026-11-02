# Перенос слоя в дом продукта — манифест (сверка 2026-11-01)

Продукт вырос в инкубаторе — внутри host-проекта, где команда ИИ-сессий работала с 26.10. Там он жил тремя
частями: подпроект экономного пайплайна (`supertick-eval/`), подпроект досок для агентов (`t-boards/`, код — форк
Kaneo в `t-boards/app`, локально) и функциональный слой (`.claude/`, `.continue/`, `.agents/`, `.ai/`, ИИ-сервисы в
`infra/`). Этот файл — сверка «что и куда переехало», чтобы читатель старых документов, капсул и handoff находил
файл по новому пути. Инкубатор при переносе не менялся.

## Соответствие путей

| Было (инкубатор) | Стало (здесь) | Как сверено |
|---|---|---|
| `supertick-eval/<path>` | `eval/<path>` | `diff -rq` — совпадает 1:1, кроме рантайма `nerve/state/`, `swarm/state/` (не переносится) |
| `t-boards/app/<path>` | `boards/<path>` | код форка; в инкубаторе не под git, сверка — по `boards/docs/impl-progress.md` |
| `t-boards/t-boards-spec.md`, `architecture-overview2.0.md` | `boards/docs/` (то же имя) | совпадают байт-в-байт |
| `t-boards/{impl-progress,impl-remaining,kimi-tasks}.md`, `impl/`, `migration/`, `kimi-reports/`, `archive/` | `boards/docs/…` | перенесены 2026-11-01 (до этого отсутствовали) |
| `t-boards/tools/` | `boards/tools/` | пробы стенда и `run-int.sh`: пути от места скрипта, `lockf`/`flock` |
| `t-boards/README.md` | `boards/docs/README.md` | карта переписана под новую раскладку |
| `SUCCESSOR-PROMPT*.md` (корень) | `process/prompts/` | совпадают |
| `CLAUDE.md`, `AGENTS.md`, `ACTION-PLAN.md` инстанса | `process/model/` | эталон настройки инстанса, совпадают |
| `.claude/`, `.continue/`, `.agents/`, `.windsurf/skills/` | те же пути | совпадают; правки дома — ниже |
| `infra/{ai-council,owner-queue-mcp,owner-queue-bot,ops-console,mcp-hub,llm-gateway,headroom}` | те же пути | перенесены 2026-11-01, только файлы под git |
| `infra/scripts/dev-ai/`, `dev/wt-deps.sh`, `misc/done-index.py`, `prod/ops-deploy-event.py` | те же пути | перенесены 2026-11-01 |
| `docs/specs/{owner-queue,ai-council}.md`, `docs/ai/*` (консилиум, Ollama, TOON), `docs/plans/notion-board.md`, `docs/ops/owner-queue-cutover.md` | те же пути | перенесены 2026-11-01 |
| записи закрытого о консилиуме, DAMS, MCP, ops-консоли и очереди владельца | `docs/plans/done/{dev-tooling,ops-control}.md` | 43 записи дословно; SHA — коммиты инкубатора |
| команды `npm run mcp-hub:* / llm-gateway:* / ai-council:* / ai-pipeline:* / done:index`, `make wt-*` | корневой `package.json`, `Makefile` | перенесены; `wt-*` — под pnpm досок |

Ссылки в документах (`eval/`, `boards/docs/`, `docs/`, `infra/`) переписаны на новые пути; относительные ссылки
пересчитаны от исходного места файла. Не переписывались: команды запуска инстанса (`cd ~/… && claude --settings
supertick-eval/…`), строки про инстанс, измерения в `eval/data/`, выдержка `eval/context/supertick-src/` и
эталон `process/model/`.

## Что исправлено при сверке (дефекты первого переноса)

| Дефект | Исправление |
|---|---|
| Нет документов реализации досок (`impl-*`, `migration/`, `kimi-*`, `archive/`, пробы) — ссылки спеки и handoff вели в пустоту | перенесены в `boards/docs/`, `boards/tools/`; архив и пробы исключены из `vp check` |
| Слой ссылался на сервисы, которых нет в репозитории: консилиум (линзы GLM для адверсариальной проверки), очередь владельца (`oq_*`), MCP-хаб, шлюз моделей роя, headroom | сервисы перенесены в `infra/`, тесты дают тот же результат, что в инкубаторе; CI — `infra-ci.yml` |
| Хук `PreToolUse` звал `infra/scripts/dev/wt-deps.sh`, которого не было, — гейт worktree молча выключен | скрипт перенесён и понимает pnpm-workspace досок (`boards/` в доме, `t-boards/app/` в инкубаторе, `BOARDS_TREE`); хук ловит и `pnpm …`/`vp …`/`pnpm -C|--dir`/`make check-boards` |
| Stop-хук typecheck видел только `apps/*`/`packages/*` — правки досок не проверял | добавлен pnpm-путь для `boards/apps/*`, `boards/packages/*`; тест `test_typecheck_gate.py` |
| `genome/build.py` жёстко держал `supertick-eval`, `roles.json` — абсолютные пути Mac; тест геномов падал вне инстанса | пути инстанса — `repo_root` и `product_tree` в `eval/nerve/config.json`; `build.py --check` воспроизводит геномы байт-в-байт; тесты геномов и рефлексов — в `eval-ci.yml` |
| Консилиум искал улики только в `apps/`/`packages/`, самопроверка падала на чужом дереве (Prisma, turbo-пакеты хоста) | корни `boards/`, `eval/`, `process/`; проверки хоста — на фикстуре или явный пропуск |
| В git лежали живые папки дел `.ai/task/` (выгрузки Notion, трассы) и сгенерированный `.continue/agents/llm-gateway.yaml` — в инкубаторе оба в `.gitignore` | убраны из git, закрыты `.gitignore` |
| `docs/` отсутствовал, а базовые правила слоя ссылаются на `docs/README.md`, `docs/CLAUDE.md`, `docs/plans/done/` | заведены карта, стандарт, оглавление закрытого и модули `boards`, `eval`, `dev-tooling`, `ops-control` |
| Нет `.windsurf/skills` — `sync-agent-skills.sh --check` не проходил | зеркало пересобрано |
| Скрипты ИИ-контура подключали `infra/scripts/dev/dev-common.sh` — `npm run ai-pipeline:*`, `ollama:*` падали на первой строке | `dev-common.sh` — только помощники Ollama и локального env; скрипты предметной области хоста (роли `hr-helper-*`, его dev-стек, Open WebUI) не переносятся; `bash -n` всех скриптов — в `infra-ci.yml` |
| Гейт ссылок документации (`docs_linkcheck.py`) не переносился и падал | `npm run docs:check` и шаг `infra-ci.yml`; ссылки законов хоста на его документы — в `.claude/scripts/docs_linkcheck.host-only.txt`, считаются отдельно |

## Что сознательно не перенесено

- **Рантайм:** `nerve/state/`, `swarm/state/`, `council.db`, `.ai/task/`, `.claude/memory/session/`,
  `.claude/skill-observations/`, `.serena/`, `graphify-out/`, `node_modules`, `.env`.
- **Продуктовое хоста:** бизнес-код, его CI и деплой, `docs/` предметной области, OpenExecutive (разбор идей
  публичного сайта хоста), продуктовые скрипты `infra/scripts/{prod,misc}` кроме названных выше.
- **Документы предметной области хоста:** его SLO и алерты прода (`docs/ops/p0-slo-alerts.md`), API, QA, архитектура —
  список префиксов в `.claude/scripts/docs_linkcheck.host-only.txt`.
- **Мусор корня инкубатора:** снимки процессов и памяти (`mem.txt`, `ps.txt`, …) и посторонние заметки.

## Что остаётся инстанс-зависимым (проверить при развёртывании над новым хостом)

- `.claude/rules/02–16` и скиллы `hr-domain`, `nestjs-service`, `react-feature`, `db-migration` — законы предметной
  области первого хоста; грузятся по его `paths:` и в доме слоя не срабатывают (кроме правила 10 на `infra/**`).
- `eval/nerve/config.json` (`repo_root`, `product_tree`, репозиторий, адрес очереди, роли) и сгенерированные из него
  геномы `eval/pipeline/genome/*.json`; `infra/ai-council/config.toml` (источники, модели).
- Адрес стенда досок и туннеля (`T_BOARDS_URL`), Keychain-сервис секретов `hr-helper-mcp`, ops-консоль с SSO
  через бэкенд хоста; её бизнес-метрики (`infra/ops-console/agent/hrh-business.sh`) и встроенные P0-правила
  (`server/alerts/builtin.ts`) описывают прод хоста.
- `eval/nerve/space.hrhelper.nerve.plist` — launchd-агент Нерва с путями машины владельца.
- Адрес VPS и раскладка WireGuard упоминаются в документах и сидах досок и ops-консоли (`boards/docs/impl/impl-b4-vps.md`,
  `boards/deploy/vps/seed/`, тесты ops-консоли) — так было и до переноса; если репозиторий публичный, вынести их в
  конфиг — решение владельца.

## Ветки до реструктуризации (сведены 2026-11-01)

Ветки, ответвлённые до раскладки `boards/` + `eval/` (код досок тогда лежал в корне), перенесены в `board-agents`
коммит в коммит (`git am --directory=boards`, авторство и сообщения сохранены):

- `b12` — включает `b10`, `t-boards`, `t-boards-pilot`, `tb-wg-replies`, `completed-at`, `tb-27`: даты завершения
  карточек, роль «ИИ-агент» (TB-26), модель блокнота на инстанс (TB-67), граф связей леса и ⌘K (R-090),
  переключатель размышлений GLM, индекс `.claude/skills` в блокноте;
- `ops-15-wg-psk` — PresharedKey и MTU 1380 для новых устройств WireGuard (OPS-15).

Конфликты: импорт SSR и модели блокнота в `apps/api/src/index.ts` (оставлены оба), `openapi.json` (перегенерирован).
Миграции перенумерованы — `0077` занят `0077_tai_boards_ssr`: `0077_t_boards_completed_at` → `0078`,
`0078_t_boards_instance_setting` → `0079`; метки `when` — после SSR (иначе drizzle молча пропустил бы их на базе с
SSR), SQL сделан повторяемым (`IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`, ограничение — через `pg_constraint`), так
что база стенда, уже прогнавшая старые номера из `b12`, принимает новый набор без ошибок. Проверено на Postgres 16:
чистая база (80 миграций) и база со старым набором `b12` (79 → 82, данные и триггеры целы).

Старые вершины `b12` и `ops-15-wg-psk` вошли в историю `board-agents` merge-коммитом `-s ours` (дерево не меняется),
поэтому исходные SHA в документах (`impl-*`, капсулы, handoff) остаются достижимыми и после удаления веток.
Соответствие коммитов:

| Было | Стало | Коммит |
|---|---|---|
| `7d09764` | `8a30ffa` | feat(cards): a card keeps its end date while it sits in a final column (draft, owner review) |
| `a88f5ce` | `c671848` | fix(cards): the end-date backfill trusts only the server's status entries |
| `bbc1635` | `5314b26` | fix(cards): a column turned final again gives its cards their real end dates |
| `02b81fa` | `eba76d1` | docs(cards): say plainly which journal entries date a done card |
| `a7679fa` | `f982af3` | test(cards): wait for the journal entry before dating it |
| `304e8b4` | `f0906ed` | fix(deploy): the app hears the Mac's claude-mem proxy through the tunnel |
| `1df8edb` | `82cf88b` | fix(i18n): the RU end-date field reads «Окончание», not «Завершена» |
| `f9275c5` | `f198f68` | docs(vps): the connect form names the database the integration cannot see |
| `1dd7003` | `f2c496e` | feat(agents): a strict «AI agent» role, assigned to every session's agent (TB-26) |
| `0b275aa` | `87ca732` | feat(notebook): one model, key and daily limit per server, set by the instance admin (TB-67) |
| `3b4f038` | `0df2d48` | fix(agents): reserved agent role keeps fixed rights; agents retry following their owner (TB-26) |
| `cb3ea91` | `a5e8bca` | fix(agents): cap an agent at the agent role when rights are checked (TB-26 review) |
| `aacd324` | `4c3d945` | fix(notebook): bind the model key to its API address; read env values one by one (TB-67 review) |
| `1a7a41e` | `9634883` | fix(web): task-row tests mock the board's forest reads (TB-70) |
| `438ac7c` | `cb63574` | feat(forest): the links graph — cards, files and decisions, grouped by sector |
| `e969ffc` | `cf977b9` | chore(openapi): regenerate the spec after the links graph merge (R-090) |
| `bf7e9dd` | `86e1642` | feat(web): ⌘K reaches cards, sectors and forest tabs from the keyboard (R-090) |
| `42094e5` | `f6c90eb` | feat(notebook): a thinking switch turns off GLM reasoning in the chat |
| `5896760` | `ac28b41` | feat(notebook): the Mac sync also indexes .claude/skills |
| `26f97e4` | `005d32a` | fix(notebook): the thinking switch reaches the chat through the admin's model settings (b12) |
| `f4d5624` | `d9f1063` | fix(vps): new WireGuard peers get a preshared key and MTU 1380 (OPS-15) |
| `c89e323` | `82f5683` | fix(vps): the existing-peer hint gives the full wg-psk.sh form (OPS-15, e1) |
| `a5e3812` | `ea70718` | fix(vps): install.sh ships wg-issue.sh and wg-psk.sh; wg-psk.sh not through a pipe (OPS-15, d9) |
| `b943e45` | `f2b86c5` | fix(vps): WireGuard backups keep the newest edits; wg-psk input and selftest per QA review |

`tb-27`, `s6-notion-full` уже входили в `board-agents`; ветка dependabot обновляла `agentscan.yml`, который удалён при
реструктуризации, — закрыта без переноса.

## Разделение на машине владельца (план 02.11)

`t-boards/` и `supertick-eval/` уходят из checkout'а инкубатора, на их местах — ссылки на checkout этого
репозитория (`supertick-eval`, `eval` → `eval/`; `t-boards/app` → `boards/`), поэтому пути инстанса в геномах, plist
Нерва и MCP досок не меняются. ИИ-сервисы `infra/` и копия слоя `.claude/` пока остаются в инкубаторе. Пошагово, с
проверками и откатом — [`docs/ops/split-hr-taibe.md`](../docs/ops/split-hr-taibe.md).

## Стенд d4dev — пока собирается из инкубатора

Сейчас `d4dev.admin.hrhelper.space` собирается из checkout'а инкубатора (`t-boards/app` на Mac, образ и
`deploy/vps/bundle.sh` → ручная доставка на VPS). Изменения в этом репозитории стенд не затрагивают, пока его не
переключат. Переключение — шаг владельца:

1. Сверить, что в локальном `t-boards/app` нет коммитов, которых нет здесь (`git log` против `board-agents`); если
   есть — перенести так же, как ветки выше.
2. Бэкап базы стенда (`deploy/vps/backup.sh`).
3. Собрать образ из `boards/` этого репозитория; `bundle.sh` работает отсюда без правок (корень — папка `boards/`).
   Миграции рассчитаны на обе истории базы: с прежними `0077`/`0078` из `b12` и без них.
4. Mac-синк блокнота и SSR направить на checkout этого репозитория. Документы и реестр понимают обе раскладки
   (`supertick-eval/…` и `eval/…`, `t-boards/*.md` и `boards/docs/*.md`), но у сущностей SSR путь — часть ключа:
   после переключения геномы, промпты и Нерв появятся под путями `eval/…`, а записи `supertick-eval/…` останутся
   старыми — их нужно закрыть или переименовать (решение владельца, D-008).

## История git

Первый перенос закоммитил живые папки дел `.ai/task/` (выгрузки Notion `ai-council-backlog/raw.json`, `cards.json`,
трассы ревью) и сгенерированный `.continue/agents/llm-gateway.yaml`. Сверка убрала их из дерева, но в истории
`board-agents` они остаются (секретов и почт в них не найдено). Переписывать историю или нет — решение владельца.
