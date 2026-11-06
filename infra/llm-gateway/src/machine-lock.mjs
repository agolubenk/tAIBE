// Машинный замок локального инференса (OPS-27). Тот же файловый flock, что у консилиума (`infra/ai-council/ollama.py`,
// `local_inference_slot`): один локальный инференс на Mac для шлюза и консилиума всех хостов. В Node нет flock, поэтому
// замок держит дочерний `python3`: берёт flock с дедлайном, пишет «ok» и ждёт конца stdin. Шлюз закрывает stdin —
// процесс выходит, ядро снимает flock. Шлюз умер (kill -9) — stdin закрылся сам, итог тот же. Держатель умер во время
// вызова — `onLost`, вызов обрывается: без замка инференс не продолжается.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Путь — как MACHINE_LOCK_REL в ollama.py: домашняя папка, вне продуктов (у launchd и терминала HOME один).
export const MACHINE_LOCK = join(homedir(), '.local', 'state', 'taibe', 'council', 'ollama-local.lock')

// Опрос раз в 0,25 с — как `_flock_by` консилиума: ни шлюз, ни консилиум не получают преимущества в очереди.
const HELPER = `
import fcntl, os, sys, time
path, deadline = sys.argv[1], time.time() + float(sys.argv[2])
os.makedirs(os.path.dirname(path), exist_ok=True)
f = open(path, "a+")
while True:
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.time() >= deadline:
            sys.exit(3)
        time.sleep(0.25)
sys.stdout.write("ok\\n")
sys.stdout.flush()
sys.stdin.read()
`
const BUSY = 3

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
