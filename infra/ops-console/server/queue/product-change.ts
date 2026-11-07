/**
 * Смена продукта у пункта (v2-lite, часть 3): только владелец — страница /queue и бот. Пункт и ответ на него меняются
 * одной транзакцией. Версии растут: тег списка меняется и у владельца, страница и сессии видят новый продукт на
 * следующем опросе. Ответ без пункта (пункт удалили после переноса) остаётся в новом продукте и держит его id.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { oqDocs, oqEvents } from '../db/schema'
import { apiError } from '../http-types'
import { DEFAULT_PRODUCT, listProducts } from './products'
import type { Actor } from './store'

export interface ProductChange {
  id: string
  from: string
  to: string
  changed: boolean
}

export async function changeItemProduct(actor: Actor, id: string, to: string, reason: string): Promise<ProductChange> {
  if (!actor.scopes.includes('owner')) throw apiError(403, 'Продукт пункта меняет только владелец')
  if (!(await listProducts()).some((p) => p.slug === to)) throw apiError(422, `Нет продукта «${to}»`)
  const db = getDb()
  return db.transaction(async (tx) => {
    const item = await tx.query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, id)) })
    if (!item) throw apiError(404, 'Нет такого пункта')
    if (item.product === to) return { id, from: to, to, changed: false }
    const data = JSON.parse(item.dataJson) as Record<string, unknown>
    // Вердикт «Контроля» дан для репозитория продукта: в другом продукте он вёл бы мёрж не туда.
    if (data.kind === 'merge' && (data.sha || data.base)) {
      throw apiError(409, 'У пункта мёржа есть вердикт «Контроля» для его продукта — сначала уберите вердикт или заведите пункт заново')
    }
    // Входящее — только в HR, пока автопередача одна (relay HR, фаза 4a плана): у другого продукта его никто не возьмёт,
    // а страница и бот показывали бы «передаётся сессии» без срока.
    if (data.kind === 'inbox' && to !== DEFAULT_PRODUCT) {
      throw apiError(409, 'Входящее пока живёт только в hr-helper: автопередача по продуктам ещё не подключена')
    }
    const at = new Date()
    const check = await tx.query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, 'checks'), eq(oqDocs.id, id)) })
    if (check) {
      await tx
        .update(oqDocs)
        .set({ product: to, version: check.version + 1, updatedAt: at, updatedBy: actor.name })
        .where(and(eq(oqDocs.collection, 'checks'), eq(oqDocs.id, id)))
    }
    await tx
      .update(oqDocs)
      .set({ product: to, version: item.version + 1, updatedAt: at, updatedBy: actor.name })
      .where(and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, id)))
    const after = JSON.stringify({ from: item.product, to, reason: reason.slice(0, 500) })
    // Событие — в обоих продуктах: история видна и прежнему продукту (что пункт ушёл), и новому; владелец видит одно
    // (docHistory схлопывает одинаковые). У ответа — своё событие: каждое изменение — строка журнала.
    const event = (collection: 'items' | 'checks', product: string) => ({ at, actor: actor.name, collection, docId: id, action: 'product', afterJson: after, product })
    await tx.insert(oqEvents).values([
      event('items', item.product),
      event('items', to),
      ...(check ? [event('checks', item.product), event('checks', to)] : []),
    ])
    return { id, from: item.product, to, changed: true }
  })
}
