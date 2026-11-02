#!/bin/bash
# Шаг 4. PR очистки HR в отдельном worktree (основной checkout HR и сессии не трогаются): удалить supertick-eval/ и
# t-boards/, поправить пять текстов, проверить, что мёрж не задеплоит прод (все пути в paths-ignore), отправить ветку
# и открыть PR. Не мёржит. Повторный запуск безопасен.
export STEP=4
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

git -C "$HR" fetch -q origin main || stop "git fetch HR не прошёл"
if [ ! -d "$HR_WT" ]; then
  if git -C "$HR" rev-parse -q --verify "refs/heads/$HR_BRANCH" >/dev/null; then
    git -C "$HR" worktree add -q "$HR_WT" "$HR_BRANCH" || stop "worktree $HR_WT не создан"
  else
    git -C "$HR" worktree add -q "$HR_WT" -b "$HR_BRANCH" origin/main || stop "worktree $HR_WT не создан"
  fi
fi
cd "$HR_WT" || stop "нет $HR_WT"
git cat-file -e HEAD:supertick-eval 2>/dev/null && git rm -r -q supertick-eval
git cat-file -e HEAD:t-boards 2>/dev/null && git rm -r -q t-boards
[ -d t-boards ] && find t-boards -depth -type d -empty -delete # пустые папки бывших gitlink
[ -e supertick-eval ] && stop "в worktree PR осталась папка supertick-eval после git rm: $(ls -A supertick-eval | head -3)"

"$PY" -I - <<'EOF' || stop "правки текстов HR не применились (вывод выше) — строки в HR изменились"
import pathlib, sys

def sub(path, old, new, count):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    if new in s and old not in s.replace(new, ""):
        print("уже сделано:", path); return
    if s.count(old) != count:
        print(f"не найдено {count}× в {path}: {old[:60]!r} (нашлось {s.count(old)})"); sys.exit(1)
    p.write_text(s.replace(old, new), encoding="utf-8"); print("правка:", path)

# 1. деплой прода не реагирует на t-boards/** — как на supertick-eval/**
sub(".github/workflows/deploy-contabo.yml", "      - 'supertick-eval/**'\n",
    "      - 'supertick-eval/**'\n      - 't-boards/**'\n", 1)
# 2. команда наследника работает и из worktree HR (там нет ссылки supertick-eval) — через основной checkout
old = "bash supertick-eval/tools/spawn_session.sh"
new = "bash $(git rev-parse --path-format=absolute --git-common-dir)/../supertick-eval/tools/spawn_session.sh"
sub(".claude/hooks/context-threshold.py", old, new, 2)
sub(".claude/skills/successor-handoff/SKILL.md", old, new, 2)
# 3. словарь имён
sub("CLAUDE.md", "подпродукт-контролплейн в `t-boards/app`",
    "подпродукт-контролплейн, код — репозиторий tAIBE (`boards/`, github.com/agolubenk/tAIBE); на машине владельца "
    "`t-boards/app` — ссылка на его checkout", 1)
# 4. путь синка блокнота
sub("docs/engineering/antipatterns.md", "`t-boards/app/deploy/vps/mac/notebook-sync.mjs`",
    "`boards/deploy/vps/mac/notebook-sync.mjs` в репозитории tAIBE", 1)
EOF

"$PY" .claude/scripts/docs_linkcheck.py >"$BK/state/hr-linkcheck.txt" 2>&1 ||
  stop "в HR висячие ссылки после удаления папок: $(grep -v '^—' "$BK/state/hr-linkcheck.txt" | head -5 | tr '\n' ' ')"
ok "ссылки документации HR целы"

ln -s "$TB/eval" supertick-eval # тест хука наследника запускает spawn_session.sh — только на время теста
fails=""
for t in .claude/hooks/test_*.py; do "$PY" "$t" >/dev/null 2>&1 || fails="$fails $t"; done
rm supertick-eval # это ссылка, не папка; в PR её быть не должно
[ -z "$fails" ] || stop "тесты хуков HR не прошли:$fails"
ok "тесты хуков HR зелёные"

git add -A
bad="$(git -c core.quotepath=off diff --cached --name-only -z origin/main | "$PY" -I -c '
import sys
ok = ("docs/", ".claude/", ".github/", "supertick-eval/", "t-boards/")
print(" ".join(p for p in sys.stdin.read().split("\0") if p and not (p.startswith(ok) or p.endswith(".md"))))')"
[ -z "$bad" ] || stop "в PR есть пути вне paths-ignore деплоя (мёрж задеплоил бы прод): $bad"
ok "все изменённые пути в paths-ignore: мёрж PR не деплоит прод"

if ! git diff --cached --quiet; then
  git commit -q -F - <<'EOF'
chore: t-boards and supertick-eval moved to the tAIBE repository

The code and data now live in agolubenk/tAIBE (boards/ and eval/). On the owner's Mac the old paths are
symlinks to the tAIBE checkout, so hooks, genomes, the Nerve and the boards MCP keep working. The successor
command goes through the main checkout, so it also works from HR worktrees. deploy-contabo ignores t-boards/**
like supertick-eval/**: this change does not rebuild production.
EOF
fi
git push -q -u origin "$HR_BRANCH" || stop "ветка $HR_BRANCH не отправилась"
ok "ветка отправлена: $HR_BRANCH ($(git log --oneline -1))"

body="$BK/hr-pr-body.md"
cat >"$body" <<EOF
## Что

\`t-boards/\` и \`supertick-eval/\` переехали в репозиторий tAIBE (\`boards/\`, \`eval/\`). На Mac владельца старые пути —
символические ссылки на checkout tAIBE (в git HR их нет), поэтому хуки, геномы, Нерв и MCP досок работают как раньше.

- \`deploy-contabo.yml\`: \`t-boards/**\` в paths-ignore, как \`supertick-eval/**\`.
- Команда наследника (хук порога и скилл successor-handoff) идёт через основной checkout — работает и из worktree HR.
- \`CLAUDE.md\` (словарь имён) и \`docs/engineering/antipatterns.md\` — новые пути.

## Проверка

- Все изменённые пути в paths-ignore деплоя: **мёрж не деплоит прод**.
- \`docs_linkcheck.py\`: висячих ссылок 0. Тесты хуков \`.claude/hooks/test_*.py\` зелёные.
- Инструкция разделения: https://github.com/agolubenk/tAIBE/blob/board-agents/docs/ops/split-hr-taibe.md

Вливать в окне переключения (шаг 5 инструкции), когда исполнитель попросит.
EOF
url="https://github.com/$HR_REPO/compare/main...$HR_BRANCH?expand=1"
if has gh && gh auth status >/dev/null 2>&1; then
  existing="$(gh pr list --repo "$HR_REPO" --head "$HR_BRANCH" --state open --json url --jq '.[0].url' 2>/dev/null)"
  if [ -n "$existing" ]; then
    url="$existing"
  else
    url="$(gh pr create --repo "$HR_REPO" --base main --head "$HR_BRANCH" \
      --title "chore: t-boards and supertick-eval moved to tAIBE" --body-file "$body" 2>/dev/null)" ||
      url="https://github.com/$HR_REPO/compare/main...$HR_BRANCH?expand=1"
  fi
fi
echo "$url" >"$BK/hr-pr-url"
wait_owner "PR очистки HR: $url (если открылась форма сравнения — создать PR, описание в $body). Не вливать сейчас. Дождаться зелёного ci-docs. Владелец назначает окно ~30 мин и закрывает ВСЕ сессии команды над HR; после его «да» — bash $SPLIT_DIR/5a-freeze.sh"
