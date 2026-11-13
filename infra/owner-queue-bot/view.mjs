// Отрисовка снимка артефакта в сообщения Telegram (HTML) и inline-клавиатуры.
import { createHash } from 'node:crypto';
import { cutTg, escText, LINK_UNIT_RE, revealInvisible, safeHttps, sanitizeTg, toPlain } from './tg-html.mjs';

export const KINDS = {
  decision: { icon: '🧭', cmd: 'decisions' },
  merge: { icon: '🔀', cmd: 'merges' },
  server: { icon: '🖥', cmd: 'server' },
  check: { icon: '✋', cmd: 'checks' },
  inbox: { icon: '📥', cmd: 'inbox' },
};
const ST_ICON = { taken: '🙋', doing: '⚙️', done: '☑️', blocked: '⏸', planned: '🗓' };
const MAX = 3900; // запас до лимита Telegram 4096
const BODY_INLINE = 2500; // тело короче — карточка одним сообщением
const PAGE = 12;
// Язык у блока кода — у клиентов Telegram появляется кнопка «Копировать».
const PRE_OPEN = '<pre><code class="language-bash">';
const PRE_CLOSE = '</code></pre>';

// Текст со страницы — экранирован, невидимые символы показаны метками (заголовки, подписи, заметки).
export const esc = (s) => escText(revealInvisible(s).text);
export const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// Линия сессии растёт на сегмент за поколение (r.62u1 → r.62u1.ab12), а начало у сессий одной роли общее: обрезка
// конца делала их одинаковыми (OPS-39). Показ — «…» и два последних сегмента; не линия — первые n знаков, как cut.
const SESSION_LINE = /^r(\.[a-z0-9]+)+$/;
export const lineTail = (s, n) => {
  const t = String(s ?? '');
  const seg = SESSION_LINE.test(t) ? t.split('.') : [];
  return seg.length > 3 ? '…' + seg.slice(-2).join('.') : cut(t, n);
};
export const btn = (text, data) => ({ text: cut(revealInvisible(text).text, 64), callback_data: data });
const plain = toPlain;

/** Короткий ключ id для callback_data (лимит 64 байта, а id пунктов бывают до 80 символов). */
export const keyOf = (id) => createHash('sha1').update(String(id)).digest('base64url').slice(0, 10);
export const optKey = (optId) => keyOf('opt:' + optId).slice(0, 6);

export function sectionOf(snap, kind) {
  return snap.sections.find((s) => s.kind === kind) || { kind, title: kind, count: '', note: '' };
}

/** Режем HTML-кусочки по границам частей; длинную команду — по строкам в несколько блоков кода. */
export function pack(pieces, limit = MAX) {
  const out = [];
  let cur = '';
  const push = (p) => {
    if (cur && cur.length + p.length + 2 > limit) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + p : p;
  };
  pieces.filter(Boolean).forEach((p) => {
    if (p.length <= limit) return push(p);
    const isPre = p.startsWith(PRE_OPEN);
    // Ссылку с пометкой домена не режем (ревью #327, п. 2): перенос строки внутри неё — пробел, длинную строку
    // обрезает cutTg по границе ссылки, тега или сущности.
    const inner = isPre ? p.slice(PRE_OPEN.length, p.length - PRE_CLOSE.length) : p.replace(LINK_UNIT_RE, (u) => u.replace(/\n/g, ' '));
    const room = limit - PRE_OPEN.length - PRE_CLOSE.length - 8;
    let chunk = '';
    // Текстовый кусок, разрезанный по строкам, мог разорвать тег — sanitizeTg закроет и уберёт лишнее
    // (пометку домена у целой ссылки он не повторит).
    const flush = () => { if (chunk) push(isPre ? PRE_OPEN + chunk + PRE_CLOSE : sanitizeTg(chunk)); chunk = ''; };
    inner.split('\n').forEach((line) => {
      const l = line.length > room ? cutTg(line, room - 1) + '…' : line;
      if (chunk.length + l.length + 1 > room) flush();
      chunk = chunk ? chunk + '\n' + l : l;
    });
    flush();
  });
  if (cur) out.push(cur);
  return out;
}

function modeLine(snap, hint) {
  if (snap.mode === 'shared') return '🟢 ответы сохраняются в общую базу — агенты их видят';
  if (snap.mode === 'local') return `🟠 страница открыта без базы: ${hint}`;
  return '⏳ страница подключается к базе…';
}

// Входящее закрывает агент («сделано») или владелец («Принято»); остальные пункты — только ответ владельца.
const isClosed = (it) => it.done || (it.kind === 'inbox' && it.agentStatus === 'done');
const openOf = (snap, kind) => snap.items.filter((it) => it.kind === kind && !isClosed(it));
const freshOf = (snap) => snap.items.filter((it) => it.src === 'db' && !it.done);

/** Отпечаток сводки: меняется — бот правит последнее меню в чате, чтобы сводка была живой. */
export function menuFingerprint(snap) {
  return JSON.stringify([snap.progress, snap.mode, snap.checkedAt, snap.news[0], ...Object.keys(KINDS).map((k) => openOf(snap, k).length), freshOf(snap).length]);
}

export function menuView(snap, { notify, hint = 'нужен вход в claude.ai в браузере бота' }) {
  const lines = [`<b>${esc(snap.title)}</b>`, `${esc(snap.progress)} · ${esc(snap.checkedAt)}`, modeLine(snap, esc(hint))];
  if (snap.news[0]) lines.push('', plainSafe(sanitizeTg(snap.news[0])));
  lines.push('');
  Object.keys(KINDS).forEach((k) => {
    const s = sectionOf(snap, k);
    const open = openOf(snap, k).length;
    const waiting = k === 'inbox' ? `у агентов: ${open}` : `ждут: ${open}`;
    lines.push(`${KINDS[k].icon} <b>${esc(s.title)}</b> — ${esc(s.count)}${open ? ` · <b>${waiting}</b>` : ' · всё закрыто'}`);
  });
  const secBtn = (k) => btn(`${KINDS[k].icon} ${sectionOf(snap, k).title} · ${openOf(snap, k).length}`, `s:${k}:0:0`);
  const fresh = freshOf(snap).length;
  return {
    text: lines.join('\n'),
    keyboard: [
      [secBtn('decision'), secBtn('merge')],
      [secBtn('server'), secBtn('check')],
      [secBtn('inbox')],
      ...(fresh ? [[btn(`🆕 От сессий · ${fresh}`, 'f')]] : []),
      [btn('📊 Ход работ', 'w'), btn('📈 Графики и Гант', 'g')],
      [btn('🔄 Обновить', 'm'), btn(notify ? '🔔 Уведомления: вкл' : '🔕 Уведомления: выкл', 't'), btn('ℹ️ Справка', 'v')],
    ],
  };
}

/** Сводка из страницы уже в HTML Telegram; обрезка по символам не должна резать теги — режем по plain-тексту. */
function plainSafe(html) {
  return html.length <= 1400 ? html : esc(cut(plain(html), 1400));
}

function itemMarks(it) {
  return (it.done ? '✅ ' : '') + (it.agentStatus ? (ST_ICON[it.agentStatus] || '🤖') + ' ' : '') + (it.src === 'db' ? '🆕 ' : '');
}

function listKeyboard(list) {
  return list.map((it) => [btn(itemMarks(it) + it.title, `i:${keyOf(it.id)}`)]);
}

export function sectionView(snap, kind, { page = 0, showDone = false } = {}) {
  const s = sectionOf(snap, kind);
  const all = snap.items.filter((it) => it.kind === kind);
  const doneCount = all.filter((it) => it.done).length;
  const list = showDone ? all : all.filter((it) => !it.done);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const lines = [`${KINDS[kind].icon} <b>${esc(s.title)}</b> — ${esc(s.count)}`];
  if (s.note) lines.push(`<i>${esc(cut(s.note, 500))}</i>`);
  lines.push('');
  if (!list.length) lines.push(doneCount ? 'Открытых пунктов нет — всё выполнено.' : 'Пунктов нет.');
  else lines.push('Нажмите пункт, чтобы открыть. ✅ выполнено · 🆕 от сессии · ⚙️🙋⏸ статус агента');
  const kb = listKeyboard(list.slice(p * PAGE, p * PAGE + PAGE));
  const sd = showDone ? 1 : 0;
  const nav = [];
  if (p > 0) nav.push(btn('◀️', `s:${kind}:${p - 1}:${sd}`));
  if (pages > 1) nav.push(btn(`${p + 1}/${pages}`, `s:${kind}:${p}:${sd}`));
  if (p < pages - 1) nav.push(btn('▶️', `s:${kind}:${p + 1}:${sd}`));
  if (nav.length) kb.push(nav);
  if (doneCount) kb.push([btn(showDone ? '🙈 Скрыть выполненные' : `👁 Показать выполненные (${doneCount})`, `s:${kind}:0:${sd ? 0 : 1}`)]);
  if (kind === 'server' && snap.sshGuide) kb.push([btn('🔐 Как подключиться к серверу', 'h')]);
  if (kind === 'merge') kb.push([btn('♻️ Перезапустить деплой', 'RD')]);
  kb.push([btn('🏠 Меню', 'm')]);
  return { text: lines.join('\n'), keyboard: kb };
}

export function freshView(snap) {
  const list = freshOf(snap);
  return {
    text: `🆕 <b>Пункты от сессий</b> — открыто ${list.length}\n\nИх добавили агенты через базу артефакта; у каждого пометка «от: …».`,
    keyboard: [...listKeyboard(list.slice(0, 30)), [btn('🏠 Меню', 'm')]],
  };
}

export function searchView(snap, query) {
  const q = query.toLowerCase();
  const hits = snap.items.filter((it) => (it.title + ' ' + it.chips.join(' ') + ' ' + it.parts.map((p) => plain(p.v)).join(' ')).toLowerCase().includes(q));
  return {
    text: hits.length
      ? `🔎 «${esc(cut(query, 60))}» — найдено ${hits.length}${hits.length > 20 ? ', показаны первые 20' : ''}`
      : `🔎 «${esc(cut(query, 60))}» — ничего не найдено. /menu — сводка.`,
    keyboard: [...listKeyboard(hits.slice(0, 20)), [btn('📥 Во входящие', 'ibn'), btn('🏠 Меню', 'm')]],
  };
}

export function guideMessages(snap) {
  const pieces = [HELP];
  if (snap.guide) pieces.push(sanitizeTg(snap.guide));
  snap.news.slice(1).forEach((n) => pieces.push(sanitizeTg(n)));
  if (snap.footer) pieces.push(`<i>${esc(snap.footer)}</i>`);
  const msgs = pack(pieces).map((text) => ({ text }));
  msgs[msgs.length - 1].keyboard = [[btn('🏠 Меню', 'm')]];
  return msgs;
}

export function sshMessages(snap) {
  const msgs = pack([snap.sshGuide ? sanitizeTg(snap.sshGuide) : 'Инструкции нет.']).map((text) => ({ text }));
  msgs[msgs.length - 1].keyboard = [[btn(`${KINDS.server.icon} К разделу`, 's:server:0:0'), btn('🏠 Меню', 'm')]];
  return msgs;
}

const CMD_INLINE = 3000; // команда длиннее — файлом .sh целиком: резать скрипт на куски для копирования опасно
const ANSWER_MAX = 1700; // потолок блока ответа (все его поля обрезаны) — раскладка карточки от ответа не зависит

/** Тело карточки: текст (через белый список), команды блоками кода; длинные команды — вложениями-файлами. */
function bodyPieces(it) {
  const pieces = [];
  const docs = [];
  it.parts.forEach((p) => {
    if (p.t !== 'cmd') return pieces.push(sanitizeTg(p.v));
    const { text, found } = revealInvisible(p.v);
    if (found) pieces.push('⚠️ <b>В команде есть невидимые символы</b> (показаны как ⟦U+…⟧) — не выполняйте, пока не разберётесь.');
    if (text.length <= CMD_INLINE) return pieces.push(PRE_OPEN + escText(text) + PRE_CLOSE);
    const name = `${String(it.id).replace(/[^A-Za-z0-9_.-]/g, '_')}-${docs.length + 1}.sh`;
    docs.push({ name, text: p.v, caption: `Команда из «${cut(revealInvisible(it.title).text, 200)}» целиком` });
    pieces.push(`📎 Команда длиннее сообщения — целиком в файле <code>${escText(name)}</code> ниже.`);
  });
  return { pieces, docs };
}

/** Версия содержимого пункта: кнопка с устаревшей версией не сработает, если агент подменил текст или варианты. */
export function verOf(it) {
  return keyOf([it.title, it.chips.join('·'), it.parts.map((p) => p.v).join('\n'), it.options.map((o) => `${o.id}=${o.label}`).join(';')].join('|')).slice(0, 5);
}

function answerBlock(it) {
  const lines = [];
  if (it.done) lines.push(`✅ <b>${esc(cut(it.summary.replace(/^✓\s*/, ''), 300) || 'Сделано')}</b>`);
  else lines.push(it.kind === 'decision' ? '⏳ <b>Ждёт вашего выбора</b>' : `⏳ <b>Ждёт отметки «${esc(it.doneLabel || 'Сделано')}»</b>`);
  if (it.agentStatus) lines.push(`${ST_ICON[it.agentStatus] || '🤖'} Агент: <b>${esc(it.agentStatusText)}</b>${it.agentNote ? ' — ' + esc(cut(it.agentNote, 400)) : ''}`);
  if (it.note) lines.push(`📝 ${esc(it.fieldLabel || 'Комментарий')}: <i>${esc(cut(it.note, 600))}</i>`);
  if (it.saveErr) lines.push('⚠️ Не сохранилось у агента — повторите');
  else if (it.saved) lines.push(`<i>${esc(it.saved)}</i>`);
  return lines.join('\n');
}

/** Следующий открытый пункт того же раздела (по кругу) — для разбора очереди подряд. */
export function nextOpen(snap, it) {
  const list = snap.items.filter((x) => x.kind === it.kind && (!x.done || x.id === it.id));
  const i = list.findIndex((x) => x.id === it.id);
  for (let k = 1; k < list.length; k++) {
    const cand = list[(i + k) % list.length];
    if (!cand.done && cand.id !== it.id) return cand;
  }
  return null;
}

function itemKeyboard(it, next) {
  const k = keyOf(it.id);
  const v = verOf(it);
  const kb = [];
  if (it.kind === 'decision') {
    it.options.forEach((o) => kb.push([btn(`${o.pressed ? '✅ ' : ''}${o.label}${o.hint ? ' · ' + o.hint : ''}`, `o:${k}:${optKey(o.id)}:${v}`)]));
  } else if (it.hasCheckbox) {
    kb.push([it.done ? btn(`↩️ Снять «${it.doneLabel || 'Сделано'}»`, `d:${k}:0:${v}`) : btn(`✅ ${it.doneLabel || 'Сделано'}`, `d:${k}:1:${v}`)]);
  }
  if (it.kind === 'merge' && !it.done) kb.unshift([btn('🚀 Влить сейчас…', `M:${k}:${v}`)]);
  const row = [btn(`✏️ ${cut(it.fieldLabel || 'Комментарий', 30)}`, `n:${k}`)];
  if (it.kind === 'decision' && it.done) row.push(btn('↩️ Изменить ответ', `r:${k}:${v}`));
  kb.push(row);
  const nav = [btn(`⬅️ ${KINDS[it.kind]?.icon || ''} Раздел`, `s:${it.kind}:0:0`), btn('🔄', `i:${k}:r`)];
  if (next) nav.push(btn('➡️ Следующий', `i:${keyOf(next.id)}`));
  nav.push(btn('🏠', 'm'));
  kb.push(nav);
  return kb;
}

/**
 * Карточка пункта. Последнее сообщение всегда несёт ответ и кнопки — его бот и правит после действия.
 * Раскладка зависит только от тела и потолка блока ответа, поэтому стабильна между правками.
 * Длинные команды — сообщения { document } перед последним.
 */
export function itemMessages(it, { next = null } = {}) {
  const head = `${KINDS[it.kind]?.icon || '•'} <b>${esc(it.title)}</b>` + (it.chips.length ? `\n<i>${esc(it.chips.join(' · '))}</i>` : '');
  const { pieces, docs } = bodyPieces(it);
  const bodyLen = pieces.reduce((n, p) => n + p.length + 2, 0);
  const answer = { text: answerBlock(it), keyboard: itemKeyboard(it, next) };
  const files = docs.map((document) => ({ document }));
  if (!docs.length && head.length + bodyLen + ANSWER_MAX <= MAX && bodyLen <= BODY_INLINE) {
    return [{ text: [head, ...pieces, '— — —', answer.text].filter(Boolean).join('\n\n'), keyboard: answer.keyboard }];
  }
  const chunks = pack([head, ...pieces]).map((text) => ({ text }));
  return [...chunks, ...files, { text: `${head}\n\n${answer.text}`, keyboard: answer.keyboard }];
}

export function workMessages(snap) {
  const d = snap.dash;
  const pieces = [`📊 <b>Ход работ</b> · ${esc(d.asof)}`];
  if (d.kpis.length) pieces.push(d.kpis.map((k) => `• <b>${esc(k.value)}</b> — ${esc(k.label)}`).join('\n'));
  if (d.status.length) pieces.push('<b>Готовность по разделам</b>\n' + d.status.map((s) => `• ${esc(s.name)} — ${esc(s.value)}`).join('\n'));
  if (d.lag.length) pieces.push('<b>Просрочено сейчас</b>\n' + d.lag.map((s) => `• ${esc(s.name)} — ${esc(s.value)}`).join('\n'));
  const byTrack = new Map();
  d.report.forEach((r) => { if (!byTrack.has(r.track)) byTrack.set(r.track, []); byTrack.get(r.track).push(r); });
  byTrack.forEach((rows, track) => {
    pieces.push(`<b>${esc(track)}</b>\n` + rows.map((r) => {
      const late = /^\+/.test(r.lag) ? ` · <b>⚠️ ${esc(r.lag)} дн.</b>` : '';
      const url = safeHttps(r.link);
      const link = url ? ` · <a href="${escText(url.href).replace(/"/g, '&quot;')}">${esc(r.linkText || url.host)}</a>` : '';
      return `• ${esc(r.title)} — <i>${esc(r.status)}</i>, ${esc(r.who)}; план ${esc(r.plan)}, факт ${esc(r.fact)}${late}${link}`;
    }).join('\n'));
  });
  const msgs = pack(pieces).map((text) => ({ text }));
  msgs[msgs.length - 1].keyboard = [[btn('📈 Графики и Гант', 'g'), btn('🏠 Меню', 'm')]];
  return msgs;
}

export function newItemsNotice(items) {
  const lines = [`🆕 <b>${items.length === 1 ? 'Новый пункт' : 'Новые пункты'} в очереди</b>`];
  items.slice(0, 8).forEach((it) => {
    const from = it.chips.find((c) => c.startsWith('от: '));
    lines.push(`${KINDS[it.kind]?.icon || '•'} ${esc(it.title)}${from ? ` <i>(${esc(from)})</i>` : ''}`);
  });
  if (items.length > 8) lines.push(`…и ещё ${items.length - 8}`);
  return { text: lines.join('\n'), keyboard: [...items.slice(0, 8).map((it) => [btn(`Открыть: ${it.title}`, `i:${keyOf(it.id)}`)]), [btn('🏠 Меню', 'm')]] };
}

export function agentNotice(it) {
  return {
    text: `${ST_ICON[it.agentStatus] || '🤖'} <b>Агент: ${esc(it.agentStatusText)}</b>\n${esc(it.title)}${it.agentNote ? '\n<i>' + esc(cut(it.agentNote, 600)) + '</i>' : ''}`,
    keyboard: [[btn('Открыть пункт', `i:${keyOf(it.id)}`), btn('🏠 Меню', 'm')]],
  };
}

export const HELP = [
  '<b>Бот «Очередь владельца»</b> повторяет артефакт: те же пункты, кнопки и ответы, сохранение в ту же базу.',
  '',
  '/menu — сводка и разделы (сводка обновляется сама)',
  '/decisions · /merges · /server · /checks · /inbox — разделы',
  '/work — «Ход работ»: показатели, отставание, отчёт по задачам',
  '/charts — графики, Гант и роадмап картинками',
  '/notify — включить или выключить уведомления',
  'Мёрж: в карточке PR — «🚀 Влить сейчас…»: экран подтверждения с SHA и последствием (деплой или нет), затем «Да».',
  '/cancel — отменить ввод текста',
  'Перешлите сюда сообщение (алерт, жалобу, мысль) — бот предложит положить его во входящие: угадает тип и срочность, поправите кнопками. Дальше ведёт агент-сессия, статусы придут сюда. /inbox — входящие.',
  'Любой другой текст — поиск по пунктам; под результатами — «📥 Во входящие».',
  '',
  'Команды из пунктов бот только показывает — у блока кода есть «Копировать». Сам бот ничего не выполняет.',
  'Длинный вывод команды присылайте несколькими сообщениями или файлом .txt, затем «💾 Сохранить».',
].join('\n');
