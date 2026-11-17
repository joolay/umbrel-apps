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
| Listify | #0A6C8F / #3FB0D6 | #4DB6DD / #7FD0EE |
| Diner Bell | #d9480f / #ff8a4c | #ff8a4c / #ffb27d |
| ShutterWorth | #145f4f / #2f8571 | #3FBF9F / #7FD6BD |
| JoolzTV (own TV glass styling in `src/joolztv/ui/css/app.css`; icon uses these) | #0a63c9 / #64d2ff | #0a84ff / #64d2ff |
| New apps | pick one accent, then an `--accent-2` 20-30° hue away | a lighter pair |

## Changing the template
Edit `templates/glass/glass.css`, bump the version in its header comment, then copy it into every app's `public/` and bump each app's version.

## Icons
Every icon people see is the same glass tile: brand gradient, soft highlight, frosted rounded panel, bold white glyph (gold only for the
JoolzApp bolt). That covers each app's own icon, JoolzApp Portal, Portal Admin, and the home screen's built-in tiles (Family, Settings, Admin).
`make-icons.py` builds them all from one template, so nothing is drawn by hand:

- **An app**: add its glyph and two brand colours to the `icons` table, then run `python3 templates/glass/make-icons.py <app>` from the repo root.
  It writes `icon.svg`, `icon-180.png`, `icon-512.png`, `icon-maskable-512.png` in `src/<app>/public/` and the store icon in `joolay-<app>/`.
- **Portal, Portal Admin and built-in tiles**: the `special` table (`portal`, `portal-admin`, `family`, `settings`). A new built-in home-screen
  tile gets an entry there (a 24x24 line glyph via `line24()`), a file in `src/portal-admin/public/icons/`, and `img: 'icons/<name>.svg'` on its item in `homeModel()`.
- Always name what to build. Run with no names and it only lists what it knows (it never rebuilds everything, so it can't overwrite an icon that was tuned later).
- Needs `rsvg-convert` and ImageMagick.

On the home screen, artwork is shown as it is (no gloss or glow added on top, see "Crisp glass icons" in `src/portal-admin/public/style.css`). An app with no
artwork gets a tinted glass tile with its first letter, so give every new app an icon from this script before it ships.
