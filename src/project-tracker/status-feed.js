'use strict';
// Sends this app's status to Portal Admin's status feed (Portal API `publishStatus`), which cleans it and writes it to a GitHub repo for the owner and Claude to read.
// One-way and best effort: nothing comes back that can change the app, a failure only means the feed is stale, and it does nothing until the app has its Portal key
// (<app data>/data/pocketbase.env, written by Portal Admin) and the status feed is switched on in Portal Admin > App keys.
// tick() resolves true when sent (or nothing to do) and false when it failed.
// link() is the handshake state Portal Admin sent back with the last report (see src/portal-admin/claudelink.js): { state: 'both'|'device'|'ai'|'broken', shaking, lastEdit, read, note, ... }.
// Apps serve it at GET /api/link for the top bar's handshake icon (linkstatus.js); until the first report it says 'broken' (nothing has come through yet).
// Identical in every app that uses it (App Updater, Services Manager, ...): copy this file, then call
//   require('./status-feed')({ dataDir: DATA_DIR, getPayload: async () => ({ ...anything useful, no secrets... }) });
// Portal Admin hides passwords, tokens and keys by itself, but do not put them in the payload in the first place.
const fs = require('fs'), path = require('path');

module.exports = function startStatusFeed({ dataDir, getPayload, everyMs = 60e3, log = () => {} }) {
  let bad = 0, lastLink = null, lastOk = 0;
  function portal() {
    try {
      const kv = {};
      for (const line of fs.readFileSync(path.join(dataDir, 'pocketbase.env'), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(POCKETBASE_PORTAL_(?:URL|KEY))\s*=\s*(.*?)\s*$/);
        if (m) kv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
      }
      return kv.POCKETBASE_PORTAL_URL && kv.POCKETBASE_PORTAL_KEY ? { url: kv.POCKETBASE_PORTAL_URL.replace(/\/+$/, ''), key: kv.POCKETBASE_PORTAL_KEY } : null;
    } catch { return null; }
  }
  async function tick() {
    const p = portal(); if (!p) return true;
    try {
      const payload = await getPayload();
      const r = await fetch(p.url + '/app-api/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key }, body: JSON.stringify({ fn: 'publishStatus', args: [payload] }), signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.message || 'Portal API error ' + r.status);
      bad = 0; lastOk = Date.now(); if (j.result && j.result.link) lastLink = j.result.link; return true;
    } catch (e) { bad++; if (bad === 1 || bad % 60 === 0) log('Status feed: ' + String(e.message || e).slice(0, 160)); return false; }
  }
  const t = setInterval(tick, everyMs); if (t.unref) t.unref();
  const first = setTimeout(tick, 20e3); if (first.unref) first.unref();
  // If Portal Admin has not answered for 35 minutes the handshake is broken whatever it last said.
  function link() { return lastLink && Date.now() - lastOk < 35 * 60e3 ? lastLink : { state: 'broken', shaking: false, lastEdit: lastLink ? lastLink.lastEdit : null, read: false, connected: false, note: 'No report has come through to the feed yet.' }; }
  return { tick, link, stop() { clearInterval(t); clearTimeout(first); } };
};
