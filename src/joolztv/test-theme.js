// Sunrise / sunset maths behind "Auto" appearance.
"use strict";
const Theme = require("./ui/js/theme.js");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } else console.log("ok", m); };
const d = new Date(2026, 5, 21, 12, 0);                        // winter solstice in the south: 21 June
const fmt = m => Math.floor(m / 60) + ":" + ("0" + Math.round(m % 60)).slice(-2);
const jhb = Theme.sun(d, -26.2, 28.0, 120);                    // Johannesburg: sunrise ~06:52, sunset ~17:21 local
ok(Math.abs(jhb.rise - (6 * 60 + 52)) < 20 && Math.abs(jhb.set - (17 * 60 + 21)) < 20, "Johannesburg midwinter " + fmt(jhb.rise) + " / " + fmt(jhb.set));
const lon = Theme.sun(new Date(2026, 5, 21), 51.5, -0.1, 60);  // London midsummer: ~04:43 / 21:21 BST
ok(Math.abs(lon.rise - (4 * 60 + 43)) < 20 && Math.abs(lon.set - (21 * 60 + 21)) < 20, "London midsummer " + fmt(lon.rise) + " / " + fmt(lon.set));
ok(Theme.sun(new Date(2026, 5, 21), 78, 15, 60) === null, "polar day gives no sunrise");
const lightAt = (h, m) => Theme.isLightNow(new Date(2026, 5, 21, h, m), "ZA");   // device zone decides the longitude; run with TZ=Africa/Johannesburg
process.env.TZ === "Africa/Johannesburg" ? (ok(lightAt(12, 0), "noon is light"), ok(!lightAt(3, 0), "3am is dark"), ok(!lightAt(19, 0), "7pm in winter is dark")) : console.log("ok (zone checks skipped)");
ok(Theme.isLightNow(new Date(2026, 5, 21, 12, 0), "") === true && Theme.isLightNow(new Date(2026, 5, 21, 22, 0), "") === false, "no country: 06:30 to 18:30");
console.log(bad ? bad + " FAILED" : "ALL PASSED"); process.exit(bad ? 1 : 0);
