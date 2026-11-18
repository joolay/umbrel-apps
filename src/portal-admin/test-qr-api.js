// The Portal API exposes only qr.start and qr.poll to apps, answers with the calling app's identity, and the Portal route list includes /qr.
'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const makeAppApi = require('./appapi'), qrlogin = require('./qrlogin')();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); });
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const api = makeAppApi({ qrlogin, pbx: { creds: () => ({}), url: () => '', userFromToken: async () => null }, DATA_DIR: dir, readBody, send });
const key = api.keys.issue('joolztv'), other = api.keys.issue('stremio');
const srv = http.createServer((q, r) => api.handle(q, r)).listen(0, async () => {
  const call = async (k, fn, args) => { const r = await fetch('http://127.0.0.1:' + srv.address().port + '/app-api/call', { method: 'POST', headers: { authorization: 'Bearer ' + k }, body: JSON.stringify({ fn, args }) }); return r.json(); };
  assert(api.allowed.includes('qr.start') && api.allowed.includes('qr.poll') && !api.allowed.includes('qr.decide') && !api.allowed.includes('qr.info'), 'apps can only start and poll');
  const s = await call(key, 'qr.start', [{ label: 'TV' }]); assert(s.ok && s.result.id && s.result.secret, 'start works with an app key');
  let p = await call(key, 'qr.poll', [s.result.id, s.result.secret]); assert.strictEqual(p.result.status, 'pending');
  p = await call(other, 'qr.poll', [s.result.id, s.result.secret]); assert.strictEqual(p.result.status, 'expired', 'another app cannot poll it');
  assert.strictEqual((await call(key, 'qr.decide', [s.result.id])).ok, false, 'apps cannot approve for the person');
  qrlogin.decide(s.result.id, { id: 'abc123abc123abc' }, true);
  p = await call(key, 'qr.poll', [s.result.id, s.result.secret]); assert.deepStrictEqual(p.result, { status: 'approved', userId: 'abc123abc123abc' });
  assert((await call('bad.key', 'qr.start', [])).message === 'Unknown app key.');
  assert(require('./portal').VIA_ADMIN.includes('/qr'), 'the Portal passes /qr on');
  console.log('ALL PASSED'); srv.close(); process.exit(0);
});
