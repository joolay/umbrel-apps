'use strict';
const assert = require('assert');
let t = 1e6; const clock = () => t;
const Q = require('./qrlogin')({ now: clock });
const ok = (m) => console.log('ok  ', m);
const throws = (fn, status, m) => { try { fn(); } catch (e) { assert.strictEqual(e.status, status, m); return; } assert.fail('no throw: ' + m); };

let r = Q.start('joolztv', { label: 'JoolzTV <b>living room</b>\n' });
assert.strictEqual(Q.info(r.id, { id: 'u1' }).label, 'JoolzTV b living room /b'); ok('label is cleaned, phone can look at a pending request');
throws(() => Q.info(r.id, null), 401, 'info needs sign-in'); ok('looking needs a signed-in person');
assert.strictEqual(Q.poll('joolztv', r.id, r.secret).status, 'pending'); ok('pending until the phone decides');
assert.strictEqual(Q.poll('joolztv', r.id, 'wrong').status, 'expired'); ok('wrong secret looks like an unknown request');
assert.strictEqual(Q.poll('other-app', r.id, r.secret).status, 'expired'); ok('another app cannot collect it');
throws(() => Q.decide(r.id, null, true), 401, 'decide needs sign-in'); ok('approving needs a signed-in person');
Q.decide(r.id, { id: 'u1' }, true);
let p = Q.poll('joolztv', r.id, r.secret); assert.deepStrictEqual(p, { status: 'approved', userId: 'u1' }); ok('approval hands over WHO approved');
assert.strictEqual(Q.poll('joolztv', r.id, r.secret).status, 'expired'); ok('an approval can be collected only once');
throws(() => Q.decide(r.id, { id: 'u2' }, true), 404, 'second decide'); ok('a finished request cannot be decided again');

r = Q.start('joolztv', {}); Q.decide(r.id, { id: 'u1' }, false);
assert.strictEqual(Q.poll('joolztv', r.id, r.secret).status, 'denied'); ok('deny is reported, with no user');

r = Q.start('joolztv', {}); t += 121e3;
throws(() => Q.decide(r.id, { id: 'u1' }, true), 404, 'expired'); assert.strictEqual(Q.poll('joolztv', r.id, r.secret).status, 'expired'); ok('after 2 minutes it cannot be approved');

r = Q.start('joolztv', {}); Q.decide(r.id, { id: 'u1' }, true); t += 61e3;
assert.strictEqual(Q.poll('joolztv', r.id, r.secret).status, 'expired'); ok('an approval nobody collected within a minute is dropped');

throws(() => Q.info('short', { id: 'u1' }), 404, 'bad id'); throws(() => Q.decide('../../x'.padEnd(22, 'a'), { id: 'u1' }, true), 404, 'bad id 2'); ok('malformed ids are refused');

t += 61e3; for (let i = 0; i < 12; i++) Q.start('joolztv', {});
throws(() => Q.start('joolztv', {}), 429, 'rate'); ok('an app can open only 12 requests a minute');
const Q2 = require('./qrlogin')({ now: clock }); for (let i = 0; i < 300; i++) Q2.start("a" + i, {});
throws(() => Q2.start('zz', {}), 503, 'cap'); ok('at most 300 requests wait at once');
console.log('ALL PASSED');
