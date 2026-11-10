/**
 * Данные «Хода работ» и «Отчётов» страницы /queue без вшитых снимков (раньше — план и PR на 15.10 в page.html).
 * Отдельный скрипт до кода страницы (page.ts), как вложения (page-files.ts): window.__oqReports.
 *  - planRows — строки плана только из базы (work/<id>, уже отобраны по продукту в SHIM); вшитый план — значения по
 *    умолчанию под строкой базы с тем же id, своих строк он не даёт;
 *  - tracksIn — направления, в которых есть строки: базовые направления HR без строк у другого продукта не видны;
 *  - earliestDay — начало шкалы очереди по дням: день первого пункта, а не дата очереди HR;
 *  - prPoints и loadPrs — PR из GET /api/oq/v1/prs (queue/prs.ts): опрос раз в 5 минут, пока вкладка видна, с ETag.
 * Чистые функции проверяет tests/queue-page-reports.test.ts.
 */
export const REPORTS_JS = String.raw`(function () {
  'use strict';
  var DAYMS = 864e5;
  function day(s) { var m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function planRows(dbWork, seed, track) {
    var by = {};
    seed.forEach(function (w) { by[w.id] = w; });
    return Object.keys(dbWork).map(function (id) { return Object.assign({ id: id }, by[id] || {}, dbWork[id]); })
      .filter(function (w) { return !w.archived && typeof w.title === 'string' && track[w.track]; })
      .sort(function (a, b) { return track[a.track].i - track[b.track].i || (a.order || 99) - (b.order || 99); });
  }
  function tracksIn(tracks, ws) {
    var used = {};
    ws.forEach(function (w) { used[w.track] = 1; });
    return tracks.filter(function (t) { return used[t.id]; });
  }
  function earliestDay(dates, t) {
    var s = t;
    dates.forEach(function (x) { var d = day(x); if (d && d < s) s = d; });
    return s;
  }
  // Точки графика и плитка: медиана ожидания мёржа у влитых за 7 дней; открытый PR ждёт до сейчас.
  function prPoints(prs, now) {
    var pts = prs.map(function (p) {
      var c = new Date(p.opened), mm = p.merged ? new Date(p.merged) : now;
      return { n: p.n, c: c, h: Math.max(0, (mm - c) / 36e5), open: !p.merged, t: String(p.title || ''), ours: !!p.ours };
    }).filter(function (p) { return !isNaN(p.c); });
    var recent = pts.filter(function (p) { return !p.open && now - p.c < 7 * DAYMS; }).map(function (p) { return p.h; }).sort(function (a, b) { return a - b; });
    var med = recent.length ? (recent.length % 2 ? recent[(recent.length - 1) / 2] : (recent[recent.length / 2 - 1] + recent[recent.length / 2]) / 2) : 0;
    return { pts: pts, merged7: recent.length, median: med };
  }
  // null — ответа ещё нет; none — токену не виден HR (репозиторий консоли — HR); error — причина вместо графика.
  var live = null, tag = '', at = 0, onChange = function () {};
  function loadPrs() {
    if (typeof fetch !== 'function' || document.hidden || (live && live.none) || Date.now() - at < 29e4) return;
    at = Date.now();
    fetch('/api/oq/v1/prs', { credentials: 'same-origin', headers: tag ? { 'If-None-Match': tag } : {} }).then(function (res) {
      if (res.status === 304) return null;
      if (res.status === 404) return { prs: [], none: true };
      if (!res.ok) return { prs: [], error: 'HTTP ' + res.status };
      tag = res.headers.get('ETag') || '';
      return res.json();
    }).then(function (j) { if (j) { live = j; onChange(); } }, function () { if (!live) { live = { prs: [], error: 'нет связи' }; onChange(); } });
  }
  setInterval(loadPrs, 3e5);
  window.__oqReports = {
    planRows: planRows, tracksIn: tracksIn, earliestDay: earliestDay, prPoints: prPoints,
    loadPrs: loadPrs, prs: function () { return live; }, onPrs: function (cb) { onChange = cb; },
  };
})();`
