'use strict';

const $ = (s) => document.querySelector(s);
const view = { data: null, lastJson: '', editing: false };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed (' + res.status + ')');
  return json;
}

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

/* Dates follow the regional default (DD/MM/YYYY, 24-hour) in the person's time zone. */
function when(ms) {
  if (!ms) return 'never';
  const tz = (view.data && view.data.settings.timezone) || undefined;
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  } catch { return new Date(ms).toLocaleString('en-GB'); }
  return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
}

async function refresh() {
  try {
    const data = await api('/api/state');
    view.data = data;
    if (!data.settings.timezone) {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) { await api('/api/settings', { timezone: tz }); data.settings.timezone = tz; }
      } catch { /* keep going */ }
    }
    const json = JSON.stringify(data, (k, v) => (k === 'time' ? undefined : v));
    if (json !== view.lastJson && !view.editing) { view.lastJson = json; render(); }
    $('#foot').textContent = 'Updated ' + when(data.time);
  } catch (err) {
    showBanner('Cannot reach the updater: ' + err.message, true);
  }
}

function showBanner(text, bad) {
  const b = $('#banner');
  if (!text) { b.hidden = true; return; }
  b.textContent = text;
  b.className = 'banner' + (bad ? ' bad' : '');
  b.hidden = false;
}

const MODE_LABEL = { off: 'Off', nightly: 'Nightly', immediate: 'Instant' };

function render() {
  const d = view.data;
  const pill = $('#connPill'), btn = $('#connBtn');
  if (d.umbrel.connected) {
    pill.textContent = d.umbrel.signedIn ? 'umbrelOS connected' : 'umbrelOS reconnecting';
    pill.className = 'chip ' + (d.umbrel.signedIn ? 'ok' : 'warn');
    btn.textContent = 'Disconnect';
    $('#connSub').textContent = d.umbrel.remember ? 'Stays connected so automatic updates keep working.' : 'Connected without "Stay connected"; automatic updates stop when the session expires.';
  } else {
    $('#connSub').textContent = 'Needed so this app can see and update your Umbrel apps.';
    pill.textContent = 'umbrelOS not connected';
    pill.className = 'chip warn';
    btn.textContent = 'Connect';
  }
  if (d.umbrel.error) showBanner(d.umbrel.error, true);
  else if (!d.umbrel.connected) showBanner('Connect to umbrelOS so the updater can see and update your apps.');
  else if (d.check.error) showBanner('Last check failed: ' + d.check.error, true);
  else if (d.apps.length && d.check.at && !d.check.registryProc) showBanner('Connected, but the app store list could not be read, so new versions cannot be detected. Open Diagnostics below and send me the result.', true);
  else if (d.umbrel.connected && !d.umbrel.remember) showBanner('Connected without "Stay connected": automatic updates stop when the umbrelOS session expires. Disconnect and connect again with Stay connected on.');
  else showBanner('');

  const shown = d.apps.filter((a) => !a.hidden), hiddenApps = d.apps.filter((a) => a.hidden);
  const updates = shown.filter((a) => a.update).length;
  const auto = shown.filter((a) => a.mode !== 'off').length;
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('span', {}, label));
  $('#stats').replaceChildren(stat(shown.length, 'Installed apps'), stat(updates, 'Updates waiting'), stat(auto, 'On auto-update'), stat(d.check.at ? when(d.check.at).slice(11) : '--:--', 'Last check'));

  $('#pauseSw').checked = !d.settings.paused;
  $('#pauseSub').textContent = d.settings.paused ? 'Paused: nothing updates by itself.' : 'On: apps set to Nightly or Instant update by themselves.';
  $('#nightly').value = d.settings.nightlyTime;
  $('#tz').value = d.settings.timezone || '';
  $('#poll').value = String(d.settings.pollSeconds);
  $('#quietSw').checked = d.settings.quiet.enabled;
  $('#qStart').value = d.settings.quiet.start;
  $('#qEnd').value = d.settings.quiet.end;
  const tk = d.settings.ticker || {};
  $('#tickerSw').checked = !!tk.enabled;
  const tc = $('#tickerChip'), tn = $('#tickerNote');
  tc.textContent = tk.linked ? 'Linked to Portal Admin' : 'Not linked yet';
  tc.className = 'chip ' + (tk.linked ? 'ok' : 'warn');
  tn.hidden = !(tk.error || !tk.linked);
  tn.textContent = tk.error ? 'Last notice failed: ' + tk.error
    : 'To link it, open Portal Admin > Changes and apply "Portal API key for each app" and "Dashboard notices from apps". No restart is needed.';

  const sf = d.self || {}, sc = $('#selfChip'), sn = $('#selfNote');
  $('#selfSw').checked = !!sf.enabled;
  sc.textContent = sf.phase === 'updating' ? 'Updating now' : sf.update ? 'Update ' + (sf.latest || '') + ' waiting' : 'v' + (sf.version || '?') + ', up to date';
  sc.className = 'chip ' + (sf.phase === 'updating' || sf.update ? 'warn' : 'ok');
  const sr = sf.result;
  sn.hidden = !(sr || sf.phase === 'updating');
  sn.textContent = sf.phase === 'updating' ? 'Updating App Updater. Checks are paused and resume when it restarts.'
    : sr && sr.ok ? 'Last self-update worked: ' + sr.from + ' to ' + sr.to + '.'
    : sr ? 'Last self-update failed: ' + sr.error + (sf.retryAt ? '. Next try ' + when(sf.retryAt) + '.' : '.') : '';
  $('#list').replaceChildren(...(shown.length ? renderGroups(d) : [h('div', { class: 'empty' }, d.umbrel.connected ? 'No apps found yet.' : 'Connect to umbrelOS to list your apps.')]));

  $('#hiddenCount').textContent = hiddenApps.length ? hiddenApps.length + ' hidden' : 'None';
  $('#hiddenList').replaceChildren(...(hiddenApps.length
    ? hiddenApps.map((a) => h('div', { class: 'hrow' }, h('span', { class: 'name' }, a.name), h('span', { class: 'sub' }, a.version ? 'v' + a.version : ''), h('button', { class: 'btn small', onclick: () => setHidden(a, false) }, 'Unhide')))
    : [h('div', { class: 'sub hnone' }, 'Nothing hidden.')]));

  $('#log').replaceChildren(...(d.log.length
    ? d.log.map((e) => h('div', { class: e.level }, h('time', {}, when(e.t)), h('span', {}, e.message)))
    : [h('div', { class: 'sub' }, 'Nothing yet.')]));
}

/* Apps are grouped by the App Store they came from; each group collapses and expands, and the state is saved on the server. */
function renderGroups(d) {
  const groups = new Map();
  for (const a of d.apps.filter((x) => !x.hidden)) {
    const st = a.store || { id: 'other', name: 'Other apps' };
    if (!groups.has(st.id)) groups.set(st.id, { id: st.id, name: st.name, raw: st.raw, apps: [] });
    groups.get(st.id).apps.push(a);
  }
  const list = [...groups.values()].sort((x, y) =>
    (x.id === 'other') - (y.id === 'other') ||
    y.apps.filter((a) => a.update).length - x.apps.filter((a) => a.update).length ||
    x.name.localeCompare(y.name));
  return list.map((g) => {
    const saved = d.settings.groupOpen && d.settings.groupOpen[g.id];
    const open = typeof saved === 'boolean' ? saved : g.apps.some((a) => a.update); // first time: open only if something is waiting
    const updates = g.apps.filter((a) => a.update).length;
    const auto = g.apps.filter((a) => a.mode !== 'off').length;
    const meta = [g.apps.length + (g.apps.length === 1 ? ' app' : ' apps'), auto ? auto + ' on auto-update' : ''].filter(Boolean).join(' · ');
    return h('section', { class: 'group' + (open ? ' open' : '') },
      h('div', { class: 'ghrow' },
        h('button', { class: 'ghead', 'aria-expanded': String(open), onclick: () => toggleGroup(g.id, !open) },
          h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸'),
          h('span', { class: 'gtext' }, h('span', { class: 'gname' }, g.name), h('span', { class: 'sub' }, meta)),
          updates ? h('span', { class: 'chip accent gupd' }, updates + (updates === 1 ? ' update' : ' updates')) : null),
        storeLink(g)),
      open ? h('div', { class: 'gbody' }, renderModeSections(g.apps)) : null);
  });
}

/* Quick link to the store's own page in umbrelOS: the official store, or a community store by its registry id. */
function storeLink(g) {
  const path = g.id === 'umbrel' ? '/app-store' : (g.raw && g.id !== 'other' ? '/community-app-store/' + encodeURIComponent(g.raw) : null);
  if (!path) return null;
  const a = h('a', { class: 'storelink', href: location.protocol + '//' + location.hostname + path, target: '_top', title: 'Open ' + g.name + ' in the App Store', 'aria-label': 'Open ' + g.name + ' store' });
  a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  return a;
}

/* Inside each store, apps are split by their auto-update mode: immediately, scheduled (nightly) or off. */
const MODE_SECTIONS = [['immediate', 'Instant'], ['nightly', 'Scheduled'], ['off', 'Off']];
function renderModeSections(apps) {
  const out = [];
  for (const [m, label] of MODE_SECTIONS) {
    const items = apps.filter((a) => (a.mode || 'off') === m).sort((x, y) => (y.update ? 1 : 0) - (x.update ? 1 : 0) || x.name.localeCompare(y.name));
    if (!items.length) continue;
    out.push(h('div', { class: 'msec' }, label + ' · ' + items.length), items.map(renderApp));
  }
  return out;
}

async function toggleGroup(id, open) {
  if (view.data) { view.data.settings.groupOpen = Object.assign({}, view.data.settings.groupOpen, { [id]: open }); render(); }
  try { await api('/api/settings', { groupOpen: { id, open } }); } catch (err) { toast(err.message, true); }
  view.lastJson = ''; refresh();
}

const ICON_TICK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_UPDATE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 9a8 8 0 0 0-14.5-2.5M4 15a8 8 0 0 0 14.5 2.5"/><path d="M5 3v4h4M19 21v-4h-4"/></svg>';
function icon(cls, svg, title) { const s = h('span', { class: cls, title }); s.innerHTML = svg; return s; }

function renderApp(a) {
  const chips = [];
  if (a.busy) chips.push(h('span', { class: 'chip warn' }, 'Updating…'));
  if (a.waiting) chips.push(h('span', { class: 'chip', title: a.mode === 'nightly' ? 'Waits for the nightly window' : 'Waits for quiet hours to end' }, 'Waiting'));
  if (a.result && !a.result.ok) chips.push(h('span', { class: 'chip bad', title: a.result.error }, 'Failed'));

  const sub = [(a.version ? 'v' + a.version : 'version unknown'), a.result && a.result.ok ? ' · updated ' + when(a.result.at).slice(0, 10) : ''].join('');

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Auto-update mode' },
    ['off', 'nightly', 'immediate'].map((m) => h('button', { class: a.mode === m ? 'on' : '', onclick: () => setMode(a, m) }, MODE_LABEL[m])));

  let right = null;
  if (a.update && !a.busy) {
    const btn = h('button', { class: 'btn primary upbtn', onclick: () => updateNow(a) });
    btn.innerHTML = ICON_UPDATE;
    btn.title = 'Update now';
    btn.append(h('span', {}, a.latest || 'Update'));
    right = btn;
  } else if (!a.update && !a.busy) right = icon('tick', ICON_TICK, 'Up to date');

  const tile = h('div', { class: 'card app' },
    h('div', { class: 'main' },
      h('div', { class: 'id' }, h('span', { class: 'name', title: a.name }, a.name), h('span', { class: 'sub' }, sub)),
      h('div', { class: 'ctl' }, chips, seg)),
    right ? h('div', { class: 'tside' }, right) : null);
  holdToHide(tile, a);
  return tile;
}

/* Hold a tile (about half a second; right-click on a computer) to hide it. */
function holdToHide(tile, a) {
  let timer = null, x = 0, y = 0;
  const stop = () => { clearTimeout(timer); timer = null; };
  tile.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('button')) return;
    x = e.clientX; y = e.clientY;
    timer = setTimeout(() => { timer = null; askHide(a); }, 550);
  });
  tile.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 8) stop(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) tile.addEventListener(ev, stop);
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!e.target.closest('button')) { stop(); askHide(a); } });
}
let hideTarget = null;
function askHide(a) {
  hideTarget = a;
  $('#hideTitle').textContent = 'Hide ' + a.name + '?';
  if (!$('#hideDlg').open) $('#hideDlg').showModal();
}
async function setHidden(a, hidden) {
  try { await api('/api/hide', { appId: a.id, hidden }); toast(a.name + (hidden ? ' hidden' : ' is back in the list')); }
  catch (err) { toast(err.message, true); }
  view.lastJson = ''; refresh();
}
$('#hideCancel').addEventListener('click', () => $('#hideDlg').close());
$('#hideGo').addEventListener('click', async () => { $('#hideDlg').close(); if (hideTarget) await setHidden(hideTarget, true); hideTarget = null; });

async function setMode(a, mode) {
  try { await api('/api/mode', { appId: a.id, mode }); toast(a.name + ': ' + MODE_LABEL[mode]); }
  catch (err) { toast(err.message, true); }
  view.lastJson = ''; refresh();
}
async function updateNow(a) {
  try { await api('/api/update', { appId: a.id }); toast('Updating ' + a.name + '…'); }
  catch (err) { toast(err.message, true); }
  view.lastJson = ''; refresh();
}
async function save(body) {
  try { await api('/api/settings', body); toast('Saved'); }
  catch (err) { toast(err.message, true); }
  view.editing = false; view.lastJson = ''; refresh();
}

/* ---- wiring ---- */
$('#pauseSw').addEventListener('change', (e) => save({ paused: !e.target.checked }));
$('#nightly').addEventListener('change', (e) => e.target.value && save({ nightlyTime: e.target.value }));
$('#tz').addEventListener('change', (e) => save({ timezone: e.target.value.trim() }));
$('#poll').addEventListener('change', (e) => save({ pollSeconds: Number(e.target.value) }));
$('#selfSw').addEventListener('change', (e) => save({ selfUpdate: { enabled: e.target.checked } }));
$('#tickerSw').addEventListener('change', (e) => save({ ticker: { enabled: e.target.checked } }));
$('#quietSw').addEventListener('change', (e) => save({ quiet: { enabled: e.target.checked } }));
$('#qStart').addEventListener('change', (e) => e.target.value && save({ quiet: { start: e.target.value } }));
$('#qEnd').addEventListener('change', (e) => e.target.value && save({ quiet: { end: e.target.value } }));
for (const id of ['#nightly', '#tz', '#poll', '#qStart', '#qEnd']) {
  $(id).addEventListener('focus', () => (view.editing = true));
  $(id).addEventListener('blur', () => setTimeout(() => (view.editing = false), 200));
}

$('#checkBtn').addEventListener('click', async () => {
  const b = $('#checkBtn');
  b.disabled = true;
  try { await api('/api/check', {}); toast('Checked'); } catch (err) { toast(err.message, true); }
  b.disabled = false; view.lastJson = ''; refresh();
});
$('#clearBtn').addEventListener('click', async () => { await api('/api/log/clear', {}); view.lastJson = ''; refresh(); });
$('#diagBtn').addEventListener('click', async () => {
  const el = $('#diag');
  if (!el.hidden) { el.hidden = true; return; }
  el.textContent = 'Asking umbrelOS…';
  el.hidden = false;
  try {
    const { results } = await api('/api/diagnose');
    el.textContent = results.map((r) => (r.ok ? 'OK    ' : 'FAIL  ') + r.proc + ' — ' + (r.shape || r.error)).join('\n');
  } catch (err) { el.textContent = err.message; }
});

const dlg = $('#connDlg');
$('#connBtn').addEventListener('click', async () => {
  if (view.data && view.data.umbrel.connected) {
    await api('/api/umbrel/logout', {});
    toast('Disconnected from umbrelOS');
    view.lastJson = ''; refresh();
  } else {
    $('#connErr').hidden = true; $('#pw').value = ''; $('#totp').value = '';
    dlg.showModal(); $('#pw').focus();
  }
});
$('#connCancel').addEventListener('click', () => dlg.close());
$('#connForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#connGo');
  go.disabled = true; go.textContent = 'Connecting…';
  try {
    await api('/api/umbrel/login', { password: $('#pw').value, totp: $('#totp').value, remember: $('#remember').checked && !$('#totp').value });
    $('#pw').value = '';
    dlg.close();
    toast('Connected to umbrelOS');
    view.lastJson = ''; refresh();
  } catch (err) {
    const el = $('#connErr');
    el.textContent = err.message; el.hidden = false;
  } finally {
    go.disabled = false; go.textContent = 'Connect';
  }
});

function route() {
  const st = location.hash === '#settings';
  $('#settingsView').hidden = !st;
  $('#mainView').hidden = st;
  window.scrollTo(0, 0);
}
$('#gearBtn').addEventListener('click', () => { location.hash = location.hash === '#settings' ? '' : '#settings'; });
$('#backBtn').addEventListener('click', () => { location.hash = ''; });
window.addEventListener('hashchange', route);
route();

refresh();
setInterval(refresh, 5000);
