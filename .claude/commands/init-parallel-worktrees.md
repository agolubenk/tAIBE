---
description: Поднять три worktree для параллельных AI-сессий (refactor, fix, spike) по темам пользователя
argument-hint: [refactor-topic] [fix-topic] [spike-topic] — kebab-case
---

Создай три git worktree для параллельной работы без конфликтов в одном checkout.

## Вход

1. Темы трёх дорожек — из аргументов; не переданы — спроси (kebab-case, по одной задаче на дорожку). Рекомендуемые
   дорожки репозитория, если они заведены, — в `worktrees/README.md`.
2. База — `WT_BASE` из `Makefile` (дом слоя — `board-agents`, host-проект — `main`).

## Выполнить

Из **корня основного репозитория**:

```bash
BASE="$(sed -n 's/^WT_BASE ?= //p' Makefile 2>/dev/null)"; BASE="${BASE:-main}"
for pair in "refactor:<refactor-topic>" "fix:<fix-topic>" "spike:<spike-topic>"; do
  t="${pair%%:*}"; n="${pair#*:}"
  mkdir -p "worktrees/$t"
  if git show-ref --verify --quiet "refs/heads/$t/$n"; then
    git worktree add "worktrees/$t/$n" "$t/$n"
  else
    git worktree add "worktrees/$t/$n" -b "$t/$n" "$BASE"
  fi
  infra/scripts/dev/wt-deps.sh install "worktrees/$t/$n"   # без зависимостей (документы, eval, слой) — пропустить
done
git worktree list
```

Цикл повторяет рецепт `make wt-add`: ветка `<track>/<topic>` от `WT_BASE` (или существующая) и свои зависимости
worktree. Агентская сессия зовёт команды напрямую: `make` с этим Makefile останавливает merge-guard (SE-105, прямые
формы — `.claude/rules/07-worktrees.md`, «Агентская сессия — прямые формы»).

## После создания

Выведи таблицу «Путь · Ветка · Задача» и напомни:

- В каждой директории — отдельная Claude Code сессия.
- Зависимости у каждого worktree свои; общий `node_modules` через симлинк делает общими и кэши сборки (`.tmp`,
  `.vite`, `.vite-temp`, `.cache`) — результаты tsc и vite одного worktree подмешиваются в другой.
- Локальные env копируются через `.worktreeinclude`.
- Удаление: `git worktree remove <path>` — только с «да» владельца (`make wt-rm` агентской сессии останавливает
  merge-guard).
