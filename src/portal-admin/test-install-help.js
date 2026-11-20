"use strict";
const assert = require("assert"), H = require("./public/install-help.js");
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  ff: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
};
const k = (ua, platform = "", touch = 0) => H.detect({ ua, platform, touch }).kind;
assert.strictEqual(k(UA.iphone), "ios-safari"); assert.strictEqual(k(UA.iphoneChrome), "ios-other");
assert.strictEqual(k(UA.mac, "MacIntel", 5), "ios-safari", "an iPad that poses as a Mac is still an iPad");
assert.strictEqual(k(UA.mac, "MacIntel", 0), "desktop-safari");
assert.strictEqual(k(UA.android), "android-chrome"); assert.strictEqual(k(UA.win), "desktop-chrome"); assert.strictEqual(k(UA.edge), "desktop-edge"); assert.strictEqual(k(UA.ff), "desktop-firefox");
assert.strictEqual(k(""), "other");
for (const kind of ["ios-safari", "ios-other", "android-chrome", "android-firefox", "desktop-chrome", "desktop-edge", "desktop-safari", "desktop-firefox", "other"]) assert.ok(H.steps({ kind }).length >= 2, kind);
assert.ok(H.signInNote(H.detect({ ua: UA.iphone })).includes("own sign-in")); assert.strictEqual(H.signInNote(H.detect({ ua: UA.win })), "");
const app = { enabled: true, url: "https://tracker.example.ts.net" };
assert.strictEqual(H.blocker(app, true), "");
assert.ok(H.blocker(app, false).includes("access")); assert.ok(H.blocker({ ...app, enabled: false }, true)); assert.ok(H.blocker({ ...app, maintenance: true }, true).includes("maintenance"));
assert.ok(H.blocker({ ...app, url: "http://192.168.1.5:3000" }, true).includes("home-network")); assert.ok(H.blocker({ ...app, url: "" }, true).includes("no address"));
console.log("install-help ok");
