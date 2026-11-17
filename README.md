# umbrel-apps (JoolzApp community store)

JoolzApp: Joolay's [Umbrel](https://umbrel.com) community app store, and the source for every app in it.

| App | Source | Store entry |
|---|---|---|
| **ShutterWorth**: photograph belongings, build an insurance inventory | `src/shutterworth/` | `joolay-shutterworth/` |
| **Portal Admin**: admin panel plus user settings for PocketBase-backed apps (global, per-app, per-user settings, per-app access approval, user preferences, audit log) | `src/portal-admin/` | `joolay-portal-admin/` |
| **Diner Bell**: read a menu, order from several restaurants, tip, split the bill, tap to call | `src/diner-bell/` | `joolay-diner-bell/` |
| **JoolzTV**: Apple TV style glass front end with its own Stremio streaming server (replaces the old Stremio app), Torrentio sources (top 3 by seeds per resolution), one JoolzApp account per profile (up to 12 per household); also the LG webOS TV launcher | `src/joolztv/` | `joolay-joolztv/` |

Each push builds every `src/<app>/Dockerfile` to `ghcr.io/joolay/<app>:<version>` (`.github/workflows/build-images.yml`). See `CLAUDE.md` for how to add or release an app.

## Add it to Umbrel

App Store → ⋯ menu → **Community App Stores** → add `https://github.com/joolay/umbrel-apps`.
