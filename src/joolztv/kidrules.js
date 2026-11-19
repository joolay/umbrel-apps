"use strict";
/* Kids' screen time and the parents' lists, as plain functions on the household record (server.js reads and writes the file).
   household.kidsAll            = { dailyMin, windDown }          the "All kids" setting
   profile.limits               = { dailyMin?, windDown? }        one kid's own value; it wins over All kids (missing = follows All kids)
   household.hidden             = { <imdb>: {name,type,poster,ts} } hidden from every kid; only Settings can undo it
   profile.recommended          = { <imdb>: {name,type,poster,ts,by} }
   household.usage[profileId]   = { "YYYY-MM-DD": seconds actually played }          (play time only: paused, browsing and menus do not count)
   household.watch[profileId]   = { <imdb>: {name,type,poster,pct,at,ep?} }          what they watched, how far and when
   profile.ext                  = { until, minutes }                                  a parent's extension (time of day and daily limit are lifted until `until`) */
const WARN = [15, 10, 5];
const DAILY_CHOICES = [30, 45, 60, 90, 120, 150, 180, 240];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EXTEND_CHOICES = [15]                 // one 15-minute step; a parent types the code again when it runs out;

/* local date and minutes since midnight in the household's time zone */
function clock(ts, tz) {
  let parts; try { parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ts)); }
  catch { parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ts)); }
  const g = t => (parts.find(p => p.type === t) || {}).value;
  return { date: g("year") + "-" + g("month") + "-" + g("day"), min: (parseInt(g("hour"), 10) % 24) * 60 + parseInt(g("minute"), 10) };
}
const toMin = t => TIME_RE.test(t || "") ? parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10) : null;

/* the values in force for a kid: its own, else All kids, else none */
function effective(h, p) {
  const all = h.kidsAll || {}, own = p.limits || {}, pick = k => (own[k] != null ? { v: own[k], custom: true } : all[k] != null ? { v: all[k], custom: false } : { v: null, custom: false });
  const d = pick("dailyMin"), w = pick("windDown");
  return { dailyMin: d.v, dailyCustom: d.custom, windDown: w.v, windCustom: w.custom };
}
const usedToday = (h, id, date) => Math.round(((h.usage && h.usage[id] && h.usage[id][date]) || 0));

/* can they play now, and how many minutes are left before it stops? */
function status(h, p, now, tz) {
  const e = effective(h, p), c = clock(now, tz), used = usedToday(h, p.id, c.date);
  if (p.ext && p.ext.until > now) return { allowed: true, extended: true, remaining: (p.ext.until - now) / 60000, reason: "extended", limit: e.dailyMin, windDown: e.windDown, usedMin: used / 60 };
  let remaining = Infinity, reason = null;
  const wd = toMin(e.windDown);
  if (wd != null) { const left = wd - c.min; remaining = left; reason = "winddown"; }
  if (e.dailyMin != null) { const left = e.dailyMin - used / 60; if (left < remaining) { remaining = left; reason = "limit"; } }
  if (remaining === Infinity) return { allowed: true, remaining: null, reason: null, limit: null, windDown: null, usedMin: used / 60 };
  return { allowed: remaining > 0, remaining: Math.max(0, remaining), reason, limit: e.dailyMin, windDown: e.windDown, usedMin: used / 60 };
}
/* the warning the player should show now (15, 10 or 5), given the minutes left and the ones already shown */
function warning(remaining, shown) {
  if (remaining == null) return null;
  for (const w of WARN.slice().reverse()) if (remaining <= w && !(shown || []).includes(w)) return w;   // the smallest threshold crossed that has not been shown
  return null;
}

/* play time: add the seconds since the last tick, capped so a stalled device cannot add a lot at once */
function addPlay(h, id, seconds, now, tz) {
  const s = Math.max(0, Math.min(90, Math.round(seconds))), c = clock(now, tz);
  h.usage = h.usage || {}; const u = h.usage[id] = h.usage[id] || {}; u[c.date] = (u[c.date] || 0) + s;
  for (const d of Object.keys(u).sort().slice(0, -14)) delete u[d];            // two weeks are kept
  return u[c.date];
}
function noteWatch(h, id, t, now) {
  const imdb = String(t.imdb || ""); if (!/^tt\d{5,12}$/.test(imdb)) return false;
  h.watch = h.watch || {}; const w = h.watch[id] = h.watch[id] || {};
  const pct = Math.max(0, Math.min(1, Number(t.pct) || 0));
  const prev = w[imdb], ep = t.ep && /^S\d{1,3}E\d{1,4}$/.test(t.ep) ? t.ep : undefined;
  w[imdb] = { name: String(t.name || (prev && prev.name) || "").slice(0, 120), type: t.type === "series" ? "series" : "movie", poster: /^https:\/\/[^\s"'<>]{4,300}$/.test(t.poster || "") ? t.poster : (prev && prev.poster) || "", pct: Math.round(pct * 100) / 100, at: now, ep };
  const keys = Object.keys(w); if (keys.length > 60) { keys.sort((a, b) => w[a].at - w[b].at).slice(0, keys.length - 60).forEach(k => delete w[k]); }
  return true;
}
function setLimits(h, target, patch) {            // target: a profile, or null for All kids. patch values: number/time to set, null to clear (a kid then follows All kids again)
  const box = target ? (target.limits = target.limits || {}) : (h.kidsAll = h.kidsAll || {});
  if ("dailyMin" in patch) { if (patch.dailyMin === null) delete box.dailyMin; else if (Number.isInteger(patch.dailyMin) && patch.dailyMin >= 10 && patch.dailyMin <= 720) box.dailyMin = patch.dailyMin; else return "Pick a daily limit between 10 minutes and 12 hours."; }
  if ("windDown" in patch) { if (patch.windDown === null) delete box.windDown; else if (TIME_RE.test(patch.windDown)) box.windDown = patch.windDown; else return "Winding-down time is a time of day like 19:30."; }
  if (target && !Object.keys(box).length) delete target.limits;
  return "";
}
function hide(h, t, now) { const imdb = String(t.imdb || ""); if (!/^tt\d{5,12}$/.test(imdb)) return false; h.hidden = h.hidden || {}; if (!h.hidden[imdb] && Object.keys(h.hidden).length >= 500) return false; h.hidden[imdb] = { name: String(t.name || "").slice(0, 120), type: t.type === "series" ? "series" : "movie", poster: /^https:\/\/[^\s"'<>]{4,300}$/.test(t.poster || "") ? t.poster : "", ts: now }; return true; }
function unhide(h, imdb) { if (h.hidden && h.hidden[imdb]) { delete h.hidden[imdb]; return true; } return false; }
function recommend(p, t, now, by) { const imdb = String(t.imdb || ""); if (!/^tt\d{5,12}$/.test(imdb)) return false; p.recommended = p.recommended || {}; if (!p.recommended[imdb] && Object.keys(p.recommended).length >= 60) return false; p.recommended[imdb] = { name: String(t.name || "").slice(0, 120), type: t.type === "series" ? "series" : "movie", poster: /^https:\/\/[^\s"'<>]{4,300}$/.test(t.poster || "") ? t.poster : "", ts: now, by: String(by || "").slice(0, 16) }; return true; }
function extend(p, minutes, now) { if (!EXTEND_CHOICES.includes(minutes)) return false; p.ext = { until: now + minutes * 60000, minutes }; return true; }

module.exports = { WARN, DAILY_CHOICES, EXTEND_CHOICES, clock, effective, status, warning, addPlay, noteWatch, setLimits, hide, unhide, recommend, extend, usedToday };
