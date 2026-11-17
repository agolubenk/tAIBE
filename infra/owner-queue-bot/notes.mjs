// Ввод текста в поле пункта (комментарий, вывод команды): многострочный — несколькими сообщениями или
// файлом до «💾 Сохранить», однострочный — сразу. Ввод живёт 10 минут и сбрасывается навигацией,
// чтобы случайный текст позже (поиск) не затёр комментарий в общей базе.
import { btn, cut, esc, itemMessages, nextOpen } from './view.mjs';

const TTL_MS = 10 * 60_000;
const NOTE_MAX = 20_000; // как у поля на странице

export function createNotes({ tg, mirror, snap, send, log }) {
  const pending = new Map(); // chatId → { key, id, buf, multiline, at }

  const get = (chatId) => {
    const p = pending.get(chatId);
    if (p && Date.now() - p.at > TTL_MS) { pending.delete(chatId); return null; }
    return p || null;
  };

  async function start(chatId, it) {
    pending.set(chatId, { key: null, id: it.id, buf: [], multiline: it.multiline, at: Date.now() });
    const how = it.multiline
      ? 'Пришлите текст — можно несколькими сообщениями или файлом .txt, — затем нажмите «💾 Сохранить».'
      : 'Пришлите текст одним сообщением — сохраню сразу.';
    const kb = it.multiline
      ? [[btn('💾 Сохранить', 'ns'), btn('🧹 Очистить поле', 'nx'), btn('✖️ Отмена', 'nc')]]
      : [[btn('🧹 Очистить поле', 'nx'), btn('✖️ Отмена', 'nc')]];
    await send(chatId, {
      text: `✏️ <b>${esc(it.fieldLabel || 'Комментарий')}</b>\n«${esc(cut(it.title, 160))}»\n\n${how}\nВвод ждёт 10 минут; /cancel — отменить.${it.note ? `\n\nСейчас в поле: <i>${esc(cut(it.note, 400))}</i>` : ''}`,
      keyboard: kb,
    });
  }

  async function save(chatId, text) {
    const p = get(chatId);
    if (!p) return send(chatId, { text: 'Нет открытого поля (или прошло больше 10 минут). Откройте пункт и нажмите ✏️.' });
    // Однострочное поле страницы вырезает переносы — заменяем сами, иначе сверка с базой не сойдётся.
    const note = (p.multiline ? text : text.replace(/\s*\n\s*/g, ' ')).slice(0, NOTE_MAX);
    const res = await mirror.act(p.id, 'note', note, (d) => (d.note || '') === note);
    if (!res.ok) return send(chatId, { text: `⚠️ ${esc(res.error)}\nТекст не потерян — пришлите «💾 Сохранить» ещё раз или /cancel.` });
    // Буфер — только после подтверждения из базы (GLM-ревью #213, карточка HR h1vza7dp): запись могла не дойти, и
    // без буфера текст уже не отправить повторно. Не подтверждено — поле остаётся открытым с тем же текстом.
    if (res.confirmed) pending.delete(chatId);
    log(`текст в поле: ${p.id}, ${note.length} симв.`);
    const s = await snap();
    const it = s.items.find((x) => x.id === p.id);
    await send(chatId, { text: `💾 ${note ? `Сохранено (${note.length} симв.)` : 'Поле очищено'}${res.confirmed ? ' — агенты видят.' : `; подтверждение из базы ещё не пришло. Текст остался в поле — ${p.multiline ? '«💾 Сохранить» отправит его ещё раз' : 'пришлите текст ещё раз'}, /cancel — закрыть поле.`}${text.length > NOTE_MAX ? `\nОбрезано до ${NOTE_MAX} символов, как на странице.` : ''}` });
    if (it) {
      const msgs = itemMessages(it, { next: nextOpen(s, it) });
      await send(chatId, msgs[msgs.length - 1]);
    }
  }

  async function collect(chatId, m) {
    const p = get(chatId);
    let text = m.text || m.caption || '';
    if (m.document) {
      const doc = m.document;
      if (!(/^text\//.test(doc.mime_type || '') || /\.(txt|log|md|json|csv|out|sh)$/i.test(doc.file_name || ''))) {
        return send(chatId, { text: 'Пришлите текстовый файл (.txt, .log) или вставьте текст сообщением.' });
      }
      text = await tg.downloadText(doc.file_id, 1_000_000);
    }
    if (!text) return send(chatId, { text: 'Нужен текст или текстовый файл.' });
    // Однострочное поле — одно сообщение и есть весь текст: повтор после неподтверждённой записи заменяет буфер.
    if (p.multiline) p.buf.push(text); else p.buf = [text];
    p.at = Date.now();
    if (!p.multiline) return save(chatId, p.buf.join('\n'));
    const total = p.buf.join('\n').length;
    return send(chatId, { text: `Принято: ${total} симв. в ${p.buf.length} сообщ. Ещё текст — или «💾 Сохранить».`, keyboard: [[btn('💾 Сохранить', 'ns'), btn('✖️ Отмена', 'nc')]] });
  }

  return {
    active: (chatId) => !!get(chatId),
    start,
    collect,
    saveBuffered: (chatId) => {
      const p = get(chatId);
      if (!p?.buf.length) return send(chatId, { text: 'Пока ничего не прислано. Пришлите текст или нажмите «🧹 Очистить поле».' });
      return save(chatId, p.buf.join('\n'));
    },
    clear: (chatId) => (get(chatId) ? save(chatId, '') : send(chatId, { text: 'Поле уже закрыто. Откройте пункт и нажмите ✏️.' })),
    cancel: (chatId) => pending.delete(chatId),
  };
}
