# OpenClaw, built from source for the JoolzApp store

Store app `joolay-openclaw` (port 3927, owner-only, `JOOLZAPP_DASHBOARD=hidden`, tailnet only, never Funnel). OpenClaw is MIT licensed; this folder does not copy its code.
The build checks out the upstream release tag in `OPENCLAW_REF`, uses upstream's own `Dockerfile` unchanged, and adds one last stage (`Dockerfile` here) with our startup files.

## How the image is built
- `.github/workflows/build-images.yml` sees `prepare.sh` and runs it first: `prepare.sh <folder>` clones the tag, copies `joolz/` in and appends our `Dockerfile` to upstream's. The image is built from that folder.
- `platforms` limits the build to `linux/amd64` (the Umbrel is x86_64). Building arm64 would need QEMU and takes hours; add `linux/arm64` there only if an arm64 Umbrel ever needs it.
- Locally: `sh src/openclaw/prepare.sh /tmp/oc && docker build -t openclaw-test /tmp/oc` (needs about 8 GB of memory for upstream's build).
- `src/openclaw/Dockerfile` is not stand-alone on purpose (`FROM openclaw-runtime`, a stage that only exists once `prepare.sh` has appended it).

## What is preconfigured (`joolz/preset.mjs`, on every start)
Written into `<app data>/data/state/openclaw.json`; everything else in that file is left as OpenClaw or the owner wrote it:
- `gateway.publicOrigin` = `https://<TS_NAME>.<TAILNET>` (the Tailscale name; TSDProxy ends the TLS, so the Control UI's WebSocket is **wss://**),
- `gateway.controlUi.allowedOrigins` = that name, `http://<TAILSCALE_IP>:3927` (ws://), `http://<LAN_HOST>:3927` and loopback,
- `gateway.trustedProxies` = Umbrel's app network and Docker's bridge range (where TSDProxy and Umbrel's proxy reach it from; `TRUSTED_PROXIES` overrides),
- `gateway.mode=local`, `bind=lan` (inside the container only), `port=18789`, `tailscale.mode=off` (the name is TSDProxy's job, never OpenClaw's own Serve/Funnel).
The values come from the compose environment (`OPENCLAW_TAILNET`, `OPENCLAW_TS_NAME`, `OPENCLAW_TAILSCALE_IP`, `OPENCLAW_LAN_HOST` override the defaults for this Umbrel). `EXTRA_ORIGINS` adds more.
A config that is not valid JSON/JSON5 is never overwritten: the container logs why and stops.

## Sign-in
Auth is OpenClaw's own: a gateway token made on first start, kept in `<app data>/data/state/joolz-gateway-token` (mode 600, never in the image or repo; set `OPENCLAW_GATEWAY_TOKEN` to use your own).
Paste it into the Control UI the first time; each browser/device is then paired with OpenClaw's own device approval. No Umbrel login sits in front (`PROXY_AUTH_ADD: "false"`), because its WebSockets and native clients cannot pass it.

## The Tailscale name
Portal Admin > Changes > "Tailnet address for OpenClaw" (`src/portal-admin/changes/014-tsdproxy-published.js`) publishes `https://openclaw.<tailnet>` to this app's port in TSDProxy's list file (tailnet only).
It finds `joolay-openclaw` (or the Umbrel store's `openclaw`) and rewrites a stale entry that still points at the old port.

## Updating OpenClaw
1. Pick the new upstream tag, put it in `OPENCLAW_REF` (`vYYYY.M.D`).
2. Bump `version` in `joolay-openclaw/umbrel-app.yml` AND the image tag in its `docker-compose.yml` (version = tag without the `v`), update `releaseNotes`.
3. Push on a `claude/...` branch, wait for the green build, merge to `main`. Config and token in the data folder carry over.

## Test
`node src/openclaw/test-preset.mjs`
