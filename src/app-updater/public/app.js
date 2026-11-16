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
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
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

const MODE_LABEL = { off: 'Off', nightly: 'Nightly', immediate: 'Immediately' };

function render() {
  const d = view.data;
  const pill = $('#connPill'), btn = $('#connBtn');
  if (d.umbrel.connected) {
    pill.textContent = d.umbrel.signedIn ? 'umbrelOS connected' : 'umbrelOS reconnecting';
    pill.className = 'chip ' + (d.umbrel.signedIn ? 'ok' : 'warn');
    btn.textContent = 'Disconnect';
  } else {
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

  const updates = d.apps.filter((a) => a.update).length;
  const auto = d.apps.filter((a) => a.mode !== 'off').length;
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('span', {}, label));
  $('#stats').replaceChildren(stat(d.apps.length, 'Installed apps'), stat(updates, 'Updates waiting'), stat(auto, 'On auto-update'), stat(d.check.at ? when(d.check.at).slice(11) : '--:--', 'Last check'));

  $('#pauseSw').checked = !d.settings.paused;
  $('#pauseSub').textContent = d.settings.paused ? 'Paused: nothing updates by itself.' : 'On: apps set to Nightly or Immediately update by themselves.';
  $('#nightly').value = d.settings.nightlyTime;
  $('#tz').value = d.settings.timezone || '';
  $('#poll').value = String(d.settings.pollSeconds);
  $('#quietSw').checked = d.settings.quiet.enabled;
  $('#qStart').value = d.settings.quiet.start;
  $('#qEnd').value = d.settings.quiet.end;

  $('#list').replaceChildren(...(d.apps.length ? d.apps.map(renderApp) : [h('div', { class: 'empty' }, d.umbrel.connected ? 'No apps found yet.' : 'Connect to umbrelOS to list your apps.')]));

  $('#log').replaceChildren(...(d.log.length
    ? d.log.map((e) => h('div', { class: e.level }, h('time', {}, when(e.t)), h('span', {}, e.message)))
    : [h('div', { class: 'sub' }, 'Nothing yet.')]));
}

function renderApp(a) {
  const chips = [];
  if (a.busy) chips.push(h('span', { class: 'chip warn' }, 'Updating…'));
  else if (a.update) chips.push(h('span', { class: 'chip accent' }, 'Update ' + (a.latest || 'available')));
  else chips.push(h('span', { class: 'chip ok' }, 'Up to date'));
  if (a.waiting) chips.push(h('span', { class: 'chip' }, a.mode === 'nightly' ? 'Waits for the nightly window' : 'Waits for quiet hours to end'));
  if (a.result && !a.result.ok) chips.push(h('span', { class: 'chip bad', title: a.result.error }, 'Last update failed'));

  const sub = [(a.version ? 'v' + a.version : 'version unknown'), a.detectedAt ? ' · found ' + when(a.detectedAt) : '', a.result && a.result.ok ? ' · updated ' + when(a.result.at) : ''].join('');

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Auto-update mode' },
    ['off', 'nightly', 'immediate'].map((m) => h('button', { class: a.mode === m ? 'on' : '', disabled: a.self, onclick: () => setMode(a, m) }, MODE_LABEL[m])));

  return h('div', { class: 'card app' },
    h('div', { class: 'id' }, h('div', { class: 'name' }, a.name), h('div', { class: 'sub' }, sub, a.self ? ' · this app (update by hand)' : '')),
    h('div', { class: 'ctl' }, chips, seg,
      h('button', { class: 'btn small primary', disabled: !a.update || a.busy || a.self, onclick: () => updateNow(a) }, 'Update now')));
}

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

refresh();
setInterval(refresh, 5000);
