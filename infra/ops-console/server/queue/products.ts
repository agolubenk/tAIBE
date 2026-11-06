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

/** Ответ на документ чужого продукта и на id чужого пространства — один, как на несуществующий. */
export const NOT_FOUND = 'Нет такого документа (id пункта продукта — с префиксом «<slug>-», у продукта по умолчанию — без префикса)'

/**
 * Пространство id: продукт, чей slug с «-» — самое длинное начало id (`taibe-m-93` → taibe); без префикса — продукт по
 * умолчанию. Продукт нового документа выводится из id: пункты разных продуктов не делят id (`c-backup-<дата>` у
 * каждого свой), а запрет следует из id, а не из базы — ответ не раскрывает, есть ли документ.
 */
export function namespaceOf(id: string, all: readonly Product[]): string {
  const prefixed = all.filter((p) => !p.isDefault && id.startsWith(`${p.slug}-`)).sort((a, b) => b.slug.length - a.slug.length)[0]
  return prefixed?.slug ?? all.find((p) => p.isDefault)?.slug ?? DEFAULT_PRODUCT
}

/**
 * Продукт нового документа — пространство его id; невидимое актору — 404, как чужой документ. Поле запроса product —
 * подтверждение: другое — 422 (оба продукта актору видимы или названы им самим).
 */
export async function productForNew(products: Visibility, id: string, requested: string | undefined): Promise<string> {
  const ns = namespaceOf(id, await listProducts())
  if (!canSee(products, ns)) throw apiError(404, NOT_FOUND)
  if (requested && requested !== ns) throw apiError(422, `id «${id}» — продукта «${ns}», а в запросе product «${requested}»`)
  return ns
}
