# M1 и M2 — черновик фактов и решений для спек (WIP, роль 2, линия r.85l7.auq8, 03.11 16:10 МСК)

> Это не спека, а сохранённая разведка. Наследник пишет из неё две спеки, `docs/specs/multi-product-m1-instances.md`
> и `docs/specs/multi-product-m2-state.md`, по формату `docs/specs/CLAUDE.md`, а этот файл удаляет до PR.
> Сверено с кодом `board-agents@25d73636` и живым Mac владельца 03.11 16:05.

## Факты (замерено)

- tAIBE **PUBLIC** (`gh repo view agolubenk/tAIBE`), HR — PRIVATE.
- `eval/nerve/config.json` в git. В нём абсолютные пути Mac владельца, имя приватного репо HR, адреса ops-консоли и d4dev.
  Геномы `eval/pipeline/genome/<роль>.json` тоже в git и тоже с путями.
- Кто читает `config.json`:
  - `eval/nerve/nerve.py:236` — все источники Нерва;
  - `eval/pipeline/genome/build.py:38` — `repo_root` и `product_tree` для путей хуков;
  - `.claude/scripts/pipeline_settings.py:110` — `boards`: ищет `eval/` или `supertick-eval/` в ROOT своей копии;
  - `infra/scripts/split/1-preflight.sh:41` и `test_nerve.py:21`.
- `eval-ci.yml` уже гоняет `build.py --check` для инстанса из `config.json`.
- Ключи `config.json` по уровню:
  - **продукт** — `repo_root`, `product_tree`, `team.{project_dir, roles, active_hours}`,
    `github.{repo, min_lenses, quorum_to, path_roles(16), lens_roles(22)}`,
    `queue.{source_roles(6), owner_items, secret_cmd}`, `boards.{product, workspace}`;
  - **Mac/аккаунт** — `interval_seconds`, `sources`, `system`, `budget`, `circadian`, `tap`, `queue.url`, `boards.url`.
- CLI `taibe` ещё нет (в репо ни файла, ни bin) — M1 его вводит.
- Состояние Нерва:
  - `tAIBE/eval/nerve/state/` (gitignored) — 848 КБ, 13 файлов: `journal.jsonl` 284 КБ / 982 записи,
    `state.json` 496 КБ, `mode.json`, `heartbeat`, `nerve.lock`, `nerve.log`, `tap-<роль>.json` ×7;
  - в `state.json`:
    - **продукт** — `github{etag,prs}`, `transcripts` (кэш по файлам сессий из `team.project_dir`), `errors`;
    - **аккаунт** — `budget{meter,waves,limit,…}`;
    - **Mac** — `hub`, `heartbeat`;
  - `mode.json` (phase, pause, limit_until, quota5, used5…) — аккаунт.
- **Бюджет считается по транскриптам одного `project_dir` (HR).** Окно 5 ч — общее на аккаунт Claude. Со вторым
  продуктом его сессии лежат в другой папке, и бюджет обязан суммировать все `project_dir`. Это довод за один процесс.
- Процессы:
  - демон — launchd `space.hrhelper.nerve`, RSS 4,7 МБ;
  - всего 13 процессов `nerve.py` вместе с `tap` в Monitor сессий — 58 МБ.
- Плист запускает Нерв **через ссылку HR**: `HR_Helper-v2/supertick-eval/nerve/nerve.py`, лог —
  `…/supertick-eval/nerve/state/nerve.log`. `HERE = os.path.abspath` ссылку не раскрывает, поэтому
  `nerve.py:37` берёт `HERE/../../.claude/scripts` = **`HR/.claude/scripts`**. В HR файла `pipeline_settings.py` нет
  (проверено 16:08), значит у демона `wakes_on()` → except → **всегда True**: переключатель владельца `nerveWakes`,
  возможно, не действует. **Проверить и, если так, — карточка в ОШИБКИ.** Кэш `HR/.claude/pipeline-settings.json`
  обновлён в 16:01 — кем, не выяснено. `tap` из tAIBE берёт копию tAIBE.
- Рой: `eval/swarm/state/` пуст, там только `swarm.lock`. Кэш настроек — `<ROOT копии>/.claude/pipeline-settings.json`,
  TTL 10 мин, < 1 КБ.
- База консилиума: `HR/.claude/council/council.db` 1,09 ГБ + бэкап 0,53 ГБ + логи 63 МБ. Сервис `infra/ai-council`
  работает из HR (`mcp_server.py` ×5).
- `deploy-contabo.yml` paths-ignore: `docs/**`, `**/*.md`, `.claude/**`, mobile. **`infra/**` деплоит прод HR.**
- Нерв уже умеет `NERVE_STATE_DIR` (`nerve.py:30`).

## M1 — решения (инженерные, мои)

- Файлы `instances/<slug>.json` (поля продукта), `instances/_shared.json` (Mac и аккаунт, `default_product`),
  JSON Schema — `instances/schema.json`.
- **`eval/nerve/config.json` остаётся, но генерируется:** `_shared` ⊕ продукт по умолчанию, json-равен нынешнему.
  Отклонено: «читатели берут loader вместо config.json». Тогда копия `pipeline_settings.py` в продуктах и пути через
  ссылки HR ломаются до синка M4. Удаление `config.json` — в M3.
- Команды:
  - `python3 -I eval/tools/taibe.py products list|add|check|render` + sh-обёртка `./taibe`; только stdlib;
  - `render --check` — exit 1, если `config.json` устарел; шаг в `eval-ci`;
  - `check` только читает: папка — git-checkout с remote = `github.repo`; `product_tree` есть; `project_dir` есть
    (warn); роли ⊂ `roles.json`; `path_roles`/`lens_roles`/`source_roles` ссылаются на роли продукта; доска находится
    (сеть; `--offline` пропускает); `build.py --check` зелёный.
- Правила:
  - секретов в файлах нет, только `secret_cmd`;
  - slug неизменяем;
  - `add` не меняет `default_product` без `--default`.
- Приёмка:
  - AC1: `render --check` = 0 и `cmp config.json` с `25d73636` пуст;
  - AC2: `build.py --check` = 0;
  - AC3: `products check hr-helper` ок на Mac;
  - AC4: негативы — чужая роль в `path_roles`, плохой slug, ручная правка `config.json` → exit 1;
  - AC5: `add demo` во временной папке → 2 продукта, `config.json` не изменился;
  - AC6: `test_nerve` и `test_genome` зелёные.
- Откат — revert PR, `config.json` байт-в-байт прежний.
- Мёрж в board-agents прод не деплоит. Основной checkout tAIBE получит изменения только по `git pull` владельца.

## M1 — развилки владельцу (через Координатора r.qaly)

- **Р1. Где хранить файлы продуктов.**
  - **А, рекомендую** — в git tAIBE, как сейчас. M1 не публикует ничего сверх того, что уже лежит в `config.json`,
    и есть история.
  - **Б** — локально, gitignore + пример в git. Снятые с учёта `config.json` и геномы при `git pull` основного
    checkout **удалятся**, и Нерв останется без конфига до `render`. CI видит только пример.
  - **В** — разделить: нейтральная часть в git, машинные и приватные поля — в `<slug>.local.json`. Те же риски, что
    у Б, и два файла на продукт.
  - Решение о приватности — до M7: второй продукт будет публичным при варианте А.
- **Р2. slug.**
  - **Рекомендую** собственный, `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, неизменяемый; HR → `hr-helper`.
  - Отклонено: slug доски (меняется при переименовании и ломает `state/<slug>`) и имя репо (`HR_Helper-v2`: регистр и
    `_`; у продукта может не быть своего репо).

## M2 — решения

- Раскладка:
  - `state/` в корне tAIBE (gitignored);
  - `state/_shared/nerve/` — budget, mode, hub, heartbeat, lock, log;
  - `state/<slug>/nerve/` — journal, tap-курсоры, `state.json` (github, transcripts, errors);
  - `state/<slug>/swarm/` и `state/<slug>/pipeline-settings.json`.
- События аккаунта (`budget.warn`, `limit.hit`/`limit.resume`) пишутся в журнал **каждого** продукта с тем же ключом
  идемпотентности, поэтому `tap` читает один журнал.
- `tap <роль> [--product <slug>]`; без флага — `default_product`, так что сегодняшние команды Monitor работают.
- Бюджет суммирует `project_dir` всех продуктов.
- Скрипт `eval/tools/state_migrate.py --product hr-helper --check|--apply|--rollback`:
  - check: та же ФС (`st_dev`, тогда `mv` — атомарный rename), цели нет, демон остановлен;
  - apply: бэкап `state/_backup/m2-<ts>.tgz` → `launchctl bootout` → `mv eval/nerve/state state/hr-helper/nerve` →
    вынести общие ключи в `_shared` (оригинал — `state.json.pre-m2`) → ссылка `eval/nerve/state` →
    `../../state/hr-helper/nerve` (для старых `tap` и путей через ссылки HR до M3) → новый плист **на путь tAIBE**,
    не через HR → bootstrap → ждать свежий heartbeat ≤ 2 мин;
  - rollback — обратный порядок.
  - Переключение — в ночной фазе, с «да» владельца (пункт очереди): Нерв стоит меньше 1 мин.
- Внимание: смена пути плиста меняет копию `pipeline_settings`, которую видит демон (см. факт выше), — в приёмку.
- Приёмка:
  - Нерв будит роли HR как до M2: те же события в `tap` за 30 мин до и после;
  - пустой второй продукт `demo` не меняет журнал HR;
  - `--rollback` возвращает байт-в-байт: `tar` + `cmp`;
  - `test_nerve` зелёный с двумя продуктами в фикстуре.

## M2 — развилки

- **Р3. Один процесс Нерва или по процессу на продукт.**
  - **А, рекомендую**, как и дорожная карта: один процесс. Бюджет и лимит общие на аккаунт, system/hub — на Mac.
    У процесса 4,7 МБ, один launchd-агент. Таймаут и изоляция ошибок — на продукт (`errors` уже по источникам).
    Худший случай: 2 продукта × 4 источника × 20 с `gh` = 160 с > интервала 60 с, поэтому нужен общий дедлайн прохода.
  - **Б** — по процессу на продукт. Нужен отдельный лидер для бюджета, иначе `budget.warn` уйдёт N раз и N раз
    прочитаются все транскрипты. Плюс N агентов.
- **Р4. Отклонение от утверждённой карты.**
  - В карте база консилиума — в M2. **Рекомендую перенести её в M5** вместе с сервисом:
    - сервис работает из HR, база занята 5 процессами `mcp_server`;
    - 1,6 ГБ;
    - смена пути в `infra/ai-council` HR — это `infra/**`, то есть **деплой прода HR**.
  - Кэш настроек: в M2 — только для копии tAIBE. Копия в продукте — через синк M4. Два кэша < 1 КБ, по запросу раз в
    10 мин, — допустимо.

## Что осталось наследнику

1. Проверить факт «демон → `HR/.claude/scripts` без `pipeline_settings.py` → `nerveWakes` не действует»:
   `python3 -I -c` с тем же `sys.path` или по `nerve.log`. Если подтвердится — карточка в ОШИБКИ.
2. Написать две спеки из этого файла, удалить черновик, поправить строки M1/M2 в
   `docs/plans/roadmap/multi-product.md` (ссылка на спеку).
3. Адверсариальная проверка: x ≥ 3 линзы консилиума GLM (по умолчанию, без отдельного «да»). Для M2 x = 4–5 —
   данные и launchd.
4. Commit, push ветки `feature/multi-product-m1-m2-spec` (upstream снят — `git push -u origin HEAD`), PR в
   board-agents.
5. Развилки Р1–Р4 — Координатору r.qaly одним пакетом, d-пункты выставляет он.
