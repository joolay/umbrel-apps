// Minimal QR code encoder (byte mode, error correction M, versions 1-10: up to 213 bytes). Zero dependencies.
// The TV can't run a QR library on Chromium 53 comfortably, so the server draws the code and sends it as a small SVG.
"use strict";
// [ec codewords per block, blocks in group 1, data codewords per group-1 block, blocks in group 2, data codewords per group-2 block], level M
const SPEC = [null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EXP = new Array(512), LOG = new Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsRemainder(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i++) { const next = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); } gen = next; }
  const rem = new Array(n).fill(0);
  for (const b of data) { const f = b ^ rem.shift(); rem.push(0); for (let i = 0; i < n; i++) rem[i] ^= mul(gen[i + 1], f); }
  return rem;
}
function capacity(v) { const s = SPEC[v]; return s[1] * s[2] + s[3] * s[4]; }

function codewords(bytes, v) {
  const bits = []; const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v <= 9 ? 8 : 16); bytes.forEach(b => put(b, 8));
  const total = capacity(v) * 8; put(0, Math.min(4, total - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < capacity(v); pad ^= 0xec ^ 0x11) data.push(pad);
  const [ecLen, n1, d1, n2, d2] = SPEC[v], blocks = []; let at = 0;
  for (let i = 0; i < n1 + n2; i++) { const len = i < n1 ? d1 : d2; const d = data.slice(at, at + len); at += len; blocks.push({ d, e: rsRemainder(d, ecLen) }); }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach(b => { if (i < b.d.length) out.push(b.d[i]); });
  for (let i = 0; i < ecLen; i++) blocks.forEach(b => out.push(b.e[i]));
  return out;
}

function build(text) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  let v = 1; while (v <= 10 && capacity(v) < bytes.length + (v <= 9 ? 2 : 3)) v++;
  if (v > 10) throw new Error("text too long for the QR encoder");
  const size = 17 + 4 * v, cw = codewords(bytes, v);
  const mod = Array.from({ length: size }, () => new Array(size).fill(false)), fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  const al = ALIGN[v];
  al.forEach((cy, i) => al.forEach((cx, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  set(8, size - 8, true);                                                    // the always-dark module
  for (let i = 0; i < 9; i++) { fn[8][i] = fn[i][8] = true; } for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = true; fn[size - 1 - i][8] = true; }
  if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { fn[i][size - 11 + j] = true; fn[size - 11 + j][i] = true; }
  // place data bits, zig-zag from the bottom right, two columns at a time, skipping the vertical timing column
  const bits = []; cw.forEach(b => { for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1); });
  let k = 0; const data = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let right = size - 1, up = true; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n++) { const y = up ? size - 1 - n : n; for (let c = 0; c < 2; c++) { const x = right - c; if (!fn[y][x]) data[y][x] = k < bits.length ? bits[k++] === 1 : false; } }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const bch = (val, gen, nbits) => { let r = val << nbits; const gl = Math.floor(Math.log2(gen)); for (let i = Math.floor(Math.log2(r || 1)); i >= gl; i--) if ((r >>> i) & 1) r ^= gen << (i - gl); return (val << nbits) | r; };
  const finish = (m) => {
    const g = mod.map(r => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x]) g[y][x] = data[y][x] !== MASKS[m](x, y);
    const f = bch((0 << 3) | m, 0x537, 10) ^ 0x5412, bit = i => ((f >>> i) & 1) === 1;   // level M = 0b00
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i); g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8); for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i); for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
    g[size - 8][8] = true;
    if (v >= 7) { const vi = bch(v, 0x1f25, 12); for (let i = 0; i < 18; i++) { const b = ((vi >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); g[c][a] = b; g[a][c] = b; } }
    return g;
  };
  const penalty = (g) => {
    let p = 0;
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) {
      let run = 1; for (let b = 1; b < size; b++) { const cur = pass ? g[b][a] : g[a][b], prev = pass ? g[b - 1][a] : g[a][b - 1]; if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (g[y][x] === g[y][x + 1] && g[y][x] === g[y + 1][x] && g[y][x] === g[y + 1][x + 1]) p += 3;
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = pat.slice().reverse();
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) for (let b = 0; b <= size - 11; b++) { const get = i => (pass ? g[b + i][a] : g[a][b + i]) ? 1 : 0; if (pat.every((x, i) => get(i) === x) || pat2.every((x, i) => get(i) === x)) p += 40; }
    let dark = 0; g.forEach(r => r.forEach(c => { if (c) dark++; })); p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = null, bp = 1e9; for (let m = 0; m < 8; m++) { const g = finish(m), p = penalty(g); if (p < bp) { bp = p; best = g; } }
  return best;
}

// A self-contained SVG: white tile with a 4-module quiet zone, black modules. `px` is the size in pixels.
function svg(text, px) {
  const g = build(text), n = g.length, q = 4; let d = "";
  g.forEach((row, y) => { let x = 0; while (x < n) { if (!row[x]) { x++; continue; } let e = x; while (e < n && row[e]) e++; d += "M" + (x + q) + " " + (y + q) + "h" + (e - x) + "v1h-" + (e - x) + "z"; x = e; } });
  const t = n + 2 * q;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + " " + t + '" width="' + (px || 320) + '" height="' + (px || 320) + '" shape-rendering="crispEdges"><rect width="' + t + '" height="' + t + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
module.exports = { svg, build };
