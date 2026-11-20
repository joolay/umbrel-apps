'use strict';
// Port Master's hidden list of every port used by the OFFICIAL Umbrel App Store, including apps that are not installed here.
// It is read from the official store's own archive (one download, about 1 MB), kept in this app's data folder and refreshed about once a week.
// The list is only used to look for clashes: it is never shown in the app, never sent to Portal Admin and never written to the status feed
// (only how many official apps it holds and when it was fetched).
// Node built-ins only: the archive is a plain .tar.gz, read with zlib and a tiny tar reader.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { parseManifest, parseCompose } = require('./checker');

const DEFAULT_URL = 'https://codeload.github.com/getumbrel/umbrel-apps/tar.gz/refs/heads/master';
const MAX_DOWNLOAD = 40 * 1024 * 1024, MAX_UNPACKED = 120 * 1024 * 1024, MAX_FILE = 256 * 1024, WEEK = 7 * 24 * 3600e3;

const cstr = (b) => { const i = b.indexOf(0); return b.toString('utf8', 0, i < 0 ? b.length : i); };
// Reads a tar archive and returns { "<app>/umbrel-app.yml": text, "<app>/docker-compose.yml": text } for the top-level app folders only.
function untar(buf) {
  const out = {}; let o = 0, nextName = '';
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512); if (h.every((x) => x === 0)) break;
    let name = cstr(h.subarray(0, 100)); const prefix = h.toString('latin1', 257, 262) === 'ustar' ? cstr(h.subarray(345, 500)) : '';
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || '0', 8) || 0, type = String.fromCharCode(h[156] || 48), start = o + 512;
    if (start + size > buf.length) break;
    const data = buf.subarray(start, start + size);
    if (type === 'L') nextName = cstr(data);
    else if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); if (m) nextName = m[1]; }
    else if (type === 'g') { /* global header: nothing we need */ }
    else {
      const n = (nextName || name).replace(/^\.\//, ''); nextName = '';
      const m = /^[^/]+\/([A-Za-z0-9._-]+)\/(umbrel-app\.yml|docker-compose\.yml)$/.exec(n);   // <archive root>/<app>/<file>
      if ((type === '0' || type === '\0') && m && size <= MAX_FILE) out[m[1] + '/' + m[2]] = data.toString('utf8');
    }
    o = start + Math.ceil(size / 512) * 512;
  }
  return out;
}
// [{ id, name, port, hostPorts }] for every official app that declares a port.
function parseArchive(tgz) {
  const files = untar(zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED })), apps = [];
  for (const k of Object.keys(files).filter((f) => f.endsWith('/umbrel-app.yml')).sort()) {
    const dir = k.split('/')[0], man = parseManifest(files[k]); if (!man.id || !man.port) continue;
    let comp = { hostPorts: [] }; try { if (files[dir + '/docker-compose.yml']) comp = parseCompose(files[dir + '/docker-compose.yml']); } catch { /* ports from the manifest only */ }
    apps.push({ id: man.id, name: man.name, port: man.port, hostPorts: comp.hostPorts.filter((p) => p !== man.port) });
  }
  return apps;
}
async function download(url, fetchImpl = fetch) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(90000), redirect: 'follow', headers: { 'user-agent': 'port-master' } });
  if (!r.ok) throw new Error('The official store answered ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MAX_DOWNLOAD) throw new Error('The official store download was too large');
  return buf;
}
// The registry keeps its last good list on disk; a failed refresh never throws it away.
function makeRegistry({ file, url = DEFAULT_URL, fetchImpl = fetch, now = Date.now }) {
  let state = { at: 0, apps: [], error: '' };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.apps)) state = { at: Number(j.at) || 0, apps: j.apps.filter((a) => a && a.id && a.port), error: '' }; } catch { /* no list yet */ }
  let running = null;
  const refresh = () => (running = running || (async () => {
    try {
      const apps = parseArchive(await download(url, fetchImpl)); if (apps.length < 20) throw new Error('The official store archive looked wrong (' + apps.length + ' apps)');
      state = { at: now(), apps, error: '' };
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify({ at: state.at, apps })); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('Could not save the official port list:', e.message); }
    } catch (e) { state = { ...state, error: String(e.message || e).slice(0, 160) }; }
    return state;
  })().finally(() => { running = null; }));
  return { refresh, get stale() { return !state.at || now() - state.at > WEEK; }, get apps() { return state.apps; }, get at() { return state.at; }, get error() { return state.error; }, get count() { return state.apps.length; } };
}
module.exports = { untar, parseArchive, makeRegistry, DEFAULT_URL };
