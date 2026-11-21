'use strict';
// The global Glass theme: one set of overrides on top of templates/glass/glass.css that every JoolzApp can load at runtime (GET /theme.css).
// The Theme Editor app (owner-only) saves it through the Portal API (`theme.set`, that app only); everyone may read the generated CSS, which holds
// colours, sizes and a font name and nothing else. One shared row: portal_settings, scope global, key theme.global.
// Whatever is sent is cleaned here first (colours must be #rrggbb, numbers are clamped, the font comes from a fixed list), so the CSS we
// serve can never carry anything but harmless style values.
const SET = '/api/collections/portal_settings/records', KEY = 'theme.global';
const q = (s) => encodeURIComponent(s);

const FONTS = {
  system: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  rounded: 'ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN",system-ui,sans-serif',
  serif: 'ui-serif,Georgia,"Times New Roman",serif',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
};
// Defaults are exactly what templates/glass/glass.css ships, so an empty theme changes nothing.
const DEFAULT = {
  light: { g1: '#cfe0ff', g2: '#e9d8ff', g3: '#c9f1e6', bg: '#f4f6fa', solid: '#fbfcfe', text: '#1b2233', muted: '#6b7488', line: '#e1e5ee', chip: '#eef1f8' },
  dark: { g1: '#1b2c58', g2: '#2d1f52', g3: '#123b3a', bg: '#10141d', solid: '#171c28', text: '#e6eaf3', muted: '#8d97ad', line: '#262d3d', chip: '#212839' },
  semantic: { danger: '#d64545', ok: '#1f9d63', warn: '#c98a0b' },
  shape: { radius: 18, radiusSm: 12, glassLight: 0.58, glassDark: 0.55 },
  font: 'system',
  views: { mobile: {}, tablet: {}, desktop: {}, tv: {} },   // per-view overrides (partial themes), see cleanPartial
  bar: { height: 56, blur: 22, opacity: 0.78, border: 'subtle', shadow: 'soft', tint: 'glass', tintLight: '#ffffff', tintDark: '#171c28', textMode: 'auto', textLight: '#1b2233', textDark: '#e6eaf3', titleWeight: 700, titleSize: 16, btn: 'round', iconSize: 20 },
  accent: { mode: 'app', light: '#3b6df0', light2: '#8f6bff', dark: '#6c92ff', dark2: '#a98fff' },   // 'app' keeps each app's own brand colour; 'global' makes them all the same
};
// The top bar's choices. Position (fixed to the top), full width and square corners are the JoolzApp standard and are NOT editable.
const BAR_ENUM = { height: [48, 56, 68], blur: [0, 10, 22, 34], border: ['none', 'subtle', 'strong'], shadow: ['none', 'soft', 'strong'], tint: ['glass', 'solid', 'accent', 'custom'], textMode: ['auto', 'custom'], titleWeight: [500, 600, 700, 800], titleSize: [14, 16, 18, 20], btn: ['round', 'square', 'plain'], iconSize: [18, 20, 22] };
const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : undefined);
const num = (v, lo, hi) => { if (v === null || v === '' || typeof v === 'boolean') return undefined; v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined; };
const pickEnum = (list, v) => (list.includes(v) ? v : list.includes(Number(v)) && typeof list[0] === 'number' ? Number(v) : undefined);
const FONT_KEYS = Object.keys(FONTS);
// One validator per editable value. Returns the cleaned value, or undefined when the input is not acceptable (then the default / base value is used).
function val(group, key, v) {
  if (group === 'light' || group === 'dark' || group === 'semantic') return hex(v);
  if (group === 'shape') { const lim = { radius: [6, 32], radiusSm: [4, 24], glassLight: [0.2, 0.95], glassDark: [0.2, 0.95] }[key]; const n = lim && num(v, lim[0], lim[1]); return n === undefined ? undefined : (key.startsWith('glass') ? Math.round(n * 100) / 100 : Math.round(n)); }
  if (group === 'bar') {
    if (key === 'opacity') { const n = num(v, 0.3, 0.95); return n === undefined ? undefined : Math.round(n * 100) / 100; }
    if (['tintLight', 'tintDark', 'textLight', 'textDark'].includes(key)) return hex(v);
    return BAR_ENUM[key] ? pickEnum(BAR_ENUM[key], v) : undefined;
  }
  if (group === 'font') return FONT_KEYS.includes(v) ? v : undefined;
  if (group === 'accent') return key === 'mode' ? (v === 'global' || v === 'app' ? v : undefined) : hex(v);
  return undefined;
}
const GROUPS = ['light', 'dark', 'semantic', 'shape', 'bar', 'accent'];
// Views: the base theme applies everywhere; each view can override any value. Breakpoints are fixed here so every app agrees.
const VIEWS = ['mobile', 'tablet', 'desktop', 'tv'];
const VIEW_MEDIA = { mobile: '(max-width:599px)', tablet: '(min-width:600px) and (max-width:1023px)', desktop: '(min-width:1024px)' };   // tv = <html data-view="tv"> (set by theme-global.js on TV browsers)

// A partial theme: only the values that are present AND valid (used for the per-view overrides).
function cleanPartial(raw) {
  const o = {}; raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const g of GROUPS) {
    const src = raw[g]; if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const k of Object.keys(DEFAULT[g])) { const v = val(g, k, src[k]); if (v !== undefined) (o[g] = o[g] || {})[k] = v; }
  }
  const f = val('font', '', raw.font); if (f !== undefined) o.font = f;
  return o;
}
// The full theme: defaults, then whatever valid values were sent; plus the (partial) view overrides.
function clean(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const t = JSON.parse(JSON.stringify(DEFAULT)); delete t.views;
  const p = cleanPartial(raw);
  for (const g of GROUPS) Object.assign(t[g], p[g] || {});
  if (p.font !== undefined) t.font = p.font;
  t.views = {}; const vs = raw.views && typeof raw.views === 'object' ? raw.views : {};
  for (const v of VIEWS) t.views[v] = cleanPartial(vs[v]);
  return t;
}
const effective = (t, view) => { const e = JSON.parse(JSON.stringify(t)); const o = t.views[view] || {}; for (const g of GROUPS) Object.assign(e[g], o[g] || {}); if (o.font) e.font = o.font; return e; };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Text colour that stays readable on top of a given accent (--accent-t).
const onAccent = (h) => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#06210f' : '#ffffff'; };

// One block of CSS for one effective theme. R is the root selector (':root', or ':root[data-view="tv"]' so a TV beats the media-query blocks).
function barCss(t, R) {
  const b = t.bar, rr = (x) => String(Math.round(x * 100) / 100);
  const shadow = { none: 'none', soft: '0 2px 14px rgba(0,0,0,.12)', strong: '0 6px 24px rgba(0,0,0,.28)' }[b.shadow];
  const border = { none: '0', subtle: '1px solid var(--glass-line)', strong: '1px solid var(--line)' }[b.border];
  const pct = Math.round(b.opacity * 100) + '%';
  const rgba = (h) => `rgba(${rgb(h).join(',')},${rr(b.opacity)})`;
  const bg = (mode) => {
    if (b.tint === 'solid') return `color-mix(in srgb,var(--solid) ${pct},transparent)`;
    if (b.tint === 'accent') return `linear-gradient(135deg,color-mix(in srgb,var(--accent) ${pct},transparent),color-mix(in srgb,var(--accent-2) ${pct},transparent))`;
    if (b.tint === 'custom') return rgba(mode === 'dark' ? b.tintDark : b.tintLight);
    return mode === 'dark' ? `rgba(32,39,58,${rr(Math.min(0.95, b.opacity))})` : `rgba(255,255,255,${rr(Math.min(0.95, b.opacity))})`;
  };
  const text = (mode) => b.tint === 'accent' ? 'var(--accent-t)' : b.textMode === 'custom' ? (mode === 'dark' ? b.textDark : b.textLight) : 'var(--text)';
  const per = (mode) => `background:${bg(mode)};color:${text(mode)}`;
  const radius = { round: '50%', square: 'var(--r-sm)', plain: '50%' }[b.btn];
  const btnBg = b.btn === 'plain' ? 'background:transparent;border:0;-webkit-backdrop-filter:none;backdrop-filter:none' : '';
  return `${R} .topbar{min-height:calc(var(--safe-t,0px) + ${b.height}px);border-bottom:${border};box-shadow:${shadow};-webkit-backdrop-filter:blur(${b.blur}px) saturate(170%);backdrop-filter:blur(${b.blur}px) saturate(170%)}\n`
    + `${R} .topbar-spacer{height:${b.height + 8}px}\n`
    + `${R} .topbar{${per('light')}}\n@media (prefers-color-scheme:dark){${R}:not([data-theme="light"]) .topbar{${per('dark')}}}\n${R}[data-theme="light"] .topbar{${per('light')}}\n${R}[data-theme="dark"] .topbar{${per('dark')}}\n`
    + `${R} .topbar .brand{font-weight:${b.titleWeight};font-size:${b.titleSize}px;color:inherit}\n`
    + `${R} .tb-btn{border-radius:${radius};color:inherit;${btnBg}}\n${R} .tb-btn svg{width:${b.iconSize}px;height:${b.iconSize}px}\n`;
}
function block(t, R) {
  const s = t.shape;
  const mode = (m, glass, base, a, a2) => {
    const k = t[m], rr = (x) => x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    let out = `--g1:${k.g1};--g2:${k.g2};--g3:${k.g3};--bg:${k.bg};--solid:${k.solid};--text:${k.text};--muted:${k.muted};--line:${k.line};--chip:${k.chip};`
      + `--glass:rgba(${base},${rr(glass)});--glass-strong:rgba(${base},${rr(Math.min(0.95, glass + 0.2))});`;
    if (t.accent.mode === 'global') out += `--accent:${a};--accent-2:${a2};--accent-t:${onAccent(a)};`;
    return out;
  };
  const light = mode('light', s.glassLight, '255,255,255', t.accent.light, t.accent.light2);
  const dark = mode('dark', s.glassDark, '32,39,58', t.accent.dark, t.accent.dark2);
  return `${R}{--r:${s.radius}px;--r-sm:${s.radiusSm}px;--danger:${t.semantic.danger};--ok:${t.semantic.ok};--warn:${t.semantic.warn};${light}}\n`
    + `@media (prefers-color-scheme:dark){${R}:not([data-theme="light"]){${dark}}}\n`
    + `${R}[data-theme="light"]{${light}}\n`
    + `${R}[data-theme="dark"]{${dark}}\n`
    + `${R} body{font-family:${FONTS[t.font]}}\n`
    + barCss(t, R);
}
function css(raw) {
  const t = clean(raw);
  let out = `/* JoolzApp global theme (Theme Editor). Loaded after glass.css and the app's own CSS. Base, then one block per view that has its own settings. */\n` + block(t, ':root');
  for (const v of VIEWS) {
    if (!Object.keys(t.views[v]).length) continue;   // a view with no settings of its own just uses the base
    const e = effective(t, v);
    out += `/* ${v} */\n` + (v === 'tv' ? block(e, ':root[data-view="tv"]') : `@media ${VIEW_MEDIA[v]}{\n${block(e, ':root')}}\n`);
  }
  return out;
}

module.exports = (pb) => ({
  clean, cleanPartial, effective, css, DEFAULT, FONTS, VIEWS,
  async row() { return ((await pb.asSuper('GET', `${SET}?page=1&perPage=1&filter=${q(`scope = 'global' && key = '${KEY}'`)}`)).items || [])[0] || null; },
  async get() { const r = await this.row(); return clean(r && r.value); },
  async set(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { const e = new Error('That is not a theme.'); e.status = 400; throw e; }
    const theme = clean(raw), ex = await this.row();
    if (ex) await pb.asSuper('PATCH', `${SET}/${ex.id}`, { value: theme });
    else await pb.asSuper('POST', SET, { scope: 'global', user: '', app: '', key: KEY, value: theme, secret: false });
    return theme;
  },
  async reset() { const ex = await this.row(); if (ex) await pb.asSuper('DELETE', `${SET}/${ex.id}`); return clean(null); },
});
