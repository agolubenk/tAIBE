// Машинный замок локального инференса (OPS-27). Тот же файловый flock, что у консилиума (`infra/ai-council/ollama.py`,
// `local_inference_slot`): один локальный инференс на Mac для шлюза и консилиума всех хостов. В Node нет flock, поэтому
// замок держит дочерний `python3`: берёт flock с дедлайном, пишет «ok» и ждёт конца stdin. Шлюз закрывает stdin —
// процесс выходит, ядро снимает flock. Шлюз умер (kill -9) — stdin закрылся сам, итог тот же. Держатель умер во время
// вызова — `onLost`, вызов обрывается: без замка инференс не продолжается.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Путь — как MACHINE_LOCK_REL в ollama.py: домашняя папка, вне продуктов (у launchd и терминала HOME один).
export const MACHINE_LOCK = join(homedir(), '.local', 'state', 'taibe', 'council', 'ollama-local.lock')

// Блокирующий flock с таймером, а не опрос: ядро будит ждущего сразу при освобождении. Консилиум опрашивает раз в
// 0,25 с (`_flock_by`), поэтому шлюз (интерактивные вызовы) получает следующий свободный слот. С опросом шлюз
// голодал за серией вызовов консилиума: тот брал замок снова через миллисекунды (линза продукта, 3 из 3 прогонов).
const HELPER = `
import fcntl, os, signal, sys
path, wait = sys.argv[1], float(sys.argv[2])
os.makedirs(os.path.dirname(path), exist_ok=True)
f = open(path, "a+")
signal.signal(signal.SIGALRM, lambda *a: sys.exit(3))
if wait <= 0:
    sys.exit(3)
signal.setitimer(signal.ITIMER_REAL, wait)
fcntl.flock(f.fileno(), fcntl.LOCK_EX)
signal.setitimer(signal.ITIMER_REAL, 0)
try:  # кто держит — для supervisor.py status (OPS-31); не записали — замок всё равно наш
    f.seek(0)
    f.truncate()
    f.write("%d gateway %d\\n" % (os.getpid(), os.getppid()))
    f.flush()
except OSError:
    pass
sys.stdout.write("ok\\n")
sys.stdout.flush()
sys.stdin.read()
try:  # отметка стирается до снятия замка, иначе следующий держатель без отметки выглядел бы шлюзом
    f.seek(0)
    f.truncate()
    f.flush()
except OSError:
    pass
`
const BUSY = 3

// Кто держит замок — для текста 503 (OPS-33): первая строка файла «pid кто», её пишет держатель (OPS-31): консилиум —
// «council», прогрев и установка моделей — «warmup <модель>», «setup <модель>», другой шлюз — «gateway <ppid>».
// Нет файла или отметки — так и сказано; чтение не бросает и идёт только на пути 503.
export function lockHolder(path) {
  let line = ''
  try {
    line = readFileSync(path, 'utf8').split('\n')[0].trim()
  } catch {
    return 'держатель неизвестен (файл замка не прочитать)'
  }
  const m = /^(\d+) (.+)$/.exec(line)
  if (!m) return 'держатель не записал себя'
  return /^gateway \d+$/.test(m[2]) ? `pid ${m[1]} (другой шлюз моделей)` : `pid ${m[1]} (${m[2].slice(0, 80)})`
}

// → { held: true, release(), onLost(cb) } | { busy: true } | { failed: '<причина>' }. Никогда не бросает.
// busy — замок не освободился за waitMs или клиент ушёл; failed — держатель не запустился или упал до замка.
export function acquireMachineLock({ path, waitMs, signal, python = 'python3', spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(python, ['-I', '-S', '-c', HELPER, path, String(Math.max(0, waitMs) / 1000)], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ failed: e.message })
    }
    let state = 'waiting'
    let err = ''
    let lost = null
    // Сразу после spawn: при EMFILE/ENFILE Node отдаёт процесс без stdio и шлёт 'error' — без слушателя он роняет шлюз.
    child.on('error', (e) => {
      if (state !== 'waiting') return
      state = 'done'
      signal?.removeEventListener('abort', onAbort)
      resolve({ failed: e.message })
    })
    if (!child.stdin || !child.stdout || !child.stderr) {
      state = 'done'
      return resolve({ failed: 'держатель замка запущен без stdio (нет свободных дескрипторов?)' })
    }
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    const onAbort = () => {
      if (state !== 'waiting') return
      state = 'done'
      kill()
      resolve({ busy: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdin.on('error', () => {}) // EPIPE после выхода держателя — его разбирает 'exit'
    child.stderr.on('data', (d) => {
      if (err.length < 400) err += d
    })
    child.stdout.on('data', (d) => {
      if (state !== 'waiting' || !String(d).includes('ok')) return
      state = 'held'
      signal?.removeEventListener('abort', onAbort)
      resolve({
        held: true,
        release() {
          if (state !== 'held') return
          state = 'done'
          child.stdin.end() // EOF → python выходит → flock снят; kill — если он почему-то жив через 2 с
          setTimeout(kill, 2000).unref()
        },
        onLost(cb) {
          lost = cb
        },
      })
    })
    child.on('exit', (code, sig) => {
      const was = state
      state = 'done'
      if (was === 'waiting') {
        signal?.removeEventListener('abort', onAbort)
        resolve(code === BUSY ? { busy: true } : { failed: `держатель замка вышел (${sig || code}): ${err.trim().slice(-200)}` })
      } else if (was === 'held') lost?.()
    })
  })
}
