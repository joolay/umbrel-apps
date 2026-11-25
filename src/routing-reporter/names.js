'use strict';
// Tailscale name upkeep (Port Master). A Tailscale name is the TSDProxy name of an app: https://<name>.<tailnet>.
// Our own apps carry their name in their compose labels (changed in the repo, Umbrel rewrites other apps' files), and Portal Admin publishes a few third-party apps
// through its own list file (joolz-published.yaml). Every OTHER app can be given a name here: Port Master keeps those in its own list file, joolz-names.yaml, in TSDProxy's
// settings folder (tailnet only, never Funnel; TSDProxy reloads a list file by itself), and keeps that file right:
//   create  - an app with no name gets one (its id without "joolay-", or a name you choose);
//   modify  - you rename one of those names;
//   fix     - a name that clashes with another app is moved to a free one, an entry whose app is gone or has a name of its own is dropped, and an entry
//             that points at an old port (or a file that someone changed) is written again.
// Names that come from a label or from Portal Admin's list are never changed from here; they are only checked (clash, not registered) and explained.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LIST = 'joolz-names.yaml', DECL = '  joolz-names:\n    filename: /config/' + LIST + '\n';
const RESERVED = new Set(['tsdproxy', 'umbrel', 'localhost']);

// What our own apps carried in their compose labels before Port Master took the names over (1.10.0): their name, the host port TSDProxy points at and whether the name is public (Funnel).
// Used when such an app has no name any more, so it comes back under the SAME address with the same port and visibility.
const SEED = {
  'joolay-cctv': { name: 'cctv', port: 3903, funnel: true }, 'joolay-diner-bell': { name: 'diner-bell', port: 3894, funnel: true }, 'joolay-gatekeeper': { name: 'gatekeeper', port: 3921, funnel: false },
  'joolay-joolztv': { name: 'joolztv', port: 3901, funnel: true }, 'joolay-listify': { name: 'listify', port: 3887, funnel: true }, 'joolay-portal-admin': { name: 'portaladmin', port: 3909, funnel: false },
  'joolay-portal': { name: 'joolzapp', port: 3886, funnel: true }, 'joolay-project-tracker': { name: 'project-tracker', port: 3916, funnel: true },
  'joolay-routing-reporter': { name: 'port-master', port: 3907, funnel: false }, 'joolay-shutterworth': { name: 'shutterworth', port: 3882, funnel: true },
};
const seedFor = (id) => SEED[id] || null;
const slugFor = (id) => String(id || '').toLowerCase().replace(/^joolay-/, '').replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const cleanName = (n) => { const v = String(n || '').trim().toLowerCase(); return NAME.test(v) && !RESERVED.has(v) ? v : ''; };

// Entries we keep: { appId: name }. owned -> what the file should hold, given the installed apps.
// apps: [{ id, port, tsdName, nameSource }] from the latest check. Returns { owned, changes: [text], entries: [{ appId, name, port }] }.
function reconcile(apps, owned, opts = {}) {
  const byId = new Map(apps.map((a) => [a.id, a])), changes = [], next = {};
  const taken = new Map();                                          // name -> app id, for names that are not ours
  for (const a of apps) if (a.tsdName && a.nameSource !== 'names') taken.set(a.tsdName, a.id);
  const free = (base, id) => { let n = base, i = 2; while (taken.has(n) && taken.get(n) !== id) n = (base.slice(0, 60) + '-' + i++); taken.set(n, id); return n; };
  for (const id of Object.keys(owned || {}).sort()) {
    const a = byId.get(id), want = cleanName(owned[id]);
    if (!a) { changes.push(`Dropped the name ${owned[id]}: ${id} is not installed any more.`); continue; }
    if (a.tsdName && a.nameSource !== 'names') { changes.push(`Dropped the name ${owned[id]}: ${a.name || id} now has its own name (${a.tsdName}).`); continue; }
    if (!want) { changes.push(`Dropped an invalid name for ${a.name || id}.`); continue; }
    const name = free(want, id); if (name !== want) changes.push(`${want} clashed with another app, so ${a.name || id} is now ${name}.`);
    next[id] = name;
  }
  const entries = Object.keys(next).map((id) => ({ appId: id, name: next[id], port: (opts[id] && opts[id].port) || byId.get(id).port, funnel: !!(opts[id] && opts[id].funnel) }));
  return { owned: next, changes, entries };
}
// A name for an app that has none: its slug, or the next free variation. null when it already has a name.
function suggest(apps, appId) {
  const a = apps.find((x) => x.id === appId); if (!a || a.tsdName) return '';
  const used = new Set(apps.filter((x) => x.tsdName).map((x) => x.tsdName)); const sd = seedFor(a.id); let base = (sd && cleanName(sd.name)) || cleanName(slugFor(a.id)) || 'app-' + a.port, n = base, i = 2;
  while (used.has(n)) n = base.slice(0, 60) + '-' + i++;
  return n;
}
// Check a name the person typed for an app. Throws { status, message } in plain words.
function validate(apps, appId, name) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 }), a = apps.find((x) => x.id === appId), n = cleanName(name);
  if (!a) throw Object.assign(new Error('That app is not in the latest check.'), { status: 404 });
  if (a.tsdName && a.nameSource !== 'names') throw bad(`${a.name || a.id} already has the name ${a.tsdName} from ${a.nameSource === 'label' ? 'its own settings (changed in the app\'s files)' : 'Portal Admin'}, so it is not changed here.`);
  if (!n) throw bad('A name uses letters, numbers and dashes only (for example my-app), up to 63 characters, and cannot be tsdproxy, umbrel or localhost.');
  const other = apps.find((x) => x.id !== appId && x.tsdName === n); if (other) throw bad(`${n} is already used by ${other.name || other.id}.`);
  return n;
}
// The TSDProxy list file: same layout Portal Admin writes for its list.
const listFile = (entries) => '# Written by Port Master. Tailscale names for the apps it manages (tailnet only, or public where marked). TSDProxy reloads this file by itself.\n' +
  entries.map((e) => (e.appId ? `# app: ${e.appId}\n` : '') + `${e.name}:\n  ports:\n    443/https:\n      targets:\n        - http://host.docker.internal:${e.port}\n` + (e.funnel ? '      tailscale:\n        funnel: true\n' : '')).join('');
// tsdproxy.yaml needs one "lists:" line for our file (TSDProxy reads it when it starts). Returns the new text (same text when it is already there).
const withList = (txt) => {
  if (/^ {2}joolz-names:\s*$/m.test(txt)) return txt;
  if (/^lists:\s*(\{\s*\})?\s*(#.*)?$/m.test(txt)) return txt.replace(/^lists:\s*(\{\s*\})?\s*(#.*)?$/m, 'lists:\n' + DECL.replace(/\n$/, ''));
  if (/^lists:/m.test(txt)) return txt.replace(/^lists:[^\n]*\n/m, (m) => m + DECL);
  return txt.replace(/\n*$/, '\n') + '\nlists:\n' + DECL;
};
// Findings for the page: one row per app. state: ok | none | clash | unregistered.
function review(apps, owned, proxies, opts = {}) {
  const count = new Map(); for (const a of apps) if (a.tsdName) count.set(a.tsdName, (count.get(a.tsdName) || 0) + 1);
  const reg = Array.isArray(proxies) ? new Set(proxies.map((p) => p.name)) : null;
  return apps.map((a) => {
    const mine = a.nameSource === 'names';
    let state = 'ok', note = '';
    if (!a.tsdName) { state = 'none'; }
    else if (count.get(a.tsdName) > 1) { state = 'clash'; note = mine ? 'Another app uses this name; Port Master moves its own name to a free one by itself.' : 'Another app uses this name too. Change tsdproxy.name in one of the two apps\' compose files in the repo.'; }
    else if (reg && !reg.has(a.tsdName)) { state = 'unregistered'; note = 'TSDProxy has no proxy with this name yet. A new name appears within a minute; if it stays, restart the TSDProxy app.'; }
    return { appId: a.id, name: a.name || a.id, port: a.port, tsdName: a.tsdName || '', source: a.nameSource || '', editable: !a.tsdName || mine, state, funnel: mine ? !!(opts[a.id] && opts[a.id].funnel) : !!(a.tsdproxy && a.tsdproxy.funnel), seedFunnel: !!(seedFor(a.id) && seedFor(a.id).funnel), note: note || (a.nameSource === 'label' && seedFor(a.id) ? 'The name moves to Port Master with this app\'s next update (same address), then you can rename it here.' : ''), suggestion: a.tsdName ? '' : suggest(apps, a.id) };
  });
}
module.exports = { SEED, seedFor, NAME, LIST, slugFor, cleanName, reconcile, suggest, validate, listFile, withList, review };
