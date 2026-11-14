# GrubDial

Upload a restaurant menu (photo, PDF, link or pasted text), order from one or more restaurants, add special instructions,
a tip and a bill split (equal or by item), then tap to call the restaurant.

- Sign-in: shared JoolzApp account on PocketBase (`pocketbase.js`, `POCKETBASE_APP_ID=grubdial`), gated by Portal Admin.
- Saved menus and carts: one JSON file per person in `/data/users/`.
- Menu reading: an AI key, set by an admin on the home screen (stored in `/data/ai-config.json`) or via `AI_API_KEY` / `AI_PROVIDER` / `AI_MODEL`.
- Setup: copy ShutterWorth's `pocketbase.env` into this app's data folder, then restart the app.
