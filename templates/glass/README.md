# JoolzApp template: ONE file (`jz.js`)

Every app loads the whole template from a single generated file, `jz.js`: Glass theme, floating top bar, menu bar and toolbar, Home/Settings/Install/theme buttons,
sync and Claude-link icons, global theme loader, drag handle and Quick Access UI. No more copying eight files and forgetting one.
- In `index.html`, FIRST in `<head>` (before the app's own CSS): `<script src="jz.js"></script>`. Options on that tag: `data-claude` (Claude handshake icon), `data-portal="."` or `data-portal="https://..."` (global theme address; default same host, port 3886).
  Do not add `glass.css`, `floatbar.css`, `floatbar.js`, `linkstatus.js`, `theme-global.js`, `installbtn.js`, `install-help.js`, `draghandle.js` or `quick-ui.js` tags any more.
- Edit the SOURCE files in `templates/glass/` (and `src/portal-admin/public/install-help.js`), then run `python3 templates/glass/build.py`. It rebuilds `templates/glass/jz.js` and copies it into every `src/*/public/` that already has a `jz.js`.
  `python3 templates/glass/build.py --check` fails when any copy is stale. Never edit a `jz.js` by hand.
- A new app: copy `templates/glass/jz.js` into `src/<app>/public/`. An existing app moves over when it is next edited: swap its template tags for the one tag and delete its old template copies (Port Master is the first).
- Not in the bundle (kept separate on purpose): the sign-in screens (`gate/`), `quick-server.js` (server side) and each app's own CSS/JS.

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
| JoolzApp Biz (JAB) | #7e22ce / #e879f9 | #c084fc / #e9d5ff |
| JoolzCCTV | #3d2fb8 / #8b7dff | #8b7dff / #c0a6ff |
| JoolzTV (own TV glass styling in `src/joolztv/ui/css/app.css`; icon uses these) | #0a63c9 / #64d2ff | #0a84ff / #64d2ff |
| New apps | pick one accent, then an `--accent-2` 20-30° hue away | a lighter pair |

## Global theme (Theme Editor)
Add `theme-global.js` (copy from this folder) as the last tag in `<head>`: it loads the admin's global theme (`/theme.css`, edited in the Theme Editor app) after glass.css and the app's CSS. Use `data-portal="."` in the Store/Portal Admin. Apps keep their brand `--accent` unless the admin turns on a single global accent. The admin can also give mobile, tablet, desktop and TV their own settings (TV browsers are marked `<html data-view="tv">` by this script).

## Login and welcome screens (gate)
One login page and one welcome flow for every JoolzApp app, in `templates/glass/gate/`. An app's `gate.html` is about 25 lines and holds only its name, slug, brand tokens and token key; everything else lives in `gate.js`, so a fix or a new feature reaches every app by copying one file.
1. Copy `gate.css`, `gate.js`, `pwtoggle.js` and `sso.html` from `templates/glass/gate/` plus `quick-ui.js` (from `templates/glass/`) into `src/<app>/public/`, then start `gate.html` from `templates/glass/gate/gate.html`: replace `APP NAME`, `APP-SLUG` and the `#BRAND`, `#BRAND2`, `#DARK`, `#DARK2` tokens (the table above) and the `JZGate({...})` options.
2. `JZGate` options: `app` (slug), `name`, `tokenKey` / `tokenHeader` (default `gd.token` / `x-gd-token`; ShutterWorth `sw.token` / `x-sw-token`), `clear` (local keys removed on sign out), `tagline`, `welcome` (array of `{icon, title, text}` or `false`). Icons: `account`, `apps`, `lock`, `install`, `spark`. Set the same `TOKEN_KEY` / `TOKEN_HEADER` at the top of `sso.html`.
3. What it does, the same everywhere: first-run **welcome slides** (swipe or Next, Skip, once per device, remembered in `jz.welcome.<app>`; the default three slides name the app, explain the one JoolzApp account and mention PIN / pattern); then **Sign in** (email, password with Show/Hide, Remember me, Forgot password, Create a JoolzApp account which goes to the Portal sign-up and back); **PIN or pattern** first on a device that has Quick Access set up (needs `quick-ui.js`, the password stays the fallback); the **Almost there** screen when the admin has not opened the app to that person yet (also the guardian-pending link to the dashboard); and the **Can't reach the account server** screen with Try again.
4. After sign-in the page reloads into the app. The app offers Quick Access once with `QA.offer()` and manages it in its Settings, as before.
5. Classes are `jz-*` (`.jz-card`, `.jz-go`, `.jz-note`...), so they never clash with an app's own CSS; brand comes only from `--accent`, `--accent-2`, `--accent-t`. The old per-app `gate.html` copies move onto this one app at a time, like the Glass theme; when an app has its own extra steps (a custom sign-up field), add it to `gate.js` as an option instead of forking the page.

## Changing the template
Edit `templates/glass/glass.css`, bump the version in its header comment, then copy it into every app's `public/` and bump each app's version.

## Icons
Every icon people see is the same clean tile: the brand gradient edge to edge, nothing else behind the glyph (no border or frame, no frosted square, no sheen or haze), and a bold white glyph (gold only for the
JoolzApp bolt) with one tight shadow so it stays sharp at any size. That covers each app's own icon, JoolzApp Dashboard, Portal Admin, and the home screen's built-in tiles (Family, Settings, Admin).
`make-icons.py` builds them all from one template, so nothing is drawn by hand:

- **An app**: add its glyph and two brand colours to the `icons` table, then run `python3 templates/glass/make-icons.py <app>` from the repo root.
  It writes `icon.svg`, `icon-180.png`, `icon-512.png`, `icon-maskable-512.png` in `src/<app>/public/` and the store icon in `joolay-<app>/`.
- **Portal, Portal Admin and built-in tiles**: the `special` table (`portal`, `portal-admin`, `family`, `settings`). A new built-in home-screen
  tile gets an entry there (a 24x24 line glyph via `line24()`), a file in `src/portal-admin/public/icons/`, and `img: 'icons/<name>.svg'` on its item in `homeModel()`.
- **Portal Admin's admin tools and its shortcut tiles** (`tool-<name>`, `shortcut-<app>`, `gatekeeper` in the `special` table) write `src/portal-admin/public/icons/<name>.svg`; the tile items in `homeModel()` carry `img: 'icons/<name>.svg'`. A new admin tool or shortcut gets an entry there, never a hand-drawn tile.
- Always name what to build. Run with no names and it only lists what it knows (it never rebuilds everything, so it can't overwrite an icon that was tuned later).
- Needs `rsvg-convert` and ImageMagick.

On the home screen, artwork is shown as it is (no gloss or glow added on top, see "Crisp glass icons" in `src/portal-admin/public/style.css`). An app with no
artwork gets a tinted glass tile with its first letter, so give every new app an icon from this script before it ships.

## Floating top bar

The app's icon sits before its title in the top bar (28px, rounded). `floatbar.js` adds it by itself from the page's `apple-touch-icon` when `.brand` has no `<img>`; an app that already has an `<img>` there keeps it. If the file fails to load the icon simply disappears.

The bar is `position:fixed` (a sticky bar quietly stops working inside any overflow container) and `floatbar.js` adds a `.topbar-spacer` below it so the page is not covered. Always copy both files; never restyle the bar back to sticky. (the standard for every JoolzApp)
Every app uses the same floating, frosted bar: the app's title on the left, the light/dark theme icon on the right (app buttons, if any, sit between).
- Copy `floatbar.css` and `floatbar.js` into `src/<app>/public/`. Load `floatbar.js` in `<head>` (no flash) and `floatbar.css` after `glass.css` and the app's own CSS.
- Markup: `<header class="topbar">` + the Home button (below) + `<div class="brand"><span>App name</span></div><span class="tb-gap"></span>` + the theme button + `</header>`.
- Home button (first in the bar, on every app): `<button class="tb-btn" data-home hidden aria-label="Home" title="Home"><svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M10 20v-5.5h4V20"/></svg></button>`. It stays hidden until the JoolzApp Dashboard's address is known and then opens it; `floatbar.js` reads it from the app's `GET api/app-config` (`{ portalUrl }`) by itself, or call `JZBar.setHome(url)`. Do not write your own click or show/hide code for it.
- Theme button: `<button class="tb-btn" data-theme-toggle><svg class="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg><svg class="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg></button>`
- The choice is kept on the device. Apps that keep preferences on the person's JoolzApp account listen for the `jz-theme` event and save it as `pref.theme`, and call `JZTheme.set(value, true)` on load with the saved value.
- Settings gear (every app; it lives in the account menu, see "Account menu" below, and the loose button stays in the bar hidden): `<button class="tb-btn" data-settings aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>`. It opens the app's own Settings screen (that app's preferences, shops/lists/categories it manages, data export, and account actions such as Sign out), never a separate page of the JoolzApp Dashboard. Tapping it again returns to the app's main view, and the app sets `aria-pressed="true"` on it while Settings is open (`floatbar.css` lights it). Put account actions (Sign out, the JoolzApp dashboard link) in Settings, not as a loose row under the bar. Order in the bar: Home, title, gap, sync ticks, profile icon (account menu). Jolly Grocer is the first app to use it.
- Adopted so far: the JoolzApp Dashboard and Project Pilot. Other apps move over one at a time, like the Glass theme itself.

## Account menu (profile icon, top right)
`floatbar.js` builds a **profile icon** as the last thing in every top bar (initial of the person's name in the accent colour, a plain person icon until the app names them). Tapping it drops down a menu of **large icons**, always in this order:
**Settings (gear), Day/Night mode, Install, and Log out at the bottom**. The old loose Settings, theme and Install buttons are no longer shown in the bar (`floatbar.css` hides them) but stay in the markup, because the menu uses them: nothing to change in an app's existing handlers.
- **Log out** clicks the app's `[data-logout]` element (an ordinary button, may be `hidden`), or call `JZBar.onLogout(fn)`. With neither, the tile is hidden.
- **Settings** clicks the app's `[data-settings]` button in the bar and hides when that button is `hidden`; it lights up while the button has `aria-pressed="true"`.
- **Day/Night mode** is its own `data-theme-toggle` tile (named for what it switches to) and keeps the menu open so the change is seen.
- **Install** is its own `data-pwa-install` tile and shows only in a **phone or tablet browser tab** (iPhone, iPad including iPadOS posing as a Mac, Android), never on a computer and never once the app is open as an installed app (PWA). `installbtn.js` decides; the loose Install button follows the same rule.
- The app names the person with `JZBar.setUser({ name, initial })` (name shows at the top of the menu; `initial` defaults to the first letter). Call it after sign-in and again when the name changes.
- **Hover hints (computer only):** pausing the mouse on any icon-only button in the bars, on the profile icon or on a menu tile shows a small styled hint after a moment (menu tiles: to the left of the menu, with a longer explanation from `data-hint`). Phones and tablets (no hover) never show them. Give an icon button a `data-hint` (or just an `aria-label`) and it gets one; the native browser hint is suppressed so there is never a double.
- The menu closes on choosing Log out / Settings / Install, tapping outside, Esc, scrolling or turning the screen; arrow keys move between tiles.

## Menu bar and toolbar (docked under the top bar, opt-in per app)
Under the top bar an app can dock two more bars, fixed with it as one block (`.jz-dock`) so they never separate: not in a PWA, not under the notch, not while the browser chrome moves. Order, top to bottom: top bar, **menu bar**, **toolbar**. An app with neither keeps the plain top bar, so only apps that need them show them.
- **Names:** the menu bar is also called the **tab bar** and the toolbar the **selector bar**. Same bars, same markup (`.menubar`, `.toolbar`); use whichever name the owner uses.
- **Menu bar = tabs.** It holds the app's sections (e.g. Lists | Spend), the main navigation. **Toolbar = drop-down selectors and quick actions.** It holds the dropdown(s) that choose *what you are looking at* (which list, project, shop, period...) and optional action buttons. (Not Windows-style File/Edit menus.)
- Same files as the top bar (`floatbar.css` + `floatbar.js`). Add the bars right after the `<header class="topbar">`; `floatbar.js` wraps all three in `.jz-dock` and keeps the page below the whole dock (to avoid a flash on first paint you may wrap them in `<div class="jz-dock">` yourself). Use `hidden` to switch either bar off where it does not apply (the app decides per screen).
- Menu bar markup: `<nav class="menubar" role="tablist" aria-label="Sections"><button type="button" class="mb-btn" role="tab" aria-selected="true">Lists</button><button type="button" class="mb-btn" role="tab" aria-selected="false">Spend</button></nav>`. The selected tab gets an accent underline. **Menu bar options always spread equally over the whole bar** (global default, in `floatbar.css`: each direct `.mb-btn` takes an equal share of the width; the bar scrolls sideways only if they cannot fit), so never size or space them by hand.
- Toolbar markup: `<div class="toolbar" role="toolbar" aria-label="Tools"><button type="button" class="mb-btn mb-select" data-menu="list" aria-haspopup="listbox" aria-expanded="false"><span class="mb-label">Weekly shop</span></button><span class="tool-gap"></span><button type="button" class="tool" aria-label="Add"><svg .../></button><div class="mb-menu" data-menu-for="list" role="listbox" hidden><button type="button" class="mb-item" role="option" aria-selected="true">Weekly shop</button><div class="mb-sep"></div><button type="button" class="mb-item" role="menuitem">+ New list</button></div></div>`. The chevron is drawn by the CSS; keep the current choice's label in `.mb-label` and mark the chosen option `aria-selected="true"` (bold label and a tick). `floatbar.js` moves every `.mb-menu` to `<body>`, opens it under its button, and closes it on choosing an item, tapping outside, Esc or scrolling; items are ordinary buttons the app listens to. Choice options that belong together (Weekly | Monthly | Annually, a view switch) go in `<div class="tool-group">...</div>` with `aria-pressed` on the chosen one: **toolbar options always spread equally over the toolbar's free width** (global default, like the menu bar), so never size them by hand. Quick actions are `.tool` buttons (icon or icon + short text, `aria-pressed="true"` lights a toggle; earlier/later arrows go here too); `.tool-sep` separates groups, `.tool-gap` pushes the rest to the right. Both bars scroll sideways on a narrow screen instead of wrapping.
- The dock's height is published as `--dock-h` on `<html>`: pin sticky bars under it with `top:var(--dock-h)`.
- Safe areas (notch, rounded corners, home bar) are handled by the bars themselves. Colours, blur and radius come from the Glass variables, so the Theme Editor's colours apply; its bar blur/border/shadow settings still style the top bar only.
- Jolly Grocer is the first app to use it (Lists | Spend tabs in the menu bar, list dropdown in the toolbar). Old apps are moved over by hand: their tabs and selectors go into these bars when the app is next edited. Listify, ShutterWorth and Services Manager already have their own `.toolbar` CSS, so rename theirs when they adopt floatbar.css.

## Sticky bars under the top bar
`position:sticky` needs `html` and `body` to use `overflow-x:clip` (as `glass.css` does), because `overflow-x:hidden` turns `body` into a scroll container and the bar silently scrolls away. Pin a bar below the top bar with `top:calc(var(--safe-t,0px) + 56px)` and a solid-ish background (Project Pilot's list picker and tabs do this).

## Install icon (top bar)
Copy `install-help.js` (from `src/portal-admin/public/`) and `installbtn.js` next to the app's `index.html`, add `<button class="ic" data-pwa-install hidden aria-label="Install app">` to the bar
and load both scripts at the end of `<body>` (`install-help.js` first). The icon shows in any normal browser tab, never inside the installed app. On an http address (home network, Tailscale IP) it opens a note saying installing needs the https address. Chromium browsers install in one tap;
iPhone, iPad, Safari and Firefox get a sheet with the steps for that device. Project Pilot is the first app to use it.

## Sync ticks and the Claude link (removed from the template 26/11/2026)
The WhatsApp-style **sync ticks** (one green tick = recorded to PocketBase, two green = read by all shared parties, amber second tick = only some have read it, red cross = not connected, grey pulsing = saving) and the **Claude link ticks** (`data-claude`, reading `GET api/link`) are no longer in `jz.js`: no app shows them by default.
`jz.js` still checks that the server answers (it colours the dot on the profile icon) and `JZLink.sync()` / `JZLink.link()` still exist and do nothing, so apps that call them keep working.
To bring the ticks back in one app: copy `templates/glass/optional/synctick.js` next to its `index.html` and load it last in `<body>` (`<script src="synctick.js"></script>`, or with `data-claude` to add the Claude link). It is the complete old script, including the AI sparkle, so do not load it in an app that also loads the new `jz.js` sparkle without removing one of them.

## AI sparkle (top bar, apps with AI features)
A sparkle that breathes and tilts, shown in the top bar only while the AI is working. It is in `jz.js` already; an app with AI features just calls `JZLink.aiWhile(promise)` around the AI request
(several at once are counted) or `JZLink.ai(true)` / `JZLink.ai(false)`. Nothing to add to the markup. It follows "reduce motion" (then it glows without moving).

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
