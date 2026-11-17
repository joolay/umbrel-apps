# JoolzTV

Apple TV style ("glass") front end for the Stremio streaming server, locked behind JoolzApp accounts. Also the interface of the LG webOS TV app
(a tiny launcher in [joolay/homebrew](https://github.com/joolay/homebrew) opens this site on the TV).

## How it fits together
```
browser / LG TV launcher ──>  web (server.js, port 3900; host 3901 = public Funnel address)  ──>  server (Stremio streaming server, never published)
                                │  JoolzApp (PocketBase) sign-in, household, per-profile data                      ▲
                                └──────────────  /s/<stream token>/…  (video, only for signed-in profiles)  ───────┘
```
- **One JoolzApp account per profile, up to 12 profiles per household.** First run (empty household): a wizard signs in with a JoolzApp account (becomes the owner), asks the preferred quality (4K / 1080p / 720p), then offers to add the other members (their email + password).
  Later: "Who's watching?" picker, then straight in.
- **Staying signed in is the server's decision, not a switch.** Sign-in gives a server-issued session token (`s.<user>.<issued>.<mac>`) that the device always keeps. It stays valid while the HOUSEHOLD was used in the last 90 days
  (`household.json` `lastActive`, moved forward by any signed-in request of any profile, at most every 10 minutes). One person using the app therefore keeps everybody signed in; after 90 days with no use by anyone, every profile asks for the password again,
  and signing in with a password restarts the 90 days. Each check re-reads the account from PocketBase, so a removed or disabled account stops working at once. Older PocketBase tokens are accepted once and swapped for a session token (`x-jtv-renew`).
- **Profile pictures**: the photo on the JoolzApp account (the users `avatar` file field, sent to the app as a small 160 px picture) or one of 24 built-in pictures drawn in the app (`ui/js/avatars.js`). Each new profile gets an unused built-in picture; the person can switch in Household > profile > Change picture.
- **Household settings** live on the server (`household.json` `prefs`, `GET /api/household`, `PUT /api/household/prefs`; view-only accounts are refused): the preferred quality and the source filters.
- **Sources** (the source's name is never shown): Settings > Sources and filters hides Dolby Vision / HDR / BluRay remux / 3D / unknown quality, limits file size, prefers an audio language, chooses which sites are searched, and has a test button and an advanced custom address. Camera recordings and screeners are always left out.
  `ui/js/sources.js` turns the choices into the address; the 3 files with the most seeds are offered in each resolution. Automatic playback takes the file with the most seeds in the preferred quality; if there is none, a notice appears and the alternatives are listed (nothing starts by itself). `test-sources.js` covers it.
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

## Smart buffering
Playback waits for a buffer sized to the torrent's current download speed (from Stremio `stats.json`, or the measured fill rate when stats are missing): fast downloads start almost at once (5 s), slow ones buffer up to 60 s, never more than 90 s. After a stall a larger buffer is rebuilt. Settings > Buffering: Quick start / Balanced / Safe. Logic and tests: `ui/js/buffer.js`, `test-buffer.js`.

## Faster playback with matching audio
Speeds 0.75x to 1.75x keep the voice pitch (`preservesPitch`). The player verifies the device really changed speed and, if not, reverts to 1x with a message.

## Skip intro and credit scenes
One small glass button at the bottom right (OK on the remote presses it; it fades after 10 s and returns with the controls): "Skip intro", "Skip to extra scene", or "Next episode" while a series' credits roll. Nothing is detected here; the points come, in this order, from:
1. **Community databases**, asked through the server (`community.js`, `POST /api/marks/lookup`; only the IMDb id, season and episode are sent, as the client name "JoolzTV", anonymous reads, answers cached 6 h):
   [IntroDB](https://introdb.app) (`api.introdb.app/segments`: intro, recap, outro, post-credit scene) and [TheIntroDB](https://theintrodb.org) (`api.theintrodb.org/v4/media`: intro, recap, credits, preview). The answers are merged and thrown out when they make no sense for the file's length.
   Credits that stop and start again leave a gap, and that gap is taken as a mid-credits scene. TheIntroDB's "preview" is not used (its own example puts it 28 minutes into a film).
2. **The file's own chapters** (ffprobe, `POST /api/marks/scan`): Intro / Opening / Credits / Post-credits scene.
Limit: the databases are community-filled, so coverage varies by title and some entries disagree. Test: `test-community.js` (stand-in services using real response shapes), `test-marks.js` (chapters).

## TMDB (artwork, ratings, cast, lists, Discover, age limits)
Optional. A JoolzApp admin pastes a TMDB key in Settings (stored in `<data>/tmdb.key`, mode 600, never sent back; or set `TMDB_KEY`, a v3 key or a v4 read token). Without a key nothing changes and Cinemeta carries on. The TV never talks to TMDB's API, only to its image CDN.
`tmdb.js` + `/api/tmdb/*` (any signed-in profile; answers cached 1-12 h):
- **Title page**: the title logo (in your language, else English), a wide backdrop, the age rating for your country (falls back to the UK, then US), runtime, tagline, "Directed by" / "Created by", summary in your language, a chip when the film has a mid- or after-credits scene (TMDB keyword), the next episode date or "Ended" for a series, tabs for Cast, More like this and the film's Collection, and a picture and summary for every episode where Cinemeta has none.
- **Rows**: trending, popular, top rated, now in cinemas / coming soon (for your country), on the air. **Discover** tab: films or TV by genre, year and sort, with More. **People**: cast cards open a person with their best-known titles; search also lists people.
- **Country and language** are household settings (Settings > Artwork, ratings and cast); by default they come from the device language, then the time zone.
- **Age limits**: the household owner can set up to 7 / 10 / 13 / 16 on a profile (Household > profile). The limit is also the account's own age when JoolzApp says it is under 18. A limited profile only gets TMDB's age-filtered rows (films whose rating name is allowed for that age in your country, e.g. UK age 7 = U, age 9 = PG; TV from the Kids genre) and `POST /api/play-check` stops anything rated above the limit, or with no rating, before it plays.
  Honest limits: the check is made by the app before starting a title, not by the streaming proxy, and TV rows cannot be filtered by rating (TMDB offers that for films only). Without a key age limits cannot be applied.
- Attribution ("This product uses the TMDB API but is not endorsed or certified by TMDB.") is in Settings.
- Tests: `test-tmdb.js` and the TMDB block of `test.js` run against `test/tmdb-stub.js`, a stand-in made from the documented response shapes. Checked once against the live API with a real key: details, logos, ratings, lists, discover, people, collections, seasons and both key types (v3 key and v4 token) work. Keyword ids: 179430 = aftercreditsstinger, 179431 = duringcreditsstinger.

## Skipping with the rewind / forward buttons and keys
One tap (or one press of OK on the button, an arrow on the progress bar, or the remote's rewind / fast-forward key) = one jump: 10 s for the buttons and arrows, 30 s for the remote's keys. Hold it and it jumps again every second.
Going forward, the repeated jumps stop at the end of what is already downloaded into the player (a short message says so); a single tap is never limited. Going back is never limited. Holding OK on any other control does not repeat it.

## Seek preview pictures
The player builds a picture every 10 seconds for the whole file (the skip increment), made on the server (`thumbs.js`, `GET /api/thumb`, ffmpeg), in this order:
1. **What is already loaded, nearest the playhead first** (the starting buffer; played parts and the part ahead). Ahead is favoured over behind. This never waits and never starts until the film is playing with at least 5 s buffered.
2. **The rest of the file is read ahead on the server first (see below) and waits until playback is well ahead of itself** (`ui/js/thumbplan.js`, `test-thumbplan.js`): the film has played for 45 s, the download is at least 3x faster than it plays, and the buffer is considerable: 60 s ahead, or as full as that player lets it get (30 s or more and no longer growing for 15 s). It stops for any rebuffering. On a slow source, or a player with a small buffer, the pictures stay inside the loaded part.
Two at a time per person (3 on the server, 2500 kept in memory), it pauses while buffering and stops for the session if the server has no ffmpeg. Every jump (tap, hold, arrow on the bar, remote key) shows a small glass card above the bar with the picture nearest to where you land and the time; hovering the bar with a mouse shows the same. Files shorter than a minute get none.
Honest limits: pictures for the part not yet downloaded make the streaming server fetch a little from there (ffmpeg reads about one keyframe interval plus the index per picture, roughly 1 to 3 MB each, so a two-hour film is on the order of 1 to 2 GB across all pictures), which is why that part waits for a fast download. Some files (MKV with the index at the end) make ffmpeg read the end of the file for the first picture.
Tested with a stand-in streaming server at 10x and 1.5x real time: fast = all pictures within 26 s, starting from the playhead; slow = only the loaded part. Not tested on a real torrent.

## Voice search
Search has a microphone ("Speak") button next to the box. webOS gives web apps no direct microphone access on most TVs (LG's own Voice Search is a system feature and is not handed to apps), so it works two ways:
1. If the browser has speech recognition (`SpeechRecognition` / `webkitSpeechRecognition`: desktop and phone browsers), Speak listens and searches what it hears.
2. Otherwise it opens the search box and the TV's own keyboard, whose microphone key (and the Magic Remote's) types what you say into the box. Anything that arrives without pressing Enter is searched on its own after 0.9 s.
LG's help says voice input is unavailable in password fields; the search box is a plain text field. Not tested on a real TV: whether your webOS 4 build offers the keyboard's microphone key, and whether it works over the home address (voice may need the TV to be online).

## What is downloaded, on the progress bar
The progress bar looks exactly as it always did (thin, light grey shading for what is downloaded, white for what is played); the shading is just drawn in as many stretches as are downloaded. It is filled only where the film is downloaded: the parts this player has loaded (buffered now, or earlier in this viewing) plus the parts the server has read ahead for the preview pictures. It is not one stretch from the start: first it fills from the beginning, and once the buffer is considerable and the download is fast, read-ahead windows appear further along (nearest the playhead first, ahead before behind) and the shading follows. No label, no extra colour.
Holding forward stops at the end of the downloaded stretch that holds the playhead, including read-ahead parts.
Read-ahead (`POST /api/prefetch`): for each 10 s window that is not downloaded, the server reads the matching byte range from the streaming server and throws it away, so the torrent downloads it on the Umbrel (nothing is sent to the TV), one window at a time per person (2 on the server, at most 80 MB each), and then the preview picture is made from it. Same gate as before (`thumbplan.js`): 45 s of playing, download 3x faster than the film, 60 s buffer (or the player's full buffer). 
Approximate: the window is found by proportion (time / duration x file size), so with variable bitrate the shaded stretch can be off by some seconds; the streaming server exposes no piece map to read the true ranges. Tested against a stand-in streaming server (`JTV_TEST_FAR` skips the speed gate for the test); not on a real torrent.

## Collections
A Collections tab (when TMDB is on; hidden for profiles with an age limit) lists about 40 well-known film franchises (`FRANCHISES` in `tmdb.js`, ids checked against the live API; any TMDB no longer has are skipped) with a search box for any other collection (`GET /api/tmdb/collections`, `?q=`). A card opens the collection's films, oldest first; the Movies page also starts with a Collections row, and a film's page links to its own collection. Tests: `test-tmdb.js`, `test.js`.

## Parental controls and the global adult block
- **Kids profile**: the account is under 18 according to JoolzApp, or a parent switched "Kids profile" on. **Parent accounts only** can change a kid's limits: an adult household member who is that kid's JoolzApp guardian, a JoolzApp admin, or the household owner when the kid has no guardian linked (`canManage` in `server.js`, checked on every change and every read of the list). The kid, other kids and other adults cannot.
- **What a parent sets** (Household > profile > Parental controls): age limit (7 / 10 / 13 / 16, needs TMDB), **title list mode** (`off`, `block` = the listed titles are refused, `allow` = only the listed titles are available) and **Manage the title list** (search a title to add, choose a listed title to remove). Every title page also has a **For kids** button (parents only) to add or remove it per kid.
- An **allow-list profile** sees only Home (its chosen titles), My List and Search (filtered to the chosen titles). A parent-allowed title skips only the age check.
- **Porn and erotica are blocked for everyone, always** (no setting, admins and owners included). One decision on the server (`POST /api/title-check`, also `/api/play-check`), asked before a title page opens and before it plays: TMDB `adult` flag; TMDB keywords erotic, erotica, softcore, pornography (and its variants), sexploitation, hentai, xxx; adult-only ratings (UK R18, ZA X18 / XX / XXX, AU X 18+, US X / XXX, ...). Without a TMDB key, Cinemeta's "Adult" genre. Also: adult results are dropped from TMDB lists, Discover, search, collections and people; Cinemeta results with the Adult genre or an obvious name are dropped; torrent results named xxx / porn / nsfw / hentai are never offered.
- Order of rules: adult block (everyone) > kid list (allow / block) > age limit. Tests: `test.js` (parent-only rules, lists, policy, adult block), `test-tmdb.js` (what counts as adult), `test-policy.js`.
- **Honest limits**: it is enforced by the app and the server before a title opens or plays; the stream proxy cannot tell which title a torrent belongs to, so someone technical with their own sign-in could still fetch a stream directly. TMDB keywords are community-made: some explicit titles may slip through, and a mainstream title tagged "erotic" will be blocked (plain "erotic thriller" is not). Not tested against the real TMDB for adult titles (the live key was used only for the earlier checks).

## Also on Netflix
When TMDB is on and a title streams on Netflix (subscription or the ad tier) in the person's country, its page shows a small glass pill, top right: "Also on Netflix" (TMDB's where-to-watch data, which comes from JustWatch; credited in Settings). Choosing it opens the TV's Netflix app through webOS's app launcher (`luna://com.webos.applicationManager/launch`, id `netflix`, through `PalmServiceBridge`); in a normal browser it opens Netflix's search page for the title. It never plays anything and no Netflix login is stored or mapped.
- Not shown on kids profiles (Netflix has its own profiles and none of JoolzTV's limits).
- It cannot jump to the title inside Netflix (no official way, and TMDB gives no Netflix title id); a message names the title to search for.
- Untested on a real LG: whether a page served from the Umbrel (not an installed app) is allowed to call the launcher. If it is not, the pill shows "Could not open Netflix from here. Open the Netflix app and search for ..." instead.

## Big-key on-screen keyboard (optional)
Settings > Typing > On-screen keyboard: "The TV's own keyboard" (default) or "Big keys". With Big keys on, choosing any text box (OK on the remote, or a click) opens `ui/js/kbd.js` instead of the TV's keyboard: a glass panel with large keys (118 x 92 px) that you move over with the arrow keys and press with OK. It has shift (one capital, then back), a 123 layer (symbols), space, backspace, Clear, a .com key for email addresses, and a tick (Done) that submits the box (search runs; Done on the email box goes on to the password; Done on the password signs in). Passwords show as dots; choose the text line to show them. A real keyboard also works while it is open (letters, Backspace, Escape). Back closes it.
It has no microphone: voice entry needs the TV's own keyboard. Untested on a real TV: the keys' size at TV distance and the remote's key codes.

## Collections in My List
A collection's page has a "+ My List" button; My List then shows the collection as a card (opens the collection again) among the films and shows. It is saved and synced with the account like the rest of My List (`col:<id>` entries).

## 50 GB cache and download ahead
- **Cache**: the stremio-docker image documents no cache setting, so on start the web app asks the streaming server's own settings API (`GET` / `POST /settings`, field `cacheSize`, `streamcfg.js`) for 50 GiB and reads it back; what the server answered is kept in `/data/stream-settings.json` and shown in Settings > Downloads and cache (with the free disk). It tries once (retrying until the server is up), so a size an admin picks later is not overwritten. An admin can choose 2 / 5 / 10 / 25 / 50 / 100 / 200 GB there; if the streaming server does not take a size the message says so.
  Unverified: that the real streaming server accepts 50 GB through that API (its presets may be smaller). If it does not, Settings shows what it reports instead. The cache is a ceiling, not reserved space: the oldest data is dropped first, and downloads and preview read-ahead share it.
- **Download ahead** (`POST /api/downloads` and friends, in `server.js`): on a title page the button picks the best source for your preferred quality (most seeds) for the Play target (the next episode for a series) and the server reads the whole file from the streaming server and throws it away, so it is downloaded into the cache on the Umbrel (nothing goes to the TV). 2 at a time on the server, 3 per person; progress from bytes read; survives restarts (re-queued); no data for 3 minutes = failed. The same adult / kid / age rules apply before a job is accepted. The button shows Downloading N% / Downloaded; choose it again to cancel or remove.
- **Told when it is done**: while the app is open it checks every 20 s and shows "Ready to watch: <title>" (or the failure), and the home screen gets a Ready to watch row; downloads that finished while the app was closed are announced at the next start. Settings lists them with progress. No dashboard notice: the existing app notice goes to everyone and would show what a person downloaded.
- Tests: the cache and downloads blocks of `test.js` (stub streaming server with `/settings`, a failing file and a slow file).
