'use strict';
// Route health for the admin's "JoolzApp apps" page. The Port Master app sends its latest report through the Portal API (`publishRoutes`); it is kept here
// (data/routes.json) and shown on that page. An admin can flag a broken route: the flag goes into the status feed as `route-alerts`, which Claude reads.
// The feed is one-way: nothing in it can change anything. Alerts clear themselves when the route answers again.
const fs = require('fs'), path = require('path');
const { clean: cleanForFeed } = require('./statusfeed');

const REPORTER = 'routing-reporter', KEYS = new Set(['lan', 'tailscale', 'name', 'public']), STATES = new Set(['up', 'down', 'checking']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, n);
const int = (v) => (Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : 0);

module.exports = function makeRoutes({ dataDir, feed, now = Date.now }) {
  const FILE = path.join(dataDir, 'routes.json');
  let st = (() => { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { report: j.report || null, receivedAt: j.receivedAt || 0, alerts: Array.isArray(j.alerts) ? j.alerts : [] }; } catch { return { report: null, receivedAt: 0, alerts: [] }; } })();
  const save = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(st)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('routes: could not save', e.message); } };

  function sanitize(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.apps)) throw fail(400, 'That is not a routing report.');
    return {
      at: int(r.at), intervalMin: Math.min(60, Math.max(1, int(r.intervalMin) || 5)),
      config: { lanHost: str(r.config && r.config.lanHost, 100), tailscaleIp: str(r.config && r.config.tailscaleIp, 40), tailnet: str(r.config && r.config.tailnet, 100) },
      apps: r.apps.slice(0, 120).map((a) => ({
        id: str(a.id, 80), name: str(a.name, 80), version: str(a.version, 30), port: int(a.port), joolzapp: !!a.joolzapp, published: ['public', 'tailnet'].includes(a.published) ? a.published : '',
        routes: (Array.isArray(a.routes) ? a.routes : []).filter((x) => x && KEYS.has(x.key)).slice(0, 6).map((x) => ({ key: x.key, label: str(x.label, 30), url: str(x.url, 200), state: STATES.has(x.state) ? x.state : 'checking', ignored: !!x.ignored, status: int(x.status), ms: int(x.ms), error: str(x.error, 160), since: int(x.since), checkedAt: int(x.checkedAt) })),
      })).filter((a) => a.id),
    };
  }
  const find = (id, key) => { const a = st.report && st.report.apps.find((x) => x.id === id); return { app: a || null, route: a ? a.routes.find((x) => x.key === key) || null : null }; };
  // What the status feed carries for Claude: only what an admin flagged (plus the last few that cleared).
  const feedAlerts = () => ({ note: 'Routes an admin flagged as broken in Portal Admin > JoolzApp apps. open = still down; resolved = answering again.',
    open: st.alerts.filter((a) => !a.resolvedAt), resolved: st.alerts.filter((a) => a.resolvedAt).slice(-10) });
  const push = async () => {
    const r = await feed.publish('route-alerts', feedAlerts(), { force: true });
    if (r && r.skipped === 'not_configured') throw fail(409, 'Switch the status feed on first (App keys > Status feed), then flag the route again.');
  };

  function publish(app, report) {
    if (app !== REPORTER) throw fail(403, 'Only Port Master can send routes.');
    st.report = sanitize(report); st.receivedAt = now();
    let changed = false;
    for (const a of st.alerts) if (!a.resolvedAt) { const { route } = find(a.appId, a.route); if (!route || route.state === 'up' || route.ignored) { a.resolvedAt = new Date(now()).toISOString(); changed = true; } }
    st.alerts = st.alerts.slice(-60); save();
    if (changed) push().catch((e) => console.error('routes: ' + e.message));        // tell Claude it has cleared
    return { ok: true };
  }
  function view() {
    const stale = !st.report || now() - st.receivedAt > Math.max(15 * 60e3, 3 * (st.report.intervalMin || 5) * 60e3);
    return { report: st.report, receivedAt: st.receivedAt, stale, alerts: st.alerts.filter((a) => !a.resolvedAt) };
  }
  async function notify(by, b) {
    const { app, route } = find(str(b.appId, 80), str(b.route, 20));
    if (!app || !route) throw fail(404, 'That route is not in the latest report.');
    if (route.state !== 'down' || route.ignored) throw fail(400, 'That route is answering now, so there is nothing to flag.');
    const note = str(b.note, 200), at = new Date(now()).toISOString();
    const entry = { appId: app.id, name: app.name, route: route.key, label: route.label, url: route.url, error: route.error, status: route.status, downSince: new Date(route.since).toISOString(), note, reportedBy: str(by, 80), reportedAt: at };
    const i = st.alerts.findIndex((a) => a.appId === entry.appId && a.route === entry.route && !a.resolvedAt);
    if (i >= 0) st.alerts[i] = entry; else st.alerts.push(entry);
    save(); await push(); return view();
  }
  async function clear(b) {
    const i = st.alerts.findIndex((a) => a.appId === str(b.appId, 80) && a.route === str(b.route, 20) && !a.resolvedAt);
    if (i >= 0) { st.alerts.splice(i, 1); save(); await push(); }
    return view();
  }
  return { publish, view, notify, clear };
};
