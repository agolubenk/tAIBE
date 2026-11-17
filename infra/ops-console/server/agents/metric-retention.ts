/** Срок хранения истории замеров (metric_samples) — ежедневная очистка планировщика (OPS-34). */
import { and, lt, sql } from 'drizzle-orm'
import type { OpsDb } from '../db/client'
import { containers, metricSamples } from '../db/schema'

/**
 * Удаляет замеры старше `before`, кроме последнего замера счётчика перезапусков (`restarts:<имя>`) каждого
 * существующего контейнера. Счётчик пишется только при изменении, и его последний замер — база окна правила
 * «перезапуск по кругу»: удали его — первый всплеск после месяца тишины недосчитался бы на перезапуск.
 *
 * Последний замер ищется коррелированным подзапросом по каждому контейнеру — поиск по `idx_metric_agent_time`
 * (agent_id, metric). Прежний `join … group by` сканировал индекс целиком: 1,07 млн строк на агента держали цикл
 * событий и базу больше секунды (OPS-34). `where m is not null` обязателен: контейнер без строки `restarts:` даёт
 * NULL, а один NULL в списке `not in` делает условие неизвестным — DELETE не удалил бы ничего.
 *
 * Возвращает построитель запроса: вызывающий ждёт его, тест берёт план (`explain query plan`).
 */
export function pruneMetricSamples(db: OpsDb, before: Date) {
  return db.delete(metricSamples).where(
    and(
      lt(metricSamples.createdAt, before),
      sql`${metricSamples.id} not in (select m from (select (select max(s.id) from ${metricSamples} s where s.agent_id = c.agent_id and s.metric = 'restarts:' || c.name) as m from ${containers} c) where m is not null)`,
    ),
  )
}
