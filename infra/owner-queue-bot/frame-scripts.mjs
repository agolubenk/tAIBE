// Функции, которые выполняются ВНУТРИ фрейма артефакта (frame.evaluate сериализует их исходник).
// Поэтому каждая самодостаточна: никаких замыканий и импортов.
// Источник истины — отрисованная страница: бот читает то же, что видит владелец, и жмёт те же кнопки,
// так что логика артефакта (сохранение, пункты из базы, «Ход работ») не дублируется.

/** Признак фрейма артефакта «Очередь владельца». */
export function isQueueFrame() {
  return !!document.getElementById('sec-decision') && !!document.getElementById('mode');
}

/** Снимок страницы: шапка, разделы, пункты с ответами и статусами агентов, «Ход работ». */
export function snapshotPage() {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // DOM → подмножество HTML, которое понимает Telegram (b, i, code, pre, a).
  function conv(node) {
    if (node.nodeType === 3) return esc(node.textContent.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    const inner = () => Array.from(node.childNodes).map(conv).join('');
    switch (tag) {
      case 'BR': return '\n';
      case 'BUTTON': case 'SCRIPT': case 'STYLE': return '';
      // Пометка домена у ссылки страницы (safeLink) — бот считает её сам в sanitizeTg (tg-html.mjs), без повтора.
      case 'SPAN': if (node.classList.contains('link-host')) return ''; return inner();
      case 'P': case 'DIV': case 'H3': case 'H4': return inner().trim() + '\n\n';
      case 'H2': { const s = inner().trim(); return s ? '<b>' + s + '</b>\n' : ''; }
      case 'UL': return Array.from(node.children).map((li) => '• ' + conv(li).trim()).join('\n') + '\n\n';
      case 'OL': return Array.from(node.children).map((li, i) => (i + 1) + '. ' + conv(li).trim()).join('\n') + '\n\n';
      case 'B': case 'STRONG': { const s = inner(); return s.trim() ? '<b>' + s + '</b>' : s; }
      case 'I': case 'EM': { const s = inner(); return s.trim() ? '<i>' + s + '</i>' : s; }
      case 'CODE': return '<code>' + esc(node.textContent) + '</code>';
      case 'PRE': return '<pre>' + esc(node.textContent) + '</pre>\n';
      case 'A': {
        const href = node.getAttribute('href') || '';
        const s = inner();
        return /^https?:\/\/[^\s"<>]+$/.test(href) ? '<a href="' + esc(href).replace(/"/g, '&quot;') + '">' + s + '</a>' : s;
      }
      default: return inner();
    }
  }
  const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Тело пункта по порядку: текст и командные блоки (их владелец копирует).
  function parts(container) {
    const out = [];
    let buf = '';
    const flush = () => { const s = tidy(buf); if (s) out.push({ t: 'html', v: s }); buf = ''; };
    Array.from(container.childNodes).forEach((n) => {
      if (n.nodeType === 1 && n.classList.contains('cmd')) {
        flush();
        const code = n.querySelector('code');
        out.push({ t: 'cmd', v: code ? code.textContent : '' });
      } else buf += conv(n);
    });
    flush();
    return out;
  }

  const items = Array.from(document.querySelectorAll('.item[data-id]')).map((el) => {
    const sec = el.closest('section[data-section]');
    const body = el.querySelector('.item-body');
    const field = el.querySelector('.field');
    const ag = el.querySelector('.agent-status');
    const st = ag && ag.classList.contains('on') ? ag.querySelector('.st') : null;
    const agSpans = ag ? ag.querySelectorAll('span') : [];
    const saved = el.querySelector('.saved');
    return {
      id: el.dataset.id,
      kind: sec ? sec.dataset.section : '',
      src: el.dataset.src === 'db' ? 'db' : 'seed',
      title: txt(el.querySelector('.item-title')),
      chips: Array.from(el.querySelectorAll('.chips .chip')).map((c) => txt(c)),
      parts: body ? parts(body) : [],
      done: el.classList.contains('is-done'),
      options: Array.from(el.querySelectorAll('.opt')).map((b) => ({
        id: b.dataset.opt,
        label: (b.childNodes[0] ? b.childNodes[0].textContent : '').trim(),
        hint: txt(b.querySelector('small')),
        pressed: b.getAttribute('aria-pressed') === 'true',
      })),
      hasCheckbox: !!el.querySelector('.cb'),
      doneLabel: txt(el.querySelector('.done-row')),
      fieldLabel: txt(el.querySelector('label.answer-label[for]')),
      multiline: !!field && field.tagName === 'TEXTAREA',
      note: field ? field.value : '',
      summary: txt(el.querySelector('.summary-answer')),
      agentStatus: st ? (Array.from(st.classList).find((c) => c.indexOf('st-') === 0) || '').slice(3) : '',
      agentStatusText: txt(st),
      agentNote: st && agSpans[1] ? txt(agSpans[1]).replace(/^Агент:\s*/, '') : '',
      saved: txt(saved),
      saveErr: !!saved && saved.classList.contains('err'),
    };
  });

  const sections = Array.from(document.querySelectorAll('section[data-section]')).map((s) => ({
    kind: s.dataset.section,
    title: txt(s.querySelector('h2.sec')),
    count: txt(s.querySelector('[data-count]')),
    note: txt(s.querySelector('.sec-note')),
  }));

  const report = Array.from(document.querySelectorAll('#report tbody tr')).map((tr) => {
    const td = tr.querySelectorAll('td');
    const a = td[7] ? td[7].querySelector('a') : null;
    return {
      title: txt(td[0]), track: txt(td[1]), who: txt(td[2]), status: txt(td[3]),
      plan: txt(td[4]), fact: txt(td[5]), lag: txt(td[6]),
      note: td[7] ? txt(td[7]).replace(a ? txt(a) : '\u0000', '').trim() : '',
      link: a ? a.getAttribute('href') : '',
      linkText: txt(a),
    };
  });

  const modeEl = document.getElementById('mode');
  const howto = document.querySelector('header .howto');
  const ssh = document.getElementById('ssh-howto');
  // Связь страницы с консолью (window.__oqConn ставит подмена базы консоли, page-scripts.ts): причина для сигнала
  // «Очередь не подключилась к консоли». null — старая консоль без записи или страница не дошла до опроса.
  const c = window.__oqConn && window.__oqConn.checks;
  const conn = c ? { okAt: +c.okAt || 0, errAt: +c.errAt || 0, err: String(c.err || '').slice(0, 200), status: +c.status || 0, fails: +c.fails || 0 } : null;
  return {
    conn,
    title: txt(document.querySelector('h1')),
    lede: txt(document.querySelector('.lede')),
    guide: howto ? tidy(conv(howto)) : '',
    sshGuide: ssh ? tidy(conv(ssh)) : '',
    news: Array.from(document.querySelectorAll('.done-today')).map((p) => tidy(conv(p))),
    checkedAt: txt(document.querySelector('.status-row > span')),
    mode: modeEl ? modeEl.dataset.mode : 'pending',
    modeText: txt(modeEl),
    progress: txt(document.getElementById('progress')),
    sections,
    items,
    dash: {
      asof: txt(document.getElementById('dash-asof')),
      kpis: Array.from(document.querySelectorAll('#kpis .kpi')).map((k) => ({ value: txt(k.querySelector('b')), label: txt(k.querySelector('span')) })),
      status: Array.from(document.querySelectorAll('#ch-status .hb')).map((r) => ({ name: txt(r.querySelector('.hb-name')), value: txt(r.querySelector('.hb-val')) })),
      // Только «Просрочено сейчас» — прямые дети графика; закрытые не в срок свёрнуты в <details> внутри него.
      lag: Array.from(document.querySelectorAll('#ch-lag > .hb')).map((r) => ({ name: txt(r.querySelector('.hb-name')), value: txt(r.querySelector('.hb-val')) })),
      report,
    },
    footer: txt(document.querySelector('footer')),
  };
}

/**
 * Действие владельца через элементы самой страницы — тот же путь, что клик мышью:
 * обработчики артефакта сами сохраняют ответ в checks/<id>.
 */
export function actOnItem({ id, op, value }) {
  const mode = document.getElementById('mode');
  if (!mode || mode.dataset.mode !== 'shared') {
    return { ok: false, error: 'Страница не подключена к общей базе (режим «' + (mode ? mode.dataset.mode : '?') + '»): ответ сохранился бы только в браузере бота.' };
  }
  const el = document.querySelector('.item[data-id="' + CSS.escape(id) + '"]');
  if (!el) return { ok: false, error: 'Пункт не найден на странице — возможно, его убрали.' };
  const fire = (node) => node.dispatchEvent(new Event('change', { bubbles: true }));
  if (op === 'choose') {
    const b = el.querySelector('.opt[data-opt="' + CSS.escape(value) + '"]');
    if (!b) return { ok: false, error: 'Такого варианта у пункта уже нет.' };
    b.click();
  } else if (op === 'done') {
    const cb = el.querySelector('.cb');
    if (!cb) return { ok: false, error: 'У пункта нет отметки «Сделано».' };
    if (cb.checked !== !!value) { cb.checked = !!value; fire(cb); }
  } else if (op === 'note') {
    const f = el.querySelector('.field');
    if (!f) return { ok: false, error: 'У пункта нет поля для текста.' };
    f.value = String(value);
    fire(f);
  } else if (op === 'reopen') {
    const r = el.querySelector('.reopen');
    if (!r) return { ok: false, error: 'Нечего менять.' };
    r.click();
  } else return { ok: false, error: 'Неизвестное действие' };
  return { ok: true };
}

/**
 * Своя подписка на checks/: подтверждает, что ответ дошёл до общей базы, а не только до страницы.
 * Ставится только в режиме shared, подключение к базе — не дольше 5 с; сбойная подписка ставится заново.
 * Каждый снимок коллекции заменяет кэш целиком (удалённые документы не «залипают»).
 */
export async function installChecksWatch(key) {
  const mode = document.getElementById('mode');
  if (!mode || mode.dataset.mode !== 'shared' || !window.claude || !window.claude.use) return false;
  const prev = window[key];
  if (prev && (prev.ok || (!prev.err && Date.now() - prev.since < 10000))) return prev.ok;
  const st = (window[key] = { checks: {}, ok: false, err: '', since: Date.now() });
  try {
    const db = await Promise.race([
      window.claude.use('db'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('база не ответила за 5 с')), 5000)),
    ]);
    db.collection('checks').onSnapshot((snap) => {
      let list = Array.isArray(snap) ? snap : (snap && (snap.docs || snap.items || snap.rows || snap.results)) || [];
      if (!Array.isArray(list) && typeof list === 'object') list = Object.keys(list).map((k) => ({ id: k, data: list[k] }));
      const next = {};
      list.forEach((d) => {
        const id = d.id || d.key || d.doc_id || (typeof d.path === 'string' ? d.path.split('/').pop() : '');
        const data = typeof d.data === 'function' ? d.data() : (d.data || d.value || d.fields || d);
        if (id && data && typeof data === 'object') next[id] = data;
      });
      st.checks = next;
      st.ok = true;
      st.err = '';
    }, (e) => { st.ok = false; st.err = String((e && e.message) || e); });
  } catch (e) { st.err = String((e && e.message) || e); }
  return st.ok;
}

export function readCheck({ key, id }) {
  const st = window[key];
  return st ? { ready: st.ok, err: st.err, data: st.checks[id] || null } : { ready: false, err: 'нет подписки', data: null };
}

/** Текст метки, если сохранение ответа не удалось или ответ изменён в другом месте; '' — всё в порядке. */
export function saveErrorOf(id) {
  const el = document.querySelector('.item[data-id="' + CSS.escape(id) + '"] .saved');
  return el && el.classList.contains('err') ? (el.textContent || 'err') : '';
}

/** На время скриншотов — шире колонка, чтобы Гант и роадмап влезли без прокрутки. */
export function setShotLayout(on) {
  let s = document.getElementById('oqb-shot');
  if (on && !s) {
    s = document.createElement('style');
    s.id = 'oqb-shot';
    s.textContent = '.wrap{max-width:1260px!important}.tip{display:none!important}';
    document.head.appendChild(s);
  } else if (!on && s) s.remove();
  return true;
}
