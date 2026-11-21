'use strict';
// Theme Editor front end. Every changeable item offers named options (chips, colour swatches) plus a custom picker/slider. The editor holds a DRAFT of the theme;
// the preview applies it to one box only (CSS variables on #pv), so editing never restyles this page. Portal Admin (theme.js) cleans everything again on save,
// so nothing here is trusted. DEFAULT mirrors theme.js DEFAULT (the shipped Glass look); keep them equal.
const $ = (s) => document.querySelector(s);
const DEFAULT = {
  light: { g1: '#cfe0ff', g2: '#e9d8ff', g3: '#c9f1e6', bg: '#f4f6fa', solid: '#fbfcfe', text: '#1b2233', muted: '#6b7488', line: '#e1e5ee', chip: '#eef1f8' },
  dark: { g1: '#1b2c58', g2: '#2d1f52', g3: '#123b3a', bg: '#10141d', solid: '#171c28', text: '#e6eaf3', muted: '#8d97ad', line: '#262d3d', chip: '#212839' },
  semantic: { danger: '#d64545', ok: '#1f9d63', warn: '#c98a0b' },
  shape: { radius: 18, radiusSm: 12, glassLight: 0.58, glassDark: 0.55 },
  bar: { height: 56, blur: 22, opacity: 0.78, border: 'subtle', shadow: 'soft', tint: 'glass', tintLight: '#ffffff', tintDark: '#171c28', textMode: 'auto', textLight: '#1b2233', textDark: '#e6eaf3', titleWeight: 700, titleSize: 16, btn: 'round', iconSize: 20 },
  font: 'system',
  views: { mobile: {}, tablet: {}, desktop: {}, tv: {} },
  accent: { mode: 'app', light: '#3b6df0', light2: '#8f6bff', dark: '#6c92ff', dark2: '#a98fff' },
};
const COLOURS = [['bg', 'Page background'], ['solid', 'Solid panel'], ['text', 'Text'], ['muted', 'Muted text'], ['line', 'Lines'], ['chip', 'Chips'], ['g1', 'Backdrop glow 1'], ['g2', 'Backdrop glow 2'], ['g3', 'Backdrop glow 3']];
const SEMANTIC = [['danger', 'Danger'], ['ok', 'OK'], ['warn', 'Warning']];
const PAL = {   // named starting points for each colour (the custom picker is always there too)
  light: { bg: ['#f4f6fa', '#ffffff', '#f5efe6', '#eaf4ee', '#eef0ff', '#fdf2f8'], solid: ['#fbfcfe', '#ffffff', '#fffaf2', '#f6fbf8'], text: ['#1b2233', '#000000', '#2d2a26', '#10241a', '#1e1b4b'], muted: ['#6b7488', '#555555', '#7a6f60', '#4f6b5a'], line: ['#e1e5ee', '#cfd5e3', '#ece3d4', '#d3e5da'], chip: ['#eef1f8', '#e6e9f2', '#f4ecdf', '#e4f1e9'],
    g1: ['#cfe0ff', '#ffe1cc', '#ffd6e4', '#d5f0dc', '#e8e8e8'], g2: ['#e9d8ff', '#ffd9d9', '#fbe3a8', '#cde7f5', '#f0f0f0'], g3: ['#c9f1e6', '#f2e8c9', '#ffe1ec', '#dcd5ff', '#ededed'] },
  dark: { bg: ['#10141d', '#000000', '#14110f', '#0e1712', '#12122a', '#1a1020'], solid: ['#171c28', '#0a0a0a', '#1d1814', '#142019'], text: ['#e6eaf3', '#ffffff', '#f3ece2', '#dff5e8', '#e0e7ff'], muted: ['#8d97ad', '#a3a3a3', '#a39886', '#86a893'], line: ['#262d3d', '#333333', '#3a3128', '#294036'], chip: ['#212839', '#1c1c1c', '#2b241d', '#1d2e25'],
    g1: ['#1b2c58', '#4a2a14', '#4a1a30', '#173f2a', '#222222'], g2: ['#2d1f52', '#4a1f1f', '#4a3f10', '#17394a', '#2a2a2a'], g3: ['#123b3a', '#3a3410', '#4a1a3a', '#25205a', '#242424'] },
  semantic: { danger: ['#d64545', '#e11d48', '#dc2626', '#ea580c'], ok: ['#1f9d63', '#16a34a', '#059669', '#0d9488'], warn: ['#c98a0b', '#d97706', '#ca8a04', '#f59e0b'] },
  accent: ['#3b6df0', '#7c3aed', '#c2347a', '#d9480f', '#1e7a4c', '#0a6c8f', '#b45309', '#145f4f'],
  accentDark: ['#6c92ff', '#a78bfa', '#ff6fae', '#ff8a4c', '#4fc083', '#4db6dd', '#f59e0b', '#3fbf9f'],
  tint: ['#ffffff', '#f4f6fa', '#1b2233', '#171c28', '#000000', '#7c3aed', '#0f766e', '#c2347a'],
  text: ['#1b2233', '#000000', '#ffffff', '#e6eaf3'],
};
const PRESETS = [
  ['Glass default', {}],
  ['Midnight', { dark: { bg: '#05070d', solid: '#0b0f1a', g1: '#101a3a', g2: '#1d1238', g3: '#0a2a2a', line: '#1a2133', chip: '#121827' }, light: { bg: '#eef1f8', g1: '#c4d4ff', g2: '#ddd0ff' } }],
  ['Warm sand', { light: { bg: '#f5efe6', solid: '#fffaf2', text: '#2d2a26', muted: '#7a6f60', line: '#ece3d4', chip: '#f4ecdf', g1: '#ffe1cc', g2: '#fbe3a8', g3: '#f2e8c9' }, dark: { bg: '#14110f', solid: '#1d1814', text: '#f3ece2', muted: '#a39886', line: '#3a3128', chip: '#2b241d', g1: '#4a2a14', g2: '#4a3f10', g3: '#3a3410' }, shape: { radius: 22 } }],
  ['Forest', { light: { bg: '#eaf4ee', solid: '#f6fbf8', text: '#10241a', muted: '#4f6b5a', line: '#d3e5da', chip: '#e4f1e9', g1: '#d5f0dc', g2: '#cde7f5', g3: '#c9f1e6' }, dark: { bg: '#0e1712', solid: '#142019', text: '#dff5e8', muted: '#86a893', line: '#294036', chip: '#1d2e25', g1: '#173f2a', g2: '#17394a', g3: '#123b3a' } }],
  ['High contrast', { light: { bg: '#ffffff', solid: '#ffffff', text: '#000000', muted: '#333333', line: '#000000', chip: '#eeeeee' }, dark: { bg: '#000000', solid: '#000000', text: '#ffffff', muted: '#cccccc', line: '#ffffff', chip: '#1a1a1a' }, shape: { glassLight: 0.9, glassDark: 0.9, radius: 10, radiusSm: 8 }, bar: { border: 'strong', shadow: 'none', tint: 'solid', opacity: 0.95 } }],
];
const OPT = {
  radius: [['Sharp', 6], ['Soft', 12], ['Standard', 18], ['Round', 26]], radiusSm: [['Sharp', 4], ['Soft', 8], ['Standard', 12], ['Round', 18]],
  glass: [['Clear', 0.35], ['Light', 0.45], ['Standard', null], ['Frosted', 0.75]],
  font: [['System', 'system'], ['Rounded', 'rounded'], ['Serif', 'serif'], ['Monospace', 'mono']],
  height: [['Compact', 48], ['Standard', 56], ['Tall', 68]], blur: [['Off', 0], ['Soft', 10], ['Standard', 22], ['Heavy', 34]],
  opacity: [['Clear', 0.45], ['Standard', 0.78], ['Solid', 0.95]], border: [['None', 'none'], ['Subtle', 'subtle'], ['Strong', 'strong']], shadow: [['None', 'none'], ['Soft', 'soft'], ['Strong', 'strong']],
  tint: [['Glass', 'glass'], ['Solid panel', 'solid'], ['Accent', 'accent'], ['Custom colour', 'custom']], textMode: [['Automatic', 'auto'], ['Custom colour', 'custom']],
  weight: [['Medium', 500], ['Semibold', 600], ['Bold', 700], ['Heavy', 800]], size: [['Small', 14], ['Standard', 16], ['Large', 18], ['XL', 20]],
  btn: [['Round', 'round'], ['Rounded square', 'square'], ['Plain (no background)', 'plain']], icon: [['Small', 18], ['Standard', 20], ['Large', 22]],
  accentMode: [['Each app keeps its own', 'app'], ['One accent for all apps', 'global']],
};
const VIEWS = [['base', 'All views'], ['mobile', 'Mobile'], ['tablet', 'Tablet'], ['desktop', 'Desktop'], ['tv', 'TV']];
const VIEW_HELP = { base: 'Applies everywhere. A device below only changes what you set for it.', mobile: 'Phones: screens under 600px wide.', tablet: 'Tablets: screens 600px to 1023px wide.', desktop: 'Computers: screens 1024px wide and up.', tv: 'TV browsers (LG webOS, Samsung Tizen, Android TV, Fire TV). Apps mark them automatically.' };
const VIEW_W = { base: '', mobile: '390px', tablet: '768px', desktop: '', tv: '' };
let saved = null, draft = null, mode = 'light', view = 'base', dirty = false;
const clone = (o) => JSON.parse(JSON.stringify(o));
const merge = (a, b) => { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = merge(a[k] || {}, v); else a[k] = v; } return a; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (m, bad) => { const t = $('#toast'); t.textContent = m; t.hidden = false; t.classList.toggle('bad', !!bad); clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500); };
const msg = (m, cls) => { const e = $('#msg'); e.textContent = m || ''; e.className = 'small ' + (cls || ''); };
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || 'Request failed (' + r.status + ')'); return j;
}
// A view shows its own override where it has one, otherwise what it inherits from the base; changing a value in a view only changes that view.
const dig = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const eff = () => { const e = clone(draft); delete e.views; if (view !== 'base') merge(e, draft.views[view] || {}); return e; };
const get = (path) => dig(eff(), path);
const own = (path) => view !== 'base' && dig(draft.views[view] || {}, path) !== undefined;
const set = (path, v) => { const ks = path.split('.'), last = ks.pop(); let o = view === 'base' ? draft : (draft.views[view] = draft.views[view] || {}); for (const k of ks) o = (o[k] = o[k] || {}); o[last] = v; };
const countOverrides = (v) => { const f = (o) => Object.values(o).reduce((n, x) => n + (x && typeof x === 'object' ? f(x) : 1), 0); return f(draft.views[v] || {}); };

/* ---- building blocks: every item gets named options, plus custom ---- */
const chips = (path, opts, label) => `<div class="item"><span class="lbl">${esc(label)}</span><div class="chips">${opts.map(([n, v]) => `<button class="chip-btn${String(get(path)) === String(v) ? ' on' : ''}" data-path="${path}" data-val="${esc(v)}" data-type="${typeof v}">${esc(n)}</button>`).join('')}</div></div>`;
const swatches = (path, label, list) => { const cur = String(get(path)).toLowerCase(); return `<div class="item"><span class="lbl">${esc(label)}</span><div class="sw">${list.map((c) => `<button style="background:${c}" class="${cur === c ? 'on' : ''}" data-path="${path}" data-val="${c}" data-type="string" aria-label="${c}" title="${c}"></button>`).join('')}<input type="color" data-cpath="${path}" value="${get(path)}" aria-label="Custom colour for ${esc(label)}"></div></div>`; };
const slider = (path, label, min, max, step, fmt) => `<div class="item"><label>${esc(label)} <span class="val">${fmt(get(path))}</span><input type="range" data-rpath="${path}" min="${min}" max="${max}" step="${step}" value="${get(path)}"></label></div>`;
const fmtPx = (v) => v + 'px', fmtPct = (v) => Math.round(v * 100) + '%';

function build() {
  const D = eff(), glassK = mode === 'light' ? 'glassLight' : 'glassDark', std = mode === 'light' ? 0.58 : 0.55;
  $('#views').innerHTML = VIEWS.map(([v, n]) => `<button class="chip-btn${view === v ? ' on' : ''}" data-view="${v}">${n}${v !== 'base' && countOverrides(v) ? '<span class="dot" title="Has its own settings"></span>' : ''}</button>`).join('');
  $('#viewNote').textContent = VIEW_HELP[view] + (view !== 'base' ? (countOverrides(view) ? ' This view has ' + countOverrides(view) + ' setting(s) of its own; everything else comes from All views.' : ' Nothing set yet: it uses All views.') : '');
  $('#presetBox').hidden = view !== 'base'; $('#clearView').hidden = view === 'base' || !countOverrides(view);
  $('#presets').innerHTML = PRESETS.map(([n], i) => `<button class="chip-btn" data-preset="${i}">${esc(n)}</button>`).join('');
  $('#colours').innerHTML = COLOURS.map(([k, l]) => swatches(mode + '.' + k, l, PAL[mode][k])).join('');
  $('#semantic').innerHTML = SEMANTIC.map(([k, l]) => swatches('semantic.' + k, l, PAL.semantic[k])).join('');
  $('#shape').innerHTML = chips('shape.radius', OPT.radius, 'Corner radius') + slider('shape.radius', 'Custom radius', 6, 32, 1, fmtPx)
    + chips('shape.radiusSm', OPT.radiusSm, 'Small corners (fields, chips)')
    + chips('shape.' + glassK, OPT.glass.map(([n, v]) => [n, v === null ? std : v]), 'Glass opacity (' + mode + ')') + slider('shape.' + glassK, 'Custom glass opacity', 0.2, 0.95, 0.01, fmtPct)
    + chips('font', OPT.font, 'Font');
  const B = D.bar;
  $('#bar').innerHTML = chips('bar.height', OPT.height, 'Height') + chips('bar.tint', OPT.tint, 'Background')
    + (B.tint === 'custom' ? swatches('bar.tint' + (mode === 'light' ? 'Light' : 'Dark'), 'Bar colour (' + mode + ')', PAL.tint) : '')
    + chips('bar.opacity', OPT.opacity, 'Background strength') + slider('bar.opacity', 'Custom strength', 0.3, 0.95, 0.01, fmtPct)
    + chips('bar.blur', OPT.blur, 'Frosted blur') + chips('bar.border', OPT.border, 'Bottom line') + chips('bar.shadow', OPT.shadow, 'Shadow')
    + (B.tint === 'accent' ? '<p class="muted small">Text and icons use the accent\'s own text colour.</p>' : chips('bar.textMode', OPT.textMode, 'Text and icon colour') + (B.textMode === 'custom' ? swatches('bar.text' + (mode === 'light' ? 'Light' : 'Dark'), 'Bar text (' + mode + ')', PAL.text) : ''))
    + chips('bar.titleWeight', OPT.weight, 'Title weight') + chips('bar.titleSize', OPT.size, 'Title size') + chips('bar.btn', OPT.btn, 'Button style') + chips('bar.iconSize', OPT.icon, 'Icon size');
  $('#accent').innerHTML = chips('accent.mode', OPT.accentMode, 'Accent colour')
    + (D.accent.mode === 'global' ? swatches('accent.light', 'Accent (light)', PAL.accent) + swatches('accent.light2', 'Accent 2 (light)', PAL.accent) + swatches('accent.dark', 'Accent (dark)', PAL.accentDark) + swatches('accent.dark2', 'Accent 2 (dark)', PAL.accentDark) : '<p class="muted small">Every app keeps the brand colour it has now.</p>');
  $('#modeName').textContent = '(' + mode + ')';
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
  preview();
}
const onAccent = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#06210f' : '#ffffff'; };
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
function preview() {   // same maths as Portal Admin's theme.js, applied to the preview box only
  const pv = $('#pv'), E = eff(), k = E[mode], s = E.shape, dark = mode === 'dark', g = dark ? s.glassDark : s.glassLight, base = dark ? '32,39,58' : '255,255,255', b = E.bar;
  const vars = { '--g1': k.g1, '--g2': k.g2, '--g3': k.g3, '--bg': k.bg, '--solid': k.solid, '--text': k.text, '--muted': k.muted, '--line': k.line, '--chip': k.chip,
    '--glass': `rgba(${base},${g})`, '--glass-strong': `rgba(${base},${Math.min(0.95, g + 0.2)})`, '--r': s.radius + 'px', '--r-sm': s.radiusSm + 'px', ...Object.fromEntries(SEMANTIC.map(([x]) => ['--' + x, E.semantic[x]])) };
  const a = E.accent; if (a.mode === 'global') { const c = dark ? a.dark : a.light; vars['--accent'] = c; vars['--accent-2'] = dark ? a.dark2 : a.light2; vars['--accent-t'] = onAccent(c); }
  else for (const v of ['--accent', '--accent-2', '--accent-t']) pv.style.removeProperty(v);
  // top bar
  const pct = Math.round(b.opacity * 100) + '%', op = Math.min(0.95, b.opacity);
  vars['--pb-h'] = b.height + 'px'; vars['--pb-blur'] = b.blur + 'px';
  vars['--pb-border'] = { none: '0', subtle: '1px solid var(--glass-line)', strong: '1px solid var(--line)' }[b.border];
  vars['--pb-shadow'] = { none: 'none', soft: '0 2px 14px rgba(0,0,0,.12)', strong: '0 6px 24px rgba(0,0,0,.28)' }[b.shadow];
  vars['--pb-bg'] = b.tint === 'solid' ? `color-mix(in srgb,var(--solid) ${pct},transparent)` : b.tint === 'accent' ? `linear-gradient(135deg,color-mix(in srgb,var(--accent) ${pct},transparent),color-mix(in srgb,var(--accent-2) ${pct},transparent))` : b.tint === 'custom' ? `rgba(${rgbOf(dark ? b.tintDark : b.tintLight)},${b.opacity})` : `rgba(${base},${op})`;
  vars['--pb-text'] = b.tint === 'accent' ? 'var(--accent-t)' : b.textMode === 'custom' ? (dark ? b.textDark : b.textLight) : 'var(--text)';
  vars['--pb-w'] = b.titleWeight; vars['--pb-fs'] = b.titleSize + 'px'; vars['--pb-ic'] = b.iconSize + 'px';
  vars['--pb-br'] = { round: '50%', square: 'var(--r-sm)', plain: '50%' }[b.btn];
  vars['--pb-btnbg'] = b.btn === 'plain' ? 'transparent' : 'var(--glass-strong)'; vars['--pb-btnborder'] = b.btn === 'plain' ? '0' : '1px solid var(--glass-line)';
  for (const [n, v] of Object.entries(vars)) pv.style.setProperty(n, v);
  pv.style.fontFamily = { system: 'system-ui,-apple-system,sans-serif', rounded: 'ui-rounded,system-ui,sans-serif', serif: 'ui-serif,Georgia,serif', mono: 'ui-monospace,Menlo,monospace' }[E.font];
  pv.style.maxWidth = VIEW_W[view] || ''; pv.dataset.view = view;
  pv.dataset.theme = mode; pv.style.colorScheme = mode;
}
function touch() { dirty = JSON.stringify(draft) !== JSON.stringify(saved); msg(dirty ? 'Unsaved changes' : 'Saved', dirty ? '' : 'ok'); }
const HEXRE = /^#[0-9a-f]{6}$/i;
document.addEventListener('input', (e) => {   // sliders and the custom colour pickers update live without rebuilding (so dragging is not interrupted)
  const t = e.target; if (!draft) return;
  if (t.dataset.rpath) { set(t.dataset.rpath, Number(t.value)); const v = t.parentElement.querySelector('.val'); if (v) v.textContent = /opacity|glass/i.test(t.dataset.rpath) ? fmtPct(t.value) : fmtPx(t.value); }
  else if (t.dataset.cpath && HEXRE.test(t.value)) set(t.dataset.cpath, t.value.toLowerCase());
  else return;
  preview(); touch();
});
document.addEventListener('change', (e) => { const t = e.target; if (draft && (t.dataset.rpath || t.dataset.cpath)) build(); });   // refresh which option is highlighted once a drag or pick ends
document.addEventListener('click', async (e) => {
  const o = e.target.closest('[data-path]');
  if (o && draft) { set(o.dataset.path, o.dataset.type === 'number' ? Number(o.dataset.val) : o.dataset.val); build(); touch(); return; }
  const vw = e.target.closest('[data-view]'); if (vw && draft) { view = vw.dataset.view; build(); return; }
  const pr = e.target.closest('[data-preset]');
  if (pr && draft) { draft = merge(clone(DEFAULT), PRESETS[Number(pr.dataset.preset)][1]); draft.views = clone(saved.views || DEFAULT.views); build(); touch(); toast('Preset applied. Save to publish it.'); return; }
  const m = e.target.closest('#mode button'); if (m) { mode = m.dataset.m; return build(); }
  if (e.target.id === 'clearView') { draft.views[view] = {}; build(); touch(); toast('This view now follows All views.'); return; }
  if (e.target.id === 'revert') { draft = clone(saved); build(); touch(); return; }
  if (e.target.id === 'save') {
    try { e.target.disabled = true; saved = (await api('/api/theme', { theme: draft })).theme; draft = clone(saved); build(); touch(); toast('Saved. Apps pick it up within a minute.'); }
    catch (x) { toast(x.message, true); } finally { e.target.disabled = false; }
  }
  if (e.target.id === 'reset') {
    if (!confirm('Reset the global theme to the Glass defaults for every app?')) return;
    try { saved = (await api('/api/reset', {})).theme; draft = clone(saved); build(); touch(); toast('Back to the Glass defaults.'); } catch (x) { toast(x.message, true); }
  }
});
(async () => {
  try { saved = (await api('/api/theme')).theme; draft = clone(saved); mode = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme:dark)').matches) ? 'dark' : 'light'; build(); touch(); }
  catch (x) { msg(x.message, 'bad'); $('#controls').style.opacity = .5; $('#controls').style.pointerEvents = 'none'; }
})();
