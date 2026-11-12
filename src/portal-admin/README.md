# Portal Admin

Central admin panel for custom apps that share a PocketBase.

- **Global settings**: defaults for every app and user.
- **Apps**: register apps; enable/disable, maintenance mode + message, per-app settings.
- **Users**: browse/create/edit/delete PocketBase users, block a user (everywhere or per app), per-user setting overrides, effective-settings preview.
- **Audit log**: every change made here.

Precedence: `global < app < user (all apps) < user × app`.

## How it works
Zero-dependency Node server serving a static UI and proxying `/pb/*` to your PocketBase (built in: the Umbrel PocketBase app at `http://host.docker.internal:5400`; override with `PB_URL`). No credentials are stored: you sign in as a PocketBase **superuser** and the browser keeps the token in `sessionStorage`. On first sign-in it offers to create three collections: `portal_apps`, `portal_settings`, `portal_audit`. `portal_settings` is readable by signed-in app users only for non-secret global/app rows and their own user rows; writes are superuser-only.

Reserved key: `portal.access` = `false` blocks a user (app = blank → all apps). Apps must check it (see snippet on the Setup page).

## Run locally
```bash
PB_URL=http://127.0.0.1:8090 PORT=3000 node server.js
```

## Umbrel
Image is built by the monorepo workflow (`.github/workflows/build-images.yml`) to `ghcr.io/joolay/portal-admin:<version>`; the Umbrel manifest is `joolay-portal-admin/`. Bump `version` in `package.json`, the manifest and the compose image tag together.

## Umbrel app sync
With `UMBREL_MCP_TOKEN` set (Umbrel MCP token; optional `UMBREL_MCP_URL`, default `http://host.docker.internal/mcp`, and `UMBREL_APP_PREFIX`, default `joolay-`), `/umbrel/apps` lists matching Umbrel apps (read-only: `list_apps`, `get_app_details`). While an admin is signed in, the UI adds missing apps to `portal_apps` (slug = Umbrel id minus the prefix) and fills blank url/description, on sign-in, every 5 minutes, and via **Sync from Umbrel**. It never overwrites edits or deletes apps.
