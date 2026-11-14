#!/usr/bin/env bash
# Тест .claude/scripts/heavy-gate.sh (HRH-124). Запуск: bash .claude/scripts/test_heavy_gate.sh — секунд 10, без сети.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
gate="$here/heavy-gate.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HEAVY_GATE_LOCK="$tmp/lock" HEAVY_GATE_POLL=0.2
unset HEAVY_GATE_HELD HEAVY_GATE_STALE_MIN
fail=0
check() { # <имя> <условие…>
  local name="$1"
  shift
  if "$@"; then echo "ok - $name"; else echo "not ok - $name"; fail=1; fi
}
no_lock() { [ ! -d "$HEAVY_GATE_LOCK" ]; }
lstart() { LC_ALL=C ps -o lstart= -p "$1" | sed 's/^ *//;s/ *$//'; }
own() { # <pid> <время старта> <взят, epoch> — записать чужой замок
  mkdir -p "$HEAVY_GATE_LOCK"
  printf '%s\n%s\n%s\nчужой\nsleep\n' "$1" "$2" "$3" >"$HEAVY_GATE_LOCK/owner"
}
finishes() { # <pid> <секунд> — процесс вышел за это время
  local i=0
  while kill -0 "$1" 2>/dev/null; do
    [ "$i" -ge $(($2 * 10)) ] && return 1
    sleep 0.1
    i=$((i + 1))
  done
}

# 1. Код команды и снятый замок.
bash "$gate" sh -c 'exit 7'
rc=$?
check "код возврата — код команды" [ "$rc" -eq 7 ]
check "замок снят после команды" no_lock
bash "$gate" 2>/dev/null
check "без команды — 125" [ $? -eq 125 ]

# 2. Два вызова — по очереди; второй один раз пишет, чей гейт идёт.
bash "$gate" sh -c "echo A1 >>'$tmp/log'; sleep 1; echo A2 >>'$tmp/log'" &
a=$!
sleep 0.4
bash "$gate" sh -c "echo B >>'$tmp/log'" 2>"$tmp/b.err"
wait "$a"
check "второй ждёт первого" [ "$(tr '\n' ' ' <"$tmp/log")" = "A1 A2 B " ]
check "ждущему — чей гейт, один раз" [ "$(grep -c 'чужой гейт' "$tmp/b.err")" -eq 1 ]

# 2б. Команда в замке — без значений: её видят ждущие из других сессий.
bash "$gate" sh -c 'sleep 1' API_TOKEN=s3cr3t --token t0k --filter=@x/y -H 'Authorization: Bearer b3ar' >/dev/null &
m=$!
i=0
while [ ! -s "$HEAVY_GATE_LOCK/owner" ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
shown="$(sed -n 5p "$HEAVY_GATE_LOCK/owner")"
wait "$m"
check "в замке нет значений присваиваний и токенов" sh -c "! printf '%s' '$shown' | grep -q -E 's3cr3t|t0k|@x/y|b3ar'"
check "в замке видна сама команда" [ "${shown%% *}" = sh ]

# 3. Замок умершего владельца снимается сразу.
sh -c 'exit 0' &
dead=$!
wait "$dead"
own "$dead" "Wed Jan  1 00:00:00 2020" "$(date +%s)"
out="$(bash "$gate" echo run 2>&1)"
check "мёртвый владелец — замок снят" [ "$out" = "heavy-gate: снят протухший замок (pid $dead, чужой)
run" ]

# 4. Живой владелец: свежий замок ждут, старше HEAVY_GATE_STALE_MIN — снимают.
sleep 30 &
alive=$!
own "$alive" "$(lstart "$alive")" "$(date +%s)"
bash "$gate" touch "$tmp/ran" 2>/dev/null &
w=$!
sleep 1
check "живой свежий замок — ждут" [ ! -e "$tmp/ran" ]
rm -rf "$HEAVY_GATE_LOCK"
check "замок отпущен — ждущий выполнил" finishes "$w" 3
check "команда ждущего выполнена" [ -e "$tmp/ran" ]
own "$alive" "$(lstart "$alive")" "$(($(date +%s) - 31 * 60))"
out="$(HEAVY_GATE_STALE_MIN=30 bash "$gate" echo run 2>&1)"
check "живой, но старше 30 мин — снят" [ "${out##*$'\n'}" = run ]
kill "$alive" 2>/dev/null
wait "$alive" 2>/dev/null

# 5. Вложенный вызов не ждёт сам себя.
bash "$gate" bash "$gate" echo inner >"$tmp/nested" &
n=$!
check "вложенный вызов не зависает" finishes "$n" 3
check "вложенный вызов выполнен" [ "$(cat "$tmp/nested")" = inner ]
kill "$n" 2>/dev/null

# 6. TERM обёртке гасит команду и отпускает замок.
bash "$gate" sleep 30 &
g=$!
i=0
while [ ! -s "$HEAVY_GATE_LOCK/owner" ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
kid="$(pgrep -P "$g" sleep)"
check "команда — дочерний процесс обёртки" [ -n "$kid" ]
kill -TERM "$g"
check "TERM — обёртка вышла" finishes "$g" 3
check "TERM — замок отпущен" no_lock
check "TERM — команда погашена" sh -c "! kill -0 ${kid:-999999} 2>/dev/null"

# 6b. Составная команда (`bash -c 'cd x && …'` — форма из подсказки хука): TERM гасит и внука, а не только bash -c.
bash "$gate" bash -c 'sleep 31; true' &
g=$!
i=0
while [ ! -s "$HEAVY_GATE_LOCK/owner" ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
sleep 0.3
mid="$(pgrep -P "$g" bash)"
grand="$(pgrep -P "${mid:-999999}" sleep)"
check "составная — внук запущен" [ -n "$grand" ]
kill -TERM "$g"
check "составная, TERM — обёртка вышла" finishes "$g" 3
check "составная, TERM — внук погашен" finishes "${grand:-999999}" 3

# 7. HEAVY_GATE_WAIT=0: занято — код 75, команда не запускалась. Ожидание, снятие и пропуск — в журнале замка.
sleep 30 &
alive=$!
own "$alive" "$(lstart "$alive")" "$(date +%s)"
HEAVY_GATE_WAIT=0 bash "$gate" touch "$tmp/nowait" 2>/dev/null
check "HEAVY_GATE_WAIT=0, занято — код 75" [ $? -eq 75 ]
check "HEAVY_GATE_WAIT=0 — команда не запускалась" [ ! -e "$tmp/nowait" ]
kill "$alive" 2>/dev/null
wait "$alive" 2>/dev/null
rm -rf "$HEAVY_GATE_LOCK"
check "журнал: ожидание" grep -q -E ' wait=[0-9]+s ' "$HEAVY_GATE_LOCK.log"
check "журнал: снятие протухшего" grep -q ' reap ' "$HEAVY_GATE_LOCK.log"
check "журнал: пропуск без ожидания" grep -q ' busy-skip ' "$HEAVY_GATE_LOCK.log"

# 8. Обёртку убили SIGKILL (trap не сработал): команда-сирота держит замок, пока жива.
bash "$gate" sleep 30 &
g=$!
i=0
while [ -z "$(sed -n 6p "$HEAVY_GATE_LOCK/owner" 2>/dev/null)" ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
kid="$(sed -n 6p "$HEAVY_GATE_LOCK/owner")"
kill -KILL "$g"
wait "$g" 2>/dev/null
HEAVY_GATE_WAIT=0 bash "$gate" true 2>/dev/null
check "SIGKILL обёртки — сирота держит замок" [ $? -eq 75 ]
kill "${kid:-999999}" 2>/dev/null
finishes "${kid:-999999}" 3
out="$(bash "$gate" echo run 2>&1)"
check "сирота умерла — замок снят" [ "${out##*$'\n'}" = run ]

exit "$fail"
