import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAction } from '../lib/hooks'
import { useSession } from '../lib/session'
import { dateTime, duration, incidentCode, preciseDuration, timeAgo } from '../lib/format'
import type { Deploy, DeploySource, UiStatus } from '../lib/types'
import { StatusBadge } from '../ui/Badge'
import { Button, LinkButton } from '../ui/Controls'
import { Empty, LoadError, PageHero, Panel, Skeleton, StatTile } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { LiveDeploy } from './deploys/LiveDeploy'
import { QueueLinks } from './deploys/QueueLinks'
import { ReleasePanel } from './deploys/ReleasePanel'
import ds from './deploys/deploys.module.css'

export function deployStatus(d: Deploy): [UiStatus, string] {
  if (d.status !== 'completed') return ['pending', d.status === 'in_progress' ? 'Идёт' : d.status]
  if (d.conclusion === 'success') return ['healthy', 'Успешно']
  if (d.conclusion === 'not_started') return ['critical', 'Не запустился']
  if (d.conclusion === 'failure' || d.conclusion === 'timed_out') return ['critical', d.conclusion === 'failure' ? 'Упал' : 'Таймаут']
  return ['unknown', d.conclusion ?? 'завершён']
}

interface DeploysResponse {
  deploys: Deploy[]
  source: DeploySource
  avgDurationMs: number | null
  avgOf: number
}

export function DeploysPage() {
  const { can } = useSession()
  const q = useQuery({ queryKey: ['deploys'], queryFn: () => api.get<DeploysResponse>('/events/deploys'), refetchInterval: 60_000 })
  const sync = useAction(() => api.post('/events/deploys/sync'), { success: 'Деплои синхронизированы с GitHub', invalidate: [['deploys']] })
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  const src = q.data?.source
  return (
    <>
      <PageHero
        eyebrow="Деплои"
        title="Выкатки из GitHub Actions"
        lead="Ход текущего деплоя по событиям скрипта на сервере и выкатки на одной шкале с инцидентами: упавший деплой — алерт, инцидент вскоре после выката и пункты очереди по этому PR (видит владелец) — в колонке «Связь»."
        actions={
          <>
            {can('operator') && src?.configured ? (
              <Button icon="refresh" busy={sync.isPending} onClick={() => sync.mutate(undefined)}>
                Синхронизировать
              </Button>
            ) : null}
            {can('owner') ? (
              <LinkButton to="/settings?tab=integrations" icon="settings">
                GitHub
              </LinkButton>
            ) : null}
          </>
        }
      />
      <LiveDeploy />
      <ReleasePanel />
      <div className={s.grid3}>
        <StatTile
          label="Источник — GitHub Actions"
          icon="plug"
          value={!src ? '—' : !src.configured ? 'Не настроен' : src.lastSyncOk ? 'Подключён' : src.lastSyncAt ? 'Ошибка' : 'Ждёт опроса'}
          sub={!src ? ' ' : src.configured ? `${src.repo} · ${src.workflow}` : 'Настройки → Интеграции'}
          tone={src && src.configured && src.lastSyncAt && !src.lastSyncOk ? 'critical' : src && !src.configured ? 'attention' : undefined}
        />
        <StatTile
          label="Последняя синхронизация"
          icon="refresh"
          value={src?.lastSyncAt ? timeAgo(src.lastSyncAt) : '—'}
          sub={src?.lastSyncError || 'опрос раз в 2 минуты'}
        />
        <StatTile
          label="Среднее время деплоя"
          icon="timer"
          value={q.data?.avgDurationMs ? preciseDuration(0, q.data.avgDurationMs) : '—'}
          sub={q.data?.avgOf ? `по ${q.data.avgOf} успешным запускам` : 'успешных запусков пока нет'}
        />
      </div>
      <Panel flush>
        {!q.data ? (
          <div style={{ padding: 20 }}>
            <Skeleton height={120} />
          </div>
        ) : q.data.deploys.length === 0 ? (
          <Empty title="Деплоев нет" icon="rocket">
            Владелец подключает репозиторий и токен в «Настройки → Интеграции» (fine-grained, только Actions: read).
          </Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ds.top}`}>
              <thead>
                <tr>
                  <th>Результат</th>
                  <th>Изменение</th>
                  <th>Сервис</th>
                  <th>Окружение</th>
                  <th>Кто</th>
                  <th>Завершён</th>
                  <th>Длительность</th>
                  <th>Связь</th>
                </tr>
              </thead>
              <tbody>
                {q.data.deploys.map((d) => {
                  const [st, label] = deployStatus(d)
                  return (
                    <tr key={d.id}>
                      <td>
                        <StatusBadge status={st} label={label} />
                      </td>
                      <td>
                        <a className={ui.rowLink} href={d.url} target="_blank" rel="noreferrer">
                          {d.title || d.runKey}
                        </a>
                        <span className={ui.cellSub}>
                          <code>{d.headSha}</code>
                        </span>
                      </td>
                      <td>{d.workflow.replace(/\.ya?ml$/, '')}</td>
                      <td>production</td>
                      <td>{d.actor || '—'}</td>
                      <td className={ui.num}>{dateTime(d.finishedAt ?? d.startedAt ?? d.createdAt)}</td>
                      <td className={ui.num}>{d.startedAt && d.finishedAt ? duration(d.startedAt, d.finishedAt) : '—'}</td>
                      <td>
                        {d.incident || d.queue ? (
                          <div className={ds.relation}>
                            {d.incident ? (
                              <Link to={`/incidents/${d.incident.incidentId}`} className={s.incidentLink}>
                                {incidentCode(d.incident.incidentId)} · {d.incident.afterMin >= 0 ? '+' : '−'}
                                {Math.abs(d.incident.afterMin)} мин
                              </Link>
                            ) : null}
                            {d.queue ? <QueueLinks queue={d.queue} /> : null}
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  )
}
