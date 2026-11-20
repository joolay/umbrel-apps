# Portal Admin

Central admin panel for custom apps that share a PocketBase.

- **Global settings**: defaults for every app and user.
- **Apps**: register apps; enable/disable, maintenance mode + message, per-app settings.
- **Users**: browse/create/edit/delete PocketBase users, block a user (everywhere or per app), per-user setting overrides, effective-settings preview.
- **Access requests**: users ask for access to other apps; approving sets `portal.access = true` for that user and app.
- **Audit log**: every change made here.
- **My settings** (regular JoolzApp users sign in on the same form): language, currency, time zone, date/time format, units, theme (stored as all-apps user settings `pref.*`, so every app gets them via the normal precedence), service access requests, and a request to delete their account (nothing is deleted until you confirm it under Access requests).

Precedence: `global < app < user (all apps) < user × app`.

## How it works
Zero-dependency Node server serving a static UI and proxying `/pb/*` to your PocketBase (built in: the Umbrel PocketBase app at `http://host.docker.internal:5400`; override with `PB_URL`). No credentials are stored: you sign in as a PocketBase **superuser** and the browser keeps the token in `sessionStorage`. On first sign-in it offers to create the collections `portal_apps`, `portal_settings`, `portal_requests` and `portal_audit`. `portal_settings` is readable by signed-in app users only for non-secret global/app rows and their own user rows; users may only edit their own `pref.*` rows; other writes are superuser-only.

Reserved key: `portal.access` = `false` blocks a user (app = blank → all apps). Apps must check it (see snippet on the Setup page).

## Run locally
```bash
PB_URL=http://127.0.0.1:8090 PORT=3000 node server.js
```

## Umbrel
Image is built by the monorepo workflow (`.github/workflows/build-images.yml`) to `ghcr.io/joolay/portal-admin:<version>`; the Umbrel manifest is `joolay-portal-admin/`. Bump `version` in `package.json`, the manifest and the compose image tag together.

## Account approval
Setup → *Require admin approval per app* sets a global `portal.access = false` (every app closed by default) and gives existing users a user-wide `portal.access = true` so they keep access. New sign-ups request each app and you approve them one by one under *Access requests*, which sets `portal.access = true` for that user × app. Apps only need the `portal.access` check they already do.

## Public access guard and the hub
Portal Admin can double as the public front door for all your apps (see `deploy/tsdproxy`). Requests that arrive
through Tailscale Funnel (or with a non-private `X-Forwarded-For` address) are treated as public: they may sign in as a
normal user, change preferences and request app access, but admin sign-in, superuser sessions and PocketBase's
admin/collection APIs are refused. Admin works from your home network or tailnet. `ALLOW_PUBLIC_ADMIN=1` turns the guard off.

Register each app's public address in **Apps > URL**; approved users then get an **Open** button on their My settings page.

## Setting a user's password
Users > a user > **Set password** changes the password immediately (no email needed) and signs the user out everywhere.
**Generate** fills a random password you can copy and pass on.

## Dashboard and My settings
People who sign in (not admins) land on the **Dashboard**: every app registered under Apps as a tile. **Open** goes to the app's
address (signed in already where the app supports it); apps they aren't approved for show a request form. Admins have a
**Dashboard** link in the sidebar to preview exactly what users see. On the public address the page is branded JoolzApp.
**My settings** has three tabs: Preferences, AI and Account (account deletion request).


## Events and the Organiser

The home screen has an **Upcoming** ticker in the top bar (tap it for the full list). It reads `GET /events?days=60&today=YYYY-MM-DD` with the person's own token, served by `events.js`.
Each event is `{ id, kind, title, sub, date, time?, allDay, source, link? }`; `kind` picks the icon (`birthday`, `pickup`, `notice`, anything else = calendar).

Providers today:
- **Birthdays** (built in): everyone in the person's circle: their household, its extended relatives, and the households they are extended family of. Only the day, month and the age they turn leave the server. A PocketBase superuser sees the ticker too, as the JoolzApp person with the same email address (if none exists, there is nothing to show).
- **Organiser hook**: the planned Organiser app (family events, notices, school pick-up schedules) writes rows to a PocketBase collection `portal_events` and they appear with no change here.
  Fields: `title`, `start` (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`), `kind`, `sub`, `link`, `source`, `familyId` (a `joolz_families` id: shown to that family's circle) and/or `userIds` (comma-wrapped ids, e.g. `,u1,u2,`: shown to those people). A row with neither is shown to everyone. If the collection does not exist yet, nothing breaks.
- **Notices from apps**: an app with a Portal API key can call `publishEvent({title, sub, kind, start})` (Portal API, `appclient.js`). It writes a `portal_events` row for everyone (no `familyId` or `userIds`), with `source` set to the calling app. A notice shows only on the day it is dated, and each app's own notices older than a week are deleted when it posts. Needs Changes > "Dashboard notices from apps" (`004-portal-events`), which creates the collection. App Updater uses it for "<app> updated" (`kind: update`, shown with a refresh icon).

## Paid apps (Yoco)

Admin > Paid apps locks an app behind a Yoco payment. It reuses the `portal.access` rows, so no other app needs changing: a locked app has an app-level
`portal.access=false`, and each person who pays (or is chosen by the admin) gets a user-level `portal.access=true` plus a `portal.entitlement` row
(`{until, via: yoco|admin|household, paymentId, payerId, familyId, amount}`). The admin always keeps access.

- Per app (`app.paywall`, app scope): `{mode: once|period, days, price, householdPrice}` in cents. Yoco takes ZAR only, minimum R2.
- Pay: `POST /pay {slug, scope: person|household}` creates a Yoco checkout and returns `redirectUrl`; the person returns to `#/paid/<slug>`, which polls `/pay/status`.
- Unlock: Yoco calls `POST /yoco/webhook` (public listener, Standard Webhooks signature, `payment.succeeded`, our `metadata.kind = joolzapp-access`, amount must match). The redirect alone never unlocks.
- The webhook needs the public (Funnel) address. Set it under Paid apps > Yoco, then Register webhook. Without it the admin can still unlock people by hand.
- An hourly sweep expires passes and keeps household passes in step with the household's members.
- Config lives in `portal_settings` (global): `yoco.secretKey`, `yoco.webhookSecret` (both secret) and `yoco.publicUrl`.

## Spouse links

Spouse is a special, one-at-a-time link between two adults in the same household (Family > Spouse). Stored on the household's member records
(`spouse: <other id>`; the pending request carries `spouseOf`). Two ways in:
- **Link an existing account** (`inviteSpouse`): a request the other person accepts under Family. Refused if either already has a spouse.
- **Create a new account** (`createSpouse`): the creator is linked straight away; the new adult account is held for admin approval
  (`joolz_guardians` row `kind=admin`, plus a `portal_requests` row `__spouse_account__`). `guardians.statusOf` reports `adminPending` for adults too.
`unlinkSpouse` clears both sides. A linked spouse can't be moved out of the household until unlinked.

## Home screen: folders, dock and background

- **Folders:** in rearrange mode, hold one icon over another (or press New folder) to make a folder; hold an icon over a folder to add it. Folders can sit on the grid or in the dock, never nest, and can't hold Settings/Admin. Stored in the same `pref.home.layout` row: `folders: { <id>: { name, items: [ids] } }`; the grid/dock list them as `folder:<id>`.
- **Dock:** icons grow as the mouse approaches (mouse only).
- **Background:** an animated, Umbrel-style colour-glow backdrop (`#bg`). Chosen in My settings > Preferences: `pref.background` (aurora, sunset, ocean, forest, violet, plain) and `pref.backgroundMotion` (animated, still). Reduced-motion devices never animate.

## App names (people rename their own apps)
On the JoolzApp home screen, Edit then the pencil on an app tile renames it for that person only. The names are kept in the person's own layout row (`pref.home.layout`, field `names`: `{ slug: "name" }`, 30 characters, no `<` `>` or control characters), so they follow the account to every device. Admin > **App names** (`/admin/app-names`, `appnames.js`) lists every rename (person, original name, their name) and can **Reset** one app or **Reset all** for a person; only the `names` field is changed. Also: if a stored app name differs from the app's own name only by capital letters (an older `joolztv`), Portal Admin tidies it to the manifest name; a name you chose yourself is never changed.

## QR sign-in for JoolzApp accounts
`qrlogin.js` keeps short-lived requests in memory (2 minutes; a restart cancels pending ones). An app with a Portal API key calls `qr.start` (gets an id and a secret) and `qr.poll` (id + secret). The phone side is the Portal's `/qr` route (`GET ?id=` to look, `POST {id, approve}`), which needs a signed-in person's own token; the dashboard shows it at `#/qr/<id>` with an Approve / Deny button. An approval is handed to the asking app once and says only the person's id; the app signs them in itself (apps mint their own sessions), so no PocketBase token leaves Portal Admin. Limits: 12 requests per app per minute, 300 waiting at once, ids are 128-bit random, the secret is checked in constant time, a wrong app or secret looks like "expired". `/qr` is in both `PORTAL_ROUTES` (`server.js`) and `VIA_ADMIN` (`portal.js`). Tests: `test-qrlogin.js`, `test-qr-api.js`.

## Quick Access (PIN / pattern) and signing people out
A faster, less secure way back in on a device the person already signed in on. Offered right after sign-up and set up in My settings > Quick Access (`quick.js`, `quickaccess.js`, route `/quick`). The device gets a random device id + secret; Portal Admin keeps only hashes in a hidden `qa.<deviceId>` row of `portal_settings` (secret = true) with the code hashed by scrypt. Signing in needs device id + secret + code; 5 wrong codes in a row remove the device's Quick Access, tries are spaced 700 ms apart. A 4 digit PIN, 6 digit PIN or a pattern (4 to 9 different dots, stored as `p:<dots>`). The Portal gets a PocketBase session by superuser impersonation (14 days; needs PocketBase 0.23+, otherwise the person sees a clear message); apps call `qa.login` / `qa.setup` / `qa.list` / `qa.remove` through Portal API and mint their own session.
**Sign out everywhere:** Admin > Users > person > Sign-in (`/admin/quick`), or the person's own button, deletes all their Quick Access devices and stamps `portal.signedOutAt` (readable by their own apps, writable only by the superuser); it also rotates the PocketBase `tokenKey` (best effort). The Portal compares the stamp with its own sign-in time (server clock) every minute; JoolzTV rejects sessions that began before it. Quick Access is a routine reason to reset a lost TV: remove it from My settings.

## Admin home screen (0.31.0)
Portal Admin no longer lists apps. For an admin its home screen shows the admin tools directly (no Admin folder); people open their apps from the JoolzApp Portal.
Its layout is saved on the account as `pref.adminhome.layout`, separate from the Portal's `pref.home.layout`.

## AI keys (0.32.0)
My settings > AI keeps a small vault of API keys per JoolzApp account (Anthropic, OpenAI, Google Gemini, OpenRouter, custom endpoint; up to 12).
Rows live in `portal_settings` with app `ai-vault` and key `ai.key.<id>`, so no other app can see them. Choosing a key writes the existing `pref.ai.*`
rows (`provider`, `model`, `apiKey`, `baseUrl`, `keyId`): at app "" for the default, or at an app slug to override one app (`resolvePortal` already lets the app row win).
AI apps therefore need no change. The browser only gets the last 4 characters; add/remove/select/test go through `POST /account/ai` (`src/portal-admin/ai.js`, in `PORTAL_ROUTES` and `VIA_ADMIN`).
The first key added becomes the default, and an older single key is moved into the vault on first open. A new AI app must be added to `AI_APPS` in `ai.js`.

## Status feed (0.33.0)
Apps can publish a status file for the owner (and Claude) to read, with nothing exposed to the internet. An app calls Portal API `publishStatus(payload)`
(`src/app-updater/status-feed.js` does it every minute, identical copy in Services Manager; copy it into any new app that should report). Portal Admin (`statusfeed.js`)
removes passwords, tokens, keys and long secret-looking strings, caps sizes, and writes `<folder>/<app>.json` to the GitHub repo set in Admin > App keys > Status feed
(default `joolay/tracking-data`, folder `status`) with a GitHub token kept only in a secret `portal_settings` row (app `status-feed`). It skips unchanged payloads and rewrites at least every 30 minutes,
so the file's `at` time shows whether the app is alive. `POST /admin/status-feed` (admin, home network only) saves, tests and clears the settings.

