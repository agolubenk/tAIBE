/**
 * Пункты очереди владельца, связанные с деплоем, — колонка «Связь» на /deploys. Отдаются только роли owner: права на
 * очередь у сессии консоли есть лишь у неё (server/queue/auth.ts), а деплои видит любая роль.
 *
 * Связь — по номеру PR из заголовка деплоя («Merge pull request #N …», «… (#N)») и по выкаченному коммиту:
 * - мёрж — только свой PR (поле pr или «gh pr merge N» в команде — как у мёржа из очереди) или событие «Влить» из
 *   очереди с этим коммитом: соседние мёржи пишут «после #N» в заголовке, но выкатываются своим деплоем;
 * - остальные — N в поле pr, в заголовке или в ссылке на PR своего репозитория; по тексту (номер, короткий SHA от
 *   7 знаков) — только если пункт касается не больше трёх PR и трёх коммитов: обзорные пункты на десятки PR связью не
 *   считаются (сверено с очередью 30.10: до 21 PR в одном тексте).
 * Ручной запуск (Run workflow, в т.ч. откат) связывается только по PR — то есть ни с чем: его headSha — вершина main,
 * а не выкаченный коммит (server/deploys/github.ts), и откат показывал бы «Влить #N ✓» того, что откатил.
 * Архивные пункты — нет: страница очереди их не показывает, ссылка вела бы в пустоту.
 */
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { getDb } from '../db/client'
import { oqDocs, oqEvents } from '../db/schema'
import { mergePlan } from '../queue/github'
import { oqItemState } from '../queue/open-rule'
import { collectionTag, listDocs } from '../queue/list'
import { DEFAULT_PRODUCT } from '../queue/products'
import { MANUAL_RUN_TITLE } from './github'

export interface QueueLink {
  id: string
  kind: string
  title: string
  done: boolean
}

export interface DeployQueueLinks {
  links: QueueLink[]
  /** Сколько связанных пунктов не показано (сверх LINKS_PER_DEPLOY). */
  more: number
}

interface DeployRef {
  id: number
  title: string
  headSha: string
}

interface ItemRefs {
  id: string
  kind: string
  title: string
  /** PR, о котором пункт: поле pr, номер в заголовке, ссылка на PR. */
  prs: Set<number>
  /** PR, упомянутые только в тексте. */
  textPrs: Set<number>
  /** Шестнадцатеричные токены текста от 7 знаков с цифрой — кандидаты в короткий SHA. */
  shas: string[]
}

export const LINKS_PER_DEPLOY = 6
const TEXT_MAX_REFS = 3
// Ячейка показывает две строки (~60 знаков), полный заголовок — в подсказке: 100 знаков хватает, а ответ /deploys
// опрашивается раз в минуту без сжатия (gzip для API выключен — BREACH).
const TITLE_MAX = 100
const KIND_ORDER = ['merge', 'check', 'decision', 'server', 'inbox']

const str = (v: unknown) => (typeof v === 'string' ? v : '')
// «&#8212;» в старых пунктах с HTML — не PR.
const hashNums = (s: string) => [...s.matchAll(/(?<!&)#(\d{1,6})(?!\d)/g)].map((m) => Number(m[1]))
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Номера из ссылок на PR: своего репозитория, а без настроенного — любого. */
const pullNums = (s: string, repo: string) =>
  [...s.matchAll(new RegExp(`github\\.com\\/${repo ? escapeRe(repo) : '[\\w.-]+\\/[\\w.-]+'}\\/pull\\/(\\d{1,6})(?!\\d)`, 'g'))].map((m) =>
    Number(m[1]),
  )
// По кодовым точкам: slice по UTF-16 режет эмодзи пополам.
const clip = (s: string, n: number) => (s.length <= n ? s : Array.from(s).slice(0, n).join(''))

/** Номера PR деплоя по заголовку коммита: merge-коммит PR или «(#N)» squash-коммита. */
export function deployPrs(title: string): number[] {
  const merge = /^Merge pull request #(\d{1,6})(?!\d)/.exec(title)
  if (merge) return [Number(merge[1])]
  return [...new Set([...title.matchAll(/\(#(\d{1,6})\)/g)].map((m) => Number(m[1])))].slice(0, 3)
}

export function itemRefs(id: string, d: Record<string, unknown>, repo = ''): ItemRefs {
  const kind = str(d.kind)
  const title = clip(str(d.title), TITLE_MAX)
  if (kind === 'merge') {
    // Тот же источник номера, что у мёржа из очереди; у пунктов без pr и команды — первый «#N» заголовка «Влить #N …».
    const own = mergePlan(d).pr ?? hashNums(str(d.title))[0]
    return { id, kind, title, prs: new Set(own ? [own] : []), textPrs: new Set(), shas: [] }
  }
  const pr = typeof d.pr === 'number' ? [d.pr] : []
  const links = Array.isArray(d.links) ? d.links.map((l) => str((l as Record<string, unknown> | null)?.href)).join(' ') : ''
  const text = `${str(d.body)}\n${str(d.after)}`
  const prs = new Set([...pr, ...hashNums(str(d.title)), ...pullNums(links, repo)])
  const textPrs = new Set([...hashNums(text), ...pullNums(text, repo)].filter((n) => !prs.has(n)))
  const shas = [...new Set([...`${str(d.title)}\n${text}`.matchAll(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g)].map((m) => m[0]))]
  return { id, kind, title, prs, textPrs, shas }
}

/** Связан ли пункт с деплоем PR из prs и коммитом sha (12 знаков, как в таблице deploys; '' — коммит неизвестен). */
export function isLinked(r: ItemRefs, prs: number[], sha: string): boolean {
  if (prs.some((n) => r.prs.has(n))) return true
  if (r.kind === 'merge') return false
  if (r.prs.size + r.textPrs.size > TEXT_MAX_REFS || r.shas.length > TEXT_MAX_REFS) return false
  if (prs.some((n) => r.textPrs.has(n))) return true
  return sha.length >= 7 && r.shas.some((t) => (t.length <= sha.length ? sha.startsWith(t) : t.startsWith(sha)))
}

// Индекс ссылок пунктов — заново только при записи в items: /deploys опрашивается раз в минуту, а вся очередь — около
// мегабайта JSON (30.10: 475 пунктов, 886 КБ). ETag коллекции — один агрегатный запрос; одновременные промахи
// (две вкладки, опрос и фокус окна) ждут одну пересборку.
let indexCache: { db: unknown; key: string; refs: ItemRefs[] } | null = null
let indexBuild: { key: string; done: Promise<ItemRefs[]> } | null = null

async function itemIndex(repo: string): Promise<ItemRefs[]> {
  const db = getDb()
  // Только пункты HR: деплои — репозитория HR, номер PR другого продукта совпал бы с чужим PR (как у мёржа, github.ts).
  const key = `${repo}|${await collectionTag('items', [DEFAULT_PRODUCT])}`
  if (indexCache && indexCache.db === db && indexCache.key === key) return indexCache.refs
  if (indexBuild?.key === key) return indexBuild.done
  const done = (async () => {
    // Тот же список, что у страницы очереди (порядок и лимит): ссылка не ведёт на пункт, которого она не покажет.
    // Все неархивные, а не только с номерами: мёрж из очереди находится и по событию «Влить» (mergedFromQueue).
    const refs = (await listDocs('items', [DEFAULT_PRODUCT])).docs.filter((doc) => doc.data.archived !== true).map((doc) => itemRefs(doc.id, doc.data, repo))
    indexCache = { db, key, refs }
    return refs
  })()
  indexBuild = { key, done }
  try {
    return await done
  } finally {
    if (indexBuild?.done === done) indexBuild = null
  }
}

// Пункты «Влить», влитые из очереди: полный SHA merge-коммита → id пункта. Журнал только дописывается, поэтому
// читаются лишь новые записи — диапазон по первичному ключу: индекса по action нет, а фильтр по collection увёл бы
// планировщик на idx_oq_events_doc, то есть на всю историю пунктов при каждом опросе.
const MERGES_KEPT = 5000
let mergeCache: { db: unknown; lastId: number; merged: Map<string, string> } | null = null

async function mergedFromQueue(): Promise<Map<string, string>> {
  const db = getDb()
  if (mergeCache?.db !== db) mergeCache = { db, lastId: 0, merged: new Map() }
  const cache = mergeCache
  for (;;) {
    const rows = await db
      .select({ id: oqEvents.id, collection: oqEvents.collection, docId: oqEvents.docId, afterJson: oqEvents.afterJson })
      .from(oqEvents)
      .where(and(gt(oqEvents.id, cache.lastId), eq(oqEvents.action, 'merge')))
      .orderBy(asc(oqEvents.id))
      .limit(500)
    for (const r of rows) {
      cache.lastId = Math.max(cache.lastId, r.id)
      if (r.collection !== 'items') continue
      let sha = ''
      try {
        sha = str((JSON.parse(r.afterJson ?? '{}') as Record<string, unknown> | null)?.mergeSha)
      } catch {
        // Битая запись журнала не должна ронять /deploys: курсор уже за ней.
      }
      if (sha) cache.merged.set(sha, r.docId)
    }
    if (rows.length < 500) break
  }
  for (const sha of cache.merged.keys()) {
    if (cache.merged.size <= MERGES_KEPT) break
    cache.merged.delete(sha)
  }
  return cache.merged
}

export async function queueLinksForDeploys(deploys: DeployRef[], repo = ''): Promise<Map<number, DeployQueueLinks>> {
  const out = new Map<number, DeployQueueLinks>()
  if (!deploys.length) return out
  const [refs, merged] = await Promise.all([itemIndex(repo), mergedFromQueue()])
  const byId = new Map(refs.map((r) => [r.id, r]))
  const linked = new Map<number, ItemRefs[]>()
  for (const d of deploys) {
    const prs = deployPrs(d.title)
    const sha = d.title !== MANUAL_RUN_TITLE && d.headSha.length >= 7 ? d.headSha : ''
    const hits = refs.filter((r) => isLinked(r, prs, sha))
    if (sha) {
      for (const [full, docId] of merged) {
        const r = byId.get(docId)
        if (full.startsWith(sha) && r && !hits.includes(r)) hits.push(r)
      }
    }
    if (hits.length) linked.set(d.id, hits)
  }
  const ids = [...new Set([...linked.values()].flat().map((r) => r.id))]
  const answers = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await getDb()
      .select({ id: oqDocs.id, dataJson: oqDocs.dataJson })
      .from(oqDocs)
      .where(and(eq(oqDocs.collection, 'checks'), inArray(oqDocs.id, ids.slice(i, i + 500))))
    for (const r of rows) answers.set(r.id, JSON.parse(r.dataJson) as Record<string, unknown>)
  }
  for (const [deployId, hits] of linked) {
    // Открытые — первыми: шесть выполненных проверок не должны прятать открытое решение в «и ещё N».
    const links = hits
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title, done: oqItemState(r.kind, answers.get(r.id)) === 'done' }))
      .sort((a, b) => Number(a.done) - Number(b.done) || rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id))
    out.set(deployId, { links: links.slice(0, LINKS_PER_DEPLOY), more: Math.max(0, links.length - LINKS_PER_DEPLOY) })
  }
  return out
}

function rank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind)
  return i < 0 ? KIND_ORDER.length : i
}
