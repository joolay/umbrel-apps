'use strict';
// The device <-> Claude handshake an app shows in its top bar (two hands: device on the left, AI on the right).
// Files in the feed repo (joolay/tracking-data):
//   status/<app>.json         written by Portal Admin for the app: { at (last write), changedAt (last real change), rev (counts real changes), seenClaude (the last Claude message rev it has read), data }
//   status/claude-<app>.json  written only by Claude: { toApp: { rev, at, note }  (a change Claude made for the app),
//                                                       seen: { deviceRev, at }    (the newest device change Claude has read) }
// Meaning of the icon:
//   both hands green  = the last change was written AND the other side has read it
//   one hand green    = the last change was written by that side (left = device, right = AI) and has not been read yet
//   hands not shaking = broken: the app was expected to report (every 30 minutes at most) and nothing has come through
const STALE_MS = 35 * 60e3;
const ms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

function linkState({ device, claude, now = Date.now(), staleMs = STALE_MS }) {
  const d = device || null, c = claude && typeof claude === 'object' ? claude : {};
  const toApp = c.toApp && typeof c.toApp === 'object' ? c.toApp : null, seen = c.seen && typeof c.seen === 'object' ? c.seen : null;
  const dAt = d ? ms(d.at) : 0, dChanged = d ? ms(d.changedAt) || dAt : 0, cAt = toApp ? ms(toApp.at) : 0;
  const connected = !!d && dAt > 0 && now - dAt <= staleMs;
  const lastEdit = !d && !toApp ? null : cAt > dChanged ? 'ai' : 'device';
  let read = false;
  if (lastEdit === 'device') read = !!seen && Number(seen.deviceRev) >= Number(d.rev || 0);
  else if (lastEdit === 'ai') read = !!d && Number(d.seenClaude || 0) >= Number(toApp.rev || 0);
  const state = !connected ? 'broken' : read ? 'both' : lastEdit === 'ai' ? 'ai' : 'device';   // 'device' / 'ai' = only that side's hand is green
  return { state, shaking: connected, lastEdit, read, connected, deviceAt: dAt || null, changedAt: dChanged || null, claudeAt: cAt || null,
    note: !connected ? (d ? 'No report from the app for ' + Math.round((now - dAt) / 60e3) + ' minutes (expected at least every 30).' : 'The app has not reported yet.')
      : read ? 'Last change was read by the other side.' : lastEdit === 'ai' ? 'Claude changed something; the app has not read it yet.' : 'The app changed something; Claude has not read it yet.' };
}
module.exports = { linkState, STALE_MS };
