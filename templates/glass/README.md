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
| Jolly Grocer | #1E7A4C / #4FC083 | #4FC083 / #7FD6A6 |
| Listify | #0A6C8F / #3FB0D6 | #4DB6DD / #7FD0EE |
| Diner Bell | #d9480f / #ff8a4c | #ff8a4c / #ffb27d |
| ShutterWorth | #145f4f / #2f8571 | #3FBF9F / #7FD6BD |
| New apps | pick one accent, then an `--accent-2` 20-30° hue away | a lighter pair |

## Changing the template
Edit `templates/glass/glass.css`, bump the version in its header comment, then copy it into every app's `public/` and bump each app's version.

## Icons
Every app icon is a glass tile: brand gradient, soft highlight, frosted rounded panel, white glyph. `make-icons.py` builds them
(`icon.svg`, `icon-180.png`, `icon-512.png`, `icon-maskable-512.png`, and the store icon in `joolay-<app>/`). Add a new app's glyph and
two brand colours to the `icons` table in that script and run it from the repo root (needs `rsvg-convert` and ImageMagick).
