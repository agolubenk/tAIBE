# MCP-хаб — общие MCP-серверы для всех ИИ-клиентов

Один набор MCP-серверов, один набор секретов и одна OAuth-авторизация для всех ИИ-клиентов:
Copilot Chat (с любой моделью, в том числе GLM/Kimi/OpenAI-провайдеры), Continue, Roo Code, Kimi Code,
Codex и Claude Code. Без хаба у каждого клиента своя копия серверов. Serena тогда индексирует монорепо
несколько раз, по ~2 ГБ RAM на копию, и копии мешают друг другу стартовать. Секреты и OAuth при этом
настраиваются в каждом клиенте отдельно.

```
                       ┌──────────────── 127.0.0.1:3050/mcp  (1mcp 0.39.3) ────────────────┐
Copilot Chat ─┐        │ serena → :9121 · dams-rag · ai-council · headroom · git (чтение)   │
Continue ─────┼──────► │ postgres-readonly (схема) · docker · markitdown · context7         │
Roo · Kimi ───┤        │ github (gh-токен) · notion/sentry/cloudflare (OAuth)               │
Codex ────────┘        │ t-boards → d4dev через туннель (ключ API)                          │
                       └────────────────────────────────────────────────────────────────────┘
Claude Code ──────────────► 127.0.0.1:9121/mcp  (serena хоста напрямую; остальное — из .mcp.json)
Claude Code в tAIBE ──────► 127.0.0.1:9122/mcp  (serena-taibe по требованию: `serena` из .mcp.json tAIBE, см. «Две serena»)
```

Хаб даёт инструментам префикс `<сервер>_1mcp_<tool>`, например `serena_1mcp_find_symbol`. Claude Code
поэтому ходит в serena напрямую: на имена `mcp__serena__*`, `mcp__ai-council__*` и т.п. завязаны агенты
(`scout`) и permissions, и переименование их сломало бы. Остальные серверы Claude Code берёт из
`.mcp.json`, как раньше.

Исключение по желанию — OAuth-серверы (notion, sentry, cloudflare, context7) и t-boards: одна запись `hub` с
`?tags=oauth,connector,boards` (команда в таблице ниже, scope `local` — только у вас и только в этом проекте), и вход
отдельно для Claude Code больше не нужен. Имена инструментов при этом другие
(`mcp__hub__notion_1mcp_notion-fetch` вместо `mcp__notion__notion-fetch`): правила `permissions` в
личных settings продублировать под новые имена, а прямые копии выключить в `.claude/settings.local.json`
(`disabledMcpjsonServers` + `enabledPlugins."context7@claude-plugins-official": false`). Хаб не
запущен — этих четырёх у Claude Code нет, как и serena.

## Хост и продукты

Хаб один на Mac владельца (`:3050`) для всех продуктов; код и эксплуатация — tAIBE, роль ops слоя (`infra/CLAUDE.md`).
Команды — из основной папки tAIBE (`npm run mcp-hub:*`). В HR те же `npm run mcp-hub:*` — алиасы (решение владельца):
обёртка HR `infra/scripts/dev-ai/taibe-dev-ai.sh` зовёт код tAIBE с хостом — основной папкой HR (OPS-42).

- **Хост** — продукт, чьи пути получают серверы с хостом (serena `:9121`, git, dams-rag, postgres-readonly, ai-council); сейчас HR.
  Как выбирается — абзац «Хост» в «Две serena». serena tAIBE (`:9122`) — по требованию, с 08.11 выключена.
- **Продукт** видит хаб через свой срез `?tags=` у клиента; срез — не граница доверия, копии серверов под продукт —
  только по замеру (раздел «Подключение клиентов», OPS-43).
- **Не менять реальный путь папки состояния** `~/.config/hr-helper-mcp-hub/`: 1mcp привязывает хранилище OAuth к
  realpath этой папки (`auth/storage/protectedRecordStorage.js`, `canonicalPath` → `fs.realpathSync`, 1mcp 0.39.3).
  Перенос или переименование — повторный вход во все OAuth-серверы и клиенты. Имена с `hr-helper` (папка, логи
  `~/Library/Logs/hr-helper-mcp-hub/`, LaunchAgent `space.hrhelper.mcp-hub`) остаются; новое имя — только ссылкой на
  старую папку, не наоборот (OPS-46, отложено).

## Запуск

В VS Code всё делает задача **«MCP: старт и авторизация»** (`.vscode/tasks.json`, `runOn: folderOpen`):
при открытии папки она поднимает serena и хаб и открывает авторизацию тем, кто её ждёт. Файл не
закоммичен: в общем репо задача запускалась бы у всех при открытии папки, это решается отдельно.
При первом открытии VS Code спросит «Allow automatic tasks», нужно разрешить. Остальные задачи группы `MCP:` (статус, авторизация, рестарт, логи, стоп) — через
Terminal → Run Task. Из терминала то же самое:

```bash
npm run mcp-hub:init      # start + auth (то, что делает задача при открытии папки)
npm run mcp-hub:auth      # открыть авторизацию заново, без суточного ограничения
npm run mcp-hub:start     # serena хоста (+ serena-taibe, если включена; до минуты на первый старт LSP) + хаб; печатает статус, код 1 — если что-то не поднялось
npm run mcp-hub:status    # кто готов / ждёт OAuth / упал; сироты, чужой процесс на порту, привязка к терминалу
npm run mcp-hub:logs      # хвосты ~/Library/Logs/hr-helper-mcp-hub/{serena,serena-taibe,hub}.log (прошлый запуск — *.log.prev)
npm run mcp-hub:restart   # после обновления serena или если хаб потерял сессию к ней
bash infra/scripts/dev-ai/mcp-hub.sh restart hub   # только агрегатор, за секунды, без переиндексации serena
bash infra/scripts/dev-ai/mcp-hub.sh check         # код 0, только если serena, хаб (и serena-taibe, если включена) живы, держат порты, обслуживают свои папки и отвечают
npm run mcp-hub:serena-taibe -- on|off|status      # вторая serena (tAIBE, :9122) — по требованию, см. «Две serena»
npm run mcp-hub:stop      # освободить память (хаб и обе serena)
npm run ai:restart-all    # хаб + serena + AI Council разом (кнопка «⟳ ИИ: всё» в строке состояния VS Code)
npm run ai:status-all     # сводный статус хаба, консилиума и его очереди (пауза — кто, когда, зачем)
```

`init`, `start`, `restart`, `sync`, `connect`, `disconnect` и `npm run ai:restart-all` — только из основной папки
репо, из связанного worktree скрипт отказывает с подсказкой `(cd <основная папка> && npm run …)`. Serena индексирует ту
копию, из которой её подняли, а после `git worktree remove` осталась бы на несуществующем каталоге; stdio-серверы хаба
работали бы на коде worktree; `sync`, `connect` и `disconnect` переписали бы живой конфиг шаблоном worktree (OPS-42).
Осознанно обслуживать копию worktree — `MCP_HUB_ALLOW_WORKTREE=1`. `status`, `check`, `stop`, `logs` работают
откуда угодно; `status` предупреждает, а `check` возвращает 1, если serena (`--project`) или хаб (рабочий каталог)
обслуживают не основную папку.

Кнопки «⟳ ИИ: всё» / «ИИ: статус» / «Консилиум» в строке состояния — задачи с `options.statusbar`
в `.vscode/tasks.json`, показывает их расширение `actboy168.tasks` (без него — Terminal → Run Task…).

При входе в систему хаб и serena поднимает LaunchAgent — включается один раз, из основной папки:

```bash
npm run mcp-hub:autostart -- on       # LaunchAgent space.hrhelper.mcp-hub; сразу же делает start
npm run mcp-hub:autostart             # включён ли, код последнего запуска, хвост журнала autostart.log
npm run mcp-hub:autostart -- off      # убрать; запущенные хаб и serena продолжают работать
```

Цепочка: LaunchAgent → `open` приложения `~/Applications/HR Helper MCP Hub.app` → `mcp-hub.sh start`. Приложение —
одна строка AppleScript: репо лежит в `~/Desktop`, а процессы, которые launchd запускает напрямую, macOS туда не
пускает (`/bin/bash: …/mcp-hub.sh: Operation not permitted`, код 126). Доступ к «Рабочему столу» получает это
приложение, а не `/bin/bash` целиком. Если macOS спросит — разрешить; запрет снимается в «Конфиденциальность и
безопасность → Файлы и папки».

PATH (python3 с пакетом `mcp`, node, uvx; gh — если есть) и папка репо зашиты в само подписанное приложение при `on`:
у launchd PATH голый. Отдельного скрипта рядом нет — иначе любой процесс пользователя мог бы его переписать и
выполниться с доступом приложения к «Рабочему столу». Без python3 с пакетом `mcp`, node или uvx в PATH `on` откажет. Сменили
Python или перенесли репо — повторить `on`: приложение пересоберётся, и macOS спросит доступ снова (новая подпись).
Ничего не изменилось — повторный `on` приложение не трогает. Осталось открытым: сами node, python3 и uvx из
Homebrew пользователь может подменить — их приложение запускает с тем же доступом.

`open` при входе повторяется до 10 раз через 3 с (LaunchServices бывает ещё не готов). launchd видит только код
`open`; код самого `start` — строка `== код N` в `autostart.log`. `autostart` (status) показывает весь последний
запуск и предупреждает, если приложение не совпадает с командой или по его PATH больше нет node, uvx или python3 с
`mcp`. Сверка — по PATH, с которым приложение собрано (он лежит в Info.plist), так что терминал с другим PATH ложной
тревоги не даёт. Журнал больше 1 МБ при
запуске обрезается до последних 256 КБ; в него пишет только `start` — у хаба и serena свои журналы. KeepAlive нет: упавший сервис поднимает следующий `start` или
задача VS Code.

Если хаб не запущен, у клиентов пропадают его инструменты, остальное работает. Закрытие терминала или конец задачи
VS Code хаб и serena больше не останавливает (см. «Старт и стоп» ниже).

1mcp ставится не через `npx`, а в `~/.config/hr-helper-mcp-hub/runtime/` (версия зашита в скрипте,
`ONE_MCP_VERSION`): путь стабилен, и в админку можно встроить ссылки хаба.

## Старт и стоп: как устроено

Разбор поломки 2026-10-21 («команды не работают»), три причины и что сделано:

- **Хаб умирал вместе с задачей VS Code.** Задача идёт в pty; когда её shell выходит, ядро шлёт SIGHUP
  группе процессов переднего плана. Хаб запускался через `nohup … &` в этой же группе, а 1mcp ставит свой
  обработчик SIGHUP (`process.on("SIGHUP", shutdown)`) и этим отменяет `nohup`: в `hub.log` — «Shutting
  down server...» без ошибки ровно в момент конца задачи. Serena (python) SIGHUP игнорирует и выживала.
  Теперь оба процесса стартуют в своей сессии и группе (`setsid` через python3 — в macOS нет `setsid(1)`),
  терминал до них не дотягивается; PGID == PID.
- **Stop оставлял сирот serena.** Гасился только pid из файла (обёртка `uvx`), а python serena на SIGTERM не
  выходит 10+ с. Теперь stop шлёт TERM всей группе, ждёт до 10 с и добивает KILL; процессы, запущенные
  по-старому (не лидеры группы), гасятся по снимку дерева потомков. Пережило KILL — stop пишет это и
  возвращает 1. Чужие процессы не трогаются никогда: «свои» узнаются по программе и командной строке
  (serena — программа `uv`/`uvx`/`serena`, `serena start-mcp-server`, `--project <основная папка>`,
  HTTP-транспорт, наш порт; хаб — программа `1mcp`, `1mcp serve --config <наш mcp.json>`, наш порт).
  Программа — argv[0], у интерпретатора (bash, node, python) — его скрипт: цикл ожидания или монитор, в
  аргументах которого есть та же строка, своим не считается.
- **Две serena после перезагрузки и «порт занят» своей же сиротой.** Два окна VS Code почти одновременно
  выполняют folderOpen-задачу `init`. Теперь start/stop/restart идут под замком
  (`~/.config/hr-helper-mcp-hub/lifecycle.lock`; владелец — pid и время старта, записанное в локали C и UTC:
  иначе вызов из русского терминала и вызов агента читали бы одно время по-разному и сочли бы живого
  владельца умершим). Замок умершего снимается, свой замок вызов снимает, только если он всё ещё его.
  Второе окно ждёт до 5 мин и видит уже запущенное. Если порт держит «своя» копия без pid-файла, она берётся
  под управление вместо отказа; лишние копии, которые порт не держат, останавливаются (~2 ГБ RAM каждая).
  Порт держит чужой процесс — понятная ошибка с его pid, а хаб всё равно стартует.

После открытия порта start через 3 с перепроверяет процесс и порт: умер — код 1 и хвост лога; жив, но порт
отпустил — тоже код 1, процесс останавливается. Прошлый лог сохраняется в `*.log.prev` — в нём причина, по
которой упал прошлый запуск. `npm run ai:restart-all` заканчивается `mcp-hub.sh check` и возвращает 1, если
хаб или serena не работают.

Тест — `bash infra/scripts/dev-ai/tests/mcp-hub-detach.test.sh` (~4 мин): pty и SIGHUP, настоящий 1mcp на
свободном порту с временным конфигом, две подставные serena (`tests/fixtures/`), сироты, «наблюдатели» с той же
командной строкой, осиротевший член группы, чужой порт, запуск по-старому, протухший замок, замок под разными
локалями и TZ, serena удалённого worktree, отказ из worktree, бинарь serena и усыновление serena, запущенной
старой строкой uvx, шаблоны без перезаписи, хост из живого конфига и отказ при битом, предохранители read_only и
одной папки, serena-taibe по требованию (без метки не стартует, on/off, restart, check). Боевые порты и каталоги не трогает: каталоги
и `uvx` переопределяются переменными `MCP_HUB_CONFIG_DIR`, `MCP_HUB_RUNTIME_DIR`, `MCP_HUB_LOG_DIR`,
`MCP_HUB_UVX`, serena — `SERENA_BIN`, `SERENA_HOME`, `SERENA_TAIBE_PROJECT`, ожидания — `MCP_HUB_STOP_WAIT`,
`MCP_HUB_SETTLE_WAIT`, порты — `MCP_HUB_PORT`, `SERENA_HTTP_PORT`, `SERENA_TAIBE_PORT`. У нестандартного порта
свои pid-файлы и логи (`serena-<порт>.pid`, `serena-taibe-<порт>.pid`, `hub-<порт>.log`): переопределённый порт
без своего каталога не трогает учёт боевых сервисов. Вариант `host` у `render_config.py` —
`python3 -I -m unittest discover -s infra/mcp-hub -p 'test_*.py'` (`make check-infra`).

## Две serena

| Экземпляр | Порт | Индексирует | Дашборд | pid · лог |
|---|---|---|---|---|
| `serena` | `:9121` (`SERENA_HTTP_PORT`) | продукт-хост `HOST_ROOT` (HR) | есть — ссылка в админке хаба | `serena.pid` · `serena.log` |
| `serena-taibe` | `:9122` (`SERENA_TAIBE_PORT`) | сам tAIBE — основная папка (с `MCP_HUB_ALLOW_WORKTREE=1` — копия worktree) | нет (`--enable-web-dashboard False`) | `serena-taibe.pid` · `serena-taibe.log`; метка `serena-taibe.enabled` |

Обе — только на чтение: индекс один на все сессии, а сессии работают в своих worktree, поэтому правка через
serena попала бы в основную папку владельца. Код: `lib/mcp-hub-serena.sh`, узнавание «своих» — `cmd_matches` в
`mcp-hub.sh`.

**serena-taibe — по требованию** (решение владельца 08.11, пункт очереди `d-serena-taibe-ram-0811`: память машины).
По умолчанию она выключена. Включает её метка `~/.config/hr-helper-mcp-hub/serena-taibe.enabled` — личный выбор
рядом с конфигом, как `connectors.enabled` (у нестандартного порта своя, `serena-taibe-<порт>.enabled`):

```bash
npm run mcp-hub:serena-taibe -- on       # метка + старт сейчас (из основной папки, под замком); serena и хаб не трогает
npm run mcp-hub:serena-taibe -- off      # снять метку и остановить
npm run mcp-hub:serena-taibe             # status: включена ли и работает ли
```

`start`, `restart`, `init`, `ai:restart-all` и автозапуск поднимают serena-taibe только с меткой; `stop` гасит её
всегда (метка остаётся — следующий `start` вернёт); `restart hub` — по-прежнему только агрегатор. `status` без метки
пишет «serena-taibe: выключена (по требованию) — включить: …», а работающую без метки — с предупреждением. `check`
без метки serena-taibe не проверяет (выключена по решению — не ошибка); с меткой и без `:9122` — код 1.

**Память.** Замер 08.11 (vmmap по всему дереву процессов): serena HR ≈ 3,0 ГБ, из них tsserver 2,7 ГБ; своп 27,5 из
28,7 ГБ. По `footprint` 07.11 (через час после старта): python 173 МБ, typescript-language-server 22 МБ, tsserver
partialSemantic 86 МБ, tsserver semantic 2 765 МБ (без `--max-old-space-size`). serena-taibe — оценка 1–1,5 ГБ, не
измерена: ~5 000 файлов (ts 3 479, tsx 1 137, mjs/js 175 — `boards/`; py 224 — `eval/`, `infra/`). Python LS
(pyright) не видит `ignored_paths` serena: без `pyrightconfig.json` в корне tAIBE он перебрал бы ~8 300 файлов .py,
из них ~8 100 — в `worktrees/`; корневой `pyrightconfig.json` их исключает. Замер после включения (через час работы
сессий, по всему дереву — python, typescript-language-server, оба tsserver, pyright):

```bash
root=$(cat ~/.config/hr-helper-mcp-hub/serena-taibe.pid)
all() { echo "$1"; for c in $(pgrep -P "$1"); do all "$c"; done; }
for p in $(all "$root"); do footprint "$p" 2>/dev/null | sed -n 1p; done   # «Footprint: N MB» по процессам
sysctl vm.swapusage
```

**Версия закреплена** — `SERENA_PIN` (2.1.1.dev0, `ede329aaf0c824bea75455a2926f01420d7aa620`). Порядок запуска:
бинарь `SERENA_BIN` (по умолчанию `~/.local/bin/serena`, если исполняемый) → `serena start-mcp-server …`; без него —
`uvx --from git+https://github.com/oraios/serena@<SERENA_PIN> serena …`, но uvx на старте нужна сеть (при входе в
систему её может не быть). Бинарь другой ревизии — `start` предупреждает по квитанции uv рядом с ним. Поставить или
обновить бинарь:

```bash
uv tool install --force "git+https://github.com/oraios/serena@ede329aaf0c824bea75455a2926f01420d7aa620"
uv tool install -p 3.13 pyright==1.1.403   # Python LS serena: без него uvx тянет pyright из кэша и сети при старте
npm run mcp-hub:restart   # serena перезапустятся на нём (HR переиндексируется, около минуты; serena-taibe — если включена)
```

Работающие serena, поднятые раньше старой строкой (`uvx --from git+https://github.com/oraios/serena`, без `@`),
`start` усыновляет, а не убивает и не задваивает: «свою» узнаёт по `serena start-mcp-server`, порту, `--project` и
транспорту, а не по версии. На закреплённую версию они переходят при следующем `restart`.

**Шаблоны** (`infra/mcp-hub/serena/`) — перед запуском serena, если файла нет; есть и отличается — остаётся как есть,
`start` предупреждает и печатает `diff -u`:

- `claude-code.context.yml` → `~/.serena/contexts/claude-code.yml` (`SERENA_HOME`): контекст обеих — только чтение,
  без инструментов правки, оболочки и памяти serena, подсказка про пути worktree. Serena берёт его раньше встроенного
  — для любой serena этой машины с `--context claude-code`, в том числе stdio-serena продукта terminal
  (`terminal/.mcp.json`). Файл положен 07.11 вручную; скрипт кладёт его, только если файла нет.
- `taibe.project.yml` → `<tAIBE>/.serena/project.yml` (каталог в `.gitignore`): `read_only: true`, TypeScript и
  Python, без `worktrees/`, `node_modules`, `dist`, состояния `eval/*/state` и `.ai/task`. В файле все ключи
  закреплённой версии: неполный serena пересохраняет при каждой загрузке, и копия всегда отличалась бы от шаблона.
  У HR свой `.serena/project.local.yml` в его checkout (не в git, `read_only: true`). Первый старт `serena-taibe`
  дописывает tAIBE в `projects:` файла `~/.serena/serena_config.yml` — это делает сама serena.

**Предохранители запуска** (`spawn_serena`, `serena_project_check`): serena не стартует, если в
`.serena/project.local.yml` (он главнее) или `project.yml` её проекта нет `read_only: true` — без файла serena создала
бы свой с `read_only: false`, и все сессии правили бы основную папку; и если в них задан `activation_command` — его
serena выполняет оболочкой при каждом старте (путь доверенный), а хаб стартует при входе в систему. `serena` хоста не
стартует и на папке `serena-taibe`: это была бы вторая копия того же индекса. Остальные сервисы при этом
поднимаются, код `start` — 1. Файлы `.serena/` не в git: предохранитель проверяет их на каждом запуске.

**Хост** (`HOST_ROOT` у `serena`, `resolve_roots`): `TAIBE_HOST_ROOT`, если задан; иначе — хост, который обслуживает
живой конфиг хаба (`render_config.py host`, тот же источник, что у `status` и предохранителя `sync`); и только без
живого конфига (или хоста в нём) — обслуживаемая копия. Живой конфиг есть, а хост из него не взят (битый JSON,
несколько хостов, каталога нет) — `start`, `restart`, `init` и `autostart on` отказывают с причиной и подсказкой
`TAIBE_HOST_ROOT=<хост>`; `status`, `check`, `stop` работают. Без `TAIBE_HOST_ROOT` любая команда печатает, какой
хост выбран и почему. 07.11 `start` без `TAIBE_HOST_ROOT` взял папку tAIBE, счёл serena HR «чужой копией» и оставил
`:9121` пустой — теперь он берёт HR из живого конфига. Автозапуск по-прежнему передаёт `TAIBE_HOST_ROOT` явно.

**Маршрут Claude Code.** User-scope `serena` — `:9121` (HR, `~/.claude.json`). В `.mcp.json` tAIBE — `serena` на
`:9122`: одобренная, она в сессиях tAIBE перекрывает user-scope, имена `mcp__serena__*` те же. Неодобренная
пропускается, и сессия остаётся на serena HR (предположение, не проверено). **Включить для сессий tAIBE — два шага:**
`npm run mcp-hub:serena-taibe -- on` и владелец добавляет `"serena"` в `enabledMcpjsonServers` (действует в новых
сессиях; в открытой — `/mcp`). Выключить — оба в обратную сторону: одобренная, но выключенная serena-taibe не
ломает сессию (сервер, который не подключился, Claude Code показывает в `/mcp` как упавший, а сессия работает —
так в этой сессии упал сервер `ide`), но и на serena HR она не откатывается: одноимённый проектный сервер её
перекрывает, и у сессии нет `mcp__serena__*` вовсе (предположение) — агенты, которые на них завязаны (`scout`),
работают через Grep и Read. Отказ соединения на `127.0.0.1` мгновенный, ожидания `MCP_TIMEOUT` нет (предположение).
Одобрение — `enabledMcpjsonServers` в `.claude/settings.local.json`
папки сессии (файл не в git и защищён merge-guard — правит владелец). Сейчас (07.11) в основной папке там
`github, notion, docker, ai-council, owner-queue` — `serena` надо добавить. Worktree Claude Code (`.claude/worktrees/*`)
получает копию этого файла из основной папки при создании (`.worktreeinclude`), уже созданные — нет. У worktree
`worktrees/<трек>/<тема>` (`git worktree add`, `make wt-*`) этого файла нет совсем: серверы `.mcp.json` там не
одобрены. Ключ `enabledMcpjsonServers` в `~/.claude/settings.json` закрыл бы все папки разом, но одобрил бы и
stdio-`serena` из `terminal/.mcp.json` (по копии serena на сессию). Проверка в сессии: `/mcp` — `serena` с адресом
`:9122`, начальный промпт serena называет продукт tAIBE. Плагин `serena@claude-plugins-official` (`.claude/settings.json`)
— отдельный сервер с другими именами (`mcp__plugin_serena_serena__*`), его это не касается.

**Откат:**
1. `npm run mcp-hub:serena-taibe -- off` и `npm run mcp-hub:stop` — новым скриптом, пока он на месте: старый
   `serena-taibe` (`:9122`) своей не считает и оставил бы её работать; метку `serena-taibe.enabled` он не читает. Уже откатили — `lsof -nP -iTCP:9122 -sTCP:LISTEN` покажет pid, его группу —
   `kill -TERM -<pid>`.
2. Revert этого изменения в основной папке; `"serena"` из `.mcp.json` уходит вместе с ним (из
   `enabledMcpjsonServers` убрать вручную).
3. `npm run mcp-hub:start` (с `TAIBE_HOST_ROOT=<HR>` — старый скрипт без него снова возьмёт папку tAIBE).
4. По желанию: `rm <tAIBE>/.serena/project.yml`; контекст `~/.serena/contexts/claude-code.yml` — удалить и
   перезапустить serena, если нужен встроенный.

## Админка: ссылки на серверы

На <http://127.0.0.1:3050/admin/servers> у каждого сервера есть «инструменты ↗» (его страница с
инструментами в новой вкладке) и ссылки на собственный UI: дашборды serena и Headroom, консилиум,
GitHub, Notion и т.д. Справа внизу на этой странице — панель «Ссылки хаба» с тем же набором. Она не
зависит от вёрстки 1mcp и работает, даже если ссылки рядом с именами после обновления 1mcp не
встанут.

- Ссылки — `infra/mcp-hub/links.json`. Подстановка `${SERENA_DASHBOARD}` — фактический порт
  дашборда serena (первый свободный от 24282).
- Код — `infra/mcp-hub/admin/hub-links.js`. Встраивается в `index.html` админки при каждом `start`
  и `sync` (`patch_admin` в `mcp-hub.sh`), поэтому переустановка 1mcp его не теряет.
- После правки `links.json` выполнить `npm run mcp-hub:sync` и обновить страницу.

## OAuth (notion, sentry, cloudflare)

`init`/`auth` открывают авторизацию сами:

- **Серверы хаба.** Ссылка на авторизацию каждого сервера в статусе `awaitingOAuth` открывается в
  браузере. Вход разовый и общий для всех клиентов хаба. Вручную — <http://127.0.0.1:3050/oauth>
  → **Authorize**. Консоль просит войти: учётка `operator` создаётся один раз командой
  `npm run mcp-hub:admin`, пароль — в Keychain (`hr-helper-mcp` / `MCP_HUB_ADMIN_PASSWORD`). Голый
  `1mcp admin bootstrap` из подсказки консоли не подходит: он создаёт учётку для `~/.config/1mcp`, а не
  для этого хаба. Токены хранит 1mcp в `~/.config/hr-helper-mcp-hub/`.
- **Remote-серверы самого Claude Code** (`.mcp.json` и плагины, `claude mcp list` → «Needs
  authentication») — `claude mcp login <имя>` по очереди, в терминале задачи (Ctrl+C пропускает
  текущий). Без терминала `claude mcp login` не работает, тогда `init` только печатает подсказку.
  Это отдельный вход: у Claude Code свои записи этих серверов (см. выше про имена инструментов).

`init` открывает страницу одного сервера не чаще раза в сутки, чтобы каждое открытие папки не плодило
вкладки. `npm run mcp-hub:auth` открывает всё заново сразу. Сервер, который авторизовывать не нужно,
лучше выключить: `"disabled": true` в `mcp.json` хаба, или убрать из `enabledMcpjsonServers` у Claude
Code. context7 работает без авторизации (анонимный лимит).

## Подключение клиентов

| Клиент | Где | Запись |
|---|---|---|
| Copilot Chat | `~/Library/Application Support/Code/User/mcp.json` | `"hr-helper-hub": {"type": "http", "url": "http://127.0.0.1:3050/mcp?app=vscode"}` |
| Continue | `.continue/config.yaml`, `.continue/agents/glm-only.yaml` | `type: streamable-http`, `url: …/mcp?app=continue&tags=…` |
| Roo Code | `…/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | `{"type": "streamable-http", "url": "…/mcp?app=roo"}` |
| Kimi Code | `~/.kimi-code/mcp.json` | `{"url": "…/mcp?app=kimi"}` |
| Codex | `codex mcp add hr-helper-hub --url …/mcp?app=codex` | — |
| Claude Code | `claude mcp add -s user -t http serena http://127.0.0.1:9121/mcp`; OAuth-серверы и t-boards — `claude mcp add -s local -t http hub "http://127.0.0.1:3050/mcp?app=claude-code&tags=oauth,connector,boards"` | serena; notion, sentry, cloudflare, context7, t-boards и подключённые коннекторы (по желанию, см. ниже). Отдельной записи `t-boards` (`/api/mcp`, OAuth) у Claude Code нет: один маршрут — через хаб. Запись `hub` добавлена раньше, без `boards`, — t-boards в ней молча нет: `claude mcp remove hub -s local` и добавить заново командой слева |

`?tags=` отдаёт клиенту срез хаба. Это важно там, где схемы всех инструментов уходят в каждый запрос к
модели (у Continue на GLM). Теги серверов: `code` (serena, dams-rag), `project` (ai-council,
dams-rag), `context` (headroom), `docs` (markitdown, context7), `git` (git), `db`
(postgres-readonly), `infra` (docker), `remote` (github, notion, sentry, cloudflare, t-boards), `boards` (t-boards), `memory` (mcp-search).

Срез — не граница доверия (OPS-21): auth у хаба выключен. Копию сервера под продукт (`git-taibe` и т. п.) заводите
только по факту вызовов — замер `python3 -I infra/mcp-hub/usage_by_server.py --days 7` (транскрипты Claude Code по
серверу и продукту + `tool.routed` журнала хаба; клиента 1mcp в журнал не пишет). Замер 13.11 (OPS-43): через хаб
вызывают только t-boards, копии не нужны.

## Что какой сервер даёт

| Сервер | Что | Заметки |
|---|---|---|
| `serena` | Навигация по символам (LSP), только чтение | Две на всех: `:9121` — хост (HR), `:9122` — tAIBE («Две serena»); через хаб — `:9121` |
| `dams-rag` | `project_search` по индексу DAMS: Prisma, REST, Connect RPC, rules, specs, OpenAPI | `infra/mcp-hub/dams_rag_server.py`; индекс пересобирает `.claude/scripts/index_rebuild.py` |
| `ai-council` | Консилиум по карточкам Notion, его база знаний, граф зависимостей (`council_graph_neighbors`), пайплайн | Читает через gateway `:8790`, он должен быть поднят (`npm run ai-pipeline:start`). Граф — `graphify-out/graph.json`, освежать `npm run graph:update` (только AST, без LLM, ~2 мин холодный старт) |
| `owner-queue` | Очередь владельца в ops-консоли: `oq_list`, `oq_get`, `oq_put`, `oq_patch`, `oq_agent_status`, `oq_history` | Токен `OQ_TOKEN` в Keychain (`security add-generic-password -U -s hr-helper-mcp -a OQ_TOKEN -w` — токен спросит сам), выпуск — `token-create <имя> agent` в консоли. Адрес — `OQ_URL`, по умолчанию прод |
| `headroom` | `headroom_compress`/`retrieve` — сжатие и общее хранилище контекста | — |
| `mcp-search` | claude-mem: поиск по памяти сессий, `work_state_*`, `save_memory`, timeline | Обёртка `infra/mcp-hub/claude-mem-mcp.sh` находит `mcp-server.cjs` установленного плагина Claude Code (маркетплейс, затем самая свежая копия в кэше). Перед запуском она поднимает воркер (`:37701`) командой `claude-mem start`, как хук SessionStart плагина: так воркер не становится потомком хаба, и `mcp-hub:stop` его не гасит. `cwd` — корень репо, по нему claude-mem определяет проект. Тег `memory`, его Continue по умолчанию не берёт: 19 инструментов — это около 14 КБ схем в каждом запросе к GLM. Нужна память в Continue — допишите `memory` в `tags=`. Claude Code берёт те же инструменты у плагина, поэтому `memory` в запись `hub` не добавлять, иначе они задвоятся. HTTP MCP на 37701 у claude-mem нет, там только dashboard |
| `git` | status/diff/log/show/branch по репо | Только чтение: commit/add/reset/checkout/create_branch скрыты (`disabledTools`) |
| `postgres-readonly` | Схема dev-БД | Роль `mcp_readonly` без SELECT на таблицы. Структура — через `execute_sql` по `pg_catalog`; `list_objects` пуст |
| `github` | Issues/PR/код на GitHub | Токен `gh auth token` (или `GITHUB_PAT` в Keychain) |
| `t-boards` | Доски t-boards на VPS (`https://d4dev.admin.hrhelper.space`; продукты HR Helper / Lavaeon, aiBoards&eval, Financial terminal): карточки, лес, журнал, блокнот — 56 инструментов | Stdio-обёртка `infra/scripts/dev-ai/mcp-t-boards.sh` → пакет `@kaneo/mcp` из `boards` → REST. Нужны ключ API в Keychain и туннель — «t-boards: ключ и туннель» ниже |
| `docker` | Контейнеры dev-стека | Создание/запуск/пересоздание любое удаление (контейнер, образ, volume, сеть) и push образа в registry скрыты (`disabledTools`): у клиентов хаба бывает авто-подтверждение, а volume Postgres — это данные |
| `markitdown`, `context7` | Документы → markdown; документация библиотек | — |
| `notion`, `sentry`, `cloudflare` | Remote, после OAuth | — |

### t-boards: ключ и туннель

1. Ключ API t-boards (Настройки → API-ключи) — в Keychain:
   `security add-generic-password -U -s hr-helper-mcp -a T_BOARDS_API_KEY -w` (ключ спросит сам — в историю терминала он не попадёт), затем
   `bash infra/scripts/dev-ai/mcp-hub.sh restart hub`.
2. Поднятый туннель WireGuard и строка `10.77.0.1 d4dev.admin.hrhelper.space` в `/etc/hosts`.

Нет ключа или собранного пакета — обёртка ждёт 5 мин перед выходом, чтобы хаб (`restartOnExit`) не перезапускал её
без остановки; после исправления — `restart hub`, не ждать. Причина — в `npm run mcp-hub:logs` (строка `t-boards: …`).
Без туннеля сервер работает, а вызовы его инструментов падают по таймауту. `T_BOARDS_URL` переопределяет адрес — только `https://` или `http://127.0.0.1:<порт>`: ключ уходит туда
заголовком Bearer. HTTP-MCP самого t-boards (`/api/mcp`, OAuth) хабу недоступен: 1mcp не пускает OAuth на приватный
адрес туннеля (`authority_mismatch`).

## Коннекторы (как в claude.ai)

Внешние сервисы из каталога коннекторов claude.ai: Linear, Atlassian, Asana, ClickUp, monday.com, Figma,
Canva, Magnific, PostHog, Intercom, Postman, Exa. В `mcp.json` хаба они лежат с тегом `connector` и
выключены. Подключаются по одному, по выбору, и сразу становятся доступны всем клиентам хаба, а Claude
Code получает их через запись `hub` (`tags=oauth,connector,boards`):

- VS Code: **Terminal → Run Task → «MCP: подключить коннектор»** → выбрать из списка. Хаб поднимает
  сервер и открывает страницу входа. Есть также «MCP: отключить коннектор» и «MCP: список коннекторов».
- Терминал: `npm run mcp-hub:connect -- linear`, `npm run mcp-hub:disconnect -- linear`,
  `npm run mcp-hub:connectors`.

Выбор личный: `~/.config/hr-helper-mcp-hub/connectors.enabled`, в git не попадает. `sync` собирает
итоговый конфиг из каталога репо и этого списка. Невключённые коннекторы в итоговый конфиг не попадают
вовсе, потому что `disabled: true` 1mcp 0.38 на лету не применяет. Exa работает без входа, остальные —
по OAuth с динамической регистрацией клиента (проверено 2026-10-02).

Не вошли **HubSpot** и **Box**: их OAuth-серверы не поддерживают динамическую регистрацию, нужно своё
OAuth-приложение в кабинете разработчика сервиса. Пока ими пользоваться как коннекторами claude.ai.
Каждый подключённый коннектор добавляет инструменты всем клиентам; у Copilot Chat лимит — 128
инструментов на запрос.

## Добавить или изменить сервер

1. Править `infra/mcp-hub/mcp.json`. Формат — 1mcp: `command`/`args`/`cwd`/`env`/`tags` или
   `type: http` + `url`/`headers`. Подстановки `${HR_HELPER_ROOT}` (код слоя — обслуживаемая копия),
   `${SERENA_HTTP_PORT}` и `${GITHUB_PAT}` делает 1mcp на запуске из окружения хаба.
   `${TAIBE_HOST_ROOT}` — корень продукта-хоста. Его на sync подставляет `infra/mcp-hub/render_config.py`:
   берёт `TAIBE_HOST_ROOT` из окружения, а без него — хост живого конфига, без живого конфига — обслуживаемую
   копию («Две serena» → «Хост»). В живом конфиге хост лежит литералом, поэтому `restart` без env его не сменит. Хост получают `git --repository`,
   `cwd` у `postgres-readonly` и `env.TAIBE_HOST_ROOT` у серверов слоя с данными в хосте (`ai-council`,
   `dams-rag`): код из этого репозитория, `council.db` и индекс DAMS — из хоста. Если путь неверный или
   данных там нет, сервер не стартует.
2. `npm run mcp-hub:sync` — хаб перечитает конфиг без рестарта. **Предохранитель:** если живой конфиг
   обслуживает другой хост, sync (а с ним `connect`/`disconnect`) отказывает с кодом 1 и подсказкой
   `TAIBE_HOST_ROOT=<хост> npm run mcp-hub:sync`. Осознанная смена хоста: `MCP_HUB_HOST_CHANGE=1`.
   `status` сравнивает по серверам: «хост расходится» или «sync перепишет из шаблона: <имена>».

Секреты в `mcp.json` не пишем: только переменные из окружения скрипта, которые тот берёт из Keychain
по той же схеме, что `.mcp.json` (`infra/scripts/dev-ai/mcp-secret.sh`, см. `.claude/mcp.md`).

## Обновление 1mcp

Версия зашита в `ONE_MCP_VERSION` (`infra/scripts/dev-ai/mcp-hub.sh`), рантайм ставит `start` при её смене.
**0.38.2 → 0.39.3** (22.10, решение владельца): 0.38.2 молча выкидывает из каталога сервер, чей список инструментов
больше 10 000 узлов JSON. Так из хаба пропал Notion — 0 инструментов с 22.10. В 0.39 предел — 1 000 000.

Цена — повторный вход. 0.39 при первом старте переносит OAuth-сессии апстримов в карантин (`oauth-quarantine-*`)
и удаляет прежние файлы. Notion, Sentry и Cloudflare попросят войти заново, context7 и Exa — нет. Поэтому
`ensure_runtime` перед установкой другой версии копирует `~/.config/hr-helper-mcp-hub/clientSessions` в
`backups/clientSessions-<прежняя версия>-<время>` (каталог 700). Копия не сделалась — обновления нет.

Порядок (хаб общий для всех сессий — днём, когда владелец рядом для входов):
1. Основная папка — на main с этим PR (`git merge --ff-only origin/main`).
2. `npm run mcp-hub:restart`: копия сессий → установка 0.39.3 → старт.
3. `npm run mcp-hub:auth` — откроет страницы входа Notion, Sentry, Cloudflare; войти в каждую.
4. Проверка: `npm run mcp-hub:status` — три сервера готовы, `awaitingOAuth` пуст; список инструментов через хаб —
   у Notion около 65, у Sentry 15, у Cloudflare 4.

Проверено без живого хаба (0.39.3 в отдельном каталоге): флаги `serve` (`--transport http`,
`--enable-async-loading`, `--async-background-retry`, `--health-info-level`, `--log-level`) на месте. Ответ
`/health/mcp` — те же `summary.loading/pending` и `servers.byState.awaitingOAuth` / `details[].authorizationUrl`,
которые читает `auth`. Админка — тот же `build/admin/index.html` с `assets/` для ссылок хаба. `admin bootstrap
--username --password` — та же учётка `operator`. Хранилище входов — тот же `clientSessions` рядом с конфигом.

**Откат на 0.38.2:**
1. `npm run mcp-hub:stop`.
2. `ONE_MCP_VERSION="0.38.2"` — revert этого PR в основной папке.
3. Вернуть сессии: `rm -rf ~/.config/hr-helper-mcp-hub/clientSessions` и
   `cp -Rp ~/.config/hr-helper-mcp-hub/backups/clientSessions-0.38.2-<время> ~/.config/hr-helper-mcp-hub/clientSessions`.
4. `npm run mcp-hub:start` — ставит 0.38.2 (и делает копию сессий 0.39.3 — её не трогать до решения).

## Диагностика и изменения — уроки

- Сервер «не работает» — сначала запусти его командой из обычного терминала под тем же окружением, что у клиента,
  без обходных префиксов PATH: проходит handshake или нет — это делит причины пополам. При `CONNECTION_CLOSED` у
  stdio — `which -a` интерпретатора и импорт зависимостей под тем же PATH. В stdout сервера — только JSON-RPC,
  логи — в stderr.
- Серверы объявляются в основном конфиге, который гарантированно загружается; пути к интерпретаторам — абсолютные:
  GUI-клиенты стартуют без PATH оболочки. Схему конфига клиента читай из установленной версии; нужного ключа в
  схеме нет — так и скажи, а не имитируй комментарием.
- Один сервер — в одном скоупе: дубли (plugin / user / project) убери до того, как поднимать таймауты.
- Хаб переименовывает инструменты. Перед переносом клиента проверь, ссылается ли он на имена инструментов
  (permissions, allowlist агентов); такие клиенты подключай к прямому HTTP-эндпоинту общего процесса.
- Новый сервер в хабе: сначала просмотри его разрушительные и публикующие инструменты и выключи их в хабе.
  Проверяй фактический список инструментов, а не конфиг.
- Обновление общего прокси — сначала на соседнем порту. Прогони запросы в форме каждого клиента (префиксы путей,
  заголовки) и сравни коды с живой версией; откат — подготовлен заранее, скриптом с проверкой готовности.
- Восстановление из бэкапа: сначала снимок живого состояния и дифф по ключам. Дописывай только отсутствующие ключи,
  никогда не затирай значения заглушками из урезанного бэкапа. Секреты инвентаризуй только по именам.

## Чего в хабе нет и почему

- **playwright, chrome-devtools.** Один браузер на несколько агентов одновременно — гонка за вкладки.
  Каждый клиент держит свой.
- **clickhouse.** Остался в VS Code `mcp.json` с `${input:…}`. В хаб — только после отдельной
  read-only роли: в аналитике лежат данные, а дефолт проекта — «без PII для агентов».
- **netdata.** Остался в VS Code `mcp.json`: это мониторинг хоста, а не проекта.
- **redis.** MCP не подключали: агентам он нужен редко, `redis-cli` в терминале хватает.

## Безопасность

- Хаб и serena слушают только `127.0.0.1`. Чужой `Host` отклоняется (1mcp → 403, serena → 421):
  страница в браузере не достучится до них через DNS rebinding.
- Аутентификации клиентов нет: любой локальный процесс пользователя может звать инструменты хаба,
  включая docker и github с правами `gh`-токена. Это та же модель доверия, что у stdio-серверов
  каждого клиента. Хаб не открывать на `0.0.0.0`.
- Serena общая: активация другого проекта переключила бы её для всех клиентов. В контексте
  `claude-code` инструмента `activate_project` нет. Обе serena — только на чтение (`read_only: true` в проекте). Для работы в worktree нужна своя serena
  (stdio, `--project <worktree>`), а не переключение общей.
