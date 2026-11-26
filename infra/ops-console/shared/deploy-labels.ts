/**
 * Подписи фаз и проверок деплоя — карточка «Деплоев» и текст алертов деплоя. Без zod: модуль импортирует web-бандл,
 * а схемы контракта (deploy-events-contract.ts) нужны только серверу (IS-261: zod в чанке Deploys — +13 КБ gzip).
 */
export const DEPLOY_PHASE_LABEL: Record<string, string> = {
  preflight: 'Проверки перед сборкой',
  prepare: 'Подготовка: снимок образов и чистка',
  build: 'Сборка, миграции, подъём стека',
  rollback_prev: 'Тег rollback-prev',
  cleanup: 'Чистка образов и кэша сборки',
  nginx: 'Конфиги nginx',
  checks: 'Проверки по публичным адресам',
}

export const DEPLOY_CHECK_LABEL: Record<string, string> = {
  api_ready: 'API: готовность',
  spa: 'SPA',
  site_config: 'site-config.js',
  ops_health: 'Ops-консоль',
  domain_root: 'Домен',
}
