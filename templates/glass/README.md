# JoolzApp Glass theme

One look for every JoolzApp: soft gradient backdrop, frosted panels, rounded corners, pill buttons, safe on iPhone.
`glass.css` is the single source of truth. Apps copy it; they do not fork it.

## Add it to an app
1. Copy `templates/glass/glass.css` to `src/<app>/public/glass.css`.
2. In `index.html` and `gate.html`, add `<link rel="stylesheet" href="glass.css">` before the app's own CSS.
3. In the app's own CSS set only the brand tokens, then add app-specific layout with your own class names.

```css
:root{--accent:#1E7A4C;--accent-2:#4FC083;--accent-t:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--accent:#4FC083;--accent-2:#7FD6A6;--accent-t:#06210F}}
:root[data-theme="dark"]{--accent:#4FC083;--accent-2:#7FD6A6;--accent-t:#06210F}
```
`--accent-t` is the text colour on top of the accent. Give each app a lighter accent for dark mode as above.

## Rules
- Use the shared classes: `.card .stat .tile .tile-ic .btn(.primary/.danger/.small/.pill) .chip(.ok/.bad/.warn) .tabs .toast .login-card .shell .side .topbar .row .grid .tiles`.
- Never hard-code colours (`--solid` is an opaque panel for rows that slide over something). Use `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--danger)`, `var(--ok)`, `var(--warn)`, `var(--glass)`.
- Semantic colours (ok / warn / danger) are separate from the accent.
- Pick a layout: `.shell` with `.side` for admin-style apps, `.topbar` plus a centred column for single-purpose apps.
- Fields stay at 16px on touch screens (already in the template) so iOS never zooms.
- Pad for the notch with `var(--safe-t|r|b|l)`; the template pads `body` already.
- Light and dark both come from `prefers-color-scheme`. Test both.
- Keep all `index.html` head tags from `CLAUDE.md` (viewport-fit=cover, manifest, theme-color, Apple icon, status bar).

## Brand tokens per app
| App | light --accent / --accent-2 | dark --accent / --accent-2 |
|---|---|---|
| Portal Admin | #3b6df0 / #8f6bff | #6c92ff / #a98fff |
| Services Manager | #5b7cf5 / #8f6bff | #6c8cff / #a98fff |
| App Updater | #c2347a / #ff6fae | #ff6fae / #ffa0cb |
| Jolly Grocer | #1E7A4C / #4FC083 | #4FC083 / #7FD6A6 |
| Project Pilot | #b45309 / #f59e0b | #f59e0b / #fbbf24 |
| Listify | #0A6C8F / #3FB0D6 | #4DB6DD / #7FD0EE |
| Diner Bell | #d9480f / #ff8a4c | #ff8a4c / #ffb27d |
| ShutterWorth | #145f4f / #2f8571 | #3FBF9F / #7FD6BD |
| JoolzCCTV | #3d2fb8 / #8b7dff | #8b7dff / #c0a6ff |
| JoolzTV (own TV glass styling in `src/joolztv/ui/css/app.css`; icon uses these) | #0a63c9 / #64d2ff | #0a84ff / #64d2ff |
| New apps | pick one accent, then an `--accent-2` 20-30° hue away | a lighter pair |

## Global theme (Theme Editor)
Add `theme-global.js` (copy from this folder) as the last tag in `<head>`: it loads the admin's global theme (`/theme.css`, edited in the Theme Editor app) after glass.css and the app's CSS. Use `data-portal="."` in the Store/Portal Admin. Apps keep their brand `--accent` unless the admin turns on a single global accent. The admin can also give mobile, tablet, desktop and TV their own settings (TV browsers are marked `<html data-view="tv">` by this script).

## Changing the template
Edit `templates/glass/glass.css`, bump the version in its header comment, then copy it into every app's `public/` and bump each app's version.

## Icons
Every icon people see is the same clean tile: the brand gradient edge to edge, nothing else behind the glyph (no border or frame, no frosted square, no sheen or haze), and a bold white glyph (gold only for the
JoolzApp bolt) with one tight shadow so it stays sharp at any size. That covers each app's own icon, JoolzApp Store, Portal Admin, and the home screen's built-in tiles (Family, Settings, Admin).
`make-icons.py` builds them all from one template, so nothing is drawn by hand:

- **An app**: add its glyph and two brand colours to the `icons` table, then run `python3 templates/glass/make-icons.py <app>` from the repo root.
  It writes `icon.svg`, `icon-180.png`, `icon-512.png`, `icon-maskable-512.png` in `src/<app>/public/` and the store icon in `joolay-<app>/`.
- **Portal, Portal Admin and built-in tiles**: the `special` table (`portal`, `portal-admin`, `family`, `settings`). A new built-in home-screen
  tile gets an entry there (a 24x24 line glyph via `line24()`), a file in `src/portal-admin/public/icons/`, and `img: 'icons/<name>.svg'` on its item in `homeModel()`.
- Always name what to build. Run with no names and it only lists what it knows (it never rebuilds everything, so it can't overwrite an icon that was tuned later).
- Needs `rsvg-convert` and ImageMagick.

On the home screen, artwork is shown as it is (no gloss or glow added on top, see "Crisp glass icons" in `src/portal-admin/public/style.css`). An app with no
artwork gets a tinted glass tile with its first letter, so give every new app an icon from this script before it ships.

## Floating top bar

The bar is `position:fixed` (a sticky bar quietly stops working inside any overflow container) and `floatbar.js` adds a `.topbar-spacer` below it so the page is not covered. Always copy both files; never restyle the bar back to sticky. (the standard for every JoolzApp)
Every app uses the same floating, frosted bar: the app's title on the left, the light/dark theme icon on the right (app buttons, if any, sit between).
- Copy `floatbar.css` and `floatbar.js` into `src/<app>/public/`. Load `floatbar.js` in `<head>` (no flash) and `floatbar.css` after `glass.css` and the app's own CSS.
- Markup: `<header class="topbar">` + the Home button (below) + `<div class="brand"><img src="icon.svg" alt="" width="28" height="28"><span>App name</span></div><span class="tb-gap"></span>` + the theme button + `</header>`.
- Home button (first in the bar, on every app): `<button class="tb-btn" data-home hidden aria-label="Home" title="Home"><svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M10 20v-5.5h4V20"/></svg></button>`. It stays hidden until the JoolzApp Store's address is known and then opens it; `floatbar.js` reads it from the app's `GET api/app-config` (`{ portalUrl }`) by itself, or call `JZBar.setHome(url)`. Do not write your own click or show/hide code for it.
- Theme button: `<button class="tb-btn" data-theme-toggle><svg class="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg><svg class="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg></button>`
- The choice is kept on the device. Apps that keep preferences on the person's JoolzApp account listen for the `jz-theme` event and save it as `pref.theme`, and call `JZTheme.set(value, true)` on load with the saved value.
- Adopted so far: the JoolzApp Store and Project Pilot. Other apps move over one at a time, like the Glass theme itself.

## Sticky bars under the top bar
`position:sticky` needs `html` and `body` to use `overflow-x:clip` (as `glass.css` does), because `overflow-x:hidden` turns `body` into a scroll container and the bar silently scrolls away. Pin a bar below the top bar with `top:calc(var(--safe-t,0px) + 56px)` and a solid-ish background (Project Pilot's list picker and tabs do this).

## Install icon (top bar)
Copy `install-help.js` (from `src/portal-admin/public/`) and `installbtn.js` next to the app's `index.html`, add `<button class="ic" data-pwa-install hidden aria-label="Install app">` to the bar
and load both scripts at the end of `<body>` (`install-help.js` first). The icon shows in any normal browser tab, never inside the installed app. On an http address (home network, Tailscale IP) it opens a note saying installing needs the https address. Chromium browsers install in one tap;
iPhone, iPad, Safari and Firefox get a sheet with the steps for that device. Project Pilot is the first app to use it.

## Connected and handshake icons (top bar)
Copy `linkstatus.js` next to `index.html` and load it last in `<body>`: `<script src="linkstatus.js"></script>` (connected icon only) or `<script src="linkstatus.js" data-claude></script>` (adds the Claude handshake; the app must serve `GET /api/link`, see `src/app-updater/status-feed.js`). Rules and protocol: CLAUDE.md, "Connected icon and Claude handshake".

## Drag handle (reordering tiles and rows)
Reordering uses a grip, never ▲▼ buttons on tiles. Copy `draghandle.js` next to `index.html` (the handle's look, `.jz-handle` and `.jz-dragging`, is already in `glass.css`), load it before the app's script, and put
`<span class="jz-handle" data-drag role="button" aria-label="Drag to reorder" title="Drag to reorder">⋮⋮</span>` as the first thing in each tile or row. Then call `JZDrag.init(root, { item, box, enabled, onStart, onDrop })` once (the options are listed at the top of `draghandle.js`).
- Works in lists (vertical) and grids (any direction); the tile follows the finger, the others make room, and the page scrolls near the top and bottom edges. Tiles never leave their `box`.
- `onDrop(ids, box)` gets every item's `data-id` in the new order and is only called when the order changed. Save it the way the app already saves order.
- The grip is the only drag target, so tapping a tile (open, notes) and press-and-hold (edit) keep working. Call your hold-timer's cancel from `onStart`.
- Keep ▲▼ only on a compact one-line row where a grip would be the only control and a precise one-step move is useful (Project Pilot's Priority tab).
- Project Pilot is the first app to use it.

## Quick Access in an app (PIN or pattern)
One shared piece, copied into every app that signs people in: `quick-server.js` (next to `pocketbase.js`, add it to the Dockerfile COPY line) and `quick-ui.js` (in `public/`, loaded by the sign-in page and the main page).
Server: `require("./quick-server")({ pb, dataDir })`; a `quick` body on the login route signs in with `quick.login()` and `quick.mint()`; the session check accepts `quick.parse()` tokens (and refuses them
when `quick.stale()`); `quick.handle()` serves `/api/account/quick*`. Pages: `JZQuick({ app, name, request })` gives `has()`, `signIn()`, `offer()` (once per device, after a password sign-in) and
`manage()` (put a "Quick Access (PIN or pattern)" button in the app's Settings). The code is the person's ONE code for every JoolzApp (checked by Portal Admin); Quick Access never replaces the password.
Project Pilot is the first app to use it (1.4.0); see its `test-server.js`.
