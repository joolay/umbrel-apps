'use strict';
// Status feed: an outward-only way for apps to let the owner (and Claude, who can read the GitHub repo) see how they are doing, without exposing anything.
// An app calls Portal API `publishStatus(payload)` (App Updater: update results and log, Services Manager: containers and problems, any future app the same way).
// Portal Admin cleans the payload (passwords, tokens, keys and long secret-looking strings are replaced, sizes are capped) and writes it to
// <dir>/<app>.json in a GitHub repo the admin chose, using a GitHub token that is stored here once (portal_settings row, secret, admin only, never sent back).
// The feed is one-way: nothing reads it back into the apps and nothing in it can change anything.
const crypto = require('crypto');

const SET = '/api/collections/portal_settings/records', APP = 'status-feed', KEY = 'secret.config';
const MIN_GAP = 30e3, HEARTBEAT = 30 * 60e3, MAX_BYTES = 150 * 1024;
const q = encodeURIComponent, esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const SECRET_KEY = /passw|secret|token|cookie|authori[sz]ation|api.?key|bearer|credential|totp/i;
class FeedError extends Error { constructor(status, message) { super(message); this.status = status; } }

function redact(s) {
  return String(s)
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[hidden]')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, '[hidden]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,})/g, '[hidden]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hidden]')
    .replace(/((?:passw\w*|token|secret|api.?key)\s*[=:]\s*)[^\s&"',;]+/gi, '$1[hidden]');
}
// Copy of the payload that is safe to publish: secret-looking keys hidden, strings redacted and trimmed, lists and depth capped.
function clean(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return redact(v).slice(0, 600);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (depth >= 8) return null;
  if (Array.isArray(v)) return v.slice(0, 300).map((x) => clean(x, depth + 1));
  if (typeof v === 'object') {
    const o = {}; let n = 0;
    for (const [k, x] of Object.entries(v)) { if (++n > 120) break; o[String(k).slice(0, 60)] = SECRET_KEY.test(k) ? '[hidden]' : clean(x, depth + 1); }
    return o;
  }
  return null;
}

module.exports = function makeFeed({ asSuper, fetchImpl = fetch, now = () => Date.now() }) {
  let cfgCache = null, chain = Promise.resolve();
  const last = new Map();      // app -> { at, hash, ok, error }

  async function row() { return ((await asSuper('GET', `${SET}?page=1&perPage=1&filter=${q(`scope = 'app' && app = '${esc(APP)}' && key = '${KEY}'`)}`)).items || [])[0] || null; }
  async function load() {
    if (cfgCache && now() - cfgCache.at < 60e3) return cfgCache.v;
    const r = await row(); let v = null;
    if (r && r.value) { try { v = JSON.parse(r.value); } catch { v = null; } }
    cfgCache = { at: now(), v }; return v;
  }
  const ready = (c) => !!(c && c.repo && c.token);

  async function adminView() {
    const c = await load() || {};
    return { configured: ready(c), repo: c.repo || 'joolay/tracking-data', branch: c.branch || '', dir: c.dir == null ? 'status' : c.dir, hasToken: !!c.token,
      feeds: [...last.entries()].map(([app, x]) => ({ app, at: x.at, ok: x.ok, error: x.error || '' })).sort((a, b) => a.app.localeCompare(b.app)) };
  }
  // b: { repo, branch, dir, token }  an empty token keeps the saved one.
  async function adminSave(b) {
    const old = await load() || {}, repo = String(b.repo || '').trim(), branch = String(b.branch || '').trim(), dir = String(b.dir == null ? 'status' : b.dir).trim().replace(/^\/+|\/+$/g, '');
    if (!/^[\w.-]{1,60}\/[\w.-]{1,100}$/.test(repo)) throw new FeedError(400, 'Repo should look like owner/name.');
    if (branch && !/^[\w./-]{1,80}$/.test(branch)) throw new FeedError(400, 'That branch name is not valid.');
    if (dir && (!/^[\w./-]{1,60}$/.test(dir) || dir.includes('..'))) throw new FeedError(400, 'Folder should be a simple path like status.');
    const token = String(b.token || '').trim() || old.token || '';
    if (b.token && !/^[\w-]{20,255}$/.test(String(b.token).trim())) throw new FeedError(400, 'That does not look like a GitHub token.');
    if (!token) throw new FeedError(400, 'Paste a GitHub token with write access to that repo.');
    const value = JSON.stringify({ repo, branch, dir, token }), ex = await row();
    if (ex) await asSuper('PATCH', `${SET}/${ex.id}`, { value, secret: true });
    else await asSuper('POST', SET, { scope: 'app', app: APP, user: '', key: KEY, value, secret: true, note: 'Status feed GitHub settings' });
    cfgCache = null; return adminView();
  }
  async function adminClear() { const ex = await row(); if (ex) await asSuper('DELETE', `${SET}/${ex.id}`); cfgCache = null; return adminView(); }

  const hdr = (c) => ({ authorization: 'Bearer ' + c.token, accept: 'application/vnd.github+json', 'user-agent': 'portal-admin-status-feed', 'content-type': 'application/json' });
  const url = (c, name) => `https://api.github.com/repos/${c.repo}/contents/${(c.dir ? c.dir + '/' : '') + name}.json`;
  async function put(c, name, obj, message) {
    const u = url(c, name), ref = c.branch ? '?ref=' + q(c.branch) : '';
    for (let i = 0; i < 3; i++) {
      const g = await fetchImpl(u + ref, { headers: hdr(c), signal: AbortSignal.timeout(15000) });
      if (g.status !== 200 && g.status !== 404) throw new FeedError(g.status === 401 || g.status === 403 ? 400 : 502, g.status === 401 || g.status === 403 ? 'GitHub refused the token (it needs write access to this repo).' : 'GitHub answered ' + g.status + '.');
      const sha = g.status === 200 ? (await g.json()).sha : undefined;
      const body = { message, content: Buffer.from(JSON.stringify(obj, null, 2) + '\n').toString('base64'), ...(sha ? { sha } : {}), ...(c.branch ? { branch: c.branch } : {}) };
      const r = await fetchImpl(u, { method: 'PUT', headers: hdr(c), body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (r.ok) return;
      if (r.status === 409 || r.status === 422) continue;     // changed under us: read the new version and try again
      throw new FeedError(r.status === 401 || r.status === 403 || r.status === 404 ? 400 : 502, r.status === 404 ? 'GitHub could not find that repo or folder with this token.' : r.status === 401 || r.status === 403 ? 'GitHub refused the token (it needs write access to this repo).' : 'GitHub answered ' + r.status + '.');
    }
    throw new FeedError(502, 'GitHub kept changing the file. Try again in a moment.');
  }

  // Called through Portal API by an app (app = the slug its key belongs to).
  async function publish(app, payload) {
    app = String(app || '');
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(app)) throw new FeedError(400, 'Unknown app.');
    const c = await load();
    if (!ready(c)) return { ok: false, skipped: 'not_configured' };
    const data = clean(payload), body = JSON.stringify(data), h = crypto.createHash('sha256').update(body).digest('hex'), p = last.get(app), t = now();
    if (body.length > MAX_BYTES) throw new FeedError(413, 'Status is too large to publish.');
    if (p && p.ok && t - p.at < MIN_GAP) return { ok: true, skipped: 'too_soon' };
    if (p && p.ok && p.hash === h && t - p.at < HEARTBEAT) return { ok: true, skipped: 'unchanged' };
    const job = chain.then(() => put(c, app, { app, at: new Date(t).toISOString(), data }, 'status: ' + app));
    chain = job.catch(() => {});
    try { await job; last.set(app, { at: t, hash: h, ok: true }); return { ok: true }; }
    catch (e) { last.set(app, { at: t, hash: '', ok: false, error: String(e.message || e).slice(0, 200) }); throw e; }
  }
  async function test() {
    const c = await load();
    if (!ready(c)) throw new FeedError(400, 'Save the repo and token first.');
    await put(c, '_portal-admin', { app: 'portal-admin', at: new Date(now()).toISOString(), note: 'Status feed test from Portal Admin.' }, 'status: test');
    return { ok: true, message: 'Written to ' + c.repo + '/' + (c.dir ? c.dir + '/' : '') + '_portal-admin.json' };
  }
  return { adminView, adminSave, adminClear, publish, test, clean, FeedError };
};
module.exports.clean = clean;
