/**
 * API очереди владельца: /api/oq/v1. Документы в формате базы артефакта (страница /queue, агенты, бот),
 * журнал, мёрж и деплой. Доступ — токен очереди или сессия владельца консоли (server/queue/auth.ts).
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { apiError } from '../http-types'
import { parseBody } from '../lib/validate'
import { requireQueueActor, requireScope, type QueueEnv } from '../queue/auth'
import { mergeInfo, mergeItem, redeploy } from '../queue/github'
import { beatRelay, readRelay, relayBeatSchema } from '../queue/relay'
import { throttleWrite } from '../queue/throttle'
import { filesRoutes } from './queue-files'
import { etagMatches } from '../queue/etag'
import { acceptsGzip, gzipListOnce } from '../queue/list-gzip'
import { collectionTag, listDocs, listOpenItems, openItemsTag, type DocList } from '../queue/list'
import { canSee, listProducts, PRODUCT_SLUG, visibilityKey } from '../queue/products'
import { deleteDoc, docHistory, getDoc, isCollection, writeDoc, type Collection } from '../queue/store'

const writeSchema = z.object({
  data: z.record(z.unknown()),
  ifVersion: z.number().int().nonnegative().optional(),
  ifAnswerAt: z.string().max(40).optional(),
  /** Продукт нового документа (v2-lite): владельцу и токену с несколькими продуктами; у существующего — его же. */
  product: z.string().regex(PRODUCT_SLUG).optional(),
})
const mergeSchema = z.object({ sha: z.string() })


function collectionOf(raw: string): Collection {
  if (!isCollection(raw)) throw apiError(404, 'Нет такой коллекции: checks, items, work')
  return raw
}

export const queueRoutes = new Hono<QueueEnv>()
queueRoutes.use('*', requireQueueActor)

// Области — и на маршруте, и в хранилище (server/queue/store.ts): одна проверка не держится на другой.
/** Обрезка потолком — полями рядом с docs и только когда она была: без обрезки JSON прежний, только { docs }. */
const listBody = ({ docs, capped }: DocList) => (capped ? { docs, truncated: true, total: capped.total, limit: capped.limit } : { docs })

/**
 * Список с тегом: совпал If-None-Match — 304; иначе JSON, сжатый один раз на тег (queue/list-gzip.ts), если клиент
 * принимает gzip. 304 и 200 несут одни ETag и Vary (RFC 9110 §15.4.5).
 * BREACH: в теле списка нет секретов, CSRF — заголовок, а не токен в теле.
 */
async function listResponse(c: Context<QueueEnv>, key: string, tag: string, build: () => Promise<unknown>) {
  const headers = { ETag: tag, Vary: 'Accept-Encoding' }
  if (etagMatches(c.req.header('if-none-match'), tag)) return c.body(null, 304, headers)
  if (!acceptsGzip(c.req.header('accept-encoding'))) return c.json(await build(), 200, headers)
  const gz = gzipListOnce(key, tag, build)
  return c.body(await gz.body, 200, { ETag: gz.tag, Vary: 'Accept-Encoding', 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
}

queueRoutes.get('/db/:col', requireScope('read', 'agent'), async (c) => {
  const col = collectionOf(c.req.param('col'))
  // ?open=1 — только открытые владельцу пункты, по тому же правилу, что на странице (MCP oq_list open_only). Ответ
  // зависит и от checks — ETag по обеим коллекциям; open: true — сервер фильтр применил (старый сервер параметр не знает).
  // Ключ кэша сжатого тела — с видимостью: у токенов разных продуктов разные списки.
  const products = c.get('oqActor').products
  const vis = visibilityKey(products)
  if (col === 'items' && c.req.query('open') === '1') {
    return listResponse(c, `items?open=1|${vis}`, await openItemsTag(products), async () => ({ ...listBody(await listOpenItems(products)), open: true }))
  }
  return listResponse(c, `${col}|${vis}`, await collectionTag(col, products), async () => listBody(await listDocs(col, products)))
})

/** Продукты, которые видит актор: метка и фильтр страницы, параметр product у MCP. */
queueRoutes.get('/products', requireScope('read', 'agent'), async (c) => {
  const products = c.get('oqActor').products
  return c.json({ products: (await listProducts()).filter((p) => canSee(products, p.slug)) })
})

queueRoutes.get('/db/:col/:id', requireScope('read', 'agent'), async (c) => {
  const doc = await getDoc(collectionOf(c.req.param('col')), c.req.param('id'), c.get('oqActor').products)
  if (!doc) throw apiError(404, 'Нет такого документа')
  return c.json(doc)
})

for (const [method, merge] of [['put', false], ['patch', true]] as const) {
  queueRoutes[method]('/db/:col/:id', requireScope('agent'), async (c) => {
    const actor = c.get('oqActor')
    throttleWrite(actor.name)
    const body = await parseBody(c, writeSchema)
    const doc = await writeDoc(actor, collectionOf(c.req.param('col')), c.req.param('id'), body.data, {
      merge,
      ifVersion: body.ifVersion,
      ifAnswerAt: body.ifAnswerAt,
      product: body.product,
    })
    return c.json(doc)
  })
}

queueRoutes.delete('/db/:col/:id', requireScope('owner'), async (c) => {
  throttleWrite(c.get('oqActor').name)
  await deleteDoc(c.get('oqActor'), collectionOf(c.req.param('col')), c.req.param('id'))
  return c.json({ ok: true })
})

queueRoutes.get('/history/:col/:id', requireScope('read', 'agent'), async (c) => c.json({ events: await docHistory(collectionOf(c.req.param('col')), c.req.param('id'), c.get('oqActor').products) }))

// Автопередача входящих сессии (queue/relay.ts): отметка процесса `server.mjs --relay` и состояние для страницы и бота.
queueRoutes.get('/relay', requireScope('read', 'agent'), async (c) => c.json(await readRelay()))
queueRoutes.put('/relay', requireScope('agent'), async (c) => {
  throttleWrite(c.get('oqActor').name)
  return c.json(await beatRelay(await parseBody(c, relayBeatSchema)))
})

queueRoutes.get('/merge/:itemId', requireScope('owner'), async (c) => c.json(await mergeInfo(c.req.param('itemId'))))

queueRoutes.post('/merge/:itemId', requireScope('owner'), async (c) => {
  const body = await parseBody(c, mergeSchema)
  return c.json(await mergeItem(c.get('oqActor'), c.req.param('itemId'), body.sha))
})

queueRoutes.post('/redeploy', requireScope('owner'), async (c) => c.json({ message: await redeploy(c.get('oqActor')) }))

// Вложения входящих: загрузка — владелец, список — read/agent, содержимое — agent/owner (routes/queue-files.ts).
queueRoutes.route('/files', filesRoutes)
