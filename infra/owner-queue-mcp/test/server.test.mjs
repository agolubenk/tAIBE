// node --test infra/owner-queue-mcp/test — MCP очереди целиком через stdio на поддельной консоли: что агент узнаёт о
// вложениях, когда консоль старая (без файлов), молчит или отдала не все обещанные файлы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = new URL('../server.mjs', import.meta.url).pathname;
const ITEM = 'i-20261023-040000-abcd';
const FILE = 'b'.repeat(32);
const BODY = 'строка лога';
const BIG = 's-tb-update-big';
const B64 = Buffer.from('x'.repeat(3_000)).toString('base64');
const BIG_DOC = {
  id: BIG, version: 7, updatedAt: 1_763_200_000_000, createdAt: 1_763_100_000_000, product: 'hr-helper',
  data: { kind: 'server', title: 'Обновить доски на сервере', source: 'backend r.f93t.g88q', body: 'т'.repeat(2_500),
    cmd: `echo ${B64} | base64 -d | bash`, cmd2: `echo ${B64} | base64 -d | bash -s -- --rollback`, after: 'п'.repeat(800) },
};
// 120 отметок по ~2 КБ: весь список (~250 тыс. символов) в один ответ не влезает — как checks на 30.10 (504 документа).
// Каждая десятая — ответ владельца, который агент ещё не прочёл.
const CHECKS = Array.from({ length: 120 }, (_, i) => ({
  id: `c-${String(i).padStart(3, '0')}`,
  version: 1,
  data: i % 10 ? { agentStatus: 'planned', agentAt: '2026-10-30T01:00:00Z', note: 'н'.repeat(2_000) } : { done: true, at: '2026-10-30T02:00:00Z', note: 'н'.repeat(2_000) },
}));

/**
 * files: 'old' — консоль без вложений (маршрута нет), 'down' — 503, 'ok' — один файл из трёх обещанных.
 * state.checks — что консоль отдаёт сейчас (тест может менять между вызовами), state.checksReads — сколько раз читали.
 */
async function consoleFake(files, state) {
  const srv = createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // Свой статус агента: тело запроса — как есть, для проверки полей takeover и release.
    if (req.method === 'PATCH' && pathname.startsWith('/api/oq/v1/db/checks/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { state.patches = [...(state.patches ?? []), JSON.parse(raw)]; json(200, { id: 'x', version: 2, data: {} }); });
      return;
    }
    // История: консоль новой версии — по limit и с next; state.oldHistory — старая, параметры не знает и отдаёт 50 полных.
    if (pathname.startsWith('/api/oq/v1/history/items/')) {
      state.historyQueries = [...(state.historyQueries ?? []), searchParams.toString()];
      const ev = (i) => ({ at: 1_000 - i, actor: 'token:a', action: 'patch', ...(searchParams.get('fields') === 'meta' ? { keys: ['step'] } : { after: { step: 50 - i } }) });
      if (state.oldHistory) return json(200, { events: Array.from({ length: 50 }, (_, i) => ev(i)) });
      const n = Number(searchParams.get('limit') || 50);
      return json(200, { events: Array.from({ length: n }, (_, i) => ev(i)), next: '77' });
    }
    // Дельта /changes (OPS-50) — только если тест её включил (state.delta); иначе 404, как у старой консоли.
    if (pathname === '/api/oq/v1/changes' && state.delta) {
      state.changesReqs = [...(state.changesReqs ?? []), searchParams.get('since') ? 'since' : 'full'];
      const items = [{ id: 'd-hr-1', version: 1, updatedAt: 2, product: 'hr-helper', data: { kind: 'decision', title: 'HR' } },
        { id: 'taibe-d-1', version: 1, updatedAt: 1, product: 'taibe', data: { kind: 'decision', title: 'tAIBE' } }];
      if (searchParams.get('since')) return json(200, { cursor: 'b1.1', changes: { checks: { docs: [], removed: [] }, items: { docs: [], removed: [] }, work: { docs: [], removed: [] } } });
      const full = JSON.stringify({ full: true, cursor: 'b1.1', collections: { checks: { docs: [] }, items: { docs: items }, work: { docs: [] } } });
      // OPS-79: полный список медленный — заголовки сразу, остаток тела через state.slowFullMs (как 1,64 МБ за 43 с).
      if (state.slowFullMs) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(full.slice(0, 5));
        setTimeout(() => { if (!res.destroyed) res.end(full.slice(5)); }, state.slowFullMs);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(full);
    }
    // Список пунктов с продуктом рядом с data; ?product= фильтрует консоль, MCP передаёт его как есть.
    if (pathname === '/api/oq/v1/db/items') {
      state.itemsQueries = [...(state.itemsQueries ?? []), searchParams.toString()];
      const all = [
        { id: 'd-hr-1', version: 1, product: 'hr-helper', data: { kind: 'decision', title: 'HR', options: [{ id: 'y', label: 'Да' }] } },
        { id: 'taibe-d-1', version: 1, product: 'taibe', data: { kind: 'decision', title: 'tAIBE', options: [{ id: 'y', label: 'Да' }] } },
      ];
      const p = searchParams.get('product');
      return json(200, { docs: p && !state.ignoreProduct ? all.filter((d) => d.product === p) : all });
    }
    // OPS-18: s-пункт с двумя командами и длинным телом (~12 КБ, как s-tb-update-b8) и его отметка checks.
    // state.bigCheck: 'ok' (по умолчанию) — ответ владельца без отметки агента, 'none' — 404, 'down' — 503.
    if (pathname === `/api/oq/v1/db/items/${BIG}`) {
      if (req.method === 'GET') return json(200, BIG_DOC);
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { state.writes = [...(state.writes ?? []), { method: req.method, body: JSON.parse(raw) }]; json(200, { ...BIG_DOC, version: 8 }); });
      return;
    }
    if (pathname === `/api/oq/v1/db/checks/${BIG}`) {
      if (state.bigCheck === 'none') return json(404, { error: 'Нет такого документа' });
      if (state.bigCheck === 'down') return json(503, { error: 'Service Unavailable' });
      return json(200, { id: BIG, version: 2, data: { done: true, at: '2026-11-15T10:00:00Z', ownerAt: '2026-11-15T10:00:00Z', note: 'н'.repeat(1_500) } });
    }
    if (pathname === `/api/oq/v1/db/items/${ITEM}`) {
      return json(200, { id: ITEM, version: 1, data: { kind: 'inbox', title: 'лог', inbox: { type: 'bug', filesExpected: 3, receivedAt: new Date().toISOString() } } });
    }
    if (pathname === '/api/oq/v1/db/checks') {
      state.checksReads += 1;
      return json(200, { docs: state.checks });
    }
    // Консоль с потолком списка: отдала 2 самых свежих из 7 (поля обрезки — рядом с docs).
    if (pathname === '/api/oq/v1/db/work') {
      return json(200, { docs: [1, 2].map((n) => ({ id: `w-cap-${n}`, version: 1, data: { title: `строка ${n}`, track: 'ops', status: 'todo' } })), truncated: true, total: 7, limit: 2 });
    }
    if (pathname === '/api/oq/v1/files') {
      if (files === 'old') return json(404, { error: 'Not Found' });
      if (files === 'down') return json(503, { error: 'Service Unavailable' });
      const sha256 = createHash('sha256').update(BODY).digest('hex');
      return json(200, { files: [{ id: FILE, name: 'лог.txt', kind: 'document', size: Buffer.byteLength(BODY), sha256, createdAt: '2026-10-23T01:00:00.000Z' }], expired: 0 });
    }
    if (pathname === `/api/oq/v1/files/${FILE}`) { res.writeHead(200); return res.end(BODY); }
    return json(404, { error: 'нет' });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return srv;
}

function mcp(port, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    // OQ_PRODUCT — основной: в сессии tAIBE TAIBE_PRODUCT=taibe, и сервер пошёл бы в Keychain за настоящим токеном.
    env: { ...process.env, OQ_URL: `http://127.0.0.1:${port}`, OQ_TOKEN: 'test-token', OQ_PRODUCT: 'hr-helper', OQ_FILES_DIR: '', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Диагностика сервера (stderr) — для проверок вида «нет строки о нарушении контракта».
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.resolve(msg.result);
      waiting.delete(msg.id);
    }
  });
  // Сервер упал (синтаксис, исключение при старте) — вызовы падают сразу, а не ждут ответа вечно.
  child.on('exit', (code) => {
    for (const w of waiting.values()) w.reject(new Error(`MCP завершился с кодом ${code}`));
    waiting.clear();
  });
  let seq = 0;
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${name}: нет ответа за 10 с`)); }, 10_000);
    waiting.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
  return { call, close: () => child.kill(), stderr: () => stderr.join('') };
}

async function rig(t, files, extraEnv) {
  const state = { checks: CHECKS.slice(), checksReads: 0 };
  const srv = await consoleFake(files, state);
  const m = mcp(srv.address().port, extraEnv);
  t.after(() => { m.close(); srv.closeAllConnections(); srv.close(); });
  return { ...m, state };
}
const body = (result) => JSON.parse(result.content[0].text);

test('консоль без вложений (404) — понятный отказ вместо «HTTP 404»; oq_get — входящее как раньше (линза GLM «ресурсы» #314)', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'old');
  const r = await m.call('oq_files', { item: ITEM });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /консоль не поддерживает вложения/);
  const g = await m.call('oq_file_get', { item: ITEM, dir: mkdtempSync(join(tmpdir(), 'oqmcp-old-')) });
  assert.match(g.content[0].text, /консоль не поддерживает вложения/);
  assert.equal(body(await m.call('oq_get', { collection: 'items', id: ITEM })).files, undefined);
});

test('консоль не отдала список файлов (503) — oq_get помечает files unknown, а не «вложений нет» (линза GLM «ресурсы» #314)', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'down');
  const files = body(await m.call('oq_get', { collection: 'items', id: ITEM })).files;
  assert.equal(files.unknown, true);
  assert.equal(files.expected, 3);
});

test('oq_file_get без id — файлы и state: один из трёх — неполный набор, а не «все вложения» (линза GLM «ресурсы» #314)', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const out = body(await m.call('oq_file_get', { item: ITEM, dir: mkdtempSync(join(tmpdir(), 'oqmcp-get-')) }));
  assert.equal(out.files.length, 1);
  assert.ok(existsSync(out.files[0].path));
  assert.deepEqual([out.state.ready, out.state.expected, out.state.incomplete], [1, 3, true]);
  assert.match(out.state.note, /ещё грузятся/);
  const one = body(await m.call('oq_file_get', { item: ITEM, id: FILE, dir: mkdtempSync(join(tmpdir(), 'oqmcp-one-')) }));
  assert.equal(one.state, undefined, 'один файл по id — без state пункта');
  assert.equal(body(await m.call('oq_files', { item: ITEM })).state.incomplete, true);
});

test('oq_file_get не пишет в репозиторий и домашний каталог — только временный каталог (QA и Безопасность #314)', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  for (const dir of [join(repo, '.github', 'workflows'), join(homedir(), '.claude', 'agents')]) {
    const r = await m.call('oq_file_get', { item: ITEM, dir });
    assert.equal(r.isError, true, dir);
    assert.match(r.content[0].text, /вне разрешённых/);
  }
  assert.equal(existsSync(join(repo, '.github', 'workflows', `${FILE}.txt`)), false, 'файл не лёг в .github/workflows');
});

test('oq_list: список больше потолка ответа — next_offset доводит до последнего документа, ни один не теряется (карточка A 115a)', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const seen = [];
  let page = { next_offset: 0 };
  let asOf;
  for (let calls = 0; page.next_offset !== undefined; calls += 1) {
    assert.ok(calls < 10, 'next_offset не сходится'); // 120 по 30 — 4 страницы
    page = body(await m.call('oq_list', { collection: 'checks', limit: 500, offset: page.next_offset, as_of: asOf }));
    assert.ok(page.docs.length <= 30, 'limit выше потолка — 30 (SE-45)');
    if (page.next_offset !== undefined) assert.equal(page.more, `ещё ${page.total - page.next_offset}`);
    assert.equal(page.total, 120);
    assert.equal(page.resnapshot, undefined);
    asOf ??= page.asOf;
    assert.equal(page.asOf, asOf, 'все страницы обхода — один снимок');
    seen.push(...page.docs.map((d) => d.id));
    // Между страницами в консоли появился новый документ в начале списка — обход по снимку его не видит и не сдвигается.
    if (calls === 0) m.state.checks.unshift({ id: 'c-new', version: 1, data: { agentStatus: 'planned' } });
  }
  assert.deepEqual(seen, CHECKS.map((d) => d.id));
  assert.equal(m.state.checksReads, 1, 'обход страницами — одно чтение консоли');
  assert.equal(body(await m.call('oq_list', { collection: 'checks', limit: 1 })).total, 121, 'offset 0 — свежий список');

  const unread = body(await m.call('oq_list', { collection: 'checks', unread: true }));
  assert.deepEqual(unread.docs.map((d) => d.id), CHECKS.filter((_, i) => i % 10 === 0).map((d) => d.id));

  // brief: длинное поле — начало и длина; целиком — oq_get. Без limit — 20 и «ещё N».
  const brief = body(await m.call('oq_list', { collection: 'checks', brief: true }));
  assert.equal(brief.docs.length, 20);
  assert.equal(brief.next_offset, 20);
  assert.equal(brief.more, `ещё ${m.state.checks.length - 20}`);
  assert.equal(brief.docs[1].noteLen, 2_000);
  // С ids — все названные, без потолка 30.
  const named = m.state.checks.slice(0, 40).map((d) => d.id);
  const byIds = body(await m.call('oq_list', { collection: 'checks', ids: named, brief: true }));
  assert.deepEqual(byIds.docs.map((d) => d.id), named);
  assert.equal(byIds.next_offset, undefined);
});

test('oq_agent_status: takeover и release уходят полями запроса, не в data', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  await m.call('oq_agent_status', { id: 'i-1', status: 'taken', session: ' r.ab12.cd34 ', takeover: ' r.ab12 ' });
  await m.call('oq_agent_status', { id: 'i-1', session: 'r.ab12', note: 'передано r.zz99', release: true });
  await m.call('oq_agent_status', { id: 'i-1', status: 'doing', session: 'r.x', note: 'работаю', release: false });
  // Новый статус без note — заметка пустая, как раньше; отпуск без статуса заметку не трогает; без status и без
  // release — понятный отказ, без запроса.
  assert.deepEqual(m.state.patches, [
    { data: { agentStatus: 'taken', agentNote: '', agentBy: 'r.ab12.cd34' }, takeover: 'r.ab12' },
    { data: { agentNote: 'передано r.zz99', agentBy: 'r.ab12' }, release: true },
    { data: { agentStatus: 'doing', agentNote: 'работаю', agentBy: 'r.x' } },
  ]);
  const bad = await m.call('oq_agent_status', { id: 'i-1', session: 'r.x' });
  assert.match(JSON.stringify(bad), /Нужен status/);
  assert.equal(m.state.patches.length, 3);
});

test('oq_list: продукт пункта в строке, параметр product уходит консоли', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const all = body(await m.call('oq_list', { collection: 'items' }));
  assert.deepEqual(all.docs.map((d) => [d.id, d.product]), [['d-hr-1', 'hr-helper'], ['taibe-d-1', 'taibe']]);
  const one = body(await m.call('oq_list', { collection: 'items', product: 'taibe', open_only: true }));
  assert.deepEqual(one.docs.map((d) => d.id), ['taibe-d-1']);
  assert.ok(m.state.itemsQueries.includes('open=1&product=taibe'), m.state.itemsQueries.join(' | '));
  // Консоль до v2-lite.3 product не знает и отдаёт всё — MCP фильтрует сам.
  m.state.ignoreProduct = true;
  const old = body(await m.call('oq_list', { collection: 'items', product: 'hr-helper' }));
  assert.deepEqual(old.docs.map((d) => d.id), ['d-hr-1']);
});

test('oq_list: серверный потолок списка — serverCapped с числами, не путается с truncated окна', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const capped = body(await m.call('oq_list', { collection: 'work' }));
  assert.equal(capped.serverCapped, 'консоль отдала 2 самых свежих из 7 документов коллекции; старые — oq_get по id');
  assert.equal(capped.truncated, undefined, 'окно ответа не урезано');
  assert.deepEqual(capped.docs.map((d) => d.id), ['w-cap-1', 'w-cap-2']);
  assert.equal(body(await m.call('oq_list', { collection: 'checks', limit: 1 })).serverCapped, undefined, 'без обрезки консоли — поля нет');
});

test('oq_list через дельту /changes (карточка HR Q-38): коллекция — полный список раз, дальше since; open_only — сервер, как раньше', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  m.state.delta = true;
  const first = body(await m.call('oq_list', { collection: 'items' }));
  assert.deepEqual(first.docs.map((d) => d.id), ['d-hr-1', 'taibe-d-1']);
  const own = body(await m.call('oq_list', { collection: 'items', product: 'taibe' }));
  assert.deepEqual(own.docs.map((d) => d.id), ['taibe-d-1'], 'продукт — фильтром здесь, по полю product');
  assert.deepEqual(m.state.changesReqs, ['full', 'since']);
  assert.equal(m.state.itemsQueries, undefined, 'полный /db/items не читали ни разу');
  await m.call('oq_list', { collection: 'items', open_only: true });
  assert.deepEqual(m.state.itemsQueries, ['open=1'], 'открытые — серверным правилом open-rule.ts');
});

test('OPS-79: полный /changes дольше обычного таймаута, но в пределах таймаута списка — oq_list через дельту, без ошибки контракта и без /db/items', { timeout: 30_000 }, async (t) => {
  // Масштаб 1:100 от 15.11: обычный таймаут 300 мс (20 с), тело — 800 мс (43 с), таймаут списка — 5 с (120 с).
  const m = await rig(t, 'ok', { OQ_TIMEOUT_MS: '300', OQ_LIST_TIMEOUT_MS: '5000' });
  m.state.delta = true;
  m.state.slowFullMs = 800;
  const first = body(await m.call('oq_list', { collection: 'items' }));
  assert.deepEqual(first.docs.map((d) => d.id), ['d-hr-1', 'taibe-d-1']);
  assert.deepEqual(m.state.changesReqs, ['full']);
  assert.equal(m.state.itemsQueries, undefined, 'прежний путь не понадобился');
  assert.doesNotMatch(m.stderr(), /не по контракту|не ответила/);
});

test('OPS-79: полный /changes не дочитан и за таймаут списка — временный сбой: oq_list прежним путём, без ошибки контракта; ответ — не `{}`', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok', { OQ_TIMEOUT_MS: '300', OQ_LIST_TIMEOUT_MS: '400' });
  m.state.delta = true;
  m.state.slowFullMs = 2_000;
  const first = body(await m.call('oq_list', { collection: 'items' }));
  assert.deepEqual(first.docs.map((d) => d.id), ['d-hr-1', 'taibe-d-1'], 'список — из GET /db/items');
  assert.deepEqual(m.state.itemsQueries, ['']);
  assert.match(m.stderr(), /консоль не ответила на \/changes \(ответ консоли не дочитан/);
  assert.doesNotMatch(m.stderr(), /не по контракту|30 мин/);
});

test('oq_history (карточка HR oow56fdzk): по умолчанию limit=20, keys_only → fields=meta, next и before; старая консоль — окно режет MCP', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const d = body(await m.call('oq_history', { collection: 'items', id: 'd-1' }));
  assert.equal(d.events.length, 20);
  assert.equal(d.next, '77');
  const k = body(await m.call('oq_history', { collection: 'items', id: 'd-1', limit: 5, keys_only: true, before: '77' }));
  assert.deepEqual(k.events[0].keys, ['step']);
  assert.equal(k.events[0].after, undefined);
  assert.deepEqual(m.state.historyQueries, ['limit=20', 'limit=5&before=77&fields=meta']);
  m.state.oldHistory = true;
  const old = body(await m.call('oq_history', { collection: 'items', id: 'd-1', limit: 3 }));
  assert.equal(old.events.length, 3, 'консоль без limit отдала 50 — MCP показал 3');
  assert.equal(old.next, undefined);
  assert.match(old.console, /консоль старой версии/, 'агент знает, что before и keys_only не сработали');
});

test('oq_history: окно урезал потолок ответа — next не отдаётся, подсказка уменьшить limit (линза Claude #360, B2)', async () => {
  const { historyOut } = await import('../list.mjs');
  // 60 коротких полей на событие: brief их не сокращает (короче 200 символов), 100 событий не влезают и в brief.
  const after = Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`f${k}`, 'x'.repeat(20)]));
  const big = Array.from({ length: 100 }, (_, i) => ({ at: i, actor: 'a', action: 'update', after: { ...after, step: i } }));
  const out = historyOut({ events: big, next: '900' }, { n: 100 });
  assert.equal(out.truncated, true);
  assert.equal(out.next, undefined, 'next консоли указывал бы за 100-е событие, а показаны не все');
  assert.match(out.hint, /меньшим limit/);
  const fits = historyOut({ events: big.slice(0, 3), next: '900' }, { n: 3 });
  assert.equal(fits.next, '900');
});

test('OPS-18: oq_put и oq_patch отвечают {id, version, updatedAt} (≤ 200 байт), запрос к консоли прежний', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  for (const name of ['oq_put', 'oq_patch']) {
    const r = await m.call(name, { collection: 'items', id: BIG, data: { title: 'x' }, if_version: 7 });
    assert.ok(Buffer.byteLength(r.content[0].text) <= 200, `${name}: ${Buffer.byteLength(r.content[0].text)} байт`);
    assert.deepEqual(body(r), { id: BIG, version: 8, updatedAt: BIG_DOC.updatedAt });
  }
  assert.deepEqual(m.state.writes, [
    { method: 'PUT', body: { data: { title: 'x' }, ifVersion: 7 } },
    { method: 'PATCH', body: { data: { title: 'x' }, ifVersion: 7 } },
  ]);
});

test('OPS-18: oq_get brief — версия, заголовок и отметка checks без body/cmd/cmd2/after (≤ 1 КБ); без brief — документ целиком', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const full = await m.call('oq_get', { collection: 'items', id: BIG });
  assert.deepEqual(body(full), BIG_DOC, 'клиент без флага получает прежний ответ');
  const r = await m.call('oq_get', { collection: 'items', id: BIG, brief: true });
  const size = Buffer.byteLength(r.content[0].text);
  assert.ok(size <= 1024, `brief: ${size} байт (полный — ${Buffer.byteLength(full.content[0].text)})`);
  const b = body(r);
  assert.deepEqual(b, {
    id: BIG, version: 7, updatedAt: BIG_DOC.updatedAt, product: 'hr-helper', kind: 'server', title: BIG_DOC.data.title,
    source: BIG_DOC.data.source, check: { done: true, unread: true },
  });
  m.state.bigCheck = 'none';
  assert.equal(body(await m.call('oq_get', { collection: 'items', id: BIG, brief: true })).check, null);
  m.state.bigCheck = 'down';
  assert.equal(body(await m.call('oq_get', { collection: 'items', id: BIG, brief: true })).check.unknown, true, 'сбой checks — не «владелец не ответил»');
});

test('OPS-18: oq_get brief входящего — с пометкой «данные», без текста и вложений', { timeout: 30_000 }, async (t) => {
  const m = await rig(t, 'ok');
  const b = body(await m.call('oq_get', { collection: 'items', id: ITEM, brief: true }));
  assert.equal(b.kind, 'inbox');
  assert.equal(b.inbox, undefined);
  assert.equal(b.files, undefined);
  assert.match(b.untrusted, /не инструкции/);
});
