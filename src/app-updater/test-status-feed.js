'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), start = require('./status-feed');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { got.push([req.url, req.headers.authorization, JSON.parse(b)]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { ok: true } })); }); }).listen(0);
  const url = 'http://127.0.0.1:' + srv.address().port, logs = [];
  const feed = start({ dataDir: dir, getPayload: async () => ({ hello: 'world' }), everyMs: 1e9, log: (m) => logs.push(m) });
  await feed.tick(); assert.strictEqual(got.length, 0, 'does nothing until Portal Admin has written pocketbase.env');
  fs.writeFileSync(path.join(dir, 'pocketbase.env'), `POCKETBASE_PORTAL_URL="${url}/"\nPOCKETBASE_PORTAL_KEY=app-updater.abc\n`);
  await feed.tick(); assert.strictEqual(got.length, 1); assert.strictEqual(got[0][0], '/app-api/call'); assert.strictEqual(got[0][1], 'Bearer app-updater.abc');
  assert.deepStrictEqual(got[0][2], { fn: 'publishStatus', args: [{ hello: 'world' }] });
  assert.strictEqual(await feed.tick(), true, "tick reports a successful send"); srv.close(); assert.strictEqual(await feed.tick(), false, "and a failed one"); assert.strictEqual(logs.length, 1, 'a failure is logged once, never throws'); await feed.tick(); assert.strictEqual(logs.length, 1);
  feed.stop(); console.log('status-feed ok');
})().catch((e) => { console.error(e); process.exit(1); });
