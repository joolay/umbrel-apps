# ShutterWorth

> This app now lives in the `umbrel-apps` monorepo (`src/shutterworth`). On Umbrel it installs from the Joolay community store and updates automatically. The standalone instructions below (`docker compose`, `auto-update.sh`) are for running it outside Umbrel: clone `https://github.com/joolay/umbrel-apps` and work from `src/shutterworth`.

Photograph your belongings and ShutterWorth builds an insurance inventory: it identifies each item, estimates its replacement cost in rand, and works out a depreciated value. Self-hosted, so your data and photos stay on your own server.

Features: multiple lists (Lounge, Garage, Office…), AI photo identification, per-category depreciation rates, age estimates, recycle bin, daily backups, and Excel / CSV / PDF export. Changes sync live between every open phone or computer.

## Install on Umbrel (or any Docker host)

```sh
ssh umbrel@umbrel.local
git clone https://github.com/joolay/ShutterWorth.git ~/shutterworth
cd ~/shutterworth
sudo docker compose up -d --build
```

The repo is private, so `git clone` asks for your GitHub username and a personal access token (github.com → Settings → Developer settings → Personal access tokens) as the password.

Open **http://umbrel.local:3880**. On a phone, use Share → *Add to Home Screen* for an app icon.

Everything lives in `~/shutterworth/data`. Start with an empty inventory, or restore a backup in Settings.

## Turn on photo identification

Settings (gear icon) → **AI photo identification** → choose a service, paste a key, **Save**, then **Test connection**.

| Service | Key from | Notes |
|---|---|---|
| Anthropic (Claude) | console.anthropic.com | Billed separately from a Claude subscription |
| Google Gemini | aistudio.google.com | Uses Gemini's OpenAI-compatible endpoint |
| OpenAI-compatible | your provider | OpenAI, OpenRouter, Groq, Mistral, or a local Ollama server (`http://umbrel.local:11434/v1`, no key) running a vision model |

Model names change over time; if a test fails with "model not found", enter a current vision model name from your provider.

The key is stored in `data/ai-config.json` on the server and is never sent back to the browser.

## Ads (test mode)

A dummy banner with a **Remove ads** button shows at the bottom of the app. Removing ads is a simulated purchase (no money is charged) and is remembered per device.

Admin controls: open Settings and tap the **Settings** title 7 times. You can then turn ads off for everyone on this server, switch test/live ads, or undo this device's purchase.

Everything lives in `public/monetization.js`. When the app is wrapped as an Android app with Capacitor, it switches automatically to real AdMob banners and a Google Play "remove_ads" purchase (plugins needed: `@capacitor-community/admob`, `cordova-plugin-purchase`).

## Google Drive storage

Each device can keep its inventory in the user's own Google Drive instead of on this server: Settings → **Storage** → **Use my Google Drive**. Data goes into a private app folder (the `drive.appdata` permission), so ShutterWorth can't see anything else in their Drive. When switching, you can copy this server's lists, items and photos across. Photo identification still runs through this server's AI settings.

One-time setup (admin):

1. At console.cloud.google.com create a project, enable the **Google Drive API**, and set up the **OAuth consent screen** (External; while it's in Testing, add your testers' Gmail addresses as test users).
2. Create an **OAuth client ID** of type *Web application*. Under *Authorized JavaScript origins* add the https address you open ShutterWorth from.
3. Put the client ID in `GOOGLE_CLIENT_ID` in `docker-compose.yml`, then `sudo docker compose up -d`.

Google only allows sign-in from **https** addresses on a real domain, so it won't work at `http://umbrel.local:3880`. Use an https address such as Tailscale Serve (`https://<machine>.<tailnet>.ts.net`) or a Cloudflare Tunnel. `http://localhost` also works for testing.

## JoolzApp accounts, trials and the admin panel (optional)

One **JoolzApp account** works in every app of yours that uses the same PocketBase. People create it once and sign in with it everywhere. They live in your PocketBase.

1. In `docker-compose.yml`, fill in `POCKETBASE_URL` (an address this container can reach, such as `http://192.168.1.50:8090`), `POCKETBASE_SUPERUSER_EMAIL` and `POCKETBASE_SUPERUSER_PASSWORD`. Then run `sudo docker compose up -d --build`.
2. Open ShutterWorth, go to Settings, and create your own account.
3. Make it an admin: `sudo docker compose exec shutterworth node make-admin.js you@example.com`
4. Reload. Settings now has a **Users** panel: edit or delete users, reset a trial, allow unlimited use of your key, set the default trial size, and close sign-ups. The AI key settings are only shown to admins.

**The app itself is locked.** With accounts on, nothing (page, inventory, photos, live updates) is served until someone signs in, and only admins and people an admin has allowed can open this server's inventory (Users panel, Allow access). New sign-ups can create an account and use trials, but see a "waiting for access" screen until you allow them. On Umbrel the app's own login is switched off (`PROXY_AUTH_ADD`), and `REQUIRE_ACCOUNTS=1` makes ShutterWorth refuse to show anything if PocketBase isn't connected, so it never opens unprotected.

How it is stored:

- The PocketBase `users` collection holds the JoolzApp account (email, password, name) and one extra field, `isAdmin`. **Admin is global**: you are admin in every current and future app, with nothing to recreate.
- A second collection, `app_access`, holds the per-app part: trial used, trial limit and unlimited. There is one row per person per app, so a trial in one app doesn't use up another's. Only the app servers can read it.
- Deleting a user in the panel deletes the JoolzApp account itself, so it disappears from every app.

### With Joolzapp Portal

If Joolzapp Portal is installed (its `portal_settings`, `portal_apps` and `portal_requests` collections exist), ShutterWorth follows it automatically:

- **Access**: the portal decides who may open the app. `portal.access` is resolved global, then app, then user, then user x app. With per-app approval switched on in the portal, new accounts are closed out until you approve ShutterWorth for them (they request it in the portal). The Users panel's Allow access button now sets that same portal setting and closes the person's pending request. Admins always get in. Without the portal, the old `access` flag still applies.
- **App on/off and maintenance**: switching ShutterWorth off, or putting it in maintenance, in the portal shows non-admins the portal's message.
- **Sign-ups**: closing sign-ups in the portal also closes them here (the local switch still works too).
- **Preferences**: each person's shared currency, language, time zone, date and time format and theme apply to amounts, dates, PDFs and the theme. Units and language text are not used here yet (the interface is English; language only sets number and date style).
- **Listing**: the first run registers ShutterWorth in the portal's app list (set `POCKETBASE_APP_NAME` to change the name shown).
- Deleting a user here also clears their portal settings and requests.

A trial counts photo identifications only (text-only requests are free), and a request that fails doesn't use one up. The first time it runs, ShutterWorth adds the `isAdmin` field to `users`, creates `app_access`, and stops people editing `isAdmin` through PocketBase's own API.

**For your next app:** copy `pocketbase.js` and `make-admin.js` into it, set the same three PocketBase variables, and set `POCKETBASE_APP_ID` to the app's name (this app uses `shutterworth`). Everyone's existing accounts and your admin status work straight away. To use a different collection name, set `POCKETBASE_USERS_COLLECTION`. Leave the three variables blank to run without accounts.

**With accounts on, each person's inventory lives in PocketBase under their own account** (collections `sw_docs` for lists, items and settings, and `sw_photos` for the pictures). The server only reads and writes the signed-in person's rows, and neither collection has API rules, so only this server can open them. Nobody sees anyone else's inventory. **Moving an existing inventory:** if the data folder still has a `db.json` from before accounts were switched on, the first time an admin opens the app it moves to the oldest admin account, once. It replaces anything that account already had in PocketBase, and the old files go to `data/legacy-backup/` (delete that folder once you're happy). With accounts off, one shared inventory stays in the data folder.

## Password

Set `APP_PASSWORD` in `docker-compose.yml`, then run `sudo docker compose up -d` again. Any username works.

## Back up

With accounts off, copy the `data` folder: `db.json` holds lists, items and settings, `photos/` holds the pictures. With accounts on, back up PocketBase instead. The in-app backups cover lists, items and settings only.

## Update

```sh
cd ~/shutterworth
git pull
sudo docker compose up -d --build
```

Your `data` folder is kept. `sudo docker compose down` stops the app.

### Automatic nightly updates

`auto-update.sh` checks GitHub every night at 03:15 and rebuilds the app when there's a new version. Set it up once:

```sh
cd ~/shutterworth
git config credential.helper store   # remember your GitHub token
git pull                             # enter username + token one last time
sudo ./auto-update.sh --install
```

- Update right now: `sudo ./auto-update.sh`
- See what happened: `cat auto-update.log`
- Turn it off: `sudo ./auto-update.sh --uninstall`

It skips the update if files in the folder were edited on the server, so nothing gets overwritten.

## Files

| Path | Purpose |
|---|---|
| `server.js` | Node server with no dependencies: routes, live updates, AI requests |
| `inventory-store.js` | Where inventories are kept: per-person in PocketBase with accounts on, or one shared inventory on disk |
| `public/index.html` | The app |
| `public/claude-shim.js` | Connects the page to this server (the app was first built as a claude.ai artifact) |
| `public/ai-settings.js` | The AI settings panel |
| `public/accounts.js` | Sign-in, trial status, and the admin Users panel |
| `public/settings-tabs.js` | Settings tabs: Account, Inventory, Data, Admin |
| `pocketbase.js`, `make-admin.js` | PocketBase accounts client and the make-an-admin command |
| `public/monetization.js` | Banner ads and the Remove ads purchase |
| `public/gdrive-store.js` | Google Drive storage and sign-in |
| `public/storage-settings.js` | The Storage settings panel |
| `.github/workflows/image.yml` | Builds the image and updates the Umbrel store on release |
| `release-notes.txt` | One line shown in Umbrel's update notes |

Run without Docker: `node server.js` (Node 20+), then open http://localhost:3880.
