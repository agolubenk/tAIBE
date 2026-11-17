#!/usr/bin/env bash
# Один тяжёлый гейт на машину (HRH-124): tsc, vitest, сборки всех сессий HR, tAIBE и worktree — по очереди.
# Замер Контроля 14.11: 4 параллельных tsc = 4 × 3,3 ГБ = 13 ГБ на Mac с 24 ГБ — memguard снимал сессии.
#
#   .claude/scripts/heavy-gate.sh <команда> [аргументы…]
#   .claude/scripts/heavy-gate.sh bash -c 'cd apps/backend && npx tsc --noEmit -p tsconfig.json'
#
# Замок — каталог (mkdir атомарен), один на машину: ~/.claude/locks/heavy-gate. Занят — ждём, а не падаем; кто держит,
# пишем один раз. Замок снимается сразу, когда умерли и обёртка, и её команда (pid и время старта: pid мог достаться
# другому процессу; обёртку убили SIGKILL — команда-сирота держит замок, пока жива), живой — когда он старше
# HEAVY_GATE_STALE_MIN минут (гейт завис). Снимает протухший замок только один ждущий —
# под вторым замком `.reap`, иначе двое снимут и свежий замок первого. Вложенный вызов (обёртка внутри обёртки)
# замок не ждёт. Команда идёт дочерним процессом: сигнал обёртке (TERM, INT, HUP) гасит команду и отпускает замок.
# Код возврата — код команды; 75 — замок занят при HEAVY_GATE_WAIT=0 (команда не запускалась); 125 — сбой обёртки.
# Ожидание и снятие протухшего замка — строка в журнал `<замок>.log` (время, событие, кто), без текста команды.
#
# Переменные: HEAVY_GATE_LOCK — каталог замка; HEAVY_GATE_STALE_MIN — 30; HEAVY_GATE_POLL — секунды между
# попытками, 2; HEAVY_GATE_LABEL — кто держит, для сообщения ждущим (по умолчанию имя текущей папки);
# HEAVY_GATE_WAIT=0 — не ждать: занято — выйти с кодом 75 (для best-effort проверок, Stop-хук typecheck).
set -u

if [ $# -eq 0 ]; then
  echo "heavy-gate: нет команды — heavy-gate.sh <команда> [аргументы…]" >&2
  exit 125
fi

LOCK="${HEAVY_GATE_LOCK:-$HOME/.claude/locks/heavy-gate}"
STALE_MIN="${HEAVY_GATE_STALE_MIN:-30}"
POLL="${HEAVY_GATE_POLL:-2}"
LABEL="${HEAVY_GATE_LABEL:-$(basename "$PWD")}"

if [ "${HEAVY_GATE_HELD:-}" = "$LOCK" ]; then exec "$@"; fi # замок уже у внешней обёртки

log() { printf '%s %s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$1" "$LABEL" >>"$LOCK.log" 2>/dev/null; }

proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || date +%s; }
field() { sed -n "${1}p" "$LOCK/owner" 2>/dev/null; } # 1 pid, 2 время старта, 3 взят (epoch), 4 кто, 5 команда,
# 6 pid команды, 7 её время старта
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(proc_start "$1")" = "$2" ]; } # <pid> <время старта>

# Протух ли замок с владельцем <pid> <время старта>: 0 — да.
stale() {
  local since
  if [ -z "$1" ]; then # каталог создан, владелец ещё не записан — протух, только если так висит долго
    [ $(($(date +%s) - $(mtime "$LOCK"))) -gt 30 ]
    return
  fi
  if ! alive "$1" "$2" && ! alive "$(field 6)" "$(field 7)"; then return 0; fi # умерли обёртка и команда
  since="$(field 3)"
  [ -n "$since" ] && [ $(($(date +%s) - since)) -ge $((STALE_MIN * 60)) ]
}

# Снять замок, если владелец всё тот же <pid|время старта>; 0 — снят.
reap() {
  local rc=1
  if [ -d "$LOCK.reap" ] && [ $(($(date +%s) - $(mtime "$LOCK.reap"))) -gt 30 ]; then rmdir "$LOCK.reap" 2>/dev/null; fi
  mkdir "$LOCK.reap" 2>/dev/null || return 1
  if [ "$(field 1)|$(field 2)" = "$1" ] && rm -rf "$LOCK" && [ ! -d "$LOCK" ]; then rc=0; fi
  rmdir "$LOCK.reap" 2>/dev/null
  return "$rc"
}

mkdir -p "$(dirname "$LOCK")" || exit 125
said=""
since=$(date +%s)
while ! mkdir "$LOCK" 2>/dev/null; do
  pid="$(field 1)"
  start="$(field 2)"
  if stale "$pid" "$start"; then
    who="pid ${pid:-?}, $(field 4)"
    if reap "$pid|$start"; then
      echo "heavy-gate: снят протухший замок ($who)" >&2
      log "reap"
      continue
    fi
  elif [ "${HEAVY_GATE_WAIT:-}" = 0 ]; then
    echo "heavy-gate: занято — pid ${pid:-?}, $(field 4); HEAVY_GATE_WAIT=0 — не жду, команда не запущена" >&2
    log "busy-skip"
    exit 75
  elif [ -z "$said" ]; then
    echo "heavy-gate: идёт чужой гейт — pid ${pid:-?}, $(field 4): $(field 5) — жду (протухнет через ${STALE_MIN} мин;" \
      "из Bash-инструмента — run_in_background: его таймаут не больше 600 с)" >&2
    said=1
  fi
  sleep "$POLL"
done
if [ -n "$said" ]; then log "wait=$(($(date +%s) - since))s"; fi

# Команда для ждущих — в чаты других сессий, поэтому без значений: `NAME=…` и слово после флага с token|key|secret|
# password — `***`, длина — до 120 символов.
shown="$(printf '%s ' "$@" | tr '\n' ' ' |
  sed -E 's/([A-Za-z_][A-Za-z0-9_]*)=[^[:space:]]*/\1=***/g; s/(-[-A-Za-z_]*(token|key|secret|password|passwd|pass)[-A-Za-z_]*)[[:space:]]+[^[:space:]]+/\1 ***/g; s/(Bearer|Basic|Token)[[:space:]]+[^[:space:]]+/\1 ***/g' |
  cut -c1-120)"
me="$$|$(proc_start $$)"
printf '%s\n%s\n%s\n%s\n%s\n' "$$" "${me#*|}" "$(date +%s)" "$LABEL" "$shown" >"$LOCK/owner"

child=""
release() {
  if [ "$(field 1)|$(field 2)" = "$me" ]; then rm -rf "$LOCK"; fi
}
stop() { # <код> — сигнал обёртке: погасить команду, отпустить замок
  if [ -n "$child" ]; then
    # Своя группа процессов (set -m при запуске): TERM всей группе гасит и внуков — `bash -c 'cd x && tsc'`
    # сам TERM детям не пересылает, и tsc остался бы сиротой без замка (линза Контроля #338).
    kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit "$1"
}
trap release EXIT
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP

export HEAVY_GATE_HELD="$LOCK"
set -m # команда — лидер своей группы процессов
"$@" &
child=$!
set +m
printf '%s\n%s\n' "$child" "$(proc_start "$child")" >>"$LOCK/owner"
wait "$child"
rc=$?
child=""
exit "$rc"
