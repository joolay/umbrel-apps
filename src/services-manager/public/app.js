'use strict';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');

const view = { services: [], umbrel: { connected: false }, filter: 'all', q: '', open: new Set(), pending: new Set(), lastJson: '' };

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
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

const POLICY_LABEL = { no: 'no', 'on-failure': 'on-failure', 'unless-stopped': 'unless-stopped', always: 'always', mixed: 'mixed', default: 'App default' };

async function refresh() {
  try {
    const data = await api('/api/state');
    const json = JSON.stringify(data.services) + JSON.stringify(data.umbrel);
    view.umbrel = data.umbrel;
    view.services = data.services;
    renderChrome();
    const busyUi = listEl.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
    if (json !== view.lastJson && !busyUi) { view.lastJson = json; renderList(); }
    $('#foot').textContent = 'Updated ' + new Date(data.time).toLocaleTimeString();
  } catch (err) {
    showBanner('Cannot read services: ' + err.message + '. Is the Docker socket mounted?', true);
  }
}

function showBanner(text, bad) {
  const b = $('#banner');
  if (!text) { b.hidden = true; return; }
  b.textContent = text;
  b.className = 'banner' + (bad ? ' bad' : '');
  b.hidden = false;
}

function renderChrome() {
  const pill = $('#connPill');
  const btn = $('#connBtn');
  if (view.umbrel.connected) {
    pill.textContent = 'umbrelOS connected';
    pill.className = 'pill ok';
    btn.textContent = 'Disconnect';
  } else {
    pill.textContent = 'umbrelOS not connected';
    pill.className = 'pill off';
    btn.textContent = 'Connect';
  }
  if (view.umbrel.error) showBanner(view.umbrel.error, true);
  else if (!view.umbrel.connected) showBanner('Connect to umbrelOS to start/stop Umbrel apps persistently and to list apps that are currently stopped. Custom Docker services work without it.');
  else showBanner('');

  const s = view.services;
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('span', {}, label));
  $('#stats').replaceChildren(
    stat(s.length, 'Services'),
    stat(s.filter((x) => x.on).length, 'Running'),
    stat(s.filter((x) => !x.on).length, 'Stopped'),
    stat(s.filter((x) => bootEnabled(x)).length, 'Start on reboot'),
  );
}

function bootEnabled(svc) {
  if (svc.kind === 'umbrel') return svc.autoStart === null ? svc.on : svc.autoStart;
  return svc.policy === 'always' || svc.policy === 'unless-stopped';
}

function matches(svc) {
  if (view.filter !== 'all' && svc.kind !== view.filter) return false;
  const q = view.q.trim().toLowerCase();
  return !q || svc.name.toLowerCase().includes(q) || svc.id.toLowerCase().includes(q) || svc.containers.some((c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q));
}

async function run(svc, action, extra) {
  view.pending.add(svc.key);
  renderList();
  try {
    await api('/api/action', Object.assign({ key: svc.key, action }, extra));
    toast(svc.name + ': ' + (extra && extra.policy ? 'restart policy set to ' + POLICY_LABEL[extra.policy] : action + ' done'));
  } catch (err) {
    toast(svc.name + ': ' + err.message, true);
  } finally {
    view.pending.delete(svc.key);
    view.lastJson = '';
    await refresh();
  }
}

function renderRow(svc) {
  const busy = svc.busy || view.pending.has(svc.key);
  const locked = svc.protected || busy || (svc.kind === 'umbrel' && !view.umbrel.connected);
  const open = view.open.has(svc.key);

  const toggle = h('label', { class: 'switch', title: svc.protected ? 'This is Services Manager itself' : svc.on ? 'Disable' : 'Enable' },
    h('input', { type: 'checkbox', checked: svc.on, disabled: locked, onchange: (e) => run(svc, e.target.checked ? 'enable' : 'disable') }),
    h('span'));

  const opts = svc.kind === 'umbrel' ? ['default', 'unless-stopped', 'always'] : ['no', 'on-failure', 'unless-stopped', 'always'];
  const current = svc.kind === 'umbrel' ? svc.pinned || 'default' : svc.policy || 'no';
  const select = h('select', { disabled: svc.protected || busy || (svc.kind === 'umbrel' && svc.containers.length === 0 && !svc.pinned), 'aria-label': 'Restart policy', onchange: (e) => run(svc, 'policy', { policy: e.target.value }) },
    current === 'mixed' ? h('option', { value: 'mixed', selected: true, disabled: true }, 'mixed') : null,
    opts.map((o) => h('option', { value: o, selected: o === current }, POLICY_LABEL[o])));

  const bootTag = svc.kind === 'umbrel' && svc.autoStart !== null
    ? h('span', { class: 'tag ' + (svc.autoStart ? 'boot-on' : 'boot-off') }, svc.autoStart ? 'starts on boot' : 'off on boot')
    : null;

  const sub = [
    h('span', { class: 'tag ' + svc.kind }, svc.kind === 'umbrel' ? 'Umbrel app' : 'Docker'),
    bootTag,
    svc.state + ' · ' + svc.containers.length + (svc.containers.length === 1 ? ' container' : ' containers'),
  ];

  const table = h('table', {},
    h('thead', {}, h('tr', {}, ['Container', 'Image', 'State', 'Restart'].map((t) => h('th', {}, t)))),
    h('tbody', {}, svc.containers.map((c) => h('tr', {}, h('td', {}, c.name + (c.self ? ' (this app)' : '')), h('td', {}, c.image), h('td', {}, c.status || c.state), h('td', {}, c.policy)))));

  const notes = [];
  if (svc.kind === 'umbrel') {
    notes.push('The switch uses umbrelOS itself, so a stopped app stays stopped after a reboot. The restart policy is pinned and re-applied whenever umbrelOS recreates the containers. Note: "always" can bring an app back after a reboot even if you stopped it; "unless-stopped" respects the stop.');
  } else {
    notes.push('Disabling stops the service and makes sure it will not return after a reboot (an "always" policy is switched to "unless-stopped"). Enabling starts it and sets "unless-stopped" if it had no restart policy.');
  }

  return h('div', { class: 'row' + (busy ? ' busy' : '') + (open ? ' open' : ''), 'data-key': svc.key },
    h('div', { class: 'head' },
      h('div', { class: 'id' },
        h('span', { class: 'dot ' + (busy ? 'busy' : svc.on ? 'on' : svc.state === 'unknown' ? 'bad' : '') }),
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, svc.name), h('div', { class: 'sub' }, sub))),
      h('div', { class: 'ctl' },
        toggle,
        h('label', { class: 'small' }, 'Restart policy', select),
        h('button', { class: 'btn small', disabled: locked || !svc.on, onclick: () => run(svc, 'restart') }, 'Restart'),
        h('button', { class: 'more', title: 'Details', onclick: () => { open ? view.open.delete(svc.key) : view.open.add(svc.key); renderList(); } }, open ? '▴' : '▾'))),
    h('div', { class: 'detail' }, svc.containers.length ? table : h('p', { class: 'sub' }, 'No containers exist right now (the app is stopped).'), h('p', { class: 'note' }, notes)));
}

function renderList() {
  const rows = view.services.filter(matches);
  listEl.replaceChildren(...(rows.length ? rows.map(renderRow) : [h('div', { class: 'empty' }, view.services.length ? 'No services match.' : 'No services found.')]));
}

/* ---- wiring ---- */
$('#search').addEventListener('input', (e) => { view.q = e.target.value; renderList(); });
$('#filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  view.filter = b.dataset.f;
  document.querySelectorAll('#filter button').forEach((x) => x.classList.toggle('on', x === b));
  renderList();
});

const dlg = $('#connDlg');
$('#connBtn').addEventListener('click', async () => {
  if (view.umbrel.connected) {
    await api('/api/umbrel/logout', {});
    toast('Disconnected from umbrelOS');
    view.lastJson = '';
    refresh();
  } else {
    $('#connErr').hidden = true;
    $('#pw').value = '';
    $('#totp').value = '';
    dlg.showModal();
    $('#pw').focus();
  }
});
$('#connCancel').addEventListener('click', () => dlg.close());
$('#connForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#connGo');
  go.disabled = true;
  go.textContent = 'Connecting…';
  try {
    await api('/api/umbrel/login', { password: $('#pw').value, totp: $('#totp').value });
    $('#pw').value = '';
    dlg.close();
    toast('Connected to umbrelOS');
    view.lastJson = '';
    refresh();
  } catch (err) {
    const el = $('#connErr');
    el.textContent = err.message;
    el.hidden = false;
  } finally {
    go.disabled = false;
    go.textContent = 'Connect';
  }
});

refresh();
setInterval(refresh, 5000);
