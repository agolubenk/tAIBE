/**
 * Запись в SQLite из одного процесса — по одной: транзакции, batch, миграции и пишущие execute ждут асинхронный шлюз,
 * чтения идут мимо. Без него одновременные записи консоли конкурировали за BEGIN, и проигравшая падала с SQLITE_BUSY.
 *
 * Синхронное ожидание libsql (timeout, client.ts) без шлюза стоит циклом событий: открытая транзакция того же процесса
 * не доходит до COMMIT, ожидающий падает через весь таймаут. Со шлюзом внутри процесса никто не ждёт — ожидание
 * остаётся только для чужого процесса (бэкап, CLI).
 *
 * Повтора SQLITE_BUSY нет: libsql не сбрасывает оператор, упавший с BUSY, и повтор на том же соединении «проходит», но
 * не фиксируется (запись теряется молча) или держит блокировку до сборки мусора.
 *
 * Внутри транзакции писать через getDb(), а не tx, нельзя: шлюз занят — запись ждала бы саму себя; ожидание шлюза
 * ограничено GATE_WAIT_MS и заканчивается 503, а не зависанием.
 */
import type { Client, InStatement, Transaction, TransactionMode } from '@libsql/client'
import { apiError } from '../http-types'

const GATE_WAIT_MS = 10_000

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
        reject(apiError(503, 'Запись в базу консоли ждёт очереди дольше 10 с — повторите позже'))
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
    get(target, prop) {
      // receiver — сам объект: геттеры с приватными полями (closed) не работают на прокси.
      const v = Reflect.get(target, prop, target) as unknown
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
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown
      if (typeof v !== 'function') return v
      if (prop === 'transaction') {
        return async (mode?: TransactionMode) => {
          const release = await gate.acquire()
          try {
            return gatedTransaction(await target.transaction(mode), release)
          } catch (e) {
            release()
            throw e
          }
        }
      }
      if (prop === 'batch' || prop === 'migrate' || prop === 'executeMultiple') {
        return (...args: unknown[]) => gate.run(() => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args))
      }
      if (prop === 'execute') {
        return (stmt: InStatement, args?: unknown) => {
          const exec = () => (args === undefined ? target.execute(stmt) : target.execute(stmt as string, args as never))
          return READ_SQL.test(sqlOf(stmt)) ? exec() : gate.run(exec)
        }
      }
      return (v as (...a: unknown[]) => unknown).bind(target)
    },
  })
}
