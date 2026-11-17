/**
 * Команда ролей на Mac в шапке /queue (OPS-82; решение владельца d-queue-team-switch — «Доли HR/tAIBE и пауза»).
 * Кнопка «Роли: HR 6 · tAIBE 6» открывает список долей — варианты пункта долей (items/<пункт>, d-team-split) — и
 * «Пауза». Выбор — ответ владельца в checks/<пункт> (PATCH с ifAnswerAt, как ответ на странице): сторож Mac
 * (eval/tools/team_plan.py) читает его раз в 10 мин; «pause» — новые роли не открываются, доля — снова открываются.
 * Тост после выбора: что сохранено, когда Mac применит и что открыто на Mac сейчас — из work/team-mac, который сторож
 * пишет каждым проходом (kind team). Документы — прямым GET, не через подмену базы: выбор продукта их не прячет.
 * Кнопки нет, пока не виден пункт долей (консоль без него, токен без продукта пункта). Чистые функции — TEAM_PURE
 * (их исполняет tests/queue-page-team.test.ts), разметка и запросы — TEAM_DOM.
 */
export const TEAM_PURE = String.raw`
var OQT_PAUSE = 'pause', OQT_STALE_MIN = 25;
var OQT_SPLIT = /^\d{1,2}(-\d{1,2})+$/;
/** Варианты кнопки: доли из пункта (id «8-4», подпись владельца) и пауза последней. */
function oqtOptions(item) {
  var out = [];
  ((item && Array.isArray(item.options)) ? item.options : []).forEach(function (o) {
    if (o && typeof o.id === 'string' && OQT_SPLIT.test(o.id) && typeof o.label === 'string' && out.length < 8) {
      out.push({ id: o.id, label: o.label.slice(0, 60) });
    }
  });
  if (out.length) out.push({ id: OQT_PAUSE, label: 'Пауза — новые роли не открывать' });
  return out;
}
/** Доля, которую держит Mac, когда ответа нет или он — пауза: «6-6» из split сторожа. */
function oqtMacSplit(mac) {
  var s = mac && Array.isArray(mac.split) ? mac.split : [];
  var nums = s.map(function (x) { return Array.isArray(x) && typeof x[1] === 'number' ? x[1] : NaN; });
  return nums.length && nums.every(function (n) { return n >= 0 && n < 100 && Math.floor(n) === n; }) ? nums.join('-') : '';
}
/** Подпись кнопки: [длинная, короткая]. */
function oqtLabel(choice, opts, mac) {
  if (choice === OQT_PAUSE) return ['Роли: пауза', '⏸'];
  var id = typeof choice === 'string' && OQT_SPLIT.test(choice) ? choice : oqtMacSplit(mac);
  var o = opts.filter(function (x) { return x.id === id; })[0];
  if (!id) return ['Роли', 'Роли'];
  return ['Роли: ' + (o ? o.label : id), id.replace(/-/g, '·')];
}
function oqtPad(n) { return (n < 10 ? '0' : '') + n; }
/** «10:50» сегодня, «16.11 10:50» — раньше. */
function oqtTime(ms, now) {
  var d = new Date(ms), t = oqtPad(d.getHours()) + ':' + oqtPad(d.getMinutes());
  return new Date(now).toDateString() === d.toDateString() ? t : oqtPad(d.getDate()) + '.' + oqtPad(d.getMonth() + 1) + ' ' + t;
}
function oqtNum(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? String(Math.round(v)) : '?'; }
/** Строка «что на Mac сейчас» из work/team-mac. */
function oqtMacLine(mac, now) {
  var at = mac && typeof mac.at === 'string' ? Date.parse(mac.at) : NaN;
  if (!mac || isNaN(at)) return 'Состояние Mac неизвестно: сторож ещё не писал его в очередь.';
  var when = oqtTime(at, now);
  if ((now - at) / 60000 > OQT_STALE_MIN) {
    return 'Сторож Mac молчит с ' + when + ': Mac выключен или спит — выбор применится, когда он проснётся.';
  }
  var s = 'Сейчас на Mac: открыто ' + oqtNum(mac.live) + ' из ' + oqtNum(mac.want);
  if (typeof mac.mem === 'number' && isFinite(mac.mem)) s += ', памяти свободно ' + Math.round(mac.mem) + '%';
  s += ', обновлено ' + when + '.';
  if (typeof mac.hold === 'string' && mac.hold) s += ' Роли сейчас не открываются: ' + mac.hold.slice(0, 160) + '.';
  return s;
}
/** Первая строка тоста после сохранения. */
function oqtSavedText(opt, wasPause) {
  if (opt.id === OQT_PAUSE) {
    return 'Пауза сохранена: в течение 10 минут сторож Mac перестанет открывать новые роли. Работающие роли дорабатывают свою задачу.';
  }
  return 'Сохранено: ' + opt.label + '. Сторож Mac применит в течение 10 минут' + (wasPause ? ' и снимет паузу' : '') +
    '. Уменьшение доли не закрывает работающие роли.';
}
`

const TEAM_DOM = String.raw`
  var API = '/api/oq/v1/db/', DOC = 'work/team-mac', ITEM = 'd-team-split', ID_RE = /^[A-Za-z0-9_.~:@+-]{1,80}$/;
  var css = document.createElement('style');
  css.textContent = '.hb-team .hb-short { display: none; font-variant-numeric: tabular-nums; }' +
    '.team-mac { padding: 6px 10px 8px; color: var(--muted); font-size: 12px; line-height: 1.4; max-width: 320px; }' +
    '.team-opt { display: flex; width: 100%; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 0; border-radius: 6px; background: none; color: var(--ink); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }' +
    '.team-opt:hover, .team-opt:focus-visible { background: var(--accent-soft); color: var(--accent); outline-offset: -2px; }' +
    '.team-opt[aria-pressed="true"] { font-weight: 600; }' +
    '.team-opt[aria-pressed="true"]::after { content: "✓"; }' +
    '.team-opt:disabled { opacity: .5; cursor: progress; }' +
    '.oq-toast { position: fixed; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 60; width: max-content; max-width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 44px 10px 14px; border-radius: 10px; background: var(--ink); color: var(--bg); box-shadow: 0 8px 28px rgba(0, 0, 0, .25); font-size: 14px; line-height: 1.45; }' +
    '.oq-toast[hidden] { display: none; }' +
    '.oq-toast.err { background: var(--warn); color: #fff; }' +
    '.oq-toast p { margin: 0; } .oq-toast p + p { margin-top: 4px; opacity: .85; }' +
    '.oq-toast button { position: absolute; top: 4px; right: 4px; width: 36px; height: 36px; border: 0; background: none; color: inherit; font-size: 16px; cursor: pointer; }' +
    '@media (max-width: 640px) { .hb-team .hb-short { display: inline; } .hb-team { flex: none; padding: 0 8px; } }';
  document.head.appendChild(css);
  var st = { id: ITEM, item: null, check: null, mac: null }, opts = [], box = null, sum = null, list = null;
  var toastEl = null, toastTimer = 0, busy = false;
  function get(path) {
    return fetch(API + path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function () { return null; });
  }
  function load() {
    return get(DOC).then(function (m) {
      st.mac = m && m.data && m.data.kind === 'team' ? m.data : null;
      st.id = st.mac && typeof st.mac.item === 'string' && ID_RE.test(st.mac.item) ? st.mac.item : ITEM;
      return Promise.all([get('items/' + encodeURIComponent(st.id)), get('checks/' + encodeURIComponent(st.id))]);
    }).then(function (r) {
      st.item = r[0] && r[0].data ? r[0].data : null;
      st.check = r[1] && r[1].data ? r[1].data : null;
      opts = oqtOptions(st.item);
      paint();
    });
  }
  function choice() { return st.check && typeof st.check.choice === 'string' ? st.check.choice : ''; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function mount() {
    var bar = document.getElementById('head-bar');
    if (!bar || box) return;
    box = el('details', 'jump');
    box.id = 'jump-team';
    sum = el('summary', 'hb-btn hb-team');
    sum.innerHTML = '<svg class="hb-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c.6-3.4 3-5 6-5s5.4 1.6 6 5M14.5 15.2c.5-.1 1-.2 1.5-.2 3 0 5.4 1.6 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="hb-long"></span><span class="hb-short" aria-hidden="true"></span>';
    list = el('ul', 'jump-list');
    box.appendChild(sum);
    box.appendChild(list);
    box.addEventListener('toggle', function () {
      if (!box.open) return;
      document.querySelectorAll('details.jump[open]').forEach(function (d) { if (d !== box) d.open = false; });
      load();
    });
    bar.insertBefore(box, document.getElementById('reports-open'));
  }
  function paint() {
    if (!st.item || !opts.length) { if (box) { box.remove(); box = null; } return; }
    mount();
    var lab = oqtLabel(choice(), opts, st.mac), line = oqtMacLine(st.mac, Date.now());
    sum.querySelector('.hb-long').textContent = lab[0];
    sum.querySelector('.hb-short').textContent = lab[1];
    sum.setAttribute('aria-label', lab[0] + '. ' + line);
    sum.setAttribute('title', line);
    list.textContent = '';
    list.appendChild(el('li', 'team-mac', line));
    opts.forEach(function (o) {
      var li = el('li'), b = el('button', 'team-opt', o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', o.id === choice() ? 'true' : 'false');
      b.disabled = busy;
      b.addEventListener('click', function () { choose(o); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }
  function toast(lines, err) {
    if (!toastEl) {
      toastEl = el('div', 'oq-toast');
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = '';
    toastEl.className = 'oq-toast' + (err ? ' err' : '');
    toastEl.setAttribute('role', err ? 'alert' : 'status');
    lines.filter(Boolean).forEach(function (t) { toastEl.appendChild(el('p', '', t)); });
    var x = el('button', '', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Закрыть');
    x.addEventListener('click', function () { toastEl.hidden = true; });
    toastEl.appendChild(x);
    toastEl.hidden = false;
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, err ? 15000 : 10000);
  }
  function choose(o) {
    if (busy) return;
    box.open = false;
    sum.focus();
    var was = choice();
    if (o.id === was) { toast([oqtLabel(was, opts, st.mac)[0] + ' — уже выбрано.', oqtMacLine(st.mac, Date.now())]); return; }
    busy = true;
    paint();
    var base = st.check && typeof st.check.at === 'string' ? st.check.at : '';
    fetch(API + 'checks/' + encodeURIComponent(st.id), {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Ops-Csrf': '1' },
      body: JSON.stringify({ data: { done: true, choice: o.id, note: '', at: new Date().toISOString() }, ifAnswerAt: base }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) { var e = new Error(j.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
        return j;
      });
    }).then(function (doc) {
      st.check = doc && doc.data ? doc.data : { choice: o.id };
      toast([oqtSavedText(o, was === OQT_PAUSE), oqtMacLine(st.mac, Date.now())]);
      if (window.__oqRefresh) window.__oqRefresh('checks');
    }, function (e) {
      if (e.status === 409) {
        toast(['Ответ уже изменили в другой вкладке — кнопка обновлена, выберите ещё раз.'], true);
        return load();
      }
      toast(['Не сохранено: ' + e.message], true);
    }).then(function () { busy = false; paint(); });
  }
  load();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(); });
`

export const TEAM_JS = `(function () {\n  'use strict';\n${TEAM_PURE}\n${TEAM_DOM}\n})();`
