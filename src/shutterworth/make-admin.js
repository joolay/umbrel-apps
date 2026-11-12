// Make an account an admin (or remove admin access). Run it on the server:
//   sudo docker compose exec shutterworth node make-admin.js you@example.com
//   sudo docker compose exec shutterworth node make-admin.js you@example.com --remove
"use strict";
const pb = require("./pocketbase");
(async () => {
  if (!pb.enabled) { console.error("Accounts are off. Set POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in docker-compose.yml first."); process.exit(1); }
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const remove = process.argv.includes("--remove");
  if (!email) { console.error("Usage: node make-admin.js you@example.com [--remove]"); process.exit(1); }
  const u = await pb.findByEmail(email);
  if (!u) { console.error("No account with that email. Create it in the app first (Settings > Account), then run this again."); process.exit(1); }
  if (remove && u.isAdmin && (await pb.countAdmins()) <= 1) { console.error("That is the only admin. Make someone else an admin first."); process.exit(1); }
  await pb.updateUser(u.id, { isAdmin: !remove });
  console.log(remove ? `${email} is no longer an admin.` : `${email} is now an admin.`);
})().catch(e => { console.error(e.message); process.exit(1); });
