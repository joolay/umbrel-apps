// node src/openclaw/test-preset.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings, apply, main, ownNetworks } from './joolz/preset.mjs';

const env = { TAILNET: 'macaw-chroma.ts.net', TS_NAME: 'openclaw', TAILSCALE_IP: '100.118.10.62', LAN_HOST: 'umbrel.local', APP_PORT: '3927' };
const ifaces = { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }], eth0: [{ address: '192.168.64.5', netmask: '255.255.240.0', family: 'IPv4', internal: false }, { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }] };
assert.deepEqual(ownNetworks(ifaces), ['192.168.64.0/20'], 'own network, network address (not host), no loopback, no IPv6');
assert.deepEqual(ownNetworks({ x: [{ address: '1.2.3.4', netmask: '128.0.0.0', family: 'IPv4', internal: false }] }), [], 'too wide is ignored');
const s = settings(env, ifaces);
assert.equal(s.publicOrigin, 'https://openclaw.macaw-chroma.ts.net');
assert.deepEqual(s.allowedOrigins, ['https://openclaw.macaw-chroma.ts.net', 'http://100.118.10.62:3927', 'http://umbrel.local:3927', 'http://localhost:3927', 'http://127.0.0.1:3927']);
assert.deepEqual(s.trustedProxies, ['192.168.64.0/20']);
assert.deepEqual(settings({ ...env, TRUSTED_PROXIES: '10.0.0.1' }, ifaces).trustedProxies, ['192.168.64.0/20', '10.0.0.1']);
// tolerant input: scheme, trailing dot, case, extra origins
assert.equal(settings({ ...env, TAILNET: 'https://Macaw-Chroma.ts.net.' }).publicOrigin, 'https://openclaw.macaw-chroma.ts.net');
assert.ok(settings({ ...env, EXTRA_ORIGINS: 'https://a.example, https://b.example' }).allowedOrigins.includes('https://b.example'));
// no tailnet: no public origin, nothing invented
const bare = settings({ APP_PORT: '3927' });
assert.equal(bare.publicOrigin, ''); assert.ok(!bare.allowedOrigins.some((o) => o.includes('undefined')));

// apply keeps everything the owner set outside the owned keys, and is stable
const mine = { agents: { defaults: { model: 'x' } }, gateway: { auth: { mode: 'token' }, controlUi: { basePath: '/c', communityInvite: false }, port: 1 } };
const a = apply(mine, s);
assert.equal(a.changed, true);
assert.deepEqual(a.next.agents, mine.agents);
assert.equal(a.next.gateway.auth.mode, 'token');
assert.equal(a.next.gateway.controlUi.basePath, '/c');
assert.equal(a.next.gateway.controlUi.communityInvite, false);
assert.equal(a.next.gateway.port, 18789);
assert.equal(a.next.gateway.bind, 'lan');
assert.equal(a.next.gateway.tailscale.mode, 'off');
assert.equal(apply(a.next, s).changed, false, 'second run changes nothing');

// main(): creates config + token once, then leaves both alone
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
const e = { ...env, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: path.join(dir, 'openclaw.json') };
const r1 = main(e); const tok = fs.readFileSync(path.join(dir, 'joolz-gateway-token'), 'utf8');
assert.match(tok, /^[0-9a-f]{64}\n$/); assert.equal(r1.changed, true);
assert.equal((fs.statSync(path.join(dir, 'joolz-gateway-token')).mode & 0o777), 0o600);
const before = fs.readFileSync(e.OPENCLAW_CONFIG_PATH, 'utf8');
const r2 = main(e);
assert.equal(r2.changed, false); assert.equal(fs.readFileSync(e.OPENCLAW_CONFIG_PATH, 'utf8'), before);
assert.equal(fs.readFileSync(path.join(dir, 'joolz-gateway-token'), 'utf8'), tok, 'token is kept');
// a broken config is never overwritten
fs.writeFileSync(e.OPENCLAW_CONFIG_PATH, '{ nope');
assert.throws(() => main(e), /NOT written/);
assert.equal(fs.readFileSync(e.OPENCLAW_CONFIG_PATH, 'utf8'), '{ nope');
console.log('preset ok');
