/**
 * Данные «Хода работ» и «Отчётов» страницы /queue без вшитых снимков (раньше — план и PR на 15.10 в page.html).
 * Отдельный скрипт до кода страницы (page.ts), как вложения (page-files.ts): window.__oqReports.
 *  - planRows — строки плана только из базы (work/<id>, уже отобраны по продукту в SHIM); вшитый план — значения по
 *    умолчанию под строкой базы с тем же id, своих строк он не даёт;
 *  - tracksIn — направления, в которых есть строки: базовые направления HR без строк у другого продукта не видны;
 *  - earliestDay — начало шкалы очереди по дням: день первого пункта, а не дата очереди HR;
 *  - prPoints и loadPrs — PR из GET /api/oq/v1/prs (queue/prs.ts): опрос раз в 5 минут, пока вкладка видна, с ETag;
 *  - dailyCounts и medianForecast — правая ось графика очереди: пунктов за день и скользящая медиана с прогнозом вперёд;
 *  - prCap — потолок шкалы PR (36 ч): что выше, рисуется на верхней линии с настоящим числом в подписи;
 *  - splitByProduct — разбивка строк по продуктам для режима «Все продукты»; пустой продукт — DEFAULT_PRODUCT;
 *  - datedCount, meanForecast и replan — прогноз графика «Задачи агентов: план и факт»: сколько точек с датой (меньше
 *    FORECAST_MIN — «мало данных», без линии), темп — скользящее среднее закрытых за день, пересчитанный план — остаток
 *    объёма, делённый на темп.
 * Чистые функции проверяет tests/queue-page-reports.test.ts.
 */
import { DEFAULT_PRODUCT } from './product-boards'

export const REPORTS_JS = String.raw`(function () {
  'use strict';
  var DAYMS = 864e5, PR_CAP_H = 36, FORECAST_MIN = 7, DEFAULT = ${JSON.stringify(DEFAULT_PRODUCT)};
  function day(s) { var m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function median(xs) {
    if (!xs.length) return 0;
    var s = xs.slice().sort(function (a, b) { return a - b; }), h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  // Пунктов за каждый день шкалы из n дней от start. Без даты — не в счёт: вшитые пункты страницы почти все без даты,
  // и в первый день встал бы всплеск, который сплющил бы правую ось. Раньше start — в первый день.
  function dailyCounts(dates, start, n) {
    var c = [];
    for (var i = 0; i < n; i++) c.push(0);
    dates.forEach(function (x) {
      var d = day(x), j = d ? Math.round((d - start) / DAYMS) : -1;
      if (d && j < n) c[Math.max(0, j)]++;
    });
    return c;
  }
  // Скользящая медиана за win последних дней (с текущим), потом ahead дней вперёд — последнее значение: прогноз
  // «если дальше как в последние win дней».
  function medianForecast(counts, win, ahead) {
    var out = counts.map(function (_, i) { return median(counts.slice(Math.max(0, i - win + 1), i + 1)); });
    var last = out.length ? out[out.length - 1] : 0;
    for (var k = 0; k < ahead; k++) out.push(last);
    return out;
  }
  // Сколько значений — даты: прогноз по меньше чем FORECAST_MIN точкам не рисуется («мало данных»).
  function datedCount(dates) { return dates.filter(function (x) { return !!day(x); }).length; }
  // Скользящее среднее за win последних дней (с текущим), потом ahead дней вперёд — последнее значение. Среднее, а не
  // медиана: закрытия задач редкие и пачками (в 4 днях из 14 на 10.11), медиана такого ряда — 0, и срок не считается.
  function meanForecast(counts, win, ahead) {
    var out = counts.map(function (_, i) {
      var w = counts.slice(Math.max(0, i - win + 1), i + 1), s = 0;
      w.forEach(function (v) { s += v; });
      return w.length ? s / w.length : 0;
    });
    var last = out.length ? out[out.length - 1] : 0;
    for (var k = 0; k < ahead; k++) out.push(last);
    return out;
  }
  // Пересчитанный план: от сделанного сегодня (vals[0] = done) с темпом rate задач в день до всего объёма total.
  // days — через сколько дней всё будет готово; null — темп 0 или срок дальше maxDays (линия — до maxDays).
  function replan(done, total, rate, maxDays) {
    var vals = [done], left = Math.max(0, total - done);
    if (!left) return { days: 0, vals: vals };
    var days = rate > 0 ? Math.ceil(left / rate - 1e-9) : null;
    if (days != null && days > maxDays) days = null;
    if (!(rate > 0)) return { days: null, vals: vals };
    for (var k = 1; k <= (days == null ? maxDays : days); k++) vals.push(Math.min(total, done + rate * k));
    return { days: days, vals: vals };
  }
  // Шкала PR: до PR_CAP_H часов; выше — точка на верхней линии (over), подпись и подсказка — с настоящим числом.
  function prCap(pts, niceMax) {
    var hmax = 4, over = 0;
    pts.forEach(function (p) { if (p.h > PR_CAP_H) over++; else if (p.h > hmax) hmax = p.h; });
    return { ymax: over ? PR_CAP_H : Math.min(PR_CAP_H, niceMax(hmax)), cap: PR_CAP_H, over: over };
  }
  // Сколько строк у каждого продукта: productOf(row) — slug, пустой — продукт по умолчанию (как в SHIM).
  function splitByProduct(rows, productOf) {
    var by = {};
    rows.forEach(function (r) { var p = productOf(r) || DEFAULT; by[p] = (by[p] || 0) + 1; });
    return by;
  }
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
    var recent = pts.filter(function (p) { return !p.open && now - p.c < 7 * DAYMS; }).map(function (p) { return p.h; });
    return { pts: pts, merged7: recent.length, median: median(recent) };
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
    dailyCounts: dailyCounts, medianForecast: medianForecast, prCap: prCap, splitByProduct: splitByProduct,
    datedCount: datedCount, meanForecast: meanForecast, replan: replan, FORECAST_MIN: FORECAST_MIN,
    loadPrs: loadPrs, prs: function () { return live; }, onPrs: function (cb) { onChange = cb; },
  };
})();`
