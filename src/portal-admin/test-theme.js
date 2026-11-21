'use strict';
const assert = require('assert');
const rows = []; let n = 0;
const pb = { async asSuper(m, p, body) {
  if (m === 'GET') return { items: rows.filter((r) => decodeURIComponent(p).includes("key = 'theme.global'")) };
  if (m === 'POST') { const r = { id: 'r' + ++n, ...body }; rows.push(r); return r; }
  if (m === 'PATCH') { Object.assign(rows.find((r) => p.endsWith(r.id)), body); return {}; }
  if (m === 'DELETE') { rows.splice(rows.findIndex((r) => p.endsWith(r.id)), 1); return {}; }
} };
const T = require('./theme')(pb);
(async () => {
  // Empty theme = exactly the shipped Glass defaults
  const d = await T.get();
  assert.strictEqual(d.light.g1, '#cfe0ff'); assert.strictEqual(d.shape.radius, 18); assert.strictEqual(d.accent.mode, 'app'); assert.strictEqual(d.font, 'system');
  // Bad values are cleaned, never passed through
  const c = T.clean({ light: { g1: 'red', g2: '#ABCDEF;}body{display:none}', bg: '#112233' }, shape: { radius: 999, glassLight: -5 }, font: 'comic;}', accent: { mode: 'x', light: '<b>' }, extra: 1 });
  assert.strictEqual(c.light.g1, '#cfe0ff'); assert.strictEqual(c.light.g2, '#e9d8ff'); assert.strictEqual(c.light.bg, '#112233');
  assert.strictEqual(c.shape.radius, 32); assert.strictEqual(c.shape.glassLight, 0.2); assert.strictEqual(c.font, 'system'); assert.strictEqual(c.accent.mode, 'app'); assert.ok(!('extra' in c));
  assert.strictEqual(T.clean(null).shape.radiusSm, 12); assert.strictEqual(T.clean([]).font, 'system');
  // Generated CSS: only style values, brand accents untouched unless global
  let css = T.css(T.clean({ light: { bg: '#112233' }, shape: { radius: 24 }, font: 'rounded' }));
  assert.ok(css.includes('--bg:#112233') && css.includes('--r:24px') && css.includes('ui-rounded'));
  assert.ok(!css.includes('--accent'), 'app accents are left alone in app mode');
  assert.ok(css.includes(':root[data-theme="dark"]') && css.includes('prefers-color-scheme:dark'));
  assert.ok(!/[<>]|\bscript\b/i.test(css));
  css = T.css({ accent: { mode: 'global', light: '#ffff00', dark: '#000011' } });
  assert.ok(css.includes('--accent:#ffff00') && css.includes('--accent-t:#06210f') && css.includes('--accent:#000011;--accent-2:#a98fff;--accent-t:#ffffff'));
  // Top bar: only listed choices pass; the bar stays fixed/square (never emitted), custom colours are #rrggbb only
  const bd = T.clean(null).bar; assert.strictEqual(bd.height, 56); assert.strictEqual(bd.tint, 'glass'); assert.strictEqual(bd.btn, 'round');
  const bb = T.clean({ bar: { height: 999, blur: '34', border: 'x', tint: 'custom', tintLight: 'url(x)', tintDark: '#000011', titleWeight: 800, btn: 'square', opacity: 5, position: 'absolute' } }).bar;
  assert.strictEqual(bb.height, 56); assert.strictEqual(bb.blur, 34); assert.strictEqual(bb.border, 'subtle'); assert.strictEqual(bb.tintLight, '#ffffff'); assert.strictEqual(bb.opacity, 0.95); assert.ok(!('position' in bb));
  let bc = T.css({ bar: { height: 68, tint: 'accent', btn: 'plain', border: 'none', shadow: 'strong' } });
  assert.ok(bc.includes('min-height:calc(var(--safe-t,0px) + 68px)') && bc.includes('.topbar-spacer{height:76px}') && bc.includes('var(--accent-t)') && bc.includes('background:transparent;border:0') && bc.includes('border-bottom:0') && bc.includes('0 6px 24px'));
  assert.ok(!/position:|left:|right:|border-radius:0/.test(bc.split('/* JoolzApp global theme')[1].split('body{font-family')[1]), 'bar position and square corners are never touched');
  bc = T.css({ bar: { tint: 'custom', tintDark: '#000011', opacity: 0.5, textMode: 'custom', textLight: '#112233' } });
  assert.ok(bc.includes('rgba(0,0,17,0.5)') && bc.includes('color:#112233'));
  // Views: partial overrides per device; only valid values are kept; the base is untouched
  const vt = T.clean({ light: { bg: '#112233' }, views: { mobile: { shape: { radius: 8, glassLight: 9 }, bar: { height: 48, tint: 'nope' }, light: { bg: 'red', text: '#000000' }, font: 'mono' }, tv: { bar: { height: 68, iconSize: 22 }, shape: { radius: 26 } }, watch: { shape: { radius: 1 } }, desktop: 'x' } });
  assert.deepStrictEqual(Object.keys(vt.views), ['mobile', 'tablet', 'desktop', 'tv']);
  assert.deepStrictEqual(vt.views.mobile, { light: { text: '#000000' }, shape: { radius: 8, glassLight: 0.95 }, bar: { height: 48 }, font: 'mono' });
  assert.deepStrictEqual(vt.views.tablet, {}); assert.deepStrictEqual(vt.views.desktop, {}); assert.strictEqual(vt.light.bg, '#112233'); assert.strictEqual(vt.shape.radius, 18);
  const ef = T.effective(vt, 'mobile'); assert.strictEqual(ef.shape.radius, 8); assert.strictEqual(ef.light.bg, '#112233'); assert.strictEqual(ef.light.text, '#000000'); assert.strictEqual(ef.font, 'mono'); assert.strictEqual(ef.shape.radiusSm, 12);
  const vc = T.css(vt);
  assert.ok(vc.includes('@media (max-width:599px){') && vc.includes(':root[data-view="tv"]{--r:26px') && vc.includes(':root[data-view="tv"] .topbar-spacer{height:76px}'), 'mobile in a media query, tv scoped to data-view');
  assert.ok(!vc.includes('(min-width:600px) and') && !vc.includes('(min-width:1024px)'), 'views with no settings emit nothing');
  assert.ok(vc.indexOf('/* mobile */') > vc.indexOf(':root{--r:18px') && vc.indexOf('/* tv */') > vc.indexOf('/* mobile */'), 'view blocks come after the base so they win');
  assert.ok(!/[<>]/.test(vc.replace(/\/\*.*?\*\//g, '')));
  assert.strictEqual(T.clean(vt).views.mobile.shape.radius, 8, 'cleaning twice changes nothing');
  // Save, read back, update, reset
  await assert.rejects(() => T.set('nope'), /not a theme/);
  await T.set({ light: { bg: '#010203' } }); assert.strictEqual(rows.length, 1); assert.strictEqual((await T.get()).light.bg, '#010203');
  await T.set({ light: { bg: '#040506' } }); assert.strictEqual(rows.length, 1); assert.strictEqual((await T.get()).light.bg, '#040506');
  await T.reset(); assert.strictEqual(rows.length, 0); assert.strictEqual((await T.get()).light.bg, '#f4f6fa');
  console.log('theme: ok');
})().catch((e) => { console.error(e); process.exit(1); });
