'use strict';
// "Changes": PocketBase changes that ship inside this app. Each file in ./changes exports { id, title, summary, plan(c), apply(c) }.
//  - plan(c) compares the live PocketBase with what the change wants and returns plain-English lines (empty = nothing to do).
//  - apply(c) makes exactly those changes. Always safe to run twice.
// Only an admin (a verified PocketBase superuser, on the home network or tailnet) can list or apply. Nothing is read from the internet:
// a change exists only if it was built into this image.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function makeChanges({ pbx, installedApps, APPS_DIR, DATA_DIR, appKeys }) {
  const DIR = path.join(__dirname, 'changes'), HISTORY = path.join(DATA_DIR, 'changes-history.json');
  const sets = () => { try { return fs.readdirSync(DIR).filter((f) => /^\d+[\w-]*\.js$/.test(f)).sort().map((f) => require(path.join(DIR, f))); } catch { return []; } };

  const dataDirOf = (app) => {
    const root = fs.realpathSync(APPS_DIR), d = fs.realpathSync(path.join(APPS_DIR, app.dir, 'data'));
    if (!/^joolay-[a-z0-9-]{1,60}$/.test(app.dir) || !d.startsWith(root + path.sep) || !fs.statSync(d).isDirectory()) throw new Error(`${app.name} has no data folder`);
    return d;
  };
  const parseEnv = (txt) => { const o = {}; for (const l of String(txt).split(/\r?\n/)) { const m = l.match(/^\s*(POCKETBASE_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) o[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); } return o; };
  const ctx = {
    pb: (method, p, body) => pbx.asSuper(method, p, body),
    async getCollection(name) { try { return await pbx.asSuper('GET', '/api/collections/' + encodeURIComponent(name)); } catch (e) { if (e.status === 404) return null; throw e; } },
    async needNewPocketBase() { try { await pbx.asSuper('GET', '/api/collections/_superusers'); } catch (e) { if (e.status === 404) throw new Error('These changes need PocketBase 0.23 or newer.'); throw e; } },
    // Apps of your own store that use the JoolzApp account and have a data folder we can write to.
    // (JoolzApp Portal is left out: it never gets a PocketBase login of any kind, and its key is handed over by linkPortal below.)
    apps() { return installedApps().apps.filter((a) => /^joolay-/.test(a.dir) && a.slug && a.slug !== 'portal' && a.env !== 'no-data-dir'); },
    readEnv(app) { try { return parseEnv(fs.readFileSync(path.join(dataDirOf(app), 'pocketbase.env'), 'utf8')); } catch { return {}; } },
    // Merge keys into <app data>/pocketbase.env, keeping every other line. Owner-only file, written atomically.
    setEnv(app, kv) {
      const data = dataDirOf(app), file = path.join(data, 'pocketbase.env'); let keep = [];
      try { keep = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !Object.keys(kv).some((k) => new RegExp('^\\s*' + k + '\\s*=').test(l))); } catch {}
      const tmp = path.join(data, '.pocketbase.env.' + process.pid + '.tmp');
      fs.writeFileSync(tmp, [...keep, ...Object.entries(kv).map(([k, v]) => k + '=' + v), ''].join('\n'), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    // Take keys out of <app data>/pocketbase.env, keeping every other line.
    unsetEnv(app, keys) {
      const data = dataDirOf(app), file = path.join(data, 'pocketbase.env');
      let lines; try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return; }
      const keep = lines.filter((l) => l.trim() && !keys.some((k) => new RegExp('^\\s*' + k + '\\s*=').test(l)));
      const tmp = path.join(data, '.pocketbase.env.' + process.pid + '.tmp');
      fs.writeFileSync(tmp, [...keep, ''].join('\n'), { mode: 0o600 }); fs.renameSync(tmp, file);
    },
    // Does this login work? When PocketBase's own rate limiter (if on) says 429, `retry` waits and tries again; without it a 429 counts as
    // "can't tell, assume yes" so that just looking at the Changes page never waits on the limiter.
    async loginWorks(collection, email, password, { retry = true } = {}) {
      if (!email || !password) return false;
      for (let i = 0; ; i++) {
        try { await pbx.raw('POST', `/api/collections/${encodeURIComponent(collection)}/auth-with-password`, { body: { identity: email, password } }); return true; }
        catch (e) {
          if (e.status === 429) { if (!retry) return true; if (i < 4) { await new Promise((r) => setTimeout(r, 3500)); continue; } }
          if (e.status === 400 || e.status === 401 || e.status === 404) return false;
          throw e;
        }
      }
    },
    password: () => crypto.randomBytes(24).toString('base64url'),
    appKeys,
    portalApiUrl: process.env.PORTAL_API_HOST_URL || 'http://host.docker.internal:3899',
    esc: (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
  };

  const history = () => { try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch { return []; } };
  const note = (entry) => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HISTORY, JSON.stringify([entry, ...history()].slice(0, 100), null, 1)); } catch {} };

  let busy = false;
  return {
    async list() {
      const limit = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('PocketBase is taking too long to answer. Try again in a moment.')), ms))]);
      const out = await Promise.all(sets().map(async (s) => {
        const o = { id: s.id, title: s.title, summary: s.summary }, t0 = Date.now();
        try { await limit(ctx.needNewPocketBase(), 15000); o.plan = await limit(s.plan(ctx), 20000); o.status = o.plan.length ? 'pending' : 'done'; }
        catch (e) { o.plan = []; o.status = 'error'; o.error = String(e.message || e); }
        if (Date.now() - t0 > 5000) console.warn(`[changes] ${s.id} took ${Date.now() - t0} ms to check`);
        return o;
      }));
      return { changes: out, history: history().slice(0, 20) };
    },
    // JoolzApp Portal (the internet-facing home screen app) needs only a Portal API key. Give it one as soon as it is installed and
    // whenever its file has none that still works. Returns a line for the log when it did something.
    linkPortal() {
      const a = installedApps().apps.find((x) => x.dir === 'joolay-portal' && x.slug === 'portal' && x.env !== 'no-data-dir'); if (!a) return '';
      const env = ctx.readEnv(a), stale = ['POCKETBASE_SUPERUSER_EMAIL', 'POCKETBASE_SUPERUSER_PASSWORD', 'POCKETBASE_SERVICE_EMAIL', 'POCKETBASE_SERVICE_PASSWORD'].filter((k) => env[k]);
      if (stale.length) ctx.unsetEnv(a, stale);   // it must never hold a PocketBase login
      if (env.POCKETBASE_PORTAL_URL === ctx.portalApiUrl && appKeys.appOf(env.POCKETBASE_PORTAL_KEY || '') === 'portal') return stale.length ? 'removed a PocketBase login from its folder' : '';
      ctx.setEnv(a, { POCKETBASE_PORTAL_URL: ctx.portalApiUrl, POCKETBASE_PORTAL_KEY: appKeys.issue('portal') });
      return 'linked (Portal API key written to its data folder)';
    },
    async apply(id) {
      const s = sets().find((x) => x.id === id); if (!s) throw Object.assign(new Error('Unknown change.'), { status: 404 });
      if (busy) throw Object.assign(new Error('Another change is running. Try again in a moment.'), { status: 409 });
      busy = true;
      try {
        await ctx.needNewPocketBase();
        const before = await s.plan(ctx); if (!before.length) return { ok: true, did: [], left: [] };
        const notes = (await s.apply(ctx, before)) || [];
        const left = await s.plan(ctx);
        note({ id, at: new Date().toISOString(), did: before, left, ok: !left.length });
        return { ok: !left.length, did: before, notes, left };
      } finally { busy = false; }
    },
  };
};
