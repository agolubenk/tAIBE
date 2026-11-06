/**
 * Продукты очереди (v2-lite, план мультипродуктовой очереди, фаза 3): что видит актор и какой продукт получает документ.
 * Одна точка для store, вложений и мёржа: запрос документов без видимости актора не строится. Чужой документ — 404, как
 * несуществующий: существование пункта другого продукта не раскрывается.
 * Это защита от ошибок сессий, а не от враждебной: Keychain на Mac общий (план, «Цель и границы»).
 */
import { asc, inArray, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import { oqDocs, oqProducts } from '../db/schema'
import { apiError } from '../http-types'

export const DEFAULT_PRODUCT = 'hr-helper'
export const PRODUCT_SLUG = /^[a-z][a-z0-9-]{1,30}$/

/** '*' — все продукты (владелец), иначе slug продуктов. Пустой список — не видит ничего. */
export type Visibility = '*' | readonly string[]

export interface Product {
  slug: string
  name: string
  isDefault: boolean
}

/** Видимость токена по столбцу products: владелец видит всё; «*» без owner не принимается — запрет по умолчанию. */
export function tokenVisibility(scopes: readonly string[], productsJson: string): Visibility {
  if (scopes.includes('owner')) return '*'
  try {
    const v = JSON.parse(productsJson) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((p): p is string => typeof p === 'string' && PRODUCT_SLUG.test(p))
  } catch {
    return []
  }
}

export function canSee(products: Visibility, product: string): boolean {
  return products === '*' || products.includes(product)
}

/** Условие SQL на продукт документа; undefined — без условия (видит всё). */
export function productWhere(products: Visibility): SQL | undefined {
  return products === '*' ? undefined : inArray(oqDocs.product, [...products])
}

/** Ключ видимости — для ETag и кэша сжатого списка: у разных наборов продуктов разные тела. */
export function visibilityKey(products: Visibility): string {
  return products === '*' ? '*' : [...products].sort().join(',')
}

export async function listProducts(): Promise<Product[]> {
  const rows = await getDb().select().from(oqProducts).orderBy(asc(oqProducts.slug))
  return rows.map((r) => ({ slug: r.slug, name: r.name, isDefault: r.isDefault }))
}

async function defaultProduct(): Promise<string> {
  return (await listProducts()).find((p) => p.isDefault)?.slug ?? DEFAULT_PRODUCT
}

/**
 * Продукт нового документа: единственный продукт токена; владельцу и токену с несколькими продуктами — `requested`
 * (поле запроса, не data) или продукт по умолчанию. Неизвестный или невидимый продукт — 422.
 */
export async function productForNew(products: Visibility, requested: string | undefined): Promise<string> {
  if (!requested && products !== '*' && products.length === 1) return products[0]!
  const slug = requested ?? (await defaultProduct())
  if (!(await listProducts()).some((p) => p.slug === slug)) throw apiError(422, `Нет продукта «${slug}»`)
  if (!canSee(products, slug)) throw apiError(422, `Токену не разрешён продукт «${slug}»`)
  return slug
}

/**
 * id нового документа: у продукта не по умолчанию — с префиксом `<slug>-` (`taibe-m-93`), чужой префикс — 409. Так
 * пункты разных продуктов не делят id (`c-backup-<дата>` у каждого свой), а запрет следует из id, а не из базы.
 */
export async function checkNewId(id: string, product: string): Promise<void> {
  const all = await listProducts()
  const owner = all.find((p) => !p.isDefault && id.startsWith(`${p.slug}-`))
  if (owner && owner.slug !== product) throw apiError(409, `id принадлежит продукту «${owner.slug}»`)
  const own = all.find((p) => p.slug === product)
  if (own && !own.isDefault && !id.startsWith(`${product}-`)) {
    throw apiError(422, `id пункта продукта «${product}» начинается с «${product}-»`)
  }
}
