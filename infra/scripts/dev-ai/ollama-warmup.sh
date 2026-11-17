#!/usr/bin/env bash
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Каждый вызов модели — под машинным замком локального инференса, общим с консилиумом и шлюзом моделей (OPS-33):
# раньше прогрев шёл параллельно с их инференсом. Замок — на одну модель, а не на весь прогрев. Ждать замок —
# не дольше OLLAMA_WARMUP_LOCK_WAIT секунд; не дождались — модель пропускается.
LOCK_WAIT="${OLLAMA_WARMUP_LOCK_WAIT:-300}"
LOCK_BUSY=75

models=(
  "glm4:latest"
  "qwen2.5:7b"
  "nomic-embed-text:latest"
  "hr-helper-agent:latest"
  "hr-helper-vision:latest"
  "tiel-coder:35b-a3b-iq3s"
)
# Ростер 2026-10-28: после d-mac-models = drop-4 (2026-10-23) на Mac остались glm4/qwen2.5/
# nomic-embed + вернувшийся Tiel-Coder (L-tier). Прежний список с qwen3.6/mistral/qwen3-coder
# и hr-helper-алиасами удалённых моделей падал на первом же 404.
# DeepSeek-R1 выведен из dev-стека 2026-08-13: роль независимого аналитика забрал
# glm4:latest (другая линейка, вдвое легче), см. .continue/rules/02-context-routing.md.

echo "Checking Ollama at $OLLAMA_HOST ..."
curl -fsS "$OLLAMA_HOST" >/dev/null
command -v python3 >/dev/null || { echo "Нужен python3: он держит замок локального инференса (OPS-33)" >&2; exit 1; }

locked() {
  local model="$1"
  shift
  python3 -I "$HERE/ollama-locked.py" --who "warmup $model" --wait "$LOCK_WAIT" -- "$@"
}

warm_llm() {
  local model="$1"
  echo "Warming LLM: $model"
  local rc=0
  locked "$model" curl -fsS "$OLLAMA_HOST/api/generate" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$model\",
      \"prompt\": \"Reply with one word: ok\",
      \"stream\": false,
      \"options\": {
        \"num_predict\": 8
      }
    }" >/dev/null || rc=$?
  case "$rc" in
    0) ;;
    "$LOCK_BUSY") echo "⚠ $model: замок локального инференса занят дольше ${LOCK_WAIT} с — пропуск" ;;
    *) echo "⚠ $model не установлена/не отвечает — пропуск (не фатально)" ;;
  esac
}

warm_embed() {
  local model="$1"
  echo "Warming EMBED: $model"
  local rc=0
  locked "$model" curl -fsS "$OLLAMA_HOST/api/embeddings" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"$model\",
      \"prompt\": \"warmup\"
    }" >/dev/null || rc=$?
  if [[ "$rc" == "$LOCK_BUSY" ]]; then
    echo "⚠ $model: замок локального инференса занят дольше ${LOCK_WAIT} с — пропуск"
  elif [[ "$rc" != 0 ]]; then
    return "$rc"
  fi
}

for model in "${models[@]}"; do
  case "$model" in
    *embed*|nomic-embed-text:latest)
      warm_embed "$model"
      ;;
    *)
      warm_llm "$model"
      ;;
  esac
done

echo "Warmup complete."
