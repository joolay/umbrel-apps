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
  nvidia: { label: 'NVIDIA (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1', model: '' },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '' },
};
// Apps that use a person's AI key. Their slug is the store id without "joolay-".
const AI_APPS = { 'diner-bell': 'Diner Bell', 'jolly-grocer': 'Jolly Grocer', listify: 'ListSnap', shutterworth: 'ShutterWorth', 'project-tracker': 'Project Pilot' };
const FIELDS = ['provider', 'model', 'apiKey', 'baseUrl', 'keyId'];
const MAX_KEYS = 12;
const MASTER = 'ai.master';   // ONE global row (scope global, secret): the owner's Master key, the default for everyone without a key of their own and for trial users

const q = (s) => encodeURIComponent(s), esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
class AiError extends Error { constructor(status, message) { super(message); this.status = status; } }

module.exports = function makeAi({ asSuper, fetchImpl = fetch, family = { householdOf: async () => null } }) {
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

  async function state(userId, isAdmin, isMinor) {
    const [vault, base] = await Promise.all([rows(userId, VAULT), rows(userId, '')]);
    const had = vaultKeys(vault), keys = await migrate(userId, had, base);
    const def = ((keys.length && !had.length ? await rows(userId, '') : base).find((r) => r.key === 'pref.ai.keyId') || {}).value || '';
    const apps = {};
    for (const slug of Object.keys(AI_APPS)) { const r = (await rows(userId, slug)).find((x) => x.key === 'pref.ai.keyId'); apps[slug] = r && (r.value === 'master' || keys.some((k) => k.id === r.value)) ? r.value : ''; }
    const mv = await masterView(!!isAdmin), appModels = {};
    for (const slug of Object.keys(AI_APPS)) { const r = (await rows(userId, slug)).find((x) => x.key === 'pref.ai.model'); appModels[slug] = r && apps[slug] ? String(r.value || '') : ''; }
    return { keys: keys.map(view), defaultId: def === 'master' || keys.some((k) => k.id === def) ? def : '', apps, appModels, master: mv, family: await familyView(userId, !!isMinor), appNames: AI_APPS, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, model: v.model }])) };
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
    const sh = await familyShared(userId).catch(() => null); if (sh && sh.by === userId && sh.key.id === k.id) await asSuper('DELETE', `${COL}/${sh.row.id}`);
    await asSuper('DELETE', `${COL}/${k._row}`);
    const base = await rows(userId, '');
    if ((base.find((r) => r.key === 'pref.ai.keyId') || {}).value === k.id) await writeUse(userId, '', null);
    for (const slug of Object.keys(AI_APPS)) { const r = (await rows(userId, slug)).find((x) => x.key === 'pref.ai.keyId'); if (r && r.value === k.id) await writeUse(userId, slug, null); }
    return null;
  }
  // appSlug '' = the default for every app; keyId '' = no choice (the app then uses the Master key); keyId 'master' = the Master key with a model of the person's choosing.
  // `model` (optional) overrides the saved key's model for that app only. The Master key itself is never copied into a person's rows: the app asks Portal Admin for it (resolve).
  async function select(userId, appSlug, keyId, model) {
    appSlug = clean(appSlug, 40); if (appSlug && !AI_APPS[appSlug]) throw new AiError(400, 'Unknown app.');
    model = clean(model, 120);
    if (!keyId) { await writeUse(userId, appSlug, null); return null; }
    if (keyId === 'master') {
      const m = await masterRow(); if (!m) throw new AiError(400, 'No Master key is set yet.');
      for (const f of FIELDS) await put(userId, appSlug, 'pref.ai.' + f, f === 'keyId' ? 'master' : f === 'model' ? model : '');
      return null;
    }
    const k = await find(userId, keyId); await writeUse(userId, appSlug, model ? { ...k, model } : k); return null;
  }

  // ---- The Master key: set by an admin only (checked in server.js), never sent to a browser except its last four characters (admins) ----
  const masterRow = async () => ((await asSuper('GET', `${COL}?page=1&perPage=1&filter=${q(`scope = 'global' && key = '${MASTER}'`)}`)).items || [])[0] || null;
  async function masterView(isAdmin) {
    const r = await masterRow(), v = r && r.value; if (!v || !v.apiKey && v.provider !== 'custom') return { set: false };
    return { set: true, provider: v.provider, providerLabel: (PROVIDERS[v.provider] || {}).label || v.provider, model: v.model, ...(isAdmin ? { last4: v.apiKey ? v.apiKey.slice(-4) : '', baseUrl: v.baseUrl || '' } : {}) };
  }
  async function setMaster(b) {
    const provider = clean(b.provider, 20), p = PROVIDERS[provider]; if (!p) throw new AiError(400, 'Pick a provider.');
    const ex = await masterRow(), old = (ex && ex.value) || {};
    const apiKey = clean(b.apiKey, 400) || (old.provider === provider ? old.apiKey : ''), model = clean(b.model, 120) || p.model, baseUrl = provider === 'custom' ? clean(b.baseUrl, 300) : '';
    if (!apiKey && provider !== 'custom') throw new AiError(400, 'Paste the API key.');
    if (!model) throw new AiError(400, 'Choose the model the Master key should use.');
    if (provider === 'custom' && !/^https?:\/\//i.test(baseUrl)) throw new AiError(400, 'Enter the base address, starting with http:// or https://');
    const value = { provider, model, apiKey, baseUrl };
    if (ex) await asSuper('PATCH', `${COL}/${ex.id}`, { value, secret: true });
    else await asSuper('POST', COL, { scope: 'global', user: '', app: '', key: MASTER, value, secret: true, note: 'Master AI key (default and free trial)' });
    return masterView(true);
  }
  async function clearMaster() { const ex = await masterRow(); if (ex) await asSuper('DELETE', `${COL}/${ex.id}`); return { set: false }; }

  // ---- Family sharing: an adult in a household shares one of their own saved keys with the whole household. ----
  // Stored as ONE global row per family (`ai.family.<familyId>`, secret): { by, byName, keyId, model }. The key itself stays in the sharer's vault (never copied),
  // so removing it, or the sharer leaving the family, ends the sharing by itself. Once shared, it replaces the free trial for the whole household.
  const famKey = (hh) => 'ai.family.' + String(hh.id).replace(/[^A-Za-z0-9]/g, '');
  const famRow = async (hh) => ((await asSuper('GET', `${COL}?page=1&perPage=1&filter=${q(`scope = 'global' && key = '${famKey(hh)}'`)}`)).items || [])[0] || null;
  const manages = (hh, userId) => hh.owner === userId || !!(hh.members || []).find((m) => m.id === userId && m.manager);
  async function familyShared(userId) {   // the live share for this person's household, or null
    const hh = await family.householdOf(userId).catch(() => null); if (!hh) return null;
    const r = await famRow(hh), v = r && r.value; if (!v || !(hh.members || []).some((m) => m.id === v.by)) return null;
    const k = await find(v.by, v.keyId).catch(() => null); if (!k) return null;
    return { hh, by: v.by, byName: v.byName || '', key: k, model: v.model || k.model, row: r };
  }
  async function familyView(userId, isMinor) {
    const hh = await family.householdOf(userId).catch(() => null); if (!hh) return { inFamily: false };
    const sh = await familyShared(userId);
    return { inFamily: true, canShare: !isMinor, canStop: !!sh && (sh.by === userId || manages(hh, userId)),
      shared: sh ? { byName: sh.byName, mine: sh.by === userId, label: sh.key.label, provider: sh.key.provider, providerLabel: (PROVIDERS[sh.key.provider] || {}).label || sh.key.provider, model: sh.model } : null };
  }
  async function shareFamily(userId, userName, isMinor, keyId, model) {
    const hh = await family.householdOf(userId).catch(() => null); if (!hh) throw new AiError(400, 'Create or join a family first.');
    if (isMinor) throw new AiError(403, 'Only a parent or another adult can share a key with the family.');
    const k = await find(userId, keyId), cur = await familyShared(userId);
    if (cur && cur.by !== userId && !manages(hh, userId)) throw new AiError(403, cur.byName + ' already shares a key with the family. Only the family creator or a manager can replace it.');
    const value = { by: userId, byName: clean(userName, 80), keyId: k.id, model: clean(model, 120) || k.model };
    const ex = await famRow(hh);
    if (ex) await asSuper('PATCH', `${COL}/${ex.id}`, { value, secret: true });
    else await asSuper('POST', COL, { scope: 'global', user: '', app: '', key: famKey(hh), value, secret: true, note: 'AI key a parent shares with the family' });
    return null;
  }
  async function unshareFamily(userId) {
    const sh = await familyShared(userId); if (!sh) return null;
    if (sh.by !== userId && !manages(sh.hh, userId)) throw new AiError(403, 'Only the person who shared it, or the family creator or a manager, can stop sharing.');
    await asSuper('DELETE', `${COL}/${sh.row.id}`); return null;
  }

  // What an app should really use for one person (server to server only). Order: the person's own key (app choice, then default) -> the key a parent shares with the household
  // (the free trial no longer applies once one is shared) -> the Master key while their free trial lasts. `trialOver` comes from the app, which owns the trial limit. null = nothing usable.
  async function resolve(userId, appSlug, { trialOver = false } = {}) {
    const m = await masterRow(), master = m && m.value && (m.value.apiKey || m.value.provider === 'custom') ? m.value : null;
    const famCfg = async () => { const f = await familyShared(userId); return f ? { source: 'family', provider: f.key.provider, model: f.model, apiKey: f.key.apiKey || '', baseUrl: f.key.provider === 'custom' ? f.key.baseUrl || '' : '', sharedBy: f.byName } : null; };
    for (const app of [clean(appSlug, 40), '']) {
      const o = {}; for (const r of await rows(userId, app)) if (r.key.startsWith('pref.ai.')) o[r.key.slice(8)] = r.value;
      if (o.keyId === 'master') { if (master && !trialOver && !(await familyShared(userId))) return { source: 'master', ...master, model: o.model || master.model }; continue; }   // a shared family key replaces the trial, so it wins over this choice
      if (o.provider && PROVIDERS[o.provider] && (o.apiKey || o.provider === 'custom')) return { source: 'own', provider: o.provider, model: o.model, apiKey: o.apiKey || '', baseUrl: o.baseUrl || '' };
    }
    const fam = await famCfg(); if (fam) return fam;
    if (master && !trialOver) return { source: 'master', ...master };
    return null;
  }

  // The models a key can use, asked from the provider itself (the Master key is listed with { master: true }).
  async function models(userId, { id, master }) {
    const k = master ? ((await masterRow()) || {}).value : await find(userId, id); if (!k) throw new AiError(404, "That key isn't saved.");
    const p = PROVIDERS[k.provider], base = (k.provider === 'custom' ? k.baseUrl : p.baseUrl).replace(/\/+$/, '');
    const r = await fetchImpl(k.provider === 'anthropic' ? base + '/v1/models?limit=100' : base + '/models', { headers: k.provider === 'anthropic' ? { 'x-api-key': k.apiKey, 'anthropic-version': '2023-06-01' } : (k.apiKey ? { authorization: 'Bearer ' + k.apiKey } : {}), signal: AbortSignal.timeout(20000) }).catch((e) => { throw new AiError(502, "Couldn't reach " + p.label + ' (' + (e.cause?.code || e.message) + ').'); });
    if (!r.ok) throw new AiError(502, r.status === 401 || r.status === 403 ? 'The provider refused this key.' : 'The provider answered ' + r.status + '.');
    const j = await r.json().catch(() => ({})), list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
    const ids = [...new Set(list.map((m) => String((m && (m.id || m.name)) || '').replace(/^models\//, '')).filter(Boolean))].sort().slice(0, 400);
    return { models: ids, current: k.model };
  }

  // One tiny request to prove the key, model and address work.
  async function test(userId, id, master) {
    const k = master ? ((await masterRow()) || {}).value : await find(userId, id); if (!k) throw new AiError(404, "That key isn't saved.");
    const p = PROVIDERS[k.provider], base = (k.provider === 'custom' ? k.baseUrl : p.baseUrl).replace(/\/+$/, '');
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

  // ---- Usage: one row per person per month (`ai.usage.YYYY-MM`, app 'ai-usage'): calls, tokens when the app knows them, and splits by app and by key source ----
  const USAGE = 'ai-usage', monthOf = (d) => (d || new Date()).toISOString().slice(0, 7), num = (v) => Math.max(0, Math.min(1e9, Math.floor(+v) || 0));
  const emptyUse = () => ({ calls: 0, inTokens: 0, outTokens: 0, byApp: {}, bySource: {} });
  async function usageOf(userId, m) { const r = (await rows(userId, USAGE)).find((x) => x.key === 'ai.usage.' + m); return { ...emptyUse(), ...((r && r.value) || {}) }; }
  async function logUsage(userId, app, b) {
    if (!userId || !AI_APPS[app]) return null; b = b || {};
    const m = monthOf(), v = await usageOf(userId, m), src = ['own', 'master', 'family'].includes(b.source) ? b.source : 'own';
    v.calls += 1; v.inTokens += num(b.inTokens); v.outTokens += num(b.outTokens); v.byApp[app] = (v.byApp[app] || 0) + 1; v.bySource[src] = (v.bySource[src] || 0) + 1;
    await put(userId, USAGE, 'ai.usage.' + m, v); return null;
  }
  // A person sees their own months. A parent (an adult in the household) also sees every household member's.
  async function usage(userId, isMinor, m) {
    const now = new Date(), months = Array.from({ length: 6 }, (_, i) => monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    m = months.includes(m) ? m : months[0];
    const out = { month: m, months, mine: await usageOf(userId, m), family: null };
    const hh = isMinor ? null : await family.householdOf(userId).catch(() => null);
    if (hh) out.family = await Promise.all((hh.members || []).filter((x) => x.id !== userId).map(async (x) => ({ id: x.id, name: x.name || '', usage: await usageOf(x.id, m) })));
    return out;
  }

  // What an app's own Settings screen may do for the signed-in person (the app vouches for who they are): see their keys and choose for THIS app only.
  async function forApp(what, app, args) {
    const userId = String(args[0] || ''); if (!userId || !AI_APPS[app]) throw new AiError(400, 'This app does not use AI keys.');
    if (what === 'mine') {
      const st = await state(userId, false, false);
      return { keys: st.keys, defaultId: st.defaultId, choice: st.apps[app] || '', model: st.appModels[app] || '', master: st.master, family: st.family, providers: st.providers };
    }
    if (what === 'log') return logUsage(userId, app, args[1]);
    if (what === 'choose') { await select(userId, app, String(args[1] || ''), String(args[2] || '')); return null; }
    if (what === 'models') return models(userId, args[1] === 'master' ? { master: true } : { id: String(args[1] || '') });
    throw new AiError(404, 'Unknown function ai.' + what);
  }
  return { forApp, logUsage, usage, state, add, remove, select, test, shareFamily, unshareFamily, familyShared, setMaster, clearMaster, masterView, resolve, models, AiError, AI_APPS, PROVIDERS };
};
module.exports.AI_APPS = AI_APPS;
