'use strict';
const assert = require('assert'), { linkState } = require('./claudelink');
const T = Date.parse('2026-11-21T12:00:00Z'), min = (n) => new Date(T - n * 60e3).toISOString();
const dev = (o) => ({ rev: 5, at: min(2), changedAt: min(10), seenClaude: 0, ...o });
let s;
// the app wrote last, Claude has not read it: only the device (left) hand is green, still shaking
s = linkState({ device: dev(), claude: { seen: { deviceRev: 4, at: min(300) } }, now: T }); assert.deepStrictEqual([s.state, s.shaking, s.lastEdit, s.read], ['device', true, 'device', false]);
// Claude read it: both green
s = linkState({ device: dev(), claude: { seen: { deviceRev: 5, at: min(1) } }, now: T }); assert.deepStrictEqual([s.state, s.shaking, s.read], ['both', true, true]);
// Claude changed something after the app's last change; the app has not read it: only the AI (right) hand is green
s = linkState({ device: dev(), claude: { toApp: { rev: 3, at: min(5), note: 'x' }, seen: { deviceRev: 5, at: min(30) } }, now: T }); assert.deepStrictEqual([s.state, s.lastEdit, s.read], ['ai', 'ai', false]);
// ...and once the app has read it: both
s = linkState({ device: dev({ seenClaude: 3 }), claude: { toApp: { rev: 3, at: min(5) } }, now: T }); assert.strictEqual(s.state, 'both');
// the app changed again after Claude's change: the device is the last editor again
s = linkState({ device: dev({ changedAt: min(1), rev: 6, seenClaude: 3 }), claude: { toApp: { rev: 3, at: min(5) }, seen: { deviceRev: 5 } }, now: T }); assert.deepStrictEqual([s.state, s.lastEdit], ['device', 'device']);
// a heartbeat (at moves, changedAt does not) is not a change
s = linkState({ device: dev({ at: min(1), changedAt: min(60) }), claude: { toApp: { rev: 1, at: min(30) }, seen: { deviceRev: 5 } }, now: T }); assert.strictEqual(s.lastEdit, 'ai');
// broken: nothing from the app for more than 35 minutes -> not shaking, whatever the hands said
s = linkState({ device: dev({ at: min(36) }), claude: { seen: { deviceRev: 5 } }, now: T }); assert.deepStrictEqual([s.state, s.shaking, s.connected], ['broken', false, false]); assert.ok(/36 minutes/.test(s.note));
s = linkState({ device: dev({ at: min(35) }), claude: null, now: T }); assert.strictEqual(s.shaking, true, 'exactly 35 minutes is still fine');
// never reported
s = linkState({ device: null, claude: null, now: T }); assert.deepStrictEqual([s.state, s.shaking, s.lastEdit], ['broken', false, null]);
// junk input never throws
s = linkState({ device: { at: 'x' }, claude: 'no', now: T }); assert.strictEqual(s.state, 'broken');
console.log('claudelink: ok');
