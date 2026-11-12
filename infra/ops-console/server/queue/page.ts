/**
 * Страница очереди владельца /queue — страница артефакта claude.ai (page.html), перенесённая как есть,
 * с базой консоли вместо базы артефакта (page-scripts.ts) и вложениями входящих (page-files.ts). Доступ — сессия
 * владельца или токен очереди (бот очереди открывает страницу с Bearer-заголовком на каждый запрос к консоли).
 *
 * Скрипты — внешними файлами /queue/assets/<имя>.<хэш содержимого>.js. Браузер кэширует их надолго (private,
 * immutable) и при повторном открытии не скачивает: раньше они шли инлайном под одноразовым nonce, около 68 КБ gzip
 * на каждое открытие. Порядок и места тегов прежние. CSP — без nonce и без unsafe-inline: script-src разрешает только
 * каталог /queue/assets/ этого хоста и хэш короткого скрипта темы в <head> (он срабатывает до первой отрисовки).
 * Каталог, а не 'self': файлы вложений отдаются с того же хоста с типом, который прислал загрузивший. Ассеты — с той
 * же авторизацией, что и страница: в коде страницы есть пункты-примеры владельца.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE } from '../auth/session'
import { notifyOnly, resolveActor } from './auth'
import { ENHANCE_JS, SHIM_JS } from './page-scripts'
import { FILES_JS } from './page-files'
import { LANES_JS } from './page-lanes'
import { PRODUCTS_JS } from './page-products'
import { REPORTS_JS } from './page-reports'
import { OPEN_RULE_JS } from './open-rule'

export const QUEUE_ASSETS = '/queue/assets/'

type Built = { html: string; assets: Map<string, string>; themeHash: string }

let built: Built | null = null

function sha256(text: string, encoding: 'hex' | 'base64'): string {
  return createHash('sha256').update(text, 'utf8').digest(encoding)
}

/** Тег внешнего скрипта; имя несёт хэш содержимого — новая версия получает новый адрес, старый кэш не мешает. */
function scriptTag(assets: Map<string, string>, base: string, body: string): string {
  const name = `${base}.${sha256(body, 'hex').slice(0, 16)}.js`
  assets.set(name, body)
  return `<script src="${QUEUE_ASSETS}${name}"></script>`
}

export function queuePageBuild(): Built {
  if (built) return built
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'page.html'), 'utf8')
  // В page.html два скрипта: тема в <head> (до первой отрисовки, DOM не трогает) и код страницы — первый <script>
  // после </main>. Третий скрипт без правки этой функции ушёл бы инлайном и был бы заблокирован CSP — поэтому отказ.
  const mainEnd = html.indexOf('</main>')
  const themeOpen = html.indexOf('<script>')
  const themeClose = html.indexOf('</script>', themeOpen)
  const first = html.indexOf('<script>', mainEnd)
  const firstClose = html.indexOf('</script>', first)
  const end = html.lastIndexOf('</body>')
  if (mainEnd < 0 || themeOpen < 0 || themeOpen > mainEnd || first < 0 || firstClose < 0 || end < firstClose) {
    throw new Error('page.html: нет скрипта темы до </main>, кода страницы после него или </body>')
  }
  if ((html.match(/<script/g) ?? []).length !== 2) throw new Error('page.html: ожидалось ровно два <script> (тема и код страницы)')
  const assets = new Map<string, string>()
  // Подмена базы, правило «открыт ли пункт» (oqItemState — то же, что у GET /db/items?open=1), вложения, данные и
  // группировка «Хода работ» — до кода страницы (она берёт window.__oqFiles, __oqReports и __oqLanes), кнопки мёржа — после.
  const page =
    html.slice(0, first) +
    scriptTag(assets, 'shim', SHIM_JS) + '\n' +
    scriptTag(assets, 'open-rule', OPEN_RULE_JS) + '\n' +
    scriptTag(assets, 'files', FILES_JS) + '\n' +
    scriptTag(assets, 'reports', REPORTS_JS) + '\n' +
    scriptTag(assets, 'lanes', LANES_JS) + '\n' +
    scriptTag(assets, 'page', html.slice(first + '<script>'.length, firstClose)) +
    html.slice(firstClose + '</script>'.length, end) +
    scriptTag(assets, 'enhance', ENHANCE_JS) + '\n' +
    scriptTag(assets, 'products', PRODUCTS_JS) + '\n' +
    html.slice(end)
  built = { html: page, assets, themeHash: sha256(html.slice(themeOpen + '<script>'.length, themeClose), 'base64') }
  return built
}

/**
 * Хост для CSP — как его прислал браузер, с портом (localhost:8797 в разработке): источник без порта совпадает только
 * с портом схемы по умолчанию. Заголовок попадает в CSP, поэтому только имя и порт; иначе — 'self'.
 */
function cspHost(c: Context): string {
  const host = (c.req.header('host') ?? '').trim().toLowerCase()
  return /^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/.test(host) ? host : "'self'"
}

export function queueCsp(host: string, themeHash: string): string {
  const scripts = host === "'self'" ? "'self'" : `${host}${QUEUE_ASSETS}`
  return [
    "default-src 'none'",
    `script-src ${scripts} 'sha256-${themeHash}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export async function queuePage(c: Context) {
  const actor = await resolveActor(c.req.header('authorization'), getCookie(c, SESSION_COOKIE))
  if (!actor || notifyOnly(actor)) return c.redirect('/login?next=%2Fqueue', 302)
  const { html, themeHash } = queuePageBuild()
  c.header('Content-Security-Policy', queueCsp(cspHost(c), themeHash))
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  return c.html(html)
}

export async function queueAsset(c: Context) {
  const actor = await resolveActor(c.req.header('authorization'), getCookie(c, SESSION_COOKIE))
  if (!actor || notifyOnly(actor)) return c.text('Unauthorized', 401, { 'Cache-Control': 'no-store' })
  const body = queuePageBuild().assets.get(c.req.param('name') ?? '')
  if (body === undefined) return c.text('Not Found', 404, { 'Cache-Control': 'no-store' })
  return c.body(body, 200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
}
