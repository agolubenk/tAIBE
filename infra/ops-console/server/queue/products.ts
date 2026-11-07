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

// Справочник меняется только миграцией (= перезапуск процесса): читается один раз на базу. db в записи — тесты меняют базу.
let productsCache: { db: unknown; list: Promise<Product[]> } | null = null

export function listProducts(): Promise<Product[]> {
  const db = getDb()
  if (productsCache?.db === db) return productsCache.list
  const list = db
    .select()
    .from(oqProducts)
    .orderBy(asc(oqProducts.slug))
    .then((rows) => rows.map((r) => ({ slug: r.slug, name: r.name })))
  productsCache = { db, list }
  list.catch(() => {
    if (productsCache?.list === list) productsCache = null
  })
  return list
}

/**
 * Ответ на документ чужого продукта и на id чужого пространства — один и тот же, как на несуществующий. Называет
 * только продукты самого актора и их префиксы: сессия узнаёт, какой id ей писать, а о чужих не узнаёт ничего.
 */
export function notFound(products: Visibility, all: readonly Product[]): never {
  const own = products === '*' ? [] : all.filter((p) => products.includes(p.slug))
  const hint = own.map((p) => (p.slug === DEFAULT_PRODUCT ? `${p.slug} — id без префикса` : `${p.slug} — id «${p.slug}-…»`)).join('; ')
  throw apiError(404, hint ? `Нет такого документа. Ваши продукты: ${hint}` : 'Нет такого документа')
}

/**
 * Пространство id: продукт, чей slug с «-» — самое длинное начало id (`taibe-m-93` → taibe); без префикса — HR.
 * Продукт нового документа выводится из id: пункты разных продуктов не делят id (`c-backup-<дата>` у каждого свой), а
 * запрет следует из id, а не из базы — ответ не раскрывает, есть ли документ.
 */
export function namespaceOf(id: string, all: readonly Product[]): string {
  const prefixed = all.filter((p) => p.slug !== DEFAULT_PRODUCT && id.startsWith(`${p.slug}-`)).sort((a, b) => b.slug.length - a.slug.length)[0]
  return prefixed?.slug ?? DEFAULT_PRODUCT
}

/**
 * Продукт нового документа — пространство его id; невидимое актору — 404, как чужой документ. `all` — справочник,
 * прочитанный до транзакции записи: чтение другим соединением пула libsql внутри транзакции оставляет блокировку.
 */
export function productForNew(products: Visibility, id: string, all: readonly Product[]): string {
  const ns = namespaceOf(id, all)
  if (!canSee(products, ns)) notFound(products, all)
  return ns
}
