# Torrentflix

Netflix-style front end for the Stremio streaming server, with profiles that sync between the browser and the LG webOS TV app.

- **UI** (`public/`) is mirrored from [joolay/homebrew](https://github.com/joolay/homebrew) `app-flix/` (the same code the TV app runs). Refresh it with
  `src/torrentflix/sync-ui.sh /path/to/homebrew`, then bump the version in `joolay-torrentflix/umbrel-app.yml` and `docker-compose.yml`.
  It deliberately does **not** use the Glass theme: it is a TV-style interface (1920x1080, D-pad navigation) that scales to the browser window.
- **Streaming server**: none bundled. The UI talks to the Stremio app's server (`joolay-stremio`, host port 11470); `server.js` serves `/config.js` with `http://<host>:11470`.
- **Sources**: Torrentio only (top 3 by seeds in 4K / 1080p / 720p / other). Posters and details: Cinemeta. Subtitles: OpenSubtitles.
- **`server.js`** (no dependencies):
  - `PORT` (3900): the UI + `/config.js` + the API, behind Umbrel's login via app_proxy.
  - `API_PORT` (3901): only `/tf/api/*` and `/healthz`, with CORS, for the TV app.
  - `POST /tf/api/sync {state}` merges `profiles`, `p<id>.resume` and `p<id>.list` maps entry by entry (newest `ts` wins, deleted profiles are tombstoned) and returns the merged state. Data lives in `<app data>/data/state.json`.
- No JoolzApp account / PocketBase integration yet: profiles are stored by Torrentflix itself.

Test: `node src/torrentflix/test.js`
