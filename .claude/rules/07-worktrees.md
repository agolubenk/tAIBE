---
paths:
  - worktrees/**
  - Makefile
---

# Git worktrees + Claude Code

> **Sync:** `Makefile`, `worktrees/README.md`

## Схема путей

```
worktrees/<track>/<topic>/
```

**Треки:** `feature` · `fix` · `refactor` · `spike` · `review`

**Ветка** = `<track>/<topic>` (например `refactor/vacancy-save-split`)

**База по умолчанию:** ветка по умолчанию репозитория (`WT_BASE` в `Makefile`: `board-agents` в доме слоя, `main` у host-проекта)

## Рекомендуемые дорожки

Дорожки по умолчанию для текущего репозитория — в `worktrees/README.md` (у инстанса над host-проектом — свои).
Не смешивать тяжёлый refactor, багфиксы и spike в одном checkout.

## Испытательный контур (владелец, 01.11)

Эволюция слоя (скиллы, правила, промпты, геномы, хуки) и решения в продукте разрабатываются и проверяются в отдельном
worktree: `spike` — эксперимент, `feature`/`fix` — кандидат в работу. Порядок: гейты в worktree → поведенческие проверки
на версии ветки (`eval/evolve/ab.py --b <ветка>`) → PR → CI → мёрж. Живые сессии берут новую ревизию на границе
единицы работы, не посреди шага. Неудачный кандидат — удалённые worktree и ветка, живой контур не менялся. Подробно —
`docs/plans/evolution-ideas.md` §8.7.

## Команды

```bash
make wt-refactor NAME=vacancy-save-split            # создаёт worktree и ставит свои зависимости
make wt-fix NAME=candidate-merge-n-plus-one WT_DEPS=0   # без зависимостей: документы, чтение
make wt-deps TRACK=fix NAME=candidate-merge-n-plus-one  # поставить позже
make wt-check TRACK=fix NAME=candidate-merge-n-plus-one # свои и свежие?
make wt-list
make wt-rm TRACK=fix NAME=candidate-merge-n-plus-one
```

Или slash-команды Claude: `/init-worktree`, `/init-parallel-worktrees`

## .worktreeinclude

При создании worktree Claude Code копирует локальные файлы из списка (`.env` и т.д.) — не коммитятся, но нужны для dev.

## После создания worktree

1. `cd worktrees/<track>/<topic>`
2. Зависимости — свои. `make wt-add` ставит их сам; worktree, созданный иначе (`git worktree add`, `/init-worktree`,
   Claude Code): `infra/scripts/dev/wt-deps.sh install <путь>`. В доме слоя (pnpm-workspace `boards/`) скрипт
   делает `pnpm install --frozen-lockfile` в `boards/`; в npm-монорепо хоста — `npm ci` с заглушкой `DATABASE_URL`:
   postinstall бэкенда (`prisma generate`) без неё падает, и `npm ci` откатывает **весь** `node_modules`. Код возврата
   берётся у самого `npm ci`. Потом `build:packages` и `check`: свой `node_modules`, установка не старее
   `package-lock.json`, `@hr-helper/*` ведут внутрь worktree.
   Зачем: worktree лежит внутри основного checkout, и без своего `node_modules` Node молча поднимается к
   `node_modules` основного checkout. Там чужой WIP пакетов и другая версия TypeScript, отсюда ложные ошибки
   typecheck и сборки (2026-10-08; 30.10 — «EXTENSION_AUTH_CODES is not iterable»). Гейт (`npm run …`, `npx …`) в
   worktree без своих зависимостей останавливает хук `.claude/hooks/pre-tool-use-wt-deps.sh` с командой починки.
   Обход для команды, которой зависимости не нужны, — `WT_DEPS_CHECK=0` в её начале; для всей сессии —
   `WT_DEPS_CHECK=0` в окружении, с которым запущен `claude` (хук и проверка Stop-typecheck молчат).
3. Проверить локальные `.env` из `.worktreeinclude` (у досок — `boards/.env`)
4. Один worktree — одна полоса работы: связанные задачи одного сектора (общие файлы, связанные ветки) — в одном
   worktree, а не в новом на каждую карточку. Отдельный PR на задачу — по-прежнему.

## Предел и уборка (владелец, 13.11, OPS-52)

- Не больше **10** worktree на продукт. Перед новым — найди открытый worktree своего сектора. `make wt-add` и
  `git worktree add` на пределе останавливает `eval/tools/wt_gc.py check-limit` (хук
  `.claude/hooks/pre-tool-use-wt-limit.sh`); исключение — только по слову владельца, `WT_LIMIT_CHECK=0`.
  До 20.11 (владелец 14.11, `d-taibe-ops52-limit-1311` = B) продукт выше предела получает только предупреждение —
  своди работу в существующие worktree. Остановка включается сама 20.11 или когда продукт впервые опустится до 10.
- Работа влита — worktree удаляется сам: Нерв видит мёрж PR в основную ветку и вызывает `wt_gc.py branch`
  (`eval/nerve/sources.py`). Удаляется только копия, чей HEAD — голова влитого PR, без правок, без неотслеживаемых
  файлов, без игнорируемого состояния сессии (`.ai/task/`, `.claude/memory/session/`, `CLAUDE.local.md`, правленый
  `.env`), в которой нет процесса, не работали последний час и на которую не ссылаются ссылки и задачи launchd. Ветка
  остаётся. Что осталось и почему — событие `wt.gc` координатору. Пропущенные мёржи — `wt_gc.py sweep <repo>`.
- Продолжаешь связанную задачу в том же worktree после мёржа — сделай коммит или `git worktree lock`: уборка не тронет
  копию, чей HEAD ушёл от головы PR, и запертую копию.
- В пределе считаются и worktree, которые создаёт сам Claude Code (`.claude/worktrees/agent-*`, `EnterWorktree`):
  хук их не видит (не Bash), а уборка — только если у их ветки влитой PR. Закончил с таким worktree — удали его.
  `review/*` в detached HEAD уборка не трогает: удаляет тот, кто ревьюил.

## Чужой незакоммиченный WIP

Принимая WIP закончившейся сессии: сохрани его патчем; заново сформулируй баг от видимого пользователю симптома;
перечисли все пути кода, которые к нему ведут (включая resize и переходы, а не только загрузку); найди дубли
затронутой логики (ключи хранилища, константы) и вынеси общее в один протестированный модуль, а не латай каждую
копию. В PR — что принято и что изменено против унаследованного.

## Удаление

```bash
git worktree remove worktrees/<track>/<topic>
git branch -d <track>/<topic>   # после merge
```
