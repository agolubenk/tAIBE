#!/usr/bin/env bash
# Управление AI-tooling пайплайном ассистента (DAMS/GLM/HEADROOM/Continue) —
# НЕ путать с npm run dev:ai (тот поднимает Ollama-модели для ПРОДУКТА).
# Здесь — инструменты, которыми Claude Code/Continue пользуются САМИ во время
# разработки: HEADROOM persistent proxy (Docker, порт 8787, перед которым
# сидит ANTHROPIC_BASE_URL из .claude/settings.local.json) + Ollama daemon
# (нужен Continue для локальных моделей) + проверка GLM-ключа.
#
# Serena / headroom MCP / context-mode / claude-mem / notion сюда сознательно не входят:
# это эфемерные MCP stdio/http-серверы (или requires-OAuth remote-серверы), их
# поднимает/гасит/авторизует сам Claude Code или Continue по требованию сессии —
# отдельного демона у них нет, управлять нечем. `status` лишь проверяет, что они
# видны в `claude mcp list` (см. CLAUDE_MCP_CHECK ниже). Notion — зарегистрирован
# в `.mcp.json` (project scope), но первый OAuth-approve делает пользователь сам
# в интерактивной сессии (`claude`/`/mcp`) — не автоматизируется этим скриптом.
#
# AI Council (`infra/ai-council/`, спека docs/specs/ai-council.md) — исключение из
# правила выше и входит сюда законно: это НЕ эфемерный MCP-сервер, а настоящее дерево
# долгоживущих процессов (супервизор + воркеры), у которого есть свой жизненный цикл.
# Notion он дёргает не через OAuth-MCP, а по REST с internal integration token
# (.claude/council/.notion-key) — поэтому работает headless, без интерактивного approve.
# Нет ключа/Ollama — поднимается в вырожденном режиме и говорит об этом, не роняя пайплайн.
#
# Strix — тоже сознательно не входит, но по другой причине: это не сервер, а
# on-demand CLI/cloud-сканер (`infra/scripts/security/.env.strix*`), которого
# запускают вручную под конкретный скан — не демон, нечего start/stop'ать.
# `status` лишь проверяет, что бинарь/конфиг на месте (см. check_strix).
#
# Использование (из корня репозитория):
#   bash infra/scripts/dev-ai/ai-tooling-pipeline.sh {start|stop|restart|status|dashboard}
#   npm run ai-pipeline:start | ai-pipeline:stop | ai-pipeline:status | ai-pipeline:dashboard
#
# Работа с самим консилиумом (очередь, планы, вердикты) — отдельными скриптами, не тут:
#   npm run ai-council:status | ai-council:doctor | ai-council:run | ai-council:plan
#   npm run ai-council:verdict | ai-council:selftest | ai-council:ui
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Код слоя — от ROOT; данные хоста (ключи, логи консилиума, .mcp.json) — от TAIBE_HOST_ROOT, без него — ROOT.
HOST_ROOT="${TAIBE_HOST_ROOT:-$ROOT}"
# shellcheck source=../dev/dev-common.sh
source "$ROOT/infra/scripts/dev/dev-common.sh"

HEADROOM_BIN="${HEADROOM_BIN:-headroom}"
HEADROOM_PROFILE="${HEADROOM_PROFILE:-default}"
# Версия образа dev-прокси меняется только вместе с CLI на хосте (`uv tool install 'headroom-ai[all]==<версия>'`) —
# cmd_headroom_apply сверяет одно с другим.
HEADROOM_IMAGE="${HEADROOM_IMAGE:-ghcr.io/headroomlabs-ai/headroom:0.41.0}"
HEADROOM_URL="${HEADROOM_URL:-http://127.0.0.1:8787}"
# Копии ~/.headroom перед каждым headroom-apply (история экономии, журнал событий, CCR, логи) — вне рабочего
# каталога прокси, чтобы контейнер их не видел.
HR_HEADROOM_BACKUP_ROOT="${HR_HEADROOM_BACKUP_ROOT:-$HOME/.headroom-backups}"
# Постоянный архив журнала событий (по файлу на месяц): сам Headroom хранит журнал только 30 дней.
HR_HEADROOM_ARCHIVE="${HR_HEADROOM_ARCHIVE:-$HOME/.headroom-archive/events}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
GLM_KEY_FILE="$HOST_ROOT/.claude/rag/.glm-key"
DASHBOARD_PORT="${AI_TOOLING_DASHBOARD_PORT:-8788}"
DASHBOARD_PID_FILE="$HOST_ROOT/.claude/rag/.ai-tooling-dashboard.pid"
DASHBOARD_LOG_FILE="$HOST_ROOT/.claude/rag/.ai-tooling-dashboard.log"
COUNCIL_SUPERVISOR="$ROOT/infra/ai-council/supervisor.py"
CONFIG_FILE="$ROOT/infra/ai-council/config.toml"

dashboard_running() {
  [ -f "$DASHBOARD_PID_FILE" ] && kill -0 "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null
}

start_dashboard() {
  if dashboard_running; then
    return 0
  fi
  rm -f "$DASHBOARD_PID_FILE"
  if command -v lsof >/dev/null 2>&1 && lsof -ti ":$DASHBOARD_PORT" >/dev/null 2>&1; then
    echo "→ Dashboard already uses :$DASHBOARD_PORT (not managed by this script)." >&2
    return 0
  fi
  nohup python3 "$SCRIPT_DIR/ai-tooling-dashboard.py" "$DASHBOARD_PORT" >"$DASHBOARD_LOG_FILE" 2>&1 &
  local dashboard_pid=$!
  echo "$dashboard_pid" >"$DASHBOARD_PID_FILE"
  sleep 0.2
  if ! kill -0 "$dashboard_pid" 2>/dev/null; then
    rm -f "$DASHBOARD_PID_FILE"
    echo "Ошибка: dashboard не запустился (см. $DASHBOARD_LOG_FILE)." >&2
    return 1
  fi
}

stop_dashboard() {
  if dashboard_running; then
    kill "$(cat "$DASHBOARD_PID_FILE")" 2>/dev/null || true
  fi
  rm -f "$DASHBOARD_PID_FILE"
}

require_headroom() {
  if ! command -v "$HEADROOM_BIN" >/dev/null 2>&1; then
    echo "Ошибка: headroom CLI не найден в PATH (переопределить путь: HEADROOM_BIN=/путь/к/headroom)." >&2
    exit 1
  fi
}

check_glm() {
  echo "=== GLM ==="
  if [ -n "${GLM_API_KEY:-}" ]; then
    echo "→ ключ из env GLM_API_KEY"
  elif [ -f "$GLM_KEY_FILE" ]; then
    echo "→ ключ из $GLM_KEY_FILE"
  else
    echo "→ ключ не найден — task-brief/query-rewrite/summary в DAMS работают в fail-safe режиме (как DAMS_GLM=off)"
  fi
}

check_ollama() {
  echo "=== Ollama (нужен Continue для локальных моделей) ==="
  if curl -fsS --max-time 1 "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1; then
    echo "→ доступна ($OLLAMA_BASE_URL)"
  else
    echo "→ НЕ отвечает ($OLLAMA_BASE_URL)"
  fi
}

check_mcp() {
  echo "=== Claude Code MCP (best-effort) ==="
  if [ "${CLAUDE_MCP_CHECK:-0}" != "1" ]; then
    echo "→ пропущено (задайте CLAUDE_MCP_CHECK=1 для медленной live-проверки)"
    return 0
  fi
  if ! command -v claude >/dev/null 2>&1; then
    echo "→ claude CLI не найден в PATH — пропущено"
    return 0
  fi
  claude mcp list 2>/dev/null | grep -E "^(headroom|serena|notion):" || echo "→ headroom/serena/notion не в списке — см. claude mcp list вручную"
}

council_available() {
  [ -f "$COUNCIL_SUPERVISOR" ] && command -v python3 >/dev/null 2>&1
}

# Консилиум не имеет права уронить пайплайн: HEADROOM уже поднят к этому моменту, а при
# `set -euo pipefail` любой ненулевой код здесь оборвал бы cmd_start молча посередине.
start_council() {
  if ! council_available; then
    echo "=== AI Council ==="
    echo "→ пропущено (нет $COUNCIL_SUPERVISOR или python3)"
    return 0
  fi
  echo "=== AI Council ==="
  if ! python3 "$COUNCIL_SUPERVISOR" start; then
    echo "→ консилиум не стартовал — пайплайн это не ломает." >&2
    echo "  Диагностика: python3 infra/ai-council/supervisor.py doctor" >&2
  fi
}

stop_council() {
  council_available || return 0
  echo "=== AI Council: stop ==="
  python3 "$COUNCIL_SUPERVISOR" stop || true
}

check_council() {
  echo "=== AI Council ==="
  if ! council_available; then
    echo "→ не установлен (см. docs/specs/ai-council.md)"
    return 0
  fi
  python3 "$COUNCIL_SUPERVISOR" status || true
}

check_strix() {
  echo "=== Strix (on-demand pentest CLI, не демон) ==="
  if command -v strix >/dev/null 2>&1; then
    echo "→ CLI найден в PATH"
  else
    echo "→ CLI не найден в PATH (см. infra/scripts/README.md — self-hosted Docker или cloud API app.strix.ai)"
  fi
  if [ -f "$HOST_ROOT/infra/scripts/security/.env.strix" ]; then
    echo "→ профиль настроен: infra/scripts/security/.env.strix"
  else
    echo "→ профиль не настроен — cp infra/scripts/security/.env.strix.example infra/scripts/security/.env.strix"
  fi
}

cmd_start() {
  # Preflight: CORE_FAILURE (1) / INVALID_CONFIG (3) — блок start;
  # DEGRADED (2) — продолжаем с отключёнными возможностями (инвариант оригинала:
  # «нет ключа/Ollama — вырожденный режим, не роняя пайплайн»).
  # doctor вызывается в if — иначе set -e убьёт скрипт на его ненулевом rc.
  local doctor_rc=0
  # Прокси до start лежит штатно — его проверку preflight пропускает, иначе каждый холодный старт «DEGRADED».
  HR_DOCTOR_PREFLIGHT=1 cmd_doctor >/dev/null 2>&1 || doctor_rc=$?
  if [ $doctor_rc -eq 1 ] || [ $doctor_rc -eq 3 ]; then
    echo "Preflight FAILED (rc=$doctor_rc) — детали: npm run ai-pipeline:doctor" >&2
    return $doctor_rc
  elif [ $doctor_rc -eq 2 ]; then
    echo "Preflight: DEGRADED — поднимаем в урезанном режиме (детали: npm run ai-pipeline:doctor)"
  fi
  require_headroom
  echo "=== HEADROOM proxy ==="
  "$HEADROOM_BIN" install start --profile "$HEADROOM_PROFILE"
  headroom_archive_events "$HOME/.headroom/savings_events.jsonl" || true
  echo
  check_ollama
  if ! curl -fsS --max-time 1 "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1; then
    hr_ensure_ollama "$OLLAMA_BASE_URL"
  fi
  echo
  check_glm
  start_dashboard
  echo
  start_council
  echo
  echo "Готово. Дашборд: http://127.0.0.1:$DASHBOARD_PORT"
}

cmd_stop() {
  # Консилиум гасим первым: его воркеры могут держать модели в Ollama.
  stop_council
  # Dashboard is ours even when HEADROOM was removed or its PATH changed.
  stop_dashboard
  require_headroom
  echo "=== HEADROOM proxy: stop ==="
  "$HEADROOM_BIN" install stop --profile "$HEADROOM_PROFILE"
  echo
  echo "Ollama не останавливаем — общий системный демон, нужен и продуктовым Ollama-моделям (npm run dev:ai) вне этого пайплайна."
  echo "MCP-серверы (Serena/headroom/context-mode/claude-mem) не трогаем — эфемерны, их жизненным циклом управляет сам Claude Code/Continue."
}

cmd_restart() {
  require_headroom
  "$HEADROOM_BIN" install restart --profile "$HEADROOM_PROFILE"
  start_dashboard
  echo
  stop_council
  start_council
}

# Расход и экономия Headroom по аккаунтам. Метка — префикс `/p/<метка>/` в адресе клиента:
# continue-zai-coding, continue-zai-general, ai-council. Трафик без метки — Claude Code: сам по проекту
# Headroom его больше не раскладывает (запись HR_Helper-v2 застыла на 2026-08-07). История — /dashboard.
headroom_accounts() {
  python3 - "$HEADROOM_URL" <<'PY'
import json, sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1] + "/stats", timeout=5) as r:
        per = json.load(r).get("savings", {}).get("per_project") or {}
except Exception as e:
    print(f"→ /stats недоступен: {e}")
    raise SystemExit(0)
if not per:
    print("→ по аккаунтам пока пусто (запросов с рестарта прокси не было)")
for name, v in sorted(per.items(), key=lambda kv: -kv[1].get("requests", 0)):
    print(f"  {name:<24} запросов {v.get('requests', 0):>6} · сэкономлено токенов "
          f"{v.get('tokens_saved', 0):>10,} · ${v.get('compression_savings_usd', 0):.2f}")
PY
}

# Фактический конфиг dev-прокси против канона cmd_headroom_apply: версии образа и CLI, режим, lossless,
# Kompress, кэш ответов, лимитер, маяк. Расхождение — повод запустить `npm run ai-pipeline:headroom-apply`.
headroom_config_summary() {
  local cli
  cli="$("$HEADROOM_BIN" --version 2>/dev/null | awk '{print $NF}')"
  python3 - "$HEADROOM_URL" "$HOME/.headroom/deploy/$HEADROOM_PROFILE/manifest.json" "$cli" <<'PY'
import json, sys, urllib.request
url, manifest_path, cli = sys.argv[1:4]
try:
    with open(manifest_path) as f:
        manifest = json.load(f)
except (OSError, ValueError) as e:
    print(f"→ манифест не прочитан ({manifest_path}): {e}")
    raise SystemExit(0)
tag = str(manifest.get("image", "?")).rsplit(":", 1)[-1]
args, env = manifest.get("proxy_args") or [], manifest.get("base_env") or {}
try:
    with urllib.request.urlopen(url + "/health", timeout=5) as r:
        kompress = (json.load(r).get("checks") or {}).get("kompress", {}).get("status", "?")
    with urllib.request.urlopen(url + "/stats", timeout=10) as r:
        prefix = ((json.load(r).get("prefix_cache") or {}).get("by_provider") or {}).get("anthropic") or {}
except Exception:
    kompress, prefix = "прокси не ответил", {}
drift = "" if cli == tag else "  ← расходятся: npm run ai-pipeline:headroom-apply"
print(f"  образ {tag} · CLI {cli or '?'}{drift}")
print(f"  mode={env.get('HEADROOM_MODE', '?')} · lossless={env.get('HEADROOM_LOSSLESS', '0')} · kompress={kompress} · "
      f"кэш ответов={'выкл' if '--no-cache' in args else 'ВКЛ'} · "
      f"лимитер={'выкл' if '--no-rate-limit' in args else env.get('HEADROOM_RPM', '60') + ' rpm'} · "
      f"маяк={env.get('HEADROOM_BEACON', 'ВКЛ (по умолчанию)')} · "
      f"tiktoken={'постоянный' if env.get('TIKTOKEN_CACHE_DIR') else '/tmp контейнера'}")
# Сброс = префикс, который был в кэше, записан заново (в 1,25–2 раза дороже чтения). На 0.39.1 — 70 % записей.
writes = prefix.get("cache_write_tokens") or 0
if prefix.get("requests"):
    print(f"  кэш префикса Anthropic с рестарта: попаданий {prefix.get('hit_rate', '?')} % · сбросов "
          f"{prefix.get('bust_count', 0)} на {prefix['requests']} запросов · "
          f"{100 * (prefix.get('bust_write_tokens') or 0) / writes if writes else 0:.0f} % записанных токенов — перезапись")
PY
}

headroom_wait_ready() {
  local i
  for i in $(seq 1 90); do
    if curl -fsS --max-time 2 -o /dev/null "$HEADROOM_URL/readyz" 2>/dev/null; then
      echo "→ прокси готов за ${i} с"
      return 0
    fi
    sleep 1
  done
  echo "Ошибка: прокси не ответил на /readyz за 90 с — docker logs headroom-default" >&2
  return 1
}

# Флаги прокси, которых `headroom install apply` не принимает (сейчас — --no-cache), дописываются в proxy_args
# манифеста: команду контейнера `install start/restart` собирают из него. Следующий apply их сотрёт, поэтому
# дописывает их только cmd_headroom_apply — сразу после apply.
headroom_manifest_add_args() {
  python3 - "$HOME/.headroom/deploy/$HEADROOM_PROFILE/manifest.json" "$@" <<'PY'
import json, os, sys
path, extra = sys.argv[1], sys.argv[2:]
with open(path) as f:
    manifest = json.load(f)
args = manifest.setdefault("proxy_args", [])
args.extend(a for a in extra if a not in args)
with open(path + ".tmp", "w") as f:
    json.dump(manifest, f, indent=2)
os.replace(path + ".tmp", path)
PY
}

# История (proxy_savings.json — пожизненные итоги, savings_events.jsonl — журнал запросов) живёт в ~/.headroom
# на хосте и переживает пересоздание контейнера сама; копия нужна на случай, если новая версия перепишет формат,
# и для отката. Снимается с остановленного прокси: итоги он сбрасывает на диск при остановке.
headroom_backup_state() {
  local dest
  dest="$HR_HEADROOM_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  # Зовётся через $(…), а там set -e не действует (bash 3.2 без inherit_errexit): каждую ошибку — явно,
  # иначе несостоявшаяся копия молча проходит как удачная.
  mkdir -p "$dest" || return 1
  cp -a "$HOME/.headroom/." "$dest/" || return 1
  if [ -f "$HOME/.headroom/proxy_savings.json" ] && [ ! -s "$dest/proxy_savings.json" ]; then
    return 1
  fi
  echo "$dest"
}

# Поднять прокси после неудачного шага headroom-apply — с прежним манифестом из копии, если она есть, иначе с
# текущим. Сам прокси важнее нового конфига: без него не работает ни одна сессия Claude Code.
headroom_start_previous() {
  local backup="$1" why="$2" manifest="deploy/$HEADROOM_PROFILE/manifest.json"
  echo "Ошибка в headroom-apply: $why — поднимаю прокси с прежним конфигом" >&2
  if [ -n "$backup" ] && [ -f "$backup/$manifest" ]; then
    cp "$backup/$manifest" "$HOME/.headroom/$manifest" || true
  fi
  env -u ANTHROPIC_BASE_URL "$HEADROOM_BIN" install restart --profile "$HEADROOM_PROFILE" >/dev/null 2>&1 \
    || env -u ANTHROPIC_BASE_URL "$HEADROOM_BIN" install start --profile "$HEADROOM_PROFILE" >/dev/null 2>&1 || true
  headroom_wait_ready || true
}

# Журнал событий Headroom хранит только 30 дней (MAX_RETENTION_DAYS в savings_ledger.py): при сжатии файла — а
# новый процесс сжимает его при первой же записи — старое стирается. Архив — копия всей истории вне рабочего
# каталога прокси, по файлу на месяц; строки сверяются по хэшу, повторный запуск ничего не дублирует. Чтобы не
# терять события, достаточно запускать это реже, чем раз в 30 дней: зовут start, status и headroom-apply.
headroom_archive_events() {
  python3 - "$1" "$HR_HEADROOM_ARCHIVE" <<'PY'
import fcntl, hashlib, json, os, sys
src, root = sys.argv[1:3]
if not os.path.exists(src):
    raise SystemExit(0)
os.makedirs(root, exist_ok=True)
lock = open(os.path.join(root, ".lock"), "w")
fcntl.flock(lock, fcntl.LOCK_EX)  # два status одновременно иначе дописали бы одни и те же строки дважды
known, files, added = {}, {}, 0
def hashes(month):
    if month not in known:
        path = os.path.join(root, f"{month}.jsonl")
        known[month] = set()
        if os.path.exists(path):
            with open(path, "rb") as f:
                known[month] = {hashlib.sha1(line.strip()).digest() for line in f if line.strip()}
    return known[month]
try:
    with open(src, "rb") as f:
        for line in f:
            line = line.strip()
            try:
                month = str(json.loads(line)["ts"])[:7]
            except (ValueError, KeyError, TypeError):
                continue  # недописанная строка — попадёт в архив в следующий раз
            digest = hashlib.sha1(line).digest()
            if digest in hashes(month):
                continue
            if month not in files:
                files[month] = open(os.path.join(root, f"{month}.jsonl"), "ab")
            files[month].write(line + b"\n")
            known[month].add(digest)
            added += 1
finally:
    for handle in files.values():
        handle.close()
months = sorted(n[:-6] for n in os.listdir(root) if n.endswith(".jsonl"))
total = 0
for m in months:
    with open(os.path.join(root, f"{m}.jsonl"), "rb") as f:
        total += sum(chunk.count(b"\n") for chunk in iter(lambda: f.read(1 << 20), b""))
span = f"{months[0]}…{months[-1]}" if months else "—"
print(f"  архив событий: +{added}, всего {total:,} за {span} ({root})")
PY
}

# Пожизненные итоги после рестарта не меньше, чем в копии, и журнал хранит все события копии за последние
# 29 дней (запас к 30-дневному окну Headroom) — иначе история потеряна. Более старые события — в архиве.
headroom_verify_history() {
  python3 - "$1" "$HEADROOM_URL" "$HOME/.headroom/savings_events.jsonl" <<'PY'
import datetime as dt, json, os, sys, urllib.request
backup, url, events = sys.argv[1:4]
if not os.path.exists(f"{backup}/proxy_savings.json"):
    print("  истории до обновления не было — сверять нечего")
    raise SystemExit(0)
with open(f"{backup}/proxy_savings.json") as f:
    before = json.load(f).get("lifetime") or {}
with urllib.request.urlopen(url + "/stats", timeout=10) as r:
    after = (json.load(r).get("persistent_savings") or {}).get("lifetime") or {}
def stamps(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, "rb") as f:
        for line in f:
            try:
                t = dt.datetime.fromisoformat(json.loads(line)["ts"])
            except (ValueError, KeyError, TypeError):
                continue
            out.append(t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc))  # наивное время — UTC
    return out
old, new = stamps(f"{backup}/savings_events.jsonl"), stamps(events)
cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=29)
last = max(old, default=cutoff)
pairs = [(k, before.get(k, 0), after.get(k, 0)) for k in ("requests", "tokens_saved", "total_input_tokens")]
pairs.append(("событий за 29 дней", sum(cutoff <= t <= last for t in old), sum(cutoff <= t <= last for t in new)))
for name, b, a in pairs:
    print(f"  {name}: было {b:,} → стало {a:,} {'✓' if a >= b else '✗'}")
sys.exit(0 if all(a >= b for _, b, a in pairs) else 1)
PY
}

# Канонический конфиг dev-прокси одной командой вместо копипасты из README; почему именно так —
# infra/headroom/developer/README.md §«Конфигурация». Повторный запуск даёт тот же манифест. Пока контейнер
# пересоздаётся (20–40 с вместе с копией истории), клиенты получают отказ соединения — Claude Code и консилиум
# повторяют запрос сами.
cmd_headroom_apply() {
  require_headroom
  local backup cli image_version="${HEADROOM_IMAGE##*:}"
  cli="$("$HEADROOM_BIN" --version 2>/dev/null | awk '{print $NF}')"
  # Прокси ≥ 0.40 не слушает 0.0.0.0 без токена, пока лаунчер не передаст HEADROOM_ALLOW_UNAUTHENTICATED_BIND=1,
  # а лаунчер CLI 0.39 его не передаёт: новый образ со старым CLI не поднимется.
  if [ "$cli" != "$image_version" ]; then
    echo "Ошибка: CLI $cli ≠ образ $image_version. Сначала: uv tool install 'headroom-ai[all]==$image_version'" >&2
    return 1
  fi
  # Словари tiktoken (~3,5 МБ) по умолчанию лежат в /tmp контейнера и пропадают при каждом пересоздании: на
  # медленной сети первые запросы после старта ждали по 10 с на словарь. TIKTOKEN_CACHE_DIR ниже держит их в
  # смонтированном ~/.headroom; первый раз заполняем из работающего контейнера, чтобы не качать заново.
  if [ ! -d "$HOME/.headroom/tiktoken-cache" ]; then
    mkdir -p "$HOME/.headroom/tiktoken-cache"
    docker cp headroom-default:/tmp/data-gym-cache/. "$HOME/.headroom/tiktoken-cache/" >/dev/null 2>&1 || true
  fi
  env -u ANTHROPIC_BASE_URL "$HEADROOM_BIN" install stop --profile "$HEADROOM_PROFILE" || true
  # Дальше прокси остановлен, а без него не работает ни одна сессия Claude Code: каждый шаг до готовности
  # проверяется явно. Ловушка ERR не годится — bash 3.2 (им запускает npm) не вызывает её для ошибок внутри
  # функций, а set -e не действует внутри $(…) (проверено 2026-10-15).
  if ! backup="$(headroom_backup_state)"; then
    headroom_start_previous "" "копия ~/.headroom не снята, конфиг не менялся"
    return 1
  fi
  echo "→ копия ~/.headroom (история, журнал событий, CCR, логи): $backup"
  headroom_archive_events "$backup/savings_events.jsonl" || echo "! архив событий не дописан — события есть в копии $backup" >&2
  # Лаунчер пробрасывает в контейнер все ANTHROPIC_*/OPENAI_*/HEADROOM_* из окружения. ANTHROPIC_BASE_URL из
  # ~/.zshrc прокси не читает (его апстрим — ANTHROPIC_TARGET_API_URL), но контейнер должен совпадать с манифестом.
  if ! env -u ANTHROPIC_BASE_URL "$HEADROOM_BIN" install apply --profile "$HEADROOM_PROFILE" \
    --preset persistent-docker --providers manual --target claude --port 8787 --image "$HEADROOM_IMAGE" \
    --mode cache --no-telemetry --no-http2 \
    --env OPENAI_TARGET_API_URL=https://api.z.ai/api/coding/paas/v4 \
    --env OLLAMA_CONTEXT_LENGTH=64000 \
    --env HEADROOM_LOSSLESS=1 \
    --env HEADROOM_DISABLE_KOMPRESS=1 \
    --env HEADROOM_BEACON=off \
    --env HEADROOM_RPM=600 \
    --env HEADROOM_REQUEST_TIMEOUT=600 \
    --env TIKTOKEN_CACHE_DIR=/tmp/headroom-home/.headroom/tiktoken-cache; then
    headroom_start_previous "$backup" "install apply упал"
    return 1
  fi
  headroom_manifest_add_args --no-cache || echo "! --no-cache не дописан в манифест — кэш ответов останется включённым" >&2
  if ! env -u ANTHROPIC_BASE_URL "$HEADROOM_BIN" install restart --profile "$HEADROOM_PROFILE" || ! headroom_wait_ready; then
    headroom_start_previous "$backup" "новый конфиг не поднялся"
    return 1
  fi
  echo "--- история:"
  if ! headroom_verify_history "$backup"; then
    echo "Ошибка: история после обновления меньше, чем в копии $backup — откат: infra/headroom/developer/README.md §«Откат»" >&2
    return 1
  fi
  headroom_config_summary
}

cmd_status() {
  echo "=== HEADROOM ==="
  if command -v "$HEADROOM_BIN" >/dev/null 2>&1; then
    "$HEADROOM_BIN" install status --profile "$HEADROOM_PROFILE" || true
    echo "--- конфиг:"
    headroom_config_summary
    headroom_archive_events "$HOME/.headroom/savings_events.jsonl" || true
  else
    echo "→ CLI не найден"
  fi
  echo "--- по аккаунтам (с рестарта прокси):"
  headroom_accounts
  echo
  check_ollama
  echo
  check_glm
  echo
  check_council
  echo
  check_strix
  echo
  check_mcp
}

cmd_dashboard() {
  start_dashboard
  echo "Dashboard: http://127.0.0.1:$DASHBOARD_PORT"
}

# ── doctor: структурированный readiness-отчёт CORE/REQUIRED/SESSION/OPTIONAL ──
# Exit codes: 0=READY, 1=CORE_FAILURE, 2=DEGRADED, 3=INVALID_CONFIGURATION.
# Добавлено additive поверх существующих проверок: ничего не поднимает и не гасит,
# только диагностирует. `start` на CORE_FAILURE не продолжит (см. cmd_start).
cmd_doctor() {
  local core_failures=0 required_failures=0 core="OK"

  echo "=== AI Pipeline Doctor ==="
  echo
  echo "--- CORE (без них пайплайн не считается запущенным) ---"
  if command -v python3 >/dev/null 2>&1; then
    echo "  ✓ Python $(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  else echo "  ✗ python3 не найден"; core="FAIL"; core_failures=$((core_failures+1)); fi
  if command -v node >/dev/null 2>&1; then echo "  ✓ Node.js $(node -v)"
  else echo "  ✗ node не найден"; core="FAIL"; core_failures=$((core_failures+1)); fi
  if command -v npm >/dev/null 2>&1; then echo "  ✓ npm $(npm -v)"
  else echo "  ✗ npm не найден"; core="FAIL"; core_failures=$((core_failures+1)); fi
  if [ -f "$CONFIG_FILE" ]; then
    if python3 -c "import tomllib,sys; tomllib.load(open('$CONFIG_FILE','rb'))" 2>/dev/null; then
      echo "  ✓ AI Council config: валидный TOML"
    else
      echo "  ✗ AI Council config: невалидный TOML"; core="INVALID"
    fi
  else
    echo "  ✗ AI Council config отсутствует"; core="FAIL"; core_failures=$((core_failures+1)); fi
  # headroom — единственный жёсткий блокер start в оригинале (require_headroom: exit 1)
  if command -v "$HEADROOM_BIN" >/dev/null 2>&1; then echo "  ✓ headroom CLI ($HEADROOM_BIN)"
  else echo "  ✗ headroom CLI не найден — start упадёт в require_headroom"; core="FAIL"; core_failures=$((core_failures+1)); fi

  echo
  echo "--- REQUIRED (full-quality; отсутствие = degraded, не блок) ---"
  # Инвариант оригинала: «Нет ключа/Ollama — вырожденный режим, не роняя пайплайн»;
  # Council тоже не имеет права уронить пайплайн → REQUIRED, не CORE.
  if python3 "$COUNCIL_SUPERVISOR" doctor >/dev/null 2>&1; then
    echo "  ✓ AI Council: полный doctor пройден"
  else
    echo "  ! AI Council: не все проверки пройдены — python3 infra/ai-council/supervisor.py doctor"; required_failures=$((required_failures+1))
  fi
  if curl -fsS --max-time 1 "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1; then
    echo "  ✓ Ollama API: $OLLAMA_BASE_URL"
  else
    echo "  ! Ollama не отвечает — start вызовет hr_ensure_ollama и поднимет сам"; required_failures=$((required_failures+1))
  fi
  # Не CORE: start сам поднимает прокси и не должен отказываться стартовать из-за того, что тот лежит.
  if [ "${HR_DOCTOR_PREFLIGHT:-0}" = "1" ]; then
    :
  elif curl -fsS --max-time 2 -o /dev/null "$HEADROOM_URL/readyz" 2>/dev/null; then
    echo "  ✓ Headroom прокси: $HEADROOM_URL/readyz"
  else
    echo "  ! Headroom прокси не отвечает — сессии Claude Code с ANTHROPIC_BASE_URL на него не работают: npm run ai-pipeline:start"
    required_failures=$((required_failures+1))
  fi
  if [ -n "${GLM_API_KEY:-}" ] || [ -f "$GLM_KEY_FILE" ]; then echo "  ✓ GLM-ключ (DAMS task-brief/query-rewrite)"
  else echo "  ! GLM-ключ не найден — DAMS уходит в fail-safe режим"; required_failures=$((required_failures+1)); fi

  echo
  echo "--- SESSION (поднимаются в AI-сессии, не этим пайплайном) ---"
  if [ -f "$HOST_ROOT/.mcp.json" ]; then
    if python3 -c "import json; json.load(open('$HOST_ROOT/.mcp.json'))" 2>/dev/null; then
      echo "  ✓ .mcp.json валиден"
      # Serena и headroom живут в user-scope Claude Code, не в project .mcp.json
      for mcp_name in notion github sentry postgres-readonly; do
        if python3 -c "import json; d=json.load(open('$HOST_ROOT/.mcp.json')); exit(0 if 'mcpServers' in d and '$mcp_name' in d['mcpServers'] else 1)" 2>/dev/null; then
          echo "  ✓ $mcp_name: описан в mcpServers (project scope)"
        else
          echo "  ! $mcp_name: не найден в project .mcp.json"
        fi
      done
    else
      echo "  ✗ .mcp.json невалидный JSON — INVALID_CONFIGURATION"; core="INVALID"
    fi
  else
    echo "  ! .mcp.json отсутствует"
  fi
  # Serena/headroom: user-scope Claude Code — live-проверка за тем же флагом,
  # что в check_mcp (медленная, поэтому opt-in).
  if [ "${CLAUDE_MCP_CHECK:-0}" = "1" ] && command -v claude >/dev/null 2>&1; then
    claude mcp list 2>/dev/null | grep -E '^(serena|headroom):' | sed 's/^/  /' \
      || echo "  ! serena/headroom не видны в claude mcp list (user scope)"
  else
    echo "  ! serena/headroom (user scope): live-проверка — CLAUDE_MCP_CHECK=1 npm run ai-pipeline:doctor"
  fi

  echo
  echo "--- OPTIONAL ---"
  if [ -n "${NOTION_TOKEN:-}${NOTION_API_KEY:-}" ] || [ -f "$HOST_ROOT/.claude/council/.notion-key" ]; then
    echo "  ✓ Notion access (council REST/internal-integration)"
  else echo "  ! Notion: OAuth запрашивается MCP-клиентом в сессии"; fi
  if [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_TOKEN:-}" ]; then echo "  ✓ GitHub token"
  else echo "  ! GitHub OAuth не инициализирован"; fi
  if command -v strix >/dev/null 2>&1; then echo "  ✓ strix CLI (on-demand pentest)"
  else echo "  ! strix CLI не в PATH — см. infra/scripts/README.md"; fi

  echo
  if [ "$core" = "INVALID" ]; then
    echo "RESULT: INVALID_CONFIGURATION"
    return 3
  elif [ $core_failures -gt 0 ]; then
    echo "RESULT: CORE_FAILURE ($core_failures)"
    return 1
  elif [ $required_failures -gt 0 ]; then
    echo "RESULT: DEGRADED ($required_failures) — basic-режим без blocked capabilities"
    return 2
  else
    echo "RESULT: READY"
    return 0
  fi
}

# ── logs: хвост логов pipeline-owned процессов (dashboard + council) ──
cmd_logs() {
  local lines="${1:-80}"
  local svc="${2:-}"
  # Dashboard — наш процесс (PID-файл и лог в .claude/rag/),
  # Council-сервисы пишут логи в .claude/council/<name>.log (supervisor.py log_file()).
  if [ -n "$svc" ]; then
    if [ "$svc" = "dashboard" ]; then
      tail -n "$lines" "$DASHBOARD_LOG_FILE" 2>/dev/null || echo "(нет лога dashboard — ещё не запускался)"
    elif [ -f "$HOST_ROOT/.claude/council/$svc.log" ]; then
      tail -n "$lines" "$HOST_ROOT/.claude/council/$svc.log"
    else
      echo "Нет лога '$svc' в .claude/council/ (доступны: $(ls "$HOST_ROOT/.claude/council/" 2>/dev/null | grep '\.log$' | sed 's/\.log$//' | tr '\n' ' '))"
      return 1
    fi
    return 0
  fi
  echo "=== Dashboard ($DASHBOARD_LOG_FILE) ==="
  tail -n "$lines" "$DASHBOARD_LOG_FILE" 2>/dev/null || echo "(нет лога — dashboard ещё не запускался)"
  echo
  for f in "$HOST_ROOT"/.claude/council/*.log; do
    [ -f "$f" ] || continue
    echo "=== Council: $(basename "$f") (последние $lines) ==="
    tail -n "$lines" "$f"
    echo
  done
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  dashboard) cmd_dashboard ;;
  doctor) cmd_doctor ;;
  logs) cmd_logs "${2:-80}" "${3:-}" ;;
  headroom-apply) cmd_headroom_apply ;;
  *)
    echo "Использование: $0 {start|stop|restart|status|dashboard|doctor|logs [lines] [service]|headroom-apply}" >&2
    echo "  headroom-apply — пересоздать dev-прокси Headroom с каноническим конфигом (infra/headroom/developer/README.md)" >&2
    echo "  doctor — readiness CORE/REQUIRED/SESSION/OPTIONAL; exit 0=READY 1=CORE_FAIL 2=DEGRADED 3=INVALID_CONFIG" >&2
    echo "  logs — хвост логов pipeline-owned процессов: dashboard + council (gateway/council/context/planner/notion-sync/learning)" >&2
    exit 1
    ;;
esac
