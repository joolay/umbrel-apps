'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), N = require('./names'), C = require('./checker');
const app = (id, port, tsdName, nameSource, name) => ({ id, name: name || id, port, tsdName: tsdName || '', nameSource: nameSource || (tsdName ? 'label' : '') });

// names and suggestions
assert.strictEqual(N.slugFor('joolay-Project_Pilot'), 'project-pilot'); assert.strictEqual(N.cleanName(' My-App '), 'my-app'); assert.strictEqual(N.cleanName('-bad'), ''); assert.strictEqual(N.cleanName('umbrel'), ''); assert.strictEqual(N.cleanName('a_b'), '');
const apps = [app('joolay-a', 1, 'a'), app('stremio', 2), app('bitcoin', 3), app('x', 4, 'bitcoin', 'list')];
assert.strictEqual(N.suggest(apps, 'stremio'), 'stremio'); assert.strictEqual(N.suggest(apps, 'bitcoin'), 'bitcoin-2', 'a name another app uses is not reused'); assert.strictEqual(N.suggest(apps, 'joolay-a'), '', 'already named');

// create / modify rules
assert.strictEqual(N.validate(apps, 'stremio', 'Stream-Box'), 'stream-box');
assert.throws(() => N.validate(apps, 'joolay-a', 'new'), /already has the name a/); assert.throws(() => N.validate(apps, 'stremio', 'bad name'), /letters, numbers and dashes/);
assert.throws(() => N.validate(apps, 'stremio', 'a'), /already used by joolay-a/); assert.throws(() => N.validate(apps, 'nope', 'zz'), /not in the latest check/);
assert.strictEqual(N.validate([app('s', 2, 'old', 'names')], 's', 'fresh'), 'fresh', 'a name Port Master gave can be renamed');

// fix: gone app, app that got its own name, clash, invalid, port follows the app
let r = N.reconcile([app('stremio', 2), app('joolay-a', 1, 'a'), app('y', 7, 'stream', 'label'), app('z', 8, 'zz', 'names')], { stremio: 'stream', gone: 'gone', 'joolay-a': 'mine', z: 'zz', q: 'q' });
assert.deepStrictEqual(r.owned, { stremio: 'stream-2', z: 'zz' });
assert.ok(r.changes.some((c) => /gone is not installed/.test(c)) && r.changes.some((c) => /now has its own name \(a\)/.test(c)) && r.changes.some((c) => /clashed.*stream-2/.test(c)));
r = N.reconcile([app('a', 5, '', ''), app('b', 6)], { a: 'same', b: 'same' }); assert.deepStrictEqual(r.owned, { a: 'same', b: 'same-2' }, 'two of our own names never share');
assert.deepStrictEqual(N.reconcile([app('a', 9)], { a: 'Bad_Name' }).owned, {});

// list file: same layout TSDProxy reads, and checker.parseList reads it back
const txt = N.listFile([{ name: 'stream', port: 3012 }, { name: 'bit', port: 3013 }]);
assert.deepStrictEqual(C.parseList(txt).map((x) => [x.name, x.port]), [['stream', 3012], ['bit', 3013]]);
assert.ok(!/funnel/i.test(txt), 'never public');

// TSDProxy settings: one lists: line, only once, other lists kept
assert.strictEqual(N.withList('a: 1\n'), 'a: 1\n\nlists:\n  joolz-names:\n    filename: /config/joolz-names.yaml\n');
const withOther = 'lists:\n  joolz:\n    filename: /config/joolz-published.yaml\nx: 1\n'; const w = N.withList(withOther);
assert.ok(/joolz:\n    filename: \/config\/joolz-published\.yaml/.test(w) && /joolz-names:/.test(w)); assert.strictEqual(N.withList(w), w);
assert.ok(/lists:\n {2}joolz-names:/.test(N.withList('lists: {}\n')));

// review: clash, not registered, none, editable
const rv = N.review([app('a', 1, 'dup'), app('b', 2, 'dup', 'names'), app('c', 3), app('d', 4, 'ghost'), app('e', 5, 'ok')], {}, [{ name: 'dup' }, { name: 'ok' }]);
const st = (id) => rv.find((x) => x.appId === id);
assert.deepStrictEqual(['a', 'b', 'c', 'd', 'e'].map((i) => st(i).state), ['clash', 'clash', 'none', 'unregistered', 'ok']);
assert.deepStrictEqual(['a', 'b', 'c'].map((i) => st(i).editable), [false, true, true]); assert.strictEqual(st('c').suggestion, 'c');
assert.strictEqual(N.review([app('d', 4, 'ghost')], {}, null)[0].state, 'ok', 'unknown proxy list: no complaint');

// discover reads both list files and tells where each name comes from
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')), apps_ = path.join(dir, 'apps'); fs.mkdirSync(apps_);
const mk = (id, port, compose) => { fs.mkdirSync(path.join(apps_, id)); fs.writeFileSync(path.join(apps_, id, 'umbrel-app.yml'), `id: ${id}\nname: ${id}\nversion: "1"\nport: ${port}\n`); if (compose) fs.writeFileSync(path.join(apps_, id, 'docker-compose.yml'), compose); };
mk('joolay-l', 11, 'labels:\n  tsdproxy.enable: "true"\n  tsdproxy.name: "lab"\n'); mk('openclaw', 12); mk('stremio', 13); mk('plain', 14);
fs.writeFileSync(path.join(dir, 'pub.yaml'), 'openclaw:\n  ports:\n    443/https:\n      targets:\n        - http://host.docker.internal:12\n'); fs.writeFileSync(path.join(dir, 'names.yaml'), N.listFile([{ name: 'stream', port: 13 }]));
const found = C.discover(apps_, [{ file: path.join(dir, 'pub.yaml'), source: 'list' }, { file: path.join(dir, 'names.yaml'), source: 'names' }]);
assert.deepStrictEqual(found.map((a) => [a.id, a.tsdproxy ? a.tsdproxy.name : null, a.nameSource]), [['joolay-l', 'lab', 'label'], ['openclaw', 'openclaw', 'list'], ['plain', null, ''], ['stremio', 'stream', 'names']]);
assert.deepStrictEqual(C.discover(apps_, path.join(dir, 'pub.yaml')).map((a) => a.nameSource), ['label', 'list', '', ''], 'a single file path still works');
console.log('names ok');

// 1.10.0: seeds, funnel and port in the list file, and the file reads back to the same app
(() => {
  const N = require('./names'), C = require('./checker'), assert = require('assert');
  const apps = [{ id: 'joolay-cctv', name: 'JoolzCCTV', port: 3902, tsdName: '', nameSource: '' }, { id: 'joolay-gatekeeper', name: 'Gatekeeper', port: 3921, tsdName: '', nameSource: '' }, { id: 'other', name: 'Other', port: 4000, tsdName: '', nameSource: '' }];
  assert.strictEqual(N.suggest(apps, 'joolay-cctv'), 'cctv', 'seed name'); assert.strictEqual(N.suggest(apps, 'other'), 'other');
  const sd = N.seedFor('joolay-cctv'); assert.deepStrictEqual([sd.port, sd.funnel], [3903, true]);
  const r = N.reconcile(apps, { 'joolay-cctv': 'cctv', 'joolay-gatekeeper': 'gatekeeper', other: 'other' }, { 'joolay-cctv': { port: 3903, funnel: true }, 'joolay-gatekeeper': { port: 3921 } });
  const txt = N.listFile(r.entries); assert.ok(/funnel: true/.test(txt) && /host.docker.internal:3903/.test(txt) && /host.docker.internal:4000/.test(txt));
  const p = C.parseList(txt); assert.deepStrictEqual(p.map((e) => [e.name, e.port, e.funnel, e.appId]), [['cctv', 3903, true, 'joolay-cctv'], ['gatekeeper', 3921, false, 'joolay-gatekeeper'], ['other', 4000, false, 'other']]);
  const rv = N.review(apps.map((a) => ({ ...a, tsdName: a.id === 'joolay-cctv' ? 'cctv' : '', nameSource: a.id === 'joolay-cctv' ? 'label' : '' })), {}, null, {}); assert.ok(/moves to Port Master/.test(rv[0].note), 'label names explain the move');
  console.log('seed, funnel and app-marker ok');
})();
