import type { Context } from 'hono'
import { z } from 'zod'
import { apiError } from '../http-types'

/** Тело запроса через Zod: неизвестные поля срезаются, ошибка — 400 с первым понятным сообщением. */
export async function parseBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw apiError(400, 'Тело запроса — не JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw apiError(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Некорректный запрос')
  }
  return parsed.data
}

/**
 * Схема частичного обновления (PATCH): все поля необязательны, `.default()` снят. В zod 4 `.partial()` подставляет
 * значение по умолчанию в непереданное поле, и PATCH молча сбросил бы его (IS-261); здесь непереданное — не трогаем.
 */
export function patchOf<T extends z.ZodObject>(schema: T): z.ZodType<Partial<z.output<T>>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = (field instanceof z.ZodDefault ? field.unwrap() : field).optional()
  }
  // Тип полей при сборке по ключам теряется; выход — тот же объект, только все поля необязательны.
  const patch: z.ZodType = schema.extend(shape)
  return patch as z.ZodType<Partial<z.output<T>>>
}

export function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query())
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw apiError(400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'Некорректные параметры')
  }
  return parsed.data
}

export function parseId(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw apiError(400, 'Некорректный id')
  return n
}
