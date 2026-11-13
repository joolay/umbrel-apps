// Find inventory rows in PocketBase that belong to a different owner id than your current account, and move them back.
//
// ShutterWorth keeps every row in `sw_docs` / `sw_photos` tagged with the PocketBase user id of its owner. If an account
// was deleted and re-created (new id), or rows were left under an old id, they still exist but no longer show in the app.
//
// Nothing is deleted. Without --apply it only reports. Rows whose path already exists on your account are left alone.
//
//   1. Report (safe):   node recover-inventory.js you@example.com
//   2. Move rows back:  node recover-inventory.js you@example.com --from <ownerId> --apply
//
// On Umbrel, without waiting for an app update, pipe it into the running container:
//   sudo docker exec -i joolay-shutterworth_web_1 node - you@example.com < recover-inventory.js
//   sudo docker exec -i joolay-shutterworth_web_1 node - you@example.com --from <ownerId> --apply < recover-inventory.js
"use strict";
const fs = require("fs");
const pb = require(fs.existsSync("/app/pocketbase.js") ? "/app/pocketbase.js" : "./pocketbase");

const q = encodeURIComponent;
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ""; };
const email = (args.find(a => a.includes("@")) || "").trim().toLowerCase();

async function all(collection, filter) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await pb.asSuper("GET", `/api/collections/${collection}/records?page=${page}&perPage=200${filter ? "&filter=" + q(filter) : ""}`);
    out.push(...(j.items || []));
    if (page >= (j.totalPages || 1)) return out;
  }
}

(async () => {
  if (!pb.enabled) throw new Error("PocketBase isn't configured here (POCKETBASE_URL and the superuser login are missing).");
  if (!email) throw new Error("Usage: node recover-inventory.js you@example.com [--from <ownerId>] [--apply]");
  const me = await pb.findByEmail(email);
  if (!me) throw new Error(`No account with email ${email}. Sign in to the app once with it first.`);

  const docs = await all("sw_docs"), photos = await all("sw_photos");
  const users = new Map((await pb.listUsers()).map(u => [u.id, u]));
  const by = new Map();
  const slot = o => { if (!by.has(o)) by.set(o, { docs: [], photos: [] }); return by.get(o); };
  docs.forEach(r => slot(r.owner).docs.push(r));
  photos.forEach(r => slot(r.owner).photos.push(r));

  console.log(`Your account: ${me.email}  id=${me.id}\n`);
  console.log("Owners found in sw_docs / sw_photos:");
  for (const [o, s] of by) {
    const kinds = {};
    s.docs.forEach(r => { const k = String(r.path).split("/")[0]; kinds[k] = (kinds[k] || 0) + 1; });
    const u = users.get(o);
    console.log(`  ${o === me.id ? "* YOU " : "      "}${o}  ${u ? u.email : "(no such user — orphaned)"}  docs=${s.docs.length} photos=${s.photos.length}  ${JSON.stringify(kinds)}`);
  }

  const from = val("--from");
  if (!from) { console.log("\nTo move one owner's rows onto your account, re-run with: --from <ownerId> [--apply]"); return; }
  if (from === me.id) throw new Error("--from is already your own id.");
  const src = by.get(from);
  if (!src) throw new Error("No rows under that owner id.");

  const mineDocs = new Set((by.get(me.id)?.docs || []).map(r => r.path));
  const minePhotos = new Set((by.get(me.id)?.photos || []).map(r => r.pid));
  const moveDocs = src.docs.filter(r => !mineDocs.has(r.path)), movePhotos = src.photos.filter(r => !minePhotos.has(r.pid));
  console.log(`\nWould move ${moveDocs.length} of ${src.docs.length} docs and ${movePhotos.length} of ${src.photos.length} photos to ${me.email}` +
    ` (skipping ${src.docs.length - moveDocs.length} docs and ${src.photos.length - movePhotos.length} photos already on your account).`);
  if (!flag("--apply")) { console.log("Dry run. Add --apply to do it."); return; }

  let d = 0, p = 0;
  for (const r of moveDocs) { await pb.asSuper("PATCH", `/api/collections/sw_docs/records/${r.id}`, { owner: me.id }); d++; }
  for (const r of movePhotos) { await pb.asSuper("PATCH", `/api/collections/sw_photos/records/${r.id}`, { owner: me.id }); p++; }
  console.log(`Moved ${d} docs and ${p} photos. Restart the app (or wait a minute) and reload it.`);
})().catch(e => { console.error(e.message); process.exit(1); });
