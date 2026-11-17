# JoolzTV

Apple TV style ("glass") front end for the Stremio streaming server, locked behind JoolzApp accounts. Also the interface of the LG webOS TV app
(a tiny launcher in [joolay/homebrew](https://github.com/joolay/homebrew) opens this site on the TV).

## How it fits together
```
browser / LG TV launcher ──>  web (server.js, port 3900; host 3901 = public Funnel address)  ──>  server (Stremio streaming server, never published)
                                │  JoolzApp (PocketBase) sign-in, household, per-profile data                      ▲
                                └──────────────  /s/<stream token>/…  (video, only for signed-in profiles)  ───────┘
```
- **One JoolzApp account per profile, up to 12 profiles per household.** First run (empty household): a wizard signs in with a JoolzApp account (becomes the owner),
  then offers to add the other members (their email + password, optional "stay signed in on this TV"). Later: "Who's watching?" picker, then sign-in unless that
  profile stays signed in on the device. Tokens are renewed every time they are used, so a sign-in lasts 90 days since you last used the app (PocketBase's token lifetime
  for `users` is set to 90 days by Portal Admin > Changes, as for the other apps).
- **Access rules** are the shared JoolzApp ones (`gateOf` in `server.js`: admin approval via `portal.access`, app disabled/maintenance, guardian approval for minors).
- **Data**: `<data>/household.json` (profiles) and `<data>/users/<accountId>.json` (My List + watch progress, newest entry wins). Removing a profile deletes that account's file.
- **Streaming**: `POST /api/stream-token` gives a signed 12-hour token; video is `/s/<token>/<infoHash>/<file>` or `/hlsv2/...` proxied to the streaming server (only those paths, ranges supported, HLS playlists rewritten). The streaming server has no port published.
- **Open on purpose**: `/healthz` (the TV launcher uses it), `/config.js`, the static UI, sign-in and password-reset requests. Everything else needs a household member's token (`x-jtv-token`).

## Subtitles matched to the file
OpenSubtitles (built in) is asked for subtitles for the exact file: first by file name and size, then again with the file's own fingerprint (`/opensubHash`, read by the streaming server from the torrent, through the sign-in proxy).
`ui/js/subs.js` ranks the results: an exact fingerprint match first, then the same release (group, source such as BluRay/WEB-DL, resolution, codec, shared name words), grouped by the profile's language (Settings: language, second language).
The Subtitles menu shows "Exact file" / "Best match" first, with "Subtitles earlier/later (±0.5 s)" once one is on. Settings can switch on automatic selection of the best match (per profile, off by default).

## Direct play or transcoding
Decided per file before playback (`Api.assess` in `ui/js/api.js`, checked by `test-subs.js`) from the release name and what the device reports it can decode (`canPlayType`):
AV1, old formats (AVI/XviD), 10-bit H.264, Dolby Vision, DTS/TrueHD (TV), and HEVC / Dolby Digital (+) when the device lacks them are transcoded to HLS by the streaming server; everything else plays directly.
The player shows which one it is ("Direct play" / "Transcoding: reason"). If a guess is wrong the player steps down by itself: direct, then transcode, then a safer transcode (H.264 + stereo AAC), then the next source.
Settings > Playback mode can force "always direct" or "always transcode". Unknown releases are tried directly first.

## Two builds from one source
`ui/` is written once. `node build.js` makes `dist/modern` (browsers) and `dist/compat` (Chromium 53 / LG webOS 4: converted syntax + core-js polyfills).
`server.js` picks one from the User-Agent (`Web0S`/`webOS`/old Chrome < 70 → compat; `?compat=1` / `?modern=1` override; `?tv=1` forces compat).
**The build fails** (so CI is red) if the old-TV copy would use something Chromium 53 cannot run: CSS grid, flex `gap`, `aspect-ratio`, `position: sticky`, `inset`, `:is()`, `min()/max()/clamp()`,
`backdrop-filter` outside `@supports`, ResizeObserver, WebAssembly, … or if the bundle is not valid ES2015. `node test-build.js` proves the guards catch bad code.
Blur-behind ("glass") is added only where `backdrop-filter` exists; the TV gets translucent panels.

## Run / test
```
npm install && npm test          # builds, then runs server tests (mock JoolzApp accounts + fake streaming server) and guard tests
```
Compose + manifest: `joolay-joolztv/`. Version in `umbrel-app.yml` must equal the `web` image tag.
