// Skip points from the community databases (nothing is detected here): IntroDB (IMDb ids; intro, recap, outro, post-credit scene) and
// TheIntroDB (TVDB/TMDB/IMDb ids; intro, recap, credits, preview). Both answer anonymous reads. Only the IMDb id, season and episode are sent.
"use strict";
const INTRODB = process.env.INTRODB_URL || "https://api.introdb.app";
const THEINTRODB = process.env.THEINTRODB_URL || "https://api.theintrodb.org/v4";
const UA = "JoolzTV";

async function getJSON(url, ms = 6000) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
  return r.json();
}
const sec = ms => (typeof ms === "number" && isFinite(ms) ? Math.round(ms) / 1000 : null);

/* what each service says, as {intro:{start,end}|null, credits:[{start,end}], scenes:[start]} in seconds */
function fromIntroDb(j) {
  const o = { intro: null, credits: [], scenes: [] }; if (!j) return o;
  if (j.intro && j.intro.start_ms != null && !j.no_intro) o.intro = { start: sec(j.intro.start_ms), end: sec(j.intro.end_ms), conf: j.intro.confidence || 0 };
  if (j.outro && j.outro.start_ms != null) o.credits.push({ start: sec(j.outro.start_ms), end: sec(j.outro.end_ms) });
  if (j.post_credits && j.post_credits.start_ms != null) o.scenes.push(sec(j.post_credits.start_ms));
  return o;
}
function fromTheIntroDb(j) {
  const o = { intro: null, credits: [], scenes: [] }; if (!j) return o;
  const i = (j.intro || [])[0]; if (i && i.end_ms != null) o.intro = { start: sec(i.start_ms == null ? 0 : i.start_ms), end: sec(i.end_ms), conf: 0.5 };
  o.credits = (j.credits || []).filter(c => c.start_ms != null).map(c => ({ start: sec(c.start_ms), end: sec(c.end_ms) })).sort((a, b) => a.start - b.start);
  return o;
}
/* put the answers together, throwing out anything that makes no sense for a file of this length */
function merge(parts, duration) {
  const d = duration > 0 ? duration : 0, out = { intro: null, credits: null, scenes: [], from: [] };
  const okIntro = i => i && i.end > i.start && i.end - i.start >= 5 && i.end - i.start <= 300 && (!d || (i.start < d * 0.4 && i.end < d * 0.6));
  const intros = parts.map(p => p.o.intro).filter(okIntro).sort((a, b) => b.conf - a.conf);
  if (intros.length) { out.intro = { start: intros[0].start, end: intros[0].end }; }
  const okCred = c => c && isFinite(c.start) && (!d || (c.start > d * 0.5 && c.start < d - 5));
  for (const p of parts) {
    const cs = p.o.credits.filter(okCred);
    if (!cs.length) continue;
    if (!out.credits || cs[0].start < out.credits.start - 1) out.credits = { start: cs[0].start };
    // credits that stop and start again (with a gap of 10 s to 10 min) leave room for a scene in the middle of them
    for (let k = 0; k + 1 < cs.length; k++) { const gap = cs[k + 1].start - cs[k].end; if (cs[k].end != null && gap >= 10 && gap <= 600) out.scenes.push(cs[k].end); }
  }
  for (const p of parts) for (const s of p.o.scenes) if (isFinite(s) && (!d || (s > d * 0.5 && s < d - 3))) out.scenes.push(s);
  out.scenes = Array.from(new Set(out.scenes.map(x => Math.round(x)))).sort((a, b) => a - b).filter((x, i, a) => i === 0 || x - a[i - 1] > 15);
  out.from = parts.filter(p => p.o.intro || p.o.credits.length || p.o.scenes.length).map(p => p.name);
  return out;
}
/* imdb: tt…; season/episode for a series; movie when season is null */
async function lookup({ imdb, season, episode, duration }) {
  if (!/^tt\d{5,12}$/.test(imdb)) return { intro: null, credits: null, scenes: [], from: [] };
  const tv = Number.isInteger(season) && Number.isInteger(episode);
  const q1 = "imdb_id=" + imdb + (tv ? "&season=" + season + "&episode=" + episode : "&is_movie=true");
  const q2 = "imdb_id=" + imdb + (tv ? "&season=" + season + "&episode=" + episode : "") + (duration > 0 ? "&duration_ms=" + Math.round(duration * 1000) : "");
  const [a, b] = await Promise.all([
    getJSON(INTRODB + "/segments?" + q1).then(fromIntroDb, () => null),
    getJSON(THEINTRODB + "/media?" + q2).then(fromTheIntroDb, () => null)]);
  if (!a && !b) { const e = new Error("The skip databases could not be reached"); e.code = "unreachable"; throw e; }
  return merge([{ name: "IntroDB", o: a || fromIntroDb(null) }, { name: "TheIntroDB", o: b || fromTheIntroDb(null) }], duration);
}
module.exports = { lookup, merge, fromIntroDb, fromTheIntroDb };
