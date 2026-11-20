'use strict';
// A person's AI keys. Everyone can save several keys (Anthropic, OpenAI, Gemini, OpenRouter, a custom OpenAI-compatible address), pick a default,
// and pick a different one for a single app. The saved keys live in a "vault": portal_settings rows with app = 'ai-vault', which no app can read.
// Choosing a key copies just that key into the ordinary "pref.ai.*" rows the apps already read: app = '' for the default, app = '<slug>' for one app
// (an app's own row wins over the default). So every AI app follows the choice without being changed. Nothing here ever sends a key to a browser
// except the last four characters.
const crypto = require('crypto');

const VAULT = 'ai-vault', PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '' },
};
// Apps that use a person's AI key. Their slug is the store id without "joolay-".
const AI_APPS = { 'diner-bell': 'Diner Bell', 'jolly-grocer': 'Jolly Grocer', listify: 'ListSnap', shutterworth: 'ShutterWorth', 'project-tracker': 'Project Pilot' };
const FIELDS = ['provider', 'model', 'apiKey', 'baseUrl', 'keyId'];
const MAX_KEYS = 12;

const q = (s) => encodeURIComponent(s), esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
class AiError extends Error { constructor(status, message) { super(message); this.status = status; } }

module.exports = function makeAi({ asSuper, fetchImpl = fetch }) {
  const COL = '/api/collections/portal_settings/records';
  const rows = async (userId, app) => {
    const f = `scope = 'user' && user = '${esc(userId)}' && app = '${esc(app)}'`;
    const out = []; for (let page = 1; page <= 5; page++) { const j = await asSuper('GET', `${COL}?page=${page}&perPage=100&filter=${q(f)}`); out.push(...(j.items || [])); if (!j.items || j.items.length < 100) break; }
    return out;
  };
  const put = async (userId, app, key, value) => {
    const f = `scope = 'user' && user = '${esc(userId)}' && app = '${esc(app)}' && key = '${esc(key)}'`;
    const ex = ((await asSuper('GET', `${COL}?page=1&perPage=1&filter=${q(f)}`)).items || [])[0];
    if (value === '' || value == null) { if (ex) await asSuper('DELETE', `${COL}/${ex.id}`); return; }
    if (ex) { if (JSON.stringify(ex.value) !== JSON.stringify(value)) await asSuper('PATCH', `${COL}/${ex.id}`, { value }); }
    else await asSuper('POST', COL, { scope: 'user', user: userId, app, key, value, secret: false });
  };
  const writeUse = async (userId, app, k) => {   // app '' = the default for every app
    const v = k ? { provider: k.provider, model: k.model, apiKey: k.apiKey, baseUrl: k.provider === 'custom' ? k.baseUrl : '', keyId: k.id } : {};
    for (const f of FIELDS) await put(userId, app, 'pref.ai.' + f, v[f] || '');
  };
  const view = (k) => ({ id: k.id, label: k.label, provider: k.provider, model: k.model, baseUrl: k.baseUrl || '', last4: k.apiKey ? k.apiKey.slice(-4) : '' });
  const vaultKeys = (list) => list.filter((r) => r.key.startsWith('ai.key.') && r.value && typeof r.value === 'object').map((r) => ({ ...r.value, id: r.key.slice(7), _row: r.id }));

  // Before this existed a person had one key in the ordinary rows. The first time they open the page it moves into the vault and stays their default.
  async function migrate(userId, keys, base) {
    if (keys.length) return keys;
    const o = {}; for (const r of base) if (r.key.startsWith('pref.ai.')) o[r.key.slice(8)] = r.value;
    if (typeof o.apiKey !== 'string' || !o.apiKey.trim() || !PROVIDERS[o.provider]) return keys;
    const k = { id: newId(), label: 'My key', provider: o.provider, model: clean(o.model, 120), apiKey: o.apiKey.trim(), baseUrl: clean(o.baseUrl, 300) };
    await put(userId, VAULT, 'ai.key.' + k.id, { label: k.label, provider: k.provider, model: k.model, apiKey: k.apiKey, baseUrl: k.baseUrl });
    await put(userId, '', 'pref.ai.keyId', k.id);
    return [k];
  }
  const newId = () => crypto.randomBytes(5).toString('hex');

  async function state(userId) {
    const [vault, base] = await Promise.all([rows(userId, VAULT), rows(userId, '')]);
    const had = vaultKeys(vault), keys = await migrate(userId, had, base);
    const def = ((keys.length && !had.length ? await rows(userId, '') : base).find((r) => r.key === 'pref.ai.keyId') || {}).value || '';
    const apps = {};
    for (const slug of Object.keys(AI_APPS)) { const r = (await rows(userId, slug)).find((x) => x.key === 'pref.ai.keyId'); apps[slug] = r && keys.some((k) => k.id === r.value) ? r.value : ''; }
    return { keys: keys.map(view), defaultId: keys.some((k) => k.id === def) ? def : '', apps, appNames: AI_APPS, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, model: v.model }])) };
  }
  async function find(userId, id) {
    const r = (await rows(userId, VAULT)).find((x) => x.key === 'ai.key.' + clean(id, 20)); if (!r || !r.value) throw new AiError(404, "That key isn't saved.");
    return { ...r.value, id: r.key.slice(7), _row: r.id };
  }

  async function add(userId, b) {
    const provider = clean(b.provider, 20), p = PROVIDERS[provider]; if (!p) throw new AiError(400, 'Pick a provider.');
    const apiKey = clean(b.apiKey, 400), model = clean(b.model, 120) || p.model, baseUrl = provider === 'custom' ? clean(b.baseUrl, 300) : '';
    if (!apiKey && provider !== 'custom') throw new AiError(400, 'Paste the API key.');
    if (!model) throw new AiError(400, 'Enter the model to use.');
    if (provider === 'custom' && !/^https?:\/\//i.test(baseUrl)) throw new AiError(400, 'Enter the base address, starting with http:// or https://');
    const have = vaultKeys(await rows(userId, VAULT)); if (have.length >= MAX_KEYS) throw new AiError(400, 'You can save up to ' + MAX_KEYS + ' keys. Remove one first.');
    const k = { id: newId(), label: clean(b.label, 40) || p.label, provider, model, apiKey, baseUrl };
    await put(userId, VAULT, 'ai.key.' + k.id, { label: k.label, provider, model, apiKey, baseUrl });
    if (!have.length) { await writeUse(userId, '', k); }   // the first key becomes the default straight away
    return view(k);
  }
  async function remove(userId, id) {
    const k = await find(userId, id);
    await asSuper('DELETE', `${COL}/${k._row}`);
    const base = await rows(userId, '');
    if ((base.find((r) => r.key === 'pref.ai.keyId') || {}).value === k.id) await writeUse(userId, '', null);
    for (const slug of Object.keys(AI_APPS)) { const r = (await rows(userId, slug)).find((x) => x.key === 'pref.ai.keyId'); if (r && r.value === k.id) await writeUse(userId, slug, null); }
    return null;
  }
  // appSlug '' = the default for every app; keyId '' = no choice (an app then uses its shared key, if the admin set one).
  async function select(userId, appSlug, keyId) {
    appSlug = clean(appSlug, 40); if (appSlug && !AI_APPS[appSlug]) throw new AiError(400, 'Unknown app.');
    if (!keyId) { await writeUse(userId, appSlug, null); return null; }
    await writeUse(userId, appSlug, await find(userId, keyId)); return null;
  }

  // One tiny request to prove the key, model and address work.
  async function test(userId, id) {
    const k = await find(userId, id), p = PROVIDERS[k.provider], base = (k.provider === 'custom' ? k.baseUrl : p.baseUrl).replace(/\/+$/, '');
    let r;
    try {
      r = k.provider === 'anthropic'
        ? await fetchImpl(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: k.model, max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }), signal: AbortSignal.timeout(20000) })
        : await fetchImpl(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(k.apiKey ? { authorization: 'Bearer ' + k.apiKey } : {}) }, body: JSON.stringify({ model: k.model, max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }), signal: AbortSignal.timeout(20000) });
    } catch (e) { return { ok: false, message: "Couldn't reach " + p.label + ' (' + (e.cause?.code || e.message) + ').' }; }
    if (r.ok) return { ok: true, message: 'Works.' };
    const j = await r.json().catch(() => ({})), why = (j.error && (j.error.message || j.error)) || '';
    return { ok: false, message: r.status === 401 || r.status === 403 ? 'The provider refused this key.' : r.status === 404 ? 'The provider does not know that model or address.' : 'The provider answered ' + r.status + (why ? ': ' + String(why).slice(0, 160) : '') + '.' };
  }

  return { state, add, remove, select, test, AiError, AI_APPS, PROVIDERS };
};
module.exports.AI_APPS = AI_APPS;
