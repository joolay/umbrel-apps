// How much to buffer before starting, for different download speeds compared with the video's bitrate.
"use strict";
const Buf = require("./ui/js/buffer.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const MB = 1e6, bit = 2.5 * MB / 8 * 8;                       // a 20 Mbit/s film = 2.5 MB/s
const p = (speed, extra) => Buf.plan(Object.assign({ bitrate: 2.5 * MB, speed, duration: 7200 }, extra || {}));
const fast = p(15 * MB), good = p(6 * MB), ok2 = p(3.2 * MB), edge = p(2.5 * MB), slow = p(1.5 * MB), dead = p(0.2 * MB);
ok(fast.startSecs <= 6 && fast.lowSecs <= 2, "6x real time: start almost at once (" + fast.startSecs + " s buffer)");
ok(good.startSecs > fast.startSecs && good.startSecs <= 12, "2.4x real time: a short buffer (" + good.startSecs + " s)");
ok(ok2.startSecs > good.startSecs && ok2.startSecs <= 25, "1.3x real time: a longer buffer (" + ok2.startSecs + " s)");
ok(edge.startSecs >= 30 && !edge.slow, "just keeping up (1x): a large buffer (" + edge.startSecs + " s)");
ok(slow.slow && slow.startSecs === 60 && /slower/.test(slow.note), "slower than real time on a long film: the biggest buffer (60 s) and a warning");
const shortSlow = Buf.plan({ bitrate: 29000, speed: 24000, duration: 90 });
ok(shortSlow.slow && shortSlow.startSecs >= 25 && shortSlow.startSecs <= 35, "slower than real time on a short file: only what is needed to play through (" + shortSlow.startSecs + " s), not a fixed minute");
ok(fast.startSecs < good.startSecs && good.startSecs < ok2.startSecs && ok2.startSecs < edge.startSecs && edge.startSecs <= slow.startSecs, "the slower the download, the more is buffered, never less");
ok(dead.startSecs <= 90 && dead.maxWait <= 90, "never asks for more than 90 s or waits more than 90 s");
ok(fast.resumeSecs >= fast.startSecs && slow.resumeSecs >= slow.lowSecs * 5, "after a stall it rebuilds a bigger buffer than the low-water mark");
const unk = Buf.plan({ duration: 7200 }); ok(unk.startSecs === 10 && /measuring/.test(unk.note), "speed not known yet: a modest 10 s buffer while measuring");
const viaFill = Buf.plan({ fill: 3 }); ok(viaFill.ratio === 3 && viaFill.startSecs === 10, "without torrent stats, the measured buffer fill rate is used instead");
const quick = p(3.2 * MB, { mode: "quick" }), safe = p(3.2 * MB, { mode: "safe" });
ok(quick.startSecs < ok2.startSecs && safe.startSecs > ok2.startSecs && safe.startSecs <= 90, "quick start waits less, safe waits more (" + quick.startSecs + " / " + ok2.startSecs + " / " + safe.startSecs + " s)");
ok(Buf.fmtSpeed(2.34 * MB) === "2.3 MB/s" && Buf.fmtSpeed(420000) === "420 KB/s" && Buf.fmtSpeed(0) === "", "speed text");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
