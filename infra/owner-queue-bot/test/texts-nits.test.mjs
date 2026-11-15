// Карточки HR zp9wxy8x (тексты бота не отправляют в замороженный артефакт) и h1vza7dp (мелочи GLM-ревью #213).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createNotes } from '../notes.mjs';
import { itemMessages } from '../view.mjs';
import { toPlain } from '../tg-html.mjs';

const DIR = join(import.meta.dirname, '..');

test('ни один текст бота, который видит владелец, не упоминает артефакт или claude.ai (zp9wxy8x)', () => {
  const bad = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.mjs'))) {
    readFileSync(join(DIR, f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\/\/ .*$/, '');
      // Строки в кавычках и шаблонах; служебные имена (watchKey, комментарии) не проверяем.
      for (const m of code.matchAll(/'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)) {
        if (/артефакт|claude\.ai/i.test(m[0])) bad.push(`${f}:${i + 1} ${m[0].slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('ошибка сохранения ответа предлагает /queue, а не артефакт (zp9wxy8x)', () => {
  const mirror = readFileSync(join(DIR, 'mirror.mjs'), 'utf8');
  assert.match(mirror, /Страница не смогла сохранить ответ в общую базу\. Повторите или ответьте на странице \/queue\./);
});

function notesHarness(confirmations) {
  const sent = [];
  const acts = [];
  const item = {
    id: 'd-1', kind: 'check', src: 'db', title: 'Пункт', chips: [], parts: [{ t: 'html', v: 'Тело' }], done: false, options: [],
    hasCheckbox: true, doneLabel: 'Проверил', fieldLabel: 'Комментарий', multiline: true, note: '', summary: '',
    agentStatus: '', agentStatusText: '', agentNote: '', saved: '', saveErr: false,
  };
  const notes = createNotes({
    tg: {}, log() {},
    mirror: { act: async (id, op, value) => { acts.push(value); return { ok: true, confirmed: confirmations.shift() ?? true }; } },
    snap: async () => ({ items: [item] }),
    send: async (chatId, msg) => { sent.push(msg.text); },
  });
  return { notes, item, sent, acts };
}

test('заметка: база не подтвердила запись — текст остаётся в поле, «💾 Сохранить» шлёт его ещё раз (h1vza7dp)', async () => {
  const h = notesHarness([false, true]);
  await h.notes.start(1, h.item);
  await h.notes.collect(1, { text: 'первая часть' });
  await h.notes.saveBuffered(1);
  assert.equal(h.notes.active(1), true, 'поле открыто — буфер не потерян');
  assert.ok(h.sent.some((s) => /подтверждение из базы ещё не пришло\. Текст остался в поле — «💾 Сохранить» отправит его ещё раз/.test(s)));
  await h.notes.saveBuffered(1);
  assert.deepEqual(h.acts, ['первая часть', 'первая часть']);
  assert.equal(h.notes.active(1), false, 'подтверждено — поле закрыто');
});

test('однострочное поле: повтор после неподтверждённой записи заменяет текст, а не склеивает (h1vza7dp)', async () => {
  const h = notesHarness([false, true]);
  h.item.multiline = false;
  await h.notes.start(1, h.item);
  await h.notes.collect(1, { text: 'старый' });
  assert.ok(h.sent.some((s) => /пришлите текст ещё раз/.test(s)));
  await h.notes.collect(1, { text: 'новый' });
  assert.deepEqual(h.acts, ['старый', 'новый']);
  assert.equal(h.notes.active(1), false);
});

// Telegram считает 4096 символов после разбора разметки (Bot API, sendMessage text): теги не в счёт, «&amp;» — один
// символ. Экранирование после обрезки поэтому не выводит сообщение за лимит, а обрезка до экранирования не режет
// сущность (п. 3 карточки — не дефект). Проверяем то, что проверяет Telegram, — каждое сообщение отдельно (п. 4).
test('длинная карточка: каждое сообщение и последнее со строкой статуса укладываются в 4096 после разбора разметки (h1vza7dp, п. 1, 3, 4)', () => {
  const status = '\n\n⏳ <i>Отправлено; подтверждение из общей базы ещё не пришло — нажмите 🔄 чуть позже.</i>';
  const amp = '&<>'.repeat(200); // экранирование удлиняет текст в 4–5 раз
  const it = {
    id: 's-1', kind: 'server', src: 'db', title: 'Сервер ' + amp, chips: [],
    parts: [{ t: 'html', v: '<p>' + 'Тело '.repeat(2000) + '</p>' }, { t: 'html', v: '<p>' + 'Ещё '.repeat(1500) + '</p>' }],
    done: true, summary: '✓ ' + amp, options: [], hasCheckbox: true, doneLabel: 'Выполнил', fieldLabel: 'Вывод', multiline: true,
    note: amp + amp, agentStatus: 'doing', agentStatusText: 'в работе', agentNote: amp, saved: '', saveErr: false,
  };
  const msgs = itemMessages(it);
  assert.ok(msgs.length > 1, 'карточка из нескольких сообщений');
  msgs.forEach((m, i) => assert.ok(toPlain(m.text).length <= 4096, `сообщение ${i}: ${toPlain(m.text).length}`));
  assert.ok(toPlain(msgs.at(-1).text + status).length <= 4096, 'последнее со строкой статуса');
});
