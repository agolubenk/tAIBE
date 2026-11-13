// node --test infra/owner-queue-mcp/test — продукт сессии (фаза 4a, OPS-51): какой токен берёт MCP и чьи входящие
// передаёт --relay. Консоль поддельная, HOME — временный: журнал автопередачи не пишется в настоящий дом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SERVER = new URL('../server.mjs', import.meta.url).pathname;
// Продукт, которого нет ни в одном Keychain: проверка отката на OQ_TOKEN не зависит от машины.
const NO_TOKEN_PRODUCT = 'zz-oq-test';

const INBOX = (id, product) => ({
  id, version: 1, ...(product ? { product } : {}),
  data: { kind: 'inbox', title: `Задача ${id}`, added: '2026-11-13', inbox: { type: 'task', urgency: 'now', receivedAt: new Date().toISOString() } },
});

async function consoleFake() {
  const seen = { auth: [], beats: [] };
  const srv = createServer((req, res) => {
    seen.auth.push(req.headers.authorization);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/oq/v1/relay' && req.method === 'PUT') {
        seen.beats.push(JSON.parse(body));
        return res.end('{"alive":true,"sessions":[],"relayed":{},"products":{}}');
      }
      if (req.url.startsWith('/api/oq/v1/db/items')) {
        return res.end(JSON.stringify({ docs: [INBOX('i-hr'), INBOX('i-hr2', 'hr-helper'), INBOX('i-tb', 'taibe')] }));
      }
      if (req.url.startsWith('/api/oq/v1/db/checks')) return res.end('{"docs":[]}');
      res.statusCode = 404;
      res.end('{"error":"нет"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => srv.close() };
}

function env(port, extra) {
  const e = { ...process.env, OQ_URL: `http://127.0.0.1:${port}`, OQ_TOKEN: 'hr-token', HOME: mkdtempSync(join(tmpdir(), 'oq-home-')), ...extra };
  for (const k of ['OQ_PRODUCT', 'TAIBE_PRODUCT', 'OQ_TOKEN_taibe']) if (!(k in extra)) delete e[k];
  return e;
}

async function listOnce(port, extra) {
  const child = spawn(process.execPath, [SERVER], { env: env(port, extra), stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const reply = new Promise((resolve) => lines.once('line', resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oq_list', arguments: { collection: 'items', limit: 1 } } })}\n`);
  await reply;
  child.kill();
}

test('продукт сессии: OQ_PRODUCT, иначе TAIBE_PRODUCT, иначе hr-helper; имя токена — OQ_TOKEN или OQ_TOKEN_<slug>', async () => {
  process.env.OQ_TOKEN ??= 'test-token'; // импорт сервера не ходит в Keychain
  const { sessionProduct, tokenName } = await import('../server.mjs');
  assert.equal(sessionProduct({}), 'hr-helper');
  assert.equal(sessionProduct({ TAIBE_PRODUCT: 'taibe' }), 'taibe');
  assert.equal(sessionProduct({ OQ_PRODUCT: 'taibe', TAIBE_PRODUCT: 'hr-helper' }), 'taibe');
  assert.equal(sessionProduct({ OQ_PRODUCT: 'Не slug' }), 'hr-helper');
  assert.equal(tokenName('hr-helper'), 'OQ_TOKEN');
  assert.equal(tokenName('taibe'), 'OQ_TOKEN_taibe');
});

test('сессия taibe ходит в очередь своим токеном; токена продукта нет — прежним OQ_TOKEN', async (t) => {
  const fake = await consoleFake();
  t.after(fake.close);
  await listOnce(fake.port, { TAIBE_PRODUCT: 'taibe', OQ_TOKEN_taibe: 'tb-token' });
  assert.equal(fake.seen.auth.at(-1), 'Bearer tb-token');
  await listOnce(fake.port, { TAIBE_PRODUCT: NO_TOKEN_PRODUCT });
  assert.equal(fake.seen.auth.at(-1), 'Bearer hr-token');
  await listOnce(fake.port, {});
  assert.equal(fake.seen.auth.at(-1), 'Bearer hr-token');
});

test('--relay --product taibe: будит сессию только входящими taibe и отмечается за taibe своим токеном', async (t) => {
  const fake = await consoleFake();
  t.after(fake.close);
  const child = spawn(process.execPath, [SERVER, '--relay', 'taibe-coord-1', '--product', 'taibe'], {
    env: env(fake.port, { OQ_TOKEN_taibe: 'tb-token' }), stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const first = await new Promise((resolve) => lines.once('line', resolve));
  assert.match(first, /^Возьми входящее i-tb /);
  // Отметка — после строк прохода; ждём её не дольше 5 с.
  for (let i = 0; i < 50 && !fake.seen.beats.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fake.seen.beats[0], { session: 'taibe-coord-1', relayed: ['i-tb'], product: 'taibe' });
  assert.ok(fake.seen.auth.every((a) => a === 'Bearer tb-token'));
});
