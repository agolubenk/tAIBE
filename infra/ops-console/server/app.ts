/**
 * HTTP-приложение консоли (Hono): одно и то же для локального сервера (server/local.ts)
 * и для Vercel Function (api/[[...route]].ts).
 */
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { hostAllowed, isQueueAliasHost, QUEUE_ALIAS_PATH_RE, requestHost, type AppEnv } from './http-types'
import { getEnv } from './env'
import { requireSession } from './auth/middleware'
import { authRoutes } from './routes/auth'
import { agentInstallRoutes, agentRoutes, cronRoutes } from './routes/agent'
import { overviewRoutes } from './routes/overview'
import { infraRoutes } from './routes/infra'
import { monitorRoutes } from './routes/monitors'
import { alertRoutes } from './routes/alerts'
import { incidentRoutes } from './routes/incidents'
import { channelRoutes } from './routes/channels'
import { adminRoutes } from './routes/admin'
import { settingsRoutes } from './routes/settings'
import { reportRoutes } from './routes/reports'
import { eventRoutes } from './routes/events'
import { releaseRoutes } from './routes/release'
import { publicRoutes } from './routes/public'
import { telegramPublicRoutes, telegramRoutes } from './routes/telegram'
import { maintenanceRoutes } from './routes/maintenance'
import { MINI_APP_HTML } from './telegram/miniapp'
import { queueRoutes } from './routes/queue'
import { queueAsset, queuePage } from './queue/page'

export function createApp() {
  const app = new Hono<AppEnv>()

  // Только свои имена: по IP сервера или чужому домену консоль не открывается (421).
  app.use('*', async (c, next) => {
    const { allowedHosts } = getEnv()
    if (!hostAllowed(requestHost(c), allowedHosts)) return c.text('Misdirected Request', 421)
    await next()
  })
  // Короткий адрес очереди — только очередь и вход, даже если путь прошёл nginx: Node разбирает «\» как «/» и
  // сворачивает «..», nginx — нет, и одного списка nginx для защиты мало.
  app.use('*', async (c, next) => {
    const { allowedHosts, publicUrl } = getEnv()
    if (isQueueAliasHost(requestHost(c), allowedHosts, publicUrl) && !QUEUE_ALIAS_PATH_RE.test(c.req.path)) return c.notFound()
    await next()
  })
  app.use('/api/*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }))
  app.use('/api/*', async (c, next) => {
    await next()
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store')
  })

  app.get('/api/health', (c) => c.json({ ok: true }))
  // Mini App ввода пароля бота — своя лёгкая страница, не SPA (см. server/telegram/miniapp.ts).
  app.get('/tg/password', (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    return c.html(MINI_APP_HTML)
  })
  app.route('/api/auth', authRoutes)
  app.route('/api/agent', agentRoutes)
  app.route('/agent', agentInstallRoutes)
  app.route('/api/cron', cronRoutes)
  app.route('/api/public', publicRoutes)
  // Вебхук Telegram и ввод пароля из Mini App — до api: requireSession их бы закрыл (401 → ретраи).
  app.route('/api/telegram', telegramPublicRoutes)
  // Очередь владельца — до api: туда ходят и агенты/бот по токену, без сессии консоли.
  app.route('/api/oq/v1', queueRoutes)
  app.get('/queue', queuePage)
  app.get('/queue/assets/:name', queueAsset)

  const api = new Hono<AppEnv>()
  api.use('*', requireSession)
  api.route('/overview', overviewRoutes)
  api.route('/infra', infraRoutes)
  api.route('/monitors', monitorRoutes)
  api.route('/alerts', alertRoutes)
  api.route('/incidents', incidentRoutes)
  api.route('/channels', channelRoutes)
  api.route('/admin', adminRoutes)
  api.route('/settings', settingsRoutes)
  api.route('/reports', reportRoutes)
  api.route('/events', eventRoutes)
  api.route('/release', releaseRoutes)
  api.route('/telegram', telegramRoutes)
  api.route('/maintenance', maintenanceRoutes)
  app.route('/api', api)

  app.notFound((c) => c.json({ error: 'Не найдено' }, 404))
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    console.error('[ops] unhandled', c.req.method, c.req.path, err)
    return c.json({ error: 'Внутренняя ошибка консоли' }, 500)
  })
  return app
}
