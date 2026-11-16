# Stremio (JoolzApp soft sync)

Zero-dependency Node reverse proxy in front of the unmodified `tsaridas/stremio-docker` image (Stremio Web + streaming server).
It **never gates or waits on anything**: Umbrel's own login protects the app, and the proxy passes every request straight to Stremio.
It only (1) injects one `<script src="/_jz/sync.js">` into Stremio Web's HTML and (2) serves `/_jz/*` for that script.

What the script does: Stremio Web keeps the login in `localStorage.profile.auth` (`{key, user}`). Browsers (iOS especially) clear that.
Signed in to JoolzApp (a small chip, bottom right), the script saves `auth` on the account as one `pref.stremio` row in `portal_settings`
(scope user, app `stremio`, `secret: true`) and puts it back into Stremio's blank profile after a clean-up, then reloads once.
Signing out of Stremio deletes the saved copy, so it is not resurrected. Restore runs at most once per tab session.

Fail-open rules (the old gate stalled, so these are tested in `test.js`): no PocketBase lookup on the proxy path; every `/_jz` call times
out after 3 s; no `pocketbase.env` just means sync is off (no restart loop, no exit); upstream down gives a plain 502.

Config: `<app data>/data/pocketbase.env`, written by Portal Admin (`pocketbase.js` is copied from `src/jolly-grocer`, plus the
`getAppPref/setAppPref/clearAppPref` helpers at the bottom). `POCKETBASE_APP_ID=stremio` is set in the compose file.

Test: `node test.js` (fake Stremio + fake PocketBase, no network). Limitation: the streaming server (port 11470) is not behind this layer.
Bump `version` in `package.json`, the manifest and the compose `web` image tag together.
