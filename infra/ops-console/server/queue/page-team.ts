/**
 * Команда ролей на Mac в шапке /queue (OPS-82; решение владельца d-queue-team-switch — «Доли HR/tAIBE и пауза»).
 * Кнопка «Роли» — сразу за «Очередь» — открывает список долей (варианты пункта долей items/<пункт>, d-team-split; доли
 * больше числа ролей продукта не показаны) и «Пауза». Выбор — ответ владельца в checks/<пункт> (PATCH с ifAnswerAt, как
 * ответ на странице): сторож Mac (eval/tools/team_plan.py) читает его раз в 10 мин; «pause» — новые роли не открываются,
 * доля — снова открываются. Тост после выбора: что сохранено, когда Mac применит, что открыто на Mac сейчас, и
 * «Отменить» — прежний ответ. Состояние Mac — GET /api/oq/v1/team (queue/team.ts, отметка сторожа раз в 10 мин): при
 * загрузке, возврате на вкладку, открытии меню и после выбора; сбой запроса оставляет прежнее состояние.
 * Пункт и ответ — из снимков подмены базы (window.__oqDocs: полные, без отбора по продукту) — без своих запросов:
 * страница и так опрашивает items и checks. Кнопки нет, пока не виден пункт долей. На телефоне — значок с точкой: точка
 * цвета предупреждения, когда пауза, Mac не на связи или роли не открываются.
 * Чистые функции — TEAM_PURE (их исполняет tests/queue-page-team.test.ts), разметка и запросы — TEAM_DOM.
 */
export const TEAM_PURE = String.raw`
var OQT_PAUSE = 'pause', OQT_STALE_MIN = 25;
var OQT_SPLIT = /^\d{1,2}(-\d{1,2})+$/;
function oqtPlural(n, one, few, many) { var a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }
function oqtPairs(v) {
  return Array.isArray(v) ? v.filter(function (x) { return Array.isArray(x) && typeof x[1] === 'number' && isFinite(x[1]); }) : [];
}
/** Варианты кнопки: доли из пункта (id «8-4», подпись пункта), которые Mac может держать, и пауза последней. */
function oqtOptions(item, mac) {
  var max = oqtPairs(mac && mac.max).map(function (x) { return x[1]; }), out = [];
  ((item && Array.isArray(item.options)) ? item.options : []).forEach(function (o) {
    if (!o || typeof o.id !== 'string' || !OQT_SPLIT.test(o.id) || typeof o.label !== 'string' || out.length >= 8) return;
    var nums = o.id.split('-').map(Number);
    // 10-2 при 8 ролях у HR — на деле 8-4: такой вариант ничего не меняет и подписан неправдой.
    if (max.length === nums.length && nums.some(function (n, i) { return n > max[i]; })) return;
    out.push({ id: o.id, label: o.label.slice(0, 60) });
  });
  if (out.length) out.push({ id: OQT_PAUSE, label: 'Пауза — новые роли не открывать' });
  return out;
}
/** Доля, которую просит ответ: доля из заметки важнее варианта, если сторож её примет (столько чисел, сколько
 *  продуктов, сумма — всего ролей, как parse_split в team_plan.py); иначе выбор. «с 18-11» в заметке — не доля. */
function oqtWanted(check, mac) {
  var c = check || {}, m = /\b(\d{1,2}(?:-\d{1,2})+)\b/.exec(typeof c.note === 'string' ? c.note : '');
  if (c.choice === OQT_PAUSE) return OQT_PAUSE;
  var total = mac && typeof mac.total === 'number' ? mac.total : 12, n = mac && Array.isArray(mac.split) && mac.split.length ? mac.split.length : 2;
  var nums = m ? m[1].split('-').map(Number) : [];
  var noted = nums.length === n && nums.reduce(function (a, b) { return a + b; }, 0) === total;
  return noted ? m[1] : typeof c.choice === 'string' && OQT_SPLIT.test(c.choice) ? c.choice : '';
}
function oqtSplitText(id, opts) {
  var o = opts.filter(function (x) { return x.id === id; })[0];
  return o ? o.label : id;
}
function oqtFresh(mac, now) {
  var at = mac && typeof mac.at === 'string' ? Date.parse(mac.at) : NaN;
  return !isNaN(at) && (now - at) / 60000 <= OQT_STALE_MIN;
}
/** Состояние кнопки: подпись, пауза ли; warn — пауза или роли не открываются (точка цвета предупреждения), quiet — Mac
 *  не на связи (серая точка: утром после сна и при «Разработка ВЫКЛ» это обычное дело, не тревога). */
function oqtState(check, opts, mac, now) {
  var want = oqtWanted(check, mac), fresh = oqtFresh(mac, now);
  var macPause = fresh && mac.pause === 'mac', pause = want === OQT_PAUSE || macPause;
  var label = pause ? 'Роли: пауза' : want ? 'Роли: ' + oqtSplitText(want, opts) : 'Роли';
  var hold = fresh && (typeof mac.hold === 'string' && mac.hold !== '' || mac.seen === false);
  return { label: label, pause: pause, warn: pause || hold, quiet: !pause && !hold && !fresh };
}
function oqtPad(n) { return (n < 10 ? '0' : '') + n; }
/** «10:50» сегодня, «16.11 10:50» — раньше. */
function oqtTime(ms, now) {
  var d = new Date(ms), t = oqtPad(d.getHours()) + ':' + oqtPad(d.getMinutes());
  return new Date(now).toDateString() === d.toDateString() ? t : oqtPad(d.getDate()) + '.' + oqtPad(d.getMonth() + 1) + ' ' + t;
}
function oqtCount(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : null; }
/** Строка «что на Mac сейчас» из work/team-mac. */
function oqtMacLine(mac, now) {
  var at = mac && typeof mac.at === 'string' ? Date.parse(mac.at) : NaN;
  if (!mac || isNaN(at)) return 'Mac ещё не присылал состояние.';
  var when = oqtTime(at, now);
  if (!oqtFresh(mac, now)) return 'Mac не на связи с ' + when + ' (выключен, спит или разработка выключена). Выбор применится, когда он включится.';
  var live = oqtCount(mac.live), want = oqtCount(mac.want), extra = oqtCount(mac.extra);
  var s = 'На Mac в ' + when + ': ' + (live === null || want === null ? 'сколько ролей открыто — неизвестно'
    : 'открыто ' + live + ' из ' + want + ' ' + oqtPlural(want, 'роли', 'ролей', 'ролей'));
  if (typeof mac.mem === 'number' && isFinite(mac.mem)) s += ', свободно памяти ' + Math.round(mac.mem) + '%';
  s += '.';
  if (extra) s += ' Ещё ' + extra + ' ' + oqtPlural(extra, 'роль', 'роли', 'ролей') + ' сверх доли ' + (extra === 1 ? 'работает' : 'работают') + ' до конца своей сессии.';
  if (mac.seen === false) s += ' Mac не видит пункт долей — выбор здесь до него не дойдёт; напишите агенту.';
  if (typeof mac.hold === 'string' && mac.hold) s += ' Новые роли не открываются: ' + mac.hold.slice(0, 160) + '.';
  return s;
}
/** Мест для новых ролей: всего ролей минус открытые (и сверх доли тоже — они считаются в потолок). */
function oqtFree(mac) {
  var cap = oqtCount(mac && mac.cap), live = oqtCount(mac && mac.live), extra = oqtCount(mac && mac.extra) || 0;
  return cap === null || live === null ? null : Math.max(0, cap - live - extra);
}
/** Первая строка тоста после сохранения; Mac не на связи или стоит — без обещания срока (вторая строка скажет почему). */
function oqtSavedText(opt, wasPause, mac, now) {
  var ok = oqtFresh(mac, now) && mac.seen !== false && !(typeof mac.hold === 'string' && mac.hold && mac.pause !== 'queue');
  if (opt.id === OQT_PAUSE) {
    return 'Пауза сохранена.' + (ok ? ' Через 10 минут Mac перестанет открывать новые роли.' : '') + ' Открытые роли продолжают работать.';
  }
  var head = 'Сохранено: ' + opt.label + '.';
  if (!ok) return head + ' Открытые роли не закрываются.';
  // Все места заняты: роль сверх доли доделывает сессию и наследника не открывает (spawn_session.sh --handoff,
  // team_plan.py keep), её место сторож отдаёт новой доле, а сессию через 30 мин простоя снимает автоуборка
  // (решение d-team-surplus-1711).
  if (oqtFree(mac) === 0) {
    return head + (wasPause ? ' Пауза снята.' : '') + ' Все ' + (oqtCount(mac.cap) || 12) + ' мест заняты. Лишние роли доделают свою сессию и не продлятся — новая доля наступит за несколько часов. Сразу — «Разработка ВЫКЛ → ВКЛ», но это прервёт работу всех ролей.';
  }
  return head + ' Mac начнёт применять в течение 10 минут' + (wasPause ? ' и снимет паузу' : '') + '. Открытые роли не закрываются.';
}
`

const TEAM_DOM = String.raw`
  // Пункт долей — постоянный: отметку /team пишет любой токен агента, она не выбирает, в какой ответ писать.
  var API = '/api/oq/v1/db/', TEAM = '/api/oq/v1/team', ITEM = 'd-team-split';
  // Пункт удалён или перенесён, а ответ остался (в нём может стоять пауза) — кнопка с долями без подписей пункта.
  var FALLBACK = { options: [{ id: '6-6', label: '6-6' }, { id: '8-4', label: '8-4' }, { id: '4-8', label: '4-8' }] };
  var css = document.createElement('style');
  css.textContent = '.hb-team { position: relative; }' +
    '.hb-team .hb-dot { display: none; position: absolute; top: 5px; right: 5px; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 2px var(--bg); }' +
    '.hb-team.warn .hb-dot, .hb-team.quiet .hb-dot { display: block; }' +
    '.hb-team.quiet .hb-dot { background: var(--muted); }' +
    '.hb-team.warn .hb-long { color: var(--warn); }' +
    '.team-mac { padding: 6px 10px 10px; margin-bottom: 4px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 13px; line-height: 1.45; max-width: 340px; }' +
    '.team-opt { display: flex; width: 100%; min-height: 40px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 0; border-radius: 6px; background: none; color: var(--ink); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }' +
    '.team-opt:hover, .team-opt:focus-visible { background: var(--accent-soft); color: var(--accent); outline-offset: -2px; }' +
    '.team-opt[aria-pressed="true"] { font-weight: 600; }' +
    '.team-opt[aria-pressed="true"]::after { content: "✓"; }' +
    '.team-opt:disabled { opacity: .5; cursor: progress; }' +
    '.oq-toast { position: fixed; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 60; width: max-content; max-width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 10px 44px 10px 14px; border-radius: 10px; background: var(--ink); color: var(--bg); box-shadow: 0 8px 28px rgba(0, 0, 0, .25); font-size: 14px; line-height: 1.45; }' +
    '.oq-toast[hidden] { display: none; }' +
    '.oq-toast.err { background: var(--warn); color: #fff; }' +
    '.oq-toast p { margin: 0; } .oq-toast p + p { margin-top: 4px; opacity: .85; }' +
    '.oq-toast .oq-toast-x { position: absolute; top: 4px; right: 4px; width: 36px; height: 36px; border: 0; background: none; color: inherit; font-size: 16px; cursor: pointer; }' +
    '.oq-toast .oq-toast-undo { margin-top: 8px; min-height: 36px; padding: 0 12px; border: 1px solid currentColor; border-radius: 8px; background: none; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }' +
    '@media (max-width: 1399.98px) { .hb-team .hb-long { display: none; } .hb-team .hb-ico { display: block; } .hb-team { flex: none; width: 40px; padding: 0; justify-content: center; } .hb-team::after { display: none; } }';
  document.head.appendChild(css);
  var st = { id: ITEM, item: null, check: null, mac: null }, opts = [], box = null, sum = null, list = null;
  var toastEl = null, toastTimer = 0, busy = false, macSeq = 0, painted = '', macAt = 0;
  function find(col, id) {
    var docs = window.__oqDocs ? window.__oqDocs(col) : [];
    for (var i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i];
    return null;
  }
  /** Состояние Mac; ответ старше последнего запроса и сбой не трогают прежнее. */
  function loadMac() {
    var seq = ++macSeq;
    macAt = Date.now();
    return fetch(TEAM, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { if (seq === macSeq && m && typeof m === 'object') { st.mac = m.at ? m : null; schedule(); } }, function () {});
  }
  function read() {
    var it = find('items', st.id), ch = find('checks', st.id);
    st.item = it && it.data ? it.data : null;
    // Свой только что сохранённый ответ новее снимка, снятого до записи: снимок его не откатывает.
    if (!busy && !(st.check && st.check.mine && ch && ch.data && ch.data.at !== st.check.at && Date.parse(ch.data.at) < Date.parse(st.check.at))) {
      st.check = ch && ch.data ? ch.data : null;
    }
    opts = oqtOptions(st.item || (st.check ? FALLBACK : null), st.mac);
    paint();
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; read(); });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function mount() {
    var jq = document.getElementById('jump-queue');
    if (!jq || box) return;
    painted = '';
    box = el('details', 'jump');
    box.id = 'jump-team';
    sum = el('summary', 'hb-btn hb-team');
    sum.innerHTML = '<svg class="hb-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c.6-3.4 3-5 6-5s5.4 1.6 6 5M14.5 15.2c.5-.1 1-.2 1.5-.2 3 0 5.4 1.6 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="hb-long"></span><i class="hb-dot" aria-hidden="true"></i>';
    list = el('ul', 'jump-list');
    box.appendChild(sum);
    box.appendChild(list);
    box.addEventListener('toggle', function () {
      if (!box.open) return;
      document.querySelectorAll('details.jump[open]').forEach(function (d) { if (d !== box) d.open = false; });
      loadMac();
    });
    jq.parentNode.insertBefore(box, jq.nextSibling);
  }
  function paint() {
    if (!opts.length) { if (box) { box.remove(); box = null; painted = ''; } return; }
    mount();
    if (!document.hidden && Date.now() - macAt > 5 * 60000) loadMac();
    var now = Date.now(), s = oqtState(st.check, opts, st.mac, now), line = oqtMacLine(st.mac, now), want = oqtWanted(st.check, st.mac);
    // Снимки items и checks приходят часто (статусы агентов) — меню не пересобирается под пальцем без нужды.
    var key = JSON.stringify([s, line, want, busy, opts]);
    if (key === painted) return;
    painted = key;
    sum.querySelector('.hb-long').textContent = s.label;
    sum.classList.toggle('warn', s.warn);
    sum.classList.toggle('quiet', s.quiet);
    sum.setAttribute('aria-label', s.label + '. ' + line);
    sum.setAttribute('title', line);
    list.textContent = '';
    list.appendChild(el('li', 'team-mac', line));
    opts.forEach(function (o) {
      var li = el('li'), b = el('button', 'team-opt', o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', o.id === want ? 'true' : 'false');
      b.disabled = busy;
      b.addEventListener('click', function () { choose(o); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }
  function toast(lines, err, undo) {
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
    if (undo) {
      var u = el('button', 'oq-toast-undo', 'Отменить');
      u.type = 'button';
      u.addEventListener('click', function () { toastEl.hidden = true; undo(); });
      toastEl.appendChild(u);
    }
    var x = el('button', 'oq-toast-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Закрыть');
    x.addEventListener('click', function () { toastEl.hidden = true; });
    toastEl.appendChild(x);
    toastEl.hidden = false;
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, err ? 15000 : undo ? 12000 : 8000);
  }
  function save(answer) {
    var base = st.check && typeof st.check.at === 'string' ? st.check.at : '';
    return fetch(API + 'checks/' + encodeURIComponent(st.id), {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Ops-Csrf': '1' },
      body: JSON.stringify({ data: answer, ifAnswerAt: base }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) { var e = new Error(j.error || ''); e.status = res.status; throw e; }
        return j;
      });
    });
  }
  function fail(e) {
    if (e.status === 409) {
      if (st.check) st.check.mine = false;
      busy = false;
      read();
      if (window.__oqRefresh) window.__oqRefresh('checks'); // новый ответ — сразу, не через 4 с опроса
      return toast(['Ответ уже изменили (другое окно или бот). Выберите ещё раз.'], true);
    }
    toast([e.status ? 'Не сохранено: ' + (e.message || 'ошибка сервера ' + e.status) + '.' : 'Не сохранено: нет связи с сервером. Попробуйте ещё раз.'], true);
  }
  /** Выбор доли или паузы; prev — ответ до выбора (для «Отменить»), undo — это возврат прежнего ответа. */
  function choose(o, prev, undo) {
    if (busy) return;
    if (box) box.open = false;
    if (sum) sum.focus();
    var was = oqtWanted(st.check, st.mac);
    if (!undo && o.id === was) { toast([st.check && st.check.choice === OQT_PAUSE ? 'Пауза уже включена.' : 'Эта доля уже выбрана.', oqtMacLine(st.mac, Date.now())]); return; }
    var before = st.check ? { choice: st.check.choice, note: st.check.note } : null;
    var answer = undo ? { done: true, choice: prev.choice, note: typeof prev.note === 'string' ? prev.note : '', at: new Date().toISOString() }
      : { done: true, choice: o.id, note: '', at: new Date().toISOString() };
    busy = true;
    paint();
    save(answer).then(function (doc) {
      st.check = doc && doc.data ? doc.data : answer;
      st.check.mine = true;
      if (window.__oqRefresh) window.__oqRefresh('checks');
      // Тост — по свежему состоянию Mac: на 3G меню могло открыться раньше, чем пришло состояние.
      return loadMac().then(function () {
        if (undo) toast(['Отменено: снова ' + oqtState(st.check, opts, st.mac, Date.now()).label.replace(/^Роли: /, '') + '.']);
        else toast([oqtSavedText(o, was === OQT_PAUSE, st.mac, Date.now()), oqtMacLine(st.mac, Date.now())], false,
          before && typeof before.choice === 'string' ? function () { choose(o, before, true); } : null);
      });
    }, fail).then(function () { busy = false; paint(); });
  }
  if (window.claude) window.claude.use('db').then(function (db) {
    if (!db) return;
    ['items', 'checks'].forEach(function (col) { db.collection(col).onSnapshot(schedule); });
  });
  loadMac();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadMac(); });
`

export const TEAM_JS = `(function () {\n  'use strict';\n${TEAM_PURE}\n${TEAM_DOM}\n})();`
