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
Portal Admin can double as the public front door for all your apps (see `deploy/joolzapp-tunnel`). Requests that arrive
through Tailscale Funnel (or with a non-private `X-Forwarded-For` address) are treated as public: they may sign in as a
normal user, change preferences and request app access, but admin sign-in, superuser sessions and PocketBase's
admin/collection APIs are refused. Admin works from your home network or tailnet. `ALLOW_PUBLIC_ADMIN=1` turns the guard off.

Register each app's public address in **Apps > URL**; approved users then get an **Open** button on their My settings page.

## Setting a user's password
Users > a user > **Set password** changes the password immediately (no email needed) and signs the user out everywhere.
**Generate** fills a random password you can copy and pass on.
