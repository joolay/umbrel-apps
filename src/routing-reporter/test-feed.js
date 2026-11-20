'use strict';
// The status feed carries every app's ports and route states (not only the problems), plus port clashes.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')), data = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-'));
const mk = (id, port, compose) => { fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, 'umbrel-app.yml'), `id: ${id}\nname: ${id}\nversion: "1.0.0"\nport: ${port}\n`); if (compose) fs.writeFileSync(path.join(dir, id, 'docker-compose.yml'), compose); };
mk('joolay-a', 41001, 'ports:\n  - "41002:3000"\n'); mk('bitcoin', 41003); mk('clash', 41001);
process.env.UMBREL_APP_DATA = dir; process.env.DATA_DIR = data; process.env.TAILSCALE_IP = '100.64.0.1'; process.env.LAN_HOST = '127.0.0.1';
const { feedPayload, _monitor } = require('./server');
(async () => {
  await _monitor.run();
  const p = await feedPayload();
  assert.deepStrictEqual(p.ports.map((x) => x.port), [41001, 41001, 41002, 41003]);
  assert.deepStrictEqual(p.ports.filter((x) => x.kind === 'published').map((x) => [x.port, x.app]), [[41002, 'joolay-a']]);
  assert.deepStrictEqual(p.portConflicts, [{ port: 41001, apps: ['clash', 'joolay-a'] }]);
  assert.ok(p.apps.every((a) => a.name && a.routes.every((r) => r.url && r.state)), 'every app and route is listed with its address');
  assert.ok(p.ports.every((x) => ['up', 'down', 'checking'].includes(x.state)));
  console.log('feed ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
