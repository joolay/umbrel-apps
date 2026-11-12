# umbrel-apps

A tiny [Umbrel](https://umbrel.com) community app store. It currently has two entries:

- **ShutterWorth**: a dashboard tile (icon and name) that opens a self-hosted ShutterWorth instance running on the same Umbrel, through Umbrel's own login.
- **Portal Admin** (source in [joolay/portal-admin](https://github.com/joolay/portal-admin)): a central admin panel for all custom apps that use PocketBase: global, per-app and per-user settings, app on/off and maintenance mode, user access, and an audit log. Sign in with a PocketBase superuser. Tile manifest in `joolay-portal-admin/`.

The ShutterWorth tile is only a shortcut. It contains no app code and no data.

## Add it to Umbrel

App Store → ⋯ menu → **Community App Stores** → add `https://github.com/joolay/umbrel-apps`.
