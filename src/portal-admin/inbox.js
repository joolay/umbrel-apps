'use strict';
// Change inbox: small, declarative change files that Claude (or you) add to `portal-changes/` on the main branch of your own repo.
// They show up in Portal Admin > Changes next to the built-in changes, with the same plain-English plan and the same Apply button.
//  - Nothing is ever executed: a file is only data ({ id, title, summary, ops: [...] }) and only the few operations below exist.
//  - Only this one repo and folder are read (api.github.com / raw.githubusercontent.com), read-only, a size limit on everything.
//  - Nothing happens until an admin presses Apply. If GitHub can't be reached the inbox is simply empty.
// Operations (more need a Portal Admin release, on purpose):
//   { "op": "setting",        "key": "portal.url", "value": "https://...", "note": "optional" }   set a global (non-secret) setting
//   { "op": "delete-setting", "key": "some.key" }                                                  remove a global setting
const REPO = process.env.INBOX_REPO || 'joolay/umbrel-apps', DIR = 'portal-changes', BRANCH = 'main';
const API = process.env.INBOX_API || 'https://api.github.com', RAW = process.env.INBOX_RAW || 'https://raw.githubusercontent.com';
const KEY = /^[a-z][a-z0-9._-]{0,63}$/, ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i, MAX_FILES = 30, MAX_BYTES = 20000, TTL = 60000;

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return '"' + (s.length > 120 ? s.slice(0, 117) + '…' : s) + '"'; };

// Checks one file's shape. Anything unexpected throws, and the file is shown as a problem instead of being applied.
function validate(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('not a change file');
  if (!ID.test(String(f.id || ''))) throw bad('missing or invalid id');
  if (typeof f.title !== 'string' || !f.title.trim() || f.title.length > 120) throw bad('missing title');
  if (f.summary != null && (typeof f.summary !== 'string' || f.summary.length > 600)) throw bad('summary too long');
  if (!Array.isArray(f.ops) || !f.ops.length || f.ops.length > 20) throw bad('needs 1 to 20 operations');
  for (const o of f.ops) {
    if (!o || typeof o !== 'object') throw bad('bad operation');
    if (o.op !== 'setting' && o.op !== 'delete-setting') throw bad('unknown operation "' + String(o.op).slice(0, 30) + '" (needs a newer Portal Admin)');
    if (!KEY.test(String(o.key || ''))) throw bad('invalid setting key');
    if (/^secret\./.test(o.key)) throw bad('secret settings are never changed from the inbox');
    if (o.op === 'setting') {
      const t = typeof o.value;
      if (!(t === 'string' || t === 'number' || t === 'boolean' || (t === 'object' && o.value !== null))) throw bad('invalid value for ' + o.key);
      if (JSON.stringify(o.value).length > 2000) throw bad('value too long for ' + o.key);
      if (o.note != null && (typeof o.note !== 'string' || o.note.length > 200)) throw bad('note too long');
      if (/^portal\.url$/.test(o.key) && !(t === 'string' && /^https?:\/\/[^\s/]+[^\s]*$/i.test(o.value) && !/\/+$/.test(o.value) && !o.value.includes('#'))) throw bad('portal.url must be an http(s) address with no trailing slash and no #');
    }
  }
  return f;
}

module.exports = function makeInbox(ctx) {
  let cache = { at: 0, files: [] };
  async function get(url, asJson) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'portal-admin-inbox', accept: asJson ? 'application/vnd.github+json' : 'text/plain' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text(); if (txt.length > MAX_BYTES * 4) throw new Error('too large');
      return asJson ? JSON.parse(txt) : txt;
    } finally { clearTimeout(t); }
  }
  async function fetchFiles() {
    if (Date.now() - cache.at < TTL) return cache.files;
    let files = [];
    try {
      const list = await get(`${API}/repos/${REPO}/contents/${DIR}?ref=${BRANCH}`, true);
      const names = (Array.isArray(list) ? list : []).filter((x) => x && x.type === 'file' && /^[\w.-]{1,80}\.json$/.test(x.name) && x.size <= MAX_BYTES).map((x) => x.name).sort().slice(-MAX_FILES);
      files = await Promise.all(names.map(async (n) => {
        try { return { name: n, data: JSON.parse(await get(`${RAW}/${REPO}/${BRANCH}/${DIR}/${n}`, false)) }; }
        catch (e) { return { name: n, error: 'could not be read (' + e.message + ')' }; }
      }));
    } catch (e) { if (!/HTTP 404/.test(e.message)) console.warn('[inbox] ' + e.message); files = []; }   // no folder yet, or GitHub unreachable: empty inbox
    cache = { at: Date.now(), files }; return files;
  }

  // Current global setting rows by key (non-secret), looked up one at a time so the filter stays simple.
  async function row(key) {
    const j = await ctx.pb('GET', `/api/collections/portal_settings/records?page=1&perPage=1&filter=${encodeURIComponent(`scope = 'global' && key = '${ctx.esc(key)}'`)}`);
    return (j.items || [])[0] || null;
  }
  const typeOf = (v) => (v !== null && typeof v === 'object') ? 'json' : typeof v;

  const toSet = (f, source) => ({
    id: 'inbox:' + f.id, inbox: true,
    title: f.title, summary: (f.summary ? f.summary + ' ' : '') + `(From your repo inbox: ${source}.)`,
    async plan(c) {
      const out = [];
      for (const o of f.ops) {
        const r = await row(o.key);
        if (o.op === 'setting') {
          if (!r) out.push(`Add setting ${o.key} = ${show(o.value)}`);
          else if (!same(r.value, o.value)) out.push(`Change setting ${o.key} from ${show(r.value)} to ${show(o.value)}`);
        } else if (r) out.push(`Remove setting ${o.key}`);
      }
      return out;
    },
    async apply() {
      for (const o of f.ops) {
        const r = await row(o.key);
        if (o.op === 'setting') {
          if (!r) await ctx.pb('POST', '/api/collections/portal_settings/records', { scope: 'global', app: '', user: '', key: o.key, value: o.value, secret: false, note: o.note || '' });
          else if (!same(r.value, o.value)) await ctx.pb('PATCH', `/api/collections/portal_settings/records/${r.id}`, { value: o.value, ...(o.note ? { note: o.note } : {}) });
        } else if (r) await ctx.pb('DELETE', `/api/collections/portal_settings/records/${r.id}`);
      }
      return [];
    },
  });
  // A broken file is listed as a problem, never applied.
  const broken = (name, why) => ({ id: 'inbox:' + name.replace(/\.json$/, ''), inbox: true, title: name, summary: '(From your repo inbox.)', async plan() { throw new Error('This file is not a valid change: ' + why); }, async apply() { throw new Error('Not a valid change.'); } });

  return {
    // Every inbox file as a change, oldest first. Two files with the same id: the first one wins.
    async load() {
      const out = [], seen = new Set();
      for (const f of await fetchFiles()) {
        if (f.error) { out.push(broken(f.name, f.error)); continue; }
        try { const v = validate(f.data); if (seen.has(v.id)) continue; seen.add(v.id); out.push(toSet(v, DIR + '/' + f.name)); }
        catch (e) { out.push(broken(f.name, e.message)); }
      }
      return out;
    },
    validate, refresh() { cache = { at: 0, files: [] }; },
  };
};
module.exports.validate = validate;
