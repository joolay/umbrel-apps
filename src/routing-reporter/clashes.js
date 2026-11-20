'use strict';
// Finds apps that use the same port and decides which one has to change.
// Who is kept: an official Umbrel app always wins. Between apps that are not official, an app from another community store wins over a JoolzApp app
// (the JoolzApp apps are the ones you can change yourself). If two apps rank the same, the first by id is kept.
// Only apps installed here can be asked to change: an official app that is not installed is never flagged, but it still keeps its port,
// so installing it later cannot clash with something you already run. Two official apps are never reported against each other.
const RANK = { official: 0, other: 1, joolzapp: 2 };

// installed: [{ id, name, port, hostPorts, joolzapp }] (what Port Master found in Umbrel's app-data), official: [{ id, name, port, hostPorts }] (the hidden list)
function findPortClashes(installed, official) {
  const ids = new Set((official || []).map((a) => a.id)), parties = new Map();     // port -> Map(id -> party)
  const add = (a, source, isInstalled) => {
    [[a.port, 'app'], ...(a.hostPorts || []).filter((p) => p !== a.port).map((p) => [p, 'published'])].forEach(([port, kind]) => {
      if (!(port > 0 && port < 65536)) return;
      const m = parties.get(port) || new Map(); if (!m.has(a.id)) m.set(a.id, { id: a.id, name: a.name || a.id, source, installed: isInstalled, kind }); parties.set(port, m);
    });
  };
  const seen = new Set();
  (installed || []).forEach((a) => { seen.add(a.id); add(a, ids.has(a.id) ? 'official' : a.joolzapp ? 'joolzapp' : 'other', true); });
  (official || []).forEach((a) => { if (!seen.has(a.id)) add(a, 'official', false); });   // an installed official app is counted once, from the installed copy
  const used = new Set(parties.keys()), clashes = [];
  for (const port of [...parties.keys()].sort((x, y) => x - y)) {
    const all = [...parties.get(port).values()].sort((x, y) => RANK[x.source] - RANK[y.source] || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (all.length < 2) continue;
    const officials = all.filter((p) => p.source === 'official'), keep = officials.length ? officials : [all[0]];
    const change = all.filter((p) => !keep.includes(p) && p.source !== 'official' && p.installed);
    if (!change.length) continue;
    clashes.push({ port, keep, change });
  }
  // A free port for each app that has to change: the next one up that nothing known uses (installed or official), never handed out twice.
  for (const c of clashes) for (const p of c.change) {
    let n = c.port + 1; while (used.has(n) && n < 65535) n++;
    if (n < 65536 && !used.has(n)) { used.add(n); p.suggestedPort = n; }
  }
  return clashes;
}
module.exports = { findPortClashes, RANK };
