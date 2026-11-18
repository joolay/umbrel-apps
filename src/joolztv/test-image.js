// Every file the server loads must be copied into the runtime image (a missing one made the app crash at start-up in production while the tests, which run from the source folder, passed).
"use strict";
const fs = require("fs"), path = require("path");
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } else console.log("ok  ", m); };
const docker = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8"), runtime = docker.slice(docker.lastIndexOf("FROM "));
const copied = new Set(); runtime.split("\n").filter(l => /^COPY\s/.test(l) && !/--from=/.test(l)).forEach(l => { const p = l.replace(/^COPY\s+/, "").trim().split(/\s+/); p.pop(); p.forEach(f => copied.add(path.normalize(f))); });
const seen = new Set(), walk = (file) => {
  if (seen.has(file)) return; seen.add(file);
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    let f = path.normalize(path.join(path.dirname(file), m[1])); if (!/\.\w+$/.test(f)) f += ".js";
    if (/test/.test(f)) continue;
    ok(fs.existsSync(path.join(__dirname, f)), file + " requires " + f + " (exists)");
    ok(copied.has(f), f + " is copied into the runtime image");
    if (fs.existsSync(path.join(__dirname, f))) walk(f);
  }
};
walk("server.js"); walk("make-clips.js");
console.log(bad ? bad + " FAILED" : "ALL PASSED"); process.exit(bad ? 1 : 0);
