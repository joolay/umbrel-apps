# JoolzApp public tunnel (Tailscale Funnel)

Publishes the Portal Admin hub and chosen apps to the internet without touching the Umbrel dashboard or OpenClaw.
Each service is a separate, tagged Tailscale node in userspace-networking mode.

| Public address | Goes to | Umbrel port |
|---|---|---|
| `https://joolzapp.<tailnet>.ts.net` | Portal Admin (hub) | 3892 |
| `https://shutterworth.<tailnet>.ts.net` | ShutterWorth | 3881 |

`<tailnet>` is your tailnet name (Tailscale admin console > DNS, e.g. `tail1234`; you can rename it there).
To add an app, copy a service block, change the hostname and the Umbrel port, then register its address as the app's
URL in Portal Admin so it gets an Open button.

## One-time setup
1. Tailscale admin console > DNS: enable **HTTPS certificates** (and MagicDNS).
2. Access controls: create the tag and allow Funnel only for it:
   ```json
   "tagOwners": { "tag:public": ["autogroup:admin"] },
   "nodeAttrs": [ { "target": ["tag:public"], "attr": ["funnel"] } ]
   ```
3. Settings > Keys: generate a **reusable** auth key with tag `tag:public`.
4. On the Umbrel (SSH), copy this folder somewhere outside Umbrel's own app folders, e.g. `~/joolzapp-tunnel`, then:
   ```
   cp .env.example .env     # paste the auth key into .env
   docker compose up -d
   docker compose logs -f   # each node should say it is serving on https://<name>.<tailnet>.ts.net
   ```
5. Portal Admin > Apps: set each app's URL to its public address so approved users get an Open button.

## Safety notes
- OpenClaw's node and the Umbrel dashboard are untouched: no host networking, no TUN device, no shared state.
- Portal Admin refuses admin sign-in and every PocketBase admin API call for requests that arrive through Funnel
  (detected from the `Tailscale-Funnel-Request` header and non-private forwarded addresses). Admin works from your
  home network or tailnet only. Set `ALLOW_PUBLIC_ADMIN=1` on the portal to switch this off (not recommended).
- Portal Admin's normal Umbrel address (port 3890) still sits behind Umbrel's login; port 3892 is only for the tunnel.
- Sessions are per hostname, so users sign in once per app with the same JoolzApp account.
- `docker compose down` removes the public routes; the Umbrel apps keep running.
