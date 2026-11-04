#!/bin/bash
# Открыть новую сессию Claude Code в отдельном окне терминала: наследник по handoff или запуск роли Т3.
#
#   bash eval/tools/spawn_session.sh --handoff FILE [--role KEY]     наследник (порог 80%, хук context-threshold)
#   bash eval/tools/spawn_session.sh --launch --role KEY             запуск роли по её пусковому файлу
#   bash eval/tools/spawn_session.sh --launch --roles all|coord,release,…   несколько ролей, по порядку 1→5→4→3→2→6
#
# (в инстансе HR_Helper-v2 скрипт лежит в supertick-eval/tools/ — работает так же; корень дерева берётся из его места)
# Опции: --cwd DIR (по умолчанию текущая папка: наследник открывается в том же worktree) · --terminal terminal|iterm|print (print — только напечатать
# команду для вкладки терминала VS Code) · --prompt-dir DIR (пусковые файлы ролей) · --dry-run (ничего не открывать)
# · --no-retire (или SPAWN_RETIRE=off): после --handoff предшественник не снимается сам.
# Handoff: наследник после приёма пишет квитанцию (lineage.py ack), сторож lineage.py retire проверяет его и снимает
# предшественника — процессы и окно Terminal (id окна записан при открытии). Уборка остальных — reap_sessions.sh.
# Роль Т3 получает свой геном (--settings genome/<ключ>.json) и первое сообщение «Сборка Т3, ключ реестра <ключ>…» —
# по нему включается правило 90 и Нерв узнаёт роль. Окно открывает osascript: первый раз macOS спросит разрешение
# на управление Terminal. Только bash 3.2 (системный на macOS): без ассоциативных массивов.
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
CWD="$PWD"
TERMINAL="${SPAWN_TERMINAL:-terminal}"
PROMPT_DIR=""
HANDOFF="" ROLE="" ROLES="" LAUNCH=0 DRY=0 RETIRE="${SPAWN_RETIRE:-on}"
SPAWNED_LINE=""  # линия последней открытой сессии (bash 3.2: из функции — только через глобальную)
ORDER="coord release backend frontend plan boards"

die() { echo "spawn_session: $*" >&2; exit 2; }
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }  # строка в одинарных кавычках для bash

while [ $# -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="${2:?}"; shift 2 ;;
    --role) ROLE="${2:?}"; shift 2 ;;
    --roles) ROLES="${2:?}"; shift 2 ;;
    --launch) LAUNCH=1; shift ;;
    --cwd) CWD="${2:?}"; shift 2 ;;
    --terminal) TERMINAL="${2:?}"; shift 2 ;;
    --prompt-dir) PROMPT_DIR="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-retire) RETIRE=off; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done

[ -d "$CWD" ] || die "нет папки $CWD"
CWD="$(cd "$CWD" && pwd)"
# Геномы и пусковые файлы — из рабочей папки, иначе из основного checkout (в свежем worktree их может не быть).
MAIN="$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')" || MAIN=""
in_tree() { if [ -e "$CWD/$1" ] || [ -z "$MAIN" ]; then echo "$CWD/$1"; else echo "$MAIN/$1"; fi; }
# Корень дерева продукта — родитель папки скрипта: supertick-eval/ (инстанс HR) или eval/ (канонический дом).
TREE_REL="$(basename "$(cd "$TOOLS/.." && pwd)")"
in_tree_product() { in_tree "$TREE_REL/$1"; }
PROMPT_DIR="${PROMPT_DIR:-$(in_tree_product prompts/launch-3010/roles)}"
case "$TERMINAL" in terminal|iterm|print) ;; *) die "--terminal: terminal, iterm или print" ;; esac

role_num() {
  case "$1" in
    coord) echo 1 ;; plan) echo 2 ;; frontend) echo 3 ;; backend) echo 4 ;; release) echo 5 ;; boards) echo 6 ;;
    *) return 1 ;;
  esac
}

# Линия потомков: у каждой новой сессии свой id — id родителя (TAIBE_LINEAGE, корень «r») + 4 случайных символа;
# поколение — число точек. Один шаблон запуска делает сессии единообразными, id — различимыми в журналах, на
# карточках (метка session) и в handoff: наследник не путает свою работу с работой предка или сиблинга.
child_lineage() {
  local tail
  tail="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 4)" || true
  [ -n "$tail" ] || tail="$$"
  printf '%s.%s' "${TAIBE_LINEAGE:-r}" "$tail"
}
generation() { printf '%s' "$1" | tr -cd '.' | wc -c | tr -d ' '; }

# Первое сообщение новой сессии → stdout. $2 — id линии новой сессии.
first_message() {
  local role="$1" lineage="$2" num file tag
  tag=" Линия: $lineage (поколение $(generation "$lineage")) — метка session на карточках и в очереди."
  if [ -n "$HANDOFF" ]; then
    # Квитанция — последним шагом приёма: по ней сторож снимает предшественника, Monitor и кроны к этому времени свои.
    tag="$tag После приёма и перевзвода Monitor и кронов выполни: python3 -I $TOOLS/lineage.py ack — по этой квитанции предшественник закроется сам."
    if [ -n "$role" ]; then
      num="$(role_num "$role")" || die "неизвестная роль: $role (coord plan frontend backend release boards)"
      printf 'Сборка Т3, ключ реестра %s, роль %s, наследник. Handoff: %s — прочитай его первым, сверь факты с живыми источниками (скилл successor-handoff) и действуй по нему. Предшественнику подтверди приём через SendMessage.%s' "$role" "$num" "$HANDOFF" "$tag"
    else
      printf 'Наследник сессии. Handoff: %s — прочитай его первым, сверь факты с живыми источниками (скилл successor-handoff) и действуй по нему. Предшественнику подтверди приём через SendMessage.%s' "$HANDOFF" "$tag"
    fi
    return
  fi
  num="$(role_num "$role")" || die "неизвестная роль: $role (coord plan frontend backend release boards)"
  file="$PROMPT_DIR/$num-$role.md"
  [ -f "$file" ] || die "нет пускового файла $file"
  printf 'Сборка Т3, ключ реестра %s, роль %s. Пусковой файл: %s — прочитай его первым и действуй по нему.%s' \
    "$role" "$num" "$file" "$tag"
}

# Одна сессия: пусковой скрипт в $TMPDIR, затем окно терминала (или печать команды).
spawn_one() {
  local role="$1" msg genome="" dir launcher cmd lineage out wid tty
  lineage="$(child_lineage)"
  SPAWNED_LINE="$lineage"
  msg="$(first_message "$role" "$lineage")"
  if [ -n "$role" ]; then
    genome="$(in_tree_product "pipeline/genome/$role.json")"
    [ -f "$genome" ] || die "нет генома $genome (build.py собирает его из roles.json)"
  fi
  # Своя папка 700 через mktemp: в общем /tmp предсказуемое имя дало бы чужому процессу подменить скрипт.
  dir="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/claude-spawn.XXXXXX")" || die "mktemp не создал папку"
  launcher="$dir/${role:-successor}.sh"
  # Текст — отдельным файлом: printf %q в bash 3.2 режет кириллицу по байтам.
  printf '%s' "$msg" > "$launcher.msg"
  {
    echo '#!/bin/bash'
    # Наследник — новая сессия верхнего уровня, а не дочерняя: маркеры родителя, унаследованные через окружение
    # (запуск из вкладки, открытой самой сессией, или --terminal print в её Bash), выключают у новой сессии запись
    # транскрипта («Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker»). Без транскрипта
    # не работают хук context-threshold, Stop-typecheck, замеры eval (wake_anatomy, context_audit) и claude-mem.
    echo "unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE"
    echo "export TAIBE_LINEAGE=$(sq "$lineage")"
    echo "cd $(sq "$CWD") || exit 1"
    # текст прочитан — папка больше не нужна: временные пусковые файлы не копятся
    echo "m=\"\$(cat $(sq "$launcher.msg"))\"; rm -rf $(sq "$dir")"
    if [ -n "$genome" ]; then
      echo "exec \"\${CLAUDE_BIN:-claude}\" --settings $(sq "$genome") \"\$m\""
    else
      echo "exec \"\${CLAUDE_BIN:-claude}\" \"\$m\""
    fi
  } > "$launcher"
  chmod 700 "$launcher"
  chmod 600 "$launcher.msg"
  cmd="/bin/bash $(sq "$launcher")"
  if [ "$TERMINAL" != print ] && [ "$DRY" = 0 ] && ! command -v osascript >/dev/null 2>&1; then
    echo "# osascript нет (Linux/SSH) — окно не открыть, команда ниже" >&2
    TERMINAL=print
  fi
  if [ "$TERMINAL" = print ] || [ "$DRY" = 1 ]; then
    echo "# ${role:-наследник}: вставить в новую вкладку терминала"
    echo "$cmd"
    if [ "$DRY" = 1 ]; then sed -n '2,$p' "$launcher"; cat "$launcher.msg"; echo; rm -rf "$dir"; return; fi
    record "$lineage" print "" "" "$role"
    return
  fi
  if [ "$TERMINAL" = iterm ]; then
    osascript -e "tell application \"iTerm\" to create window with default profile command \"$cmd\"" >/dev/null
    record "$lineage" iterm "" "" "$role"
  else
    # id окна и tty вкладки — сразу при открытии: у окна нет tty, у вкладки нет id; по ним сторож закроет именно его.
    out="$(osascript -e 'tell application "Terminal"' -e "set t to do script \"$cmd\"" -e 'activate' \
      -e 'try' -e 'set w to first window whose tabs contains t' -e 'return ((id of w) as text) & " " & (tty of t)' \
      -e 'on error' -e 'return "- " & (tty of t)' -e 'end try' -e 'end tell')" || out=""
    wid="${out%% *}"; tty="${out#* }"
    case "$wid" in *[!0-9]*|"") wid="" ;; esac
    case "$tty" in /dev/tty*) ;; *) tty="" ;; esac
    record "$lineage" terminal "$wid" "$tty" "$role"
  fi
  echo "открыто: ${role:-наследник} → $launcher"
}

# Запись линии (окно, tty) для сторожа и reap_sessions.sh. Сбой — предупреждение: окно уже открыто.
record() {
  python3 -I "$TOOLS/lineage.py" record --line "$1" --terminal "$2" --window-id "$3" --tty "$4" --role "$5" \
    || echo "# spawn_session: запись линии $1 не сохранена — окно закроется только по tty" >&2
}

case "${TMPDIR:-}$CWD" in *\"*|*\\*) die "кавычка или обратный слэш в пути — osascript не примет" ;; esac

if [ -n "$HANDOFF" ]; then
  [ "$LAUNCH" = 0 ] && [ -z "$ROLES" ] || die "--handoff не сочетается с --launch/--roles"
  [ -f "$HANDOFF" ] || die "нет файла handoff: $HANDOFF"
  HANDOFF="$(cd "$(dirname "$HANDOFF")" && pwd)/$(basename "$HANDOFF")"
  # Handoff — только дельта: строки, которые наследник и так получит из CLAUDE.md и правил, стоят токенов зря.
  # Предупреждение, не стоп: handoff пишется на исходе контекста, переписывать его некогда.
  settings="$(cd "$TOOLS/../.." && pwd)/.claude/scripts/pipeline_settings.py"
  if [ -f "$settings" ] && ! python3 -I "$settings" enabled handoffDupes; then
    :  # выключено в настройках продукта (tAI-Boards → «Pipeline & evolution», handoffDupes)
  elif [ -f "$TOOLS/../evolve/dupes.py" ] && command -v python3 >/dev/null 2>&1; then
    python3 -I "$TOOLS/../evolve/dupes.py" --against-l1 "$HANDOFF" --max-waste "${SPAWN_MAX_WASTE:-300}" --top 5 >&2 \
      || echo "# spawn_session: handoff повторяет постоянный контекст — в следующий раз пиши только дельту" >&2
  fi
  spawn_one "$ROLE"
  # Предшественник уходит сам: сторож ждёт квитанцию наследника и проверяет его, модель в этом не участвует.
  if [ "$DRY" = 0 ] && [ "$RETIRE" != off ]; then
    python3 -I "$TOOLS/lineage.py" retire --child "$SPAWNED_LINE" ${ROLE:+--role "$ROLE"} \
      || echo "# spawn_session: сторож не запущен — предшественник останется, уберёт reap_sessions.sh" >&2
  fi
elif [ "$LAUNCH" = 1 ]; then
  if [ -n "$ROLES" ]; then
    [ "$ROLES" = all ] && ROLES="$ORDER"
    first=1
    for r in $(echo "$ROLES" | tr ',' ' '); do
      [ "$first" = 1 ] || [ "$TERMINAL" = print ] || [ "$DRY" = 1 ] || sleep 3  # окна не стартуют разом: MCP и индексация не толкаются
      first=0
      spawn_one "$r"
    done
  else
    [ -n "$ROLE" ] || die "--launch: нужен --role KEY или --roles LIST"
    spawn_one "$ROLE"
  fi
else
  die "нужен --handoff FILE или --launch (см. --help)"
fi
