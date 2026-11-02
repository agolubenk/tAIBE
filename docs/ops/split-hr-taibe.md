# Разделение HR Helper v2 и tAIBE на машине владельца — пошаговая инструкция для исполнителя (GLM)

> **Статус (2026-11-01):** сверено с кодом обоих репозиториев: HR `main` 888653ec, tAIBE `board-agents`. Ключевые
> места проверены на макете: `git pull` после `mv`, ссылки, `spawn_session.sh --dry-run`. Ревью — три линзы:
> потеря данных, связь с сервером, выполнимость. Исполнитель — GLM на Mac владельца, 2026-11-02. Что откуда
> перенесено — [`process/TRANSFER.md`](../../process/TRANSFER.md).

## Рамка

Решения владельца 01.11:

1. **Только ноутбук.** Сервер не трогаем: VPS, стенд `d4dev.admin.hrhelper.space`, ops-консоль, бот очереди,
   WireGuard. Ни деплоя, ни правки конфигов. Связь с сервером после разделения работает так же, как до него.
2. **Из HR уходят только `t-boards/` и `supertick-eval/`.** Всё остальное остаётся в HR и работает оттуда, как
   сейчас:
   - ИИ-сервисы `infra/`: консилиум, MCP-хаб, шлюз моделей, очередь владельца, ops-консоль, headroom;
   - `.claude/`, `.continue/`, `.agents/`.

   Их чистка — позже и по частям.
3. **Слой в HR — копия.** Сессии, которые пишут код HR, по-прежнему запускаются из checkout'а HR. Новые версии
   слоя появляются в tAIBE и переносятся в HR отдельным синком (не в этот раз).

### Как это устроено после разделения

Код и данные `supertick-eval/` и `t-boards/app` живут в checkout'е tAIBE. В checkout'е HR на их месте —
символические ссылки. В git HR ссылок нет: их скрывает локальный файл `.git/info/exclude`.

| Ссылка в HR | Куда ведёт | Зачем |
|---|---|---|
| `supertick-eval` | `tAIBE/eval` | Через `supertick-eval/` прописаны: геномы ролей, хуки-рефлексы, plist Нерва, `spawn_session.sh`, старые handoff |
| `eval` | `tAIBE/eval` | Тексты слоя из tAIBE (капсулы, промпты ролей) ссылаются на `eval/nerve/nerve.py`, `eval/tools/…` |
| `t-boards/app` | `tAIBE/boards` | MCP досок в хабе: `infra/scripts/dev-ai/mcp-t-boards.sh` ищет `t-boards/app/packages/mcp` |
| `boards` | `tAIBE/boards` | Промпт роли «доски» ссылается на `boards/…` |

Конфиги tAIBE уже рассчитаны на такую раскладку. В `eval/nerve/config.json`: `repo_root` — checkout HR,
`product_tree` — `supertick-eval`. Геномы собраны под эти же пути.

**Что меняется в поведении** (это не просто перенос файлов):
- Нерв и рой из tAIBE читают настройки пайплайна продукта с досок (`nerveWakes`, `swarm`).
- Если выключить их на доске, Нерв перестанет будить сессии.
- Если доски недоступны или продукт не определился, включено всё.

## Правила для исполнителя

- **Все команды выполнять в `bash`, не в `zsh`.** В zsh `#` в конце строки — не комментарий, а шаблон имени без
  совпадений обрывает всю команду. Перед каждым блоком: `bash`. Если оболочка не сохраняет переменные между
  командами, первая строка каждого блока — `source ~/Backups/split-env.sh`.
- **Ничего не удалять.** Только `mv` в папку бэкапа. Удалить бэкап может только владелец, и не раньше чем через
  неделю.
- **Не пушить в `main` HR и не мёржить.** В HR — только ветка и PR (шаг 4), вливает владелец.
- **Не трогать сервер:** никаких `ssh`, `install.sh`, `bundle.sh`, `docker` на VPS.
- **Без `--force`, `reset --hard`, `clean`, `stash`** в обоих репозиториях.
- **СТОП** — остановиться, записать в журнал, что увидел, и спросить владельца. Не обходить.
- Каждую команду и коротко её вывод — в журнал `$BK/LOG.md`. Секреты в журнал не писать.
- Шаги идут строго по порядку. В шаге 5 два «да» владельца: на начало окна и на мёрж PR.

## Шаг 0. Переменные

```bash
mkdir -p ~/Backups && cat > ~/Backups/split-env.sh <<'EOF'
export HR="$HOME/Desktop/Development/HR_Helper-v2"
export TB="$HOME/Desktop/Development/tAIBE"
export BK="$HOME/Backups/split-2026-11-02"
export PY=/Library/Frameworks/Python.framework/Versions/3.14/bin/python3
: "${HR:?}" "${TB:?}" "${BK:?}"
EOF
source ~/Backups/split-env.sh
mkdir -p "$BK"/{patches,moved,launchd,home,state} && chmod 700 "$BK" && touch "$BK/LOG.md"
[ -x "$PY" ] && "$PY" --version || echo "СТОП: нет $PY"
```

`PY` — это Python Нерва. `/usr/bin/python3` на этой машине — шим Xcode, им не пользоваться.

`chmod 700` обязателен: в бэкапе будут ключи (`~/.t-boards-notebook/api_key` и подобные).

---

## Шаг 1. Предполётная проверка (ничего не меняет)

```bash
source ~/Backups/split-env.sh
cd "$HR" && git status --short --branch | head -40
git fetch origin && git log --oneline origin/main..HEAD          # локальные коммиты, не отправленные в main
df -h "$HOME" | tail -1; node -v; git --version
ls -la "$HR/t-boards" "$HR/supertick-eval" | head -30
ls -d "$HR/tAIBoard_and_Eval" "$TB" 2>/dev/null
launchctl list | grep -E 'hrhelper|t-boards' > "$BK/launchd/before.txt"; cat "$BK/launchd/before.txt"
grep -l -E 'HR_Helper-v2/(t-boards|supertick-eval)' ~/Library/LaunchAgents/*.plist 2>/dev/null | tee "$BK/launchd/tied.txt"
# ветки HR, которые меняют переезжающие папки: их мёрж после разделения вернёт настоящие папки на место ссылок
for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v -E '^origin/(main|HEAD)$'); do
  n="$(git log --oneline origin/main.."$b" -- supertick-eval t-boards | wc -l | tr -d ' ')"
  [ "$n" -gt 0 ] && echo "$b: $n коммитов в supertick-eval/t-boards"
done | tee "$BK/patches/hr-branches-touching.txt"
```

Ожидаемо:
- checkout HR на ветке `main`;
- `node -v` не ниже 24.11;
- свободно не меньше 20 ГБ. Бэкап делается через `mv` на тот же диск и места почти не занимает, но зависимости
  tAIBE весят несколько ГБ.

СТОП в трёх случаях:
- В HR есть локальные коммиты, не отправленные в `main`, или checkout не на `main`. В шаге 5 выполняется
  `git pull --ff-only`, а он поверх таких коммитов не пройдёт. Отправлять их или оставить, решает владелец.
- `$TB` уже существует. Поверх не клонировать, спросить, чей это checkout.
- Файл `hr-branches-touching.txt` не пуст. Список показать владельцу: такие ветки нельзя вливать в HR после
  разделения, пока их правки не перенесены в tAIBE. Продолжать только после ответа.

Незакоммиченные правки HR вне `supertick-eval/` и `t-boards/` не трогать, их список записать в журнал.

Список `tied.txt` — это launchd-агенты с путями в переезжающие папки. Обычно там только Нерв. Каждый такой
plist проверяется в шаге 6.

## Шаг 2. Бэкап (ничего не меняет в рабочих папках)

### 2.1. launchd, домашние папки, свежий дамп базы досок

```bash
source ~/Backups/split-env.sh
for f in ~/Library/LaunchAgents/space.hrhelper.*.plist ~/Library/LaunchAgents/com.hrhelper.*.plist; do
  [ -e "$f" ] && cp -p "$f" "$BK/launchd/"; done; ls "$BK/launchd"
for d in .t-boards-notebook .t-boards-memory .t-boards-backup .hr-owner-queue-bot; do
  [ -d "$HOME/$d" ] && tar -C "$HOME" -czf "$BK/home/$d.tgz" "$d"; done; ls -la "$BK/home"
find ~/t-boards-backups -name 't-boards-*.dump' -mtime -1 | head -1; tail -2 ~/t-boards-backups/pull.log 2>/dev/null
```

СТОП, если за последние сутки нет ни одного файла `t-boards-*.dump`. База досок на сервере — главные данные, без
свежей копии не продолжать: владелец проверяет агент бэкапа.

### 2.2. Скрипты снимка и переноса (записать один раз, запускать в шагах 2.3 и 5.2)

```bash
source ~/Backups/split-env.sh
cat > "$BK/scan.sh" <<'EOS'
#!/bin/bash
# Снимок всех git-репозиториев и worktree внутри переезжающих папок: бандл, статус, правки, неотслеживаемые, тайники.
set -u; source "$HOME/Backups/split-env.sh"
out="$BK/scan-$(date +%H%M%S)"; mkdir -p "$out"
find "$HR/t-boards" "$HR/supertick-eval" "$HR/tAIBoard_and_Eval" -maxdepth 6 \
  \( -name node_modules -o -name .pnpm-store \) -prune -o -name .git -print 2>/dev/null | while read -r g; do
  r="$(dirname "$g")"; n="$(printf '%s' "${r#"$HR"/}" | tr '/' '_')"
  echo "=== $r" >> "$out/summary.txt"
  git -C "$r" status --porcelain > "$out/$n.status.txt"
  git -C "$r" diff HEAD > "$out/$n.uncommitted.patch"
  git -C "$r" ls-files --others --exclude-standard -z | tar -C "$r" --null -T - -czf "$out/$n.untracked.tgz" 2>/dev/null || true
  if [ -d "$g" ]; then   # основной репозиторий; у worktree .git — файл, его ветки и тайники — в основном
    git -C "$r" fetch --all --prune >/dev/null 2>&1 || echo "fetch не прошёл: $r" >> "$out/summary.txt"
    git -C "$r" stash list > "$out/$n.stash.txt"
    git -C "$r" worktree list >> "$out/summary.txt"
    git -C "$r" bundle create "$out/$n.bundle" --all >/dev/null 2>&1 && git -C "$r" bundle verify "$out/$n.bundle" >/dev/null 2>&1 \
      && echo "бандл ok: $n" >> "$out/summary.txt" || echo "БАНДЛ НЕ СОЗДАН: $n" >> "$out/summary.txt"
    for b in $(git -C "$r" for-each-ref --format='%(refname:short)' refs/heads); do
      c="$(git -C "$r" rev-list --count "$b" --not --remotes)"
      [ "$c" -gt 0 ] && echo "$r $b $c" >> "$out/unpushed.txt"
    done
  fi
  echo "правок: $(wc -l < "$out/$n.status.txt" | tr -d ' ')" >> "$out/summary.txt"
done
for b in "$out"/*.bundle; do git bundle list-heads "$b"; done | grep -q '^799fae6' \
  && echo "799fae6 в бандле: ok" >> "$out/summary.txt" || echo "СТОП: коммита 799fae6 нет ни в одном бандле" >> "$out/summary.txt"
cd "$HR" && git -c core.quotepath=off status --porcelain -- supertick-eval t-boards > "$out/hr-dirs.status.txt"
git diff -- supertick-eval t-boards > "$out/hr-dirs.uncommitted.patch"
git -c core.quotepath=off ls-files -z --others --exclude-standard -- supertick-eval > "$out/hr-supertick.untracked.z"
echo "$out"
EOS
cat > "$BK/port.sh" <<'EOS'
#!/bin/bash
# port.sh <repo> <branch>: коммиты ветки, которых нет в tAIBE, по порядку — в ветку rescue/<repo>-<branch> tAIBE.
set -u; source "$HOME/Backups/split-env.sh"
r="$1"; b="$2"; name="rescue/$(basename "$r")-$(printf '%s' "$b" | tr '/' '-')"
dir=(--directory=boards); [ -d "$r/boards" ] && dir=()   # у форка код от корня, у клона tAIBE — уже под boards/
todo=""; for s in $(git -C "$r" rev-list --reverse --topo-order "$b" --not --remotes); do
  git -C "$TB" cat-file -e "$s^{commit}" 2>/dev/null || todo="$todo $s"; done
[ -z "$todo" ] && { echo "$r $b: всё уже есть в tAIBE"; exit 0; }
git -C "$TB" fetch -q origin
if git -C "$TB" rev-parse -q --verify "refs/heads/$name" >/dev/null; then git -C "$TB" switch -q "$name" || exit 2   # повторный запуск (шаг 5.2)
else git -C "$TB" switch -q -c "$name" origin/board-agents || exit 2; fi
for s in $todo; do
  subj="$(git -C "$r" log -1 --format=%s "$s")"
  if git -C "$TB" log HEAD --format=%s | grep -qxF "$subj"; then echo "уже есть (тема совпала): ${s:0:7} $subj"; continue; fi
  git -C "$r" format-patch -1 "$s" --stdout > "$BK/patches/${s:0:7}.patch"
  if ! git -C "$TB" am -q --3way "${dir[@]}" "$BK/patches/${s:0:7}.patch"; then
    git -C "$TB" am --abort; echo "НЕ ПРИМЕНИЛСЯ, остальное в ветке не переносится: ${s:0:7} $subj"; break; fi
  echo "перенесён: ${s:0:7} $subj"
done
git -C "$TB" log --oneline origin/board-agents..HEAD; git -C "$TB" switch -q board-agents
EOS
chmod +x "$BK/scan.sh" "$BK/port.sh"
```

### 2.3. Первый снимок

```bash
source ~/Backups/split-env.sh
S="$(bash "$BK/scan.sh")"; echo "$S"; cat "$S/summary.txt"; cat "$S/unpushed.txt" 2>/dev/null
```

СТОП, если в `summary.txt` есть строка «БАНДЛ НЕ СОЗДАН» или «СТОП». Список `unpushed.txt` — это ветки с
коммитами, которых нет на GitHub. Их переносит шаг 3.4.

## Шаг 3. Подготовить checkout tAIBE (сервисы продолжают работать из HR)

### 3.1. Клон

```bash
source ~/Backups/split-env.sh
git clone https://github.com/agolubenk/tAIBE.git "$TB" && cd "$TB" && git switch board-agents && git log --oneline -1
"$PY" -I -m json.tool eval/nerve/config.json | grep -E '"(repo_root|product_tree|project_dir|repo)"'
ls docs/ops/split-hr-taibe.md
```

Ожидаемые значения в `config.json`:
- `repo_root` = `/Users/agolubenko/Desktop/Development/HR_Helper-v2`;
- `product_tree` = `supertick-eval`;
- `repo` = `agolubenk/HR_Helper-v2`.

Так и должно быть: Нерв следит за командой, которая работает над HR. Если значения другие — СТОП.

Если этой инструкции нет в `board-agents` (PR с ней ещё не влит), её копия лежит в ветке
`claude/busy-turing-2ej5pk`:

```bash
git -C "$TB" fetch origin claude/busy-turing-2ej5pk && git -C "$TB" show FETCH_HEAD:docs/ops/split-hr-taibe.md | head
```

### 3.2. Проверки слоя и eval

```bash
source ~/Backups/split-env.sh; cd "$TB"
"$PY" -I eval/pipeline/genome/build.py --check
for t in .claude/hooks/test_*.py .claude/scripts/test_*.py; do "$PY" "$t" >/dev/null 2>&1 || echo "FAIL $t"; done
"$PY" -I -m unittest discover -s eval/nerve -p 'test_*.py' 2>&1 | tail -1
"$PY" -I -m unittest discover -s eval/pipeline -p 'test_*.py' 2>&1 | tail -1
"$PY" -I .claude/scripts/pipeline_settings.py enabled nerveWakes; echo "nerveWakes: $? (0 = включено)"
```

Ожидаемо:
- `build.py --check` проходит без расхождений;
- ни одного `FAIL`;
- оба прогона `unittest` заканчиваются строкой `OK`;
- `nerveWakes` возвращает 0.

Любое расхождение — СТОП. Если `nerveWakes` возвращает 1, Нерв после переезда никого не будит: включено ли
это на доске намеренно, решает владелец.

### 3.3. Зависимости досок и пакет MCP

```bash
source ~/Backups/split-env.sh; cd "$TB/boards"
corepack enable && corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile && pnpm --filter "./packages/*" build
ls -la packages/mcp/dist/index.js
for f in .env .env.local apps/web/.env.local; do      # файлы окружения со старого места, не затирая
  [ -f "$HR/t-boards/app/$f" ] && [ ! -e "$TB/boards/$f" ] && cp -p "$HR/t-boards/app/$f" "$TB/boards/$f" && echo "скопирован $f"
done
```

Локальный стек досок (`compose.local.yml`) раньше работал под проектом `app` — так называлась папка. Чтобы не
получить пустую базу, запускать его с тем же именем: `docker compose -p app -f compose.local.yml up`. Тома
этого проекта видны в `docker volume ls | grep ' app_'`.

### 3.4. Перенос неотправленных коммитов

Для каждой строки `<repo> <branch> <число>` из `$S/unpushed.txt` (шаг 2.3):

```bash
source ~/Backups/split-env.sh
while read -r repo branch n; do bash "$BK/port.sh" "$repo" "$branch"; done < "$S/unpushed.txt" | tee -a "$BK/LOG.md"
git -C "$TB" branch --list 'rescue/*'
```

- Каждая ветка с коммитами получает свою ветку `rescue/<repo>-<branch>` в tAIBE. Отправить их все, но не мёржить:
  `for b in $(git -C "$TB" branch --format='%(refname:short)' --list 'rescue/*'); do git -C "$TB" push -u origin "$b"; done`.
- Пустую ветку `rescue/*` (в выводе `port.sh` нет ни одного «перенесён») удалить: `git -C "$TB" branch -d <имя>`.
- Незакоммиченные правки (`*.uncommitted.patch`, `*.untracked.tgz`, тайники) в tAIBE не применять. Они в
  бэкапе, решение за владельцем.

## Шаг 4. PR очистки HR (в отдельном worktree; основной checkout HR и сессии не трогаются)

```bash
source ~/Backups/split-env.sh; cd "$HR" && git fetch origin main
git worktree add "$HR/worktrees/chore/split-t-boards" -b chore/split-t-boards-supertick origin/main
cd "$HR/worktrees/chore/split-t-boards" && git rm -r -q supertick-eval t-boards
```

Правки — только эти. Каждая выполняется скриптом и сама проверяет, что заменила ровно то, что нужно:

```bash
cd "$HR/worktrees/chore/split-t-boards" && "$PY" -I - <<'EOF'
import pathlib
def sub(path, old, new, count):
    p = pathlib.Path(path); s = p.read_text(encoding="utf-8")
    assert s.count(old) == count, (path, s.count(old)); p.write_text(s.replace(old, new), encoding="utf-8")
# 1. деплой прода не реагирует на t-boards/** — как на supertick-eval/**
sub(".github/workflows/deploy-contabo.yml", "      - 'supertick-eval/**'\n",
    "      - 'supertick-eval/**'\n      - 't-boards/**'\n", 1)
# 2. команда наследника работает и из worktree HR (там нет ссылки supertick-eval) — путь через основной checkout
cmd_old = "bash supertick-eval/tools/spawn_session.sh"
cmd_new = "bash $(git rev-parse --path-format=absolute --git-common-dir)/../supertick-eval/tools/spawn_session.sh"
sub(".claude/hooks/context-threshold.py", cmd_old, cmd_new, 2)
sub(".claude/skills/successor-handoff/SKILL.md", cmd_old, cmd_new, 2)
# 3. словарь имён
sub("CLAUDE.md", "подпродукт-контролплейн в `t-boards/app`",
    "подпродукт-контролплейн, код — репозиторий tAIBE (`boards/`, github.com/agolubenk/tAIBE); на машине владельца "
    "`t-boards/app` — ссылка на его checkout", 1)
# 4. путь синка блокнота
sub("docs/engineering/antipatterns.md", "`t-boards/app/deploy/vps/mac/notebook-sync.mjs`",
    "`boards/deploy/vps/mac/notebook-sync.mjs` в репозитории tAIBE", 1)
print("правки ok")
EOF
"$PY" .claude/scripts/docs_linkcheck.py | tail -2
ln -s "$TB/eval" supertick-eval      # тест хука наследника запускает spawn_session.sh — только на время теста
for t in .claude/hooks/test_*.py; do "$PY" "$t" >/dev/null 2>&1 || echo "FAIL $t"; done
rm supertick-eval                    # ссылка, не папка; в PR её быть не должно
```

Ожидаемо: «правки ok», висячих ссылок 0, ни одного `FAIL`.

- Если висячие ссылки нашлись, каждую ссылку на `supertick-eval/…` или `t-boards/…` заменить адресом
  `https://github.com/agolubenk/tAIBE/blob/board-agents/<новый путь>`. Новый путь берётся из таблицы
  «Соответствие путей» в `process/TRANSFER.md`:
  - `supertick-eval/X` → `eval/X`;
  - `t-boards/app/X` → `boards/X`;
  - `t-boards/<док>.md` → `boards/docs/<док>.md`.
- Если `FAIL` и непонятно почему — СТОП.

**Не трогать:**
- `infra/scripts/dev-ai/mcp-t-boards.sh`: его нет в `paths-ignore`, правка задеплоит прод; работает и так, через
  ссылку `t-boards/app`;
- `.gitignore`: его тоже нет в `paths-ignore`; ссылки скрываются локально, в шаге 5.4.

Проверка, что мёрж PR не запустит деплой прода — каждый изменённый путь должен попадать в `paths-ignore`:

```bash
git add -A && git -c core.quotepath=off diff --cached --name-only -z | "$PY" -I -c '
import sys
ok = ("docs/", ".claude/", ".github/", "supertick-eval/", "t-boards/")
bad = [p for p in sys.stdin.read().split("\0") if p and not (p.startswith(ok) or p.endswith(".md"))]
print("НЕ В paths-ignore:", bad) if bad else print("ok: все пути в paths-ignore")'
```

Вывод не `ok` — СТОП: найти и убрать лишнюю правку.

```bash
git commit -q -F - <<'EOF'
chore: t-boards and supertick-eval moved to the tAIBE repository

The code and data now live in agolubenk/tAIBE (boards/ and eval/). On the owner's Mac the old paths are
symlinks to the tAIBE checkout, so hooks, genomes, the Nerve and the boards MCP keep working. The successor
command goes through the main checkout, so it also works from HR worktrees. deploy-contabo ignores t-boards/**
like supertick-eval/**: this change does not rebuild production.
EOF
git push -u origin chore/split-t-boards-supertick
```

Открыть PR в `agolubenk/HR_Helper-v2`, база `main`, **не вливать**. В описании:
- что удалено и куда переехало;
- вывод проверки путей;
- ссылка на эту инструкцию;
- строка «мёрж не деплоит прод: все пути в `paths-ignore`».

Дождаться зелёного `ci-docs`. Владельцу — пункт очереди (MCP `oq_*`): «PR очистки HR готов, нужно окно ~30 мин
для переключения». **СТОП до ответа владельца.**

## Шаг 5. Переключение (окно ~30 минут, по «да» владельца)

### 5.1. Остановить всё, что пишет в переезжающие папки

Владелец закрывает **все** сессии команды над HR. Поставить на паузу недостаточно: процессы `nerve.py tap` у
сессий продолжают двигать курсоры.

```bash
source ~/Backups/split-env.sh
launchctl bootout gui/$(id -u)/space.hrhelper.nerve 2>/dev/null
launchctl bootout gui/$(id -u)/space.hrhelper.t-boards-notebook-sync 2>/dev/null   # синк блокнота — до решения владельца, см. ниже
sleep 3; pgrep -fl 'nerve.py|swarm.py' && echo "СТОП: процессы ещё живы" || echo "ok: Нерв, тапы и рой остановлены"
```

Синк блокнота ставится на паузу по такой причине. Он отправляет на сервер файлы, которые git HR числит своими
(`git ls-files`), а исчезнувшие удаляет из блокнота. После разделения HR больше не числит `t-boards/*.md`
(спецификация досок и другие) и `supertick-eval/**/*.md`. Включённый синк удалил бы их из блокнота на сервере.

Включать его обратно — только по решению владельца. Варианты:
- синк из двух корней (HR и tAIBE) — доработка tAIBE;
- смириться с потерей этих документов в блокноте.

`ssr-sync.mjs` руками не запускать по той же причине.

### 5.2. Свежий снимок и перенос коммитов

Первый снимок сделан несколько часов назад, поэтому повторяем шаги 2.3 и 3.4. Это быстро: бандлы пересоздаются,
`port.sh` пропускает то, что уже перенесено.

```bash
source ~/Backups/split-env.sh
S="$(bash "$BK/scan.sh")"; cat "$S/summary.txt" | grep -E 'СТОП|НЕ СОЗДАН'; echo "снимок: $S"
[ -s "$S/unpushed.txt" ] && while read -r repo branch n; do bash "$BK/port.sh" "$repo" "$branch"; done < "$S/unpushed.txt"
tar -C "$HR" -czf "$BK/state/supertick-eval-state.tgz" supertick-eval/nerve/state supertick-eval/swarm/state 2>/dev/null; ls -la "$BK/state"
```

### 5.3. Перенести данные в tAIBE, не затирая tAIBE

```bash
source ~/Backups/split-env.sh
mkdir -p "$TB/eval/nerve/state" "$TB/eval/swarm/state"            # в tAIBE папки state/ в .gitignore
cp -Rp "$HR/supertick-eval/nerve/state/." "$TB/eval/nerve/state/"
cp -Rp "$HR/supertick-eval/swarm/state/." "$TB/eval/swarm/state/" 2>/dev/null || true
rm -f "$TB/eval/nerve/state/nerve.lock" "$TB/eval/swarm/state/swarm.lock"   # замки остановленных процессов
wc -c < "$TB/eval/nerve/state/nerve.log" > "$BK/state/nerve.log.size" 2>/dev/null || echo 0 > "$BK/state/nerve.log.size"
# неотслеживаемые файлы supertick-eval — только те, которых в tAIBE нет (tar -k не затирает)
cd "$HR" && tr '\0' '\n' < "$S/hr-supertick.untracked.z" | sed 's#^supertick-eval/##' | grep -vE '^(nerve|swarm)/state/' > "$BK/patches/carry.txt"
[ -s "$BK/patches/carry.txt" ] && tar -C "$HR/supertick-eval" -cf - -T "$BK/patches/carry.txt" | tar -C "$TB/eval" -xkf -
git -C "$TB" status --short | head -30
```

Изменённые **отслеживаемые** файлы из `$S/hr-dirs.status.txt`, кроме `nerve/state`, в tAIBE не копировать.
В tAIBE их версии уже другие: пути переписаны, есть доработки. Изменения сохранены в
`$S/hr-dirs.uncommitted.patch`, список нужно передать владельцу.

### 5.4. Мёрж PR, затем убрать папки и поставить ссылки

**«Да» владельца: он вливает PR очистки сейчас.** После мёржа во вкладке Actions HR не должно быть нового
запуска `deploy-contabo` от этого мёржа. Если он запустился — сразу сказать владельцу. Это пересборка того же
кода; ждать её или отменить, решает он.

```bash
source ~/Backups/split-env.sh; cd "$HR"
mv supertick-eval "$BK/moved/supertick-eval"
mv t-boards "$BK/moved/t-boards"                   # вместе с вложенными репозиториями и их worktree
[ -d tAIBoard_and_Eval ] && mv tAIBoard_and_Eval "$BK/moved/"   # старый вложенный клон tAIBE, его снимок есть в $S
git pull --ff-only origin main
git -c core.quotepath=off status --porcelain | grep -E 'supertick-eval|t-boards' && echo "СТОП: пути ещё в git" || echo "ok"
ln -s "$TB/eval" "$HR/supertick-eval"
ln -s "$TB/eval" "$HR/eval"
ln -s "$TB/boards" "$HR/boards"
mkdir -p "$HR/t-boards" && ln -s "$TB/boards" "$HR/t-boards/app"
printf '%s\n' '/supertick-eval' '/eval' '/boards' '/t-boards/' '/.claude/pipeline-settings.json' >> "$HR/.git/info/exclude"
git status --short | head; ls -la "$HR/supertick-eval" "$HR/eval" "$HR/boards" "$HR/t-boards/app"
```

`.claude/pipeline-settings.json` — кэш настроек пайплайна. Его теперь пишет Нерв из tAIBE в корень HR.

Если `git pull` не прошёл — СТОП. Вернуть папки:

```bash
mv "$BK/moved/supertick-eval" "$BK/moved/t-boards" "$HR/"
```

Затем спросить владельца. В выводе `git pull` обычно видно, какой локальный файл мешает.

После ссылок `git status` в HR не должен показывать ни одной из пяти строк из `exclude`.

### 5.5. Запустить обратно

```bash
source ~/Backups/split-env.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/space.hrhelper.nerve.plist
sleep 10; launchctl print gui/$(id -u)/space.hrhelper.nerve | grep -E '^\s*(state|pid) '
echo "nerve.log: было $(cat "$BK/state/nerve.log.size") байт, стало $(wc -c < "$TB/eval/nerve/state/nerve.log")"
tail -5 "$TB/eval/nerve/state/nerve.log"
cd "$HR" && bash infra/scripts/dev-ai/mcp-hub.sh restart hub && bash infra/scripts/dev-ai/mcp-hub.sh check
```

plist Нерва не меняется: в нём путь `HR_Helper-v2/supertick-eval/nerve/nerve.py`, который теперь ведёт в tAIBE.

`restart hub` перезапускает только агрегатор, Serena не переиндексируется.

Если `nerve.log` вырос — посмотреть его последние строки. Ошибки пути или импорта означают СТОП и откат.

## Шаг 6. Проверка — должно сойтись всё

| # | Что | Команда (в `bash`, после `source ~/Backups/split-env.sh`) | Ожидаемо |
|---|---|---|---|
| 1 | Геномы | `"$PY" -I "$TB/eval/pipeline/genome/build.py" --check` | без расхождений |
| 2 | Запуск ролей | `cd "$HR" && bash supertick-eval/tools/spawn_session.sh --launch --roles all --terminal print --dry-run \| grep -c -- '--settings'` | `6`, и каждый файл генома из вывода существует |
| 3 | Хуки HR | `cd "$HR" && for t in .claude/hooks/test_*.py; do "$PY" "$t" >/dev/null 2>&1 \|\| echo "FAIL $t"; done` | ни одного `FAIL` |
| 4 | Нерв | `"$PY" -I "$HR/eval/nerve/nerve.py" status` и `tail -3 "$TB/eval/nerve/state/journal.jsonl"` | демон жив, записи свежие |
| 5 | Тап (проверочная роль, курсоры сессий не трогает) | `"$PY" -I "$HR/eval/nerve/nerve.py" tap selftest --once; echo $?` | `0`, без ошибки пути |
| 6 | launchd-агенты с путями в старые папки | для каждого файла из `$BK/launchd/tied.txt`: `plutil -p <файл> \| grep -oE '/Users/[^"]+' \| while read p; do [ -e "$p" ] \|\| echo "НЕТ $p"; done` | ни одного `НЕТ` (пути `nerve.log` и `state/` создаются при старте) |
| 7 | Туннель | `ifconfig \| grep 'inet 10.77.0.'` | адрес `10.77.0.2` есть |
| 8 | Доски | `curl -sS -o /dev/null -w '%{http_code}\n' https://d4dev.admin.hrhelper.space/api/health` | `200` |
| 9 | Ops-консоль | `curl -sS https://ops.admin.hrhelper.space/api/health` | `{"ok":true}` |
| 10 | MCP досок | `cd "$HR" && bash infra/scripts/dev-ai/mcp-hub.sh status`; в сессии Claude из HR — любой инструмент t-boards (например, список продуктов) | сервер `t-boards` поднят, доски отвечают |
| 11 | Очередь владельца | в сессии Claude из HR: `oq_list checks` | ответ без ошибки |
| 12 | Агенты на Mac | `launchctl list \| grep -E 'hrhelper\|t-boards' \| diff "$BK/launchd/before.txt" -` | расходятся только PID и синк блокнота (на паузе). Скрипты агентов **не запускать**: `notebook-agent.sh check` переписывает их копии в `~` |
| 13 | Блокнот смотрит в HR | `"$PY" -c 'import json,os;print(json.load(open(os.path.expanduser("~/.t-boards-notebook/config.json")))["repoRoot"])'` | путь checkout'а HR, не менять |
| 14 | Бэкап базы досок | `launchctl list \| grep t-boards-backup`; `tail -2 ~/t-boards-backups/pull.log` | агент загружен, последняя строка без `FAILED` |
| 15 | Git обоих | `git -C "$HR" status --short`; `git -C "$TB" status --short` | в HR — только правки владельца, бывшие до начала; в tAIBE — только файлы, перенесённые в 5.3 (список владельцу) |

Если какая-то строка не сошлась — СТОП и откат (раздел ниже), если владелец не решит иначе.

Последний шаг: владелец запускает сессии команды как обычно — из `$HR`, теми же командами
`claude --settings supertick-eval/pipeline/genome/<роль>.json …` или `spawn_session.sh --launch`.

## Откат (2 минуты, данные не теряются)

```bash
source ~/Backups/split-env.sh
launchctl bootout gui/$(id -u)/space.hrhelper.nerve 2>/dev/null
for l in "$HR/supertick-eval" "$HR/eval" "$HR/boards" "$HR/t-boards/app"; do [ -L "$l" ] && rm "$l"; done   # только ссылки
[ -d "$HR/t-boards" ] && rmdir "$HR/t-boards"
[ -e "$HR/supertick-eval" ] || mv "$BK/moved/supertick-eval" "$HR/"
[ -e "$HR/t-boards" ] || mv "$BK/moved/t-boards" "$HR/"
cp -Rp "$TB/eval/nerve/state/." "$HR/supertick-eval/nerve/state/"   # если Нерв успел поработать из tAIBE
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/space.hrhelper.nerve.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/space.hrhelper.t-boards-notebook-sync.plist
cd "$HR" && bash infra/scripts/dev-ai/mcp-hub.sh restart hub
```

Строки, добавленные в `$HR/.git/info/exclude`, убрать руками. Если PR очистки уже влит, git HR покажет
вернувшиеся папки как неотслеживаемые; работе это не мешает. Вернуть их в git — `git revert` PR очистки
отдельным PR, решение владельца.

## Отчёт владельцу (в чат и пунктом очереди `oq_*`)

1. Таблица шага 6 с фактическими выводами.
2. Ссылка на PR очистки HR и подтверждение, что мёрж не запустил деплой.
3. Ветки `rescue/*` в tAIBE: что перенесено, что «уже есть (тема совпала)», что не применилось.
4. Что лежит только в бэкапе `$BK` и ждёт решения:
   - незакоммиченные правки и тайники вложенных репозиториев;
   - изменённые отслеживаемые файлы `supertick-eval/`;
   - перенесённые неотслеживаемые файлы в tAIBE.
5. Синк блокнота на паузе — нужно решение (раздел 5.1).
6. Ветки HR, которые меняют `supertick-eval/` или `t-boards/` (шаг 1): их нельзя вливать до переноса правок в tAIBE.
7. Бэкап `$BK` хранить не меньше недели.

## Что остаётся на потом (не в этот раз)

- **Стенд d4dev.** Не собирать и не выкатывать образ досок (`deploy/vps/bundle.sh`), пока стенд не переключён по
  `process/TRANSFER.md`, раздел «Стенд d4dev». `t-boards/app` теперь ведёт в tAIBE: образ соберётся из его кода с
  перенумерованными миграциями, а бэкап перед этим не сделан.
- **Ops-консоль** собирается деплоем HR (`infra/docker/docker-compose.contabo.yml`, сервис `ops-console`).
  Перевод её на tAIBE затрагивает прод HR: сервер общий, вход идёт через SSO бэкенда HR.
- **Чистка остального в HR — по частям:** консилиум (своя `.claude/council/council.db`), хаб, шлюз моделей,
  очередь владельца, ops-консоль. Для каждой части сначала решить, откуда она работает, и только потом удалять.
- **Синк слоя tAIBE → HR** (скиллы, хуки, правила) — отдельный скрипт и PR в HR. Синк блокнота из двух корней —
  доработка tAIBE.
- **Старые worktree HR** держат настоящие копии `supertick-eval/` и `t-boards/`, пока не подтянут `main`. После
  этого они работают через основной checkout.
- **Мусор, закоммиченный в HR раньше:** `infra/ai-council/council.db` (пустой файл) и снимки в корне
  (`mem.txt`, `ps.txt` и подобные).
