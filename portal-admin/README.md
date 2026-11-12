# Portal Admin

Central admin panel for custom apps that share a PocketBase.

- **Global settings**: defaults for every app and user.
- **Apps**: register apps; enable/disable, maintenance mode + message, per-app settings.
- **Users**: browse/create/edit/delete PocketBase users, block a user (everywhere or per app), per-user setting overrides, effective-settings preview.
- **Audit log**: every change made here.

Precedence: `global < app < user (all apps) < user × app`.

## How it works
Zero-dependency Node server serving a static UI and proxying `/pb/*` to your PocketBase. No credentials are stored: you sign in as a PocketBase **superuser** and the browser keeps the token in `sessionStorage`. On first sign-in it offers to create three collections: `portal_apps`, `portal_settings`, `portal_audit`. `portal_settings` is readable by signed-in app users only for non-secret global/app rows and their own user rows; writes are superuser-only.

Reserved key: `portal.access` = `false` blocks a user (app = blank → all apps). Apps must check it (see snippet on the Setup page).

## Run locally
```bash
PB_URL=http://127.0.0.1:8090 DATA_DIR=./data PORT=3000 node server.js
```

## Umbrel
Image is built by `.github/workflows/portal-admin-image.yml` to `ghcr.io/joolay/portal-admin:<version>` (make the package public). Bump `version` in `package.json`, `joolay-portal-admin/umbrel-app.yml` and the compose image tag together.
