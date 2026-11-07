/**
 * Продукт пункта на странице /queue (v2-lite, часть 3): метка у каждого пункта, смена продукта владельцем и фильтр
 * «Все / продукт» в панели инструментов. Отдельный скрипт, как кнопки мёржа (page-scripts.ts ENHANCE): разметку пункта
 * не меняет, только дополняет. Метка — в шапке пункта вне `.chips` и `.item-body`: бот очереди читает эти места и
 * переносит в Telegram, метка ему не нужна. Продукт — из снимка коллекции (window.__oqDocs, поле product); пункты,
 * вшитые в страницу, — продукта HR. Фильтр запоминается в браузере (localStorage), счётчики разделов — по всем продуктам.
 */
export const PRODUCTS_JS = String.raw`(function () {
  'use strict';
  var DEFAULT = 'hr-helper', KEY = 'oq-product-filter';
  var css = document.createElement('style');
  css.textContent = '.item.oq-off { display: none !important; }' +
    '.item-product { justify-self: start; font-size: 12px; color: var(--muted); }' +
    '.item-product select, .oq-product-filter select { font: inherit; font-size: 12px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }' +
    '.oq-product-filter { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; margin-left: 8px; }' +
    '.oq-product-hint { color: var(--muted); font-size: 12px; }';
  document.head.appendChild(css);
  var products = [], names = {}, filter = '', busy = {};
  function readFilter() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function saveFilter(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* приватное окно */ } }
  function productOf(id) {
    var docs = window.__oqDocs ? window.__oqDocs('items') : [];
    for (var i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i].product || DEFAULT;
    return DEFAULT;
  }
  function option(slug, label, selected) {
    var o = document.createElement('option');
    o.value = slug;
    o.textContent = label;
    if (selected) o.selected = true;
    return o;
  }
  function say(el, text, err) {
    var s = el.querySelector('.saved');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('err', !!err);
  }
  function change(el, id, sel, from) {
    var to = sel.value;
    if (to === from) return;
    if (!window.confirm('Перенести пункт в продукт «' + (names[to] || to) + '»?\n\nСессии продукта «' + (names[from] || from) + '» его больше не увидят.')) {
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
      say(el, '✓ Продукт: ' + (names[to] || to));
      if (window.__oqRefresh) { window.__oqRefresh('items'); window.__oqRefresh('checks'); }
    }, function (e) {
      sel.value = from;
      say(el, e.message, true);
    }).then(function () { delete busy[id]; sel.disabled = false; });
  }
  function decorateItem(el) {
    var id = el.dataset.id, head = el.querySelector('.item-head');
    if (!id || !head) return;
    var p = productOf(id), box = head.querySelector('.item-product');
    if (!box) {
      box = document.createElement('label');
      box.className = 'item-product';
      var sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Продукт пункта');
      // Пункты, вшитые в страницу, в базе не живут — менять их продукт нечем.
      if (el.dataset.src !== 'db') sel.disabled = true;
      sel.addEventListener('change', function () { change(el, id, sel, sel.dataset.product || DEFAULT); });
      box.appendChild(sel);
      head.appendChild(box);
    }
    var s = box.querySelector('select');
    if (s.dataset.product !== p && !busy[id]) {
      s.dataset.product = p;
      s.textContent = '';
      products.forEach(function (x) { s.appendChild(option(x.slug, x.name, x.slug === p)); });
      if (!names[p]) s.appendChild(option(p, p, true));
    }
    el.classList.toggle('oq-off', !!filter && p !== filter);
  }
  function decorateBar() {
    var bar = document.querySelector('header .toolbar');
    if (!bar || bar.querySelector('.oq-product-filter') || !products.length) return;
    var box = document.createElement('label');
    box.className = 'oq-product-filter';
    box.appendChild(document.createTextNode('Продукт '));
    var sel = document.createElement('select');
    sel.appendChild(option('', 'Все', !filter));
    products.forEach(function (x) { sel.appendChild(option(x.slug, x.name, x.slug === filter)); });
    sel.addEventListener('change', function () { filter = sel.value; saveFilter(filter); decorate(); });
    box.appendChild(sel);
    var hint = document.createElement('small');
    hint.className = 'oq-product-hint';
    hint.textContent = 'счётчики разделов — по всем продуктам';
    box.appendChild(hint);
    bar.appendChild(box);
  }
  function decorate() {
    decorateBar();
    var hint = document.querySelector('.oq-product-hint');
    if (hint) hint.hidden = !filter;
    document.querySelectorAll('section[data-section] .item[data-id]').forEach(decorateItem);
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; if (products.length) decorate(); });
  }
  fetch('/api/oq/v1/products', { credentials: 'same-origin' }).then(function (res) { return res.ok ? res.json() : { products: [] }; })
    .then(function (j) {
      products = Array.isArray(j.products) ? j.products.filter(function (x) { return x && typeof x.slug === 'string' && typeof x.name === 'string'; }) : [];
      products.forEach(function (x) { names[x.slug] = x.name; });
      filter = readFilter();
      if (filter && !names[filter]) { filter = ''; saveFilter(''); }
      decorate();
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
      // Продукт пункта меняется без смены разметки (снимок items пришёл, а тело то же) — сверка раз в 4 с.
      setInterval(schedule, 4000);
    }, function () { /* без справочника — страница как до v2-lite */ });
})();`
