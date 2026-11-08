/**
 * Меню консоли и поиск по нему. Поиск находит разделы, их внутренние вкладки (по названию и
 * ключевым словам) и объекты — серверы, контейнеры, мониторы, горящие алерты, открытые инциденты.
 * Без React и DOM: чистые функции, проверяются тестами (tests/nav.test.ts).
 */
import type { IconName } from '../ui/Icon'
import type { AgentSummary, Alert, Container, Incident, Monitor, Role } from '../lib/types'

export interface NavCounts {
  critical: number
  warning: number
  incidents: number
}

/** Вкладка или раздел страницы: в меню не показывается, находится поиском. */
export interface NavEntry {
  to: string
  label: string
  keywords?: string
  minRole?: Role
}

export interface NavSection extends NavEntry {
  icon: IconName
  count?: (c: NavCounts) => [number, boolean]
  children?: NavEntry[]
}

export const NAV: NavSection[] = [
  { to: '/', label: 'Обзор', icon: 'overview', keywords: 'главная сводка дашборд состояние' },
  {
    to: '/infrastructure',
    label: 'Инфраструктура',
    icon: 'server',
    keywords: 'серверы хосты агенты контейнеры docker cpu память диск сеть перезапуск трафик nginx бизнес-метрики',
  },
  {
    to: '/monitoring',
    label: 'Мониторинг',
    icon: 'pulse',
    keywords: 'проверки аптайм uptime доступность',
    children: [
      { to: '/monitoring', label: 'HTTP-проверки', keywords: 'url сайт health задержка latency' },
      { to: '/monitoring?tab=tls', label: 'TLS-сертификаты', keywords: 'ssl https сертификат истекает срок' },
    ],
  },
  {
    to: '/alerts',
    label: 'Алерты',
    icon: 'bell',
    keywords: 'уведомления оповещения тревоги',
    count: (c) => [c.critical + c.warning, c.critical === 0],
    children: [
      { to: '/alerts', label: 'Активные алерты', keywords: 'горит сейчас' },
      { to: '/alerts?tab=history', label: 'История алертов', keywords: 'прошлые закрытые' },
      { to: '/alerts?tab=rules', label: 'Правила алертов', keywords: 'пороги условия порог' },
      {
        to: '/alerts?tab=channels',
        label: 'Каналы уведомлений',
        keywords: 'telegram телеграм бот email почта smtp webhook вебхук hmac',
        minRole: 'operator',
      },
      { to: '/alerts?tab=deliveries', label: 'Доставка уведомлений', keywords: 'отправка ошибки доставки' },
    ],
  },
  { to: '/incidents', label: 'Инциденты', icon: 'flame', keywords: 'аварии сбои постмортем', count: (c) => [c.incidents, false] },
  { to: '/deploys', label: 'Деплои', icon: 'rocket', keywords: 'github actions релизы выкат ci версия продукта' },
  { to: '/events', label: 'События', icon: 'list', keywords: 'журнал лента активность аудит' },
  { to: '/reports', label: 'Отчёты ИИ-совету', icon: 'report', keywords: 'ии-совет совет директоров приёмник расписание дайджест' },
  {
    to: '/settings',
    label: 'Настройки',
    icon: 'settings',
    children: [
      { to: '/settings', label: 'Общие настройки', keywords: 'часовой пояс хранение публичный статус heartbeat название' },
      { to: '/settings?tab=agents', label: 'Агенты', keywords: 'установка ключ секрет подключение сервера', minRole: 'owner' },
      { to: '/settings?tab=users', label: 'Пользователи', keywords: 'роли доступ sso владелец оператор наблюдатель', minRole: 'owner' },
      { to: '/settings?tab=integrations', label: 'Интеграции', keywords: 'github токен репозиторий workflow' },
      { to: '/settings?tab=profile', label: 'Профиль', keywords: 'пароль смена пароля вход через платформу' },
    ],
  },
]

export type HitGroup = 'Разделы' | 'Серверы' | 'Контейнеры' | 'Мониторы' | 'Алерты' | 'Инциденты'
export const HIT_GROUPS: HitGroup[] = ['Разделы', 'Серверы', 'Контейнеры', 'Мониторы', 'Алерты', 'Инциденты']

export interface SearchHit {
  key: string
  group: HitGroup
  to: string
  label: string
  /** Где это: раздел-родитель, сервер, адрес. */
  context: string
  icon: IconName
}

export interface SearchData {
  agents?: AgentSummary[]
  containers?: Container[]
  monitors?: Monitor[]
  alerts?: Alert[]
  incidents?: Incident[]
}

/** Сколько совпадений одной группы показывать — остальное уточняется запросом. */
export const PER_GROUP = 6

export const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

export function tokenize(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

/** 0 — название начинается с запроса, 1 — запрос в названии, 2 — только в ключевых словах, null — мимо. */
function score(label: string, extra: string, tokens: string[]): number | null {
  const l = normalize(label)
  const all = `${l} ${normalize(extra)}`
  if (!tokens.every((t) => all.includes(t))) return null
  if (tokens.every((t) => l.includes(t))) return l.startsWith(tokens[0] ?? '') ? 0 : 1
  return 2
}

function ranked(items: Array<{ hit: SearchHit; rank: number | null }>): SearchHit[] {
  return items
    .filter((x): x is { hit: SearchHit; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, PER_GROUP)
    .map((x) => x.hit)
}

export function searchSections(tokens: string[], can: (min: Role) => boolean): SearchHit[] {
  const out: Array<{ hit: SearchHit; rank: number | null }> = []
  for (const section of NAV) {
    if (section.minRole && !can(section.minRole)) continue
    out.push({
      hit: { key: `s:${section.to}`, group: 'Разделы', to: section.to, label: section.label, context: 'раздел', icon: section.icon },
      rank: score(section.label, section.keywords ?? '', tokens),
    })
    for (const child of section.children ?? []) {
      if (child.minRole && !can(child.minRole)) continue
      out.push({
        hit: {
          key: `s:${child.to}:${child.label}`,
          group: 'Разделы',
          to: child.to,
          label: child.label,
          context: section.label,
          icon: section.icon,
        },
        // Родитель участвует в совпадении: «алерты каналы» находит вкладку «Каналы уведомлений».
        rank: score(child.label, `${child.keywords ?? ''} ${section.label} ${section.keywords ?? ''}`, tokens),
      })
    }
  }
  return ranked(out)
}

export function searchEntities(tokens: string[], data: SearchData): SearchHit[] {
  const agentName = new Map((data.agents ?? []).map((a) => [a.id, a.name]))
  const agents = ranked(
    (data.agents ?? []).map((a) => ({
      hit: {
        key: `a:${a.id}`,
        group: 'Серверы' as const,
        to: `/infrastructure/${encodeURIComponent(a.id)}`,
        label: a.name,
        context: a.environment || a.id,
        icon: 'server' as const,
      },
      rank: score(a.name, `${a.id} ${a.environment} ${a.snapshot?.hostname ?? ''}`, tokens),
    })),
  )
  const containers = ranked(
    (data.containers ?? []).map((c) => ({
      hit: {
        key: `c:${c.agentId}:${c.name}`,
        group: 'Контейнеры' as const,
        to: `/infrastructure/${encodeURIComponent(c.agentId)}#c-${encodeURIComponent(c.name)}`,
        label: c.name,
        context: `${agentName.get(c.agentId) ?? c.agentId} · ${c.state}`,
        icon: 'box' as const,
      },
      rank: score(c.name, `${c.composeService} ${c.image}`, tokens),
    })),
  )
  const monitors = ranked(
    (data.monitors ?? []).map((m) => ({
      hit: {
        key: `m:${m.id}`,
        group: 'Мониторы' as const,
        to: `/monitoring?monitor=${m.id}`,
        label: m.name,
        context: m.url,
        icon: 'pulse' as const,
      },
      rank: score(m.name, `${m.url} ${m.tags}`, tokens),
    })),
  )
  const alerts = ranked(
    (data.alerts ?? []).map((a) => ({
      hit: {
        key: `al:${a.id}`,
        group: 'Алерты' as const,
        to: `/alerts?focus=${a.id}`,
        label: a.title,
        context: a.object,
        icon: 'bell' as const,
      },
      rank: score(a.title, `${a.object} ${a.value}`, tokens),
    })),
  )
  const incidents = ranked(
    (data.incidents ?? []).map((i) => ({
      hit: {
        key: `i:${i.id}`,
        group: 'Инциденты' as const,
        to: `/incidents/${i.id}`,
        label: i.title,
        context: `#${i.id}`,
        icon: 'flame' as const,
      },
      rank: score(i.title, `${i.id} ${i.summary}`, tokens),
    })),
  )
  return [...agents, ...containers, ...monitors, ...alerts, ...incidents]
}
