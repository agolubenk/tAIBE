#!/bin/bash
# Открыть новую сессию Claude Code в отдельном окне терминала: наследник по handoff или запуск роли Т3.
#
#   bash eval/tools/spawn_session.sh --handoff FILE [--role KEY]     наследник (порог 80%, хук context-threshold)
#   bash eval/tools/spawn_session.sh --launch --role KEY             запуск роли по её пусковому файлу
#   bash eval/tools/spawn_session.sh --launch --roles all|coord,release,…   несколько ролей, по порядку 1→5→4→3→2→6
#   bash eval/tools/spawn_session.sh --status | --stop                 роли продукта и пульс нерва | команды kill для владельца
#
# --launch идемпотентен (OPS-24): сначала поднимает нерв (не загружен → bootstrap, молчит → kickstart), живую роль
# продукта пропускает («жива: …»), после открытия ждёт сессию новой линии до SPAWN_WAIT с (90), затем следующую роль;
# в конце печатает итог. --force — открыть и при живой роли. Продукт — основной checkout папки --cwd (team_status.py).
# (в инстансе HR_Helper-v2 скрипт лежит в supertick-eval/tools/ — работает так же; корень дерева берётся из его места)
# Опции: --cwd DIR (по умолчанию текущая папка: наследник открывается в том же worktree) · --terminal terminal|iterm|print (print — только напечатать
# команду для вкладки терминала VS Code) · --prompt-dir DIR (пусковые файлы ролей) · --dry-run (ничего не открывать)
# · --no-retire (или SPAWN_RETIRE=off): после --handoff предшественник не снимается сам
# · --keep-window (или SPAWN_AUTOCLOSE=off): окно Terminal не закрывается само после выхода claude.
# Окно Terminal закрывается само, когда claude в нём вышел с кодом 0: 10 с отсчёта (Enter — оставить), затем
# lineage.py autoclose — окно этой линии, одна вкладка, в ней только shell; настройка Terminal «When the shell exits»
# не важна. Код ≠ 0 — окно остаётся. Код выхода пишется в запись линии (lineage.py exited) для автоуборки.
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
HANDOFF="" ROLE="" ROLES="" LAUNCH=0 DRY=0 RETIRE="${SPAWN_RETIRE:-on}" FORCE=0 INFO=""
CLOSE="${SPAWN_AUTOCLOSE:-on}"
DELAY="${SPAWN_CLOSE_DELAY:-10}"  # с отсчёта перед закрытием окна (Enter — оставить)
case "$DELAY" in ''|*[!0-9]*) DELAY=10 ;; esac
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
    --keep-window) CLOSE=off; shift ;;
    --force) FORCE=1; shift ;;
    --status) INFO=status; shift ;;
    --stop) INFO=stop; shift ;;
    -h|--help) awk 'NR>1{if(/^#/)print;else exit}' "$0"; exit 0 ;;  # шапка до первой строки кода — без номеров строк
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
# Дом слоя — настоящая папка скрипта, без ссылок (05.11: в хосте ссылок на tAIBE больше нет).
LAYER="$(cd "$TOOLS/.." && pwd -P)"
# Своя копия дерева в рабочей папке (worktree tAIBE) — её; дерево хоста через ссылку или без дерева — дом слоя:
# геном и пусковые файлы тогда не идут через ссылку, которую снимут под живой сессией.
in_tree_product() {
  if [ -d "$CWD/$TREE_REL" ] && [ ! -L "$CWD/$TREE_REL" ]; then in_tree "$TREE_REL/$1"; else echo "$LAYER/$1"; fi
}
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
  local tail parent
  tail="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 4)" || true
  [ -n "$tail" ] || tail="$$"
  # Сессия после --resume теряет TAIBE_LINEAGE: линию даёт её первый промпт (lineage.py line), иначе корень «r».
  parent="${TAIBE_LINEAGE:-}"
  [ -n "$parent" ] || parent="$(python3 -I "$TOOLS/lineage.py" line 2>/dev/null)" || parent=""
  printf '%s.%s' "${parent:-r}" "$tail"
}
generation() { printf '%s' "$1" | tr -cd '.' | wc -c | tr -d ' '; }

# Первое сообщение новой сессии → stdout. $2 — id линии новой сессии.
first_message() {
  local role="$1" lineage="$2" num file tag
  tag=" Линия: $lineage (поколение $(generation "$lineage")) — метка session на карточках и в очереди."
  if [ -n "$HANDOFF" ]; then
    # Квитанция — последним шагом приёма: по ней сторож снимает предшественника, Monitor и кроны к этому времени свои.
    tag="$tag Последним шагом приёма (после Monitor, если ты его взводишь) выполни: python3 -I $TOOLS/lineage.py ack — по этой квитанции предшественник закроется сам."
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
  if [ "$TERMINAL" != print ] && [ "$DRY" = 0 ] && ! command -v osascript >/dev/null 2>&1; then
    echo "# osascript нет (Linux/SSH) — окно не открыть, команда ниже (и без autoclose)" >&2
    TERMINAL=print
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
    if [ "$TERMINAL" = terminal ] && [ "$CLOSE" = on ]; then
      # Без exec: после выхода claude скрипт закрывает своё окно (06.11: 33 сессии и своп 36 из 37 ГБ — окна
      # закончившихся сессий висели с zsh). set -m — claude лидер своей группы на переднем плане, как при exec:
      # Ctrl-C и сторож retire снимают его группу. Код ≠ 0 (сбой, KILL) — окно остаётся, видна причина. Закрывает
      # отцепленный lineage.py autoclose после выхода скрипта: только окно этой линии и только если в нём один shell.
      echo "set -m"
      if [ -n "$genome" ]; then
        echo "\"\${CLAUDE_BIN:-claude}\" --settings $(sq "$genome") \"\$m\"; rc=\$?"
      else
        echo "\"\${CLAUDE_BIN:-claude}\" \"\$m\"; rc=\$?"
      fi
      # Код выхода — в запись линии: автоуборка закрывает только окна с кодом 0 и не раньше чем через 10 мин.
      echo "L=$(sq "$TOOLS/lineage.py")"
      echo "python3 -I \"\$L\" exited --rc \"\$rc\" >/dev/null 2>&1 </dev/null || true"
      echo "[ \"\$rc\" = 0 ] || { echo \"claude вышел с кодом \$rc — окно оставлено\"; exit \"\$rc\"; }"
      echo "echo \"claude вышел. Окно закроется через $DELAY с — Enter, чтобы оставить.\""
      echo "if read -r -t $DELAY _; then python3 -I \"\$L\" exited --rc 0 --keep >/dev/null 2>&1 </dev/null || true; echo \"окно оставлено\"; exit 0; fi"
      echo "python3 -I \"\$L\" autoclose --tty \"\$(tty)\" --pid \$\$ >/dev/null 2>&1 </dev/null || true"
      echo "exit 0"
    elif [ -n "$genome" ]; then
      echo "exec \"\${CLAUDE_BIN:-claude}\" --settings $(sq "$genome") \"\$m\""
    else
      echo "exec \"\${CLAUDE_BIN:-claude}\" \"\$m\""
    fi
  } > "$launcher"
  chmod 700 "$launcher"
  chmod 600 "$launcher.msg"
  cmd="/bin/bash $(sq "$launcher")"
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

# Одна роль в --launch: живую пропустить, иначе открыть и дождаться её сессии. Итог — строкой в SUMMARY.
SUMMARY=""
note() { SUMMARY="$SUMMARY$(printf '\n  %s' "$*")"; }
launch_role() {
  local r="$1" live rc got
  role_num "$r" >/dev/null || die "неизвестная роль: $r (coord plan frontend backend release boards)"
  if [ "$FORCE" = 0 ]; then
    rc=0; live="$(python3 -I "$TOOLS/team_status.py" live --role "$r" --cwd "$CWD" 2>&1)" || rc=$?
    if [ "$rc" = 0 ]; then echo "жива: $r · $live"; note "$r — жива, не открывал: $live"; return; fi
    # Открывать только по явному «роли нет» (rc 3). Любой другой rc (1 — трейсбек Python, 2 — ошибка) — проверка
    # сломалась: вторая сессия той же роли хуже, чем пропуск, видный в итоге.
    if [ "$rc" != 3 ]; then echo "# $r: проверка живой роли не прошла: $live" >&2; note "$r — НЕ открыта: проверка не прошла (--force — открыть)"; return; fi
  fi
  spawn_one "$r"
  if [ "$TERMINAL" = print ] || [ "$DRY" = 1 ]; then note "$r — команда напечатана"; return; fi
  echo "жду сессию $r (до ${SPAWN_WAIT:-90} с)…"
  got="$(python3 -I "$TOOLS/team_status.py" wait --role "$r" --line "$SPAWNED_LINE" --timeout "${SPAWN_WAIT:-90}" 2>&1)" \
    && note "$r — поднята: $got" || note "$r — открыта, сессия НЕ появилась: $got"
}

case "${TMPDIR:-}$CWD" in *\"*|*\\*) die "кавычка или обратный слэш в пути — osascript не примет" ;; esac

if [ -n "$INFO" ]; then
  [ -z "$HANDOFF" ] && [ "$LAUNCH" = 0 ] || die "--status/--stop не сочетаются с --handoff/--launch"
  exec python3 -I "$TOOLS/team_status.py" "$INFO" --cwd "$CWD"
elif [ -n "$HANDOFF" ]; then
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
  else
    [ -n "$ROLE" ] || die "--launch: нужен --role KEY или --roles LIST"
    ROLES="$ROLE"
  fi
  # Весь список — до нерва и первой роли: опечатка в третьей не должна срывать запуск после двух открытых.
  for r in $(echo "$ROLES" | tr ',' ' '); do
    role_num "$r" >/dev/null || die "неизвестная роль: $r (coord plan frontend backend release boards)"
  done
  # Сначала нерв: роли без него не получают назначений. Сбой — в итог, запуск ролей не останавливает.
  if [ "$DRY" = 1 ]; then nerve="$(python3 -I "$TOOLS/team_status.py" nerve 2>&1)" || true
  else nerve="$(python3 -I "$TOOLS/team_status.py" nerve --fix 2>&1)" || true; fi
  echo "$nerve"
  # Следующая роль — после того, как сессия предыдущей появилась (wait): окна не стартуют разом, MCP и индексация
  # не толкаются. Сессия не появилась — таймаут в итог, дальше по порядку.
  for r in $(echo "$ROLES" | tr ',' ' '); do launch_role "$r"; done
  echo "итог ($(basename "${MAIN:-$CWD}")):$SUMMARY"
  python3 -I "$TOOLS/team_status.py" nerve 2>&1 | sed 's/^/  /' || true
else
  die "нужен --handoff FILE или --launch (см. --help)"
fi
