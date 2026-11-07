/**
 * If-None-Match по RFC 9110 §13.1.2: слабое сравнение (префикс W/ не учитывается), список тегов через запятую и «*».
 * Строгое `===` молча теряет 304, если прокси перед консолью или клиент меняет префикс W/ или шлёт список тегов.
 */
export function etagMatches(header: string | undefined, tag: string): boolean {
  if (!header) return false
  const want = opaque(tag)
  return header.split(',').some((raw) => {
    const t = raw.trim()
    return t === '*' || opaque(t) === want
  })
}

const opaque = (t: string) => (t.startsWith('W/') ? t.slice(2) : t)
