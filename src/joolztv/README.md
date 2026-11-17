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

## Subtitles matched to the file (English only, best 10, auto-sync)
OpenSubtitles (built in) is asked for subtitles for the exact file: first by file name and size, then again with the file's own fingerprint (`/opensubHash`, read by the streaming server from the torrent, through the sign-in proxy).
`ui/js/subs.js` ranks the results: an exact fingerprint match first, then the same release (group, source such as BluRay/WEB-DL, resolution, codec, shared name words).
**Only the profile's chosen language is listed (English by default; Settings can add a second language), duplicates are merged and at most the best 10 are shown**, most likely match first ("Exact file" / "Best match").
Settings can turn on automatic selection of the best match (off by default, per profile).

**Auto-sync** (`subsync.js`, needs `ffmpeg`, installed in the image): the Subtitles menu's "Auto-sync" sends the subtitle and the torrent file id to `POST /api/subs/sync`. The server reads a few 3-minute audio windows from the streaming server,
marks where speech is (loudness against the window's own noise floor, speech band only) and finds the shift that lines the subtitle's speaking times up with it. It also tries the frame-rate ratios that cause drift (25 vs 23.976 fps etc.).
It returns `offsetMs` and `scale` (new time = old × scale + offset) and a confidence; unrelated or unclear subtitles are refused rather than guessed ("Use earlier/later by hand"). One sync per person at a time, two at once overall.
Settings can run it automatically when a subtitle is turned on. A fix is remembered per subtitle + file on the device. `test-subsync.js` proves it on synthetic audio (late, early, in sync, drift, unrelated). It is crude voice detection, not a trained model: real films with loud music can fool it.

## Direct play or transcoding, and what each device can decode
Decided per file before playback (`Api.assess`, checked by `test-subs.js`) from the release name and what this device is known to decode:
1. **First-run device check** (`ui/js/devtest.js`, screen shown once per device after the first sign-in, again from Settings): plays 12 tiny 2-second clips made at image build time by `make-clips.js` (H.264, HEVC, 10-bit HEVC, AV1, 10-bit H.264, XviD/AVI, MKV, TS, Dolby Digital, Dolby Digital Plus, DTS, TrueHD) muted and off-screen, and records which play (picture decoded; audio proven where the browser reports `webkitAudioDecodedByteCount`). Results go into the device memory. A test that needs H.264 is skipped if H.264 itself failed. If the server has no clips the check is skipped.
2. **Device memory** (`devcaps` in the device's storage, 180-day expiry): every real playback refines it. A direct play that shows a picture for a few seconds records the file's formats as OK; a decoder failure (error code 3, a source that is reachable but not supported, no picture, a stuck decoder with data buffered, or data arriving that never opens) records them as failed and falls back within seconds instead of waiting for the 45 s start timeout. Plain H.264/AAC/MP4 are never blamed on the device, and network errors are never learned.
3. **Capability report** (`canPlayType`) fills any gaps: AV1, 10-bit H.264, Dolby Vision, old AVI/XviD, and DTS/TrueHD (TV) are transcoded; HEVC / Dolby Digital (+) when the device lacks them.
The player shows "Direct play" or "Transcoding: reason". If a guess is wrong it steps down: direct, then transcode, then a safer transcode (H.264 + stereo AAC), then the next source. Settings: playback mode (automatic / always direct / always transcode), "Run the device check again" and "Forget what this device can play".

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
