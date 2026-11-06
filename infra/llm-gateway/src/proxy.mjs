// Ядро шлюза: один запрос клиента → перебор кандидатов (модель × ключ) с паузами и ожиданием,
// без потери данных: клиент получает байты апстрима как есть, ротация возможна только до первого `data:`.
import { once } from 'node:events'
import { acquireMachineLock } from './machine-lock.mjs'
import { requestNeeds } from './router.mjs'
import { Semaphore, buildRequest, describeError, embeddedError, firstDataError, localBody, readUntilFirstData } from './upstream.mjs'

const KEY_ERRORS = new Set([401, 402, 403, 429])
// Пауза ключа/модели короче этого — ждём её, а не уходим на локальную модель или запасную из пула `free`.
const SHORT_WAIT_MS = 10_000
// У Z.AI нет /completions (FIM): GLM-кандидат на этом пути — гарантированный 404, его не пробуем.
export const servesPath = (path) => (c) => !(path === '/completions' && c.provider === 'glm')

// Кандидаты маршрута для пути. Выбранная модель — только GLM, путь — FIM: локальный фолбэк дал бы чатовый ответ
// вместо дополнения кода и на каждой паузе набора менял бы модель в памяти Ollama — честный 503 лучше.
export function pathCandidates(route, path) {
  const served = route.candidates.filter(servesPath(path))
  const hadMain = route.candidates.some((c) => !c.fallback)
  if (hadMain && !served.some((c) => !c.fallback)) {
    return { candidates: [], reason: 'у GLM (Z.AI) нет /completions (FIM) — автокомплит идёт в локальную FIM-модель Ollama (GW_CONTINUE_AUTOCOMPLETE)' }
  }
  return { candidates: served, reason: 'нет ключей OpenRouter и подходящих локальных моделей' }
}
const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
  })

function usageFromTail(tail) {
  const lines = tail.split('\n').filter((l) => l.startsWith('data:') && l.includes('"usage"'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const u = JSON.parse(lines[i].slice(5)).usage
      if (u) return u
    } catch {
      /* обрезанная строка в начале хвоста */
    }
  }
  return undefined
}

// chat.completion → chat.completion.chunk: message становится delta, остальное (id, usage, tool_calls) — как было.
function asChunk(obj) {
  if (!obj?.choices) return null
  return { ...obj, object: 'chat.completion.chunk', choices: obj.choices.map(({ message, ...c }) => ({ ...c, delta: message ?? {} })) }
}

export class Proxy {
  constructor({ cfg, pool, router, discovery, log = () => {}, fetchImpl = fetch }) {
    Object.assign(this, { cfg, pool, router, discovery, log, fetchImpl })
    this.remote = new Semaphore(cfg.maxConcurrency)
    // Локальные модели — строго по одной (политика машины владельца): семафор — внутри процесса, машинный замок
    // (cfg.localLock) — с консилиумом и другими процессами на этом Mac.
    this.local = new Semaphore(1)
    this.stats = { requests: 0, ok: 0, failed: 0, aborted: 0, attempts: 0, localFallbacks: 0, byStatus: {} }
  }

  commit(ctx, extra = {}) {
    if (ctx.committed) return
    ctx.committed = true
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...extra,
    })
  }

  gatewayHeaders(ctx, cand, key) {
    return {
      'x-gateway-model': cand.model,
      'x-gateway-provider': cand.provider,
      'x-gateway-key': key?.id || 'local',
      'x-gateway-attempts': String(ctx.attempts),
    }
  }

  async handle({ path, body, bytes, res, signal, reqId }) {
    this.stats.requests++
    const started = Date.now()
    const stream = body.stream === true
    const need = requestNeeds(body, bytes)
    await this.discovery.refreshLocal()
    const route = this.router.resolve(body.model, need)
    const { candidates, reason } = pathCandidates(route, path)
    const ctx = { res, stream, committed: false, attempts: 0, tried: [], keepAlive: null }
    const done = (outcome) => {
      clearInterval(ctx.keepAlive)
      const last = ctx.tried[ctx.tried.length - 1]
      this.log({ reqId, path, requested: route.name, stream, ms: Date.now() - started, attempts: ctx.attempts, tried: ctx.tried, ...last, ...outcome })
    }
    if (!candidates.length) {
      done({ status: 503 })
      return this.fail(ctx, { status: 503, message: `gateway: нет кандидатов для «${route.name}» на ${path} — ${reason}` })
    }
    // Долгое ожидание ключа/ответа: шлём клиенту SSE-комментарии, чтобы он не оборвал соединение по таймауту.
    if (stream) {
      ctx.keepAlive = setInterval(() => {
        if (res.writableEnded || res.destroyed) return
        this.commit(ctx)
        res.write(': gateway waiting\n\n')
      }, this.cfg.streamCommitMs)
    }

    const deadline = started + this.cfg.maxWaitMs
    const main = candidates.filter((c) => !c.fallback)
    const fallback = candidates.filter((c) => c.fallback)
    const skip = new Set()
    const groupFails = { openrouter: 0, glm: 0 } // подряд идущие отказы провайдера в этом запросе
    let lastErr = null
    let triedFallback = false
    while (ctx.attempts < this.cfg.maxAttempts && !signal.aborted) {
      let progressed = false
      let minWait = Infinity
      let chosenWait = Infinity // ближайшая готовность не-запасных кандидатов в этом проходе
      for (let i = 0; i < main.length && ctx.attempts < this.cfg.maxAttempts; i++) {
        if (skip.has(i) || signal.aborted) continue
        const cand = main[i]
        // Каскад: провайдер отказал GW_PROVIDER_SKIP_AFTER раз подряд — его остаток не пробуем,
        // сразу следующая группа (например, OpenRouter лежит → GLM → локальная).
        if (groupFails[cand.provider] >= this.cfg.providerSkipAfter) {
          skip.add(i)
          continue
        }
        // Выбранная клиентом модель на короткой паузе (429 с Retry-After в пару секунд) — ждём её, не подменяем.
        if (cand.backup && chosenWait - Date.now() <= SHORT_WAIT_MS) continue
        let key = null
        if (cand.provider !== 'local') {
          const got = this.pool.acquire(cand.model, cand.provider)
          if (!got.key) {
            if (got.waitUntil === Infinity) skip.add(i)
            else {
              minWait = Math.min(minWait, got.waitUntil)
              if (!cand.backup) chosenWait = Math.min(chosenWait, got.waitUntil)
            }
            continue
          }
          key = got.key
        }
        progressed = true
        const r = await this.attempt(ctx, cand, key, path, body, signal)
        if (r.done) return done(r)
        lastErr = r.error
        if (signal.aborted) break
        if (r.overloaded) break
        if (cand.provider === 'local') {
          skip.add(i)
          continue
        }
        groupFails[cand.provider]++
        if (this.pool.failure(key, cand.model, r.error) === 'final') {
          done({ status: r.error.status })
          return this.fail(ctx, r.error)
        }
        // Ключевая ошибка (лимит, кредиты, доступ) — та же модель с другим ключом, если он готов прямо сейчас.
        if (KEY_ERRORS.has(r.error.status)) i--
      }
      if (lastErr?.overloaded) break
      if (progressed) continue
      // Никто не готов прямо сейчас. Ключ освободится скоро (≤ 10 с) — ждём его; дольше — сперва локальная модель.
      const now = Date.now()
      const canWait = minWait !== Infinity && minWait <= deadline
      if (canWait && (minWait - now <= SHORT_WAIT_MS || !fallback.length || triedFallback)) {
        await sleep(Math.max(50, minWait - now), signal)
        continue
      }
      if (triedFallback || !fallback.length) break
      triedFallback = true
      this.stats.localFallbacks++
      const r = await this.attempt(ctx, fallback[0], null, path, body, signal)
      if (r.done) return done({ ...r, fallback: true })
      lastErr = r.error
    }
    if (signal.aborted) {
      this.stats.aborted++
      done({ status: 499 })
      return ctx.res.destroy()
    }
    // Retry-After (клиент openrouter-copilot — до 3 повторов, пауза ≤ 30 с). Всё было на паузе и попыток не было —
    // точное время до ближайшей готовности по пулу и всем кандидатам (и пропущенным каскадом), а не «30 с наугад».
    // Апстрим отказал 429 без своего заголовка — не меньше 30 с: лимит OpenRouter общий на аккаунт, и модели, до
    // которых каскад не дошёл, лишь выглядят готовыми — короткая пауза сожгла бы все повторы клиента за секунды.
    const nextReadyAt = Math.min(...main.filter((c) => c.provider !== 'local').map((c) => this.pool.nextReady(c.model, c.provider)))
    const waitMs = nextReadyAt === Infinity ? null : Math.max(1_000, nextReadyAt - Date.now())
    const err = lastErr
      ? { ...lastErr }
      : { status: 429, message: `gateway: все ключи и модели на паузе${waitMs ? `, ближайший освободится через ${Math.ceil(waitMs / 1000)} с` : ''}` }
    if (err.status === 429 && err.retryAfterMs == null) err.retryAfterMs = lastErr ? Math.max(30_000, waitMs ?? 0) : waitMs ?? 30_000
    done({ status: err.status })
    return this.fail(ctx, { ...err, message: `gateway: ${ctx.tried.map((t) => `${t.key}→${t.model}:${t.status}`).join(', ') || 'нет попыток'} | ${err.message}`, raw: undefined })
  }

  // Слот локального инференса: семафор процесса, затем машинный замок с остатком того же дедлайна localMaxWaitMs.
  // → { release, lock } или { error } (503: занято или замок недоступен — ротация на другие модели).
  async localSlot(clientSignal) {
    const t0 = Date.now()
    const release = await this.local.acquire(this.cfg.localMaxWaitMs, clientSignal)
    if (!release) return { error: 'локальная модель занята другим запросом' }
    if (!this.cfg.localLock) return { release }
    let lock
    try {
      lock = await acquireMachineLock({ path: this.cfg.localLock, waitMs: this.cfg.localMaxWaitMs - (Date.now() - t0), signal: clientSignal, python: this.cfg.python })
    } catch (e) {
      lock = { failed: e.message } // семафор не должен утечь ни при каком сбое замка
    }
    if (lock.held) return { release, lock }
    release()
    if (lock.failed) this.log({ level: 'warn', msg: 'machine-lock', error: lock.failed })
    return { error: lock.busy ? 'локальная модель занята другим процессом на этом Mac (консилиум)' : `машинный замок локальной модели недоступен: ${lock.failed}` }
  }

  async attempt(ctx, cand, key, path, body, clientSignal) {
    const isLocal = cand.provider === 'local'
    const slot = isLocal ? await this.localSlot(clientSignal) : { release: await this.remote.acquire(this.cfg.maxWaitMs, clientSignal) }
    const { release, lock } = slot
    const note = (status) => ctx.tried.push({ key: key?.id || 'local', model: cand.model, status })
    if (!release) {
      note(503)
      // Очередь к облаку переполнена — ротация не поможет, отвечаем сразу. Локальная занята — пробуем других.
      return { error: { status: 503, message: isLocal ? slot.error : 'очередь шлюза переполнена', overloaded: !isLocal }, overloaded: !isLocal }
    }
    ctx.attempts++
    this.stats.attempts++
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    clientSignal.addEventListener('abort', onAbort, { once: true })
    // Держатель машинного замка умер посреди вызова — замок уже не наш: инференс обрывается, параллели нет.
    lock?.onLost(() => ac.abort())
    // До заголовков — короткий таймаут (апстрим молчит → ротация), после — общий потолок на тело.
    let timer = setTimeout(() => ac.abort(), this.cfg.firstByteTimeoutMs)
    try {
      const sent = isLocal ? localBody(body, cand) : body
      const { url, init } = buildRequest(this.cfg, cand, key, path, sent, ctx.stream ? 'text/event-stream' : 'application/json', this.outputCap(cand))
      let resp
      try {
        resp = await this.fetchImpl(url, { ...init, signal: ac.signal })
      } catch (e) {
        return (note(0), { error: { status: clientSignal.aborted ? 499 : 0, message: `сеть: ${e.cause?.code || e.message}` } })
      }
      clearTimeout(timer)
      timer = setTimeout(() => ac.abort(), this.cfg.requestTimeoutMs)
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        const err = describeError(resp.status, resp.headers, text)
        return (note(err.status), { error: { ...err, raw: text, rawStatus: resp.status } })
      }
      const sse = (resp.headers.get('content-type') || '').includes('text/event-stream')
      if (!sse) return this.finishJson(ctx, cand, key, resp, note)
      return this.finishStream(ctx, cand, key, resp, ac, clientSignal, note)
    } finally {
      clearTimeout(timer)
      clientSignal.removeEventListener('abort', onAbort)
      lock?.release()
      release()
    }
  }

  // Потолок max_tokens: облако — GW_MAX_OUTPUT_TOKENS и максимум модели по каталогу; локальная — без потолка.
  outputCap(cand) {
    if (cand.provider === 'local') return Infinity
    const cfgCap = this.cfg.maxOutputTokens || Infinity
    const modelCap = cand.provider === 'openrouter' ? this.discovery.catalog.get(cand.model)?.maxOutput || Infinity : Infinity
    return Math.min(cfgCap, modelCap)
  }

  async finishJson(ctx, cand, key, resp, note) {
    let buf
    try {
      buf = Buffer.from(await resp.arrayBuffer())
    } catch (e) {
      return (note(408), { error: { status: 408, message: `ответ не дочитан: ${e.message}` } })
    }
    let obj
    try {
      obj = JSON.parse(buf.toString('utf8'))
    } catch {
      /* не JSON — отдадим как есть */
    }
    const emb = embeddedError(obj)
    if (emb) {
      const err = describeError(emb.code, resp.headers, emb.text)
      return (note(err.status), { error: { ...err, raw: emb.text, rawStatus: emb.code } })
    }
    note(200)
    this.stats.ok++
    if (ctx.committed) {
      // Клиент ждал поток и уже получил SSE-заголовки, а апстрим ответил JSON — отдаём одним чанком потока.
      const chunk = asChunk(obj)
      ctx.res.end(`data: ${chunk ? JSON.stringify(chunk) : buf.toString('utf8')}\n\ndata: [DONE]\n\n`)
    } else {
      ctx.res.writeHead(200, { 'Content-Type': resp.headers.get('content-type') || 'application/json', 'Content-Length': buf.length, ...this.gatewayHeaders(ctx, cand, key) })
      ctx.res.end(buf)
    }
    return { done: true, status: 200, usage: obj?.usage }
  }

  async finishStream(ctx, cand, key, resp, ac, clientSignal, note) {
    const reader = resp.body.getReader()
    let first
    // OpenRouter шлёт заголовки сразу и держит поток комментариями, пока провайдер думает: ждём первый `data:` не дольше таймаута.
    const firstTimer = setTimeout(() => ac.abort(), this.cfg.firstByteTimeoutMs)
    try {
      first = await readUntilFirstData(reader)
    } catch (e) {
      return (note(408), { error: { status: clientSignal.aborted ? 499 : 408, message: `нет первого чанка: ${e.message}` } })
    } finally {
      clearTimeout(firstTimer)
    }
    const emb = first.firstData ? firstDataError(first.firstData) : { code: 502, text: JSON.stringify({ error: { message: `пустой поток: ${(first.text || '').slice(0, 200)}` } }) }
    if (emb) {
      reader.cancel().catch(() => {})
      const err = describeError(emb.code, resp.headers, emb.text)
      return (note(err.status), { error: { ...err, raw: emb.text, rawStatus: emb.code } })
    }
    clearInterval(ctx.keepAlive)
    this.commit(ctx, this.gatewayHeaders(ctx, cand, key))
    const res = ctx.res
    const decoder = new TextDecoder()
    let tail = ''
    const keep = (v) => (tail = (tail + decoder.decode(v, { stream: true })).slice(-16_384))
    const write = async (v) => {
      keep(v)
      if (!res.write(v)) await Promise.race([once(res, 'drain'), once(res, 'close')])
    }
    try {
      for (const c of first.chunks) await write(c)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await write(value)
      }
      res.end()
    } catch (e) {
      if (clientSignal.aborted) return (note(499), { done: true, status: 499 })
      // Данные уже у клиента — ротация задвоила бы ответ. Честно закрываем поток ошибкой.
      if (!res.writableEnded) res.end(`data: ${JSON.stringify({ error: { message: `gateway: поток оборван: ${e.message}`, code: 502 } })}\n\ndata: [DONE]\n\n`)
      note(502)
      this.stats.failed++
      return { done: true, status: 502, midStream: true }
    }
    note(200)
    this.stats.ok++
    return { done: true, status: 200, usage: usageFromTail(tail) }
  }

  fail(ctx, err) {
    clearInterval(ctx.keepAlive)
    this.stats.failed++
    const status = err.rawStatus || (err.status >= 400 ? err.status : 502)
    this.stats.byStatus[status] = (this.stats.byStatus[status] || 0) + 1
    const payload = err.raw || JSON.stringify({ error: { message: err.message, type: 'gateway_error', code: status } })
    if (ctx.committed) {
      if (!ctx.res.writableEnded) ctx.res.end(`data: ${payload}\n\ndata: [DONE]\n\n`)
      return
    }
    const headers = { 'Content-Type': 'application/json' }
    if (status === 429 || status === 503) headers['Retry-After'] = String(Math.ceil((err.retryAfterMs ?? 30_000) / 1000))
    ctx.res.writeHead(status, headers)
    ctx.res.end(payload)
  }
}
