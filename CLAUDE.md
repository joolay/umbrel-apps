# umbrel-apps: monorepo conventions

This repo is both the Umbrel community app store (`id: joolay`) and the source for every custom app.
Everything is managed here; never create a separate repo for a new app.

## Adding an app called `<name>`
1. Source: `src/<name>/` with a `Dockerfile` (build context is that folder; keep `LABEL org.opencontainers.image.source=https://github.com/joolay/umbrel-apps`).
2. Store entry: `joolay-<name>/` with `umbrel-app.yml` (`id: joolay-<name>`), `docker-compose.yml`, `icon.svg`.
   - compose `web.image` must be `ghcr.io/joolay/<name>:<version>`, equal to `version` in `umbrel-app.yml`.
   - `app_proxy` uses `APP_HOST: joolay-<name>_web_1`. Pick an unused `port`.
3. `.github/workflows/build-images.yml` auto-discovers `src/*/Dockerfile`, builds multi-arch, and pushes the image from `main` and `claude/**` branches (so the image exists before the manifest lands on `main`).
4. Releasing an update: bump `version` in `umbrel-app.yml` AND the compose image tag (and `package.json` if present), update `releaseNotes`.
5. The store only updates when the change is on `main`. Develop on the assigned `claude/...` branch, wait for the build to be green, then open a PR / merge when the user asks.

Apps backed by PocketBase should read config via the Portal Admin settings (`src/portal-admin`).
ShutterWorth (`src/shutterworth`) and Portal Admin (`src/portal-admin`) both follow this layout.

## JoolzApp-account apps and pocketbase.env
Any `joolay-*` app that signs people in with the JoolzApp account declares `POCKETBASE_APP_ID=<slug>` in its compose file and reads
`<app data>/data/pocketbase.env` (copy `src/jolly-grocer/pocketbase.js`, the newest version). Portal Admin writes that file, and only after
you sign in there: it notices a new app with a data folder but no file (checks every 30 s, and the app must create its data folder on
startup), opens a sign-in prompt, verifies the PocketBase superuser login, and writes the file for every waiting app. Nothing is stored
by Portal Admin and an existing file is never overwritten. Apps must fail closed without the file, but must NOT need a restart: while
accounts are off, call `pb.reload()` on each request (it re-reads the file, at most every 2 s) and make the waiting page refresh itself.

## Glass theme (uniform style for every JoolzApp)
All apps, old and new, use the shared Glass theme in `templates/glass/` (`glass.css` plus a README with the rules and each app's brand tokens).
Copy `glass.css` into `src/<app>/public/`, link it before the app's own CSS, and set only `--accent` and `--accent-2` in the app. New apps start from it;
existing apps move onto it one at a time. Every `index.html` head also carries: `viewport` with `viewport-fit=cover`, `theme-color`, `manifest.webmanifest`,
`apple-touch-icon` (180px PNG), `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent` and a short `apple-mobile-web-app-title`.

## Preview before pushing
Before asking the owner to confirm a push, publish or update an artifact that previews the changed app in the Glass theme (light and dark, phone width).
Only after he confirms: push and merge to `main` in one step.

## Settings live on the account, and view-only users
- Every app saves its user preferences (default tip, ordering of tiles, preferred branch, hidden items, theme...) on the person's JoolzApp account, never only on the device or in the app's data folder, so updates and reinstalls never reset them. Pattern: one `pref.<app>` row in `portal_settings` (scope user, app = the app id) written by the server with `setAppPref` (see `src/diner-bell/pocketbase.js`) and read back from `user.portal.prefs`. Copy any older local settings up the first time.
- **One user hierarchy across every JoolzApp: Admin > Editor > Member > View-only.** Portal Admin (Users > Access > Role) sets it with two flags in `portal_settings` (scope user, app ""): `portal.editor` and `portal.readonly` (mutually exclusive); admins come from the Users page. Admin and Editor can edit, confirm and re-render anything shared in any app. A Member can use the app and make small tagged edits (who and when is recorded) that an editor or admin confirms. View-only can use the app but must be refused every change to shared resources server-side (`user.portal.readonly`, admins excepted). The *uploader* (originator of a menu, list, file...) is only a title, but the uploader is treated as an editor of that upload. Every app with shared resources must follow this; copy `isEditor`/`canEdit` from `src/diner-bell/menus.js` and the `editor`/`readonly` fields from `src/diner-bell/pocketbase.js`. Diner Bell enforces it on every write to the shared menu archive.

## Regional defaults (units, temperature, dates, currency, time)
Defaults come from the person's region, never a hard-coded US/UK style. Portal Admin seeds each account once from the device language and time zone
(`regionalDefaults()` in `src/portal-admin/public/app.js`; South Africa = metric, Celsius, DD/MM/YYYY, 24-hour, ZAR) into the shared `pref.*` rows:
`language`, `currency`, `timezone`, `dateFormat`, `timeFormat`, `units` (metric|imperial), `temperature` (C|F). Every app reads them from `user.portal.prefs`,
formats with them, and only falls back to metric / Celsius / DD/MM/YYYY / 24h when a value is missing. Do not add per-app unit or date toggles that ignore them.
