// QR encoder: shape checks and a fixed result. The result was verified by scanning it with OpenCV's QR decoder (versions 1, 2, 5, 8 and 10, with accents too).
"use strict";
const assert = require("assert"), crypto = require("crypto"), qr = require("./qr");
const ok = m => console.log("ok  ", m);
const g = qr.build("https://joolzapp.example.ts.net/#/qr/AbCdEfGhIjKlMnOpQrStUv");
assert.strictEqual(g.length, 33); ok("a 60 character address needs version 4 (33 modules)");
const finder = (x, y) => { for (let d = 0; d < 7; d++) for (let e = 0; e < 7; e++) { const edge = d === 0 || d === 6 || e === 0 || e === 6, core = d >= 2 && d <= 4 && e >= 2 && e <= 4; assert.strictEqual(g[y + d][x + e], edge || core); } };
finder(0, 0); finder(26, 0); finder(0, 26); ok("the three finder squares are in place");
for (let i = 8; i < 25; i++) assert.strictEqual(g[6][i], i % 2 === 0); ok("timing pattern runs along row 6");
const h = crypto.createHash("sha1").update(g.map(r => r.map(c => (c ? 1 : 0)).join("")).join("\n")).digest("hex");
assert.strictEqual(h, "5cfbb6fc982f9bcce166bc0314a9e915e0377fa3"); ok("the modules are exactly what was verified with a decoder");
const s = qr.svg("hello", 200); assert(/^<svg [^>]*viewBox="0 0 29 29"/.test(s) && /<path d="M/.test(s) && !/script/i.test(s)); ok("svg is a plain drawing with a quiet zone");
assert.throws(() => qr.build("x".repeat(300))); ok("text that is too long is refused, not mis-drawn");
console.log("ALL PASSED");
