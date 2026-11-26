import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'

// APP-678: `api.use('*', requireSession)` закрывает весь `/api/*` консоли. В hono до 4.13.16 (GHSA-h7mg-cq63-vhpq)
// шаблон wildcard-мидлвара RegExpRouter был `.*`: он не совпадает с переводом строки (\n, \r, U+2028), а параметр
// маршрута `[^/]+` совпадает. Путь с `%0A` проходил мимо проверки сессии прямо в обработчик. Под `/api/` ответ без
// сессии — только 401; путь, который после разбора уже не под `/api/` (GHSA-jpvv-r467-5p4w, «\»), — 401 или 404.
// Сейчас (18.11, hono 4.13.13) консоль работает на TrieRouter: SmartRouter не собрал RegExpRouter для её набора
// маршрутов, и тест проходит и на старой версии. Он сторожит путь на случай, если набор маршрутов изменится.

let app: Awaited<ReturnType<typeof freshApp>>

beforeAll(async () => {
  app = await freshApp()
})

const BREAKS = ['%0A', '%0D', '%0D%0A', '%E2%80%A8']
const ROUTES = ['/overview', '/infra', '/admin/users', '/settings', '/release', '/maintenance', '/alerts', '/events']
// Маршруты с параметром: здесь старый hono отдавал запрос обработчику без сессии.
const PARAM_ROUTES = ['/incidents/:x', '/monitors/:x', '/reports/:x', '/infra/agents/:x', '/infra/agents/:x/series',
  '/alerts/:x/notes']

const underApi = (): string[] => [
  ...ROUTES.flatMap((r) => [`/api${r}`, ...BREAKS.flatMap((b) => [`/api${r}${b}`, `/api${r}/${b}`])]),
  ...PARAM_ROUTES.flatMap((r) => BREAKS.flatMap((b) => [r.replace(':x', `a${b}b`), r.replace(':x', b)]))
    .map((p) => `/api${p}`),
]
const outsideApi = (): string[] =>
  ROUTES.flatMap((r) => [`/api%0A${r}`, `/api\\${r.slice(1)}`, `/api%5C${r.slice(1)}`])

describe('сессия консоли (APP-678)', () => {
  it('без сессии путь под /api/ с переводом строки — 401, не обработчик', async () => {
    const open: string[] = []
    for (const path of underApi()) {
      const res = await app.request(path)
      if (res.status !== 401) open.push(`${path} → ${res.status}`)
    }
    expect(open).toEqual([])
  })

  it('без сессии путь с «\\» или переводом строки до /api/ — 401 или 404, не данные', async () => {
    const open: string[] = []
    for (const path of outsideApi()) {
      const res = await app.request(path)
      if (res.status !== 401 && res.status !== 404) open.push(`${path} → ${res.status}`)
    }
    expect(open).toEqual([])
  })
})
