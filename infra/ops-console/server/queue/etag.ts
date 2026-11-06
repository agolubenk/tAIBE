/**
 * If-None-Match по RFC 9110 §13.1.2: слабое сравнение (префикс W/ не учитывается), список тегов через запятую и «*».
 * Зачем: сжатый ответ списка (hono/compress на GET /db/:col) отдаёт тег как W/"…" — клиент присылает его обратно, и
 * строгое `===` не дало бы ни одного 304: страница и relay MCP тянули бы весь список на каждом опросе.
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
