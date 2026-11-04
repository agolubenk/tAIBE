# shellcheck shell=bash
# MCP-хаб: OAuth, коннекторы, админ-консоль 1mcp и ссылки хаба в ней. Подключается через source из
# infra/scripts/dev-ai/mcp-hub.sh и пользуется его переменными (ROOT, SCRIPT_DIR, CONFIG_DIR, HUB_PORT,
# ONE_MCP_PKG_DIR, ONE_MCP_BIN, AUTH_MARK_DIR, CONNECTORS_FILE, CONFIG_SRC) и функциями (pidfile_pid,
# descendants, ensure_runtime, cmd_sync, render_config). Запуск и остановка процессов — не здесь, а в mcp-hub.sh.

# Предохранитель хоста до правки connectors.enabled: иначе при отказе sync имя уже записано, и следующий
# удачный sync молча включил бы (или выключил) коннектор. Код 1 — хост живого конфига другой.
host_guard() {
  [ -f "$CONFIG_DIR/mcp.json" ] || return 0
  render_config render --live "$CONFIG_DIR/mcp.json" >/dev/null
}

# Дашборд serena слушает первый свободный порт от 24282 — берём фактический у процесса serena.
serena_dashboard_url() {
  local pid pids port
  pid="$(pidfile_pid serena)" || return 0
  # shellcheck disable=SC2046 # список pid потомков
  pids="$(printf '%s\n' "$pid" $(descendants "$pid") | paste -sd, -)"
  for port in $(lsof -nP -a -p "$pids" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 { sub(/.*:/, "", $9); print $9 }'); do
    if [ "$port" != "$SERENA_PORT" ]; then
      echo "http://127.0.0.1:$port/dashboard/"
      return 0
    fi
  done
}

# Ссылки хаба на /admin/servers (infra/mcp-hub/admin/hub-links.js): скрипт и JSON — в ассеты
# админки, <script> — в её index.html. Идемпотентно; повторяется при start и sync, поэтому
# переустановка 1mcp или правка links.json патч не теряют.
patch_admin() {
  local admin="$ONE_MCP_PKG_DIR/build/admin"
  if [ ! -f "$admin/index.html" ]; then
    echo "⚠ нет $admin/index.html — ссылки хаба в админку не встроены" >&2
    return 0
  fi
  cp "$ROOT/infra/mcp-hub/admin/hub-links.js" "$admin/assets/hub-links.js"
  SERENA_DASHBOARD="$(serena_dashboard_url)" python3 - "$ROOT/infra/mcp-hub/links.json" "$admin" <<'PY'
import json, os, sys
src, admin = sys.argv[1], sys.argv[2]
links = json.load(open(src))
dash = os.environ.get("SERENA_DASHBOARD", "")
out = {}
for name, items in links.items():
    resolved = []
    for item in items:
        url = item["url"].replace("${SERENA_DASHBOARD}", dash)
        if url and "${" not in url:
            resolved.append({"label": item["label"], "url": url})
    out[name] = resolved
with open(os.path.join(admin, "assets", "hub-links.json"), "w") as f:
    json.dump(out, f, ensure_ascii=False)
index = os.path.join(admin, "index.html")
html = open(index).read()
tag = '<script defer src="/admin/assets/hub-links.js"></script>'
if tag not in html:
    open(index, "w").write(html.replace("</head>", f"  {tag}\n  </head>", 1))
PY
}

# Без force страница авторизации сервера открывается не чаще раза в сутки: иначе каждое
# открытие папки плодит вкладки по серверам, которые решено не авторизовывать (такие —
# `"disabled": true` в infra/mcp-hub/mcp.json или убрать из enabledMcpjsonServers).
prompted_recently() {
  local mark="$AUTH_MARK_DIR/$1"
  [ -f "$mark" ] && [ -n "$(find "$mark" -mtime -1 2>/dev/null)" ]
}

# Печатает «имя<TAB>URL авторизации» для серверов хаба в статусе awaitingOAuth; сначала ждёт,
# пока хаб догрузит серверы (иначе только что стартовавший ещё не знает, кому нужна OAuth).
hub_oauth_pending() {
  python3 - "$HUB_PORT" <<'PY'
import json, sys, time, urllib.request
health = f"http://127.0.0.1:{sys.argv[1]}/health/mcp"
servers = {}
for _ in range(60):
    try:
        with urllib.request.urlopen(health, timeout=5) as r:
            data = json.load(r)
        servers = data["servers"]
        if data["summary"]["loading"] == 0 and data["summary"]["pending"] == 0:
            break
    except Exception:
        pass
    time.sleep(2)
for name in servers.get("byState", {}).get("awaitingOAuth", []):
    url = servers.get("details", {}).get(name, {}).get("authorizationUrl")
    print(f"{name}\t{url or f'http://127.0.0.1:{sys.argv[1]}/oauth'}")
PY
}

cmd_auth() {
  local force="${1:-}" name url opened_hub="" pending_claude=()
  mkdir -p "$AUTH_MARK_DIR" "$LOG_DIR"

  while IFS=$'\t' read -r name url; do
    [ -n "$name" ] || continue
    if [ -z "$force" ] && prompted_recently "hub-$name"; then
      echo "  · хаб/$name ждёт OAuth — страница уже открывалась за сутки (заново: npm run mcp-hub:auth)"
      continue
    fi
    echo "  → хаб/$name: открываю страницу авторизации"
    # Отметка до open: второе окно VS Code, проверяющее то же самое, вкладку уже не откроет.
    touch "$AUTH_MARK_DIR/hub-$name"
    open "$url"
    opened_hub=1
  done < <(hub_oauth_pending)
  if [ -n "${opened_hub:-}" ]; then
    # Колбэк хаба после входа редиректит на /admin/oauth, а консоль просит логин — это не ошибка
    # авторизации: токены к этому моменту уже сохранены (или нет — это видно только в status).
    echo "    После входа у провайдера браузер откроет консоль хаба с формой логина — это не ошибка."
    echo "    Итог смотреть: npm run mcp-hub:status. Консоль: логин operator, пароль —"
    echo "    security find-generic-password -s hr-helper-mcp -a MCP_HUB_ADMIN_PASSWORD -w | pbcopy"
  fi

  if command -v claude >/dev/null 2>&1; then
    # Имя — всё до первого «: » (у плагинов в имени свои двоеточия: plugin:context7:context7).
    # Коннекторы claude.ai («claude.ai Notion» и т.п.) — из настроек аккаунта, входят там, не тут.
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      if [ -z "$force" ] && prompted_recently "claude-$name"; then
        echo "  · Claude Code/$name ждёт OAuth — вход уже предлагался за сутки (заново: npm run mcp-hub:auth)"
        continue
      fi
      pending_claude+=("$name")
    done < <(cd "$ROOT" && claude mcp list 2>/dev/null | awk '/Needs authentication/ && !/^claude\.ai / { sub(/: .*/, ""); print }')
  fi
  if [ "${#pending_claude[@]}" -gt 0 ] && [ ! -t 0 ]; then
    # Без терминала `claude mcp login` отказывается («stdin isn't a terminal»). Отметку «предлагалось»
    # не ставим — следующий запуск из терминала (задача VS Code, npm run) предложит снова.
    echo "  · Claude Code ждёт OAuth: ${pending_claude[*]} — нужен терминал: npm run mcp-hub:auth (или /mcp в сессии)"
  elif [ "${#pending_claude[@]}" -gt 0 ]; then
    # По одному и на переднем плане: каждый вход держит свой callback, пока не завершится в браузере.
    # Ctrl+C прерывает только текущий вход (trap на INT), очередь идёт дальше.
    echo "  → Claude Code: claude mcp login ${pending_claude[*]} (по очереди; пропустить текущий — Ctrl+C)"
    trap ':' INT
    for name in "${pending_claude[@]}"; do
      touch "$AUTH_MARK_DIR/claude-$name"
      (cd "$ROOT" && claude mcp login "$name") || echo "  ⚠ Claude Code/$name: вход не завершён"
    done
    trap - INT
  fi
  echo "  ✓ проверка авторизации завершена"
}

# Копия OAuth-сессий 1mcp перед сменой версии (ensure_runtime): `$CONFIG_DIR/backups/clientSessions-<версия>-<время>`,
# каталог 700, как сам конфиг. Сессий ещё нет — копировать нечего, это не ошибка. Откат — infra/mcp-hub/README.md.
backup_client_sessions() {
  local from_version="$1" src="$CONFIG_DIR/clientSessions" dest
  [ -d "$src" ] || return 0
  mkdir -p "$CONFIG_DIR/backups" && chmod 700 "$CONFIG_DIR/backups" || return 1
  dest="$CONFIG_DIR/backups/clientSessions-$from_version-$(date +%Y%m%d-%H%M%S)"
  cp -Rp "$src" "$dest" || return 1
  echo "→ копия OAuth-сессий 1mcp $from_version: $dest (откат — infra/mcp-hub/README.md, «Обновление 1mcp»)"
}

# Учётка админ-консоли 1mcp (/admin, /oauth) — один раз. Голый `1mcp admin bootstrap` из подсказки
# консоли создал бы её для ~/.config/1mcp, а не для каталога этого хаба. Пароль генерируется и
# живёт в Keychain (hr-helper-mcp / MCP_HUB_ADMIN_PASSWORD), в историю shell не попадает.
# Для OAuth консоль не обязательна: `auth` открывает ссылки провайдеров напрямую.
cmd_admin() {
  local password
  if ! password="$(bash "$SCRIPT_DIR/mcp-secret.sh" MCP_HUB_ADMIN_PASSWORD 2>/dev/null)"; then
    password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    security add-generic-password -U -s hr-helper-mcp -a MCP_HUB_ADMIN_PASSWORD -w "$password"
  fi
  ensure_runtime
  "$ONE_MCP_BIN" admin bootstrap --config "$CONFIG_DIR/mcp.json" \
    --username operator --password "$password" 2>&1 | grep -v 'npm warn' | sed "s/$password/<скрыто>/g"
  echo "Консоль: http://127.0.0.1:$HUB_PORT/admin — логин operator; пароль в буфер обмена:"
  echo "  security find-generic-password -s hr-helper-mcp -a MCP_HUB_ADMIN_PASSWORD -w | pbcopy"
}

cmd_connectors() {
  python3 - "$CONFIG_SRC" "$CONNECTORS_FILE" "$HUB_PORT" <<'PY'
import json, os, sys, urllib.request
src, enabled_file, port = sys.argv[1:4]
servers = json.load(open(src))["mcpServers"]
enabled = {line.strip() for line in open(enabled_file)} if os.path.exists(enabled_file) else set()
state = {}
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health/mcp", timeout=5) as r:
        for st, names in json.load(r)["servers"]["byState"].items():
            for n in names:
                state[n] = st
except Exception:
    pass
print("Коннекторы (✓ — подключён):")
for name, s in servers.items():
    if "connector" in s.get("tags", []):
        mark = "✓" if name in enabled else "·"
        print(f"  {mark} {name:<10} {state.get(name, '—') if name in enabled else 'выключен':<14} {s['url']}")
print("Подключить: npm run mcp-hub:connect -- <имя> · отключить: npm run mcp-hub:disconnect -- <имя>")
PY
}

is_connector() {
  python3 -c 'import json, sys
s = json.load(open(sys.argv[1]))["mcpServers"].get(sys.argv[2])
sys.exit(0 if s and "connector" in s.get("tags", []) else 1)' "$CONFIG_SRC" "$1"
}

cmd_connect() {
  local name="${1:-}" state url
  if [ -z "$name" ]; then
    cmd_connectors
    return 0
  fi
  if ! is_connector "$name"; then
    echo "Коннектора «${name}» нет в infra/mcp-hub/mcp.json — список: npm run mcp-hub:connectors" >&2
    return 1
  fi
  host_guard || return 1
  mkdir -p "$CONFIG_DIR"
  touch "$CONNECTORS_FILE"
  grep -qxF "$name" "$CONNECTORS_FILE" || echo "$name" >>"$CONNECTORS_FILE"
  cmd_sync >/dev/null
  # Хаб перечитывает конфиг сам; ждём, пока сервер дойдёт до готовности или до запроса OAuth.
  IFS=$'\t' read -r state url < <(python3 - "$HUB_PORT" "$name" <<'PY'
import json, sys, time, urllib.request
port, name = sys.argv[1], sys.argv[2]
for _ in range(45):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health/mcp", timeout=5) as r:
            servers = json.load(r)["servers"]
        for st in ("ready", "awaitingOAuth", "failed"):
            if name in servers["byState"].get(st, []):
                print(f"{st}\t{servers.get('details', {}).get(name, {}).get('authorizationUrl', '')}")
                raise SystemExit(0)
    except SystemExit:
        raise
    except Exception:
        pass
    time.sleep(2)
print("timeout\t")
PY
)
  case "$state" in
    ready) echo "✓ $name подключён — инструменты уже в хабе" ;;
    awaitingOAuth)
      echo "→ $name ждёт входа"
      if [ -n "$url" ] && [ -z "${MCP_HUB_NO_OPEN:-}" ]; then
        open "$url"
        echo "  страница входа открыта в браузере; после входа сервер подключится сам"
      else
        echo "  войти: npm run mcp-hub:auth"
      fi
      ;;
    failed) echo "✗ $name не поднялся — npm run mcp-hub:logs" >&2 ;;
    *) echo "⚠ $name: хаб не ответил за 90 с — запущен ли он? npm run mcp-hub:status" >&2 ;;
  esac
  echo "Claude Code видит его через запись hub после /mcp → reconnect; Copilot и остальные — сразу."
}

cmd_disconnect() {
  local name="${1:?usage: mcp-hub.sh disconnect <имя коннектора>}"
  host_guard || return 1
  if [ -f "$CONNECTORS_FILE" ]; then
    grep -vxF "$name" "$CONNECTORS_FILE" >"$CONNECTORS_FILE.tmp" || true
    mv "$CONNECTORS_FILE.tmp" "$CONNECTORS_FILE"
  fi
  cmd_sync >/dev/null
  echo "Коннектор $name отключён (OAuth-токены остаются в $CONFIG_DIR/clientSessions)."
}
