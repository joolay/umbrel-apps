'use strict';
// Watches the JoolzApp store repo (joolay/umbrel-apps, branch main) and compares what it holds with what umbrelOS lists in its store registry.
// An app or version that is on the repo but not yet in the registry is "pending": umbrelOS has not seen it yet (it refreshes community stores on its own schedule).
// Read-only and best effort: a failed fetch only sets `error`, it never changes anything.
module.exports = function makeRepoWatch({ fetchText, isNewer, now = Date.now, repo = 'joolay/umbrel-apps', branch = 'main', everyMs = 120000 }) {
  const state = { at: 0, error: null, apps: {} };   // apps: { id: { name, version } }
  let running = null;

  const field = (yml, key) => { const m = new RegExp('^' + key + ':\\s*(.+?)\\s*$', 'm').exec(yml); return m ? m[1].replace(/^(["'])(.*)\1$/, '$2').trim() : null; };

  async function load() {
    const tree = JSON.parse(await fetchText('https://api.github.com/repos/' + repo + '/git/trees/' + branch));
    const dirs = (tree.tree || []).filter((e) => e.type === 'tree' && /^joolay-[a-z0-9-]+$/.test(e.path)).map((e) => e.path);
    const apps = {};
    await Promise.all(dirs.map(async (id) => {
      try {
        const yml = await fetchText('https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + id + '/umbrel-app.yml');
        const version = field(yml, 'version');
        if (field(yml, 'id') === id && version) apps[id] = { name: field(yml, 'name') || id, version };
      } catch { /* a folder with no manifest is not an app */ }
    }));
    if (!Object.keys(apps).length) throw new Error('no apps found on ' + repo);
    return apps;
  }

  // Fetches at most once per everyMs (or when `force`); concurrent calls share one fetch.
  async function refresh(force) {
    if (running) return running;
    if (!force && state.at && now() - state.at < everyMs) return state;
    running = (async () => {
      try { state.apps = await load(); state.error = null; } catch (e) { state.error = String(e.message || e).slice(0, 160); }
      state.at = now();
      running = null;
      return state;
    })();
    return running;
  }

  // registry: Map id -> version as umbrelOS lists it (null when it could not be read: then nothing can be said).
  function pending(registry) {
    if (!registry) return [];
    const out = [];
    for (const [id, r] of Object.entries(state.apps)) {
      const seen = registry.get(id);
      if (!seen) out.push({ id, name: r.name, repo: r.version, umbrel: null, kind: 'new' });
      else if (isNewer(r.version, seen)) out.push({ id, name: r.name, repo: r.version, umbrel: seen, kind: 'update' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { state, refresh, pending };
};
