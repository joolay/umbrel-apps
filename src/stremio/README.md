# Stremio (JoolzApp gate)

Zero-dependency Node reverse proxy in front of the unmodified `tsaridas/stremio-docker` image (Stremio Web + streaming server).
Shows a JoolzApp sign-in page, validates the PocketBase token, honours Portal Admin's per-app access (`portal.access`, app on/off,
maintenance) and proxies everything else to Stremio Web. Admins always get in. Fails closed when accounts aren't configured.

Config goes in `<app data>/data/pocketbase.env` (same keys as ShutterWorth): `POCKETBASE_URL`, `POCKETBASE_SUPERUSER_EMAIL`,
`POCKETBASE_SUPERUSER_PASSWORD`. `POCKETBASE_APP_ID=stremio` is set in the compose file. `pocketbase.js` is copied from `src/shutterworth`.

Sign out: `/_auth/logout`.

Limitation: Stremio's streaming server (port 11470) is called directly by the browser and Stremio apps, so it isn't behind this gate.

Bump `version` in `package.json`, the manifest and the compose gate image tag together.
