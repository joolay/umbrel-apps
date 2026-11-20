"use strict";
// Project Pilot <-> a JSON file in a GitHub repo (the shared "appdev" list). No dependencies: GitHub's REST API over fetch.
// Reading uses ETag checks, so asking again while nothing changed costs nothing against the rate limit. Every write first reads the
// newest copy, applies the change to it and sends it back with the file's sha; if someone else got in first GitHub refuses, and we read again and retry.
// Reading a public repo needs no token. Writing always does: a fine-grained token limited to the data repo (Contents: read and write).
class GitHubError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status || 0; } }
const b64 = s => Buffer.from(s, "utf8").toString("base64"), unb64 = s => Buffer.from(String(s).replace(/\n/g, ""), "base64").toString("utf8");

module.exports = function makeGitHub({ getConfig, fetchImpl = fetch, now = Date.now, minGapMs = 3000 }) {
  const cache = new Map();   // "repo|path|ref" -> { sha, data, etag, at }
  const key = c => [c.repo, c.path, c.branch || ""].join("|");
  const headers = (c, extra) => ({ accept: "application/vnd.github+json", "user-agent": "joolzapp-project-tracker", "x-github-api-version": "2022-11-28", ...(c.token ? { authorization: "Bearer " + c.token } : {}), ...extra });
  const url = c => `https://api.github.com/repos/${c.repo}/contents/${c.path.split("/").map(encodeURIComponent).join("/")}`;
  async function call(u, init) {
    try { return await fetchImpl(u, { ...init, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new GitHubError("unreachable", "Can't reach GitHub (" + (e.cause && e.cause.code || e.message) + ")."); }
  }
  async function fail(r) {
    let m = ""; try { m = (await r.json()).message || ""; } catch {}
    if (r.status === 401) return new GitHubError("bad_token", "GitHub refused the token. Paste a new one in the Connection panel.", 401);
    if (r.status === 403 && /rate limit/i.test(m)) return new GitHubError("rate_limited", "GitHub says too many requests. It will try again shortly.", 403);
    if (r.status === 403) return new GitHubError("no_permission", "The token can't write to that repo. It needs Contents: read and write on it.", 403);
    if (r.status === 404) return new GitHubError("not_found", "GitHub can't find that repo or file. Check the repo name, and that the token can see it.", 404);
    return new GitHubError("github_error", "GitHub answered " + r.status + (m ? ": " + m : "") + ".", r.status);
  }
  // Newest copy of the file. `force` skips the minimum gap (writes always do).
  async function read(force) {
    const c = await getConfig(); if (!c || !c.repo || !c.path) throw new GitHubError("not_configured", "No GitHub list is set up yet.");
    const k = key(c), prev = cache.get(k);
    if (prev && !force && now() - prev.at < minGapMs) return prev;
    const r = await call(url(c) + (c.branch ? "?ref=" + encodeURIComponent(c.branch) : ""), { headers: headers(c, prev && prev.etag ? { "if-none-match": prev.etag } : {}) });
    if (r.status === 304 && prev) { prev.at = now(); return prev; }
    if (r.status === 404) { const e = { sha: null, data: null, etag: "", at: now() }; cache.set(k, e);
      // 404 on the file is normal for a brand new list. 404 on the repo is a mistake worth telling.
      const rr = await call(`https://api.github.com/repos/${c.repo}`, { headers: headers(c) }); if (rr.status === 404 && !c.token) throw await fail(rr); return e; }
    if (!r.ok) throw await fail(r);
    const j = await r.json(); let data = null;
    try { data = JSON.parse(unb64(j.content)); } catch { throw new GitHubError("bad_file", "That file in GitHub isn't valid JSON, so nothing was changed."); }
    const e = { sha: j.sha, data, etag: r.headers.get("etag") || "", at: now() }; cache.set(k, e); return e;
  }
  // mutate(currentData|null) -> newData. Retries when the file changed under us.
  async function write(mutate, message) {
    const c = await getConfig(); if (!c || !c.repo || !c.path) throw new GitHubError("not_configured", "No GitHub list is set up yet.");
    if (!c.token) throw new GitHubError("read_only", "This list is read-only here until a GitHub token is added in the Connection panel.");
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await read(true), next = mutate(cur.data);
      const body = { message: message || "Update project list", content: b64(JSON.stringify(next, null, 2) + "\n"), ...(cur.sha ? { sha: cur.sha } : {}), ...(c.branch && cur.sha ? { branch: c.branch } : {}) };
      const r = await call(url(c), { method: "PUT", headers: headers(c, { "content-type": "application/json" }), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) { cache.delete(key(c)); continue; }   // somebody changed it first: read again, apply again
      if (!r.ok) throw await fail(r);
      const j = await r.json(); const e = { sha: j.content && j.content.sha, data: next, etag: "", at: now() }; cache.set(key(c), e); return e;
    }
    throw new GitHubError("conflict", "The list kept changing while saving. Try again in a moment.");
  }
  // Date of the newest commit that touched a path (for the 3-day rule). null when unknown.
  const commitCache = new Map();
  // anon: never send the owner's token (other people's lists must not be able to look at the owner's private repos).
  async function lastCommit(repo, path, ttlMs, anon) {
    const c = anon ? {} : await getConfig(), k = (anon ? "anon|" : "") + repo + "|" + path, hit = commitCache.get(k);
    if (hit && now() - hit.at < ttlMs) return hit.day;
    const r = await call(`https://api.github.com/repos/${repo}/commits?per_page=1&path=${encodeURIComponent(path)}`, { headers: headers(c || {}) });
    if (!r.ok) { commitCache.set(k, { at: now(), day: hit ? hit.day : null }); return hit ? hit.day : null; }
    const j = await r.json(), d = j[0] && j[0].commit && (j[0].commit.committer && j[0].commit.committer.date || j[0].commit.author && j[0].commit.author.date);
    const day = d ? String(d).slice(0, 10) : null; commitCache.set(k, { at: now(), day }); return day;
  }
  return { read, write, lastCommit, GitHubError };
};
module.exports.GitHubError = GitHubError;
