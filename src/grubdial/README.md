# GrubDial

Upload a restaurant menu (photo, PDF, link or pasted text), order from one or more restaurants, add special instructions,
a tip and a bill split (equal or by item), then tap to call the restaurant.

- Sign-in: shared JoolzApp account on PocketBase (`pocketbase.js`, `POCKETBASE_APP_ID=grubdial`), gated by Portal Admin.
- Menus: one shared archive in PocketBase (`grubdial_menus`, created automatically). Anyone signed in can order from any menu; only the uploader or an admin can edit or delete it.
- Carts: one JSON file per person in `/data/users/`.
- Menu reading: an AI key, set by an admin on the home screen (stored in `/data/ai-config.json`) or via `AI_API_KEY` / `AI_PROVIDER` / `AI_MODEL`.
- Setup: PocketBase is found at the Umbrel PocketBase app automatically. Create `pocketbase.env` in this app's data folder with `POCKETBASE_SUPERUSER_EMAIL=` and `POCKETBASE_SUPERUSER_PASSWORD=` (copying ShutterWorth's file also works), then restart the app.
