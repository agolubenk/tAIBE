/**
 * Управление очередью владельца на сервере консоли (`npm run oq -- <команда>`):
 *   token-create <имя> <области через запятую: read,agent,owner> [продукты через запятую, по умолчанию hr-helper; * — все,
 *                только с owner] [срок в днях]                    — выпустить токен (показывается один раз)
 *   token-list                                                   — токены без секретов
 *   token-revoke <id>                                            — отозвать
 *   merge-token                                                  — токен GitHub для мёржей: читается из stdin
 *   import <папка выгрузки>                                      — история артефакта (checks/ items/ work/ *.json)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../db/migrate'
import { encryptSecret } from '../lib/crypto'
import { getGithubSettings, writeSetting } from '../settings/store'
import { createToken, listTokens, revokeToken } from './auth'
import { listProducts } from './products'
import { COLLECTIONS, importDoc, type Scope } from './store'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const ch of process.stdin) chunks.push(ch as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  await runMigrations()
  switch (cmd) {
    case 'token-create': {
      const [name, scopes, products, days] = args
      if (!name || !scopes) throw new Error('token-create <имя> <read,agent,owner> [продукты] [срок в днях]')
      const t = await createToken(name, scopes.split(',').map((s) => s.trim()) as Scope[], {
        products: products ? products.split(',').map((s) => s.trim()) : undefined,
        expiresDays: days ? Number(days) : undefined,
      })
      const until = days ? `до ${new Date(Date.now() + Number(days) * 86_400_000).toISOString().slice(0, 10)}` : 'бессрочный'
      console.log(`Токен #${t.id} «${name}» (${scopes}; ${products ?? 'по умолчанию'}; ${until}) — сохраните сейчас, повторно не показывается:\n${t.token}`)
      return
    }
    case 'token-list':
      for (const t of await listTokens()) console.log(`#${t.id}\t${t.name}\t${t.scopes}\t${t.products}\t${t.revoked ? 'отозван' : t.expiresAt && t.expiresAt.getTime() <= Date.now() ? 'истёк' : 'активен'}\tдо: ${t.expiresAt?.toISOString() ?? 'бессрочно'}\tпоследний раз: ${t.lastUsedAt?.toISOString() ?? '—'}`)
      return
    case 'token-revoke': {
      const ok = await revokeToken(Number(args[0]))
      console.log(ok ? 'Отозван.' : 'Нет такого активного токена.')
      return
    }
    case 'merge-token': {
      const token = await readStdin()
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) throw new Error('Ожидается токен GitHub (github_pat_… или ghp_…) в stdin')
      const gh = await getGithubSettings()
      await writeSetting('github', { ...gh, mergeTokenEnc: encryptSecret(token) })
      console.log('Токен для мёржей сохранён (зашифрован).')
      return
    }
    case 'import': {
      const dir = args[0]
      if (!dir || !statSync(dir).isDirectory()) throw new Error('import <папка выгрузки с checks/ items/ work/>')
      const products = await listProducts()
      for (const col of COLLECTIONS) {
        const sub = join(dir, col)
        const files = (() => { try { return readdirSync(sub).filter((f) => f.endsWith('.json')) } catch { return [] } })()
        const counts = { added: 0, kept: 0, invalid: 0 }
        const bad: string[] = []
        for (const f of files) {
          const id = f.slice(0, -5)
          const res = await importDoc(col, id, JSON.parse(readFileSync(join(sub, f), 'utf8')) as Record<string, unknown>, 'import:artifact', products)
          counts[res]++
          if (res === 'invalid') bad.push(id)
        }
        console.log(`${col}: добавлено ${counts.added}, уже было ${counts.kept}, не прошло проверку ${counts.invalid}${bad.length ? ` (${bad.slice(0, 10).join(', ')})` : ''}`)
      }
      return
    }
    default:
      console.log('Команды: token-create <имя> <области> · token-list · token-revoke <id> · merge-token (stdin) · import <папка>')
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`Ошибка: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  },
)
