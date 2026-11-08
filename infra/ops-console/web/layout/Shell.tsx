import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { releaseQuery } from '../lib/release'
import { ROLE_LABEL, useSession } from '../lib/session'
import { applyAppearance, effectiveDark, readAppearance, type Appearance } from '../lib/theme'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Controls'
import { cx } from '../ui/Glass'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import type { SettingsResponse } from '../pages/settingsTypes'
import { NAV, type NavCounts } from './navigation'
import { NavSearch } from './NavSearch'
import s from './shell.module.css'

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className={s.logo} width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="ops-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--lg-accent)" />
          <stop offset="1" stopColor="var(--lg-accent-2)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="9" fill="url(#ops-logo)" />
      <path d="M8 18h4l2.5-6 3 10 2.5-6H24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ThemeToggle() {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance)
  useEffect(() => applyAppearance(appearance), [appearance])
  const dark = effectiveDark(appearance)
  return (
    <Button variant="ghost" iconOnly icon={dark ? 'sun' : 'moon'} onClick={() => setAppearance(dark ? 'light' : 'dark')}>
      {dark ? 'Светлая тема' : 'Тёмная тема'}
    </Button>
  )
}

/** Подвал меню: что это за консоль, как в неё входят и где публичная страница статуса. */
function NavFoot() {
  const { ssoEnabled, can } = useSession()
  // Тот же запрос и ключ, что у «Настроек» и «Отчётов»: флаг страницы статуса без лишнего запроса.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings'), staleTime: 60_000 })
  const publicStatus = settings.data?.general.publicStatusEnabled
  // Тот же ключ, что у панели «Версия продукта» на «Деплоях»: там запрос свежий, здесь хватит раза в 5 минут.
  const release = useQuery({ ...releaseQuery, staleTime: 5 * 60_000, refetchOnWindowFocus: false })
  const version = release.data?.current
  return (
    <div className={s.navFoot}>
      Наблюдение за продуктом: серверы, контейнеры, проверки, алерты.
      {ssoEnabled ? ' Вход — аккаунтом платформы, роли задаёт её суперадмин.' : ''}
      <br />
      {version ? (
        <>
          <Link to="/deploys">
            Версия {version.version} · {version.sha.slice(0, 7)}
          </Link>
          <br />
        </>
      ) : null}
      {publicStatus ? (
        <a href="/status" target="_blank" rel="noreferrer">
          Публичный статус →
        </a>
      ) : publicStatus === false && can('owner') ? (
        <Link to="/settings">Публичная страница статуса выключена — включить</Link>
      ) : null}
    </div>
  )
}

export function Shell({ children, consoleName = 'HR Helper Ops' }: { children: ReactNode; consoleName?: string }) {
  const { user } = useSession()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = useState('')
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api.get<NavCounts>('/overview/counts'), refetchInterval: 15_000 })
  const c = counts.data
  const firing = (c?.critical ?? 0) + (c?.warning ?? 0)

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined)
    qc.clear()
    navigate('/login')
  }

  return (
    <div className={s.app}>
      <a className="visually-hidden" href="#main">
        К содержимому
      </a>
      <header className={s.header}>
        <div className={s.headerBar}>
          <Link to="/" className={s.brand}>
            <Logo />
            <span className={s.brandName}>{consoleName}</span>
            <span className={s.envChip}>Ops</span>
          </Link>
          <div className={s.headerActions}>
            <Link
              to="/alerts"
              className={cx(s.alertPill, !c?.critical && (firing ? s.alertPillWarn : s.alertPillOk))}
              aria-label={`Активных алертов: ${firing}`}
            >
              <Icon name={firing ? 'bell' : 'check'} size={15} />
              {firing ? firing : 'Всё спокойно'}
            </Link>
            <ThemeToggle />
            {user ? (
              <span className={s.user}>
                <span className={s.userEmail}>{user.email}</span>
                <span className={s.userRole}>{ROLE_LABEL[user.role]}</span>
              </span>
            ) : null}
            <Button variant="ghost" iconOnly icon="logout" onClick={() => void logout()}>
              Выйти
            </Button>
          </div>
        </div>
      </header>
      <div className={s.body}>
        <div className={s.navCol}>
          <NavSearch query={query} onQuery={setQuery} />
          {/* Пока идёт поиск, вместо меню — результаты (они в NavSearch). */}
          <nav className={s.nav} aria-label="Разделы" hidden={query.trim().length > 0}>
            {NAV.map((item) => {
              const [n, warnOnly] = c && item.count ? item.count(c) : [0, false]
              return (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className={s.navLink}>
                  <Icon name={item.icon} size={17} />
                  {item.label}
                  {n > 0 ? <span className={cx(s.navCount, warnOnly && s.navCountWarn)}>{n}</span> : null}
                </NavLink>
              )
            })}
          </nav>
          <NavFoot />
        </div>
        <main id="main" className={s.main}>
          <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
