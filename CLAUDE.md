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
Externally built apps (e.g. ShutterWorth) keep their own repo and image.
