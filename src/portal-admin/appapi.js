'use strict';
// Portal API: lets an app ask Portal Admin to do its account, access and portal-settings work, so the app needs no PocketBase login of its own.
//   POST /app-api/call   Authorization: Bearer <app>.<secret>   { fn, args }   ->   { ok, result } or { ok:false, status, message, data }
// Each app has its own key. Every call runs as that app (its access rows, its settings). Keys are only stored here as hashes.
// Served on a separate internal port that is NOT published through the internet tunnel.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const makeClient = require('./appclient');
const guardians = require('./guardians');
const family = require('./family');
// Guardian approvals (under-18s) run here, in one place for every app: call them as 'guardians.<name>'.
const GUARD = ['createdSpouse', 'createdByParent', 'adminDecide', 'statusOf', 'checkParents', 'requestApproval', 'requestFamily', 'inbox', 'decide', 'revoke'];

// Family (households, shared family orders) also runs here: call as 'family.<name>'. Managing a family stays on the dashboard itself.
const FAMILY = ['mine', 'linkedIds', 'addOrder', 'listOrders', 'removeOrder'];

// QR sign-in (a TV shows a code, a signed-in phone approves): apps open a request and collect the result; the phone side is the Portal's /qr route.
const QR = ['start', 'poll'];

const RAW = new Set(['asSuper', 'superFetch', 'ensureSchema', 'enabled', 'PBError', 'collection', 'app']);   // never callable through the API

module.exports = function makeAppApi({ qrlogin, quick, pbx, DATA_DIR, readBody, send }) {
  const FILE = path.join(DATA_DIR, 'app-keys.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const keys = {
    appOf(key) {
      key = String(key || ''); const i = key.indexOf('.'); if (i < 1) return null;
      const app = key.slice(0, i), want = load()[app]; if (!want) return null;
      const a = Buffer.from(hash(key)), b = Buffer.from(want);
      return a.length === b.length && crypto.timingSafeEqual(a, b) ? app : null;
    },
    valid: (app, key) => keys.appOf(key) === app,
    issue(app) {
      const key = app + '.' + crypto.randomBytes(32).toString('base64url'), all = load(); all[app] = hash(key);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 }); fs.renameSync(tmp, FILE);
      return key;
    },
  };

  const clients = new Map();
  function client(app) {
    const c = pbx.creds(), sig = [pbx.url(), c.email, c.pass].join('|'), have = clients.get(app);
    if (have && have.sig === sig) return have.cl;
    if (!c.email) throw Object.assign(new Error("Portal Admin isn't connected to PocketBase yet."), { status: 503 });
    const cl = makeClient({ url: pbx.url(), email: c.email, pass: c.pass, app });
    clients.set(app, { sig, cl }); return cl;
  }
  const ALLOWED = new Set([...Object.entries(makeClient({ url: '', email: '', pass: '', app: 'x' })).filter(([k, v]) => typeof v === 'function' && !RAW.has(k)).map(([k]) => k), ...GUARD.map((n) => 'guardians.' + n), ...FAMILY.map((n) => 'family.' + n), ...QR.map((n) => 'qr.' + n), ...['login', 'setup', 'list', 'remove', 'status'].map((n) => 'qa.' + n), 'touchActive']);

  // Apps say "this person just used me"; Portal Admin keeps one date per person so accounts unused for a year can be reviewed (Cleanup page).
  const lastTouch = new Map();
  const forgetTouch = (id) => lastTouch.delete(String(id));   // after a deletion notice, the very next use must clear it
  async function touchActive(id) {
    id = String(id || '');
    if (!/^[a-z0-9]{15}$/.test(id)) return null;
    const now = Date.now();
    if (now - (lastTouch.get(id) || 0) < 12 * 3600e3) return null;
    lastTouch.set(id, now); if (lastTouch.size > 5000) lastTouch.clear();
    try { await pbx.asSuper('PATCH', '/api/collections/' + (process.env.POCKETBASE_USERS_COLLECTION || 'users') + '/records/' + id, { lastActive: new Date(now).toISOString().replace('T', ' '), deletionNoticeAt: '' }); }
    catch (e) { lastTouch.delete(id); if (e.status !== 404) throw e; }
    return null;
  }

  const plain = (v) => (v instanceof Set ? [...v] : v);   // JSON can't carry a Set
  // Admin work needs more than an app's key: the request must carry the token of a signed-in admin, checked here with PocketBase.
  // So a leaked or misused app key can't list, change, create or delete people.
  const ADMIN_ONLY = new Set(['listUsers', 'updateUser', 'deleteUser', 'createUser', 'setPortalAccess', 'guardians.adminDecide']);
  const adminOk = new Map();   // token hash -> checked at (15 s)
  async function isAdminToken(tok) {
    tok = String(tok || ''); if (!tok || tok.length > 4096) return false;
    const h = hash(tok), at = adminOk.get(h);
    if (at && Date.now() - at < 15000) return true;
    const u = await pbx.userFromToken(tok);
    if (!u || u.isAdmin !== true) { adminOk.delete(h); return false; }
    adminOk.set(h, Date.now()); if (adminOk.size > 500) adminOk.clear();
    return true;
  }
  const bad = new Map();   // failed key attempts per caller: 20 per 10 minutes
  const fails = (ip) => { const n = Date.now(), a = (bad.get(ip) || []).filter((t) => n - t < 600e3); bad.set(ip, a); return a; };

  async function handle(req, res) {
    if (req.url === '/healthz') return send(res, 200, 'ok');
    if (req.method !== 'POST' || req.url !== '/app-api/call') return send(res, 404, { message: 'Not found' });
    const ip = String(req.socket.remoteAddress || '');
    if (fails(ip).length >= 20) return send(res, 429, { message: 'Too many attempts.' });
    const app = keys.appOf(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!app) { bad.set(ip, [...fails(ip), Date.now()]); if (bad.size > 2000) bad.clear(); return send(res, 401, { message: 'Unknown app key.' }); }
    let b; try { b = JSON.parse(await readBody(req, 256 * 1024)); } catch { return send(res, 400, { message: 'Invalid request.' }); }
    const fn = String(b.fn || '');
    if (!ALLOWED.has(fn)) return send(res, 200, { ok: false, status: 404, message: 'Unknown function: ' + fn });
    if (ADMIN_ONLY.has(fn)) { let adm = false; try { adm = await isAdminToken(b.as); } catch (e) { return send(res, 200, { ok: false, status: Number(e.status) || 500, message: String(e.message || e) }); } if (!adm) return send(res, 200, { ok: false, status: 403, message: 'Only a signed-in admin can do that.' }); }
    try { const args = Array.isArray(b.args) ? b.args : [], r = fn === 'touchActive' ? await touchActive(args[0]) : fn.startsWith('guardians.') ? await guardians[fn.slice(10)](...args) : fn.startsWith('family.') ? plain(await family[fn.slice(7)](...args)) : fn.startsWith('qr.') ? qrlogin[fn.slice(3)](app, ...args) : fn.startsWith('qa.') ? await quick[fn.slice(3)](...args) : await client(app)[fn](...args); return send(res, 200, { ok: true, result: r === undefined ? null : r }); }
    catch (e) { return send(res, 200, { ok: false, status: Number(e.status) || 500, message: String(e.message || e), data: e.data || undefined }); }
  }
  return { handle, keys, allowed: [...ALLOWED], adminOnly: [...ADMIN_ONLY], touchActive, forgetTouch };
};
