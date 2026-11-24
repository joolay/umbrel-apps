# umbrel-apps: monorepo conventions

This repo is both the Umbrel community app store (`id: joolay`) and the source for every custom app.
Everything is managed here; never create a separate repo for a new app.

## Adding an app called `<name>`
1. Source: `src/<name>/` with a `Dockerfile` (build context is that folder; keep `LABEL org.opencontainers.image.source=https://github.com/joolay/umbrel-apps`).
2. Store entry: `joolay-<name>/` with `umbrel-app.yml` (`id: joolay-<name>`), `docker-compose.yml`, `icon.svg`.
   - The icon is never drawn by hand: add the app to `templates/glass/make-icons.py` and run `python3 templates/glass/make-icons.py <name>` (see `templates/glass/README.md`, "Icons"). Same glass tile for every app, the Portal, Portal Admin and the home screen's built-in tiles.
   - compose `web.image` must be `ghcr.io/joolay/<name>:<version>`, equal to `version` in `umbrel-app.yml`.
   - `app_proxy` uses `APP_HOST: joolay-<name>_web_1`. Pick an unused `port`.
   - Ports must be unique across the WHOLE store: every `port:` in `umbrel-app.yml` and every host port published in a compose file (`"<host>:<container>"`) share one pool. Check with `grep -rn 'port:' joolay-*/umbrel-app.yml; grep -rn '"[0-9]*:[0-9]*"' joolay-*/docker-compose.yml` before picking one. A clash stops whichever app starts second. Port Master also checks every installed app against the official Umbrel store's ports (installed or not) and flags the non-official app to change; official ports are not free for our use, so run the grep AND look at Port Master's clash card (e.g. official `satwatch` 3883, `vert` 3884, `neko` 3880).
   - An owner-only tool that should not get an icon on the JoolzApp home screen sets `JOOLZAPP_DASHBOARD=hidden` in its compose environment.
3. `.github/workflows/build-images.yml` auto-discovers `src/*/Dockerfile`, builds multi-arch, and pushes the image from `main` and `claude/**` branches (so the image exists before the manifest lands on `main`).
4. Releasing an update: bump `version` in `umbrel-app.yml` AND the compose image tag (and `package.json` if present), update `releaseNotes`.
5. The store only updates when the change is on `main`. Develop on the assigned `claude/...` branch, wait for the build to be green, then open a PR / merge when the user asks.

Apps backed by PocketBase should read config via the Portal Admin settings (`src/portal-admin`).
ShutterWorth (`src/shutterworth`) and Portal Admin (`src/portal-admin`) both follow this layout.

## JoolzApp Dashboard and Portal Admin: two apps, one image
The home screen people use is its own store app, `joolay-portal` ("JoolzApp Dashboard"), and it is the one that faces the internet.
It has no `src/portal` folder: its compose file runs the **Portal Admin image** with `command: ["node", "portal.js"]` (source `src/portal-admin/portal.js`),
so the dashboard UI (`src/portal-admin/public`) exists once and the two apps can never drift apart.
- Releasing Portal Admin means bumping BOTH manifests to the same version: `joolay-portal-admin/*` and `joolay-portal/*` (image tag `ghcr.io/joolay/portal-admin:<version>` in both).
- `portal.js` holds no PocketBase login and serves only: the static UI, `/pb/*` (people's own calls; admin APIs and superuser tokens refused) and a fixed list of
  routes passed to Portal Admin's apps-only port as `/user/<route>` with the Portal's own Portal API key (`VIA_ADMIN` in `portal.js` = `PORTAL_ROUTES` in `server.js`; keep them equal).
  Portal Admin always treats those as public, user-only requests. A new server route the dashboard needs must be added to both lists.
- Portal Admin gives the Portal its key by itself (`linkPortal` in `changes.js`), never a superuser or service login, and hides it from app lists and Changes.

## New apps and PocketBase logins (after the security changes)
Once "Limited login for each app" has been applied in Portal Admin > Changes, a newly installed JoolzApp app is linked automatically within
30 s (`linkNewApps` in `src/portal-admin/changes.js`): its data folder gets its own limited `app_service` login and a Portal API key, never the
superuser login. So a new app must work that way from the start: copy `src/jolly-grocer/pocketbase.js` (Portal API hook included), use
`pb.asApp`/`pb.appFetch` for its own data, and add a Changes card (like `009-app-data-storage.js`) that creates its collections and limits them
to `@request.auth.collectionName = "app_service" && @request.auth.appId = "<slug>"`. There is no Connect button any more (removed 23/11/2026): an app that is not linked yet is linked by the Changes card "Limited login for each app".

## JoolzApp-account apps and pocketbase.env
Any `joolay-*` app that signs people in with the JoolzApp account declares `POCKETBASE_APP_ID=<slug>` in its compose file and reads
`<app data>/data/pocketbase.env` (copy `src/jolly-grocer/pocketbase.js`, the newest version). Portal Admin writes that file by itself: within 30 s of a new app
getting its data folder (the app must create it on startup) `linkNewApps` gives it a limited `app_service` login and a Portal API key (needs "Limited login for each app"
applied in Changes; an existing file is never overwritten). Apps must fail closed without the file, but must NOT need a restart: while
accounts are off, call `pb.reload()` on each request (it re-reads the file, at most every 2 s) and make the waiting page refresh itself.

## JoolzApp Dashboard is the App Store
The Portal home screen IS the app store: every app is a tile, tapping one opens a sheet with **View on web** (signs the person in) and **Install** (steps for their device; installing is
done by the browser from the app's own address, so a page cannot do it for another address). Apps are grouped in folders. ONE shared layout (order, dock, hidden apps, folders with names and
descriptions, app names and descriptions) is stored as the global `store.layout` row in `portal_settings`; everyone reads it (`GET /store/layout`) and only an admin saves it (`POST /store/layout`,
checked server-side against `user.isAdmin`, cleaned by `src/portal-admin/storelayout.js`). Admins edit it in place (long-press, drag, rename, folder and app descriptions); nobody else gets edit mode.
Keep `/store/layout` in both route lists (see the Portal section above).

## ONE template file: `jz.js`
The whole shared template (Glass theme, top bar, menu bar and toolbar, Install/Settings/Home/theme buttons, sync and Claude-link icons, global theme loader, drag handle, Quick Access UI) ships as ONE generated file,
`templates/glass/jz.js`, loaded with a single `<script src="jz.js"></script>` first in `<head>` (options `data-claude`, `data-portal`). Edit the source files in `templates/glass/`, run `python3 templates/glass/build.py`
(rebuilds and copies `jz.js` into every `src/*/public/` that has one; `--check` for CI). Never copy the separate template files into an app any more and never hand-edit a `jz.js`. New and edited apps use it (Port Master first);
details in `templates/glass/README.md`. The older sections below that say "copy glass.css / floatbar.css / linkstatus.js ..." now mean "use jz.js".

## Glass theme (uniform style for every JoolzApp)
All apps, old and new, use the shared Glass theme in `templates/glass/` (`glass.css` plus a README with the rules and each app's brand tokens).
Copy `glass.css` into `src/<app>/public/`, link it before the app's own CSS, and set only `--accent` and `--accent-2` in the app. New apps start from it;
existing apps move onto it one at a time. Every `index.html` head also carries: `viewport` with `viewport-fit=cover`, `theme-color`, `manifest.webmanifest`,
`apple-touch-icon` (180px PNG), `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent` and a short `apple-mobile-web-app-title`.

## Global theme and the Admin folder (Theme Editor)
`src/theme-editor` (store app `joolay-theme-editor`, port 3908, owner-only, `JOOLZAPP_DASHBOARD=hidden`) edits ONE global theme on top of `glass.css`: colours, status colours, radius, glass opacity, font and an optional single accent
(`accent.mode: 'global'`; default `'app'` keeps every app's brand accent). It saves through the Portal API (`theme.get`/`theme.set`/`theme.reset`; only the `theme-editor` key may write). Portal Admin cleans it (`src/portal-admin/theme.js`: #rrggbb colours,
clamped numbers, font from a fixed list), stores it as the global `theme.global` row in `portal_settings` and serves it publicly as `/theme.css` (also through the Store, `/theme.css` is in both route lists).
An app follows the global theme by adding `<script src="theme-global.js"></script>` last in `<head>` (copy `templates/glass/theme-global.js`; `data-portal="."` when the app IS the portal, `data-portal="https://..."` otherwise; default is the same host on port 3886).
The theme has a base plus one override set per view (mobile under 600px, tablet 600-1023px, desktop 1024px and up, TV = `<html data-view="tv">`, which `theme-global.js` sets on TV browsers or `?view=tv`); a view with no settings of its own uses the base. It also styles the floating top bar (height, background, blur, line, shadow, title, buttons, icons) but never its position, full width or square corners.
The Store and Portal Admin already load it; other apps move over one at a time, like the Glass theme itself.
Admins also get an **Admin folder** in their JoolzApp Dashboard listing every owner-only app (`JOOLZAPP_DASHBOARD=hidden`): `GET /admin/apps` (admin-checked on the server, in both route lists) feeds a virtual folder that is built per admin and never saved in `store.layout`.

## Login and welcome screens (standard for every app)
Every app's `gate.html` is the shared gate (`templates/glass/gate/`: `gate.css`, `gate.js`, `gate.html`, `sso.html`, `pwtoggle.js`; rules in `templates/glass/README.md`, "Login and welcome screens (gate)"): first-run welcome slides, JoolzApp sign-in with PIN / pattern first on known devices, the "Almost there" and "Can't reach the account server" screens. Do not copy-paste a new login page per app; copy the template files and set the `JZGate({...})` options. A change every app should get goes into `templates/glass/gate/` first. Existing apps move onto it one at a time as they are edited.

## Floating top bar (standard for every app)
Home button first (`data-home`, hidden until the Store's address is known; `floatbar.js` handles it), app icon and title next (`floatbar.js` adds the icon from the apple-touch-icon by itself; changed 23/11/2026, the icon is shown again), light/dark theme icon on the right, a full-width frosted bar fixed to the top edge (square, not pill-shaped). Files and markup are in `templates/glass/README.md` ("Floating top bar"): copy `floatbar.css` + `floatbar.js`.
The JoolzApp Dashboard has it; other apps move over one at a time, like the Glass theme.
The bar is persistent: fixed to the top of the screen while the page scrolls (done in `floatbar.css`/`floatbar.js`; copy both, never make it sticky or scroll away). This is the standard for every app.
Every app's top bar ends with the **profile icon** (account menu, built by `floatbar.js`): a dropdown of large icons in this order: Settings gear, Day/Night mode, Install, Log out at the bottom (Install only in a phone or tablet browser tab, never in a PWA or on a computer). Settings, theme and Install are no longer loose icons in the bar: the app keeps its `data-settings` / `data-theme-toggle` / `data-pwa-install` buttons (hidden by the template) and adds `data-logout` to its sign-out button and `JZBar.setUser({name})` after sign-in; rules in `templates/glass/README.md`, "Account menu".
Every app's top bar also carries the **Settings gear** (`data-settings` button, markup in `templates/glass/README.md`, "Floating top bar"): it opens that app's own Settings screen (its preferences, the things it manages such as shops or categories, data export, and account actions like Sign out). No loose account rows under the bar. Order: Home, title, sync ticks, profile icon. Add it to every app as it is edited; Jolly Grocer has it.
Every app's top bar also carries the **Install** icon (`data-pwa-install` button, `install-help.js` + `installbtn.js`; see `templates/glass/README.md`, "Install icon"): it shows only in a browser tab and opens the install steps for the person's device. Add it to every app as it is edited; Project Pilot and Port Master have it.
Menu bar and toolbar (also called **tab bar** and **selector bar**; the owner uses either name, they mean the same bars): the top bar, an optional **menu bar** and an optional **toolbar** are docked together as ONE fixed block (`.jz-dock`, built by `floatbar.js`) so they stay together everywhere, PWA included. The **menu bar holds the tabs** (the app's sections), always spread equally over the whole bar (global default in `floatbar.css`) and the **toolbar holds the drop-down selectors** (which list, project, shop, period) plus optional quick actions and option groups (`.tool-group`, e.g. Weekly | Monthly | Annually) whose options also always spread equally over the toolbar; not Windows-style File/Edit menus. It is the global default but opt-in: an app adds `<nav class="menubar">` and/or `<div class="toolbar">` after its top bar only if it needs them (and may hide either per screen), so apps without them keep the plain bar. Markup and rules in `templates/glass/README.md` ("Menu bar and toolbar"). Existing apps get their loose tabs and selectors moved into them by hand as each is edited. Sticky bars under the dock use `top:var(--dock-h)`.

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

## Upcoming events (dashboard ticker)
The top bar of the JoolzApp home screen scrolls upcoming events. Apps that own dates (Organiser, school pick-ups, notices) never build their own ticker: write rows to
`portal_events` (see `src/portal-admin/README.md`, "Events and the Organiser") or add a provider in `src/portal-admin/events.js`.

## Change inbox: sending PocketBase changes to Portal Admin
The owner never edits PocketBase by hand. For a settings change (set or remove a global setting such as `portal.url`) add a data file to `portal-changes/<NNN-name>.json` on `main`
(format in `portal-changes/README.md`; `src/portal-admin/inbox.js` reads it, no image build or release needed). It appears in Portal Admin > Changes with a plan and an Apply button.
Same rules as any push: show the owner what it will do and wait for his confirmation, then merge to `main`. For a NEW app, add `portal-changes/<NNN>-install-<name>.json` with `{ "op": "install-app", "id": "joolay-<name>" }` in the same merge: Apply queues it and App Updater installs it by itself once umbrelOS lists it (App Updater's "Install new JoolzApps by itself" is on by default). Anything beyond settings (collections, fields, files) is a built-in change in `src/portal-admin/changes/`.

## Paid apps
Admin > Paid apps (Yoco) locks an app behind payment using the existing `portal.access` rows, so apps need no changes. Details: `src/portal-admin/README.md`, "Paid apps (Yoco)".

## Connected icon and Claude handshake (top bar, every app)
`templates/glass/linkstatus.js` (copy into `public/`, load last in `<body>`) adds the sync ticks (plus the Claude link for Claude apps) to the top bar (`.topbar`, else the first `<header>`/`#bar`), just before the Install/theme buttons:
- **Sync ticks** (every app, WhatsApp style; replaces the old green/red dot): red cross = not connected or the last save failed; pulsing grey tick = saving / kept on this device only; **one green tick = recorded to PocketBase** (the person's JoolzApp account);
  **two green ticks = read by all shared parties** (second tick amber while only some have read it; data nobody else shares counts as read once recorded). The server is checked every 15 s (HEAD) plus online/offline events.
  An app that says nothing shows one green tick while its server answers. An app that keeps data on the account reports its state: `JZLink.sync({ saved: "saving"|"saved"|"error"|"local", parties: <others it is shared with>, read: <how many have read the latest> })` (Jolly Grocer does this from its save routine).
- **Claude link = the same ticks** (only apps that talk to Claude: App Updater, Services Manager, Kiosk Manager, Port Master, Project Pilot; add `data-claude` to the `jz.js` tag). There is no separate chain-link or handshake icon any more:
  two green ticks = Claude has read the last change; one green tick = the app wrote something Claude has not read; amber second tick = Claude wrote something the app has not read; red cross = broken (a report the app should have made has not come through, nothing for 35 minutes).
  It reads `GET /api/link` on the app's own server, which returns `feed.link()` from `status-feed.js` (the state Portal Admin sent back with the last report).
- Protocol (state logic and tests: `src/portal-admin/claudelink.js`, `test-claudelink.js`): `status/<app>.json` now carries `rev` (counts real changes, a heartbeat does not), `changedAt`, `sig` and `seenClaude` (the newest Claude message rev the app has read).
  Claude's side is `status/claude-<app>.json`, written ONLY by Claude when it changes something for that app: `{ "toApp": { "rev": <n+1>, "at": "<ISO>", "note": "<what changed>" }, "seen": { "deviceRev": <the app's rev just read>, "at": "<ISO>" } }`.
  After reading `status/<app>.json`, set `seen.deviceRev` to its `rev` (that turns the app's hand into "read"); after a change, bump `toApp.rev` (the app marks it read on its next report, normally within a minute or two).
  Fresh read before every write, change only that file.
- **AI sparkle** (every app with AI features, e.g. ones that call a model): `JZLink.aiWhile(promise)` (or `JZLink.ai(true|false)`) shows a breathing sparkle beside the ticks while the AI is working and hides it afterwards. Part of `jz.js`; see `templates/glass/README.md`, "AI sparkle".
- New apps that talk to Claude: copy `status-feed.js`, keep the handle (`feedHandle = require('./status-feed')(...)`), serve `/api/link`, add `data-claude`.
- JoolzTV (TV UI) has no top bar and is left out on purpose; see the TV rules.

## Look for an existing community add-on or service first
Before building a feature from scratch (skip intro/credits, subtitles, metadata, ...), search for a community Stremio add-on or public community database that already provides it, and say what was found. Build our own only when nothing usable exists, and keep it as the fallback.

## TV-specific views and Quick Access
- A specialised TV browsing view (remote/D-pad navigation, 1920x1080 layout, Chromium 53 build) belongs only in JoolzApp apps that are meant for the TV, such as JoolzTV. Do not bake TV-specific architecture into other apps unless asked.
- Quick Access (PIN or pattern, `src/portal-admin/quickaccess.js`) is a convenience on top of the main password, never a replacement for it. Admins reset a person's main password as usual; there is no separate admin tool for Quick Access beyond "Sign out everywhere" (Admin > Users > Sign-in), which also removes the person's Quick Access devices.

## Project Pilot notes (read before working on an app)
Each project in the shared list (`appdev.json` in `joolay/tracking-data`) can carry `notes` the owner wrote in the Project Pilot app. Before starting work on one of his apps,
fetch that file (poll it fresh), read the project's `notes`, and treat the open ones as part of the request. When a note has been dealt with, set its `state` to `review`
(never delete it yourself), tell him what changed and ask him to confirm. He clears it in the app (or tells you to). Write back with a fresh read first, changing only that project.
If you finish with something unfinished on a project (an open question, a problem that still needs attending, a follow-up you could not do), leave him a note on that project too: add `{ "id": "<new id>", "text": "...", "at": "<ISO now>", "state": "open", "by": "claude" }` to its `notes` (same fresh read, change only that project). The app shows `by: "claude"` notes with a Claude badge, and he can edit any note.

## Project Pilot Task schedule (queue for Claude's nightly run, Project Pilot 1.9.0)
In a project's notes dialog **Add to queue** puts the project in the Task schedule tab. The queue lives on the project in `appdev.json`: `queue: { state: queued|held|running|done|failed, at, pos, merge, startedAt?, doneAt?, result?, runs? }`; the list carries `schedule: { days: [1], time: "20:00", offsetMin: 120, lastRun? }` (weekdays 0=Sunday, default every Monday 20:00 South African time; editable in the tab) (rules in `src/project-tracker/lists.js`: `cleanQueue`, `nextRun`, `queueRows`).
The Claude scheduled task runs HOURLY and only acts when a run is due: fetch `appdev.json` fresh, compute the latest scheduled moment (`days`/`time`/`offsetMin`) that has passed, and stop unless it is after `schedule.lastRun`; otherwise set `schedule.lastRun` to now and go on. Then: fetch `appdev.json` fresh, take projects with `queue.state === "queued"` in `pos` order, set `running`, work their open notes on a `claude/...` branch, build, push, wait for the green build, merge to main only when `queue.merge` is true (otherwise stop after the build), set the handled notes to `review`, then write `queue` back as `done` or `failed` with `doneAt` and a short `result` (fresh read, change only that project). On failure leave a `by: "claude"` note. Adding to the queue is the owner's confirmation that all notes are in (an unattended run cannot show a preview).

## Status feed: monitoring the apps on the Umbrel (read before diagnosing a problem)
Nothing on the Umbrel is opened to the internet for monitoring. App Updater, Services Manager and Kiosk Manager (and any app that copies `status-feed.js`, see `src/portal-admin/README.md`, "Status feed")
push a cleaned status file to `status/<app>.json` in the feed repo (default `joolay/tracking-data`, readable like `appdev.json`). Before diagnosing an update or a server problem,
fetch `status/app-updater.json` / `status/services-manager.json` / `status/kiosk-manager.json` fresh and check `at` (older than about 35 minutes means the app or the feed is down). Read-only: never try to act through it.
A new owner-only app that should be monitorable: copy `status-feed.js`, call it with a `getPayload` that returns useful, secret-free state, declare `POCKETBASE_APP_ID`, add it to the notes here.


## Gatekeeper (`src/gatekeeper`, store app `joolay-gatekeeper`, port 3921, owner-only, `JOOLZAPP_DASHBOARD=hidden`)
The gate in front of the apps, **layered behind an unmodified TSDProxy** (TSDProxy keeps the Tailscale names and Funnel and stays on its automatic updates). A protected app's TSDProxy name is pointed at Gatekeeper (port 3921) instead of the app;
Gatekeeper reads the name (`X-Forwarded-Host` / `Host`, first label) -> a route in `<data>/gatekeeper.json` (`name`, `slug`, `upstream`, `adminOnly`, `enabled`), makes the person sign in with their JoolzApp account (Portal API `login`), asks Portal Admin `gate.can(userId, slug)`
(Gatekeeper's key only: the same `portal.access` rules apps follow, plus the app's on/off switch; admins open everything; fails closed), then proxies (HTTP and WebSockets) with the gate's own cookie removed and `X-Gatekeeper-User` / `X-Gatekeeper-Admin` added.
It runs beside the current routes: nothing changes until a name is pointed at it. Gatekeeper's one job is access control; routing stays with Port Master, so **Tailscale name upkeep (the TSDProxy names, not ACL tags) belongs to Port Master** (decided 23/11/2026, built in Port Master 1.9.0: `src/routing-reporter/names.js`). Not in v1: the Umbrel-password rule for Umbrel's own dashboard, the Community Apps admin-only list. Sign-in is per name (a cookie on each name) until a cross-name hand-off is added.
Portal Admin is also published on the tailnet (`portaladmin`, port 3909, never Funnel); it signs in with the PocketBase admin login as before.

## Port Master (formerly Routing Reporter): monitoring access routes (LAN, Tailscale, Public)
`src/routing-reporter` (store app `joolay-routing-reporter`, port 3906, owner-only, `JOOLZAPP_DASHBOARD=hidden`) reads every installed app's manifest and compose file, checks each app's LAN, Tailscale-IP
and TSDProxy (Funnel = Public) route from inside the Umbrel, and sends the report to Portal Admin (`publishRoutes` in the Portal API, kept by `src/portal-admin/routes.js`).
Portal Admin > **JoolzApp apps** shows it; an admin taps **Notify Claude** on a down route, which writes `status/route-alerts.json` in the feed (app, route, URL, error, since when; clears itself when the route answers).
Port Master's own summary is `status/routing-reporter.json`: every app with its name, port, published host ports, each route's address and state, a sorted `ports` list and any `portConflicts` (not only the problems). Before diagnosing "can't reach app X" fetch `status/route-alerts.json` and `status/routing-reporter.json` fresh and check `at`. Read-only, like the rest of the feed.

## Tailscale names (Port Master 1.9.0)
Port Master creates, renames and fixes the Tailscale (TSDProxy) names of apps that have none: TSDProxy tab > "Tailscale names" (automatic and on from the start: every app without a name gets one; Remove keeps it off for that app via `noNames`, Create brings it back; Settings has Create names for all apps without one). They live in Port Master's OWN TSDProxy list file `joolz-names.yaml` (tailnet only, never Funnel;
declared once in `tsdproxy.yaml` with a `.bak`, then `restart-tsdproxy` for Services Manager); Portal Admin's `joolz-published.yaml` (OpenClaw) is separate and untouched. Names in an app's compose labels (ours) or Portal Admin's list are never changed from there, only checked.
Fixes by itself: clash -> free name, app gone or named itself -> entry dropped, port moved or file edited -> rewritten. Existing names stay as they are. Wishes are kept in Port Master's config (`names`, `noNames`, `autoNames`, on unless set to false). Tests: `test-names.js`, `test-names-flow.js`.

## TSDProxy keeper (Services Manager) and route switches (Port Master)
TSDProxy is not an Umbrel App Store app, so `src/services-manager/tsdproxy.js` looks after it (Services Manager owns the Docker socket): it adds an API key to `tsdproxy.yaml` once (`apiKeyFile`, then one restart), reaches the REST API on TSDProxy's Docker network,
pauses/resumes proxies listed in `joolz-paused.json` (written by Port Master; a TSDProxy restart forgets a pause so it is re-applied every 15 s), reads the version, pulls the image about every 12 hours and replaces the container in the nightly window or on request (old one put back if the new one does not stay up).
It reports in `tsdproxy-status.json` in TSDProxy's settings folder (read by Port Master and App Updater); App Updater writes `tsdproxy-settings.json` (automatic update + time) and `tsdproxy-update-request` (Update now). Port Master's ticks call `/api/route`: Public and Tailscale-name pause the proxy, LAN/.local/Tailscale address only stop being counted (`src/routing-reporter/control.js`).
Port Master's features list (`public/features.js`) is the map of what is live, built and proposed: keep it up to date with each release. Any new `.js` file a server needs must also be added to that app's Dockerfile `COPY` line.
