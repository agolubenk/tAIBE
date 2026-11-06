/**
 * Запись в SQLite из одного процесса — по одной, а занятая чужим процессом база — асинхронным повтором.
 *
 * Почему не busy_timeout libsql: его ожидание синхронное и стоит циклом событий — открытая транзакция того же процесса
 * не доходит до COMMIT, ожидающий падает через весь таймаут, а консоль всё это время не отвечает. Почему не повтор без
 * шлюза: неудачный BEGIN IMMEDIATE оставляет соединение пула так, что следующее чтение на нём держит блокировку, и
 * COMMIT победителя и все следующие записи процесса падают.
 *
 * Поэтому: транзакции, batch и пишущие execute ждут асинхронный шлюз — внутри процесса BEGIN не конкурирует. Чужой
 * процесс (бэкап читает базу под блокировкой чтения) даёт SQLITE_BUSY — повтор с паузами, цикл событий свободен.
 * Чтения идут мимо шлюза. Внутри транзакции писать через getDb(), а не tx, нельзя: шлюз занят — запись ждала бы саму
 * себя; ожидание шлюза ограничено GATE_WAIT_MS и заканчивается ошибкой, а не зависанием.
 */
import type { Client, InStatement, Transaction, TransactionMode } from '@libsql/client'

/** Паузы повтора при SQLITE_BUSY, мс: всего ~1,6 с — дольше копии ночного бэкапа (доли секунды). */
const BUSY_DELAYS_MS = [20, 50, 100, 200, 400, 800]
const GATE_WAIT_MS = 10_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function isBusy(e: unknown): boolean {
  const err = e as { code?: unknown; rawCode?: unknown; message?: unknown; cause?: unknown } | null
  if (!err) return false
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') return true
  return typeof err.message === 'string' && /SQLITE_BUSY|database is locked/.test(err.message) ? true : isBusy(err.cause)
}

/** Повтор при SQLITE_BUSY с паузами; остальные ошибки — сразу. fn повторяется целиком: транзакция — с BEGIN. */
export async function retryBusy<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!isBusy(e) || i >= BUSY_DELAYS_MS.length) throw e
      await sleep(BUSY_DELAYS_MS[i]!)
    }
  }
}

/** Асинхронный замок: очередь ожидающих, без опроса. */
class Gate {
  #held = false
  #waiters: (() => void)[] = []

  acquire(): Promise<() => void> {
    let released = false
    const release = () => {
      if (released) return
      released = true
      const next = this.#waiters.shift()
      if (next) next()
      else this.#held = false
    }
    if (!this.#held) {
      this.#held = true
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve(release)
      }
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== grant)
        reject(Object.assign(new Error('SQLITE_BUSY: запись процесса ждёт шлюз дольше 10 с'), { code: 'SQLITE_BUSY' }))
      }, GATE_WAIT_MS)
      this.#waiters.push(grant)
    })
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

const READ_SQL = /^\s*(select|pragma|explain)\b/i
const sqlOf = (stmt: InStatement): string => (typeof stmt === 'string' ? stmt : stmt.sql)

/** Транзакция держит шлюз до commit, rollback или close; неудачный commit — до rollback (его зовёт drizzle). */
function gatedTransaction(tx: Transaction, release: () => void): Transaction {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      if (prop === 'commit') return async () => { await target.commit(); release() }
      if (prop === 'rollback') return async () => { try { await target.rollback() } finally { release() } }
      if (prop === 'close') return () => { try { target.close() } finally { release() } }
      return (v as (...a: unknown[]) => unknown).bind(target)
    },
  })
}

export function gateClient(client: Client): Client {
  const gate = new Gate()
  return new Proxy(client, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      if (prop === 'transaction') {
        return async (mode?: TransactionMode) => {
          const release = await gate.acquire()
          try {
            return gatedTransaction(await retryBusy(() => target.transaction(mode)), release)
          } catch (e) {
            release()
            throw e
          }
        }
      }
      if (prop === 'batch') {
        return (stmts: InStatement[], mode?: TransactionMode) => gate.run(() => retryBusy(() => target.batch(stmts, mode)))
      }
      if (prop === 'execute') {
        return (stmt: InStatement, args?: unknown) => {
          const exec = () => (args === undefined ? target.execute(stmt) : target.execute(stmt as string, args as never))
          return READ_SQL.test(sqlOf(stmt)) ? retryBusy(exec) : gate.run(() => retryBusy(exec))
        }
      }
      return (v as (...a: unknown[]) => unknown).bind(target)
    },
  })
}
