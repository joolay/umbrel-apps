// Checks the old-TV guards: good code passes, code Chromium 53 can't run fails the build, and the converter handles modern syntax.
"use strict";
process.env.UI_OUT = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "jtv-build-"));
const { guardJs, guardCss, guardOutput } = require("./build.js");
const esbuild = require("esbuild"), fs = require("fs"), path = require("path");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

ok(!throws(() => guardCss(".a{display:flex;transform:scale(1.1)} @supports ((backdrop-filter:blur(1px))){.g{backdrop-filter:blur(9px)}}", "x")), "CSS: flexbox, transforms and backdrop-filter inside @supports are fine");
[["display:grid", ".a{display:grid}"], ["grid-template", ".a{grid-template-columns:1fr 1fr}"], ["gap", ".a{display:flex;gap:10px}"], ["aspect-ratio", ".a{aspect-ratio:16/9}"], ["sticky", ".a{position:sticky}"],
 ["inset", ".a{position:absolute;inset:0}"], ["backdrop-filter outside @supports", ".a{backdrop-filter:blur(5px)}"], ["clamp()", ".a{width:clamp(1px,2px,3px)}"], [":is()", ":is(a,b){color:red}"], ["focus-within", "a:focus-within{color:red}"]]
  .forEach(([n, css]) => ok(throws(() => guardCss(css, "x")), "CSS guard fails on " + n));
ok(!throws(() => guardJs("var a = Object.assign({}, b); fetch('/x').then(function(r){return r.json();});", "x")), "JS: normal code passes");
["new ResizeObserver(f)", "WebAssembly.instantiate(x)", "structuredClone(o)", "arr.at(-1)", "AbortSignal.timeout(5)"].forEach(c => ok(throws(() => guardJs(c, "x")), "JS guard fails on " + c));
ok(throws(() => guardOutput("async function f(){ await 1; }")), "output check rejects async/await in the TV bundle");
ok(throws(() => guardOutput("var a = x?.y;")), "output check rejects optional chaining in the TV bundle");
const modern = "const f = async (o) => { await Promise.resolve(); const n = o?.a ?? 5; return { ...o, n }; }; class A { #p = 1; static s = 2; get v() { return this.#p; } }; for (const x of [1]) f({x});";
const conv = esbuild.transformSync(modern, { loader: "js", target: "chrome53" }).code;
ok(!throws(() => guardOutput(conv)), "converter turns async/await, ?., ??, object spread and class fields into code Chromium 53 can parse");
const comp = fs.readFileSync(path.join(process.env.UI_OUT, "compat", "app.js"), "utf8");
ok(!throws(() => guardOutput(comp)) && /Promise/.test(comp), "real compat bundle parses as ES2015 and carries the polyfills");
ok(fs.existsSync(path.join(process.env.UI_OUT, "modern", "index.html")) && /app\.js/.test(fs.readFileSync(path.join(process.env.UI_OUT, "compat", "index.html"), "utf8")), "both builds written");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
