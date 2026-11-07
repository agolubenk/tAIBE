#!/usr/bin/env bash
# Единый локальный MCP-хаб для всех ИИ-клиентов (Copilot Chat, Continue, Roo, Kimi Code, Codex,
# Claude Code): один набор серверов, один набор секретов, одна OAuth-авторизация на всех.
#
# Три фоновых процесса, запускаются этой командой (при входе в систему — LaunchAgent, `autostart on`):
#   serena       — по streamable HTTP, :9121, код продукта-хоста (HOST_ROOT, HR). Одна LSP-индексация на всех
#                  клиентов вместо копии на каждого (копии мешали друг другу стартовать);
#   serena-taibe — :9122, сам tAIBE (основная папка), без дашборда. Обе только на чтение, версия закреплена
#                  (lib/mcp-hub-serena.sh, README хаба — «Две serena»);
#   хаб          — агрегатор 1mcp, :3050/mcp. Список серверов — infra/mcp-hub/mcp.json (копируется в
#                  ~/.config/hr-helper-mcp-hub/: рядом с конфигом 1mcp пишет своё состояние, в репо
#                  ему не место).
# Claude Code ходит в serena напрямую — имена инструментов mcp__serena__* не меняются (хаб
# добавляет префикс `<сервер>_1mcp_`, а на эти имена завязаны агенты и permissions): user-scope `serena` —
# :9121, а `serena` из .mcp.json tAIBE (:9122) перекрывает её в сессиях tAIBE.
# Подключение клиентов, OAuth, добавление сервера — infra/mcp-hub/README.md.
#
#   bash infra/scripts/dev-ai/mcp-hub.sh {init|auth|admin|start|stop|restart [hub]|status|check|logs [N]|sync|connectors|connect <имя>|disconnect <имя>|autostart on|off|status}
#   npm run mcp-hub:init | mcp-hub:auth | mcp-hub:start | mcp-hub:stop | mcp-hub:restart | mcp-hub:status | mcp-hub:logs | mcp-hub:sync
#   npm run mcp-hub:connectors | mcp-hub:connect -- <имя> | mcp-hub:disconnect -- <имя>
#   npm run mcp-hub:autostart -- on|off|status
#
# init  — то, что запускает задача VS Code при открытии папки (.vscode/tasks.json): start + auth.
# auth  — открыть авторизацию всем, кто её ждёт (lib/mcp-hub-admin.sh); коннекторы — там же.
# autostart — LaunchAgent macOS, который при входе в систему зовёт start (lib/mcp-hub-autostart.sh).
# check — код 0, только если обе serena и хаб живы, держат свои порты, обслуживают свои папки и
#         отвечают (lib/mcp-hub-health.sh; его зовёт ai-restart-all.sh).
#
# Процессы стартуют в своей сессии (конец задачи VS Code их не гасит), stop гасит всё дерево,
# start/stop/restart — под замком, сироты прошлых запусков берутся под управление или
# останавливаются (lib/proc-lifecycle.sh; разбор — README хаба, «Старт и стоп»). Общие сервисы
# обслуживают основную папку репо: из связанного worktree start/restart/init отказывают
# (MCP_HUB_ALLOW_WORKTREE=1 — осознанно обслуживать его копию). Для теста
# (tests/mcp-hub-detach.test.sh) каталоги и uvx переопределяются: MCP_HUB_CONFIG_DIR,
# MCP_HUB_RUNTIME_DIR, MCP_HUB_LOG_DIR, MCP_HUB_UVX, MCP_HUB_STOP_WAIT, MCP_HUB_SETTLE_WAIT, порты —
# MCP_HUB_PORT, SERENA_HTTP_PORT, SERENA_TAIBE_PORT (у нестандартного порта свои pid-файлы и логи:
# serena-<порт>.pid, serena-taibe-<порт>.pid); serena — SERENA_BIN (пусто — через uvx), SERENA_HOME,
# SERENA_TAIBE_PROJECT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Основная папка репо: в связанном worktree .git — файл «gitdir: <основная>/.git/worktrees/<имя>».
# Её и обслуживают общие хаб и serena: worktree удалят — serena осталась бы индексировать
# несуществующий каталог, а stdio-серверы хаба — без своего кода.
MAIN_ROOT="$ROOT"
if [ -f "$ROOT/.git" ]; then
  MAIN_ROOT="$(sed -n 's|^gitdir: \(.*\)/\.git/worktrees/.*|\1|p' "$ROOT/.git" 2>/dev/null || true)"
  [ -n "$MAIN_ROOT" ] && [ -d "$MAIN_ROOT" ] || MAIN_ROOT="$ROOT"
fi
SERVE_ROOT="$MAIN_ROOT"
if [ "${MCP_HUB_ALLOW_WORKTREE:-}" = 1 ]; then SERVE_ROOT="$ROOT"; fi

HUB_PORT="${MCP_HUB_PORT:-3050}"
SERENA_PORT="${SERENA_HTTP_PORT:-9121}"
SERENA_TAIBE_PORT="${SERENA_TAIBE_PORT:-9122}"
[ "$SERENA_PORT" != "$SERENA_TAIBE_PORT" ] || { echo "✗ serena и serena-taibe на одном порту :$SERENA_PORT" >&2; exit 1; }
ONE_MCP_VERSION="0.39.3"
CONFIG_SRC="$ROOT/infra/mcp-hub/mcp.json"
CONFIG_DIR="${MCP_HUB_CONFIG_DIR:-$HOME/.config/hr-helper-mcp-hub}"
# 1mcp ставится в свой каталог, а не через npx: путь стабилен, и в его админку можно встроить
# ссылки хаба (каталог npx-кеша назван по хешу и может быть пересоздан в любой момент).
RUNTIME_DIR="${MCP_HUB_RUNTIME_DIR:-$CONFIG_DIR/runtime}"
ONE_MCP_PKG_DIR="$RUNTIME_DIR/node_modules/@1mcp/agent"
ONE_MCP_BIN="$RUNTIME_DIR/node_modules/.bin/1mcp"
LOG_DIR="${MCP_HUB_LOG_DIR:-$HOME/Library/Logs/hr-helper-mcp-hub}"
# shellcheck disable=SC2034 # запасной запуск serena — serena_launcher в lib/mcp-hub-serena.sh
UVX="${MCP_HUB_UVX:-uvx}"
# У нестандартного порта свои pid-файлы и логи (serena-<порт>.pid, hub-<порт>.log): иначе запуск с
# одним переопределённым портом перезаписал бы и удалил pid-файлы боевых сервисов и ротировал их логи.
SERENA_SFX=""
SERENA_TAIBE_SFX=""
HUB_SFX=""
if [ "$SERENA_PORT" != 9121 ]; then SERENA_SFX="-$SERENA_PORT"; fi
if [ "$SERENA_TAIBE_PORT" != 9122 ]; then SERENA_TAIBE_SFX="-$SERENA_TAIBE_PORT"; fi
if [ "$HUB_PORT" != 3050 ]; then HUB_SFX="-$HUB_PORT"; fi
SERENA_PID_FILE="$CONFIG_DIR/serena$SERENA_SFX.pid"
SERENA_TAIBE_PID_FILE="$CONFIG_DIR/serena-taibe$SERENA_TAIBE_SFX.pid"
HUB_PID_FILE="$CONFIG_DIR/hub$HUB_SFX.pid"
SERENA_LOG="$LOG_DIR/serena$SERENA_SFX.log"
SERENA_TAIBE_LOG="$LOG_DIR/serena-taibe$SERENA_TAIBE_SFX.log"
HUB_LOG="$LOG_DIR/hub$HUB_SFX.log"
AUTH_MARK_DIR="$CONFIG_DIR/auth-prompted"
CONNECTORS_FILE="$CONFIG_DIR/connectors.enabled"

# Ожидания, секунды. Первый старт serena (uvx + LSP на монорепо) — до минуты.
SERENA_START_WAIT=120
SERENA_TAIBE_START_WAIT=120
HUB_START_WAIT=60
SETTLE_WAIT="${MCP_HUB_SETTLE_WAIT:-3}"
STOP_WAIT="${MCP_HUB_STOP_WAIT:-10}"
LOCK_WAIT="${MCP_HUB_LOCK_WAIT:-300}"

# CLT-каталог из PATH убираем: его python3 без пакета mcp, и ai-council под ним падает
# CONNECTION_CLOSED (см. CLAUDE.local.md).
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/CommandLineTools/' | paste -sd: -)"
PATH="$HOME/.local/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH

# HOST_ROOT (что индексирует serena) и SERENA_TAIBE_PROJECT (что индексирует serena-taibe) — lib/mcp-hub-serena.sh.
# shellcheck source=lib/mcp-hub-serena.sh
source "$SCRIPT_DIR/lib/mcp-hub-serena.sh"
resolve_roots

# shellcheck source=lib/proc-lifecycle.sh
source "$SCRIPT_DIR/lib/proc-lifecycle.sh"
# shellcheck source=lib/mcp-hub-admin.sh
source "$SCRIPT_DIR/lib/mcp-hub-admin.sh"
# shellcheck source=lib/mcp-hub-health.sh
source "$SCRIPT_DIR/lib/mcp-hub-health.sh"
# shellcheck source=lib/mcp-hub-autostart.sh
source "$SCRIPT_DIR/lib/mcp-hub-autostart.sh"

# ── «наши» процессы ─────────────────────────────────────────────────────────────────────────
# Узнаём по командной строке, а не только по pid-файлу: сироты прошлых запусков pid-файла не
# имеют, а pid из файла после смерти процесса может достаться чужому.
#   serena, serena-taibe — программа uv/uvx (обёртка) или serena (python), `serena start-mcp-server … --port
#            <порт экземпляра>`: старая строка uvx (`--from git+…/serena`), закреплённая (`…/serena@<sha>`) и бинарь
#            uv tool (`python …/bin/serena`); строго (усыновить сироту, остановить лишнюю) — ещё `--project <папка
#            экземпляра>` и HTTP-транспорт: stdio-serena клиентов и serena других проектов не трогаем никогда;
#   hub    — программа 1mcp, `1mcp serve --config <наш mcp.json> … --port <порт>`.
# Программа — argv[0], а у интерпретатора (sh/bash/node/python) — его скрипт, argv[1]. Без этого
# «своим» был бы любой процесс, в аргументах которого просто есть такая строка (цикл ожидания с
# pgrep, монитор агента), и stop/start его убили бы.
cmd_matches() { # <serena|serena-taibe|hub> <strict|loose> <командная строка>
  local cmd=" $3 " prog port="$SERENA_PORT" project="$HOST_ROOT"
  case "$1" in
    serena | serena-taibe)
      case "$cmd" in *"serena start-mcp-server "*) ;; *) return 1 ;; esac
      if [ "$1" = serena-taibe ]; then port="$SERENA_TAIBE_PORT" project="$SERENA_TAIBE_PROJECT"; fi
      case "$cmd" in *" --port $port "*) ;; *) return 1 ;; esac
      ;;
    hub)
      case "$cmd" in *"1mcp serve "*) ;; *) return 1 ;; esac
      case "$cmd" in *" --config $CONFIG_DIR/mcp.json "*) ;; *) return 1 ;; esac
      case "$cmd" in *" --port $HUB_PORT "*) ;; *) return 1 ;; esac
      ;;
    *) return 1 ;;
  esac
  prog="${3%% *}"
  case "${prog##*/}" in
    sh | bash | zsh | dash | node | python | python[0-9]* | Python)
      prog="${3#"$prog"}"
      prog="${prog# }"
      prog="${prog%% *}"
      ;;
  esac
  case "$1:${prog##*/}" in
    serena:uv | serena:uvx | serena:serena | serena-taibe:uv | serena-taibe:uvx | serena-taibe:serena | hub:1mcp) ;;
    *) return 1 ;;
  esac
  if [ "$1" = hub ] || [ "$2" = loose ]; then return 0; fi
  case "$cmd" in *" --project $project "*) ;; *) return 1 ;; esac
  case "$cmd" in *" --transport streamable-http "*) return 0 ;; esac
  return 1
}

is_ours() { cmd_matches "$1" "$2" "$(proc_cmd "$3")"; } # <kind> <strict|loose> <pid>

# Таблица экземпляров: порт, pid-файл, лог, ожидание старта, папка (у хаба — рабочий каталог).
port_of() { case "$1" in serena) echo "$SERENA_PORT" ;; serena-taibe) echo "$SERENA_TAIBE_PORT" ;; *) echo "$HUB_PORT" ;; esac; }
pid_file_of() { case "$1" in serena) echo "$SERENA_PID_FILE" ;; serena-taibe) echo "$SERENA_TAIBE_PID_FILE" ;; *) echo "$HUB_PID_FILE" ;; esac; }
log_of() { case "$1" in serena) echo "$SERENA_LOG" ;; serena-taibe) echo "$SERENA_TAIBE_LOG" ;; *) echo "$HUB_LOG" ;; esac; }
start_wait_of() { case "$1" in serena) echo "$SERENA_START_WAIT" ;; serena-taibe) echo "$SERENA_TAIBE_START_WAIT" ;; *) echo "$HUB_START_WAIT" ;; esac; }
project_of() { case "$1" in serena) echo "$HOST_ROOT" ;; serena-taibe) echo "$SERENA_TAIBE_PROJECT" ;; *) echo "$SERVE_ROOT" ;; esac; }

# Какую копию репо обслуживает процесс: serena — `--project`, хаб — рабочий каталог (spawn_hub
# запускает его из SERVE_ROOT, там же HR_HELPER_ROOT его stdio-серверов). Пусто — та, что нужна.
project_problem() { # <kind> <pid>
  local p want
  want="$(project_of "$1")"
  if [ "$1" != hub ]; then
    p=" $(proc_cmd "$2") "
    case "$p" in *" --project "*) p="${p#* --project }" && p="${p%% *}" ;; *) p="" ;; esac
  else
    p="$(lsof -a -p "$2" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n 1p || true)"
  fi
  if [ -z "$p" ] || [ "$p" = "$want" ]; then return 0; fi
  if [ "$1" != hub ]; then printf 'индексирует %s, а не %s' "$p" "$want"; else printf 'запущен из %s, а не из %s' "$p" "$SERVE_ROOT"; fi
  if [ ! -d "$p" ]; then printf ' (этого каталога уже нет)'; fi
  echo
}

# pid из pid-файла — только если это живой процесс этого сервиса.
pidfile_pid() {
  local file pid
  file="$(pid_file_of "$1")"
  [ -f "$file" ] || return 1
  pid="$(tr -cd '0-9' <"$file")"
  { [ -n "$pid" ] && proc_alive "$pid" && is_ours "$1" loose "$pid"; } || return 1
  echo "$pid"
}

# Корни деревьев «наших» (строго) процессов: у корня родитель не из того же набора. Обёртка uv
# и её python — одно дерево; python, переживший обёртку (ppid 1), — отдельный корень.
our_roots() {
  local all pid ppid cmd
  all="$(ps -axww -o pid=,ppid=,command= 2>/dev/null | while read -r pid ppid cmd; do
    if cmd_matches "$1" strict "$cmd"; then echo "$pid $ppid"; fi
  done)"
  [ -n "$all" ] || return 0
  printf '%s\n' "$all" | while read -r pid ppid; do
    printf '%s\n' "$all" | awk -v p="$ppid" '$1 == p { f = 1 } END { exit !f }' || echo "$pid"
  done
}

chain_root() { # <kind> <pid>: верхний «наш» предок (обёртка uv над python serena)
  local parent pid="$2"
  while :; do
    parent="$(proc_field "$pid" ppid)"
    { [ -n "$parent" ] && [ "$parent" -gt 1 ] && is_ours "$1" strict "$parent"; } || break
    pid="$parent"
  done
  echo "$pid"
}

# ── стоп ────────────────────────────────────────────────────────────────────────────────────
# Процесс из pid-файла и все «наши» сироты этого сервиса. Код 1 — что-то пережило KILL.
stop_service() { # <kind>
  local kind="$1" pid root listener rc=0 found=""
  if pid="$(pidfile_pid "$kind")"; then
    found=1
    if kill_tree "$pid"; then echo "  · остановлен $kind (pid $pid)"; else rc=1; fi
  fi
  for root in $(our_roots "$kind"); do
    if [ -n "$pid" ] && in_tree "$pid" "$root"; then continue; fi
    found=1
    if kill_tree "$root"; then echo "  · остановлена лишняя копия $kind без pid-файла (pid $root)"; else rc=1; fi
  done
  [ -n "$found" ] || echo "  · $kind: не был запущен"
  # pid-файл — прочь, если не указывает на живой процесс сервиса: переживший KILL остаётся в учёте.
  pidfile_pid "$kind" >/dev/null || rm -f "$(pid_file_of "$kind")"
  listener="$(port_listener "$(port_of "$kind")")"
  if [ -n "$listener" ] && [ "$rc" = 0 ]; then
    echo "  ⚠ :$(port_of "$kind") держит не процесс этого сервиса (pid $listener), не трогаю: $(proc_cmd "$listener" | cut -c1-120)"
  fi
  return "$rc"
}

reap_extra() { # <kind> <pid активного или пусто>: остановить «наши» копии, кроме активной
  local root
  for root in $(our_roots "$1"); do
    if [ -n "$2" ] && in_tree "$2" "$root"; then continue; fi
    echo "→ $1: лишняя копия pid $root (сирота прошлого запуска, порт :$(port_of "$1") не держит) — останавливаю"
    kill_tree "$root" || true
  done
}

# ── старт ───────────────────────────────────────────────────────────────────────────────────
log_tail() { tail -n 20 "$(log_of "$1")" 2>/dev/null | sed 's/^/    /' >&2 || true; } # <kind>

service_died() { # <kind> <pid>
  echo "✗ $1 (pid $2) упал после старта — последние строки $(log_of "$1"):" >&2
  log_tail "$1"
  rm -f "$(pid_file_of "$1")"
}

# Ждёт, пока процесс откроет порт; затем через SETTLE_WAIT с перепроверяет, что он жив и порт за
# ним. Умер — код 1 и хвост лога; жив, но порт отпустил — тоже код 1, процесс останавливается (без
# управления он висел бы до следующего stop). Жив, но порт не открыл — предупреждение (может ещё стартовать).
await_service() { # <kind> <pid> <секунд>
  local kind="$1" pid="$2" port i=0 listener
  port="$(port_of "$kind")"
  while :; do
    if ! proc_alive "$pid"; then
      service_died "$kind" "$pid"
      return 1
    fi
    listener="$(port_listener "$port")"
    if [ -n "$listener" ] && in_tree "$pid" "$listener"; then break; fi
    if [ "$i" -ge "$3" ]; then
      echo "⚠ $kind (pid $pid) жив, но не открыл :$port за $3 с — npm run mcp-hub:status, логи: npm run mcp-hub:logs" >&2
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  sleep "$SETTLE_WAIT"
  if ! proc_alive "$pid"; then
    service_died "$kind" "$pid"
    return 1
  fi
  listener="$(port_listener "$port")"
  if [ -z "$listener" ] || ! in_tree "$pid" "$listener"; then
    echo "✗ $kind (pid $pid) жив, но перестал слушать :$port — останавливаю; последние строки $(log_of "$kind"):" >&2
    log_tail "$kind"
    kill_tree "$pid" || true
    rm -f "$(pid_file_of "$kind")"
    return 1
  fi
  echo "→ $kind запущен: pid $pid, :$port"
}

ensure_runtime() {
  local installed=""
  [ -f "$ONE_MCP_PKG_DIR/package.json" ] \
    && installed="$(node -p "require('$ONE_MCP_PKG_DIR/package.json').version" 2>/dev/null || true)"
  [ "$installed" = "$ONE_MCP_VERSION" ] && return 0
  # Смена версии: 0.39 при первом старте переносит OAuth-сессии апстримов в карантин и удаляет прежние файлы —
  # без копии откат на старую версию потерял бы все входы. Копии нет — не обновляем.
  if [ -n "$installed" ]; then
    backup_client_sessions "$installed" || { echo "✗ хаб: копия OAuth-сессий не сделана — 1mcp не обновляю" >&2; return 1; }
  fi
  echo "→ ставлю @1mcp/agent@$ONE_MCP_VERSION в $RUNTIME_DIR"
  npm install --prefix "$RUNTIME_DIR" --no-audit --no-fund --loglevel=error "@1mcp/agent@$ONE_MCP_VERSION" >/dev/null
}

spawn_hub() {
  local github_pat
  if [ ! -f "$CONFIG_DIR/mcp.json" ]; then
    echo "✗ хаб: нет $CONFIG_DIR/mcp.json — npm run mcp-hub:sync" >&2
    return 1
  fi
  ensure_runtime || { echo "✗ хаб: не удалось поставить @1mcp/agent@$ONE_MCP_VERSION" >&2; return 1; }
  patch_admin || echo "⚠ ссылки хаба в админку не встроены" >&2
  # Тот же порядок, что у mcp-auth-headers.sh: env → Keychain → gh auth token.
  github_pat="$(bash "$SCRIPT_DIR/mcp-secret.sh" GITHUB_PAT 2>/dev/null || gh auth token 2>/dev/null || true)"
  [ -n "$github_pat" ] || echo "⚠ GITHUB_PAT не найден (env / Keychain hr-helper-mcp / gh auth) — github ответит 401" >&2
  rotate_log "$HUB_LOG"
  # Рабочий каталог хаба — обслуживаемая копия: по нему status и check видят, чей код у stdio-серверов.
  cd "$SERVE_ROOT"
  # Секрет — через окружение процесса, не аргументом: аргументы видны всем в ps.
  HR_HELPER_ROOT="$SERVE_ROOT" SERENA_HTTP_PORT="$SERENA_PORT" GITHUB_PAT="$github_pat" \
    spawn_detached "$HUB_LOG" "$ONE_MCP_BIN" serve \
    --config "$CONFIG_DIR/mcp.json" \
    --transport http --host 127.0.0.1 --port "$HUB_PORT" \
    --enable-async-loading --async-background-retry \
    --health-info-level basic --log-level info
  echo "$SPAWNED_PID" >"$HUB_PID_FILE"
  await_service hub "$SPAWNED_PID" "$HUB_START_WAIT"
}

# Поднять сервис, если он не работает. Порт держит:
#   · процесс из pid-файла (или его потомок) — уже работает;
#   · «наш» процесс без pid-файла (сирота прошлого запуска) — берём под управление, а не отказываем;
#   · чужой процесс — понятная ошибка, код 1; cmd_start всё равно идёт к следующему сервису.
# Лишние «наши» копии, которые порт не держат, останавливаются (serena — ~2 ГБ RAM каждая).
# Работающий сервис другой копии репо (worktree) — код 1 с подсказкой restart: молча не убиваем.
ensure_service() { # <kind>
  local kind="$1" port pid listener active="" age wait problem
  port="$(port_of "$kind")"
  pid="$(pidfile_pid "$kind" || true)"
  listener="$(port_listener "$port")"
  if [ -n "$listener" ]; then
    if [ -n "$pid" ] && in_tree "$pid" "$listener"; then
      active="$pid"
    elif is_ours "$kind" strict "$listener"; then
      active="$(chain_root "$kind" "$listener")"
      echo "→ $kind: :$port уже держит копия этого проекта без pid-файла (pid $active) — беру под управление"
      echo "$active" >"$(pid_file_of "$kind")"
    else
      echo "✗ $kind: :$port занят чужим процессом — pid $listener: $(proc_cmd "$listener" | cut -c1-160)" >&2
      echo "  $kind не запускаю; освободить порт и повторить: npm run mcp-hub:start" >&2
      return 1
    fi
  elif [ -n "$pid" ]; then
    # Жив, но порт не держит: ещё стартует — дождаться; давно — не убивать молча, а сказать.
    age="$(proc_age "$pid")"
    wait="$(start_wait_of "$kind")"
    reap_extra "$kind" "$pid"
    if [ "$age" -ge "$wait" ]; then
      echo "✗ $kind: pid $pid жив уже $age с, но :$port не слушает — перезапуск: npm run mcp-hub:restart" >&2
      return 1
    fi
    echo "→ $kind: pid $pid ещё стартует — жду :$port"
    await_service "$kind" "$pid" $((wait - age))
    return
  fi
  reap_extra "$kind" "$active"
  if [ -n "$active" ]; then
    problem="$(project_problem "$kind" "$active")"
    [ -n "$problem" ] || return 0
    echo "✗ $kind (pid $active) $problem — перезапуск из основной папки: npm run mcp-hub:restart" >&2
    return 1
  fi
  if [ "$kind" = hub ]; then spawn_hub; else spawn_serena "$kind"; fi
}

# ── команды ─────────────────────────────────────────────────────────────────────────────────
# Итоговый конфиг хаба: каталог из репо + личный список включённых коннекторов, ${TAIBE_HOST_ROOT} →
# HOST_ROOT при сборке (infra/mcp-hub/render_config.py). `render_config drift --live <файл>` — для status.
render_config() { # <render|drift> [--live <живой mcp.json>]
  local mode="$1"
  shift
  python3 -I "$ROOT/infra/mcp-hub/render_config.py" "$mode" --template "$CONFIG_SRC" \
    --connectors "$CONNECTORS_FILE" --host-root "$HOST_ROOT" --serve-root "$SERVE_ROOT" "$@"
}

cmd_sync() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  local rendered live=""
  # Предохранитель: живой конфиг обслуживает другой хост — отказ, код 1 (TAIBE_HOST_ROOT забыт в окружении).
  # Это же закрывает connect/disconnect. Сменить хост осознанно: MCP_HUB_HOST_CHANGE=1.
  [ -f "$CONFIG_DIR/mcp.json" ] && live="$CONFIG_DIR/mcp.json"
  # Сначала собрать, потом писать: при ошибке сборки пустой конфиг выгрузил бы из хаба все серверы.
  rendered="$(render_config render --live "$live")" || { echo "⚠ конфиг хаба не собран — оставляю прежний" >&2; return 1; }
  printf '%s\n' "$rendered" >"$CONFIG_DIR/mcp.json"
  echo "Конфиг хаба → $CONFIG_DIR/mcp.json (запущенный хаб подхватит без рестарта)"
  [ -d "$ONE_MCP_PKG_DIR" ] && patch_admin
  return 0
}

# Сбой одного сервиса не обрывает старт другого: код 1 в конце, если упал хоть один. Хаб — до serena-taibe: от неё
# он не зависит, а её первый старт (LSP на tAIBE) — до двух минут, и `restart hub` ждал бы их.
cmd_start() {
  local rc=0
  mkdir -p "$LOG_DIR"
  if [ ! -f "$CONFIG_DIR/mcp.json" ]; then cmd_sync || rc=1; fi
  python3 -c 'import mcp' 2>/dev/null \
    || echo "⚠ python3 ($(command -v python3)) без пакета mcp — ai-council в хабе не стартует" >&2
  ensure_service serena || rc=1
  ensure_service hub || rc=1
  ensure_service serena-taibe || rc=1
  cmd_status
  return "$rc"
}

cmd_stop() {
  local rc=0
  stop_service hub || rc=1
  stop_service serena-taibe || rc=1
  stop_service serena || rc=1
  if [ "$rc" = 0 ]; then echo "Хаб и обе serena остановлены."; else echo "✗ остановлено не всё — npm run mcp-hub:status" >&2; fi
  return "$rc"
}

# Общие сервисы поднимаются только из основной папки: из worktree serena индексировала бы его копию
# (а после `git worktree remove` — несуществующий каталог), stdio-серверы хаба работали бы на его коде.
from_main_only() { # <команда>
  [ "$ROOT" != "$SERVE_ROOT" ] || return 0
  echo "✗ $1: общие хаб и serena поднимаются из основной папки репо — (cd $MAIN_ROOT && npm run mcp-hub:$1)" >&2
  echo "  Отсюда ($ROOT) serena индексировала бы копию worktree, а после его удаления — несуществующий" >&2
  echo "  каталог. Осознанно обслуживать эту копию: MCP_HUB_ALLOW_WORKTREE=1 (своя serena для worktree — README хаба)." >&2
  return 1
}

main() {
  local rc=0 lock="$CONFIG_DIR/lifecycle.lock"
  case "${1:-status}" in
    init)
      { from_main_only init && host_known init; } || return 1
      # Замок — только на старт: auth может ждать браузер минутами, второе окно ждать его не должно.
      lock_acquire "$lock"
      cmd_start || rc=1
      lock_release
      echo "Авторизация MCP:"
      cmd_auth
      return "$rc"
      ;;
    auth) cmd_auth force ;;
    admin) cmd_admin ;;
    start)
      { from_main_only start && host_known start; } || return 1
      lock_acquire "$lock"
      cmd_start
      ;;
    stop)
      lock_acquire "$lock"
      cmd_stop
      ;;
    restart)
      { from_main_only restart && host_known restart; } || return 1
      lock_acquire "$lock"
      # restart hub — только агрегатор (секунды), без переиндексации serena (минута и 2 ГБ).
      if [ "${2:-}" = "hub" ]; then stop_service hub || rc=1; else cmd_stop || rc=1; fi
      cmd_start || rc=1
      return "$rc"
      ;;
    status) cmd_status ;;
    check) cmd_check ;;
    logs) cmd_logs "${2:-40}" ;;
    sync) cmd_sync ;;
    connectors) cmd_connectors ;;
    connect) cmd_connect "${2:-}" ;;
    disconnect) cmd_disconnect "${2:-}" ;;
    autostart)
      # plist записывает путь к репо: из worktree он вёл бы в копию, которую потом удалят.
      if [ "${2:-status}" = on ]; then { from_main_only autostart && host_known autostart; } || return 1; fi
      cmd_autostart "${2:-status}"
      ;;
    *)
      echo "usage: $0 {init|auth|admin|start|stop|restart [hub]|status|check|logs [N]|sync|connectors|connect <имя>|disconnect <имя>|autostart on|off|status}" >&2
      return 2
      ;;
  esac
}

# Подключение через source (тест) — только функции, без запуска команды.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

trap 'lock_release' EXIT
trap 'lock_release; exit 129' HUP
trap 'lock_release; exit 130' INT
trap 'lock_release; exit 143' TERM
main "$@"
