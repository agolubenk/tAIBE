// Вложения входящих (files-plan v2): права, тип по содержимому, ZIP без макросов и подмены, имена, лимиты без гонок,
// удаление вместе с пунктом, уборка по сроку и сирот.
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { freshApp, login } from './helpers'
import { createToken } from '../server/queue/auth'
import { deleteDoc, importDoc } from '../server/queue/store'
import { getEnv, setEnvForTests } from '../server/env'
import { sweepFiles } from '../server/queue/files/sweep'
import { contentDisposition } from '../server/queue/files/names'
import { deleteRows, listAllFiles, markExpired, usedBytes } from '../server/queue/files/store'
import { getDb } from '../server/db/client'
import { oqDocs, oqFiles } from '../server/db/schema'
import { and, eq, sql } from 'drizzle-orm'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let cookie: string
let owner: string
let agent: string
let reader: string
let dir: string

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])
const PDF = Buffer.from('%PDF-1.7\n%fake\n')

function inbox(text = 'Задача с файлом') {
  return { kind: 'inbox', title: text, inbox: { type: 'task', urgency: 'queue', text, originKind: 'self', forwarded: false, receivedAt: '2026-10-21T20:00:00.000Z' } }
}

let seq = 0
async function newItem(): Promise<string> {
  const id = `i-test-${++seq}`
  expect(await importDoc('items', id, inbox(), 'test')).toBe('added')
  return id
}

async function upload(token: string | null, itemId: string, body: Buffer, name = 'file.bin', opts: { noLength?: boolean; csrf?: boolean } = {}) {
  const headers: Record<string, string> = { 'X-File-Name': encodeURIComponent(name) }
  if (!opts.noLength) headers['Content-Length'] = String(body.length)
  if (token) headers.Authorization = `Bearer ${token}`
  else {
    headers.Cookie = cookie
    if (opts.csrf !== false) headers['X-Ops-Csrf'] = '1'
  }
  const res = await app.request(`/api/oq/v1/files?item=${itemId}`, { method: 'POST', headers, body })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any> }
}

async function get(token: string, path: string) {
  return app.request(`/api/oq/v1${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

/** ZIP без сжатия (метод 0) или со сжатием (8) — для docx/xlsx в тестах. */
function zip(entries: Array<{ name: string; data: Buffer | string; deflate?: boolean; localName?: string }>, hidden?: { name: string; data: string }) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const pushLocal = (name: string, data: Buffer, method: number, raw: Buffer) => {
    const nameBuf = Buffer.from(name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    const at = offset
    locals.push(lh, nameBuf, data)
    offset += 30 + nameBuf.length + data.length
    return at
  }
  if (hidden) pushLocal(hidden.name, Buffer.from(hidden.data), 0, Buffer.from(hidden.data))
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const data = e.deflate ? deflateRawSync(raw) : raw
    const method = e.deflate ? 8 : 0
    const at = pushLocal(e.localName ?? e.name, data, method, raw)
    const nameBuf = Buffer.from(e.name, 'utf8')
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(at, 42)
    centrals.push(ch, nameBuf)
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/**
 * Тот же архив, но записи с дескриптором данных (бит 3), как пишут Java и LibreOffice: в локальном заголовке CRC и
 * размеры нулевые, после данных — дескриптор, в каталоге — настоящие значения и тот же флаг.
 */
function withDescriptor(z: Buffer): Buffer {
  const eocdAt = z.length - 22
  const cdOffset = z.readUInt32LE(eocdAt + 16)
  const n = z.readUInt16LE(eocdAt + 10)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let p = cdOffset
  let offset = 0
  for (let i = 0; i < n; i++) {
    const nameLen = z.readUInt16LE(p + 28)
    const ch = Buffer.from(z.subarray(p, p + 46 + nameLen))
    const at = ch.readUInt32LE(42)
    const crc = ch.readUInt32LE(16), csize = ch.readUInt32LE(20), usize = ch.readUInt32LE(24)
    const lnLen = z.readUInt16LE(at + 26)
    const lh = Buffer.from(z.subarray(at, at + 30 + lnLen))
    lh.writeUInt16LE(lh.readUInt16LE(6) | 0x08, 6)
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22)
    const data = z.subarray(at + 30 + lnLen, at + 30 + lnLen + csize)
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12)
    ch.writeUInt16LE(ch.readUInt16LE(8) | 0x08, 8)
    ch.writeUInt32LE(offset, 42)
    locals.push(lh, data, dd)
    centrals.push(ch)
    offset += lh.length + data.length + dd.length
    p += 46 + nameLen
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.from(z.subarray(eocdAt))
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const TYPES_DOCX = '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const docx = (extra: Array<{ name: string; data: string }> = [], types = TYPES_DOCX) =>
  zip([{ name: '[Content_Types].xml', data: types, deflate: true }, { name: 'word/document.xml', data: '<w:document/>' }, ...extra])

beforeAll(async () => {
  app = await freshApp()
  cookie = await login(app)
  owner = (await createToken('queue-bot', ['owner'])).token
  agent = (await createToken('test-agent', ['read', 'agent'])).token
  reader = (await createToken('reader', ['read'])).token
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oq-files-'))
  setEnvForTests({ oqFiles: { ...getEnv().oqFiles, dir, maxBytes: 64 * 1024, maxPerItem: 3, totalCapBytes: 1024 * 1024, freeReserveBytes: 0, retentionDays: 90 } })
})

describe('вложения: права и отдача', () => {
  it('владелец загружает, агент видит в списке и скачивает — всегда attachment, nosniff, sandbox', async () => {
    const itemId = await newItem()
    const up = await upload(owner, itemId, PNG, 'скрин.png')
    expect(up.status).toBe(201)
    const list = await (await get(agent, `/files?item=${itemId}`)).json()
    // sha256 — для сверки скачанного у агента (MCP); отпечаток содержимого, не секрет.
    expect(list.files).toEqual([expect.objectContaining({ id: up.json.file.id, name: 'скрин.png', kind: 'image', size: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex') })])
    const res = await get(agent, `/files/${up.json.file.id}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="file.png"; filename*=UTF-8''${encodeURIComponent('скрин.png')}`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    // Владелец скачивает свой файл — и из браузера (сессия), и токеном бота: owner проходит любую область (линза GLM #313).
    expect((await app.request(`/api/oq/v1/files/${up.json.file.id}`, { headers: { Cookie: cookie } })).status).toBe(200)
    expect((await get(owner, `/files/${up.json.file.id}`)).status).toBe(200)
  })

  it('read видит список, но не байты; agent не загружает; сессия без CSRF — 403; не входящее — 404', async () => {
    const itemId = await newItem()
    const up = await upload(owner, itemId, PDF, 'a.pdf')
    expect((await get(reader, `/files?item=${itemId}`)).status).toBe(200)
    expect((await get(reader, `/files/${up.json.file.id}`)).status).toBe(403)
    expect((await upload(agent, itemId, PDF)).status).toBe(403)
    expect((await upload(null, itemId, PDF, 'a.pdf', { csrf: false })).status).toBe(403)
    expect((await upload(null, itemId, PNG, 'b.png')).status).toBe(201)
    await importDoc('items', 'd-not-inbox', { kind: 'decision', title: 'Решение', options: [{ id: 'a', label: 'А' }] }, 'test')
    expect((await upload(owner, 'd-not-inbox', PDF)).status).toBe(404)
  })

  it('без Content-Length — 411; больше лимита — 413', async () => {
    const itemId = await newItem()
    expect((await upload(owner, itemId, PDF, 'a.pdf', { noLength: true })).status).toBe(411)
    expect((await upload(owner, itemId, Buffer.concat([PDF, Buffer.alloc(70 * 1024)]), 'big.pdf')).status).toBe(413)
  })
})

describe('вложения: тип по содержимому', () => {
  it.each([
    ['SVG под видом картинки', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'evil.svg'],
    ['HTML как текст', '﻿ \n\t<html><body>x</body></html>', 'page.txt'],
    ['комментарий разметки', '<!-- x --> hello', 'a.log'],
    ['двоичный мусор', Buffer.from([0x00, 0x01, 0x02, 0x03]), 'a.bin'],
    ['не UTF-8', Buffer.from([0xc3, 0x28, 0x41]), 'a.txt'],
  ])('%s — 415', async (_t, body, name) => {
    const itemId = await newItem()
    expect((await upload(owner, itemId, Buffer.isBuffer(body) ? body : Buffer.from(body), name)).status).toBe(415)
  })

  it('текст принимается, расширение по содержимому: exe с PDF внутри → .pdf, лог → .log', async () => {
    const itemId = await newItem()
    expect((await upload(owner, itemId, PDF, 'отчёт.exe')).json.file.name).toBe('отчёт.pdf')
    expect((await upload(owner, itemId, Buffer.from('ERROR at line 1\n'), 'backend.log')).json.file.name).toBe('backend.log')
  })

  it('docx принимается; макросы (vbaProject.bin, macroEnabled) и подмена каталога — 415', async () => {
    const itemId = await newItem()
    const ok = await upload(owner, itemId, docx(), 'план.docx')
    expect(ok.status).toBe(201)
    expect(ok.json.file.kind).toBe('doc')
    const other = await newItem()
    expect((await upload(owner, other, docx([{ name: 'word/vbaProject.bin', data: 'macro' }]), 'm.docx')).status).toBe(415)
    expect((await upload(owner, other, docx([], TYPES_DOCX.replace('main+xml', 'macroEnabled.main+xml')), 'm.docx')).status).toBe(415)
    const lying = zip([{ name: '[Content_Types].xml', data: TYPES_DOCX }, { name: 'word/document.xml', data: '<w/>', localName: 'word/vbaProject.bin' }])
    expect((await upload(owner, other, lying, 'lie.docx')).status).toBe(415)
    const hiddenLocal = zip([{ name: '[Content_Types].xml', data: TYPES_DOCX }, { name: 'word/document.xml', data: '<w/>' }], { name: 'word/vbaProject.bin', data: 'macro' })
    expect((await upload(owner, other, hiddenLocal, 'hidden.docx')).status).toBe(415)
  })

  it('локальный заголовок говорит не то, что каталог (метод, CRC, размер) — 415; дескриптор данных (Java, LibreOffice) — принимается (линза GLM #313)', async () => {
    const itemId = await newItem()
    const good = docx()
    // [Content_Types].xml — первая запись: локальный заголовок с нулевого байта, метод +8, CRC +14, размер +18.
    for (const [at, value] of [[8, 0], [14, 0xdeadbeef], [18, 1]] as const) {
      const bad = Buffer.from(good)
      if (at === 8) bad.writeUInt16LE(value, at)
      else bad.writeUInt32LE(value, at)
      expect((await upload(owner, itemId, bad, 'подмена.docx')).status, `смещение ${at}`).toBe(415)
    }
    expect((await upload(owner, itemId, withDescriptor(good), 'libre.docx')).status).toBe(201)
  })
})

describe('вложения: имена', () => {
  it('имя с разметкой хранится текстом; bidi, пути и ведущие точки убираются', async () => {
    const itemId = await newItem()
    expect((await upload(owner, itemId, PNG, '<img src=x onerror=alert(1)>.png')).json.file.name).toBe('<img src=x onerror=alert(1)>.png')
    expect((await upload(owner, itemId, PDF, '../..\\.secret‮fdp.exe')).json.file.name).toBe('_.._.secretfdp.pdf'.replace(/^\./, ''))
  })

  it('Content-Disposition: кавычки, «;» и перевод строки в имени не ломают заголовок', () => {
    expect(contentDisposition('x"; x=;.pdf', 'pdf')).toBe(`attachment; filename="file.pdf"; filename*=UTF-8''x%22%3B%20x%3D%3B.pdf`)
    const header = contentDisposition("a\r\nb'(1)*!.txt", 'txt')
    expect(header).not.toMatch(/[\r\n]/)
    expect(header.split("filename*=UTF-8''")[1]).toMatch(/^[A-Za-z0-9%._~-]+$/)
  })
})

describe('вложения: лимиты без гонок', () => {
  it('тот же файл повторно — прежний id; четвёртый файл — 409, и параллельно тоже', async () => {
    const itemId = await newItem()
    const first = await upload(owner, itemId, PNG, 'a.png')
    const again = await upload(owner, itemId, PNG, 'a-copy.png')
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ duplicate: true, file: { id: first.json.file.id } })
    expect((await upload(owner, itemId, PDF, 'b.pdf')).status).toBe(201)
    const results = await Promise.all([
      upload(owner, itemId, Buffer.from('third\n'), 'c.txt'),
      upload(owner, itemId, Buffer.from('fourth\n'), 'd.txt'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(readdirSync(dir).filter((f) => f !== 'tmp')).toHaveLength(3)
  })

  it('общий потолок: две параллельные загрузки на границе — одна 507, потолок не превышен', async () => {
    // База общая для файла тестов: потолок — от уже занятого.
    setEnvForTests({ oqFiles: { ...getEnv().oqFiles, totalCapBytes: (await usedBytes()) + 30 } })
    const a = await newItem()
    const b = await newItem()
    const results = await Promise.all([upload(owner, a, Buffer.from('x'.repeat(20)), 'a.txt'), upload(owner, b, Buffer.from('y'.repeat(20)), 'b.txt')])
    expect(results.map((r) => r.status).sort()).toEqual([201, 507])
  })
})

describe('вложения: удаление и уборка', () => {
  it('уборка пишет порциями: 40 000 id за раз не упираются в предел параметров SQLite (линза GLM #313)', async () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => `nope-${i}`)
    await expect(markExpired(ids, new Date())).resolves.toBeUndefined()
    await expect(deleteRows(ids)).resolves.toBeUndefined()
  })

  it('удаление пункта удаляет его файлы: GET — 404, на диске пусто', async () => {
    const itemId = await newItem()
    const up = await upload(owner, itemId, PNG, 'a.png')
    const del = await app.request(`/api/oq/v1/db/items/${itemId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner}` } })
    expect(del.status).toBe(200)
    expect((await get(agent, `/files/${up.json.file.id}`)).status).toBe(404)
    expect(existsSync(join(dir, up.json.file.id))).toBe(false)
  })

  it('уборка: срок после закрытия, сироты на диске и в базе, оборванные загрузки', async () => {
    const closed = await newItem()
    const open = await newItem()
    const old = await upload(owner, closed, PNG, 'old.png')
    const keep = await upload(owner, open, PDF, 'keep.pdf')
    await getDb().update(oqDocs).set({ dataJson: JSON.stringify({ ...inbox(), archived: true }), updatedAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, closed)))
    // Файл приложен до закрытия: срок считается от закрытия.
    await getDb().update(oqFiles).set({ createdAt: new Date(Date.now() - 95 * 86_400_000) }).where(eq(oqFiles.id, old.json.file.id))
    const orphan = join(dir, 'f'.repeat(32))
    writeFileSync(orphan, 'x')
    const staleTmp = join(dir, 'tmp', 'a'.repeat(32))
    writeFileSync(staleTmp, 'x')
    const past = (Date.now() - 2 * 86_400_000) / 1000
    utimesSync(orphan, past, past)
    utimesSync(staleTmp, past, past)
    const report = await sweepFiles()
    expect(report).toMatchObject({ expired: 1, orphanFiles: 1, tmpRemoved: 1 })
    expect(existsSync(join(dir, old.json.file.id))).toBe(false)
    expect(existsSync(join(dir, keep.json.file.id))).toBe(true)
    // Надгробие: файл удалён, строка осталась — «удалено по сроку», а не «файлов не было».
    expect((await get(agent, `/files/${old.json.file.id}`)).status).toBe(410)
    expect(await (await get(agent, `/files?item=${closed}`)).json()).toEqual({ files: [], expired: 1 })
    const rows = (await getDb().all(sql`SELECT count(*) AS n FROM oq_files WHERE item_id = ${open}`)) as Array<{ n: number }>
    expect(Number(rows[0]?.n)).toBe(1)
  })
})

describe('вложения: линза GLM «корректность» #313', () => {
  const DAY = 86_400_000

  it('список пункта не теряет живые файлы за надгробиями (раньше общий LIMIT 50 считал и надгробия)', async () => {
    const itemId = await newItem()
    const old = new Date(Date.now() - 400 * DAY)
    for (let i = 0; i < 60; i++) {
      await getDb().insert(oqFiles).values({ id: (i + 1).toString(16).padStart(32, 'c'), itemId, name: `old-${i}.png`, kind: 'image', mime: 'image/png', size: 1,
        sha256: (i + 1).toString(16).padStart(64, '0'), createdAt: old, createdBy: 'test', deletedAt: old, deletedReason: 'retention' })
    }
    const live = await upload(owner, itemId, PNG, 'свежий.png')
    expect(await (await get(agent, `/files?item=${itemId}`)).json()).toEqual({ files: [expect.objectContaining({ id: live.json.file.id })], expired: 60 })
  })

  it('файл, докреплённый к давно закрытому пункту, живёт свой срок, а не исчезает на следующей уборке', async () => {
    const itemId = await newItem()
    await getDb().update(oqDocs).set({ dataJson: JSON.stringify({ ...inbox(), archived: true }), updatedAt: new Date(Date.now() - 200 * DAY) })
      .where(and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, itemId)))
    const late = await upload(owner, itemId, PDF, 'потом.pdf')
    expect((await sweepFiles()).expired).toBe(0)
    expect(existsSync(join(dir, late.json.file.id))).toBe(true)
    expect((await sweepFiles(Date.now() + 91 * DAY)).expired).toBe(1)
  })

  it('каталог пуст или подменён — строки не удаляются пачкой, в отчёте «подозрительно»', async () => {
    const { rmSync } = await import('node:fs')
    const itemId = await newItem()
    setEnvForTests({ oqFiles: { ...getEnv().oqFiles, maxPerItem: 10 } })
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push((await upload(owner, itemId, Buffer.from(`файл ${i}`), `f${i}.txt`)).json.file.id)
    await getDb().update(oqFiles).set({ createdAt: new Date(Date.now() - 2 * DAY) }).where(eq(oqFiles.itemId, itemId))
    // Новый каталог (как если бы том не смонтировался): все файлы «пропали».
    for (const id of ids) rmSync(join(dir, id))
    const report = await sweepFiles()
    expect(report.suspicious).toBeGreaterThanOrEqual(7)
    const rows = (await getDb().all(sql`SELECT count(*) AS n FROM oq_files WHERE item_id = ${itemId} AND deleted_at IS NULL`)) as Array<{ n: number }>
    expect(Number(rows[0]?.n)).toBe(7)
  })

  it('дубль, когда у прежней записи файл пропал с диска, — новая копия встаёт на место, а не стирается', async () => {
    const { rmSync } = await import('node:fs')
    const itemId = await newItem()
    const first = await upload(owner, itemId, PDF, 'отчёт.pdf')
    rmSync(join(dir, first.json.file.id))
    const again = await upload(owner, itemId, PDF, 'отчёт.pdf')
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ duplicate: true, file: { id: first.json.file.id } })
    const res = await get(agent, `/files/${first.json.file.id}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF)
  })

  it('надгробия старше года уборка удаляет — строки не копятся без конца', async () => {
    const itemId = await newItem()
    const id = 'e'.repeat(32)
    await getDb().insert(oqFiles).values({ id, itemId, name: 'old.png', kind: 'image', mime: 'image/png', size: 1, sha256: 'e'.repeat(64),
      createdAt: new Date(Date.now() - 500 * DAY), createdBy: 'test', deletedAt: new Date(Date.now() - 400 * DAY), deletedReason: 'retention' })
    await sweepFiles()
    const rows = (await getDb().all(sql`SELECT count(*) AS n FROM oq_files WHERE id = ${id}`)) as Array<{ n: number }>
    expect(Number(rows[0]?.n)).toBe(0)
  })

  it('сводка: удалили новый файл и загрузили другой того же размера в ту же секунду — не 304', async () => {
    const itemId = await newItem()
    const a = await upload(owner, itemId, Buffer.from('файл-1'), 'a.txt')
    const first = await get(agent, '/files/summary')
    const etag = first.headers.get('etag')!
    const [aRow] = await getDb().select().from(oqFiles).where(eq(oqFiles.id, a.json.file.id))
    await app.request(`/api/oq/v1/files/${a.json.file.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner}` } })
    const b = await upload(owner, itemId, Buffer.from('файл-2'), 'b.txt')
    // Худший случай: новый файл с той же меткой времени — агрегаты таблицы те же, отличает только счётчик изменений.
    await getDb().update(oqFiles).set({ createdAt: aRow!.createdAt }).where(eq(oqFiles.id, b.json.file.id))
    const again = await app.request('/api/oq/v1/files/summary', { headers: { Authorization: `Bearer ${agent}`, 'If-None-Match': etag } })
    expect(again.status).toBe(200)
  })

  it('пункт удалили, пока шла загрузка, — 404, ни строки, ни файла', async () => {
    const itemId = await newItem()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('медленный '))
        await gate
        ctrl.enqueue(new TextEncoder().encode('файл'))
        ctrl.close()
      },
    })
    const pending = app.request(`/api/oq/v1/files?item=${itemId}`, {
      method: 'POST', body, duplex: 'half',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Length': String(Buffer.byteLength('медленный файл')), 'X-File-Name': 'slow.txt' },
    } as RequestInit)
    await new Promise((r) => setTimeout(r, 30))
    await deleteDoc({ name: 'test', scopes: ['owner'], products: '*' }, 'items', itemId)
    release()
    expect((await pending).status).toBe(404)
    const rows = (await getDb().all(sql`SELECT count(*) AS n FROM oq_files WHERE item_id = ${itemId}`)) as Array<{ n: number }>
    expect(Number(rows[0]?.n)).toBe(0)
    expect(readdirSync(dir).filter((n) => n !== 'tmp')).toHaveLength(0)
  })
})

describe('вложения: продукт (v3)', () => {
  it('повтор имени в пункте — «(2)»; удаление владельцем — без следа', async () => {
    const itemId = await newItem()
    const a = await upload(owner, itemId, PNG, 'скрин.png')
    const b = await upload(owner, itemId, Buffer.concat([PNG, Buffer.from('2')]), 'скрин.png')
    expect(b.json.file.name).toBe('скрин (2).png')
    const del = await app.request(`/api/oq/v1/files/${a.json.file.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner}` } })
    expect(del.status).toBe(200)
    expect(await (await get(agent, `/files?item=${itemId}`)).json()).toEqual({ files: [expect.objectContaining({ name: 'скрин (2).png' })], expired: 0 })
    expect(existsSync(join(dir, a.json.file.id))).toBe(false)
  })

  it('входящее принимает filesExpected и filesFailed — агент видит, что файлы ещё грузятся или не приняты', async () => {
    const data = { ...inbox(), inbox: { ...inbox().inbox, filesExpected: 2, filesFailed: [{ name: 'big.zip', reason: 'архивы не принимаются' }] } }
    expect(await importDoc('items', 'i-expect', data, 'test')).toBe('added')
  })

  it('сводка для страницы: файлы по пунктам в порядке загрузки, лимиты, место; без изменений — 304', async () => {
    const itemId = await newItem()
    const a = await upload(owner, itemId, PNG, 'первый.png')
    const b = await upload(owner, itemId, PDF, 'второй.pdf')
    const res = await get(agent, '/files/summary')
    expect(res.status).toBe(200)
    const etag = res.headers.get('etag')!
    const body = await res.json()
    expect(body).toMatchObject({ enabled: true, limits: { maxBytes: 64 * 1024, maxPerItem: 3, retentionDays: 90 } })
    // Занятое место — по всем продуктам: только тому, кто видит все (владелец), агенту продукта — нет (v2-lite).
    expect(body.usage).toBeUndefined()
    const full = (await (await get(owner, '/files/summary')).json()) as { usage: { capBytes: number; warn: boolean; usedBytes: number } }
    expect(full.usage).toMatchObject({ capBytes: 1024 * 1024, warn: false })
    expect(full.usage.usedBytes).toBeGreaterThan(0)
    expect(body.items[itemId]).toEqual({ files: [expect.objectContaining({ id: a.json.file.id, name: 'первый.png' }), expect.objectContaining({ id: b.json.file.id })], count: 2, expired: 0 })
    const again = await app.request('/api/oq/v1/files/summary', { headers: { Authorization: `Bearer ${agent}`, 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    await upload(owner, itemId, Buffer.from('третий'), 'c.txt')
    const changed = await app.request('/api/oq/v1/files/summary', { headers: { Authorization: `Bearer ${agent}`, 'If-None-Match': etag } })
    expect(changed.status).toBe(200)
  })

  it('сводка урезана по строкам — счётчик остаётся у всех пунктов и есть отметка: старый пункт не теряет вложения молча (ревью «Контроля» #313)', async () => {
    const itemId = await newItem()
    for (const [i, body] of [PNG, PDF, Buffer.from('третий файл')].entries()) await upload(owner, itemId, body, `f${i}`)
    const cut = await listAllFiles('*', 2)
    expect(cut.files).toHaveLength(2)
    expect(cut.counts.get(itemId)).toBe(3)
    expect(cut.truncated).toEqual({ files: true, groups: false })
    const whole = await listAllFiles('*', 10_000)
    expect(whole.truncated.files).toBe(false)
  })

  it('не больше 4 загрузок сразу: пятая — 429, место на томе не уходит под временные файлы (линза GLM #313)', async () => {
    const releases: Array<() => void> = []
    const slow = (itemId: string) => {
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      releases.push(release)
      const body = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('медленный '))
          await gate
          ctrl.enqueue(new TextEncoder().encode('файл'))
          ctrl.close()
        },
      })
      const size = Buffer.byteLength('медленный файл')
      return app.request(`/api/oq/v1/files?item=${itemId}`, {
        method: 'POST', body, duplex: 'half',
        headers: { Authorization: `Bearer ${owner}`, 'Content-Length': String(size), 'X-File-Name': 'slow.txt' },
      } as RequestInit)
    }
    const items = await Promise.all([newItem(), newItem(), newItem(), newItem(), newItem()])
    const held = items.slice(0, 4).map(slow)
    await new Promise((r) => setTimeout(r, 50))
    expect((await upload(owner, items[4]!, Buffer.from('пятый'), 'fifth.txt')).status).toBe(429)
    releases.forEach((r) => r())
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([201, 201, 201, 201])
    expect((await upload(owner, items[4]!, Buffer.from('пятый'), 'fifth.txt')).status).toBe(201)
  })

  it('сводку не задолбить: свой лимит, 121-й запрос за минуту — 429 (линза GLM #313)', async () => {
    const burst = (await createToken('summary-burst', ['read'])).token
    const codes: number[] = []
    for (let i = 0; i < 121; i++) codes.push((await get(burst, '/files/summary')).status)
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true)
    expect(codes[120]).toBe(429)
  })

  it('хранилище не настроено — сводка говорит «выключено», а не 503: страница прячет «📎»', async () => {
    setEnvForTests({ oqFiles: { ...getEnv().oqFiles, dir: null } })
    expect(await (await get(reader, '/files/summary')).json()).toEqual({ enabled: false })
  })
})

