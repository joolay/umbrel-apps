'use strict';
const assert = require('assert'), makeAi = require('./ai');
// a tiny in-memory stand-in for the portal_settings collection
let rows = [], n = 0;
const asSuper = async (method, p, body) => {
  const id = (p.match(/records\/(\w+)/) || [])[1];
  if (method === 'GET') {
    const f = decodeURIComponent((p.match(/filter=([^&]*)/) || [])[1] || ''), g = (k) => (f.match(new RegExp(k + " = '([^']*)'")) || [])[1];
    if (/scope = 'global'/.test(f)) return { items: rows.filter((r) => r.scope === 'global' && r.key === g('key')).map((r) => ({ ...r })) };
    const items = rows.filter((r) => r.scope === 'user' && r.user === g('user') && r.app === g('app') && (!g('key') || r.key === g('key')));
    return { items: items.map((r) => ({ ...r })) };
  }
  if (method === 'POST') { rows.push({ id: 'r' + ++n, ...body }); return {}; }
  if (method === 'PATCH') { Object.assign(rows.find((r) => r.id === id), body); return {}; }
  if (method === 'DELETE') { rows = rows.filter((r) => r.id !== id); return {}; }
};
let calls = [], reply = { ok: true, status: 200, json: async () => ({}) };
const HH = { id: 'fam1', owner: 'p1', members: [{ id: 'p1' }, { id: 'p2' }, { id: 'kid' }] };
const ai = makeAi({ asSuper, family: { householdOf: async (id) => (HH.members.some((m) => m.id === id) ? HH : null) }, fetchImpl: async (u, i) => { calls.push([u, i.body ? JSON.parse(i.body) : null, i.headers]); return reply; } });
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
  // Nvidia is a provider; the Master key is one global row, admin-set, never shown beyond its last four characters
  const kn = await ai.add('u1', { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', apiKey: 'nvapi-NNNN5555' }); assert.strictEqual(kn.last4, '5555');
  await assert.rejects(() => ai.select('u1', 'diner-bell', 'master'), /No Master key/);
  assert.strictEqual((await ai.state('u1')).master.set, false);
  let mv = await ai.setMaster({ provider: 'gemini', apiKey: 'AIzaMASTER7777' }); assert.strictEqual(mv.last4, '7777'); assert.strictEqual(mv.model, 'gemini-3.8-flash');
  assert.ok(!JSON.stringify(await ai.state('u2', false)).includes('7777') && !JSON.stringify(await ai.state('u2', false)).includes('AIza'), 'non-admins never see any part of it');
  assert.strictEqual((await ai.state('u2', true)).master.last4, '7777');
  mv = await ai.setMaster({ provider: 'gemini', model: 'gemini-x' }); assert.strictEqual(mv.model, 'gemini-x', 'saving without a key keeps the stored key');
  assert.strictEqual(rows.filter((r) => r.key === 'ai.master').length, 1);
  // a person with no key of their own gets the Master key; choosing "master" for an app copies no key into their rows
  assert.strictEqual((await ai.resolve('u9', 'diner-bell')).source, 'master');
  await ai.select('u9', 'diner-bell', 'master', 'gemini-pro-y');
  assert.deepStrictEqual(use('diner-bell'), { keyId: 'master', model: 'gemini-pro-y' }); assert.ok(!JSON.stringify(rows.filter((r) => r.user === 'u9')).includes('AIza'));
  let rr = await ai.resolve('u9', 'diner-bell'); assert.strictEqual(rr.model, 'gemini-pro-y'); assert.strictEqual(rr.apiKey, 'AIzaMASTER7777');
  assert.strictEqual((await ai.resolve('u9', 'jolly-grocer')).model, 'gemini-x', 'other apps keep the Master default');
  // a saved key with its own model for one app
  await ai.select('u1', 'shutterworth', kn.id, 'other/model'); rr = await ai.resolve('u1', 'shutterworth'); assert.deepStrictEqual([rr.source, rr.provider, rr.model], ['own', 'nvidia', 'other/model']);
  assert.strictEqual((await ai.state('u1')).appModels.shutterworth, 'other/model');
  // model lists come from the provider
  reply = { ok: true, status: 200, json: async () => ({ data: [{ id: 'models/b' }, { id: 'a' }, { id: 'a' }] }) };
  assert.deepStrictEqual((await ai.models('u1', { id: kn.id })).models, ['a', 'b']); assert.ok(calls[calls.length - 1][0].startsWith('https://integrate.api.nvidia.com/v1/models'));
  assert.deepStrictEqual((await ai.models('u1', { master: true })).models, ['a', 'b']);
  // Family sharing: a parent shares one of their keys; after a member's trial is over it becomes their default
  const pk = await ai.add('p1', { provider: 'anthropic', label: 'Dad Claude', model: 'claude-x', apiKey: 'sk-ant-PARENT1234' });
  await assert.rejects(() => ai.shareFamily('kid', 'Kid', true, pk.id), /parent|adult/); await assert.rejects(() => ai.shareFamily('u1', 'U1', false, kn.id), /family/);
  assert.strictEqual((await ai.resolve('kid', 'diner-bell', { trialOver: true })), null, 'trial over, nothing shared yet = nothing');
  assert.strictEqual((await ai.resolve('kid', 'diner-bell', { trialOver: false })).source, 'master', 'nothing shared: the Master key covers the trial');
  await ai.shareFamily('p1', 'Dad', false, pk.id, 'claude-fam');
  let fv = await ai.state('kid', false, true); assert.strictEqual(fv.family.shared.byName, 'Dad'); assert.strictEqual(fv.family.canShare, false); assert.ok(!JSON.stringify(fv).includes('PARENT1234'));
  assert.strictEqual((await ai.resolve('kid', 'diner-bell', { trialOver: false })).source, 'family', 'a shared family key replaces the free trial');
  rr = await ai.resolve('kid', 'diner-bell', { trialOver: true }); assert.deepStrictEqual([rr.source, rr.provider, rr.model, rr.apiKey, rr.sharedBy], ['family', 'anthropic', 'claude-fam', 'sk-ant-PARENT1234', 'Dad']);
  await ai.select('u1', '', kn.id); assert.strictEqual((await ai.resolve('u1', 'diner-bell', { trialOver: true })).source, 'own', 'a key of their own always wins');
  // a second adult cannot take over unless they manage; the sharer or a manager can stop it
  const pk2 = await ai.add('p2', { provider: 'openai', model: 'gpt-y', apiKey: 'sk-P2' });
  await assert.rejects(() => ai.shareFamily('p2', 'Mum', false, pk2.id), /already shares/);
  HH.members[1].manager = true; await ai.shareFamily('p2', 'Mum', false, pk2.id); assert.strictEqual((await ai.resolve('kid', 'jolly-grocer', { trialOver: true })).sharedBy, 'Mum');
  await ai.unshareFamily('p1'); assert.strictEqual((await ai.resolve('kid', 'jolly-grocer', { trialOver: true })), null);
  // removing the shared key, or the sharer leaving, ends the sharing
  await ai.shareFamily('p1', 'Dad', false, pk.id); await ai.remove('p1', pk.id); assert.strictEqual(await ai.resolve('kid', 'diner-bell', { trialOver: true }), null);
  await ai.shareFamily('p2', 'Mum', false, pk2.id); HH.members = HH.members.filter((m) => m.id !== 'p2'); assert.strictEqual(await ai.resolve('kid', 'diner-bell', { trialOver: true }), null); HH.members.push({ id: 'p2' });
  // Usage: one row per month per person; a parent sees the household, a child sees only their own
  await ai.logUsage('kid', 'diner-bell', { source: 'family', inTokens: 100, outTokens: 50 }); await ai.logUsage('kid', 'jolly-grocer', { source: 'family' }); await ai.logUsage('p1', 'diner-bell', { source: 'own' });
  await assert.rejects(async () => { throw new Error('x'); }); assert.strictEqual(await ai.logUsage('kid', 'not-an-app', {}), null);
  let us = await ai.usage('kid', true); assert.strictEqual(us.mine.calls, 2); assert.deepStrictEqual(us.mine.byApp, { 'diner-bell': 1, 'jolly-grocer': 1 }); assert.strictEqual(us.mine.inTokens, 100); assert.strictEqual(us.family, null, 'a child never sees the others');
  us = await ai.usage('p1', false); assert.strictEqual(us.mine.calls, 1); assert.strictEqual(us.mine.bySource.own, 1); assert.strictEqual(us.family.find((x) => x.id === 'kid').usage.calls, 2); assert.ok(!us.family.some((x) => x.id === 'p1'));
  assert.strictEqual((await ai.usage('p1', false, '1999-01')).month, us.months[0], 'only the last six months');
  assert.strictEqual((await ai.usage('u9', false)).family, null, 'someone with no household sees only their own');
  await ai.clearMaster(); assert.strictEqual(await ai.resolve('u9', 'jolly-grocer'), null, 'no Master key and no own key = nothing to use');
  console.log('ai ok');
})().catch((e) => { console.error(e); process.exit(1); });
