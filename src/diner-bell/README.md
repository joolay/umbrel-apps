# Diner Bell

Restaurants are picture tiles (search, hold to edit, drag to reorder). Upload a restaurant menu (photo, PDF, link or pasted text), order from one or more restaurants, add special instructions,
choose Collection, Delivery or Sit Down (delivery fee and driver tip, or a sit-down tip rounded to R10), split the bill, then tap to call the restaurant or send the order on WhatsApp (when the branch has a WhatsApp order number; tips are never sent).

- Sign-in: shared JoolzApp account on PocketBase (`pocketbase.js`, `POCKETBASE_APP_ID=diner-bell`), gated by Portal Admin.
- Menus: one shared archive in PocketBase (`grubtogo_menus`, created automatically). Anyone signed in can order from any menu; only the uploader or an admin can edit or delete it.
- Settings (default tip, tile order, preferred branch, hidden restaurants) are saved on the JoolzApp account (`pref.diner`), so updates never reset them. People an admin made view-only (`portal.readonly`) cannot change shared menus, pictures or branches.
- Carts: one JSON file per person in `/data/users/`.
- Menu reading: an AI key, set by an admin on the home screen (stored in `/data/ai-config.json`) or via `AI_API_KEY` / `AI_PROVIDER` / `AI_MODEL`.
- Setup: PocketBase is found at the Umbrel PocketBase app automatically. Create `pocketbase.env` in this app's data folder with `POCKETBASE_SUPERUSER_EMAIL=` and `POCKETBASE_SUPERUSER_PASSWORD=` (copying ShutterWorth's file also works), then restart the app.
