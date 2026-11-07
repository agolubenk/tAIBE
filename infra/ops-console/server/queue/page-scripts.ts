/**
 * Скрипты, которые консоль добавляет к странице очереди (page.html — страница артефакта claude.ai как есть).
 *
 * SHIM ставится до кода страницы: подменяет window.claude.use('db') базой консоли. Страница не знает,
 * что переехала: collection().onSnapshot — опрос /api/oq/v1/db/<коллекция> с ETag (304 — почти бесплатно),
 * doc(...).set — PUT, doc(...).update — PATCH (ответ владельца в checks/<id> — только его поля). Вкладка в фоне
 * опрашивает реже.
 *
 * ENHANCE ставится после: кнопки «Влить» у пунктов мёржа и «Перезапустить деплой» (/api/oq/v1/merge,
 * /api/oq/v1/redeploy) с подтверждением, где видно PR, SHA, базу и последствие — деплой или нет. «Влить»
 * неактивна, пока в пункте нет вердикта «Контроля» (поля sha и base); снимок пунктов — window.__oqDocs.
 */

export const SHIM_JS = String.raw`(function () {
  'use strict';
  var BASE = '/api/oq/v1/db/';
  var subs = {};
  function json(res) {
    if (!res.ok) return res.text().then(function (t) { var m = ''; try { m = JSON.parse(t).error || ''; } catch (e) {} var err = new Error(m || ('HTTP ' + res.status)); err.status = res.status; throw err; });
    return res.status === 204 ? null : res.json();
  }
  function poll(col) {
    var s = subs[col];
    clearTimeout(s.timer);
    fetch(BASE + col, { credentials: 'same-origin', headers: s.etag ? { 'If-None-Match': s.etag } : {} })
      .then(function (res) {
        if (res.status === 304) return null;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        s.etag = res.headers.get('ETag');
        return res.json();
      })
      .then(function (j) {
        s.fail = 0;
        if (!j) return;
        // version — чтобы страница отличала снимок, снятый до своего сохранения (ревью #324, minor).
        // product — продукт документа (v2-lite): метка и фильтр страницы (page-products.ts), рядом с data.
        s.last = j.docs.map(function (d) { return { id: d.id, data: d.data, version: d.version, product: d.product }; });
        s.cbs.forEach(function (cb) { try { cb.ok(s.last); } catch (e) { console.error(e); } });
      })
      .catch(function (e) {
        s.fail = (s.fail || 0) + 1;
        if (s.fail === 3) s.cbs.forEach(function (cb) { if (cb.err) cb.err(e); });
      })
      .then(function () { s.timer = setTimeout(function () { poll(col); }, document.hidden ? 30000 : 4000); });
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) Object.keys(subs).forEach(function (col) { poll(col); });
  });
  var db = {
    collection: function (col) {
      return {
        onSnapshot: function (ok, err) {
          var s = subs[col] || (subs[col] = { cbs: [] });
          s.cbs.push({ ok: ok, err: err });
          if (s.cbs.length === 1) poll(col); else if (s.last) ok(s.last);
          return function () {};
        },
        get: function () {
          return fetch(BASE + col, { credentials: 'same-origin' }).then(json).then(function (j) { return j.docs; });
        },
      };
    },
    doc: function (path) {
      var p = String(path).split('/');
      var col = p[0], id = p.slice(1).join('/');
      // opts.ifVersion: 0 — создать только если документа ещё нет (иначе 409, ошибка несёт status).
      function write(method, data, opts) {
        var body = opts && typeof opts.ifVersion === 'number' ? { data: data, ifVersion: opts.ifVersion } : { data: data };
        // ifAnswerAt — at ответа владельца, от которого начата правка: другой сохранённый ответ даст 409.
        if (opts && typeof opts.ifAnswerAt === 'string') body.ifAnswerAt = opts.ifAnswerAt;
        return fetch(BASE + col + '/' + encodeURIComponent(id), {
          method: method, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Ops-Csrf': '1' },
          body: JSON.stringify(body),
        }).then(json).then(function (r) { if (subs[col]) poll(col); return r; });
      }
      return {
        // set — замена документа целиком (PUT); update — слияние присланных полей (PATCH), остальные поля не трогает.
        set: function (data, opts) { return write('PUT', data, opts); },
        update: function (data, opts) { return write('PATCH', data, opts); },
        // Один документ { id, data, version }; нет такого — ошибка со status 404.
        get: function () {
          return fetch(BASE + col + '/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(json);
        },
      };
    },
  };
  window.claude = { use: function (cap) { return Promise.resolve(cap === 'db' ? db : null); } };
  // Последний снимок коллекции — для кнопок ENHANCE (одобрена ли голова PR), без лишнего запроса.
  window.__oqDocs = function (col) { var s = subs[col]; return s && s.last ? s.last : []; };
  // Перечитать коллекцию сейчас — после записи мимо db (смена продукта, page-products.ts).
  window.__oqRefresh = function (col) { if (subs[col]) poll(col); };
})();`

export const ENHANCE_JS = String.raw`(function () {
  'use strict';
  function api(method, path, body) {
    return fetch('/api/oq/v1' + path, {
      method: method, credentials: 'same-origin',
      headers: Object.assign({ 'X-Ops-Csrf': '1' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status)); return j; });
    });
  }
  function say(el, text, err) {
    var s = el.querySelector('.saved');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('err', !!err);
  }
  function itemData(id) {
    var docs = window.__oqDocs ? window.__oqDocs('items') : [];
    for (var i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i].data;
    return null;
  }
  /** Вердикт «Контроля» в пункте: полный SHA головы (sha) и база PR (base); без обоих вливать нельзя. */
  function hasVerdict(id) {
    var d = itemData(id);
    return !!(d && /^[0-9a-f]{40}$/.test(d.sha || '') && /^[A-Za-z0-9._\/-]{1,200}$/.test(d.base || ''));
  }
  function syncButton(btn, id) {
    if (btn.dataset.busy) return;
    var ok = hasVerdict(id);
    btn.disabled = !ok;
    // Только при изменении: запись textContent — мутация childList, и наблюдатель ниже будил бы себя каждый кадр.
    var label = ok ? 'Влить сейчас…' : 'Ждёт вердикта «Контроля»';
    var title = ok ? '' : 'В пункте нет вердикта «Контроля» (поля sha и base) — вливать нельзя';
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.title !== title) btn.title = title;
  }
  function mergeFlow(el, id, btn) {
    btn.dataset.busy = '1';
    btn.disabled = true;
    say(el, 'Спрашиваю GitHub…');
    api('GET', '/merge/' + encodeURIComponent(id)).then(function (m) {
      var what = m.skipCi ? 'без деплоя ([skip ci])' : (m.deploys && m.baseRef === 'main' ? 'ЗАПУСТИТ ДЕПЛОЙ ПРОДА' : 'деплой не ожидается');
      if (m.state !== 'open') throw new Error('PR #' + m.pr + ': ' + (m.state === 'merged' ? 'уже влит' : 'закрыт'));
      if (m.approval === 'missing') throw new Error('Нет вердикта «Контроля» (поля sha и base в пункте) — вливать нельзя');
      if (m.approval === 'mismatch') throw new Error('Голова PR ' + m.headSha.slice(0, 7) + ' — не та, что одобрил «Контроль» (' + m.approvedSha.slice(0, 7) + '): нужен новый вердикт');
      if (m.approval === 'base') throw new Error('«Контроль» одобрил PR для базы «' + m.approvedBase + '», а сейчас база «' + m.baseRef + '»: нужен новый вердикт');
      if (m.deployRunning && m.deploys && !m.skipCi) throw new Error('Сейчас идёт деплой — дождитесь окончания');
      var ok = window.confirm('Влить ' + (m.repo || 'PR ') + '#' + m.pr + ' «' + m.title + '»?\n\nКоммит: ' + m.headSha.slice(0, 7) + ' (' + m.headRef + ' → ' + m.baseRef + '), одобрен «Контролем»\nСпособ: ' + (m.method === 'squash' ? 'squash — одним коммитом' : 'merge — коммитом слияния') +
        (m.subject ? '\nЗаголовок: ' + m.subject : '') + '\nПоследствие: ' + what +
        (m.baseRef !== 'main' ? '\n\n⚠️ База PR — «' + m.baseRef + '», не main: прод не изменится, меняется ветка «' + m.baseRef + '»' : '') +
        (m.mergeable === false ? '\n\n⚠️ GitHub: ' + (m.mergeableState || 'есть конфликт') : ''));
      if (!ok) { say(el, ''); return null; }
      say(el, 'Вливаю…');
      return api('POST', '/merge/' + encodeURIComponent(id), { sha: m.headSha });
    }).then(function (r) { if (r) say(el, '✓ ' + r.message); })
      .catch(function (e) { say(el, e.message, true); })
      .then(function () { delete btn.dataset.busy; syncButton(btn, id); });
  }
  function decorate() {
    document.querySelectorAll('#sec-merge .item[data-id]').forEach(function (el) {
      var btn = el.querySelector('.oq-merge');
      if (!btn) {
        var row = el.querySelector('.answer');
        if (!row) return;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toggle oq-merge';
        btn.addEventListener('click', function () { mergeFlow(el, el.dataset.id, btn); });
        row.insertBefore(btn, row.firstChild);
      }
      syncButton(btn, el.dataset.id);
    });
    var head = document.querySelector('#sec-merge .sec-head');
    if (head && !head.querySelector('.oq-redeploy')) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toggle oq-redeploy';
      b.textContent = 'Перезапустить деплой';
      b.addEventListener('click', function () {
        if (!window.confirm('Запустить деплой main на прод заново? ~3 минуты сайт отвечает 502.')) return;
        api('POST', '/redeploy').then(function (r) { window.alert(r.message); }, function (e) { window.alert(e.message); });
      });
      head.appendChild(b);
    }
  }
  var queued = false;
  new MutationObserver(function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; decorate(); });
  }).observe(document.body, { childList: true, subtree: true });
  decorate();
})();`
