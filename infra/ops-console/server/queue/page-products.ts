/**
 * Продукт на странице /queue (v2-lite): выбор продукта первым в шапке страницы и подпись «Продукт:» с выбором у пунктов,
 * которые можно перенести. Отдельный скрипт, как кнопки мёржа (page-scripts.ts ENHANCE): разметку пункта не меняет,
 * только дополняет. Подпись — в шапке пункта вне `.chips` и `.item-body`: бот очереди читает эти места и переносит в
 * Telegram, подпись ему не нужна.
 * Выбор вверху — только когда актору видно больше одного продукта (GET /products). Он задаёт отбор снимков в подмене
 * базы (SHIM, __oqView): список, числа шапки и разделов, «Ход работ» и «Отчёты» — по одному продукту. Вшитые пункты
 * страницы (не из базы) — HR: при другом продукте они спрятаны здесь же классом oq-off.
 * Переносятся пункты из базы, кроме мёржа с вердиктом «Контроля»; входящее — с предупреждением, что его никто не возьмёт.
 * Проход — на изменение снимка items (подписка db) и разметки списков, без периодической работы.
 */
export const PRODUCTS_JS = String.raw`(function () {
  'use strict';
  var DEFAULT = 'hr-helper', KEY = 'oq-product-filter';
  var css = document.createElement('style');
  css.textContent = '.item.oq-off { display: none !important; }' +
    '.item-product { justify-self: start; display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }' +
    '.item-product select { font: inherit; font-size: 12px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }' +
    '.oq-product-pick { max-width: min(46vw, 260px); padding: 0 8px; text-overflow: ellipsis; }' +
    '@media (pointer: coarse) { .item-product select, .oq-product-pick { font-size: 16px; } .item-product select { min-height: 36px; } }';
  document.head.appendChild(css);
  var products = [], names = Object.create(null), filter = '', busy = Object.create(null);
  var docsById = Object.create(null), moved = Object.create(null);
  function readFilter() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function saveFilter(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* приватное окно */ } }
  /** Выбранный продукт; '' — все. Подмена базы отдаёт странице снимки заново, только если выбор сменился. */
  function setView(v) {
    filter = v;
    moved = Object.create(null);
    if (window.__oqView && (window.__oqViewOf ? window.__oqViewOf() : '') !== v) window.__oqView(v);
  }
  function indexDocs() {
    var docs = window.__oqDocs ? window.__oqDocs('items') : [];
    docsById = Object.create(null);
    for (var i = 0; i < docs.length; i++) docsById[docs[i].id] = docs[i];
  }
  function productOf(id) { var d = docsById[id]; return (d && d.product) || DEFAULT; }
  // Для строки автопередачи страницы (page.html paintRelayItem): автопередача — только HR.
  window.__oqProductOf = productOf;
  function movable(id) {
    var d = docsById[id], data = d && d.data;
    if (!data) return false;
    return !(data.kind === 'merge' && (data.sha || data.base));
  }
  function label(slug) { return names[slug] || slug; }
  function option(slug, text, selected) {
    var o = document.createElement('option');
    o.value = slug;
    o.textContent = text;
    if (selected) o.selected = true;
    return o;
  }
  function say(el, text, err) {
    var s = el.querySelector('.saved');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('err', !!err);
  }
  function change(el, id, sel) {
    var from = sel.dataset.product || DEFAULT, to = sel.value;
    if (to === from) return;
    var inbox = docsById[id] && docsById[id].data.kind === 'inbox';
    var warn = to === DEFAULT ? '' : inbox
      ? '\n\nСессий «' + label(to) + '» пока нет, задачу никто не возьмёт.'
      : '\n\nСессий «' + label(to) + '» в очереди пока нет: пункт и ваш ответ никто не прочтёт до их подключения.';
    if (!window.confirm('Перенести пункт в продукт «' + label(to) + '»?\n\nСессии «' + label(from) + '» его больше не увидят.' + warn)) {
      sel.value = from;
      return;
    }
    busy[id] = 1;
    sel.disabled = true;
    say(el, 'Переношу…');
    fetch('/api/oq/v1/items/' + encodeURIComponent(id) + '/product', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Ops-Csrf': '1' },
      body: JSON.stringify({ to: to }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status)); return j; });
    }).then(function () {
      // Сразу, не дожидаясь снимка: вернуть прежний продукт можно тут же, и подтверждение назовёт верный «из».
      sel.dataset.product = to;
      if (docsById[id]) docsById[id].product = to;
      // Перенесённый виден и при выборе другого продукта — до смены выбора: вернуть можно тут же.
      moved[id] = 1;
      if (window.__oqKeep) window.__oqKeep(id);
      say(el, '✓ Продукт: ' + label(to));
      if (window.__oqRefresh) { window.__oqRefresh('items'); window.__oqRefresh('checks'); }
    }, function (e) {
      sel.value = from;
      say(el, e.message, true);
    }).then(function () { delete busy[id]; sel.disabled = false; });
  }
  function fill(sel, p) {
    sel.dataset.product = p;
    sel.textContent = '';
    products.forEach(function (x) { sel.appendChild(option(x.slug, x.name, x.slug === p)); });
    if (!names[p]) sel.appendChild(option(p, p, true));
  }
  function decorateItem(el) {
    var id = el.dataset.id, head = el.querySelector('.item-head');
    if (!id || !head) return;
    var p = productOf(id), box = head.querySelector('.item-product');
    var can = el.dataset.src === 'db' && movable(id);
    if (box && !can && !busy[id]) { box.remove(); box = null; }
    if (!box && can) {
      box = document.createElement('label');
      box.className = 'item-product';
      box.appendChild(document.createTextNode('Продукт:'));
      var sel = document.createElement('select');
      sel.addEventListener('change', function () { change(el, id, sel); });
      box.appendChild(sel);
      head.appendChild(box);
    }
    var s = box && box.querySelector('select');
    if (s && !busy[id] && (s.dataset.product !== p || !s.children.length)) fill(s, p);
    // Пункт из ссылки «#item=<id>» и перенесённый на этой странице — видны при любом фильтре.
    var off = !!filter && p !== filter && !el.classList.contains('is-target') && !moved[id];
    el.classList.toggle('oq-off', off);
  }
  /** Выбор продукта — первым в шапке страницы (#head-bar), один на страницу. */
  function mountPicker() {
    var bar = document.getElementById('head-bar');
    if (!bar || bar.querySelector('.oq-product-pick')) return;
    var sel = document.createElement('select');
    sel.className = 'hb-btn oq-product-pick';
    sel.setAttribute('aria-label', 'Продукт: очередь и «Ход работ»');
    sel.appendChild(option('', 'Все продукты', !filter));
    products.forEach(function (x) { sel.appendChild(option(x.slug, x.name, x.slug === filter)); });
    sel.addEventListener('change', function () { saveFilter(sel.value); setView(sel.value); decorate(); });
    bar.insertBefore(sel, bar.firstChild);
  }
  function decorate() {
    indexDocs();
    document.querySelectorAll('section[data-section] .item[data-id]').forEach(decorateItem);
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; decorate(); });
  }
  fetch('/api/oq/v1/products', { credentials: 'same-origin' }).then(function (res) { return res.ok ? res.json() : { products: [] }; })
    .then(function (j) {
      products = Array.isArray(j.products) ? j.products.filter(function (x) { return x && typeof x.slug === 'string' && typeof x.name === 'string'; }) : [];
      // Без справочника — страница как до v2-lite: ни подписей, ни выбора; сохранённый выбор не действует.
      if (!products.length) { setView(''); return; }
      products.forEach(function (x) { names[x.slug] = x.name; });
      // Сохранён продукт, которого больше нет (lavaeon до 0016) или не видно, — выбор стирается: иначе подмена базы при
      // каждой загрузке сначала показывала бы пустую очередь.
      var saved = readFilter();
      if (saved && !names[saved]) { saved = ''; saveFilter(''); }
      // Один продукт — выбора нет и отбора нет.
      setView(products.length < 2 ? '' : saved);
      if (products.length >= 2) mountPicker();
      decorate();
      // Списки разделов — новые и перемонтированные пункты; снимок items — новый продукт без смены разметки.
      var mo = new MutationObserver(schedule);
      document.querySelectorAll('section[data-section] .list').forEach(function (l) { mo.observe(l, { childList: true }); });
      if (window.claude) window.claude.use('db').then(function (db) { if (db) db.collection('items').onSnapshot(schedule); });
    }, function () { setView(''); /* без справочника — страница как до v2-lite */ });
})();`
