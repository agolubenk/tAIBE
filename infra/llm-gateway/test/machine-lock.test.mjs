// OPS-27: шлюз и консилиум делят один машинный замок локального инференса. Настоящий шлюз против фейковой Ollama;
// «консилиум» — настоящий `ollama.local_inference_slot` из infra/ai-council в отдельном python3 на том же файле.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { createApp } from '../src/server.mjs'
import { MACHINE_LOCK, acquireMachineLock } from '../src/machine-lock.mjs'

const TOKEN = 'test-token'
const COUNCIL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai-council')
const dir = mkdtempSync(join(tmpdir(), 'gw-lock-'))
const LOCK = join(dir, 'ollama-local.lock')

// Пик одновременных инференсов на Mac: фейковая Ollama (шлюз) и «инференс» консилиума пишут в один счётчик.
let active = 0
let peak = 0
const enter = () => {
  active++
  peak = Math.max(peak, active)
}
const leave = () => active--

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const ollama = createServer(async (req, res) => {
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'loc:8k', capabilities: ['completion'] }] }))
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
  for await (const _ of req);
  // Инференс — только чат; /api/show и прочее от discovery — без генерации, в счётчик не идут.
  if (!req.url.includes('chat')) return res.end(JSON.stringify({}))
  enter()
  await new Promise((r) => setTimeout(r, 80))
  leave()
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local' }, finish_reason: 'stop' }] }))
})

// Консилиум держит слот holdMs. «in» — слот взят, «out» — сейчас отпустит.
function council(holdMs, wait = 30) {
  const code = `import sys, time\nsys.path.insert(0, ${JSON.stringify(COUNCIL)})\nimport ollama\nwith ollama.local_inference_slot(${wait}):\n    print("in", flush=True)\n    time.sleep(${holdMs / 1000})\n    print("out", flush=True)\n`
  const child = spawn('python3', ['-I', '-c', code], { env: { ...process.env, AI_COUNCIL_LOCAL_LOCK: LOCK }, stdio: ['ignore', 'pipe', 'inherit'] })
  const lines = []
  const waiters = []
  child.stdout.on('data', (d) => {
    for (const l of String(d).split('\n').filter(Boolean)) {
      if (l === 'in') enter()
      if (l === 'out') leave()
      lines.push(l)
      waiters.splice(0).forEach((w) => w())
    }
  })
  const seen = (l) => new Promise((r) => (lines.includes(l) ? r() : waiters.push(() => lines.includes(l) && r())))
  return { child, seen, exited: new Promise((r) => child.on('exit', r)) }
}

let gw
let base
let olPort
const makeGw = async (env = {}) => {
  const cfg = loadConfig({
    envFile: '/nonexistent',
    env: { GW_TOKEN: TOKEN, GW_PORT: '0', OLLAMA_URL: `http://127.0.0.1:${olPort}`, GW_LOCAL_LOCK: LOCK, ...env },
  })
  const app = createApp(cfg, { persist: false })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  return app
}
before(async () => {
  olPort = await listen(ollama)
  gw = await makeGw()
  base = `http://127.0.0.1:${gw.server.address().port}`
})
after(() => {
  gw?.server.close()
  ollama.close()
  rmSync(dir, { recursive: true, force: true })
})

const ask = (url = base) =>
  fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'local/loc:8k', messages: [{ role: 'user', content: 'x' }] }),
  })

test('путь замка по умолчанию — тот же, что у консилиума (MACHINE_LOCK_REL в ollama.py)', () => {
  assert.ok(MACHINE_LOCK.endsWith(join('.local', 'state', 'taibe', 'council', 'ollama-local.lock')))
  assert.equal(loadConfig({ envFile: '/nonexistent', env: {} }).localLock, MACHINE_LOCK)
  assert.equal(loadConfig({ envFile: '/nonexistent', env: { GW_LOCAL_LOCK: 'off' } }).localLock, '')
})

test('шлюз и консилиум одновременно — пик локальных инференсов 1, запрос шлюза дожидается слота', async () => {
  peak = 0
  const c = council(400)
  await c.seen('in')
  const started = Date.now()
  const rs = await Promise.all([ask(), ask()])
  for (const r of rs) assert.equal(r.status, 200)
  assert.ok(Date.now() - started >= 250, 'шлюз ждал, пока консилиум отпустит замок')
  await c.exited
  assert.equal(peak, 1)
})

test('kill -9 держателя освобождает замок: шлюз получает слот сразу', async () => {
  const c = council(60_000)
  await c.seen('in')
  leave() // «инференс» консилиума оборвётся вместе с процессом
  c.child.kill('SIGKILL')
  await c.exited
  const started = Date.now()
  assert.equal((await ask()).status, 200)
  assert.ok(Date.now() - started < 2_000)
})

test('замок занят дольше GW_LOCAL_MAX_WAIT_MS — 503 с причиной, Ollama не вызвана', async () => {
  const short = await makeGw({ GW_LOCAL_MAX_WAIT_MS: '300' })
  peak = 0
  const c = council(3_000)
  try {
    await c.seen('in')
    const r = await ask(`http://127.0.0.1:${short.server.address().port}`)
    assert.equal(r.status, 503)
    assert.match((await r.json()).error.message, /консилиум/)
    assert.equal(peak, 1)
  } finally {
    c.child.kill('SIGKILL')
    await c.exited
    leave()
    short.server.close()
  }
})

test('держатель замка шлюза умер посреди вызова — onLost, замок свободен', async () => {
  let child
  const spawnImpl = (...a) => (child = spawn(...a))
  const lock = await acquireMachineLock({ path: LOCK, waitMs: 1_000, spawnImpl })
  assert.ok(lock.held)
  const lost = new Promise((r) => lock.onLost(r))
  const blocked = council(10, 0.3) // пока держит шлюз — консилиум не попадёт
  assert.notEqual(await blocked.exited, 0)
  child.kill('SIGKILL')
  await lost
  const c = council(10, 2)
  assert.equal(await c.exited, 0, 'после смерти держателя консилиум берёт замок')
  lock.release() // после потери — без эффекта
})

test('штатный release — не потеря, замок свободен для следующего', async () => {
  const lock = await acquireMachineLock({ path: LOCK, waitMs: 1_000 })
  let lost = false
  lock.onLost(() => (lost = true))
  lock.release()
  const again = await acquireMachineLock({ path: LOCK, waitMs: 2_000 })
  assert.ok(again.held)
  again.release()
  assert.equal(lost, false)
})

test('нет python3 — failed, а не исключение и не зависание', async () => {
  const r = await acquireMachineLock({ path: LOCK, waitMs: 100, python: '/nonexistent/python3' })
  assert.ok(r.failed)
})

test('клиент ушёл, пока ждал замок — busy, держатель снят', async () => {
  const c = council(1_000)
  await c.seen('in')
  const ac = new AbortController()
  const p = acquireMachineLock({ path: LOCK, waitMs: 5_000, signal: ac.signal })
  setTimeout(() => ac.abort(), 100)
  assert.deepEqual(await p, { busy: true })
  await c.exited
})
