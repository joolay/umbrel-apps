# Portal Admin change inbox

Each `*.json` file here shows up in Portal Admin > Changes with a plain-English plan and an Apply button. Nothing is applied until an admin presses it.
Files are read from `main` by Portal Admin 0.28.0 or newer. They are data only (no code), so adding one needs no image build and no app update.

```json
{
  "id": "portal-url",
  "title": "Set the JoolzApp address",
  "summary": "QR sign-in on the TV needs the public address of the JoolzApp Dashboard.",
  "ops": [
    { "op": "setting", "key": "portal.url", "value": "https://joolzapp.<tailnet>.ts.net", "note": "address of the Portal" }
  ]
}
```

Operations: `setting` (set a global, non-secret setting), `delete-setting`, and `install-app` (`{ "op": "install-app", "id": "joolay-name" }`: queue a new JoolzApp for App Updater to install automatically once umbrelOS lists it; Portal Admin 0.38.0 or newer). Keys starting with `secret.` are refused. `portal.url` must have no trailing slash and no `#`.
Use a new `id` for each change; applied changes disappear from the Changes page. Anything else (new collections, fields, files) still ships as a built-in change in `src/portal-admin/changes/`.
