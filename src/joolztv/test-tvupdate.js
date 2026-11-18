// /tv/update: latest launcher version from the Homebrew manifest, cached, stale copy on errors, junk ignored.
"use strict";
const http = require("http");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
let body = { id: "io.stremio.flix.tv", version: "2.1.0" }, code = 200, hits = 0;
const srv = http.createServer((q, r) => { hits++; r.writeHead(code); r.end(typeof body === "string" ? body : JSON.stringify(body)); });
(async () => {
  await new Promise(r => srv.listen(0, r));
  process.env.TV_MANIFEST_URL = "http://127.0.0.1:" + srv.address().port + "/m.json"; process.env.TV_UPDATE_TTL_MS = "60000";
  const T = require("./tvupdate");
  let l = await T.latest(); ok(l.id === "io.stremio.flix.tv" && l.version === "2.1.0", "reads the newest version from the manifest");
  await T.latest(); ok(hits === 1, "a second ask is answered from the cache");
  T._reset(); code = 500; l = await T.latest(); ok(l.version === null, "feed down and nothing cached: version is null, no error");
  T._reset(); code = 200; await T.latest(); code = 500; T._reset(); body = { id: "io.stremio.flix.tv", version: "9.9.9" }; code = 200; l = await T.latest(); ok(l.version === "9.9.9", "a new manifest is picked up after a reset");
  T._reset(); body = { id: "io.stremio.flix.tv", version: "1.0; rm -rf" }; l = await T.latest(); ok(l.version === null, "a version that is not digits and dots is dropped");
  T._reset(); body = { id: "other.app", version: "1.0.0" }; l = await T.latest(); ok(l.version === null, "a manifest for another app is ignored");
  T._reset(); body = "not json"; l = await T.latest(); ok(l.version === null, "junk is ignored");
  srv.close(); process.exit(fails ? 1 : 0);
})();
