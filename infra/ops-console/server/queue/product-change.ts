/**
 * Смена продукта у пункта (v2-lite, часть 3): только владелец — страница /queue и бот. Пункт и ответ на него меняются
 * одной транзакцией. Версии растут: тег списка меняется и у владельца, страница и сессии видят новый продукт на
 * следующем опросе. Ответ без пункта (пункт удалили после переноса) остаётся в новом продукте и держит его id.
 */
import { apiError } from '../http-types'
import { oqWrite } from './oq-write'
import { listProducts } from './products'
import { AGENT_FIELDS, type Actor } from './store'

export interface ProductChange {
  id: string
  from: string
  to: string
  changed: boolean
}

export async function changeItemProduct(actor: Actor, id: string, to: string, reason: string): Promise<ProductChange> {
  if (!actor.scopes.includes('owner')) throw apiError(403, 'Продукт пункта меняет только владелец')
  if (!(await listProducts()).some((p) => p.slug === to)) throw apiError(422, `Нет продукта «${to}»`)
  return oqWrite(async (w) => {
    const item = await w.doc('items', id)
    if (!item) throw apiError(404, 'Нет такого пункта')
    if (item.product === to) return { id, from: to, to, changed: false }
    const data = JSON.parse(item.dataJson) as Record<string, unknown>
    // Вердикт «Контроля» дан для репозитория продукта: в другом продукте он вёл бы мёрж не туда.
    if (data.kind === 'merge' && (data.sha || data.base)) {
      throw apiError(409, 'Пункт мёржа с вердиктом «Контроля» не переносится: вердикт дан для репозитория его продукта. Нужен другой продукт — попросите «Контроль» завести пункт там')
    }
    // Входящее переносится (решение владельца d-oq-inbox-product-0711, now-warn): до автопередачи по продуктам (фаза 4a)
    // его в другом продукте никто не возьмёт — страница предупреждает перед переносом.
    const check = await w.doc('checks', id)
    if (check) {
      // Входящее — без захвата сессии прежнего продукта: она его больше не видит (404), а сессия нового продукта или HR
      // после возврата получала бы 409 «Пункт уже ведёт …» до 12 ч. Перенос виден в истории (событие product).
      const dataJson = data.kind === 'inbox' ? withoutAgent(check.dataJson) : check.dataJson
      await w.updateDoc('checks', id, { product: to, dataJson, version: check.version + 1, updatedBy: actor.name })
    }
    await w.updateDoc('items', id, { product: to, version: item.version + 1, updatedBy: actor.name })
    const after = JSON.stringify({ from: item.product, to, reason: reason.slice(0, 500) })
    // Событие — в обоих продуктах: история видна и прежнему продукту (что пункт ушёл), и новому; владелец видит одно
    // (docHistory схлопывает одинаковые). У ответа — своё событие: каждое изменение — строка журнала.
    const event = (collection: 'items' | 'checks', product: string) => ({ actor: actor.name, collection, docId: id, action: 'product', afterJson: after, product })
    await w.event(event('items', item.product), event('items', to), ...(check ? [event('checks', item.product), event('checks', to)] : []))
    return { id, from: item.product, to, changed: true }
  })
}

function withoutAgent(json: string): string {
  const d = JSON.parse(json) as Record<string, unknown>
  for (const k of AGENT_FIELDS) delete d[k]
  return JSON.stringify(d)
}
