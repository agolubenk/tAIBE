// Минимальный клиент Telegram Bot API: long polling и несколько методов.
// Токен живёт только в URL запроса и никогда не попадает в логи (redact).
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API = 'https://api.telegram.org';

/**
 * Один повтор после 429 (Too Many Requests), если Telegram просит подождать не дольше capS секунд: дольше — ошибка
 * наружу сразу, чтобы не держать обработку остальных нажатий. Остальные ошибки — наружу без повтора.
 */
export async function retryFlood(fn, { sleep, capS = 5 }) {
  try {
    return await fn();
  } catch (e) {
    const wait = Number(e?.retryAfter) || 1;
    if (e?.code !== 429 || wait > capS) throw e;
    await sleep(wait * 1000);
    return fn();
  }
}

const apiError = (redact, method, json, status) => {
  const err = new Error(redact(`${method}: ${json.description || status}`));
  err.code = json.error_code;
  err.retryAfter = json.parameters?.retry_after;
  return err;
};

export class TelegramApi {
  constructor(token) {
    this.token = token;
    this.base = `${API}/bot${token}`;
  }

  redact(text) {
    return String(text).split(this.token).join('<token>');
  }

  async call(method, params = {}, { timeoutMs = 20_000 } = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) throw apiError((t) => this.redact(t), method, json, res.status);
    return json.result;
  }

  async getUpdates(offset) {
    return this.call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: 65_000 });
  }

  send(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }

  async edit(chatId, messageId, text, extra = {}) {
    try {
      return await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    } catch (e) {
      // Тот же текст и клавиатура — не ошибка для нас.
      if (/message is not modified/.test(e.message)) return null;
      throw e;
    }
  }

  answer(callbackId, text = '', showAlert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackId, text: text.slice(0, 190), show_alert: showAlert }).catch(() => null);
  }

  async upload(method, form) {
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    const json = await res.json().catch(() => ({ ok: false }));
    if (!json.ok) throw apiError((t) => this.redact(t), method, json, res.status);
    return json.result;
  }

  /** Текстовый файл (длинная команда целиком). Подпись — простой текст. */
  sendDocument(chatId, name, text, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([text], { type: 'text/plain' }), name);
    return this.upload('sendDocument', form);
  }

  /** Заменить файл сообщения-документа на месте (editMessageMedia): карточка не растёт на 🔄 (линза Claude #343, B1). */
  async editDocument(chatId, messageId, name, text, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('message_id', String(messageId));
    form.append('media', JSON.stringify({ type: 'document', media: 'attach://doc', caption: caption.slice(0, 1000) }));
    form.append('doc', new Blob([text], { type: 'text/plain' }), name);
    try {
      return await this.upload('editMessageMedia', form);
    } catch (e) {
      if (/message is not modified/.test(e.message)) return null;
      throw e;
    }
  }

  /**
   * Скриншоты: альбомами по 2–10 фото; одиночное — sendPhoto; слишком длинное для фото Telegram
   * (сумма сторон > 10000 или соотношение > 20) — файлом, иначе упал бы весь альбом.
   */
  async sendPhotos(chatId, photos) {
    const fits = (p) => { const w = p.buf.readUInt32BE(16); const h = p.buf.readUInt32BE(20); return w + h <= 10_000 && Math.max(w, h) / Math.min(w, h) <= 20; };
    const asPhotos = photos.filter(fits);
    for (const p of photos.filter((x) => !fits(x))) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', String(p.caption || '').slice(0, 1000));
      form.append('document', new Blob([p.buf], { type: 'image/png' }), 'chart.png');
      await this.upload('sendDocument', form);
    }
    for (let i = 0; i < asPhotos.length; i += 10) {
      const batch = asPhotos.slice(i, i + 10);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (batch.length === 1) {
        form.append('caption', String(batch[0].caption || '').slice(0, 1000));
        form.append('photo', new Blob([batch[0].buf], { type: 'image/png' }), 'p0.png');
        await this.upload('sendPhoto', form);
        continue;
      }
      form.append('media', JSON.stringify(batch.map((p, j) => ({ type: 'photo', media: `attach://p${j}`, caption: String(p.caption || '').slice(0, 1000) }))));
      batch.forEach((p, j) => form.append(`p${j}`, new Blob([p.buf], { type: 'image/png' }), `p${j}.png`));
      await this.upload('sendMediaGroup', form);
    }
  }

  /**
   * Файл у Telegram — потоком во временный файл (вложение входящего): не больше maxBytes, обрыв на лимите.
   * Ошибка «слишком большой» несёт tooBig — повтор не поможет. Адрес файла содержит токен: в ошибки он не попадает.
   */
  async downloadTo(fileId, path, maxBytes) {
    const file = await this.call('getFile', { file_id: fileId });
    const tooBig = () => Object.assign(new Error('Файл больше лимита Bot API'), { tooBig: true });
    if (!file.file_path) throw new Error('Telegram не отдал файл');
    if ((file.file_size || 0) > maxBytes) throw tooBig();
    try {
      const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) throw new Error(`Не скачался файл: HTTP ${res.status}`);
      let size = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) return cb(tooBig());
          return cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(path, { mode: 0o600 }));
      return size;
    } catch (e) {
      if (e?.tooBig) throw e;
      throw new Error(this.redact(e?.message || String(e)));
    }
  }

  async downloadText(fileId, maxBytes) {
    const file = await this.call('getFile', { file_id: fileId });
    if (!file.file_path || (file.file_size || 0) > maxBytes) throw new Error('Файл слишком большой');
    const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Не скачался файл: HTTP ${res.status}`);
    return (await res.text()).slice(0, maxBytes);
  }
}
