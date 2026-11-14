#!/usr/bin/env bash
# Tiel-Coder 35B-A3B (Ornith-1.5, qwen3.5-moe) — UD-IQ3_S + MTP, локальный GGUF-импорт:
#   тег tiel-coder:35b-a3b-iq3s — код-ассистент: deep-предложения консилиума (proposer.code),
#   Continue (Executor), чат через HR Gateway (local/<тег> появляется сам).
#
# Файлы (14.07 ГБ + 0.9 ГБ mmproj) качаются с Hugging Face в infra/local/ollama/gguf/
# (gitignored, докачка curl -C -). hf CLI не используется: системному Python 3.14 не хватает
# модуля yaml — см. LOCAL_OLLAMA_MODELS.md.
#
# Использование (из корня репозитория):
#   npm run ollama:tiel-coder
#   SKIP_DOWNLOAD=1 npm run ollama:tiel-coder   # файлы уже на месте
#   SKIP_SHA=1 ...                              # без проверки sha256 (медленно на 14 ГБ)
#   VISION=0 ...                                # без mmproj (только текст)
#   RUN_SMOKE=1 ...                             # + тестовая генерация (грузит 13 ГБ)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=dev-common.sh
source "$ROOT/infra/scripts/dev/dev-common.sh"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"

HF_REPO="peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP"
GGUF_DIR="$ROOT/infra/local/ollama/gguf"
TAG="tiel-coder:35b-a3b-iq3s"

# num_ctx 16384: 13.1 ГБ весов + ~1.6 ГБ KV (qwen3.5-moe GQA) укладываются в ~16 ГБ
# GPU-бюджета 24-ГБ машины. 32k уже частично уходит в CPU, 64k — своп.
NUM_CTX="${NUM_CTX:-16384}"

MAIN_FILE="Tiel-Coder-35B-A3B-MTP-UD-IQ3_S.gguf"
MAIN_SHA="928c4d44265b7af6c64cc54c2caf36333339a31c90100b2b3bb33319a80d51cc"
MAIN_SIZE=14066147200
MMPROJ_FILE="mmproj-BF16.gguf"
MMPROJ_SHA="d9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837"
MMPROJ_SIZE=902822016

mkdir -p "$GGUF_DIR"

fetch() {
  local file="$1" want_sha="$2" want_size="$3"
  local url="https://huggingface.co/${HF_REPO}/resolve/main/${file}"
  local have=0
  [ -f "$GGUF_DIR/$file" ] && have="$(stat -f%z "$GGUF_DIR/$file")"
  if [[ "$have" == "$want_size" ]]; then
    echo "→ $file уже скачан полностью ($have байт) — загрузка не нужна."
  elif [[ "${SKIP_DOWNLOAD:-0}" != "1" || "$have" == "0" ]]; then
    echo "→ Загрузка/докачка $file из ${HF_REPO} (есть $have из $want_size)…"
    curl -sS -L --fail --retry 8 --retry-delay 10 --retry-all-errors -C - \
      -o "$GGUF_DIR/$file" "$url"
  else
    echo "→ $file на месте неполностью ($have из $want_size), SKIP_DOWNLOAD=1 — проверяю что есть."
  fi
  if [[ "${SKIP_SHA:-0}" != "1" && "$want_sha" != "" ]]; then
    echo "→ Проверка sha256 $file …"
    local got
    got="$(shasum -a 256 "$GGUF_DIR/$file" | awk '{print $1}')"
    if [[ "$got" != "$want_sha" ]]; then
      echo "   ⚠ sha256 не совпал: $got" >&2
      echo "   Удалите файл и повторите: rm '$GGUF_DIR/$file'" >&2
      exit 1
    fi
  fi
}

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ошибка: установите Ollama — https://ollama.com/download" >&2
  exit 1
fi

echo "→ Проверка / запуск Ollama ($OLLAMA_BASE_URL)…"
hr_ensure_ollama "$OLLAMA_BASE_URL"

fetch "$MAIN_FILE" "$MAIN_SHA" "$MAIN_SIZE"
if [[ "${VISION:-1}" == "1" ]]; then
  fetch "$MMPROJ_FILE" "$MMPROJ_SHA" "$MMPROJ_SIZE"
fi

MODELFILE="$GGUF_DIR/tiel-coder.Modelfile"
cat >"$MODELFILE" <<EOF
# Генерируется infra/scripts/dev-ai/ollama-setup-tiel-coder.sh — не коммитится (каталог gitignored).
# Tiel-Coder 35B-A3B, unsloth-dynamic IQ3_S + MTP-слои. Vision: mmproj второй строкой FROM —
# Ollama сам определяет projector-GGUF по метаданным (инструкции PROJECTOR больше нет).
FROM $GGUF_DIR/$MAIN_FILE
EOF
if [[ "${VISION:-1}" == "1" ]]; then
  echo "FROM $GGUF_DIR/$MMPROJ_FILE" >>"$MODELFILE"
fi
cat >>"$MODELFILE" <<EOF
PARAMETER num_ctx ${NUM_CTX}
PARAMETER temperature 0.2
# MTP-тензоры встроены в GGUF: спекулятивный декодинг включается только явным значением
# (дока Modelfile: embedded MTP tensors require setting this parameter). 0 = выключить.
PARAMETER draft_num_predict ${DRAFT_TOKENS:-4}
EOF

echo "→ ollama create $TAG (num_ctx=${NUM_CTX}, vision=${VISION:-1})…"
ollama create "$TAG" -f "$MODELFILE" </dev/null || {
  echo "   Предупреждение: пересоздаю $TAG…" >&2
  ollama rm "$TAG" 2>/dev/null || true
  ollama create "$TAG" -f "$MODELFILE"
}

# ── FIM-вариант для автокомплита Continue ────────────────────────────────────────
# У tiel-coder НЕТ FIM-шаблона в Modelfile (Continue тогда не умеет автодополнение),
# но модель понимает <|fim_*|>-токены Qwen. Шаблон ниже — точная копия официального
# qwen2.5-coder: Continue по наличию {{.Suffix }} в /api/show сам включает FIM-режим.
# Это отдельный тег: чат/Executor остаётся на $TAG, autocomplete идёт на $FIM_TAG.
FIM_TAG="${FIM_TAG:-tiel-coder-fim:latest}"
FIM_MODELFILE="$GGUF_DIR/tiel-coder-fim.Modelfile"
cat >"$FIM_MODELFILE" <<EOF
# Генерируется infra/scripts/dev-ai/ollama-setup-tiel-coder.sh — не коммитится (каталог gitignored).
# Только автокомплит (FIM): чат-шаблон заменён на infill, ctx меньше, температура ниже.
FROM $TAG
TEMPLATE """{{- if .Suffix }}<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>
{{- else }}<|fim_prefix|>{{ .Prompt }}<|fim_middle|>
{{- end }}"""
PARAMETER num_ctx ${FIM_NUM_CTX:-8192}
PARAMETER temperature 0.1
PARAMETER stop "<|fim_suffix|>"
PARAMETER stop "<|endoftext|>"
PARAMETER num_predict 64
EOF

echo "→ ollama create $FIM_TAG (FIM-шаблон для автокомплита Continue)…"
ollama create "$FIM_TAG" -f "$FIM_MODELFILE" </dev/null || {
  echo "   Предупреждение: пересоздаю $FIM_TAG…" >&2
  ollama rm "$FIM_TAG" 2>/dev/null || true
  ollama create "$FIM_TAG" -f "$FIM_MODELFILE"
}

echo "→ Метаданные:"
ollama show "$TAG" | head -20
echo "→ FIM-шаблон виден клиенту:"
ollama show "$FIM_TAG" --modelfile | grep -A3 "TEMPLATE" | head -5

if [[ "${RUN_SMOKE:-0}" == "1" ]]; then
  echo "→ Тестовая генерация (грузит ~13 ГБ, минута-другая; под локом L-модели и замком инференса — OPS-33, OPS-59)…"
  python3 -I "$SCRIPT_DIR/ollama-locked.py" --who "setup $TAG" --wait 600 --model "$TAG" --large -- ollama run "$TAG" "Ответь одним словом: ok"
fi

echo ""
echo "Готово: $TAG + $FIM_TAG (автокомплит)"
echo "Чат/HR Gateway: модель появится как local/$TAG после обновления списка (reload окна)."
echo "Автокомплит Continue: запись пишет npm run llm-gateway:sync — модель из GW_CONTINUE_AUTOCOMPLETE"
echo "  (по умолчанию tiel-coder-fim:latest; задали свой FIM_TAG — укажите его и там)."
echo "Затем npm run llm-gateway:sync (проект шлюза) перегенерит клиентов."
