# TV Remote (Umbrel app `joolay-tv-remote`)

See and control your rooted LG webOS TV from a browser. The TV's agent (app **TV Remote** in `joolay/homebrew`, `app-remote/`) connects **out** to this app, so people connect to the Umbrel, never to the TV, and the TV does nothing while nobody watches.

- **Page** (port 3000 behind Umbrel's login, `PROXY_AUTH_ADD`): list of TVs, *Add TV* (shows a 4-digit pairing code), live picture (multipart stream, Eco / Normal / Fast), remote keys, text, app launch, rename / remove. Owner-only tool: `JOOLZAPP_DASHBOARD=hidden`.
- **Agent port** (3905, published): `POST /agent/pair {code,name}` and a WebSocket `/agent/ws` with `Authorization: Bearer <token>`. Nothing else is served there. The pairing code is 4 digits, valid 10 minutes, single use, and 5 wrong tries cancel it. Only a SHA-256 of each TV's token is stored (`/data/tvs.json`).
- **Going easy on the TV:** one screenshot request at a time; one capture shared by all viewers; the gap grows (up to 3 s) while the picture is unchanged and resets on a key press; no viewer, no capture. A slow viewer skips frames.
- State-changing requests need the `X-Requested-With: tvremote` header (cross-site safety).
- `ws.js` is identical to `app-remote/agent/ws.js` in `joolay/homebrew`: change both together.

Tests: `node test/test.js`.
