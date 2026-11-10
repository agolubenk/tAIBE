/**
 * Группировка «Хода работ» на /queue: по направлениям (как было), по проектам t-boards или по секторам t-boards. Отдельный
 * скрипт до кода страницы (page.ts). Страница зовёт window.__oqLanes.apply в workList: графики, Гант и роадмап рисуют
 * дорожки из TRACKS, поэтому выбор меняет только список дорожек и поле track у копий строк.
 *  - проект строки — проект большинства её карточек t-boards (пространство + префикс ключа: OPS-34 → OPS), при равенстве
 *    — первой карточки; имя проекта — из карты доски;
 *  - сектор строки — первый по карте доски сектор, в дерево которого входит её карточка (корень или ветка);
 *  - карта доски — документ work/boards-<ws> {kind: 'boards', ws, projects, sectors}. Его пишет
 *    infra/ai-council/cards_stats.py (tAIBE) клиентом t-boards; читается из полного снимка work (__oqDocs), а не из
 *    отобранного по продукту: карту tAIBE пишет токен HR.
 * Выбор — список в заголовке «Хода работ», запоминается в браузере. Секторы без карты недоступны.
 * Чистую функцию lanesOf проверяет tests/queue-page-lanes.test.ts.
 */
export const LANES_JS = String.raw`(function () {
  'use strict';
  var KEY = 'oq-lanes', NONE = '~', CARD = /^([A-Z][A-Z0-9]{0,15})-\d{1,7}$/;
  var COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
  var MODES = [['track', 'Направления'], ['project', 'Проекты t-boards'], ['sector', 'Секторы t-boards']];
  var mode = 'track', onChange = null, sel = null;
  try { mode = localStorage.getItem(KEY) || 'track'; } catch (e) { mode = 'track'; }
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
  /**
   * Дорожки и строки для группировки how ('project' | 'sector'); null — по направлениям (страница как была).
   * boards: { <ws>: { projects: [{slug, name}], sectors: [{id, name, keys}] } }. Строки — копии с track = id дорожки и
   * trackOf = прежнее направление; порядок — по дорожкам (первое появление), внутри — прежний.
   */
  function lanesOf(rows, how, boards) {
    if (how !== 'project' && how !== 'sector') return null;
    if (how === 'sector' && !hasSectors(boards)) return null;
    var sectorOf = Object.create(null);
    if (how === 'sector') {
      Object.keys(boards).forEach(function (ws) {
        (boards[ws].sectors || []).forEach(function (s, i) {
          if (!s || typeof s.id !== 'string') return;
          (Array.isArray(s.keys) ? s.keys : []).forEach(function (k) {
            var id = ws + '/' + k;
            if (!sectorOf[id]) sectorOf[id] = { id: ws + '#' + s.id, name: String(s.name || s.id), order: i };
          });
        });
      });
    }
    function laneOf(w) {
      var cs = boardCards(w), best = null;
      if (how === 'project') {
        var n = Object.create(null);
        cs.forEach(function (c) {
          var slug = CARD.exec(c.key)[1], id = c.ws + '/' + slug;
          n[id] = (n[id] || 0) + 1;
          if (!best || n[id] > n[best.id]) best = { id: id, ws: c.ws, slug: slug };
        });
        return best ? { id: best.id, name: projectName(boards, best.ws, best.slug) } : { id: NONE, name: 'Без карточек t-boards' };
      }
      cs.forEach(function (c) { var s = sectorOf[c.ws + '/' + c.key]; if (s && (!best || s.order < best.order)) best = s; });
      return best ? { id: best.id, name: best.name } : { id: NONE, name: 'Вне секторов' };
    }
    var lanes = [], at = Object.create(null), none = null;
    var out = rows.map(function (w) {
      var l = laneOf(w);
      if (l.id === NONE) none = none || { id: NONE, name: l.name, c: 'var(--st-none)' };
      else if (!at[l.id]) { at[l.id] = 1; lanes.push({ id: l.id, name: l.name, c: COLORS[lanes.length % COLORS.length] }); }
      return Object.assign({}, w, { track: l.id, trackOf: w.track });
    });
    if (none) lanes.push(none);
    var idx = Object.create(null);
    lanes.forEach(function (l, i) { idx[l.id] = i; });
    out = out.map(function (w, i) { return { w: w, i: i }; })
      .sort(function (a, b) { return idx[a.w.track] - idx[b.w.track] || a.i - b.i; })
      .map(function (x) { return x.w; });
    return { tracks: lanes, rows: out };
  }

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
  function paintSelect(boards) {
    if (!sel) return;
    var noMap = !hasSectors(boards);
    sel.options[2].disabled = noMap;
    sel.options[2].textContent = MODES[2][1] + (noMap ? ' — карты ещё нет' : '');
    sel.value = mode === 'sector' && noMap ? 'track' : mode;
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
      try { localStorage.setItem(KEY, mode); } catch (e) { /* приватное окно */ }
      if (onChange) onChange();
    });
    var h = head.querySelector('h2');
    head.insertBefore(sel, h ? h.nextSibling : head.firstChild);
    paintSelect(boardsNow());
  }

  window.__oqLanes = {
    lanesOf: lanesOf,
    mode: function () { return mode; },
    onChange: function (cb) { onChange = cb; },
    /** Строки workList → {tracks, rows} по выбранной группировке; null — направления. */
    apply: function (rows) {
      var b = boardsNow();
      paintSelect(b);
      return lanesOf(rows, mode, b);
    },
  };
  try { mount(); } catch (e) { /* без списка — направления, как было */ }
})();`
