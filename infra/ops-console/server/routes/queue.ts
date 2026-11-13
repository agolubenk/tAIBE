/**
 * API очереди владельца: /api/oq/v1. Документы в формате базы артефакта (страница /queue, агенты, бот),
 * журнал, мёрж и деплой. Доступ — токен очереди или сессия владельца консоли (server/queue/auth.ts).
 */
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { apiError } from '../http-types'
import { parseBody } from '../lib/validate'
import { requireQueueActor, requireScope, type QueueEnv } from '../queue/auth'
import { mergeInfo, mergeItem, redeploy } from '../queue/github'
import { beatProduct, beatRelay, readRelay, relayBeatSchema } from '../queue/relay'
import { acceptNotify, notifySchema } from '../queue/notify'
import { throttleNotify, throttleWrite } from '../queue/throttle'
import { filesRoutes } from './queue-files'
import { etagMatches } from '../queue/etag'
import { acceptsGzip, gzipListOnce } from '../queue/list-gzip'
import { collectionTag, listDocs, listOpenItems, openItemsTag, type DocList } from '../queue/list'
import { changeItemProduct } from '../queue/product-change'
import { recentPrs } from '../queue/prs'
import { canSee, DEFAULT_PRODUCT, listProducts, PRODUCT_BOARDS, PRODUCT_SLUG, visibilityKey, type Visibility } from '../queue/products'
import { SESSION_MAX, deleteDoc, docHistory, getDoc, isCollection, writeDoc, type Collection } from '../queue/store'

const writeSchema = z.object({
  data: z.record(z.unknown()),
  ifVersion: z.number().int().nonnegative().optional(),
  ifAnswerAt: z.string().max(40).optional(),
  /** Входящее: перехват захвата у названной сессии (наследник) и отпуск своего захвата (queue/store.ts). */
  takeover: z.string().min(1).max(SESSION_MAX).optional(),
  release: z.boolean().optional(),
})
const mergeSchema = z.object({ sha: z.string(), version: z.number().int().nonnegative().optional() })
const productChangeSchema = z.object({ to: z.string().regex(PRODUCT_SLUG), reason: z.string().max(500).optional() })

function withProductFilter(products: Visibility, slug: string | undefined): Visibility {
  if (slug === undefined || slug === '') return products
  return PRODUCT_SLUG.test(slug) && canSee(products, slug) ? [slug] : []
}


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
  // Ключ кэша сжатого тела — с видимостью: у токенов разных продуктов разные списки. ?product=<slug> — только этот
  // продукт из видимых (фильтр владельца, параметр product у MCP); невидимый — пустой список, как несуществующий.
  const products = withProductFilter(c.get('oqActor').products, c.req.query('product'))
  const vis = visibilityKey(products)
  if (col === 'items' && c.req.query('open') === '1') {
    return listResponse(c, `items?open=1|${vis}`, await openItemsTag(products), async () => ({ ...listBody(await listOpenItems(products)), open: true }))
  }
  return listResponse(c, `${col}|${vis}`, await collectionTag(col, products), async () => listBody(await listDocs(col, products)))
})

/** Продукт пункта меняет владелец (страница, бот): пункт и ответ — одной транзакцией (queue/product-change.ts). */
queueRoutes.post('/items/:id/product', requireScope('owner'), async (c) => {
  throttleWrite(c.get('oqActor').name)
  const body = await parseBody(c, productChangeSchema)
  return c.json(await changeItemProduct(c.get('oqActor'), c.req.param('id'), body.to, body.reason ?? ''))
})

/**
 * Продукты, которые видит актор: метка и фильтр страницы, параметр product у MCP. boards — пространства t-boards продукта:
 * по ним страница относит строки «Хода работ» к продукту (product-boards.ts); default — продукт строк без столбца product,
 * его доска пишет сводку карточек в прежний work/cards-stats (infra/ai-council/cards_stats.py).
 */
queueRoutes.get('/products', requireScope('read', 'agent'), async (c) => {
  const products = c.get('oqActor').products
  return c.json({
    default: DEFAULT_PRODUCT,
    products: (await listProducts())
      .filter((p) => canSee(products, p.slug))
      .map((p) => ({ ...p, boards: [...(PRODUCT_BOARDS[p.slug] ?? [])] })),
  })
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
      takeover: body.takeover,
      release: body.release,
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
// По продуктам (фаза 4a, OPS-51): актор видит сессии только своих продуктов и отмечается только за видимый продукт.
queueRoutes.get('/relay', requireScope('read', 'agent'), async (c) => c.json(await readRelay(c.get('oqActor').products)))
queueRoutes.put('/relay', requireScope('agent'), async (c) => {
  const actor = c.get('oqActor')
  throttleWrite(actor.name)
  const beat = await parseBody(c, relayBeatSchema)
  const product = beatProduct(actor.products, beat.product)
  // Чужой продукт — как несуществующий (404); свой, но не определить (токен нескольких продуктов без основного) — 422.
  if (!product) throw beat.product ? apiError(404, 'Нет автопередачи для продуктов токена') : apiError(422, 'Укажите product: токен видит несколько продуктов')
  return c.json(await beatRelay(beat, product, actor.products))
})

// PR репозитория консоли для графика «Сколько PR ждали мёржа» (queue/prs.ts). Репозиторий — HR: токен без HR — 404.
// Тег — время сборки кэша: повторный опрос страницы до новой сборки — 304 без тела.
queueRoutes.get('/prs', requireScope('read', 'agent'), async (c) => {
  const list = await recentPrs(c.get('oqActor').products)
  if (!list) throw apiError(404, 'Нет PR для продуктов токена: репозиторий консоли — HR')
  return listResponse(c, 'prs', `W/"prs-${Date.parse(list.at).toString(36)}"`, async () => list)
})

queueRoutes.get('/merge/:itemId', requireScope('owner'), async (c) => c.json(await mergeInfo(c.req.param('itemId'))))

queueRoutes.post('/merge/:itemId', requireScope('owner'), async (c) => {
  const body = await parseBody(c, mergeSchema)
  return c.json(await mergeItem(c.get('oqActor'), c.req.param('itemId'), body.sha, body.version))
})

queueRoutes.post('/redeploy', requireScope('owner'), async (c) => c.json({ message: await redeploy(c.get('oqActor')) }))

// События 2FA от backend продукта (queue/notify.ts): токен notify (или owner), 30 в час на токен — до разбора
// тела, ответ 202 до доставки. Повтор login + event + минута — тоже 202, но без второго сообщения.
queueRoutes.post(
  '/notify',
  requireScope('notify'),
  async (c, next) => {
    throttleNotify(c.get('oqActor').name)
    await next()
  },
  bodyLimit({
    maxSize: 4096,
    onError: () => {
      throw apiError(413, 'Слишком большой запрос')
    },
  }),
  async (c) => {
    const body = await parseBody(c, notifySchema)
    const fresh = acceptNotify(body, c.get('oqActor').name)
    return c.json({ accepted: true, duplicate: !fresh }, 202)
  },
)

// Вложения входящих: загрузка — владелец, список — read/agent, содержимое — agent/owner (routes/queue-files.ts).
queueRoutes.route('/files', filesRoutes)
