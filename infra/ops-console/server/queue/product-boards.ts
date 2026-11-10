/**
 * Продукт по умолчанию и доски продуктов — без базы: их берут и сервер (products.ts, GET /products), и скрипты страницы
 * /queue (page-scripts.ts, page-products.ts), которым клиент базы не нужен.
 */
export const DEFAULT_PRODUCT = 'hr-helper'

/**
 * Пространства t-boards продукта — slug, как `ws` у карточек строк «Хода работ». По ним страница относит строку плана,
 * сводку и карту доски к продукту: документы tAIBE пишет токен HR (у MCP очереди один токен, фаза 4a плана), и по
 * столбцу product «Ход работ» tAIBE пуст. Столбца в oq_products нет — новый продукт с доской добавляет строку здесь.
 */
export const PRODUCT_BOARDS: Readonly<Record<string, readonly string[]>> = {
  'hr-helper': ['hr-helper-lavaeon'],
  taibe: ['aiboards-eval'],
}
