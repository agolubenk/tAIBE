// Сквозные проверки: настоящий HTTP-шлюз против фейковых OpenRouter и Ollama на случайных портах.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { createApp } from '../src/server.mjs'

const TOKEN = 'test-token'
const calls = []
let localActive = 0
let localMaxActive = 0
const STREAM_B = [
  ': OPENROUTER PROCESSING\n\n',
  'data: {"id":"1","choices":[{"delta":{"content":"Пр"}}]}\n\n',
  'data: {"id":"1","choices":[{"delta":{"content":"ивет 👋"}}]}\n\n',
  'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
]

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const readJson = async (req) => {
  let s = ''
  for await (const c of req) s += c
  return JSON.parse(s)
}

// OpenRouter: or1 упирается в лимит на всём; модель `bad-stream` шлёт ошибку первым чанком;
// `strict` отвечает 400 на любой запрос (ошибка запроса, не модели).
const openrouter = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/models') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ data: [{ id: 'good', context_length: 100000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }))
  }
  if (req.method === 'GET' && req.url === '/api/v1/key') return res.end(JSON.stringify({ data: { limit: null, usage: 0, is_free_tier: true } }))
  const body = await readJson(req)
  const key = req.headers.authorization
  calls.push({ key, model: body.model, stream: body.stream })
  if (key === 'Bearer k1') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' })
    return res.end(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }))
  }
  if (body.model === 'strict') {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { code: 400, message: 'messages: field required' } }))
  }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (body.model === 'bad-stream') return res.end(': x\n\ndata: {"error":{"code":502,"message":"provider down"}}\n\n')
    for (const c of STREAM_B) {
      res.write(c)
      await new Promise((r) => setTimeout(r, 5))
    }
    return res.end()
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `ok:${body.model}` }, finish_reason: 'stop' }], echo: body }))
})

const OLLAMA_CAPS = { 'loc:8k': ['completion', 'tools'], 'think:8k': ['completion', 'tools', 'thinking'], 'nomic-embed-text': ['embedding'] }
const ollama = createServer(async (req, res) => {
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: Object.entries(OLLAMA_CAPS).map(([name, capabilities]) => ({ name, capabilities })) }))
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
  const body = await readJson(req)
  // Как Ollama 0.40: рассуждения у модели без thinking — 400 до генерации.
  if (body.reasoning_effort && body.reasoning_effort !== 'none' && !OLLAMA_CAPS[body.model]?.includes('thinking')) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: `"${body.model}" does not support thinking`, type: 'invalid_request_error' } }))
  }
  localActive++
  localMaxActive = Math.max(localMaxActive, localActive)
  await new Promise((r) => setTimeout(r, 60))
  localActive--
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `local:${body.model}` }, finish_reason: 'stop' }], echo: body }))
})

let gw
let base
let olPortShared
before(async () => {
  const orPort = await listen(openrouter)
  olPortShared = await listen(ollama)
  const cfg = loadConfig({
    envFile: '/nonexistent',
    env: {
      GW_TOKEN: TOKEN,
      GW_PORT: '0',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${orPort}/api/v1`,
      OLLAMA_URL: `http://127.0.0.1:${olPortShared}`,
      OPENROUTER_KEY_1: 'k1',
      OPENROUTER_KEY_2: 'k2',
      OPENROUTER_RPM_1: '0',
      OPENROUTER_RPM_2: '0',
      GW_MIN_INTERVAL_MS: '0',
      GW_ALIAS_DUO: 'bad-stream,good',
      GW_STRATEGY: 'priority',
      GW_MAX_WAIT_MS: '2000',
      GW_OPENROUTER_FREE_ONLY: '0',
      // Машинный замок — во временной папке: тест не ждёт живой консилиум владельца и не пишет в ~/.local/state.
      GW_LOCAL_LOCK: join(mkdtempSync(join(tmpdir(), 'gw-test-')), 'ollama-local.lock'),
    },
  })
  gw = createApp(cfg, { persist: false })
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${gw.server.address().port}`
})
// before() упал — gw нет; серверы фейков всё равно закрыть, иначе процесс теста висит вечно.
after(() => {
  gw?.server.close()
  openrouter.close()
  ollama.close()
})

const post = (body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('ключ OpenRouter вместо токена — 401 с подсказкой, сам ключ в ответ не попадает', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer sk-or-v1-secretvalue' }, body: '{}' })
  assert.equal(r.status, 401)
  const text = await r.text()
  assert.match(text, /токен шлюза/)
  assert.doesNotMatch(text, /secretvalue/)
})

test('без токена — 401, health открыт', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })
  assert.equal(r.status, 401)
  assert.equal((await fetch(`${base}/health`)).status, 200)
})

test('ключ в лимите → тот же запрос уходит вторым ключом, тело не искажено', async () => {
  calls.length = 0
  const body = { model: 'good', messages: [{ role: 'user', content: 'Привет «мир»   🚀' }], temperature: 0.3, tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] }
  const r = await post(body)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-gateway-key'), 'or2')
  const j = await r.json()
  assert.deepEqual(j.echo, body, 'апстрим получил ровно то, что прислал клиент')
  assert.deepEqual(calls.map((c) => c.key), ['Bearer k1', 'Bearer k2'])
})

test('поток: ошибка в первом чанке → следующая модель пула; клиенту — байты апстрима один в один', async () => {
  const r = await post({ model: 'duo', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('x-gateway-model'), 'good')
  assert.equal(await r.text(), STREAM_B.join(''))
})

test('завышенный max_tokens срезается до GW_MAX_OUTPUT_TOKENS, остальное тело — как прислал клиент', async () => {
  const body = { model: 'good', max_tokens: 131_072, messages: [{ role: 'user', content: 'x' }] }
  const j = await (await post(body)).json()
  assert.equal(j.echo.max_tokens, 32_768)
  assert.deepEqual({ ...j.echo, max_tokens: body.max_tokens }, body)
})

test('ошибка самого запроса (400) — клиенту как есть, без ротации по моделям', async () => {
  calls.length = 0
  const r = await post({ model: 'strict', messages: [] })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error.message, /field required/)
  assert.equal(calls.filter((c) => c.key === 'Bearer k2').length, 1)
})

test('local/* — строго по одному запросу к Ollama, даже при параллельных клиентах', async () => {
  localMaxActive = 0
  const rs = await Promise.all([1, 2, 3].map(() => post({ model: 'local/loc:8k', messages: [{ role: 'user', content: 'x' }] })))
  for (const r of rs) {
    assert.equal(r.status, 200)
    assert.equal((await r.json()).choices[0].message.content, 'local:loc:8k')
  }
  assert.equal(localMaxActive, 1)
})

test('local: запрос openrouter-copilot (reasoning_effort max) — у модели без thinking рассуждения сняты, у thinking — как прислал', async () => {
  const ext = { messages: [{ role: 'user', content: 'x' }], include_reasoning: true, reasoning_effort: 'max' }
  const r = await post({ model: 'local/loc:8k', ...ext })
  assert.equal(r.status, 200)
  const plain = await r.json()
  assert.equal(plain.choices[0].message.content, 'local:loc:8k')
  assert.equal(plain.echo.reasoning_effort, undefined)
  assert.equal(plain.echo.include_reasoning, undefined)
  const r2 = await post({ model: 'local/think:8k', ...ext })
  assert.equal(r2.status, 200)
  assert.equal((await r2.json()).echo.reasoning_effort, 'max')
})

test('/v1/models: пулы, локальные модели (без эмбеддингов в чатовых), local/auto', async () => {
  const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const ids = (await r.json()).data.map((m) => m.id)
  for (const id of ['auto', 'free', 'cascade', 'duo', 'local/loc:8k', 'local/auto', 'local/code', 'local/fast']) assert.ok(ids.includes(id), id)
})

test('cascade: OpenRouter лежит (5xx) → запрос подхватывает GLM-контур', async () => {
  // Отдельный инстанс шлюза: «мёртвый» OpenRouter (503 на всё) и живой фейковый Z.AI.
  const deadOr = createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 503, message: 'provider down' } }))
  })
  const zai = createServer(async (req, res) => {
    const body = await readJson(req)
    calls.push({ key: req.headers.authorization, model: body.model, stream: false })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `glm:${body.model}` }, finish_reason: 'stop' }] }))
  })
  const orPort2 = await listen(deadOr)
  const zaiPort = await listen(zai)
  const cfg2 = loadConfig({
    envFile: '/nonexistent',
    env: {
      GW_TOKEN: TOKEN,
      GW_PORT: '0',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${orPort2}/api/v1`,
      OLLAMA_URL: `http://127.0.0.1:${olPortShared}`,
      OPENROUTER_KEY_1: 'k1',
      OPENROUTER_MODELS_1: 'a,b',
      OPENROUTER_RPM_1: '0',
      GW_MIN_INTERVAL_MS: '0',
      GW_STRATEGY: 'priority',
      GW_MAX_WAIT_MS: '2000',
      GW_OPENROUTER_FREE_ONLY: '0',
      GW_FALLBACK_LOCAL: '0',
      ZAI_CODING_KEY: 'zk',
      GLM_MODELS_CODING: 'glm-4.6',
      GLM_CODING_RPM: '0',
      ZAI_CODING_URL: `http://127.0.0.1:${zaiPort}/v4`,
    },
  })
  const gw2 = createApp(cfg2, { persist: false })
  await new Promise((r) => gw2.server.listen(0, '127.0.0.1', r))
  const base2 = `http://127.0.0.1:${gw2.server.address().port}`
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-gateway-provider'), 'glm', 'после отказов OpenRouter отвечает GLM')
    assert.equal(r.headers.get('x-gateway-model'), 'glm-4.6')
    const j = await r.json()
    assert.match(j.choices[0].message.content, /^glm:/)
    // Прямой glm-пул тоже идёт на Z.AI-контур с его ключом.
    const r2 = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r2.headers.get('x-gateway-key'), 'zai-coding')
  } finally {
    gw2.server.close()
    deadOr.close()
    zai.close()
  }
})

test('чужой Host (DNS rebinding) — отказ', async () => {
  const { request } = await import('node:http')
  const status = await new Promise((resolve) => {
    const u = new URL(base)
    const req = request({ host: u.hostname, port: u.port, path: '/v1/models', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } }, (res) => resolve(res.statusCode))
    req.end()
  })
  assert.equal(status, 421)
})

test('короткий 429 выбранной модели — шлюз ждёт её, а не подменяет запасной из пула free', async () => {
  const seen = []
  let flakyHits = 0
  const or3 = createServer(async (req, res) => {
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [] }))
    const body = await readJson(req)
    seen.push(body.model)
    if (body.model === 'flaky:free' && flakyHits++ === 0) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })
      return res.end(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: body.model }, finish_reason: 'stop' }] }))
  })
  const cfg3 = loadConfig({
    envFile: '/nonexistent',
    env: {
      GW_TOKEN: TOKEN,
      OPENROUTER_BASE_URL: `http://127.0.0.1:${await listen(or3)}/api/v1`,
      OPENROUTER_KEY_1: 'k1',
      OPENROUTER_MODELS_1: 'flaky:free,spare:free',
      OPENROUTER_RPM_1: '0',
      GW_MIN_INTERVAL_MS: '0',
      GW_MAX_WAIT_MS: '5000',
      GW_LOCAL: '0',
    },
  })
  const gw3 = createApp(cfg3, { persist: false })
  await new Promise((r) => gw3.server.listen(0, '127.0.0.1', r))
  try {
    const r = await fetch(`http://127.0.0.1:${gw3.server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'flaky:free', models: ['anthropic/claude-opus-4'], plugins: [{ id: 'web' }], messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-gateway-model'), 'flaky:free')
    assert.deepEqual(seen, ['flaky:free', 'flaky:free'])
  } finally {
    gw3.server.close()
    or3.close()
  }
})

test('всё на паузе — 429 с Retry-After до реальной готовности, апстрим не дёргается', async () => {
  const cfg4 = loadConfig({
    envFile: '/nonexistent',
    env: {
      GW_TOKEN: TOKEN,
      // Закрытый порт: любой запрос к апстриму дал бы сетевую ошибку, а не 429 шлюза.
      OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1',
      OPENROUTER_KEY_1: 'k1',
      OPENROUTER_MODELS_1: 'm:free',
      OPENROUTER_RPM_1: '0',
      GW_MIN_INTERVAL_MS: '0',
      GW_MAX_WAIT_MS: '300',
      GW_LOCAL: '0',
    },
  })
  const gw4 = createApp(cfg4, { persist: false })
  gw4.pool.keys[0].modelUntil.set('m:free', Date.now() + 90_000)
  await new Promise((r) => gw4.server.listen(0, '127.0.0.1', r))
  try {
    const r = await fetch(`http://127.0.0.1:${gw4.server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm:free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r.status, 429)
    const after = Number(r.headers.get('retry-after'))
    assert.ok(after >= 88 && after <= 90, `Retry-After ${after} — до снятия паузы, а не дефолтные 30`)
    assert.match((await r.json()).error.message, /освободится через \d+ с/)
  } finally {
    gw4.server.close()
  }
})

test('апстрим отказал 429 без заголовка — Retry-After 30 с: не 600 из-за GLM на паузе и не 1 с из-за непробованных моделей', async () => {
  const limited = createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 429, message: 'rate limited' } }))
  })
  const orPort = await listen(limited)
  const cfg5 = loadConfig({
    envFile: '/nonexistent',
    env: {
      GW_TOKEN: TOKEN,
      OPENROUTER_BASE_URL: `http://127.0.0.1:${orPort}/api/v1`,
      OPENROUTER_KEY_1: 'k1',
      OPENROUTER_MODELS_1: 'a,b,c,d,e,f',
      OPENROUTER_RPM_1: '0',
      GW_MIN_INTERVAL_MS: '0',
      GW_STRATEGY: 'priority',
      GW_MAX_WAIT_MS: '2000',
      GW_OPENROUTER_FREE_ONLY: '0',
      GW_FALLBACK_LOCAL: '0',
      GW_LOCAL: '0',
      ZAI_CODING_KEY: 'zk',
      GLM_MODELS_CODING: 'glm-4.6',
      GLM_CODING_RPM: '0',
      ZAI_CODING_URL: 'http://127.0.0.1:9/v4',
    },
  })
  const gw5 = createApp(cfg5, { persist: false })
  gw5.pool.keys.find((k) => k.upstream?.kind === 'glm').until = Date.now() + 600_000
  await new Promise((r) => gw5.server.listen(0, '127.0.0.1', r))
  try {
    const r = await fetch(`http://127.0.0.1:${gw5.server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(r.status, 429)
    const after = Number(r.headers.get('retry-after'))
    // Лимит OpenRouter общий на аккаунт: d–f каскад не пробовал (пропуск провайдера после 3 отказов), но и они на лимите.
    assert.equal(after, 30, `Retry-After ${after}: GLM на 10 мин не в счёт, непробованные модели — не повод для 1 с`)
  } finally {
    gw5.server.close()
    limited.close()
  }
})
