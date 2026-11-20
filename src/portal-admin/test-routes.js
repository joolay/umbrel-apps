'use strict';
// Route health: only Routing Reporter can send a report, an admin can flag a route that is really down, the flag goes to the status feed, and clears itself on recovery.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const makeRoutes = require('./routes'), makeAppApi = require('./appapi');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), sent = []; let t = Date.parse('2026-11-20T10:00:00Z'), feedOn = true;
  const feed = { publish: async (app, payload, opts) => { if (!feedOn) return { ok: false, skipped: 'not_configured' }; sent.push({ app, payload: JSON.parse(JSON.stringify(payload)), opts }); return { ok: true }; } };
  const R = makeRoutes({ dataDir: dir, feed, now: () => t });
  const rt = (key, state, extra = {}) => ({ key, label: key, url: 'http://x/' + key, state, status: state === 'up' ? 200 : 0, ms: 12, error: state === 'down' ? 'connection refused (nothing listening)' : '', since: t - 60e3, checkedAt: t, ...extra });
  const report = (tsState) => ({ at: t, intervalMin: 5, config: { lanHost: '192.168.1.5', tailscaleIp: '100.64.0.9', tailnet: 'tail1.ts.net' }, apps: [
    { id: 'joolay-project-tracker', name: 'Project Pilot', version: '1.4.0', port: 3915, joolzapp: true, published: 'public', routes: [rt('lan', 'up'), rt('tailscale', tsState), rt('public', 'up')] },
    { id: 'bitcoin', name: 'Bitcoin', version: '1', port: 8332, joolzapp: false, published: '', routes: [rt('lan', 'up')] }] });
  assert.throws(() => R.publish('joolay-listify', report('up')), /Only Routing Reporter/);
  assert.throws(() => R.publish('routing-reporter', { nope: 1 }), /not a routing report/);
  assert.deepStrictEqual(R.publish('routing-reporter', report('down')), { ok: true });
  let v = R.view(); assert.strictEqual(v.stale, false); assert.strictEqual(v.report.apps.length, 2); assert.strictEqual(v.alerts.length, 0);
  // flagging: only a route that is down, and it reaches the status feed with which route
  await assert.rejects(() => R.notify('zahir@x.co', { appId: 'joolay-project-tracker', route: 'lan' }), /answering now/);
  await assert.rejects(() => R.notify('zahir@x.co', { appId: 'nope', route: 'lan' }), /not in the latest report/);
  v = await R.notify('zahir@x.co', { appId: 'joolay-project-tracker', route: 'tailscale', note: 'Cannot open from my phone' });
  assert.strictEqual(v.alerts.length, 1); assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].app, 'route-alerts'); assert.strictEqual(sent[0].opts.force, true, 'a flag is always written');
  const al = sent[0].payload.open[0]; assert.strictEqual(al.appId, 'joolay-project-tracker'); assert.strictEqual(al.route, 'tailscale'); assert.strictEqual(al.url, 'http://x/tailscale'); assert.strictEqual(al.reportedBy, 'zahir@x.co'); assert.strictEqual(al.note, 'Cannot open from my phone'); assert.ok(/^2026-11-20T/.test(al.reportedAt));
  await R.notify('zahir@x.co', { appId: 'joolay-project-tracker', route: 'tailscale', note: 'Still broken' }); assert.strictEqual(R.view().alerts.length, 1, 'flagging twice updates the same flag');
  // it clears itself when the route answers again, and Claude is told
  t += 5 * 60e3; R.publish('routing-reporter', report('up')); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(R.view().alerts.length, 0); const last = sent[sent.length - 1].payload; assert.strictEqual(last.open.length, 0); assert.strictEqual(last.resolved.length, 1); assert.ok(last.resolved[0].resolvedAt);
  // clearing by hand, a feed that is off, and a report that goes quiet
  R.publish('routing-reporter', report('down')); await R.notify('a', { appId: 'joolay-project-tracker', route: 'tailscale' }); await R.clear({ appId: 'joolay-project-tracker', route: 'tailscale' }); assert.strictEqual(R.view().alerts.length, 0);
  feedOn = false; await assert.rejects(() => R.notify('a', { appId: 'joolay-project-tracker', route: 'tailscale' }), (e) => e.status === 409 && /status feed/.test(e.message)); feedOn = true;
  t += 20 * 60e3; assert.strictEqual(R.view().stale, true, 'no report for 20 minutes is shown as stale');
  // a route the owner ignores in Routing Reporter cannot be flagged, and clears an open flag
  R.publish('routing-reporter', report('down')); await R.notify('a', { appId: 'joolay-project-tracker', route: 'tailscale' });
  const ig = report('down'); ig.apps[0].routes[1].ignored = true; R.publish('routing-reporter', ig); await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(R.view().alerts.length, 0); await assert.rejects(() => R.notify('a', { appId: 'joolay-project-tracker', route: 'tailscale' }), /answering now/);
  // it survives a restart
  assert.strictEqual(makeRoutes({ dataDir: dir, feed, now: () => t }).view().report.apps.length, 2);
  // hostile text is flattened and sizes are capped
  R.publish('routing-reporter', { at: t, apps: [{ id: 'x<script>', name: 'a'.repeat(500), routes: [{ key: 'evil', state: 'up' }, { key: 'lan', state: 'hax', url: 'http://<b>/' }] }] });
  const a0 = R.view().report.apps[0]; assert.ok(!/[<>]/.test(a0.id)); assert.strictEqual(a0.name.length, 80); assert.strictEqual(a0.routes.length, 1); assert.strictEqual(a0.routes[0].state, 'checking'); assert.ok(!/[<>]/.test(a0.routes[0].url));
  // the Portal API lets only the allowed function through, and the app is whoever the key says
  const api = makeAppApi({ qrlogin: {}, quick: {}, feed, routes: R, pbx: { creds: () => ({}), url: () => '', userFromToken: async () => null }, DATA_DIR: dir, readBody: async () => '', send: () => {} });
  assert.ok(api.allowed.includes('publishRoutes'));
  console.log('routes ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
