/**
 * Вложения входящих очереди владельца (план handoff/2026-10-21/work/files-plan.md v2). Загрузка — только владелец
 * (сессия с CSRF или токен бота с областью owner), тело — сам файл, имя — заголовок X-File-Name (URL-кодирование).
 * Отдача — всегда attachment + nosniff + CSP sandbox: даже пропущенный проверкой файл браузер не исполнит.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Hono } from 'hono'
import { apiError } from '../http-types'
import { requireScope, type QueueEnv } from '../queue/auth'
import { DOC_ID } from '../queue/store'
import { throttleFileRead, throttleSummary, throttleWrite } from '../queue/throttle'
import { contentDisposition, displayName, extOf } from '../queue/files/names'
import { sniffFile, UnsupportedFileError } from '../queue/files/sniff'
import { ensureDirs, FILE_ID, filesConfig, finalPath, freeBytes, newFileId, removeQuiet, tmpPath } from '../queue/files/storage'
import { deleteFileRow, filesEpoch, filesFingerprint, getFile, insertFile, isInboxItem, itemInfo, listAllFiles, listItemFiles, uniqueNameInItem, usedBytes, type FileRow } from '../queue/files/store'
import { canSee, visibilityKey } from '../queue/products'
import { getEnv } from '../env'

const HEAD_BYTES = 64
/**
 * Байты загрузок, которые идут сейчас: в показе занятого места (/summary), не в проверке потолка при вставке.
 * Счётчик процесса: консоль — один процесс; при нескольких он покажет только свои загрузки (потолок от этого не зависит).
 */
let inFlightBytes = 0
let inFlightCount = 0
/** Загрузок сразу — не больше: вместе с проверкой места это потолок временных файлов (4 × 20 МБ), даже при цикле в боте. */
const MAX_IN_FLIGHT = 4
/** Обрезка сводки — в журнал, но не на каждый опрос страницы: не чаще раза в час. */
let truncatedLoggedAt = 0

function noteTruncated(t: { files: boolean; groups: boolean }, items: number): void {
  if (!t.files && !t.groups) return
  const now = Date.now()
  if (now - truncatedLoggedAt < 3_600_000) return
  truncatedLoggedAt = now
  console.warn(
    `[oq-files] сводка /files/summary урезана: ${t.files ? 'строки файлов — только у новых, у остальных пунктов страница догружает список' : ''}` +
      `${t.files && t.groups ? '; ' : ''}${t.groups ? `пунктов с вложениями больше ${items} — у лишних нет даже счётчика` : ''}`,
  )
}

/** sha256 — для сверки скачанного у агента (MCP): не секрет, отпечаток содержимого. */
function toPublic(r: FileRow) {
  return { id: r.id, itemId: r.itemId, name: r.name, kind: r.kind, size: r.size, sha256: r.sha256, createdAt: r.createdAt, createdBy: r.createdBy }
}

function decodeName(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

/** Тело — потоком во временный файл: счётчик байт (обрыв на лимите), sha256 и первые байты для типа — по ходу. */
async function receive(body: ReadableStream<Uint8Array>, tmp: string, maxBytes: number) {
  const hash = createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > maxBytes) return cb(apiError(413, `Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`))
      hash.update(chunk)
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)])
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(body as never), meter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }))
  return { size, sha256: hash.digest('hex'), head }
}

export const filesRoutes = new Hono<QueueEnv>()

filesRoutes.post('/', requireScope('owner'), async (c) => {
  const actor = c.get('oqActor')
  throttleWrite(actor.name)
  const cfg = filesConfig()
  const itemId = c.req.query('item') ?? ''
  if (!DOC_ID.test(itemId)) throw apiError(422, 'Нужен id входящего: ?item=i-…')
  const lengthHeader = c.req.header('content-length')
  if (!lengthHeader) throw apiError(411, 'Нужен заголовок Content-Length')
  const declared = Number(lengthHeader)
  if (!Number.isInteger(declared) || declared <= 0) throw apiError(400, 'Пустой файл')
  if (declared > cfg.maxBytes) throw apiError(413, `Файл больше ${Math.round(cfg.maxBytes / 1024 / 1024)} МБ`)
  if (!c.req.raw.body) throw apiError(400, 'Пустой файл')
  if (!(await isInboxItem(itemId, actor.products))) throw apiError(404, 'Нет такого входящего')
  await ensureDirs(cfg.dir)
  const free = await freeBytes(cfg.dir)
  // Проверка и учёт идущей загрузки — без await между ними: параллельные запросы видят байты друг друга, и место на
  // томе (общем с SQLite) не уходит под временные файлы. Потолок хранилища окончательно проверяет вставка в базу.
  if (inFlightCount >= MAX_IN_FLIGHT) throw apiError(429, 'Слишком много загрузок сразу — повторите через минуту')
  if (free - inFlightBytes < declared + cfg.freeReserveBytes) throw apiError(507, 'На сервере мало места — файл не принят')

  const id = newFileId()
  const tmp = tmpPath(cfg.dir, id)
  inFlightBytes += declared
  inFlightCount++
  try {
    const got = await receive(c.req.raw.body, tmp, cfg.maxBytes)
    if (got.size !== declared) throw apiError(400, 'Файл пришёл не целиком — повторите')
    const sniffed = await sniffFile(tmp, got.size, got.head)
    if (!cfg.kinds.includes(sniffed.kind)) throw new UnsupportedFileError('Этот тип файлов отключён')
    const name = await uniqueNameInItem(itemId, displayName(decodeName(c.req.header('x-file-name')), sniffed))
    const path = finalPath(cfg.dir, id)
    await rename(tmp, path)
    try {
      const res = await insertFile(
        { id, itemId, name, kind: sniffed.kind, mime: sniffed.mime, size: got.size, sha256: got.sha256, createdBy: actor.name },
        { maxPerItem: cfg.maxPerItem, capBytes: cfg.totalCapBytes },
      )
      if (res.status === 'duplicate' && !(await stat(finalPath(cfg.dir, res.row.id)).catch(() => null))) {
        // У прежней записи файл пропал (том без файлов после восстановления, ручное удаление): новая копия встаёт на
        // его место, а не стирается — иначе дубль удалил бы единственные байты (линза GLM #313).
        await rename(path, finalPath(cfg.dir, res.row.id))
      } else if (res.status !== 'created') await removeQuiet(path)
      // Пункт удалили, пока шла загрузка: строка и файл не остаются сиротами до суточной уборки (линза GLM #313).
      if (res.status === 'created' && !(await isInboxItem(itemId, actor.products))) {
        await deleteFileRow(id)
        throw apiError(404, 'Входящее удалено, пока шла загрузка')
      }
      if (res.status === 'limit') throw apiError(409, `У входящего уже ${cfg.maxPerItem} файлов — больше нельзя`)
      if (res.status === 'cap') throw apiError(507, 'Хранилище вложений заполнено — файл не принят')
      return c.json({ file: toPublic(res.row), duplicate: res.status === 'duplicate' }, res.status === 'created' ? 201 : 200)
    } catch (e) {
      await removeQuiet(path)
      throw e
    }
  } catch (e) {
    await removeQuiet(tmp)
    if (e instanceof UnsupportedFileError) throw apiError(415, `Файл не принят: ${e.message}`)
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOSPC') throw apiError(507, 'На сервере закончилось место — файл не принят')
    // Владелец нажал «Отменить» или пропала связь: клиента уже нет, в журнале это не сбой сервера.
    if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') throw apiError(400, 'Загрузка прервана')
    throw e
  } finally {
    inFlightBytes -= declared
    inFlightCount--
  }
})

filesRoutes.get('/', requireScope('read', 'agent'), async (c) => {
  const itemId = c.req.query('item') ?? ''
  if (!DOC_ID.test(itemId)) throw apiError(422, 'Нужен id входящего: ?item=i-…')
  // Чужой пункт — тот же ответ, что у несуществующего: пусто.
  const info = await itemInfo(itemId)
  if (info && !canSee(c.get('oqActor').products, info.product)) return c.json({ files: [], expired: 0 })
  const { files, expired } = await listItemFiles(itemId)
  return c.json({ files: files.map(toPublic), expired })
})

/**
 * Сводка для страницы /queue одним запросом: вложения всех входящих, число удалённых по сроку, лимиты для подсказки
 * формы и занятое место — тихая строка «Вложения: N из M МБ». Предупреждение — с 95 % от min(потолок, занято +
 * свободно на томе): раньше это тревога без действия (80 % — только журнал консоли, см. sweep.ts). Страница
 * спрашивает сводку при смене входящих, после своих загрузок и, пока у пункта ждут файлы, раз в несколько секунд —
 * с ETag: без изменений ответ 304. Хранилища нет (хостинг без диска) — `enabled: false`, и форма прячет «📎».
 */
filesRoutes.get('/summary', requireScope('read', 'agent'), async (c) => {
  throttleSummary(c.get('oqActor').name)
  if (!getEnv().oqFiles.dir) return c.json({ enabled: false })
  const cfg = filesConfig()
  await ensureDirs(cfg.dir)
  const used = (await usedBytes()) + inFlightBytes
  const limit = Math.min(cfg.totalCapBytes, used + (await freeBytes(cfg.dir)))
  const warn = used >= limit * 0.95
  // Отпечаток до тяжёлых выборок: строки вложений меняются только вставкой, удалением и надгробием — число, сумма,
  // последние created_at и deleted_at это ловят. Без изменений — 304 без GROUP BY по таблице (линза GLM #313).
  // Видимость — в теге: у токенов разных продуктов разные сводки. Отпечаток общий: тег токена меняется и от загрузок
  // в чужом продукте — раскрывает только, что где-то что-то загрузили, без пункта и файла.
  const products = c.get('oqActor').products
  const fp = await filesFingerprint()
  const etag = `W/"${createHash('sha256').update(JSON.stringify([visibilityKey(products), fp, filesEpoch(), inFlightBytes, warn, cfg.maxBytes, cfg.maxPerItem, cfg.kinds, cfg.retentionDays, cfg.totalCapBytes])).digest('base64url').slice(0, 22)}"`
  c.header('ETag', etag)
  if (c.req.header('if-none-match') === etag) return c.body(null, 304)
  const summary = await listAllFiles(products)
  noteTruncated(summary.truncated, summary.counts.size)
  // count — живых файлов у пункта; files короче count — строки не вошли в сводку, страница догрузит список пункта.
  const items: Record<string, { files: ReturnType<typeof toPublic>[]; count: number; expired: number }> = {}
  const slot = (id: string) => (items[id] ??= { files: [], count: 0, expired: 0 })
  // Новые первыми из базы — в пункте показываем по порядку загрузки.
  for (const r of [...summary.files].reverse()) slot(r.itemId).files.push(toPublic(r))
  for (const [id, n] of summary.counts) slot(id).count = n
  for (const [id, n] of summary.expired) slot(id).expired = n
  const body = JSON.stringify({
    enabled: true,
    limits: { maxBytes: cfg.maxBytes, maxPerItem: cfg.maxPerItem, kinds: cfg.kinds, retentionDays: cfg.retentionDays },
    // Занятое место — по всем продуктам: только владельцу (по его изменению видно размер и время чужих загрузок).
    ...(products === '*' ? { usage: { usedBytes: used, capBytes: cfg.totalCapBytes, warn } } : {}),
    items,
    ...(summary.truncated.files || summary.truncated.groups ? { truncated: summary.truncated } : {}),
  })
  return c.body(body, 200, { 'Content-Type': 'application/json; charset=utf-8' })
})

filesRoutes.get('/:id', requireScope('agent'), async (c) => {
  throttleFileRead(c.get('oqActor').name)
  const id = c.req.param('id')
  if (!FILE_ID.test(id)) throw apiError(404, 'Нет такого файла')
  const row = await getFile(id)
  if (!row || !(await isInboxItem(row.itemId, c.get('oqActor').products))) throw apiError(404, 'Нет такого файла')
  if (row.deletedAt) throw apiError(410, 'Файл удалён по сроку хранения')
  const cfg = filesConfig()
  const path = finalPath(cfg.dir, id)
  if (!(await stat(path).catch(() => null))) throw apiError(410, 'Файл удалён с диска')
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
  return new Response(stream, {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(row.size),
      'Content-Disposition': contentDisposition(row.name, extOf(row.name)),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    },
  })
})

filesRoutes.delete('/:id', requireScope('owner'), async (c) => {
  throttleWrite(c.get('oqActor').name)
  const id = c.req.param('id')
  if (!FILE_ID.test(id) || !(await deleteFileRow(id))) throw apiError(404, 'Нет такого файла')
  await removeQuiet(finalPath(filesConfig().dir, id))
  return c.json({ ok: true })
})
