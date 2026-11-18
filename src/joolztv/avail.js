// "Does this title have at least one source?" Asks the household's sources add-on (the same one that plays things) and remembers the answer.
// A title the add-on says has nothing is dropped from lists. If the add-on cannot be asked (down, slow), the title is left in: only a real "nothing found" hides it.
"use strict";
const YES_MS = 6 * 3600e3, NO_MS = 1 * 3600e3, MAX = 4000;
const cache = new Map();                                              // "type:imdb" -> { ok, at }
function make({ tmdb, fetchImpl }) {
  const get = fetchImpl || ((u, o) => fetch(u, o));
  async function has(base, imdb, type) {                              // true / false / null (could not find out)
    const key = type + ":" + imdb, c = cache.get(key);
    if (c && Date.now() - c.at < (c.ok ? YES_MS : NO_MS)) return c.ok;
    try {
      const r = await get(base + "/stream/" + type + "/" + encodeURIComponent(type === "series" ? imdb + ":1:1" : imdb) + ".json", { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j = await r.json(), ok = Array.isArray(j.streams) && j.streams.length > 0;
      if (cache.size >= MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { ok, at: Date.now() }); return ok;
    } catch { return null; }
  }
  /* items: cards { tmdb, type, poster }. Keeps what has a source (or might: unknown + has artwork); a title with no artwork must be confirmed. */
  async function filter(items, { base, budgetMs = 7000, workers = 8 } = {}) {
    if (!base || !items.length) return items;
    const verdict = new Array(items.length).fill(null), until = Date.now() + budgetMs; let next = 0;
    async function work() {
      while (next < items.length && Date.now() < until) {
        const i = next++, it = items[i];
        try { const r = await tmdb.resolve({ tmdb: it.tmdb, type: it.type }); verdict[i] = await has(base, r.imdb, r.type); } catch { verdict[i] = null; }
      }
    }
    await Promise.race([Promise.all(Array.from({ length: workers }, work)), new Promise(r => setTimeout(r, budgetMs))]);
    return items.filter((it, i) => verdict[i] === true || (verdict[i] === null && !!it.poster));
  }
  return { has, filter, _cache: cache };
}
module.exports = { make };
