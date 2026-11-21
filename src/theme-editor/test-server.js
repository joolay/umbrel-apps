'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-')); process.env.DATA_DIR = dir;
const calls = [];
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { const j = JSON.parse(b); calls.push({ auth: req.headers.authorization, ...j }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { font: 'system', echo: j.args && j.args[0] } })); }); });
fake.listen(0, async () => {
  const { server } = require('./server');
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port, get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json().catch(() => null)]);
  // The pages themselves are served as files (not JSON)
  let pg = await fetch(base + '/'); assert.ok(/text\/html/.test(pg.headers.get('content-type')) && (await pg.text()).startsWith('<!DOCTYPE html>'));
  pg = await fetch(base + '/app.js'); assert.ok(/javascript/.test(pg.headers.get('content-type')) && (await pg.text()).includes('Theme Editor front end'));
  // Not linked: a clear message, never a crash
  let [st, j] = await get('/api/theme'); assert.strictEqual(st, 503); assert.ok(/Not linked/.test(j.message));
  fs.writeFileSync(path.join(dir, 'pocketbase.env'), `POCKETBASE_PORTAL_URL=http://127.0.0.1:${fake.address().port}\nPOCKETBASE_PORTAL_KEY=theme-editor.k\n`);
  [st, j] = await get('/api/theme'); assert.strictEqual(st, 200); assert.strictEqual(calls[0].fn, 'theme.get'); assert.strictEqual(calls[0].auth, 'Bearer theme-editor.k');
  const r = await fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify({ theme: { font: 'serif' } }) }); assert.strictEqual(r.status, 200);
  assert.strictEqual(calls[1].fn, 'theme.set'); assert.deepStrictEqual(calls[1].args[0], { font: 'serif' });
  assert.strictEqual((await fetch(base + '/api/theme', { method: 'POST', body: 'nope' })).status, 400);
  assert.strictEqual((await fetch(base + '/api/reset', { method: 'POST' })).status, 200); assert.strictEqual(calls[2].fn, 'theme.reset');
  assert.ok([403, 404].includes((await fetch(base + '/%2e%2e/server.js')).status));
  console.log('theme-editor server: ok'); server.close(); fake.close();
});
