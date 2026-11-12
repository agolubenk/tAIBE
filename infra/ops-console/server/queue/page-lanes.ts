/**
 * Группировка «Хода работ» на /queue: по блокам (направлениям, как было), по проектам t-boards, по секторам t-boards или
 * по продуктам. Отдельный скрипт до кода страницы (page.ts). Страница зовёт window.__oqLanes.apply в workList: Гант,
 * роадмап и отчёт рисуют дорожки из TRACKS, поэтому выбор меняет только список дорожек и поле track у копий строк.
 *  - проект строки — проект большинства её карточек t-boards (пространство + префикс ключа: OPS-34 → OPS), при равенстве
 *    — первой карточки; имя проекта — из карты доски;
 *  - сектор строки — первый по карте доски сектор, в дерево которого входит её карточка (корень или ветка);
 *  - продукт строки — как в подмене базы (window.__oqProductOfDoc по полному снимку work), без неё — продукт большинства
 *    досок её карточек (PRODUCT_BOARDS), иначе продукт по умолчанию; продукт карточки — по её доске;
 *  - карта доски — документ work/boards-<ws> {kind: 'boards', ws, projects, sectors}. Его пишет
 *    infra/ai-council/cards_stats.py (tAIBE) клиентом t-boards; читается из полного снимка work (__oqDocs), а не из
 *    отобранного по продукту: карту tAIBE пишет токен HR.
 * Выбор — список в заголовке «Хода работ», запоминается в браузере. Секторы без карты недоступны.
 *
 * Свой разрез у графиков (просьба владельца 11.11 — «диаграммы разделить по блокам/проектам/сегментам/продуктам»):
 *  - cardsBy — карточки t-boards строк по продуктам и внутри продукта — по проектам, секторам или блокам: для
 *    «Готовности по разделам» (план и факт) и «Карточек t-boards в плане» (закрыто, на ревью, открыто); списки
 *    #pick-status и #pick-cards;
 *  - slicesOf и sliceRows — срез «Задач агентов: план и факт»: все задачи или один продукт, проект, сектор или блок
 *    (список #pick-plan, варианты — из строк).
 * Чистые функции lanesOf, cardsBy и slicesOf проверяет tests/queue-page-lanes.test.ts.
 */
import { DEFAULT_PRODUCT, PRODUCT_BOARDS } from './product-boards'

export const LANES_JS = String.raw`(function () {
  'use strict';
  var KEY = 'oq-lanes', NONE = '~', CARD = /^([A-Z][A-Z0-9]{0,15})-\d{1,7}$/;
  var DEFAULT = ${JSON.stringify(DEFAULT_PRODUCT)}, WS_PRODUCT = Object.create(null), BOARDS_OF = ${JSON.stringify(PRODUCT_BOARDS)};
  Object.keys(BOARDS_OF).forEach(function (p) { BOARDS_OF[p].forEach(function (ws) { WS_PRODUCT[ws] = p; }); });
  var COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
  // Индексы прежние (0 — блоки, 2 — секторы): сохранённый выбор и проверки не сдвигаются; продукты — новым последним.
  var MODES = [['track', 'Блоки (направления)'], ['project', 'Проекты t-boards'], ['sector', 'Секторы t-boards'], ['product', 'Продукты']];
  var SLICE_NAMES = { product: 'Продукты', project: 'Проекты t-boards', sector: 'Секторы t-boards', track: 'Блоки (направления)' };
  var PICKS = { 'pick-status': 'project', 'pick-cards': 'project' };
  var mode = 'track', onChange = null, sel = null, picks = Object.create(null), sliceSig = '';
  function stored(k, def) { try { return localStorage.getItem(k) || def; } catch (e) { return def; } }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватное окно */ } }
  mode = stored(KEY, 'track');
  if (!MODES.some(function (m) { return m[0] === mode; })) mode = 'track';

  function boardCards(w) {
    return (Array.isArray(w.cards) ? w.cards : []).filter(function (c) { return c && typeof c.ws === 'string' && CARD.test(c.key || ''); });
  }
  function projectName(boards, ws, slug) {
    var b = boards[ws], list = b && Array.isArray(b.projects) ? b.projects : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].slug === slug && list[i].name) return slug + ' · ' + list[i].name;
    return slug;
  }
  function hasSectors(boards) {
    return Object.keys(boards).some(function (ws) { return Array.isArray(boards[ws].sectors) && boards[ws].sectors.length > 0; });
  }
  // Ключ карточки (ws/ключ) → первый по карте доски сектор, в дерево которого она входит.
  function sectorsOf(boards) {
    var at = Object.create(null);
    Object.keys(boards).forEach(function (ws) {
      (boards[ws].sectors || []).forEach(function (s, i) {
        if (!s || typeof s.id !== 'string') return;
        (Array.isArray(s.keys) ? s.keys : []).forEach(function (k) {
          var id = ws + '/' + k;
          if (!at[id]) at[id] = { id: ws + '#' + s.id, name: String(s.name || s.id), order: i };
        });
      });
    });
    return at;
  }
  function productName(slug) { return (window.__oqProductName && window.__oqProductName(slug)) || slug; }
  // Продукт строки: подмена базы по полному снимку (ctx.products), иначе большинство досок карточек, иначе по умолчанию.
  function rowProduct(w, products) {
    if (products && products[w.id]) return products[w.id];
    var n = Object.create(null), best = '';
    boardCards(w).forEach(function (c) {
      var p = WS_PRODUCT[c.ws];
      if (!p) return;
      n[p] = (n[p] || 0) + 1;
      if (!best || n[p] > n[best]) best = p;
    });
    return best || DEFAULT;
  }
  function cardProduct(c, home) {
    if (window.__oqProductOfDoc) return window.__oqProductOfDoc('work', { product: home, data: { ws: c.ws } }) || home;
    return WS_PRODUCT[c.ws] || home;
  }
  function trackOf(w) { return w.trackOf || w.track; }

  /**
   * Дорожка строки для how: функция строка → {id, name}; null — секторы без карты или неизвестный how. ctx:
   * {products: {id строки → slug}, trackName(id)} — для продуктов и блоков.
   */
  function laneFn(how, boards, ctx) {
    ctx = ctx || {};
    if (how === 'track') return function (w) { var id = trackOf(w); return { id: id, name: ctx.trackName ? ctx.trackName(id) : id }; };
    if (how === 'product') return function (w) { var p = rowProduct(w, ctx.products); return { id: p, name: productName(p) }; };
    if (how === 'project') {
      return function (w) {
        var n = Object.create(null), best = null;
        boardCards(w).forEach(function (c) {
          var slug = CARD.exec(c.key)[1], id = c.ws + '/' + slug;
          n[id] = (n[id] || 0) + 1;
          if (!best || n[id] > n[best.id]) best = { id: id, ws: c.ws, slug: slug };
        });
        return best ? { id: best.id, name: projectName(boards, best.ws, best.slug) } : { id: NONE, name: 'Без карточек t-boards' };
      };
    }
    if (how !== 'sector' || !hasSectors(boards)) return null;
    var sectorOf = sectorsOf(boards);
    return function (w) {
      var best = null;
      boardCards(w).forEach(function (c) { var s = sectorOf[c.ws + '/' + c.key]; if (s && (!best || s.order < best.order)) best = s; });
      return best ? { id: best.id, name: best.name } : { id: NONE, name: 'Вне секторов' };
    };
  }

  /**
   * Дорожки и строки для группировки how ('project' | 'sector' | 'product'); null — по блокам (страница как была).
   * boards: { <ws>: { projects: [{slug, name}], sectors: [{id, name, keys}] } }. Строки — копии с track = id дорожки и
   * trackOf = прежнее направление; порядок — по дорожкам (первое появление), внутри — прежний.
   */
  function lanesOf(rows, how, boards, ctx) {
    var laneOf = how === 'track' ? null : laneFn(how, boards, ctx);
    if (!laneOf) return null;
    var lanes = [], at = Object.create(null), none = null;
    var out = rows.map(function (w) {
      var l = laneOf(w);
      if (l.id === NONE) none = none || { id: NONE, name: l.name, c: 'var(--st-none)' };
      else if (!at[l.id]) { at[l.id] = 1; lanes.push({ id: l.id, name: l.name, c: COLORS[lanes.length % COLORS.length] }); }
      return Object.assign({}, w, { track: l.id, trackOf: trackOf(w) });
    });
    if (none) lanes.push(none);
    var idx = Object.create(null);
    lanes.forEach(function (l, i) { idx[l.id] = i; });
    out = out.map(function (w, i) { return { w: w, i: i }; })
      .sort(function (a, b) { return idx[a.w.track] - idx[b.w.track] || a.i - b.i; })
      .map(function (x) { return x.w; });
    return { tracks: lanes, rows: out };
  }

  function tally() { return { c: { closed: 0, review: 0, open: 0 }, total: 0, due: 0 }; }
  function bump(t, x) {
    t.total++;
    t.c[x.closed ? 'closed' : x.review ? 'review' : 'open']++;
    if (x.due) t.due++;
  }
  function byTotal(a, b) { return (a.id === NONE) - (b.id === NONE) || b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
  /**
   * Карточки t-boards строк по продуктам, внутри продукта — по how: 'project' (пространство и префикс ключа карточки),
   * 'sector' (карта доски), 'track' (блок строки), 'product' — без второго уровня. Карточка — одна на ws/ключ, даже у
   * нескольких строк; карточки прежнего трекера (archived, без ключа доски) — не в счёт. due — карточка строки с исходным
   * плановым сроком (basePlanEnd, иначе planEnd — как planEndOf страницы) не позже ctx.today ('YYYY-MM-DD'): по плану к сегодня она закрыта. Ответ: продукты [{id, name, c, total, due,
   * groups: [{id, name, c, total, due}]}] по убыванию total, «без группы» — последней; c = {closed, review, open}.
   */
  function cardsBy(rows, how, boards, ctx) {
    ctx = ctx || {};
    var seen = Object.create(null), list = [], sectorOf = how === 'sector' ? sectorsOf(boards) : null;
    rows.forEach(function (w) {
      var home = rowProduct(w, ctx.products), pe = w.basePlanEnd || w.planEnd;
      var due = typeof pe === 'string' && !!ctx.today && pe.slice(0, 10) <= ctx.today;
      boardCards(w).forEach(function (c) {
        if (c.archived) return;
        var uid = c.ws + '/' + c.key, x = seen[uid];
        if (x) { x.due = x.due || due; return; }
        var g = null;
        if (how === 'project') { var slug = CARD.exec(c.key)[1]; g = { id: c.ws + '/' + slug, name: projectName(boards, c.ws, slug) }; }
        else if (how === 'sector') { var s = sectorOf[uid]; g = s ? { id: s.id, name: s.name } : { id: NONE, name: 'Вне секторов' }; }
        else if (how === 'track') { var tr = trackOf(w); g = { id: tr, name: ctx.trackName ? ctx.trackName(tr) : tr }; }
        x = seen[uid] = { p: cardProduct(c, home), g: g, due: due, closed: !!c.closed, review: !!c.review };
        list.push(x);
      });
    });
    var prods = Object.create(null), out = [];
    list.forEach(function (x) {
      var p = prods[x.p];
      if (!p) { p = prods[x.p] = Object.assign(tally(), { id: x.p, name: productName(x.p), groups: [], at: Object.create(null) }); out.push(p); }
      bump(p, x);
      if (!x.g) return;
      var g = p.at[x.g.id];
      if (!g) { g = p.at[x.g.id] = Object.assign(tally(), { id: x.g.id, name: x.g.name }); p.groups.push(g); }
      bump(g, x);
    });
    out.forEach(function (p) { delete p.at; p.groups.sort(byTotal); });
    return out.sort(byTotal);
  }

  /** Варианты среза строк: [{how, name, items: [{id, name, n}]}] — продукты, проекты, секторы (с картой), блоки. */
  function slicesOf(rows, boards, ctx) {
    return ['product', 'project', 'sector', 'track'].map(function (how) {
      var f = laneFn(how, boards, ctx), items = [], at = Object.create(null);
      if (!f) return null;
      rows.forEach(function (w) {
        var l = f(w);
        if (!at[l.id]) { at[l.id] = { id: l.id, name: l.name, n: 0 }; items.push(at[l.id]); }
        at[l.id].n++;
      });
      return { how: how, name: SLICE_NAMES[how], items: items.sort(byN) };
    }).filter(Boolean);
  }
  function byN(a, b) { return (a.id === NONE) - (b.id === NONE) || b.n - a.n; }

  /** Карты досок из полного снимка work: последняя по времени на пространство. */
  function boardsNow() {
    var docs = window.__oqDocs ? window.__oqDocs('work') : [], out = Object.create(null);
    docs.forEach(function (d) {
      var x = d && d.data;
      if (!x || x.kind !== 'boards' || typeof x.ws !== 'string') return;
      if (!out[x.ws] || String(x.at || '') > String(out[x.ws].at || '')) out[x.ws] = x;
    });
    return out;
  }
  /** Продукт каждой строки по полному снимку work — как в подмене базы (задачи tAIBE пишет токен HR). */
  function productsNow() {
    var docs = window.__oqDocs ? window.__oqDocs('work') : [], f = window.__oqProductOfDoc, out = Object.create(null);
    if (f) docs.forEach(function (d) { if (d && d.id && d.data && !d.data.kind) out[d.id] = f('work', d); });
    return out;
  }
  function paintSelect(boards) {
    if (!sel) return;
    var noMap = !hasSectors(boards);
    sel.options[2].disabled = noMap;
    sel.options[2].textContent = MODES[2][1] + (noMap ? ' — карты ещё нет' : '');
    sel.value = mode === 'sector' && noMap ? 'track' : mode;
  }
  // Списки разреза у карточек графиков: секторы без карты недоступны, сохранённый выбор секторов — проекты.
  function paintPicks(boards) {
    var noMap = !hasSectors(boards);
    Object.keys(picks).forEach(function (id) {
      var p = picks[id];
      Array.prototype.forEach.call(p.el.options, function (o) {
        if (o.value !== 'sector') return;
        o.disabled = noMap;
        o.textContent = 'по секторам t-boards' + (noMap ? ' — карты ещё нет' : '');
      });
      p.el.value = p.v === 'sector' && noMap ? PICKS[id] : p.v;
    });
  }
  function pickValue(id) {
    var p = picks[id], b = boardsNow();
    if (!p) return PICKS[id] || 'project';
    paintPicks(b);
    return p.v === 'sector' && !hasSectors(b) ? PICKS[id] : p.v;
  }
  function bindPick(id) {
    var el = document.querySelector('#' + id);
    if (!el) return;
    var v = stored('oq-' + id, PICKS[id]), ok = Array.prototype.some.call(el.options, function (o) { return o.value === v; });
    picks[id] = { el: el, v: ok ? v : PICKS[id] };
    el.addEventListener('change', function () {
      picks[id].v = el.value;
      store('oq-' + id, el.value);
      if (onChange) onChange();
    });
  }
  // Срез «Задач агентов: план и факт»: список перестраивается, только когда сменились варианты (фокус не теряется).
  var plan = { el: null, v: '' };
  function paintSlices(slices) {
    var el = plan.el;
    if (!el) return;
    var sig = JSON.stringify(slices.map(function (s) { return [s.how, s.items.map(function (x) { return [x.id, x.name, x.n]; })]; }));
    if (sig !== sliceSig) {
      sliceSig = sig;
      el.textContent = '';
      var all = document.createElement('option');
      all.value = '';
      all.textContent = 'Все задачи';
      el.appendChild(all);
      slices.forEach(function (s) {
        var g = document.createElement('optgroup');
        g.label = s.name;
        s.items.forEach(function (x) {
          var o = document.createElement('option');
          o.value = s.how + ':' + x.id;
          o.textContent = x.name + ' — ' + x.n;
          g.appendChild(o);
        });
        el.appendChild(g);
      });
    }
    var known = slices.some(function (s) { return s.items.some(function (x) { return s.how + ':' + x.id === plan.v; }); });
    el.value = known ? plan.v : '';
  }
  function mount() {
    var head = document.querySelector('#agents .sec-head');
    if (!head || head.querySelector('.oq-lanes')) return;
    var css = document.createElement('style');
    css.textContent = '.oq-lanes { font: inherit; font-size: 12px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; max-width: 60vw; }' +
      '@media (pointer: coarse) { .oq-lanes { font-size: 16px; min-height: 36px; } }';
    document.head.appendChild(css);
    sel = document.createElement('select');
    sel.className = 'oq-lanes';
    sel.setAttribute('aria-label', 'Группировать «Ход работ»');
    MODES.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m[0];
      o.textContent = m[1];
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      mode = sel.value;
      store(KEY, mode);
      if (onChange) onChange();
    });
    var h = head.querySelector('h2');
    head.insertBefore(sel, h ? h.nextSibling : head.firstChild);
    paintSelect(boardsNow());
    Object.keys(PICKS).forEach(bindPick);
    plan.el = document.querySelector('#pick-plan');
    if (plan.el) {
      plan.v = stored('oq-pick-plan', '');
      plan.el.addEventListener('change', function () {
        plan.v = plan.el.value;
        store('oq-pick-plan', plan.v);
        if (onChange) onChange();
      });
    }
  }
  function ctxNow(trackName) { return { products: productsNow(), trackName: trackName }; }

  window.__oqLanes = {
    lanesOf: lanesOf,
    cardsBy: cardsBy,
    slicesOf: slicesOf,
    mode: function () { return mode; },
    onChange: function (cb) { onChange = cb; },
    /** Перерисовать с новыми данными группировки: имена продуктов пришли (page-products.ts). */
    refresh: function () { if (onChange) onChange(); },
    /** Строки workList → {tracks, rows} по выбранной группировке; null — блоки (направления). */
    apply: function (rows) {
      var b = boardsNow();
      paintSelect(b);
      return lanesOf(rows, mode, b, ctxNow(null));
    },
    /** Карточки строк для графика id ('pick-status' | 'pick-cards') по его разрезу; today — 'YYYY-MM-DD'. */
    cards: function (id, rows, today, trackName) {
      var how = pickValue(id), ctx = ctxNow(trackName);
      ctx.today = today;
      return { how: how, products: cardsBy(rows, how, boardsNow(), ctx) };
    },
    /** Строки среза «план и факт» и его название ('' — все задачи); список #pick-plan — по вариантам строк. */
    sliceRows: function (rows, trackName) {
      var b = boardsNow(), ctx = ctxNow(trackName), slices = slicesOf(rows, b, ctx);
      paintSlices(slices);
      var v = plan.el ? plan.el.value : '', at = v.indexOf(':'), how = v.slice(0, at), id = v.slice(at + 1), f = at > 0 ? laneFn(how, b, ctx) : null;
      if (!f) return { rows: rows, name: '' };
      var name = '';
      slices.forEach(function (s) { if (s.how === how) s.items.forEach(function (x) { if (x.id === id) name = x.name; }); });
      return { rows: rows.filter(function (w) { return f(w).id === id; }), name: name };
    },
  };
  try { mount(); } catch (e) { /* без списков — блоки и разрез по умолчанию, как было */ }
})();`
