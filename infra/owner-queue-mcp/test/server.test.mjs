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

function mcp(port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OQ_URL: `http://127.0.0.1:${port}`, OQ_TOKEN: 'test-token', OQ_FILES_DIR: '' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
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
  return { call, close: () => child.kill() };
}

async function rig(t, files) {
  const state = { checks: CHECKS.slice(), checksReads: 0 };
  const srv = await consoleFake(files, state);
  const m = mcp(srv.address().port);
  t.after(() => { m.close(); srv.close(); });
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
    assert.ok(calls < 10, 'next_offset не сходится');
    page = body(await m.call('oq_list', { collection: 'checks', limit: 500, offset: page.next_offset, as_of: asOf }));
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

  // brief: весь список в одном ответе, длинное поле — начало и длина; целиком — oq_get.
  const brief = body(await m.call('oq_list', { collection: 'checks', limit: 500, brief: true }));
  assert.equal(brief.docs.length, m.state.checks.length);
  assert.equal(brief.next_offset, undefined);
  assert.equal(brief.docs[1].noteLen, 2_000);
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
