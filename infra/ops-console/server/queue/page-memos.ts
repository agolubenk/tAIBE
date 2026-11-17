/**
 * «Памятки» в шапке /queue (решение владельца d-queue-memos — кнопка в шапке, 17.11). Памятка — то, что владельцу
 * нужно под рукой надолго, а не пункт к выполнению: «Телефон потерян или украден» и две команды на Mac. Документ
 * work/memo-<id> (у продукта не по умолчанию — work/<slug>-memo-<id>: id без префикса принадлежит HR, и токен другого
 * продукта его не запишет) {kind: 'memo', title, body, cmds: [{label, cmd}], order, added, source, archived}. Пишет агент,
 * когда владелец просит «вынеси в памятки»; владелец скрывает и возвращает (archived) — PATCH, как ответ на странице.
 * Памятки не пункты: не входят в счётчик «Очередь» и в бот, строкой «Хода работ» не становятся (page.html пропускает
 * kind memo).
 * Документы — из снимка подмены базы (window.__oqDocs('work'): полный, без отбора по продукту — памятки общие), без
 * своих запросов: страница и так опрашивает work. Окно — как «Отчёты» (dialog.sheet). Весь текст — textContent.
 * Чистые функции — MEMOS_PURE (их исполняет tests/queue-page-memos.test.ts), разметка и запросы — MEMOS_DOM.
 */
export const MEMOS_PURE = String.raw`
var OQM_ID = /^(?:[a-z][a-z0-9-]{1,30}-)?memo-[A-Za-z0-9_.~:@+-]{1,75}$/;
// Невидимые и меняющие направление символы — метками ⟦U+…⟧, как у ссылок пунктов: владелец копирует и запускает
// команду, а на экране такие символы не видны (агент мог подменить команду).
var OQM_INVISIBLE = /(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}|[\p{Cf}\p{Co}]/gu;
function oqmReveal(s) {
  return String(s == null ? '' : s).replace(OQM_INVISIBLE, function (c) {
    var hex = c.codePointAt(0).toString(16).toUpperCase();
    while (hex.length < 4) hex = '0' + hex;
    return '⟦U+' + hex + '⟧';
  });
}
function oqmHidden(s) { OQM_INVISIBLE.lastIndex = 0; var r = OQM_INVISIBLE.test(String(s || '')); OQM_INVISIBLE.lastIndex = 0; return r; }
function oqmPad(n) { return (n < 10 ? '0' : '') + n; }
/** «Записал taibe-07, изменено 17.11 16:05» — кто и когда: памятку может переписать любой агент. */
function oqmByline(m) {
  var parts = [];
  if (m.source) parts.push('Записал ' + m.source);
  if (m.updatedAt > 0) {
    var d = new Date(m.updatedAt);
    parts.push((m.version > 1 ? 'изменено ' : 'записано ') + oqmPad(d.getDate()) + '.' + oqmPad(d.getMonth() + 1) + ' ' + oqmPad(d.getHours()) + ':' + oqmPad(d.getMinutes()));
  }
  return parts.join(', ');
}
function oqmStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
/** Памятки из снимка work: только kind memo с заголовком; порядок — order, затем дата, затем заголовок. */
function oqmList(docs) {
  var out = [];
  (Array.isArray(docs) ? docs : []).forEach(function (d) {
    var x = d && d.data;
    if (!x || x.kind !== 'memo' || !OQM_ID.test(String(d.id)) || !oqmStr(x.title, 200).trim()) return;
    var cmds = (Array.isArray(x.cmds) ? x.cmds : []).filter(function (c) { return c && typeof c.cmd === 'string' && c.cmd.trim(); })
      .slice(0, 10).map(function (c) { return { label: oqmStr(c.label, 200), cmd: c.cmd.slice(0, 4000), hidden: oqmHidden(c.cmd) }; });
    out.push({
      id: d.id, title: oqmStr(x.title, 200), body: oqmStr(x.body, 4000), cmds: cmds, archived: x.archived === true,
      source: oqmStr(x.source, 80), version: typeof d.version === 'number' ? d.version : 0,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
      order: typeof x.order === 'number' && isFinite(x.order) ? x.order : 1e9, added: oqmStr(x.added, 10),
    });
  });
  return out.sort(function (a, b) {
    return a.order - b.order || (a.added < b.added ? 1 : a.added > b.added ? -1 : 0) || (a.title < b.title ? -1 : 1);
  });
}
/** Абзацы текста: пустая строка делит абзацы, переносы внутри абзаца сохраняются (CSS pre-line). */
function oqmParas(body) {
  return String(body || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
}
`

const MEMOS_DOM = String.raw`
  var API = '/api/oq/v1/db/work/';
  var css = document.createElement('style');
  css.textContent = '.hb-memos { flex: none; }' +
    '.memo-list { display: grid; gap: 12px; padding: 12px 16px 16px; }' +
    '.memo { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }' +
    '.memo h3 { margin: 0 0 6px; font-size: 16px; }' +
    '.memo p { margin: 6px 0; white-space: pre-line; line-height: 1.5; }' +
    '.memo-cmd { margin: 10px 0 0; }' +
    '.memo-cmd-label { margin-bottom: 4px; color: var(--muted); font-size: 13px; }' +
    '.memo-by { margin: 0 0 6px; color: var(--muted); font-size: 12px; }' +
    '.memo-warn { margin: 6px 0 0; color: var(--warn); font-size: 13px; }' +
    '.memo-cmd pre { margin: 0; padding: 10px 12px; overflow-x: auto; border-radius: 8px; background: var(--code-bg); font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; }' +
    '.memo-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }' +
    '.memo-btn { min-height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; font-size: 14px; cursor: pointer; }' +
    '.memo-btn:hover, .memo-btn:focus-visible { border-color: var(--accent); color: var(--accent); }' +
    '.memo-btn.quiet { color: var(--muted); }' +
    '.memo-empty { padding: 16px; color: var(--muted); line-height: 1.5; }' +
    '.memo-hidden { padding: 0 16px 16px; }' +
    '.memo-hidden > summary { cursor: pointer; color: var(--muted); padding: 8px 0; }' +
    '.memo-err { margin: 8px 16px 0; color: var(--warn); }' +
    '@media (max-width: 1399.98px) { .hb-memos .hb-long { display: none; } .hb-memos .hb-ico { display: block; } }' +
    '@media (max-width: 640px) { .hb-memos { width: 40px; padding: 0; justify-content: center; } }';
  document.head.appendChild(css);
  var dlg = null, listEl = null, btn = null, busy = Object.create(null), errText = '', shownKey = '';
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function memos() { return oqmList(window.__oqDocs ? window.__oqDocs('work') : []); }
  function copy(text, b) {
    function done(ok) {
      b.textContent = ok ? '✓ Скопировано' : 'Не скопировалось — выделите текст выше';
      setTimeout(function () { b.textContent = 'Скопировать'; }, 2500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    var t = el('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    t.remove();
    done(ok);
  }
  function setArchived(m, on) {
    busy[m.id] = 1;
    errText = '';
    render();
    fetch(API + encodeURIComponent(m.id), {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Ops-Csrf': '1' },
      body: JSON.stringify({ data: { archived: on } }),
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('ошибка сервера ' + res.status)); });
      if (window.__oqRefresh) window.__oqRefresh('work');
    }).catch(function (e) {
      errText = 'Не сохранено: ' + (e && e.message && !/fetch|network|Load failed/i.test(e.message) ? e.message : 'нет связи с сервером') + '.';
    }).then(function () { delete busy[m.id]; render(); });
  }
  function card(m) {
    var a = el('article', 'memo');
    a.appendChild(el('h3', '', oqmReveal(m.title)));
    var by = oqmByline(m);
    if (by) a.appendChild(el('p', 'memo-by', by));
    oqmParas(m.body).forEach(function (p) { a.appendChild(el('p', '', oqmReveal(p))); });
    m.cmds.forEach(function (c) {
      var box = el('div', 'memo-cmd');
      if (c.label) box.appendChild(el('div', 'memo-cmd-label', oqmReveal(c.label)));
      var pre = el('pre'), code = el('code', '', oqmReveal(c.cmd));
      pre.appendChild(code);
      box.appendChild(pre);
      if (c.hidden) {
        // Скрытые символы в команде — не копировать: запущенная команда была бы не той, что видна.
        box.appendChild(el('p', 'memo-warn', 'В команде скрытые символы (метки ⟦U+…⟧) — не копируйте и не запускайте её; напишите агенту.'));
      } else {
        var row = el('div', 'memo-row'), b = el('button', 'memo-btn', 'Скопировать');
        b.type = 'button';
        b.addEventListener('click', function () { copy(c.cmd, b); });
        row.appendChild(b);
        box.appendChild(row);
      }
      a.appendChild(box);
    });
    var row = el('div', 'memo-row'), h = el('button', 'memo-btn quiet', m.archived ? 'Вернуть' : 'Скрыть');
    h.type = 'button';
    h.disabled = !!busy[m.id];
    h.addEventListener('click', function () { setArchived(m, !m.archived); });
    row.appendChild(h);
    a.appendChild(row);
    return a;
  }
  function render() {
    if (!dlg || !dlg.open) return;
    var all = memos();
    // Снимок work меняется и без памяток (строки плана): окно не пересобирается — не закрываются «Скрытые», не
    // сбрасывается выделение команды.
    var key = JSON.stringify([all, errText, Object.keys(busy)]);
    if (key === shownKey) return;
    shownKey = key;
    var shown = all.filter(function (m) { return !m.archived; }), hidden = all.filter(function (m) { return m.archived; });
    listEl.textContent = '';
    if (errText) listEl.appendChild(el('p', 'memo-err', errText));
    if (!shown.length) {
      listEl.appendChild(el('p', 'memo-empty', 'Памяток пока нет. Чтобы добавить, нажмите «Поставить задачу» и напишите: вынеси в памятки …'));
    } else {
      var ul = el('div', 'memo-list');
      shown.forEach(function (m) { ul.appendChild(card(m)); });
      listEl.appendChild(ul);
    }
    if (hidden.length) {
      var d = el('details', 'memo-hidden'), s = el('summary', '', 'Скрытые (' + hidden.length + ')'), ul2 = el('div', 'memo-list');
      d.appendChild(s);
      hidden.forEach(function (m) { ul2.appendChild(card(m)); });
      d.appendChild(ul2);
      listEl.appendChild(d);
    }
  }
  function close() { if (typeof dlg.close === 'function') dlg.close(); else { dlg.removeAttribute('open'); dlg.dispatchEvent(new Event('close')); } }
  function mount() {
    var bar = document.getElementById('head-bar');
    if (!bar || btn) return;
    btn = el('button', 'hb-btn hb-memos');
    btn.type = 'button';
    btn.id = 'memos-open';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-controls', 'memos-dlg');
    btn.setAttribute('aria-label', 'Памятки');
    btn.title = 'Памятки: что держать под рукой';
    btn.innerHTML = '<svg class="hb-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span class="hb-long">Памятки</span>';
    bar.insertBefore(btn, document.getElementById('theme-btn'));
    dlg = el('dialog', 'sheet');
    dlg.id = 'memos-dlg';
    dlg.setAttribute('aria-labelledby', 'memos-dlg-title');
    var head = el('div', 'sheet-head'), h = el('h2', '', 'Памятки'), x = el('button', 'sheet-close', '✕');
    h.id = 'memos-dlg-title';
    x.type = 'button';
    x.setAttribute('aria-label', 'Закрыть');
    x.addEventListener('click', close);
    head.appendChild(h);
    head.appendChild(x);
    listEl = el('div', 'sheet-body');
    dlg.appendChild(head);
    dlg.appendChild(listEl);
    // Клик по подложке приходит самому окну, но вне его прямоугольника — закрыть, как у «Отчётов».
    dlg.addEventListener('click', function (ev) {
      if (ev.target !== dlg) return;
      var r = dlg.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close();
    });
    dlg.addEventListener('close', function () { errText = ''; if (document.contains(btn)) btn.focus(); });
    document.body.appendChild(dlg);
    btn.addEventListener('click', function () {
      if (dlg.open) return;
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      shownKey = '';
      render();
    });
  }
  mount();
  if (window.claude) window.claude.use('db').then(function (db) { if (db) db.collection('work').onSnapshot(render); });
`

export const MEMOS_JS = `(function () {\n  'use strict';\n${MEMOS_PURE}\n${MEMOS_DOM}\n})();`
