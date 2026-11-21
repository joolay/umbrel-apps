'use strict';
// Restarts TSDProxy when Portal Admin asks for it (after its "Tailnet address" change is applied). Portal Admin has no Docker access: it only writes a
// small marker file, <tsdproxy config>/restart-tsdproxy, holding the time of the request. This watcher (Services Manager owns the Docker socket) restarts
// ONLY the TSDProxy container once the request is DELAY_MS old, then removes the marker. A marker survives a restart of either app. Older than a day: dropped.
const fs = require('fs'), path = require('path');
const MARKER = 'restart-tsdproxy', DELAY_MS = 30000, STALE_MS = 24 * 3600 * 1000;

function makeWatcher({ dir, docker, now = Date.now, log = () => {} }) {
  const file = path.join(dir, MARKER); let busy = false;
  return async function check() {
    if (busy) return 'busy'; busy = true;
    try {
      let txt, st; try { txt = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch { return 'none'; }
      const t = Date.parse(String(txt).trim()) || st.mtimeMs, age = now() - t;
      if (age >= STALE_MS) { try { fs.unlinkSync(file); } catch {} return 'stale'; }
      if (age < DELAY_MS) return 'waiting';
      const list = await docker('GET', '/containers/json?filters=' + encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.service=tsdproxy'] })));
      const ids = (Array.isArray(list) ? list : []).filter((c) => /tsdproxy/i.test(c.Image || '')).map((c) => c.Id);
      if (ids.length !== 1) { log('[restart-request] ' + (ids.length ? 'more than one TSDProxy container, not restarting' : 'TSDProxy container not found')); return 'skipped'; }
      await docker('POST', '/containers/' + ids[0] + '/restart?t=10');
      try { fs.unlinkSync(file); } catch {}
      log('[restart-request] TSDProxy restarted'); return 'restarted';
    } catch (e) { log('[restart-request] ' + e.message); return 'error'; }
    finally { busy = false; }
  };
}
module.exports = { makeWatcher, MARKER, DELAY_MS };
