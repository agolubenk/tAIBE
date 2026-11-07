// Конфиг шлюза: .env рядом с пакетом (gitignored) + переменные процесса (они главнее).
// Ключи и модели — OPENROUTER_KEY_<n> / OPENROUTER_MODELS_<n> / OPENROUTER_RPM_<n>, n = 1..9;
// GLM (Z.AI) — ZAI_CODING_KEY / GLM_MODELS_CODING и ZAI_GENERAL_KEY / GLM_MODELS_GENERAL.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACHINE_LOCK } from './machine-lock.mjs'

export const CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
// Данные (.env, .state) — всегда в основной папке репо, даже если код запущен из worktree:
// иначе ключи пропали бы вместе с удалённым worktree.
const wt = CODE_DIR.indexOf('/worktrees/')
export const PKG_DIR = process.env.GW_HOME || (wt >= 0 ? join(CODE_DIR.slice(0, wt), 'infra/llm-gateway') : CODE_DIR)
export const REPO_ROOT = join(PKG_DIR, '..', '..')
export const STATE_DIR = process.env.GW_STATE_DIR || join(PKG_DIR, '.state')

export function parseDotenv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    } else {
      const hash = val.search(/\s#/)
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    out[key] = val
  }
  return out
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)
const int = (v, def) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : def
}
// Интерпретатор держателя машинного замка — абсолютным путём один раз на старте, а не `python3` из PATH: под голым
// PATH launchd это шим xcrun `/usr/bin/python3` (вдвое медленнее, а запрос лицензии Xcode дал бы 503 на каждый
// локальный вызов), а npm ставит перед ним свои `node_modules/.bin`.
const PYTHONS = ['/Library/Frameworks/Python.framework/Versions/Current/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
export const findPython = (candidates = PYTHONS) => candidates.find((p) => existsSync(p)) || 'python3'

const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v))

// Токен клиентов: без него любой сайт в браузере мог бы слать POST на localhost и тратить ключи.
function ensureToken(env) {
  if (env.GW_TOKEN) return env.GW_TOKEN
  const file = join(STATE_DIR, 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(STATE_DIR, { recursive: true })
  const token = `gw-${randomBytes(18).toString('base64url')}`
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

export function loadConfig({ envFile = join(PKG_DIR, '.env'), env = process.env } = {}) {
  const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')) : {}
  const e = { ...fileEnv, ...pick(env) }

  const keys = []
  for (let n = 1; n <= 9; n++) {
    const key = e[`OPENROUTER_KEY_${n}`]
    if (!key) continue
    keys.push({
      id: `or${n}`,
      key,
      models: list(e[`OPENROUTER_MODELS_${n}`]),
      rpm: int(e[`OPENROUTER_RPM_${n}`], int(e.GW_DEFAULT_RPM, 20)),
      upstream: { kind: 'openrouter', url: (e.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '') },
    })
  }
  // GLM (Z.AI) — два биллинговых контура одного провайдера, смешивать нельзя (правило
  // .continue/rules/04-model-rotation.md): Coding — подписка (плата за вызов), General —
  // кошелёк (плата за токен). Каждый контур = отдельный ключ шлюза со своим upstream-URL.
  if (e.ZAI_CODING_KEY) {
    const codingModels = list(e.GLM_MODELS_CODING)
    keys.push({
      id: 'zai-coding',
      key: e.ZAI_CODING_KEY,
      // Пустой список в пуле означал бы «любая модель» — для Z.AI это неприемлемо, всегда дефолт-лестница.
      models: codingModels.length ? codingModels : ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.2'],
      rpm: int(e.GLM_CODING_RPM, 20),
      upstream: { kind: 'glm', url: (e.ZAI_CODING_URL || 'https://api.z.ai/api/coding/paas/v4').replace(/\/$/, '') },
    })
  }
  if (e.ZAI_GENERAL_KEY && list(e.GLM_MODELS_GENERAL).length) {
    // General = реальные деньги за токены, поэтому ключ добавляется ТОЛЬКО с явным списком моделей
    // (пустой список в пуле означал бы «любая модель» — OpenRouter-модели ушли бы на Z.AI-ключ).
    // Бесплатный glm-4.7-flash проверен рабочим 2026-10-29.
    keys.push({
      id: 'zai-general',
      key: e.ZAI_GENERAL_KEY,
      models: list(e.GLM_MODELS_GENERAL),
      rpm: int(e.GLM_GENERAL_RPM, 20),
      upstream: { kind: 'glm', url: (e.ZAI_GENERAL_URL || 'https://api.z.ai/api/paas/v4').replace(/\/$/, '') },
    })
  }

  const aliases = {}
  for (const [k, v] of Object.entries(e)) {
    const m = /^GW_ALIAS_([A-Z0-9_]+)$/.exec(k)
    if (m && list(v).length) aliases[m[1].toLowerCase().replace(/_/g, '-')] = list(v)
  }

  const host = e.GW_HOST || '127.0.0.1'
  // Шлюз тратит чужие ключи по одному токену — наружу его не выставляем ни при какой настройке.
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error(`GW_HOST=${host}: шлюз слушает только loopback`)

  return {
    host,
    port: int(e.GW_PORT, 8789),
    token: ensureToken(e),
    keys,
    aliases,
    openrouterUrl: (e.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    ollamaUrl: (e.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    localEnabled: bool(e.GW_LOCAL, true),
    localDefault: e.GW_LOCAL_DEFAULT || '',
    localExclude: list(e.GW_LOCAL_EXCLUDE || 'embed,nomic,minicpm-o'),
    // Потолок окна локальной модели без num_ctx в Modelfile — держать не выше OLLAMA_CONTEXT_LENGTH сервера.
    localMaxContext: int(e.GW_LOCAL_MAX_CONTEXT, 32_768),
    // Тиры локальной ротации: явные списки из .env или авто-определение по имени/размеру/окну.
    localTiers: {
      code: list(e.GW_LOCAL_CODE),
      reason: list(e.GW_LOCAL_REASON),
      long: list(e.GW_LOCAL_LONG),
      fast: list(e.GW_LOCAL_FAST),
    },
    fallbackLocal: bool(e.GW_FALLBACK_LOCAL, true),
    // OpenRouter — только бесплатные: платная модель не уходит в апстрим ни из пула, ни прямым выбором.
    // Причина — 402 «requires more credits» 2026-10-29: клиент молча подменил пропавшую free-модель платной.
    openrouterFreeOnly: bool(e.GW_OPENROUTER_FREE_ONLY, true),
    // Потолок max_tokens для OpenRouter: клиент просит «до 131072», и OpenRouter резервирует кредиты под весь объём.
    maxOutputTokens: int(e.GW_MAX_OUTPUT_TOKENS, 32_768),
    // Локальные роли ассистента Continue — напрямую в Ollama, мимо шлюза: автокомплит FIM и эмбеддинги.
    continueAutocomplete: e.GW_CONTINUE_AUTOCOMPLETE ?? 'tiel-coder-fim:latest',
    continueEmbed: e.GW_CONTINUE_EMBED ?? 'nomic-embed-text:latest',
    strategy: e.GW_STRATEGY === 'priority' ? 'priority' : 'roundrobin',
    autoFreeCount: int(e.GW_AUTO_FREE_COUNT, 8),
    localMaxWaitMs: int(e.GW_LOCAL_MAX_WAIT_MS, 180_000),
    // Машинный замок локального инференса, общий с консилиумом (OPS-27). `off` — только семафор процесса.
    localLock: e.GW_LOCAL_LOCK === 'off' ? '' : e.GW_LOCAL_LOCK || MACHINE_LOCK,
    python: e.GW_PYTHON || findPython(),
    streamCommitMs: int(e.GW_STREAM_COMMIT_MS, 8_000),
    maxAttempts: int(e.GW_MAX_ATTEMPTS, 8),
    maxWaitMs: int(e.GW_MAX_WAIT_MS, 45_000),
    // Каскад OR → GLM → local: сколько подряд отказов провайдера пропускают его остаток.
    providerSkipAfter: int(e.GW_PROVIDER_SKIP_AFTER, 3),
    maxConcurrency: int(e.GW_MAX_CONCURRENCY, 4),
    minIntervalMs: int(e.GW_MIN_INTERVAL_MS, 1_000),
    firstByteTimeoutMs: int(e.GW_FIRST_BYTE_TIMEOUT_MS, 120_000),
    requestTimeoutMs: int(e.GW_REQUEST_TIMEOUT_MS, 600_000),
    maxBodyBytes: int(e.GW_MAX_BODY_MB, 32) * 1024 * 1024,
    referer: e.GW_REFERER || 'http://localhost/hr-helper-dev',
    title: e.GW_TITLE || 'HR Helper dev gateway',
  }
}

// Из окружения процесса берём только свои переменные: чужие (PATH и пр.) конфигу не нужны.
function pick(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^(GW_|OPENROUTER_|OLLAMA_URL$|ZAI_|GLM_)/.test(k) && v !== undefined) out[k] = v
  }
  return out
}

export const maskKey = (key) => (key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : '…')
