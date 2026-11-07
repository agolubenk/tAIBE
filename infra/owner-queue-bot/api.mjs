// Клиент API очереди в ops-консоли (/api/oq/v1): мёрж и перезапуск деплоя из Telegram, входящие из Telegram и их
// вложения. Сами ответы бот пишет через страницу /queue (её код и сохраняет), а мёрж — прямым вызовом API:
// у страницы в боте нет диалогов подтверждения, подтверждение — кнопками Telegram.
import { openAsBlob } from 'node:fs';

export class QueueApi {
  constructor({ url, token }) {
    this.base = `${new URL(url).origin}/api/oq/v1`;
    this.token = token;
  }

  async call(method, path, body, timeoutMs = 30_000) {
    const res = await fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Консоль ответила HTTP ${res.status}`), { status: res.status });
    return json;
  }

  mergeInfo(itemId) { return this.call('GET', `/merge/${encodeURIComponent(itemId)}`); }
  /** version — версия пункта с экрана подтверждения: пункт меняли после показа — консоль ответит 409. */
  merge(itemId, sha, version) { return this.call('POST', `/merge/${encodeURIComponent(itemId)}`, { sha, version }); }
  redeploy() { return this.call('POST', '/redeploy', {}); }
  /** Входящее из Telegram: пункт kind inbox (схема — server/queue/store.ts консоли). ifVersion 0 — только создание. */
  putItem(id, data, ifVersion) { return this.call('PUT', `/db/items/${encodeURIComponent(id)}`, { data, ...(ifVersion !== undefined ? { ifVersion } : {}) }); }
  getItem(id) { return this.call('GET', `/db/items/${encodeURIComponent(id)}`); }
  /** Автопередача входящих сессии ({ alive, sessions, relayed }): ответ на входящее ждёт её не дольше 3 с. */
  relay() { return this.call('GET', '/relay', undefined, 3_000); }
  /** Сводка вложений: лимиты (maxBytes, maxPerItem) и включено ли хранилище. */
  filesSummary() { return this.call('GET', '/files/summary'); }
  /** Файлы входящего (сколько уже приложено — для режима «Прикрепить файл»). */
  listFiles(itemId) { return this.call('GET', `/files?item=${encodeURIComponent(itemId)}`); }

  /**
   * Вложение входящего: тело — сам файл с диска (Blob из файла: размер известен, Content-Length ставит fetch), имя —
   * X-File-Name. Ошибка несёт status ответа консоли: 4xx — повтор не поможет, 5xx и сеть — повторяет очередь.
   */
  async uploadFile(itemId, name, path) {
    const res = await fetch(`${this.base}/files?item=${encodeURIComponent(itemId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
      body: await openAsBlob(path),
      signal: AbortSignal.timeout(180_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Консоль ответила HTTP ${res.status}`), { status: res.status });
    return json;
  }
}
