# shellcheck shell=bash
# MCP-хаб: две общие serena только на чтение — какие папки они индексируют (resolve_roots), программа запуска
# (закреплённая версия), шаблоны проекта и контекста, запуск одного экземпляра. Подключается через source из
# infra/scripts/dev-ai/mcp-hub.sh и пользуется его переменными (ROOT, SERVE_ROOT, CONFIG_DIR, CONFIG_SRC, SERENA_PORT,
# UVX) и функциями (port_of, pid_file_of, log_of, project_of, start_wait_of, rotate_log, spawn_detached,
# await_service). Узнавание «своих» процессов — cmd_matches в mcp-hub.sh.
#
#   serena        :9121 (SERENA_HTTP_PORT)  — код продукта-хоста HOST_ROOT (HR); с дашбордом (ссылка в админке хаба);
#   serena-taibe  :9122 (SERENA_TAIBE_PORT) — сам tAIBE, основная папка (SERENA_TAIBE_PROJECT); без дашборда.

# shellcheck disable=SC2034 # список экземпляров читают status и check (lib/mcp-hub-health.sh)
SERENA_KINDS="serena serena-taibe"
# Закреплённая версия: 2.1.1.dev0. Бинарь — `uv tool install` этой ревизии (README хаба, «Две serena»); без него — uvx
# той же ревизии, но ему на старте нужна сеть. Незакреплённый `git+…/serena` при входе в систему брал бы что угодно.
SERENA_PIN="ede329aaf0c824bea75455a2926f01420d7aa620"
SERENA_GIT="git+https://github.com/oraios/serena@$SERENA_PIN"
SERENA_BIN="${SERENA_BIN-$HOME/.local/bin/serena}"
SERENA_HOME_DIR="${SERENA_HOME:-$HOME/.serena}"
SERENA_TEMPLATES="$ROOT/infra/mcp-hub/serena"

abs_dir() { # <имя переменной> <путь>: печатает абсолютный существующий каталог (через cd && pwd); иначе код 1
  case "$2" in
    /*) [ -d "$2" ] || { echo "✗ $1=$2: каталога нет" >&2; return 1; } ;;
    *) echo "✗ $1=$2: нужен абсолютный путь" >&2; return 1 ;;
  esac
  (cd "$2" && pwd)
}

# Что индексирует serena: код продукта-хоста → HOST_ROOT, откуда он взят → HOST_FROM. Хост — TAIBE_HOST_ROOT
# (абсолютный путь, тот же, что у ai-council и dams-rag); без него — хост, который обслуживает живой конфиг хаба
# (тот же источник, что у status и предохранителя sync), и только без живого конфига — обслуживаемая копия.
# Живой конфиг есть, а хост из него не взят (битый JSON, несколько хостов, каталога нет) → HOST_PROBLEM: status и
# check работают, а start/restart/init/autostart on отказывают (host_known) — иначе restart погасил бы serena HR и
# поднял :9121 на папке слоя. 07.11: start без TAIBE_HOST_ROOT взял папку слоя и отказал работающей serena HR.
# serena-taibe индексирует сам tAIBE — обслуживаемую копию (основную папку) → SERENA_TAIBE_PROJECT.
resolve_roots() {
  local live="$CONFIG_DIR/mcp.json" found="" rc=0
  HOST_ROOT="${TAIBE_HOST_ROOT:-}"
  HOST_FROM="TAIBE_HOST_ROOT"
  HOST_PROBLEM=""
  if [ -z "$HOST_ROOT" ]; then
    if [ -f "$live" ]; then
      found="$(python3 -I "$ROOT/infra/mcp-hub/render_config.py" host --template "$CONFIG_SRC" \
        --serve-root "$SERVE_ROOT" --live "$live" 2>&1)" || rc=$?
      if [ "$rc" != 0 ]; then
        HOST_PROBLEM="живой конфиг хаба $live не прочитан: $(echo "$found" | sed -n 1p)"
      else
        case "$found" in
          "") ;;
          *$'\n'*) HOST_PROBLEM="живой конфиг хаба $live обслуживает несколько хостов: $(echo "$found" | paste -sd' ' -)" ;;
          *) if [ -d "$found" ]; then HOST_ROOT="$found"; else HOST_PROBLEM="хоста живого конфига хаба $found нет на диске"; fi ;;
        esac
      fi
    fi
    if [ -n "$HOST_ROOT" ]; then
      HOST_FROM="живой конфиг хаба $live"
      echo "→ хост продукта (serena :$SERENA_PORT): $HOST_ROOT — $HOST_FROM; TAIBE_HOST_ROOT не задан" >&2
    else
      HOST_ROOT="$SERVE_ROOT"
      HOST_FROM="обслуживаемая копия: TAIBE_HOST_ROOT не задан, хоста в живом конфиге хаба нет"
      if [ -n "$HOST_PROBLEM" ]; then
        echo "⚠ хост продукта (serena :$SERENA_PORT) не определён: $HOST_PROBLEM — задайте TAIBE_HOST_ROOT" >&2
      else
        echo "→ хост продукта (serena :$SERENA_PORT): $HOST_ROOT — $HOST_FROM" >&2
      fi
    fi
  fi
  HOST_ROOT="$(abs_dir TAIBE_HOST_ROOT "$HOST_ROOT")" || exit 1
  SERENA_TAIBE_PROJECT="$(abs_dir SERENA_TAIBE_PROJECT "${SERENA_TAIBE_PROJECT:-$SERVE_ROOT}")" || exit 1
}

host_known() { # <команда>: код 1, если живой конфиг есть, а хост из него не взят (resolve_roots)
  [ -n "$HOST_PROBLEM" ] || return 0
  echo "✗ $1: хост продукта не определён — $HOST_PROBLEM" >&2
  echo "  Задайте хост явно: TAIBE_HOST_ROOT=<папка продукта-хоста> npm run mcp-hub:$1" >&2
  return 1
}

# Годится ли проект для общей serena. Файлы .serena/ не в git — проверка на каждом запуске:
#   read_only: true — в .serena/project.local.yml (он главнее), иначе в project.yml;
#   нет activation_command — serena выполняет его оболочкой при каждом старте (путь доверенный), а хаб стартует при входе.
serena_project_check() { # <папка проекта>: код 0 — годится; иначе причина в stdout и код 1
  local d="$1/.serena" f ro=""
  for f in "$d/project.local.yml" "$d/project.yml"; do
    [ -f "$f" ] || continue
    if grep -qE '^activation_command:[[:space:]]*[^[:space:]#]' "$f"; then
      echo "в $f задан activation_command (serena выполнила бы его при старте)"
      return 1
    fi
    [ -n "$ro" ] || ro="$(sed -n 's/^read_only:[[:space:]]*\([A-Za-z]*\).*/\1/p' "$f" | tail -n 1)"
  done
  [ "$ro" = true ] && return 0
  echo "в $d/project.local.yml или project.yml нет read_only: true"
  return 1
}

# Программа и её аргументы до `start-mcp-server` → массив SERENA_LAUNCH.
serena_launcher() {
  local link receipt
  if [ -n "$SERENA_BIN" ] && [ -x "$SERENA_BIN" ]; then
    SERENA_LAUNCH=("$SERENA_BIN")
    # Квитанция uv tool рядом с бинарём называет ревизию: другая — предупредить, но не отказывать.
    link="$(readlink "$SERENA_BIN" 2>/dev/null || echo "$SERENA_BIN")"
    case "$link" in /*) ;; *) link="$(dirname "$SERENA_BIN")/$link" ;; esac
    receipt="$(dirname "$link")/../uv-receipt.toml"
    if [ -f "$receipt" ] && ! grep -q "$SERENA_PIN" "$receipt"; then
      echo "⚠ serena: $SERENA_BIN — не закреплённая ревизия $SERENA_PIN ($receipt)" >&2
    fi
    return 0
  fi
  echo "→ serena: ${SERENA_BIN:-SERENA_BIN пуст} — не исполняемый файл, запуск через $UVX $SERENA_GIT (нужна сеть)" >&2
  SERENA_LAUNCH=("$UVX" --from "$SERENA_GIT" serena)
}

# Шаблон из репо → рабочая копия, если её нет. Есть и отличается — остаётся как есть (её мог править человек),
# с предупреждением и командой сравнения. Код 1 — копии нет и положить её не удалось.
install_template() { # <шаблон> <куда> <что это>
  if [ -f "$2" ]; then
    cmp -s "$1" "$2" || echo "⚠ $3: $2 отличается от шаблона — оставляю как есть; сравнить: diff -u $1 $2" >&2
    return 0
  fi
  if mkdir -p "$(dirname "$2")" && cp "$1" "$2"; then
    echo "→ $3: $2 ← $1"
    return 0
  fi
  echo "✗ $3: не удалось положить $2" >&2
  return 1
}

spawn_serena() { # <serena|serena-taibe>
  local kind="$1" log pid_file project dashboard problem
  log="$(log_of "$kind")"
  pid_file="$(pid_file_of "$kind")"
  project="$(project_of "$kind")"
  # Хост = папка tAIBE: это индекс serena-taibe, вторая копия — лишние LSP и общий .serena/cache.
  if [ "$kind" = serena ] && [ "$project" = "$SERENA_TAIBE_PROJECT" ]; then
    echo "✗ serena не запускаю: хост $project — папка serena-taibe (:$SERENA_TAIBE_PORT); TAIBE_HOST_ROOT=<папка продукта-хоста>" >&2
    return 1
  fi
  # Контекст claude-code — у обеих: только чтение, без инструментов правки и памяти. Не положить — serena возьмёт
  # встроенный (с правкой через serena), как до 07.11.
  install_template "$SERENA_TEMPLATES/claude-code.context.yml" "$SERENA_HOME_DIR/contexts/claude-code.yml" \
    "контекст serena" || true
  dashboard=(--open-web-dashboard False)
  if [ "$kind" = serena-taibe ]; then
    install_template "$SERENA_TEMPLATES/taibe.project.yml" "$project/.serena/project.yml" "проект serena-taibe" || return 1
    # Дашборд — только у serena хоста: на него ссылается админка хаба (lib/mcp-hub-admin.sh).
    dashboard=(--enable-web-dashboard False --open-web-dashboard False)
  fi
  # Без read_only: true serena создала бы свой project.yml с read_only: false — правка основной папки для всех сессий.
  if ! problem="$(serena_project_check "$project")"; then
    echo "✗ $kind не запускаю: $problem" >&2
    return 1
  fi
  serena_launcher
  rotate_log "$log"
  cd "$SERVE_ROOT" || return 1
  spawn_detached "$log" "${SERENA_LAUNCH[@]}" start-mcp-server --project "$project" --context claude-code \
    --transport streamable-http --host 127.0.0.1 --port "$(port_of "$kind")" "${dashboard[@]}"
  echo "$SPAWNED_PID" >"$pid_file"
  await_service "$kind" "$SPAWNED_PID" "$(start_wait_of "$kind")"
}
