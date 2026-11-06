/**
 * API очереди владельца: /api/oq/v1. Документы в формате базы артефакта (страница /queue, агенты, бот),
 * журнал, мёрж и деплой. Доступ — токен очереди или сессия владельца консоли (server/queue/auth.ts).
 */
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { z } from 'zod'
import { apiError } from '../http-types'
import { parseBody } from '../lib/validate'
import { requireQueueActor, requireScope, type QueueEnv } from '../queue/auth'
import { mergeInfo, mergeItem, redeploy } from '../queue/github'
import { beatRelay, readRelay, relayBeatSchema } from '../queue/relay'
import { throttleWrite } from '../queue/throttle'
import { filesRoutes } from './queue-files'
import { etagMatches } from '../queue/etag'
import { collectionTag, deleteDoc, docHistory, getDoc, isCollection, listDocs, listOpenItems, openItemsTag, writeDoc, type Collection, type DocList } from '../queue/store'

const writeSchema = z.object({
  data: z.record(z.unknown()),
  ifVersion: z.number().int().nonnegative().optional(),
  ifAnswerAt: z.string().max(40).optional(),
})
const mergeSchema = z.object({ sha: z.string() })


function collectionOf(raw: string): Collection {
  if (!isCollection(raw)) throw apiError(404, 'Нет такой коллекции: checks, items, work')
  return raw
}

export const queueRoutes = new Hono<QueueEnv>()
queueRoutes.use('*', requireQueueActor)

// Области — и на маршруте, и в хранилище (server/queue/store.ts): одна проверка не держится на другой.
/** Обрезка потолком — полями рядом с docs и только когда она была: обычный ответ байт в байт прежний. */
const listBody = ({ docs, capped }: DocList) => (capped ? { docs, truncated: true, total: capped.total, limit: capped.limit } : { docs })

// Сжатие — только у списка (586 КБ gzip против 2 МБ у items на каждом опросе Нерва). compress ставит тегу W/ —
// поэтому 304 сравнивает слабо (etagMatches). В теле списка нет секретов, CSRF — заголовок, а не токен в теле (BREACH).
queueRoutes.get('/db/:col', requireScope('read', 'agent'), compress({ encoding: 'gzip' }), async (c) => {
  const col = collectionOf(c.req.param('col'))
  // ?open=1 — только открытые владельцу пункты, по тому же правилу, что на странице (MCP oq_list open_only). Ответ
  // зависит и от checks — ETag по обеим коллекциям; open: true — сервер фильтр применил (старый сервер параметр не знает).
  if (col === 'items' && c.req.query('open') === '1') {
    const openTag = await openItemsTag()
    if (etagMatches(c.req.header('if-none-match'), openTag)) return c.body(null, 304, { ETag: openTag })
    c.header('ETag', openTag)
    return c.json({ ...listBody(await listOpenItems()), open: true })
  }
  const tag = await collectionTag(col)
  if (etagMatches(c.req.header('if-none-match'), tag)) return c.body(null, 304, { ETag: tag })
  c.header('ETag', tag)
  return c.json(listBody(await listDocs(col)))
})

queueRoutes.get('/db/:col/:id', requireScope('read', 'agent'), async (c) => {
  const doc = await getDoc(collectionOf(c.req.param('col')), c.req.param('id'))
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
    })
    return c.json(doc)
  })
}

queueRoutes.delete('/db/:col/:id', requireScope('owner'), async (c) => {
  throttleWrite(c.get('oqActor').name)
  await deleteDoc(c.get('oqActor'), collectionOf(c.req.param('col')), c.req.param('id'))
  return c.json({ ok: true })
})

queueRoutes.get('/history/:col/:id', requireScope('read', 'agent'), async (c) => c.json({ events: await docHistory(collectionOf(c.req.param('col')), c.req.param('id')) }))

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
