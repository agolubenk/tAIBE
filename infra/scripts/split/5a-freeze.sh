#!/bin/bash
# Шаг 5a (окно переключения, после «да» владельца и закрытия ВСЕХ сессий команды над HR): остановить Нерв и синк
# блокнота, свежий снимок и перенос коммитов, снимок состояния, перенос данных в tAIBE (не затирая tAIBE).
export STEP=5a
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

[ -L "$HR/supertick-eval" ] && stop "supertick-eval в HR уже ссылка — 5a уже пройден и 5b начат; дальше: bash $SPLIT_DIR/5b-switch.sh или откат"
if has launchctl; then
  launchctl bootout "$(gui)/space.hrhelper.nerve" 2>/dev/null && log "Нерв остановлен (launchd)"
  # Синк блокнота шлёт на сервер то, что git HR числит своим, и удаляет из блокнота исчезнувшее: после
  # разделения он удалил бы t-boards/*.md и supertick-eval/**/*.md. На паузе до решения владельца.
  launchctl bootout "$(gui)/space.hrhelper.t-boards-notebook-sync" 2>/dev/null && log "синк блокнота на паузе"
fi
sleep 3
p="$(nerve_procs)"
if [ -n "$p" ] && [ "${SPLIT_OWNER_OK_KILL_TAPS:-0}" = 1 ]; then
  # Владелец подтвердил, что окна сессий закрыты: остались осиротевшие тапы/Мониторы — завершить их.
  for pid in $(printf '%s\n' "$p" | awk '{print $1}'); do kill "$pid" 2>/dev/null; done
  sleep 2
  p="$(nerve_procs)"
fi
[ -z "$p" ] || stop "ещё живы процессы Нерва/тапов сессий/роя: $(printf '%s' "$p" | tr '\n' ';') — владелец: закрыть сессии команды (пауза не годится), затем снова bash $0. Если окна уже закрыты, а процессы остались (осиротевшие тапы): SPLIT_OWNER_OK_KILL_TAPS=1 bash $0"
ok "Нерв, тапы сессий и рой остановлены"

S="$(bash "$SPLIT_DIR/scan.sh")"
log "свежий снимок: $S"
grep -q 'БАНДЛ НЕ СОЗДАН' "$S/summary.txt" && stop "не создался бандл (см. $S/summary.txt)"
bash "$SPLIT_DIR/port-all.sh" >/dev/null
rc=$?
[ "$rc" = 5 ] && stop "часть коммитов не применилась в tAIBE (см. $BK/port-report.txt)"
[ "$rc" = 0 ] || stop "перенос коммитов не прошёл (код $rc)"
ok "коммиты вложенных репозиториев перенесены (отчёт $BK/port-report.txt)"

tar -C "$HR" -czf "$BK/state/supertick-eval-state.tgz" supertick-eval/nerve/state supertick-eval/swarm/state 2>/dev/null ||
  tar -C "$HR" -czf "$BK/state/supertick-eval-state.tgz" supertick-eval/nerve/state ||
  stop "не снят архив состояния Нерва"
ok "архив состояния: state/supertick-eval-state.tgz"

mkdir -p "$TB/eval/nerve/state" "$TB/eval/swarm/state" # в tAIBE папки state/ в .gitignore
cp -Rp "$HR/supertick-eval/nerve/state/." "$TB/eval/nerve/state/" || stop "состояние Нерва не скопировалось"
[ -d "$HR/supertick-eval/swarm/state" ] && cp -Rp "$HR/supertick-eval/swarm/state/." "$TB/eval/swarm/state/"
rm -f "$TB/eval/nerve/state/nerve.lock" "$TB/eval/swarm/state/swarm.lock" # замки остановленных процессов
if [ -f "$TB/eval/nerve/state/nerve.log" ]; then wc -c <"$TB/eval/nerve/state/nerve.log" | tr -d ' '; else echo 0; fi >"$BK/state/nerve.log.size"
ok "состояние Нерва и роя → $TB/eval/{nerve,swarm}/state"

# Неотслеживаемые файлы supertick-eval — только те, которых в tAIBE нет (tar -k не затирает).
tr '\0' '\n' <"$S/hr-supertick.untracked.z" | sed 's#^supertick-eval/##' | grep -vE '^(nerve|swarm)/state/' >"$BK/patches/carry.txt" || true
if [ -s "$BK/patches/carry.txt" ]; then
  tar -C "$HR/supertick-eval" -cf - -T "$BK/patches/carry.txt" | tar -C "$TB/eval" -xkf - 2>>"$LOG" || true
  log "неотслеживаемые файлы supertick-eval перенесены без затирания: $(wc -l <"$BK/patches/carry.txt" | tr -d ' ') (список patches/carry.txt)"
fi
changed="$(grep -vE 'supertick-eval/(nerve|swarm)/state/' "$S/hr-dirs.status.txt" | grep -v '^??' | wc -l | tr -d ' ')"
log "изменённые отслеживаемые файлы в supertick-eval/t-boards (не копируются, лежат в $S/hr-dirs.uncommitted.patch): $changed"

wait_owner "владелец вливает PR очистки HR $(cat "$BK/hr-pr-url" 2>/dev/null) и смотрит Actions HR: нового запуска deploy-contabo быть не должно. Затем: bash $SPLIT_DIR/5b-switch.sh"
