# shellcheck shell=bash
# MCP-хаб: команды только на чтение — status, check, logs. Ничего не запускают, не останавливают и
# не берут под управление. Подключается через source из infra/scripts/dev-ai/mcp-hub.sh и пользуется
# его переменными (ROOT, SERVE_ROOT, HOST_ROOT, HOST_FROM, SERENA_TAIBE_PROJECT, CONFIG_DIR, SERENA_PORT,
# SERENA_TAIBE_PORT, HUB_PORT, SERENA_LOG, SERENA_TAIBE_LOG, HUB_LOG, SERENA_KINDS) и функциями (pidfile_pid,
# our_roots, is_ours, project_problem, render_config, port_of, serena_taibe_enabled, serena_taibe_off_line).

# Какие serena ведут status и check: serena — всегда, serena-taibe — с меткой (`serena-taibe on`); с `running` —
# и работающую без метки (status её показывает, check — нет: выключенная по решению не ошибка).
serena_kinds_on() { # [running]
  echo serena
  if serena_taibe_enabled; then
    echo serena-taibe
  elif [ "${1:-}" = running ] && { pidfile_pid serena-taibe >/dev/null || [ -n "$(our_roots serena-taibe)" ]; }; then
    echo serena-taibe
  fi
}

# Отвечают ли эти serena (initialize по MCP) и хаб (/health/mcp). Код 1 — если хоть один не ответил.
probe_http() { # <serena|serena-taibe>…
  local kind specs=()
  for kind in "$@"; do specs+=("$kind=$(port_of "$kind")"); done
  python3 - "$HUB_PORT" "${specs[@]}" <<'PY'
import json, sys, urllib.request
hub_port = sys.argv[1]
ok = True
for name, serena_port in (spec.split("=", 1) for spec in sys.argv[2:]):
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{serena_port}/mcp", method="POST",
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "mcp-hub-status", "version": "1"}}}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f"  ✓ {name} отвечает: http://127.0.0.1:{serena_port}/mcp")
    except Exception as e:
        ok = False
        print(f"  ✗ {name} :{serena_port}: {e}")
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{hub_port}/health/mcp", timeout=10) as r:
        by_state = json.load(r)["servers"]["byState"]
    print(f"  ✓ хаб отвечает: http://127.0.0.1:{hub_port}/mcp")
    labels = {"ready": "готовы", "awaitingOAuth": "ждут OAuth", "failed": "упали",
              "loading": "загружаются", "pending": "в очереди"}
    for state, label in labels.items():
        if by_state.get(state):
            print(f"      {label}: {', '.join(sorted(by_state[state]))}")
    if by_state.get("awaitingOAuth"):
        print("      → авторизовать: npm run mcp-hub:auth")
except Exception as e:
    ok = False
    print(f"  ✗ хаб :{hub_port}: {e}")
sys.exit(0 if ok else 1)
PY
}

cmd_status() {
  local kind pid port tty root listener problem kinds
  if [ "$ROOT" != "$SERVE_ROOT" ]; then echo "  (общие хаб и serena обслуживают основную папку $SERVE_ROOT)"; fi
  echo "  (serena :$SERENA_PORT индексирует хост $HOST_ROOT — $HOST_FROM; serena-taibe :$SERENA_TAIBE_PORT — $SERENA_TAIBE_PROJECT)"
  kinds="$(serena_kinds_on running | paste -sd' ' -)"
  for kind in $SERENA_KINDS hub; do
    case "$kind: $kinds " in serena-taibe:*" serena-taibe "*) ;; serena-taibe:*) serena_taibe_off_line && continue ;; esac
    port="$(port_of "$kind")"
    listener="$(port_listener "$port")"
    if pid="$(pidfile_pid "$kind")"; then
      echo "  ✓ $kind: pid $pid"
      tty="$(proc_field "$pid" tty)"
      if [ -n "$tty" ] && [ "$tty" != "??" ]; then
        echo "    ⚠ привязан к терминалу $tty и закроется вместе с ним — npm run mcp-hub:restart"
      fi
      problem="$(project_problem "$kind" "$pid")"
      if [ -n "$problem" ]; then echo "    ⚠ $problem — перезапуск из основной папки: npm run mcp-hub:restart"; fi
      if [ "$kind" = serena-taibe ] && ! serena_taibe_enabled; then
        echo "    ⚠ выключена (метки нет), но работает — остановить: npm run mcp-hub:serena-taibe -- off"
      fi
    else
      pid=""
      echo "  ✗ $kind: не запущен (npm run mcp-hub:start)"
      if [ -n "$listener" ] && ! is_ours "$kind" strict "$listener"; then
        echo "    ⚠ :$port занят чужим процессом (pid $listener) — $kind на нём не стартует"
      fi
    fi
    for root in $(our_roots "$kind"); do
      if [ -n "$pid" ] && in_tree "$pid" "$root"; then continue; fi
      if [ -n "$listener" ] && in_tree "$root" "$listener"; then
        echo "    ⚠ :$port держит копия без pid-файла (pid $root) — npm run mcp-hub:start возьмёт её под управление"
      else
        echo "    ⚠ лишняя копия $kind без pid-файла (pid $root, порт не держит) — уберёт npm run mcp-hub:start"
      fi
    done
  done
  # shellcheck disable=SC2086 # список экземпляров
  probe_http $kinds || true
  # По серверам, а не текстом: хост расходится — подсказка с TAIBE_HOST_ROOT, иначе — что sync перепишет.
  if [ -f "$CONFIG_DIR/mcp.json" ]; then
    render_config drift --live "$CONFIG_DIR/mcp.json" 2>&1 | sed 's/^/  /' \
      || echo "  ⚠ расхождение с шаблоном не посчитано (строка выше) — sync при той же ошибке откажет"
  fi
}

# Для ai-restart-all.sh и людей: код 0, только если serena, хаб и (с меткой) serena-taibe живы, держат порты,
# обслуживают свои папки (serena — `--project`: хост и tAIBE, хаб — рабочий каталог) и отвечают. serena-taibe без
# метки — выключена по решению, не ошибка; с меткой и без :9122 — код 1.
cmd_check() {
  local kind pid port listener problem rc=0
  for kind in $SERENA_KINDS hub; do
    if [ "$kind" = serena-taibe ] && ! serena_taibe_enabled; then
      serena_taibe_off_line
      continue
    fi
    port="$(port_of "$kind")"
    if ! pid="$(pidfile_pid "$kind")"; then
      echo "  ✗ $kind: не запущен"
      rc=1
      continue
    fi
    listener="$(port_listener "$port")"
    if [ -z "$listener" ] || ! in_tree "$pid" "$listener"; then
      echo "  ✗ $kind: pid $pid жив, но :$port не слушает"
      rc=1
      continue
    fi
    problem="$(project_problem "$kind" "$pid")"
    if [ -n "$problem" ]; then
      echo "  ✗ $kind: pid $pid $problem — перезапуск из основной папки: npm run mcp-hub:restart"
      rc=1
      continue
    fi
    echo "  ✓ $kind: pid $pid держит :$port"
  done
  # shellcheck disable=SC2046 # список экземпляров
  probe_http $(serena_kinds_on) || rc=1
  return "$rc"
}

cmd_logs() {
  local f files=""
  for f in "$SERENA_LOG" "$SERENA_TAIBE_LOG" "$HUB_LOG"; do
    if [ -f "$f" ]; then files="$files $f"
    elif [ "$f" = "$SERENA_TAIBE_LOG" ] && ! serena_taibe_enabled; then echo "(serena-taibe выключена — лога нет)"
    else echo "(нет $f — ещё не запускался)"; fi
  done
  # shellcheck disable=SC2086 # пути без пробелов: ~/Library/Logs/…
  [ -z "$files" ] || tail -n "${1:-40}" $files
  for f in "$SERENA_LOG.prev" "$SERENA_TAIBE_LOG.prev" "$HUB_LOG.prev"; do
    if [ -f "$f" ]; then echo "(прошлый запуск — $f)"; fi
  done
}
