/**
 * Отчёты в Telegram.
 *
 * Базовый (суточный отчёт и «Срочный отчёт») — одна карточка: статус и главная причина, что горит
 * сейчас, доступность, инциденты и алерты, ресурсы, контейнеры, деплои, TLS (только если близко к
 * сроку или ошибка), «что сделать». Под ней кнопки: «Больше информации» — тот же отчёт целиком, как
 * его получает ИИ-совет (по разделам, несколькими сообщениями), «Графики» — снимки за тот же
 * период, «Срочный отчёт» — свежий отчёт прямо сейчас (на самой срочной карточке — «Обновить»).
 * callback_data — до 64 байт: «rep:more:<конец периода, мин>», «rep:charts:<конец, мин>», «rep:now».
 */
import type { OpsReport } from '../../shared/report-contract'
import { escapeHtml } from '../notify/format'
import { clock } from '../lib/time'
import { plural } from '../../shared/plural'
import { periodHead } from './digest'
import { containersLine, hostContainers } from './containers'


/** TLS в карточке — только если до конца меньше стольких дней (или ошибка проверки). */
const TLS_SOON_DAYS = 21

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`)
const e = escapeHtml
const maxOf = (vs: Array<number | null>) => {
  const xs = vs.filter((v): v is number => v !== null)
  return xs.length ? Math.max(...xs) : null
}

export function reportKeyboard(report: OpsReport, opts: { urgent?: boolean } = {}): Record<string, unknown> {
  const endMin = Math.floor(new Date(report.period.end).getTime() / 60_000)
  return {
    inline_keyboard: [
      [{ text: '📋 Больше информации', callback_data: `rep:more:${endMin}` }],
      [
        { text: '📈 Графики', callback_data: `rep:charts:${endMin}` },
        opts.urgent ? { text: '🔄 Обновить', callback_data: 'rep:now' } : { text: '⚡ Срочный отчёт', callback_data: 'rep:now' },
      ],
      [{ text: '🏠 Меню: алерты, серверы, проверки', callback_data: 'mo:home' }],
    ],
  }
}

export function periodLine(r: OpsReport, tz: string): string {
  const end = new Date(r.period.end).getTime()
  const start = new Date(r.period.start).getTime()
  return `${clock(start, tz, end)} → ${clock(end, tz, end)}`
}

/** Главная причина статуса — вместо повтора самого статуса. */
function reason(r: OpsReport): string {
  const open = r.alerts.stillOpen.length
  const checks = r.availability.filter((a) => a.checks > 0 && a.uptimePct !== null)
  const worst = [...checks].sort((a, b) => (a.uptimePct ?? 100) - (b.uptimePct ?? 100))[0]
  const parts: string[] = []
  if (open) parts.push(`горит ${plural(open, ['алерт', 'алерта', 'алертов'])}`)
  if (worst && (worst.uptimePct ?? 100) < 100) parts.push(`${worst.monitor} ${pct(worst.uptimePct)}`)
  if (!parts.length) {
    // Сейчас всё в норме — называем, что было за период: заголовок «были сбои» не должен стоять рядом
    // с «сбоев не было» (закрывшееся предупреждение или упавший деплой инцидента не открывают).
    // Инцидент в «наблюдении» алертов не держит, но ещё открыт — «все закрыты» про него не пишем.
    const closed: string[] = []
    const n = r.incidents.length
    const open = r.incidents.filter((i) => !i.resolvedAt).length
    if (n) closed.push(`${plural(n, ['инцидент', 'инцидента', 'инцидентов'])}, ${open ? (n === 1 ? 'ещё открыт' : `открыто ${open}`) : n === 1 ? 'закрыт' : 'все закрыты'}`)
    else if (r.alerts.fired) closed.push(`${plural(r.alerts.fired, ['алерт', 'алерта', 'алертов'])}, ${r.alerts.fired === 1 ? 'закрыт' : 'все закрыты'}`)
    if (r.deploys.failed) closed.push(`неудачных деплоев: ${r.deploys.failed}`)
    return closed.length ? closed.join('; ') : 'сбоев за период не было'
  }
  return parts.join(', ')
}

/** Базовый отчёт: одна карточка без прокрутки. */
export function digestHtml(r: OpsReport, tz: string, opts: { urgent?: boolean } = {}): string {
  const checks = r.availability.filter((a) => a.checks > 0)
  const worst = [...checks].sort((a, b) => (a.uptimePct ?? 100) - (b.uptimePct ?? 100))[0]
  const measured = checks.filter((a) => a.uptimePct !== null)
  const totalUptime = measured.length ? measured.reduce((sum, a) => sum + (a.uptimePct ?? 0), 0) / measured.length : null
  const cpuMax = maxOf(r.hosts.map((h) => h.cpuMaxPct))
  const memMax = maxOf(r.hosts.map((h) => h.memAvgPct))
  const diskMax = maxOf(r.hosts.map((h) => h.diskMaxPct))
  const tlsRisk = r.tls
    .filter((t) => t.error || (t.daysLeft !== null && t.daysLeft < TLS_SOON_DAYS))
    .sort((a, b) => (a.error ? -1 : b.error ? 1 : (a.daysLeft ?? 0) - (b.daysLeft ?? 0)))[0]
  const openIncidents = r.incidents.filter((i) => !i.resolvedAt)
  const now: string[] = []
  if (r.alerts.stillOpen.length) now.push(`горит ${plural(r.alerts.stillOpen.length, ['алерт', 'алерта', 'алертов'])}`)
  if (openIncidents.length) now.push(openIncidents.length === 1 ? `открыт инцидент #${openIncidents[0]!.id}` : `открыто инцидентов: ${openIncidents.length}`)

  const kind = opts.urgent ? 'срочный отчёт' : r.period.kind === 'daily' ? 'суточный отчёт' : 'отчёт за неделю'
  const resources =
    cpuMax === null && memMax === null && diskMax === null
      ? '🖥 Ресурсы: агенты не прислали метрик'
      : `🖥 Ресурсы: CPU пик <b>${pct(cpuMax)}</b> · RAM до ${pct(memMax)} · диск до ${pct(diskMax)}`
  const lines = [
    `${opts.urgent ? '⚡' : '📊'} <b>${e(r.source.console)} · ${kind}</b>`,
    `<i>${e(periodLine(r, tz))}</i>`,
    '',
    `<b>${e(periodHead(r))}</b> — ${e(reason(r))}`,
    ...(now.length ? [`🔥 Сейчас: ${now.join(' · ')}`] : []),
    '',
    `🌐 Доступность: <b>${pct(totalUptime)}</b>${checks.length ? ` по ${plural(checks.length, ['монитору', 'мониторам', 'мониторам'])}` : ' — проверок не было'}${worst && (worst.uptimePct ?? 100) < 100 ? ` · хуже всех ${e(worst.monitor)} ${pct(worst.uptimePct)}` : ''}`,
    `🚨 Инциденты: <b>${r.incidents.length}</b>${openIncidents.length ? ` (открыто ${openIncidents.length})` : ''} · алерты: <b>${r.alerts.fired}</b>${r.alerts.critical ? ` (критичных ${r.alerts.critical})` : ''}`,
    resources,
    containersLine(r),
    `🚀 Деплои: ${r.deploys.total}${r.deploys.failed ? ` (упало ${r.deploys.failed})` : ''}`,
  ]
  if (tlsRisk) {
    lines.push(tlsRisk.error ? `🔒 TLS: ошибка проверки ${e(tlsRisk.domain)}` : `🔒 TLS: ${e(tlsRisk.domain)} — осталось ${plural(tlsRisk.daysLeft ?? 0, ['день', 'дня', 'дней'])}`)
  }
  // «Не запущены …» уже в строке контейнеров — второй раз не повторяем.
  const todo = r.recommendations.filter((x) => !/: не запущены /.test(x)).slice(0, 3)
  if (todo.length) lines.push('', '<b>Что сделать</b>', ...todo.map((x) => `→ ${e(x)}`))
  return lines.join('\n')
}

const RESTART_RESULT: Record<string, string> = {
  succeeded: 'выполнен',
  done: 'выполнен',
  failed: 'не удался',
  expired: 'истёк — агент не забрал',
  pending: 'ждёт агента',
  claimed: 'выполняется',
}

const INCIDENT_STATUS: Record<string, string> = { active: 'открыт', monitoring: 'наблюдение', resolved: 'закрыт' }

function deployIcon(conclusion: string | null): string {
  if (conclusion === 'success') return '🟢'
  if (conclusion === 'failure' || conclusion === 'timed_out') return '🔴'
  if (conclusion === null) return '⏳'
  return '⚪️'
}

const safeUrl = (url: string) => (/^https:\/\//.test(url) ? url : '')

export type ReportSectionKey = 'sum' | 'av' | 'inc' | 'hst' | 'dep' | 'tls' | 'rec'

export interface ReportSection {
  key: ReportSectionKey
  /** Подпись кнопки раздела. */
  button: string
  lines: string[]
}

/**
 * Разделы подробного отчёта — те же, что получает ИИ-совет: сводка, доступность, инциденты и
 * алерты, серверы и перезапуски, деплои, TLS, рекомендации. Из них собирается и «Весь отчёт»
 * (несколько сообщений), и просмотр по разделам кнопками.
 */
export function detailSections(r: OpsReport, tz: string, now = Date.now()): ReportSection[] {
  const end = new Date(r.period.end).getTime()
  const at = (iso: string) => clock(new Date(iso).getTime(), tz, end)
  return [
    {
      key: 'sum',
      button: '📋 Сводка',
      lines: [
        `📋 <b>${e(r.source.console)} · подробный отчёт</b>`,
        `<i>${e(periodLine(r, tz))}</i>`,
        '',
        `<b>${e(periodHead(r))}</b> — ${e(reason(r))}`,
        ...r.summary.highlights.map((h) => `• ${e(h)}`),
      ],
    },
    {
      key: 'av',
      button: '🌐 Доступность',
      lines: [
        '🌐 <b>Доступность</b>',
        ...(r.availability.length
          ? r.availability.map((a) =>
              a.checks > 0
                ? `• ${e(a.monitor)}: <b>${pct(a.uptimePct)}</b> из ${a.checks} проверок${a.avgLatencyMs !== null ? `, ~${a.avgLatencyMs} мс` : ''}`
                : `• ${e(a.monitor)}: проверок за период не было`,
            )
          : ['• мониторов нет']),
      ],
    },
    {
      key: 'inc',
      button: '🚨 Инциденты',
      lines: [
        '🚨 <b>Инциденты</b>',
        ...(r.incidents.length
          ? r.incidents.map(
              (i) =>
                `• #${i.id} ${i.severity === 'critical' ? '🔴' : '🟠'} ${e(i.title)} — с ${e(at(i.startedAt))}, ${INCIDENT_STATUS[i.status] ?? e(i.status)}${i.resolvedAt ? `, ${i.durationMin ?? 0} мин` : ''}`,
            )
          : ['• не было']),
        '',
        `⚠️ <b>Алерты за период</b>: ${r.alerts.fired} (критичных ${r.alerts.critical}, предупреждений ${r.alerts.warning})`,
        ...(r.alerts.stillOpen.length ? [`<i>Горят сейчас (на ${e(clock(now, tz, now))}):</i>`] : []),
        ...r.alerts.stillOpen.slice(0, 10).map((a) => `• ${a.severity === 'critical' ? '🔴' : '🟠'} ${e(a.title)} — ${e(a.object)} (с ${e(at(a.since))})`),
      ],
    },
    {
      key: 'hst',
      button: '🖥 Серверы',
      lines: [
        '🖥 <b>Серверы</b>',
        ...(r.hosts.length
          ? r.hosts.map(
              (h) =>
                `• <b>${e(h.name)}</b>: CPU ${pct(h.cpuAvgPct)} (пик ${pct(h.cpuMaxPct)}), RAM ${pct(h.memAvgPct)}, диск до ${pct(h.diskMaxPct)}${hostContainers(h)}`,
            )
          : ['• агентов нет']),
        '',
        `🔁 <b>Ручные перезапуски</b>: ${r.restarts.length}`,
        ...r.restarts
          .slice(0, 10)
          .map((x) => `• ${e(at(x.at))} ${e(x.container)} (${e(x.agent)}) — ${e(x.by)}: «${e(x.reason)}» → ${e(RESTART_RESULT[x.result] ?? x.result)}`),
      ],
    },
    {
      key: 'dep',
      button: '🚀 Деплои',
      lines: [
        `🚀 <b>Деплои</b>: ${r.deploys.total}${r.deploys.failed ? `, упало ${r.deploys.failed}` : ''}`,
        ...(r.deploys.recent.length
          ? r.deploys.recent.slice(0, 8).map((d) => {
              const url = safeUrl(d.url)
              const title = url ? `<a href="${e(url)}">${e(d.title)}</a>` : e(d.title)
              return `• ${e(at(d.at))} ${deployIcon(d.conclusion)} ${title}`
            })
          : ['• за период деплоев не было']),
      ],
    },
    {
      key: 'tls',
      button: '🔒 TLS',
      lines: [
        `🔒 <b>TLS</b> <i>(на ${e(clock(now, tz, now))})</i>`,
        ...(r.tls.length
          ? r.tls.map((t) => `• ${e(t.domain)}: ${t.error ? `ошибка — ${e(t.error)}` : plural(t.daysLeft ?? 0, ['день', 'дня', 'дней'])}`)
          : ['• доменов нет']),
      ],
    },
    {
      key: 'rec',
      button: '💡 Что сделать',
      lines: [
        '💡 <b>Рекомендации</b>',
        ...(r.recommendations.length ? r.recommendations.map((x) => `→ ${e(x)}`) : ['• замечаний нет']),
        '',
        `Отчёт в консоли: ${e(r.source.url)}/reports`,
      ],
    },
  ]
}

/** Полный отчёт по разделам — несколько сообщений, каждое ≤ 3800 символов, разрезано по разделам. */
export function detailHtmlParts(r: OpsReport, tz: string, now = Date.now()): string[] {
  return packMessages(detailSections(r, tz, now).map((x) => x.lines))
}

const MESSAGE_MAX = 3800
const LINE_MAX = 1000

/**
 * Строка длиннее LINE_MAX (длинная ошибка TLS, заголовок деплоя) — без разметки и обрезана: резать
 * HTML посередине нельзя (незакрытый <b> — и Telegram отвергает всё сообщение).
 */
function safeLine(line: string): string {
  if (line.length <= LINE_MAX) return line
  return `${line.replace(/<[^>]+>/g, '').slice(0, LINE_MAX).replace(/&[a-z#0-9]*$/i, '')}…`
}

/** Разделы — в сообщения ≤ MESSAGE_MAX: раздел целиком, а не влезший раздел — по строкам. */
export function packMessages(sections: string[][]): string[] {
  const out: string[] = []
  let cur = ''
  const push = (chunk: string, sep: string) => {
    if (cur && cur.length + sep.length + chunk.length > MESSAGE_MAX) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}${sep}${chunk}` : chunk
  }
  for (const sec of sections) {
    const lines = sec.map(safeLine)
    const block = lines.join('\n')
    if (block.length <= MESSAGE_MAX) {
      push(block, '\n\n')
      continue
    }
    lines.forEach((line, i) => push(line, i === 0 ? '\n\n' : '\n'))
  }
  if (cur) out.push(cur)
  return out
}

/** Текстовая версия базового отчёта (email, webhook-превью) — без разметки. */
export function digestText(r: OpsReport, tz: string): string {
  return digestHtml(r, tz).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}
