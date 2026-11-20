'use strict';
const assert = require('assert'), makeAi = require('./ai');
// a tiny in-memory stand-in for the portal_settings collection
let rows = [], n = 0;
const asSuper = async (method, p, body) => {
  const id = (p.match(/records\/(\w+)/) || [])[1];
  if (method === 'GET') {
    const f = decodeURIComponent((p.match(/filter=([^&]*)/) || [])[1] || ''), g = (k) => (f.match(new RegExp(k + " = '([^']*)'")) || [])[1];
    const items = rows.filter((r) => r.scope === 'user' && r.user === g('user') && r.app === g('app') && (!g('key') || r.key === g('key')));
    return { items: items.map((r) => ({ ...r })) };
  }
  if (method === 'POST') { rows.push({ id: 'r' + ++n, ...body }); return {}; }
  if (method === 'PATCH') { Object.assign(rows.find((r) => r.id === id), body); return {}; }
  if (method === 'DELETE') { rows = rows.filter((r) => r.id !== id); return {}; }
};
let calls = [], reply = { ok: true, status: 200, json: async () => ({}) };
const ai = makeAi({ asSuper, fetchImpl: async (u, i) => { calls.push([u, JSON.parse(i.body), i.headers]); return reply; } });
const use = (app) => Object.fromEntries(rows.filter((r) => r.app === app && r.key.startsWith('pref.ai.')).map((r) => [r.key.slice(8), r.value]));
(async () => {
  // the first key saved becomes the default and is copied into the ordinary rows apps read
  let k1 = await ai.add('u1', { provider: 'anthropic', label: 'Work Claude', apiKey: 'sk-ant-AAAA1111' });
  assert.ok(!JSON.stringify(k1).includes('sk-ant')); assert.strictEqual(k1.last4, '1111'); assert.strictEqual(k1.model, 'claude-sonnet-5-5');
  assert.deepStrictEqual(use(''), { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-AAAA1111', keyId: k1.id });
  let k2 = await ai.add('u1', { provider: 'openai', model: 'gpt-x', apiKey: 'sk-OPEN2222' });
  assert.strictEqual(use('').keyId, k1.id, 'the second key does not take over the default');
  let st = await ai.state('u1'); assert.strictEqual(st.keys.length, 2); assert.strictEqual(st.defaultId, k1.id); assert.ok(!JSON.stringify(st).includes('sk-'));
  // choose a different key for one app: only that app's rows change, and an app's own row wins in the apps' own lookup
  await ai.select('u1', 'diner-bell', k2.id);
  assert.strictEqual(use('diner-bell').provider, 'openai'); assert.strictEqual(use('').provider, 'anthropic');
  assert.strictEqual((await ai.state('u1')).apps['diner-bell'], k2.id);
  await ai.select('u1', '', k2.id); assert.strictEqual(use('').apiKey, 'sk-OPEN2222');
  await assert.rejects(() => ai.select('u1', 'not-an-app', k2.id), /Unknown app/);
  // other people's keys are theirs alone
  assert.strictEqual((await ai.state('u2')).keys.length, 0); await assert.rejects(() => ai.select('u2', '', k1.id), /isn't saved/);
  // custom needs an address; every key needs a model and a key
  await assert.rejects(() => ai.add('u1', { provider: 'custom', model: 'm', apiKey: 'x', baseUrl: 'nope' }), /base address/);
  await assert.rejects(() => ai.add('u1', { provider: 'openai', apiKey: 'x' }), /model/); await assert.rejects(() => ai.add('u1', { provider: 'openai', model: 'm' }), /Paste/);
  // test() uses the right shape for each provider and explains failures
  assert.deepStrictEqual(await ai.test('u1', k1.id), { ok: true, message: 'Works.' }); assert.ok(calls[0][0].endsWith('/v1/messages') && calls[0][2]['x-api-key'] === 'sk-ant-AAAA1111');
  await ai.test('u1', k2.id); assert.ok(calls[1][0].endsWith('/chat/completions') && calls[1][2].authorization === 'Bearer sk-OPEN2222');
  reply = { ok: false, status: 401, json: async () => ({ error: { message: 'bad' } }) }; assert.match((await ai.test('u1', k1.id)).message, /refused/);
  // removing a key clears every place it was chosen
  await ai.remove('u1', k2.id); assert.deepStrictEqual(use('diner-bell'), {}); assert.deepStrictEqual(use(''), {}); assert.strictEqual((await ai.state('u1')).keys.length, 1);
  // an old single key (before the vault) moves in the first time the page is opened
  rows.push(...[['provider', 'gemini'], ['model', 'gemini-3.8-flash'], ['apiKey', 'AIzaOLD9999']].map(([k, v]) => ({ id: 'o' + ++n, scope: 'user', user: 'u3', app: '', key: 'pref.ai.' + k, value: v })));
  st = await ai.state('u3'); assert.strictEqual(st.keys.length, 1); assert.strictEqual(st.keys[0].last4, '9999'); assert.strictEqual(st.defaultId, st.keys[0].id);
  assert.strictEqual((await ai.state('u3')).keys.length, 1, 'migrating twice adds nothing');
  console.log('ai ok');
})().catch((e) => { console.error(e); process.exit(1); });
