/**
 * «Деплои» → «Версия продукта» (APP-558): текущая версия и её коммит, к какому деплою привяжется новая, предложение
 * по коммитам main, форма владельца и история. Подвалы продукта читают эту версию через публичный /release.json.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { dateTime } from '../../lib/format'
import { releaseNavQuery, releaseQuery, releaseSuggestionQuery } from '../../lib/release'
import { plural } from '../../../shared/plural'
import {
  compareReleaseVersions,
  parseReleaseVersion,
  RELEASE_NOTE_MAX,
  RELEASE_SHA_RE,
  type BindingReason,
  type BindingRun,
  type ReleaseEntry,
  type ReleaseResponse,
  type ReleaseSuggestionResponse,
} from '../../../shared/release'
import { Button, Check, Field, FormError, Input, Textarea } from '../../ui/Controls'
import { LoadError, Panel, Skeleton, cx } from '../../ui/Glass'
import { Icon } from '../../ui/Icon'
import ui from '../../ui/styles'
import s from './deploys.module.css'

const REASON: Record<BindingReason, string> = {
  manual_run:
    'Новее последнего успешного деплоя есть ручной запуск (откат или перевыкладка): какой коммит он выкатил, GitHub не сообщает. Найдите SHA в логе запуска и вставьте его.',
  failed_run: 'Новее последнего успешного деплоя есть упавший запуск: прод мог обновиться частично. Проверьте лог запуска и вставьте SHA, который сейчас на проде.',
  in_progress: 'Идёт деплой. Дождитесь его конца и нажмите «Проверить ещё раз» — или вставьте SHA, который сейчас на проде.',
  no_deploy: 'Успешных выкаток из GitHub Actions в таблице деплоев нет. Вставьте SHA коммита, который сейчас на проде.',
}

const safeHref = (url: string | undefined) => (url && url.startsWith('https://') ? url : undefined)
const short = (sha: string) => sha.slice(0, 7)

function RunLink({ run }: { run: BindingRun | null }) {
  const href = safeHref(run?.url)
  if (!run || !href) return null
  return (
    <a className={s.runLink} href={href} target="_blank" rel="noreferrer">
      Запуск в GitHub <Icon name="external" size={14} />
    </a>
  )
}

function CurrentVersion({ current }: { current: ReleaseEntry | null }) {
  if (!current) {
    return <p className={cx(ui.small, ui.faint)}>Версия ещё не задана: подвалы продукта её не показывают.</p>
  }
  return (
    <div className={s.head}>
      <span className={s.title}>{current.version}</span>
      <code className={s.sha} title={current.sha}>
        {short(current.sha)}
      </code>
      <span className={cx(ui.small, ui.faint)}>
        {dateTime(current.setAt)} · {current.setBy}
        {current.note ? ` · ${current.note}` : ''}
      </span>
    </div>
  )
}

function BindingView({ data }: { data: ReleaseResponse }) {
  const b = data.binding
  if (b.mode === 'auto') {
    return (
      <div className={s.head}>
        <span className={ui.small}>Новая версия привяжется к деплою</span>
        <code className={s.sha} title={b.sha}>
          {short(b.sha)}
        </code>
        {b.run.title ? <span className={cx(ui.small, s.title)}>{b.run.title}</span> : null}
        <span className={cx(ui.small, ui.faint)}>{dateTime(b.run.at)}</span>
        <RunLink run={b.run} />
      </div>
    )
  }
  return (
    <div className={s.releaseWarn} role="status">
      <p>{REASON[b.reason]}</p>
      <div className={ui.row}>
        {b.sha ? <span className={ui.small}>Последний успешный автоматический деплой — {short(b.sha)}.</span> : null}
        <RunLink run={b.run} />
      </div>
    </div>
  )
}

function SuggestionView({ data, onAccept }: { data: ReleaseResponse; onAccept: (v: string) => void }) {
  const q = useQuery(releaseSuggestionQuery(data.rev, data.binding.sha))
  if (q.isPending) return <p className={cx(ui.small, ui.faint)}>Считаю предложение по коммитам main…</p>
  if (q.isError) return <p className={cx(ui.small, ui.faint)}>Предложение не загрузилось — введите версию вручную.</p>
  const { suggestion: sg, suggestionError }: ReleaseSuggestionResponse = q.data
  if (!sg) return suggestionError ? <p className={cx(ui.small, ui.faint)}>Предложения нет: {suggestionError}</p> : null
  return (
    <div className={ui.row}>
      <span>
        Предложение: <strong>{sg.version}</strong>
      </span>
      <span className={cx(ui.small, ui.faint)}>
        {plural(sg.commits, ['коммит', 'коммита', 'коммитов'])} main после {short(sg.base)}: feature {sg.counts.feature} · fix {sg.counts.fix} · прочее {sg.counts.other}
      </span>
      <Button small icon="check" onClick={() => onAccept(sg.version)}>
        Принять
      </Button>
    </div>
  )
}

function ReleaseForm({ data }: { data: ReleaseResponse }) {
  const qc = useQueryClient()
  const [version, setVersion] = useState('')
  const [note, setNote] = useState('')
  const [sha, setSha] = useState('')
  const [confirmLower, setConfirmLower] = useState(false)
  const needSha = data.binding.mode === 'confirm'
  const next = parseReleaseVersion(version.trim())
  const cur = data.current ? parseReleaseVersion(data.current.version) : null
  const notHigher = Boolean(next && cur && compareReleaseVersions(next, cur) <= 0)
  const shaValue = sha.trim().toLowerCase()
  const ready = Boolean(next) && (!needSha || RELEASE_SHA_RE.test(shaValue)) && (!notHigher || confirmLower)
  const save = useAction(
    () =>
      api.put<{ rev: number; current: ReleaseEntry; syncError: string | null }>('/release', {
        version: version.trim(),
        note: note.trim(),
        expectedRev: data.rev,
        expectedMode: data.binding.mode,
        expectedRunKey: data.binding.run?.runKey ?? '',
        expectedSha: data.binding.sha ?? '',
        ...(needSha ? { sha: shaValue } : {}),
        confirmLower: notHigher && confirmLower,
      }),
    { success: (r) => `Версия ${r.current.version} сохранена`, invalidate: [releaseQuery.queryKey, releaseNavQuery.queryKey] },
  )
  const submit = () =>
    save.mutate(undefined, {
      onSuccess: () => {
        setVersion('')
        setNote('')
        setSha('')
        setConfirmLower(false)
      },
      // 409 «новый деплой» или чужая запись: перечитать привязку и ревизию сразу, а не по таймеру.
      onError: () => void qc.invalidateQueries({ queryKey: releaseQuery.queryKey }),
    })
  return (
    <div className={ui.stack}>
      <SuggestionView data={data} onAccept={setVersion} />
      <div className={cx(ui.formGrid, ui.formGrid2)}>
        <Field label="Новая версия" hint="v.A.B.C.D, сегменты 0–9999. A — номер Лаваэона, меняется только вручную.">
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v.0.1.0.0" spellCheck={false} />
        </Field>
        {needSha ? (
          <Field label="SHA выкаченного коммита" hint="7–40 шестнадцатеричных знаков из лога запуска">
            <Input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="a1b2c3d" spellCheck={false} />
          </Field>
        ) : null}
        <Field label="Заметка" wide hint={`Видна только в консоли; до ${RELEASE_NOTE_MAX} знаков`}>
          <Textarea value={note} maxLength={RELEASE_NOTE_MAX} rows={2} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {notHigher ? (
        <Check label={`Подтверждаю: версия не выше текущей ${data.current?.version ?? ''}`} checked={confirmLower} onChange={setConfirmLower} />
      ) : null}
      {version.trim() && !next ? <p className={cx(ui.small, ui.faint)}>Формат: v.A.B.C.D без ведущих нулей, например v.0.2.0.0.</p> : null}
      <FormError error={save.error} />
      <div className={ui.row}>
        <Button variant="primary" icon="check" busy={save.isPending} disabled={!ready} onClick={submit}>
          Сохранить версию
        </Button>
      </div>
    </div>
  )
}

function ReleaseHistory({ history }: { history: ReleaseEntry[] }) {
  if (history.length === 0) return null
  return (
    <section aria-label="История версий">
      <h3 className={s.subTitle}>История</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Версия</th>
              <th>Коммит</th>
              <th>Установлена</th>
              <th>Кто</th>
              <th>Заметка</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={`${h.version}-${h.setAt}`}>
                <td>{h.version}</td>
                <td>
                  <code title={h.sha}>{short(h.sha)}</code>
                </td>
                <td className={ui.num}>{dateTime(h.setAt)}</td>
                <td>{h.setBy}</td>
                <td>{h.note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function ReleasePanel() {
  const { can } = useSession()
  // Минута: панель не дёргает сервер при каждом возврате на вкладку, «Проверить ещё раз» читает сразу.
  const q = useQuery({ ...releaseQuery, staleTime: 60_000 })
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  const data = q.data
  return (
    <Panel
      title="Версия продукта"
      hint="Одна версия для подвалов продукта, страницы входа и меню профиля. Привязана к коммиту деплоя и держится до следующей."
      action={
        <Button small variant="ghost" icon="refresh" busy={q.isFetching} onClick={() => void q.refetch()}>
          Проверить ещё раз
        </Button>
      }
    >
      {!data ? (
        <Skeleton height={96} />
      ) : (
        <div className={ui.stack}>
          <CurrentVersion current={data.current} />
          <BindingView data={data} />
          {data.syncError ? <p className={cx(ui.small, ui.faint)}>Опрос деплоев: {data.syncError}</p> : null}
          {can('owner') ? <ReleaseForm data={data} /> : null}
          <ReleaseHistory history={data.history} />
        </div>
      )}
    </Panel>
  )
}
