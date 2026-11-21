'use strict';
// Publishes apps that are NOT ours (and so can't carry TSDProxy labels: Umbrel rewrites their compose files on every update) on the tailnet,
// through a TSDProxy "list" file. Today: OpenClaw (the gateway). Tailnet only, never Funnel, so it works on every device that has Tailscale.
// Needs TSDProxy's config folder mounted at /tsdproxy-config (joolay-portal-admin compose). TSDProxy reloads the list file by itself; only the one-time
// "lists:" line in tsdproxy.yaml needs a TSDProxy restart: Apply leaves a request file and Services Manager restarts TSDProxy 30 s later.
const fs = require('fs'), path = require('path');
const PUBLISH = [{ id: 'openclaw', name: 'openclaw', title: 'OpenClaw' }];   // add more third-party apps here (tailnet only)
const LIST = 'joolz-published.yaml', DECL = '  joolz:\n    filename: /config/' + LIST + '\n';

const withList = (txt) => {
  if (/^ {2}joolz:\s*$/m.test(txt)) return txt;
  if (/^lists:\s*(\{\s*\})?\s*(#.*)?$/m.test(txt)) return txt.replace(/^lists:\s*(\{\s*\})?\s*(#.*)?$/m, 'lists:\n' + DECL.replace(/\n$/, ''));
  if (/^lists:/m.test(txt)) return txt.replace(/^lists:[^\n]*\n/m, (m) => m + DECL);
  return txt.replace(/\n*$/, '\n') + '\nlists:\n' + DECL;
};
const listFile = (apps) => '# Written by Portal Admin (Changes). Tailnet-only addresses for apps that are not ours. TSDProxy reloads this file by itself.\n' +
  apps.map((a) => `${a.name}:\n  ports:\n    443/https:\n      targets:\n        - http://host.docker.internal:${a.port}\n`).join('');
const targets = (c) => PUBLISH.map((p) => { const a = c.installedApps().apps.find((x) => x.id === p.id && x.port); return a ? { ...p, port: a.port } : null; }).filter(Boolean);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

module.exports = {
  id: '014-tsdproxy-published',
  title: 'Tailnet address for OpenClaw (TSDProxy)',
  summary: 'Gives OpenClaw its own private address, https://openclaw.<your tailnet>, through TSDProxy, so it opens on every device that has Tailscale (Mac, iPhone, Android, Windows, Linux). Tailnet only: it is never public. Port Master then checks that address like the others.',
  async plan(c) {
    const apps = targets(c); if (!apps.length) return [];
    const cfg = read(path.join(c.tsdDir, 'tsdproxy.yaml'));
    if (cfg == null) return ["Can't see TSDProxy's settings folder yet: update Portal Admin, then reopen this page"];
    const out = [];
    if (withList(cfg) !== cfg) out.push('Add a proxy list to TSDProxy\'s settings (Services Manager restarts TSDProxy by itself 30 seconds after you apply)');
    if (read(path.join(c.tsdDir, LIST)) !== listFile(apps)) out.push(...apps.map((a) => `Publish ${a.title} (port ${a.port}) at https://${a.name}.<your tailnet>, tailnet only`));
    return out;
  },
  async apply(c) {
    const apps = targets(c); if (!apps.length) return ['OpenClaw is not installed, so nothing was changed.'];
    const f = path.join(c.tsdDir, 'tsdproxy.yaml'), cfg = read(f); if (cfg == null) throw new Error("TSDProxy's settings folder is not visible to Portal Admin.");
    fs.writeFileSync(path.join(c.tsdDir, LIST), listFile(apps));
    const next = withList(cfg), notes = [];
    if (next !== cfg) {
      try { fs.writeFileSync(f + '.bak', cfg, { mode: 0o600 }); } catch {}
      const tmp = f + '.tmp'; fs.writeFileSync(tmp, next, { mode: 0o600 }); fs.renameSync(tmp, f);
      // Portal Admin has no Docker access: Services Manager sees this file and restarts TSDProxy (only) 30 seconds later.
      try { fs.writeFileSync(path.join(c.tsdDir, 'restart-tsdproxy'), new Date().toISOString() + '\n'); notes.push('Services Manager restarts TSDProxy by itself in about 30 seconds so it reads the new list. The address then appears within a minute, and Port Master will show it. (If Services Manager is not running, restart TSDProxy yourself.)'); }
      catch { notes.push('Restart TSDProxy once (Services Manager > tsdproxy > Restart) so it reads the new list.'); }
    }
    return notes;
  },
  withList, listFile,
};
