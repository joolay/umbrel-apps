"use strict";
const assert = require("assert"), make = require("./github");
// A tiny fake of GitHub's contents API: one file, sha changes on every write, ETag support, optional "someone else wrote first".
function fakeGitHub(initial) {
  const s = { file: initial ? JSON.stringify(initial) : null, sha: initial ? "s1" : null, n: 1, calls: [], raceOnce: false };
  s.fetch = async (u, init = {}) => {
    const method = init.method || "GET"; s.calls.push(method + " " + u.replace("https://api.github.com", ""));
    const R = (status, body, h = {}) => ({ status, ok: status < 400, json: async () => body, headers: { get: k => h[k.toLowerCase()] || null } });
    if (/\/commits\?/.test(u)) return R(200, [{ commit: { committer: { date: "2026-11-18T10:00:00Z" } } }]);
    if (u.endsWith("/repos/joolay/tracking-data")) return R(200, {});
    if (method === "GET") {
      if (s.file === null) return R(404, { message: "Not Found" });
      if (init.headers["if-none-match"] === '"e' + s.sha + '"') return R(304, {});
      return R(200, { sha: s.sha, content: Buffer.from(s.file).toString("base64") }, { etag: '"e' + s.sha + '"' });
    }
    const b = JSON.parse(init.body);
    if (s.raceOnce) { s.raceOnce = false; s.file = JSON.stringify({ projects: [{ id: "other", name: "Other" }] }); s.sha = "s" + (++s.n); }
    if ((b.sha || null) !== s.sha) return R(409, { message: "sha does not match" });
    s.file = Buffer.from(b.content, "base64").toString("utf8"); s.sha = "s" + (++s.n); return R(200, { content: { sha: s.sha } });
  };
  return s;
}
(async () => {
  let t = 0; const cfg = { repo: "joolay/tracking-data", path: "appdev.json", token: "tok" };
  // reading: unchanged checks come back from the cache, and a changed file is picked up
  let g = fakeGitHub({ projects: [{ id: "a", name: "A" }] }), gh = make({ getConfig: async () => cfg, fetchImpl: g.fetch, now: () => t, minGapMs: 3000 });
  let r = await gh.read(); assert.strictEqual(r.sha, "s1"); t += 1000; await gh.read(); assert.strictEqual(g.calls.length, 1, "inside the gap: no request");
  t += 5000; r = await gh.read(); assert.strictEqual(g.calls.length, 2); assert.strictEqual(r.sha, "s1");
  g.file = JSON.stringify({ projects: [] }); g.sha = "s9"; t += 5000; r = await gh.read(); assert.strictEqual(r.sha, "s9", "a change is noticed");
  // writing: reads first, applies to the newest copy, sends the sha
  g = fakeGitHub({ projects: [{ id: "a", name: "A" }] }); gh = make({ getConfig: async () => cfg, fetchImpl: g.fetch, now: () => t });
  await gh.write(d => ({ projects: [...d.projects, { id: "b", name: "B" }] }), "add b"); assert.strictEqual(JSON.parse(g.file).projects.length, 2);
  // someone else wrote in between: we re-read and keep their change as well as ours
  g.raceOnce = true; await gh.write(d => ({ projects: [...d.projects, { id: "c", name: "C" }] }));
  assert.deepStrictEqual(JSON.parse(g.file).projects.map(p => p.id), ["other", "c"]);
  // a new list (404) is created
  g = fakeGitHub(null); gh = make({ getConfig: async () => cfg, fetchImpl: g.fetch, now: () => t }); await gh.write(d => ({ projects: [{ id: "n", name: "N" }], was: d })); assert.strictEqual(JSON.parse(g.file).was, null);
  // no token: reading works, writing says why not
  gh = make({ getConfig: async () => ({ repo: cfg.repo, path: cfg.path }), fetchImpl: g.fetch, now: () => t });
  assert.ok((await gh.read(true)).data); await assert.rejects(() => gh.write(d => d), e => e.code === "read_only");
  // commit dates for the 3-day rule
  assert.strictEqual(await gh.lastCommit("joolay/umbrel-apps", "src/x", 60000), "2026-11-18");
  console.log("github ok");
})().catch(e => { console.error(e); process.exit(1); });
