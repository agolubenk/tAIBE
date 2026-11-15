// node --test infra/owner-queue-bot/test — отрисовка в Telegram на синтетическом снимке страницы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTg } from '../tg-html.mjs';
import {
  backNotice, connReason, itemMessages, keyOf, localNotice, menuFingerprint, menuView, nextOpen, optKey, pack, searchView,
  sectionView, verOf, workMessages,
} from '../view.mjs';

const item = (over = {}) => ({
  id: 'd-x', kind: 'decision', src: 'seed', title: 'Решение <x>', chips: [], parts: [{ t: 'html', v: 'Тело <b>жирное</b>' }],
  done: false, options: [{ id: 'yes', label: 'Да', hint: 'рекомендую', pressed: false }], hasCheckbox: false,
  doneLabel: '', fieldLabel: 'Комментарий', multiline: false, note: '', summary: '', agentStatus: '', agentStatusText: '',
  agentNote: '', saved: '', saveErr: false, ...over,
});
const snapOf = (items) => ({
  title: 'Очередь', progress: 'Сделано 0 из 3', checkedAt: 'Сверено', mode: 'shared', news: ['Новое'], guide: '', sshGuide: 'ssh',
  sections: ['decision', 'merge', 'server', 'check'].map((k) => ({ kind: k, title: k, count: '0 из 1', note: '' })),
  items, footer: '', dash: { asof: '', kpis: [], status: [], lag: [], report: [] },
});

// Баланс тегов, допустимых в HTML Telegram, и лимит длины.
function assertTelegramHtml(text) {
  assert.ok(text.length <= 4096, `длина ${text.length}`);
  const stack = [];
  for (const m of text.matchAll(/<(\/?)(b|i|code|pre|a)(\s[^>]*)?>/g)) {
    if (!m[1]) stack.push(m[2]);
    else assert.equal(stack.pop(), m[2], `несбалансирован </${m[2]}>`);
  }
  assert.deepEqual(stack, []);
  assert.doesNotMatch(text.replace(/<\/?(b|i|code|pre|a)(\s[^>]*)?>/g, ''), /<[a-z/]/i);
}
const callbacks = (kb) => (kb || []).flat().map((b) => b.callback_data);

test('ключи коротки и стабильны: callback_data укладывается в 64 байта при id до 80 символов', () => {
  const id = 'x'.repeat(80);
  assert.equal(keyOf(id), keyOf(id));
  assert.notEqual(keyOf('a'), keyOf('b'));
  const msgs = itemMessages(item({ id, options: [{ id: 'y'.repeat(40), label: 'L'.repeat(200), hint: '', pressed: false }] }));
  for (const cb of callbacks(msgs.at(-1).keyboard)) assert.ok(Buffer.byteLength(cb) <= 64, cb);
  assert.ok(callbacks(msgs.at(-1).keyboard).some((c) => c.startsWith(`o:${keyOf(id)}:${optKey('y'.repeat(40))}:`)));
});

test('заголовок экранируется, длинное тело — несколько сообщений в пределах лимита', () => {
  const cmd = Array.from({ length: 60 }, (_, i) => `echo "строка ${i} <&>"`).join('\n');
  const text = Array.from({ length: 40 }, (_, i) => `Абзац ${i}: ` + 'текст '.repeat(30)).join('\n');
  const msgs = itemMessages(item({ kind: 'server', hasCheckbox: true, doneLabel: 'Выполнил', multiline: true, parts: [{ t: 'html', v: text }, { t: 'cmd', v: cmd }] }));
  assert.ok(msgs.length >= 3, 'тело длинное — несколько сообщений плюс ответ');
  msgs.forEach((m) => assertTelegramHtml(m.text));
  assert.ok(msgs.some((m) => m.text.includes('&lt;&amp;&gt;')), 'команда экранирована в блоке кода');
  assert.match(msgs[0].text, /Решение &lt;x&gt;/);
  assert.ok(msgs.at(-1).keyboard, 'кнопки — на последнем сообщении');
  assert.ok(callbacks(msgs.at(-1).keyboard).some((c) => c.startsWith('d:')));
});

test('короткая карточка — одним сообщением, выбранный вариант отмечен', () => {
  const msgs = itemMessages(item({ done: true, summary: '✓ Да', options: [{ id: 'yes', label: 'Да', hint: '', pressed: true }] }));
  assert.equal(msgs.length, 1);
  assertTelegramHtml(msgs[0].text);
  assert.match(msgs[0].keyboard[0][0].text, /^✅ Да/);
  assert.ok(callbacks(msgs[0].keyboard).some((c) => c.startsWith('r:')), 'есть «Изменить ответ»');
});

test('«Следующий» ведёт к следующему открытому пункту раздела по кругу', () => {
  const a = item({ id: 'a' }); const b = item({ id: 'b', done: true }); const c = item({ id: 'c' });
  const s = snapOf([a, b, c]);
  assert.equal(nextOpen(s, a).id, 'c');
  assert.equal(nextOpen(s, c).id, 'a');
  assert.equal(nextOpen(snapOf([a]), a), null);
});

test('раздел скрывает выполненные и листается страницами', () => {
  const items = Array.from({ length: 30 }, (_, i) => item({ id: `i${i}`, done: i % 3 === 0 }));
  const s = snapOf(items);
  const v = sectionView(s, 'decision');
  assert.equal(v.keyboard.filter((r) => r[0].callback_data.startsWith('i:')).length, 12);
  assert.ok(callbacks(v.keyboard).includes('s:decision:1:0'));
  assert.ok(callbacks(v.keyboard).includes('s:decision:0:1'), 'кнопка «Показать выполненные»');
  assertTelegramHtml(v.text);
});

test('меню: счётчики, живой отпечаток меняется вместе с ответами', () => {
  const s = snapOf([item({ id: 'a' }), item({ id: 'b', src: 'db' })]);
  const m = menuView(s, { notify: true });
  assertTelegramHtml(m.text);
  assert.ok(callbacks(m.keyboard).includes('f'), 'есть «От сессий»');
  const fp = menuFingerprint(s);
  s.items[0].done = true;
  assert.notEqual(menuFingerprint(s), fp);
});

test('поиск по заголовку и телу без учёта регистра', () => {
  const s = snapOf([item({ id: 'a', title: 'Мёрж #140' }), item({ id: 'b', parts: [{ t: 'html', v: 'про <code>nginx</code>' }] })]);
  assert.equal(searchView(s, '#140').keyboard.length, 2);
  assert.equal(searchView(s, 'NGINX').keyboard.length, 2);
  assert.match(searchView(s, 'нет-такого').text, /ничего не найдено/);
});

test('pack не превышает лимит и не теряет текст', () => {
  const pieces = Array.from({ length: 50 }, (_, i) => `кусок ${i} `.repeat(30));
  const out = pack(pieces, 1000);
  out.forEach((t) => assert.ok(t.length <= 1000));
  assert.equal(out.join('\n\n').replace(/\s+/g, ''), pieces.join('').replace(/\s+/g, ''));
});

test('pack: длинная строка не режется внутри ссылки, пометка домена не теряется и не дублируется (ревью #327, п. 2)', () => {
  const link = '<a href="https://evil.com/">github.com</a> (⚠️ ведёт на evil.com)';
  for (const pad of [3780, 3800, 3820, 3840, 3860]) {
    const out = pack([`${'x'.repeat(pad)} ${link} ${'y'.repeat(300)}`]);
    out.forEach((t) => assertTelegramHtml(t));
    const all = out.join('\n');
    if (all.includes('<a ')) assert.ok(all.includes(link), `pad ${pad}`);
    // Обрезка по сырой строке оставила бы обломок пометки вроде « (⚠…» рядом с целой.
    assert.ok(!all.replace(link, '').includes('⚠'), `pad ${pad}: ${all.slice(-120)}`);
    assert.equal(all.split('ведёт на evil.com').length - 1, all.includes('<a ') ? 1 : 0, `pad ${pad}`);
  }
  // Перенос строки внутри подписи не разрывает ссылку между сообщениями: без замены на пробел первая строка подписи
  // ушла бы в первое сообщение, а «#5</a> (evil.com)» — во второе.
  const multi = pack([`${'z '.repeat(1900)}\n${sanitizeTg('<a href="https://evil.com/">Инцидент\n#5</a>')}\n${'w'.repeat(200)}`]);
  multi.forEach((t) => assertTelegramHtml(t));
  assert.equal(multi.length, 2);
  assert.ok(multi[1].startsWith('<a href="https://evil.com/">Инцидент #5</a> (evil.com)'), multi[1].slice(0, 80));
});

test('«Ход работ»: ссылки только https, отставание помечено', () => {
  const s = snapOf([]);
  s.dash.report = [
    { title: 'Задача', track: 'Ops', who: 'агент', status: 'в работе', plan: '1 окт', fact: '—', lag: '+3', note: '', link: 'javascript:alert(1)', linkText: 'x' },
    { title: 'Другая', track: 'Ops', who: 'вы', status: 'сделано', plan: '1 окт', fact: '1 окт', lag: '0', note: '', link: 'https://github.com/x', linkText: '#1' },
  ];
  const text = workMessages(s).map((m) => m.text).join('\n');
  assertTelegramHtml(text);
  assert.doesNotMatch(text, /javascript:/);
  assert.match(text, /⚠️ \+3 дн\./);
  assert.match(text, /href="https:\/\/github.com\/x"/);
});

test('версия пункта меняется при подмене текста или варианта и входит в кнопки ответа', () => {
  const a = item();
  const v = verOf(a);
  assert.notEqual(verOf(item({ title: 'Другое' })), v);
  assert.notEqual(verOf(item({ options: [{ id: 'yes', label: 'Нет', hint: '', pressed: false }] })), v);
  assert.equal(verOf(item({ done: true, note: 'x', summary: '✓ Да' })), v, 'ответ владельца версию не меняет');
  assert.ok(callbacks(itemMessages(a).at(-1).keyboard).some((c) => c.startsWith('o:') && c.endsWith(`:${v}`)));
});

test('длинная команда уходит файлом целиком, невидимые символы — предупреждение', () => {
  const cmd = 'echo x\n'.repeat(1000);
  const msgs = itemMessages(item({ kind: 'server', hasCheckbox: true, doneLabel: 'Выполнил', parts: [{ t: 'cmd', v: cmd }] }));
  const doc = msgs.find((m) => m.document);
  assert.ok(doc, 'есть вложение');
  assert.equal(doc.document.text, cmd, 'команда целиком, без обрезки');
  assert.ok(msgs.at(-1).keyboard, 'последнее сообщение — ответ с кнопками');
  const warn = itemMessages(item({ kind: 'server', hasCheckbox: true, parts: [{ t: 'cmd', v: 'ls ‮etc' }] }));
  assert.match(warn[0].text, /невидимые символы/);
  assert.match(warn[0].text, /⟦U\+202E⟧/);
});

test('HTML из фрейма проходит белый список: javascript-ссылка не попадает в сообщение', () => {
  const msgs = itemMessages(item({ parts: [{ t: 'html', v: '<a href="javascript:alert(1)">клик</a> <script>x</script>' }] }));
  assertTelegramHtml(msgs[0].text);
  assert.doesNotMatch(msgs[0].text, /javascript:|<script>/);
});

test('у открытого пункта мёржа — «Влить сейчас», у выполненного нет; в разделе мёржей — перезапуск деплоя', () => {
  const open = itemMessages(item({ kind: 'merge', hasCheckbox: true, doneLabel: 'Влил', options: [] }));
  assert.ok(callbacks(open.at(-1).keyboard).some((c) => c.startsWith('M:')));
  const done = itemMessages(item({ kind: 'merge', hasCheckbox: true, doneLabel: 'Влил', options: [], done: true, summary: '✓ Влил' }));
  assert.ok(!callbacks(done.at(-1).keyboard).some((c) => c.startsWith('M:')));
  const s = snapOf([item({ id: 'm1', kind: 'merge', options: [] })]);
  assert.ok(callbacks(sectionView(s, 'merge').keyboard).includes('RD'));
});

test('сигнал «страница без базы»: причина по ответу консоли (просьба владельца 14.11)', () => {
  assert.match(connReason({ okAt: 1, errAt: 2, status: 401, err: 'HTTP 401', fails: 3 }), /не приняла токен бота \(ответ 401\)/);
  assert.match(connReason({ okAt: 1, errAt: 2, status: 403, err: 'HTTP 403', fails: 3 }), /токен отозван или истёк/);
  assert.match(connReason({ okAt: 1, errAt: 2, status: 502, err: 'HTTP 502', fails: 3 }), /ошибкой 502 — .*выкатке/);
  assert.match(connReason({ okAt: 0, errAt: 2, status: 0, err: 'Failed to fetch', fails: 3 }), /не ответила по сети \(Failed to fetch\)/);
  assert.equal(connReason({ okAt: 1, errAt: 2, status: 429, err: 'HTTP 429', fails: 3 }), 'консоль ответила 429');
  assert.equal(connReason({ okAt: 1, errAt: 2, status: 409, err: 'конфликт', fails: 3 }), 'консоль ответила 409: конфликт');
  assert.match(connReason(null), /опроса не было/);
  assert.match(connReason({ okAt: 5, errAt: 0, status: 0, err: '', fails: 0 }), /хотя консоль отвечала/);
});

test('сигнал «страница без базы»: последний удачный ответ по Москве, следующая перезагрузка, подсказка; HTML валиден', () => {
  const okAt = Date.UTC(2026, 10, 14, 14, 2); // 17:02 МСК
  const n = localNotice({ okAt, errAt: okAt + 60_000, status: 502, err: 'HTTP 502', fails: 3 }, { now: okAt + 3 * 60_000, nextReloadMs: 60_000, hint: 'token-list <на сервере>' });
  assert.match(n.text, /^🟠 <b>Очередь не подключилась к консоли<\/b>/);
  assert.match(n.text, /Последний удачный ответ консоли — 17:02 МСК \(3 мин назад\)/);
  assert.match(n.text, /Неудачных опросов подряд: 3/);
  assert.match(n.text, /перезагрузит страницу через 1 мин/);
  assert.match(n.text, /token-list &lt;на сервере&gt;/);
  assertTelegramHtml(n.text);
  const never = localNotice(null, { now: okAt, nextReloadMs: 60_000, hint: '' });
  assert.match(never.text, /Удачных ответов консоли с открытия страницы не было/);
  assert.doesNotMatch(never.text, /Если связь не вернётся/);
  assertTelegramHtml(never.text);
});

test('связь вернулась: сколько её не было, не меньше минуты', () => {
  assert.match(backNotice(4 * 60_000).text, /^🟢 .*Связи не было около 4 мин\.$/);
  assert.match(backNotice(5_000).text, /около 1 мин/);
});
