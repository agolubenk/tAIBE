// OPS-59: шлюз и прогрев грузят L-модель только под машинным локом L-модели консилиума (OPS-29). Настоящий шлюз
// против фейковой Ollama; «консилиум» — настоящий `ollama.machine_model_slot` / `local_inference_slot` из
// infra/ai-council в отдельном python3 на тех же файлах.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { councilLargeTier, loadConfig } from '../src/config.mjs'
import { createApp } from '../src/server.mjs'
import { MACHINE_LOCK } from '../src/machine-lock.mjs'

const TOKEN = 'test-token'
const HERE = dirname(fileURLToPath(import.meta.url))
const COUNCIL = join(HERE, '..', '..', 'ai-council')
const LOCKED = join(HERE, '..', '..', 'scripts', 'dev-ai', 'ollama-locked.py')
const dir = mkdtempSync(join(tmpdir(), 'gw-large-'))
const LOCK = join(dir, 'ollama-local.lock')
const GIB = 2 ** 30

// big:1 — L по списку (GW_LOCAL_LARGE), huge:1 — L по размеру (10 ГиБ ≥ порога 9), loc:8k — S.
const TAGS = [
  { name: 'loc:8k', size: 4 * GIB },
  { name: 'big:1', size: 1 * GIB },
  { name: 'huge:1', size: 10 * GIB },
].map((m) => ({ ...m, capabilities: ['completion'] }))
let calls = []
let active = 0
let peak = 0
let delayMs = 80
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const ollama = createServer(async (req, res) => {
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: TAGS }))
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
  let body = ''
  for await (const d of req) body += d
  if (!req.url.includes('chat')) return res.end(JSON.stringify({}))
  const model = JSON.parse(body || '{}').model
  calls.push(model)
  active++
  peak = Math.max(peak, active)
  await new Promise((r) => setTimeout(r, delayMs))
  active--
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: model }, finish_reason: 'stop' }] }))
})

// Процесс консилиума или прогрева: печатает «in», когда взял свои замки, и «out» перед тем, как их отпустить.
function proc(args, env = {}) {
  const child = spawn('python3', ['-I', ...args], { env: { ...process.env, AI_COUNCIL_LOCAL_LOCK: LOCK, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  const waiters = []
  child.stdout.on('data', (d) => {
    out += d
    waiters.splice(0).forEach((w) => w())
  })
  child.stderr.on('data', (d) => (err += d))
  const seen = (s) => new Promise((r) => (out.includes(s) ? r() : waiters.push(() => out.includes(s) && r())))
  return { child, seen, done: new Promise((r) => child.on('exit', (code) => r({ code, out, err }))) }
}
// Блок large_model консилиума: лок L-модели на весь блок; `inner` — ещё и лок инференса внутри (порядок консилиума).
const council = (holdMs, { model = 'big:1', inner = false, wait = 30 } = {}) => {
  const body = inner
    ? `    with ollama.local_inference_slot(${wait}):\n        print("in", flush=True)\n        time.sleep(${holdMs / 1000})\n        print("out", flush=True)\n`
    : `    print("in", flush=True)\n    time.sleep(${holdMs / 1000})\n    print("out", flush=True)\n`
  const code = `import sys, time\nsys.path.insert(0, ${JSON.stringify(COUNCIL)})\nimport ollama\nwith ollama.machine_model_slot(${JSON.stringify(model)}, "w1", ${wait}):\n${body}`
  return proc(['-c', code])
}
const locked = (args) => proc([LOCKED, ...args])

const apps = []
const makeGw = async (env = {}) => {
  const cfg = loadConfig({
    envFile: '/nonexistent',
    env: { GW_TOKEN: TOKEN, GW_PORT: '0', OLLAMA_URL: `http://127.0.0.1:${olPort}`, GW_LOCAL_LOCK: LOCK, GW_LOCAL_LARGE: 'big:1', ...env },
  })
  const app = createApp(cfg, { persist: false })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  apps.push(app)
  return `http://127.0.0.1:${app.server.address().port}`
}
let olPort
let base
before(async () => {
  olPort = await listen(ollama)
  base = await makeGw()
})
after(() => {
  apps.forEach((a) => a.server.close())
  ollama.close()
  rmSync(dir, { recursive: true, force: true })
})
const reset = () => {
  calls = []
  peak = 0
  delayMs = 80
}
const ask = (model, url = base) =>
  fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `local/${model}`, messages: [{ role: 'user', content: 'x' }] }),
  })

test('L-тир шлюза читается из config.toml консилиума: список [models.large] и порог', () => {
  const live = councilLargeTier()
  assert.ok(live.models.includes('tiel-coder:35b-a3b-iq3s'), `в списке: ${live.models}`)
  assert.equal(live.thresholdGb, 9)
  const fx = join(dir, 'c.toml')
  const text = '[models]\nlarge_threshold_gb = 7.5 # комментарий\n# "x:1" = 1\n[models.large]\n# Tiel\n"a:1" = 13.1\nb = 2\n[models.roles.fast]\n"c:1" = "d"\n'
  writeFileSync(fx, text)
  assert.deepEqual(councilLargeTier(fx), { models: ['a:1', 'b'], thresholdGb: 7.5 })
  assert.deepEqual(councilLargeTier(join(dir, 'нет.toml')), { models: [], thresholdGb: 9 })
  const cfg = loadConfig({ envFile: '/nonexistent', env: { GW_TOKEN: 't', GW_COUNCIL_CONFIG: fx } })
  assert.deepEqual([cfg.localLarge, cfg.localLargeGb], [['a:1', 'b'], 7.5])
})

test('файл лока L-модели — рядом с замком инференса, как MACHINE_MODEL_LOCK в ollama.py; без замка — нет и его', () => {
  const def = loadConfig({ envFile: '/nonexistent', env: { GW_TOKEN: 't' } })
  assert.equal(def.localLargeLock, join(dirname(MACHINE_LOCK), 'large-model.lock'))
  assert.equal(loadConfig({ envFile: '/nonexistent', env: { GW_TOKEN: 't', GW_LOCAL_LOCK: LOCK } }).localLargeLock, join(dir, 'large-model.lock'))
  assert.equal(loadConfig({ envFile: '/nonexistent', env: { GW_TOKEN: 't', GW_LOCAL_LOCK: 'off' } }).localLargeLock, '')
})

test('консилиум держит блок large_model — запрос шлюза на L-модель ждёт конца блока, на S-модель идёт сразу', async () => {
  reset()
  const c = council(1_500)
  await c.seen('in')
  const t0 = Date.now()
  const large = ask('big:1').then((r) => ({ status: r.status, ms: Date.now() - t0 }))
  const small = await ask('loc:8k')
  assert.equal(small.status, 200)
  assert.ok(Date.now() - t0 < 1_000, `S-модель ждала ${Date.now() - t0} мс — лок L-модели ей не нужен`)
  assert.deepEqual(calls, ['loc:8k'], 'L-модель не вызвана, пока блок консилиума идёт')
  const r = await large
  assert.equal(r.status, 200)
  assert.ok(r.ms >= 1_200, `L-модель дождалась конца блока: ${r.ms} мс`)
  assert.equal((await c.done).code, 0)
  assert.deepEqual(calls, ['loc:8k', 'big:1'])
})

test('лок L-модели занят дольше GW_LOCAL_MAX_WAIT_MS — 503 называет держателя; L по размеру тоже под локом', async () => {
  reset()
  const short = await makeGw({ GW_LOCAL_MAX_WAIT_MS: '300' })
  const c = council(3_000)
  try {
    await c.seen('in')
    for (const model of ['big:1', 'huge:1']) {
      const r = await ask(model, short)
      assert.equal(r.status, 503)
      const msg = (await r.json()).error.message
      assert.match(msg, new RegExp(`лок L-модели \\(${model}\\) занят другим процессом на этом Mac дольше 0\\.3 с: pid \\d+ \\(council w1 big:1\\)$`))
    }
    assert.deepEqual(calls, [], 'Ollama не вызвана')
  } finally {
    c.child.kill('SIGKILL')
    await c.done
  }
})

test('порядок замков один: шлюз (L-модель) и блок консилиума (лок L-модели, внутри — инференс) — без взаимной блокировки, пик 1', async () => {
  reset()
  delayMs = 400
  const first = ask('big:1')
  while (!calls.length) await new Promise((r) => setTimeout(r, 10))
  const c = council(300, { model: 'other:1', inner: true, wait: 10 })
  const s = proc(['-c', `import sys, time\nsys.path.insert(0, ${JSON.stringify(COUNCIL)})\nimport ollama\nwith ollama.local_inference_slot(10):\n    print("in", flush=True)\n`])
  assert.equal((await first).status, 200)
  const [cc, ss] = await Promise.all([c.done, s.done])
  assert.equal(cc.code, 0, cc.err)
  assert.equal(ss.code, 0, ss.err)
  assert.equal(peak, 1)
})

test('прогрев L-модели (ollama-locked.py --model/--large) ждёт блок консилиума: 75 и держатель; шлюз видит «warmup»', async () => {
  reset()
  const c = council(1_500)
  await c.seen('in')
  const busy = await locked(['--who', 'warmup tiel-coder:35b-a3b-iq3s', '--wait', '0.3', '--model', 'tiel-coder:35b-a3b-iq3s', '--', 'python3', '-c', 'print("ran")']).done
  assert.equal(busy.code, 75)
  assert.match(busy.err, /модельный лок под tiel-coder:35b-a3b-iq3s занят другим процессом дольше 0\.3 с: .*council w1 big:1/)
  assert.doesNotMatch(busy.out, /ran/)
  const forced = await locked(['--wait', '0.3', '--large', '--', 'python3', '-c', 'print("ran")']).done
  assert.equal(forced.code, 75, '--large без --model — тоже под локом L-модели')
  // S-модель (её нет в [models.large], размер 0) — только замок инференса, блок консилиума ей не мешает.
  const small = await locked(['--wait', '0.3', '--model', 'loc:8k', '--', 'python3', '-c', 'print("ran")']).done
  assert.equal(small.code, 0, small.err)
  // Конфиг консилиума не читается (неверный TAIBE_HOST_ROOT — HostRootError на импорте): L-тир только по размеру,
  // команда идёт, а не падает (линза boards, #268).
  const noCfg = await proc([LOCKED, '--wait', '0.3', '--model', 'loc:8k', '--', 'python3', '-c', 'print("ran")'], { TAIBE_HOST_ROOT: join(dir, 'нет') }).done
  assert.equal(noCfg.code, 0, noCfg.err)
  assert.match(noCfg.err, /конфиг консилиума не прочитан \(\w+Error: .*L-тир только по размеру/)
  assert.match(noCfg.out, /ran/)
  await c.done

  const short = await makeGw({ GW_LOCAL_MAX_WAIT_MS: '300' })
  const w = locked(['--who', 'warmup big:1', '--wait', '5', '--large', '--model', 'big:1', '--', 'python3', '-c', 'import time; print("in", flush=True); time.sleep(1)'])
  await w.seen('in')
  const r = await ask('big:1', short)
  assert.equal(r.status, 503)
  assert.match((await r.json()).error.message, /\(big:1\) .*: pid \d+ \(warmup big:1\)$/)
  assert.equal((await w.done).code, 0)
  assert.equal((await ask('big:1')).status, 200, 'после прогрева лок L-модели свободен')
})
