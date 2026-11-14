// HTTP-вход шлюза: OpenAI-совместимые /v1/chat/completions, /v1/completions, /v1/embeddings, /v1/models,
// плюс /health и /stats. Слушает только loopback и требует токен клиента.
import { createServer } from 'node:http'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, STATE_DIR, maskKey } from './config.mjs'
import { KeyPool } from './keypool.mjs'
import { Discovery } from './discovery.mjs'
import { Router, localContext, LOCAL_TIERS } from './router.mjs'
import { Proxy } from './proxy.mjs'

const LOG_MAX_BYTES = 5 * 1024 * 1024

export function jsonlLogger(file) {
  mkdirSync(STATE_DIR, { recursive: true })
  return (entry) => {
    try {
      if (statSync(file, { throwIfNoEntry: false })?.size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
    } catch {
      /* лог — не повод ронять запрос */
    }
  }
}

// Путь клиента → путь апстрима. VS Code может дописать /chat/completions к базе — смотрим по суффиксу.
export function routePath(method, url) {
  const p = url.split('?')[0].replace(/\/+$/, '') || '/'
  if (method === 'GET') {
    if (p === '/health' || p === '/stats') return p
    if (p.endsWith('/models')) return '/models'
    return null
  }
  if (method !== 'POST') return null
  if (p.endsWith('/chat/completions')) return '/chat/completions'
  if (p.endsWith('/completions')) return '/completions'
  if (p.endsWith('/embeddings')) return '/embeddings'
  if (p === '/v1' || p === '/') return '/chat/completions'
  return null
}

function tokenOk(req, token) {
  const h = req.headers.authorization || ''
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-api-key'] || '')
  const a = Buffer.from(got)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Клиент, переключённый на шлюз со старым ключом OpenRouter (расширение OpenRouter for Copilot), должен увидеть,
// что делать, а не «нужен токен». Сам ключ в ответ и в журнал не попадает — только факт префикса.
function authHint(req) {
  const h = String(req.headers.authorization || req.headers['x-api-key'] || '')
  return /^(Bearer\s+)?sk-or-/i.test(h)
    ? 'gateway: пришёл ключ OpenRouter, а нужен токен шлюза — pbcopy < infra/llm-gateway/.state/token, затем «OpenRouter: Set API Key»'
    : 'gateway: нужен токен шлюза (Authorization: Bearer …). Continue: npm run llm-gateway:sync пишет его в .continue/.env'
      + ' (LLM_GATEWAY_TOKEN), затем перезагрузите окно; файл токена — infra/llm-gateway/.state/token'
}

// Защита от DNS rebinding: чужой домен, указывающий на 127.0.0.1, приходит со своим Host.
const hostOk = (req) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '')

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('тело запроса больше лимита'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

export function modelList(app) {
  const { cfg, pool, router, discovery } = app
  const seen = new Set()
  const out = []
  const add = (id, extra = {}) => {
    if (seen.has(id)) return
    seen.add(id)
    const m = discovery.catalog.get(id)
    out.push({ id, object: 'model', owned_by: extra.owned_by || 'openrouter', created: 0, context_length: m?.context || extra.context || null, ...extra })
  }
  for (const name of router.poolNames()) add(name, { owned_by: 'gateway', pool: (router.poolModels(name) || []).filter((id) => router.servable(id)) })
  for (const id of pool.configuredModels().filter((x) => router.servable(x))) add(id)
  for (const id of pool.modelsOf('glm')) add(id, { owned_by: 'zai' })
  if (cfg.localEnabled) {
    for (const m of discovery.local.models.filter((x) => x.chat || x.embedding)) {
      add(`local/${m.name}`, { owned_by: 'ollama', context: localContext(discovery, m.name), modelContext: m.context, loaded: discovery.local.loaded.includes(m.name), embedding: m.embedding })
    }
    if (discovery.local.models.some((m) => m.chat)) {
      add('local/auto', { owned_by: 'gateway' })
      for (const tier of LOCAL_TIERS) add(`local/${tier}`, { owned_by: 'gateway', pool: router.localTierModels(tier, {}) })
    }
  }
  return out
}

export function stats(app) {
  const { cfg, pool, discovery, proxy } = app
  return {
    uptimeS: Math.round(process.uptime()),
    strategy: cfg.strategy,
    keys: pool.snapshot().map((k) => ({ ...k, masked: maskKey(cfg.keys.find((x) => x.id === k.id).key), info: discovery.keyInfo.get(k.id) || null })),
    aliases: cfg.aliases,
    catalog: { models: discovery.catalog.size, ageS: discovery.catalogAt ? Math.round((Date.now() - discovery.catalogAt) / 1000) : null, error: discovery.catalogError || null },
    local: { url: cfg.ollamaUrl, enabled: cfg.localEnabled, loaded: discovery.local.loaded, models: discovery.local.models.map((m) => m.name), error: discovery.local.error },
    queue: { remoteActive: proxy.remote.active, remoteWaiting: proxy.remote.waiting, localActive: proxy.local.active, localWaiting: proxy.local.waiting },
    counters: proxy.stats,
  }
}

export function createApp(cfg, { fetchImpl = fetch, persist = true } = {}) {
  const pool = new KeyPool(cfg.keys, { minIntervalMs: cfg.minIntervalMs })
  const discovery = new Discovery(cfg, { fetchImpl, persist })
  const router = new Router(cfg, pool, discovery)
  const log = persist ? jsonlLogger(join(STATE_DIR, 'requests.jsonl')) : () => {}
  const proxy = new Proxy({ cfg, pool, router, discovery, log, fetchImpl })
  const app = { cfg, pool, discovery, router, proxy }

  app.server = createServer(async (req, res) => {
    res.on('error', () => {})
    if (!hostOk(req)) return sendJson(res, 421, { error: { message: 'gateway: только localhost' } })
    const path = routePath(req.method, req.url || '/')
    if (path === '/health') return sendJson(res, 200, { ok: true, keys: pool.size, local: !discovery.local.error && discovery.local.models.length > 0 })
    if (!path) return sendJson(res, 404, { error: { message: `gateway: нет маршрута ${req.method} ${req.url}` } })
    if (!tokenOk(req, cfg.token)) return sendJson(res, 401, { error: { message: authHint(req), type: 'auth' } })
    try {
      if (path === '/models') {
        await Promise.all([discovery.refreshCatalog(), discovery.refreshLocal()])
        return sendJson(res, 200, { object: 'list', data: modelList(app) })
      }
      if (path === '/stats') {
        await discovery.refreshLocal()
        return sendJson(res, 200, stats(app))
      }
      const raw = await readBody(req, cfg.maxBodyBytes)
      let body
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return sendJson(res, 400, { error: { message: 'gateway: тело не JSON' } })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: { message: 'gateway: ожидается JSON-объект' } })
      const ac = new AbortController()
      res.on('close', () => !res.writableFinished && ac.abort())
      await proxy.handle({ path, body, bytes: raw.length, res, signal: ac.signal, reqId: randomUUID().slice(0, 8) })
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: { message: `gateway: ${err.message}` } })
      else res.end()
    }
  })
  // Длинные генерации: не рвать сокет по дефолтным таймаутам Node.
  app.server.requestTimeout = 0
  app.server.headersTimeout = 60_000
  app.server.keepAliveTimeout = 65_000
  return app
}

export async function start(cfg = loadConfig()) {
  const app = createApp(cfg)
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(cfg.port, cfg.host, resolve)
  })
  // Каталог и ключи — в фоне: старт не ждёт сети.
  app.discovery.refreshCatalog().catch(() => {})
  app.discovery.refreshLocal().catch(() => {})
  app.discovery.refreshKeyInfo(cfg.keys).catch(() => {})
  const timer = setInterval(() => {
    app.discovery.refreshCatalog().catch(() => {})
    app.discovery.refreshKeyInfo(cfg.keys).catch(() => {})
  }, 10 * 60_000)
  timer.unref()
  const ids = cfg.keys.map((k) => `${k.id}(${k.models.length || 'любые'} мод., ${k.rpm} rpm)`).join(', ') || 'нет'
  console.log(`[llm-gateway] http://${cfg.host}:${cfg.port}/v1 · ключи: ${ids} · пулы: ${['auto', 'free', ...Object.keys(cfg.aliases)].join(', ')} · Ollama: ${cfg.localEnabled ? cfg.ollamaUrl : 'выкл'} · замок: ${cfg.localLock ? `${cfg.localLock} (${cfg.python})` : 'выкл'}`)
  return app
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  start().catch((err) => {
    console.error(`[llm-gateway] не стартовал: ${err.message}`)
    process.exit(1)
  })
}
