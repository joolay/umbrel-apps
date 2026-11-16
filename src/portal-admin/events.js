"use strict";
// Upcoming events for the dashboard ticker.
//
// An event is { id, kind, title, sub, date: "YYYY-MM-DD", time?: "HH:MM", allDay, source, link? }.
// Providers add events for one person; the dashboard just shows whatever they return, soonest first.
//   - birthdays: built in. Everyone in the person's circle (household, extended relatives, and the households they are extended family of).
//   - portal_events: the hook for the Organiser app (family events, notices, school pickups...). Organiser writes rows into the PocketBase
//     collection `portal_events` and they show up here with no change to Portal Admin. See README, "Events and the Organiser".
const pb = require("./pocketbase");
const family = require("./family");

const q = s => encodeURIComponent(s);
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const dayDiff = (a, b) => Math.round((b - a) / 86400000);
const first = n => String(n || "").trim().split(/\s+/)[0] || "Someone";

async function birthdays(user, today, days, circle) {
  const out = [];
  for (const id of circle.ids) {
    const u = id === user.id ? user : await pb.getUser(id).catch(() => null);
    const dob = u && u.dob ? parseDay(u.dob) : null; if (!dob) continue;
    const m = dob.getUTCMonth(), d = dob.getUTCDate();
    for (const yr of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
      let when = new Date(Date.UTC(yr, m, d));
      if (when.getUTCMonth() !== m) when = new Date(Date.UTC(yr, m, 28));   // 29 February in a year without one
      const n = dayDiff(today, when);
      if (n < 0 || n > days) continue;
      const age = yr - dob.getUTCFullYear(), mine = id === user.id;
      out.push({ id: "bday:" + id + ":" + yr, kind: "birthday", title: mine ? "Your birthday" : first(u.name || String(u.email || "").split("@")[0]) + "'s birthday", sub: "turns " + age, date: ymd(when), allDay: true, source: "birthdays" });
      break;
    }
  }
  return out;
}

// Organiser events. Optional: if the collection does not exist yet this returns nothing.
async function organiser(user, today, days, circle) {
  const to = new Date(today.getTime() + days * 86400000);
  let j; try { j = await pb.asSuper("GET", `/api/collections/portal_events/records?perPage=200&sort=start&filter=${q(`start >= '${ymd(today)}' && start <= '${ymd(to)} 23:59:59'`)}`); }
  catch (e) { return []; }
  const fam = new Set(circle.familyIds);
  return (j.items || []).filter(r => (!r.familyId && !r.userIds) || (r.familyId && fam.has(r.familyId)) || String(r.userIds || "").includes("," + user.id + ",") || String(r.userIds || "") === user.id)
    .map(r => ({ id: "ev:" + r.id, kind: String(r.kind || "event"), title: String(r.title || "Event").slice(0, 120), sub: String(r.sub || "").slice(0, 120), date: String(r.start).slice(0, 10), time: /\d{2}:\d{2}/.test(String(r.start)) ? String(r.start).slice(11, 16) : "", allDay: !/\d{2}:\d{2}/.test(String(r.start)), source: String(r.source || "organiser"), link: r.link || "" }));
}

async function upcoming(user, todayStr, days = 60) {
  const today = parseDay(todayStr) || parseDay(new Date().toISOString());
  const circle = await family.circleIds(user).catch(() => ({ ids: new Set([user.id]), familyIds: [] }));
  const lists = await Promise.all([birthdays(user, today, days, circle), organiser(user, today, days, circle)].map(p => p.catch(() => [])));
  return lists.flat().sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))).slice(0, 40);
}
module.exports = { upcoming };
