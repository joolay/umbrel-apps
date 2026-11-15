# JoolzApp public addresses with TSDProxy (Tailscale Funnel)

TSDProxy watches Docker and gives every container that carries labels its own Tailscale address, with Funnel on. Our own
apps already carry the labels in their compose files (`joolay-*/docker-compose.yml`), so **installing or updating an app from
the store is what publishes it**. No per-app Tailscale steps.

| Public address | App | Host port |
|---|---|---|
| `https://joolzapp.<tailnet>.ts.net` | Portal Admin: the Dashboard (user-only port) | 3892 |
| `https://shutterworth.<tailnet>.ts.net` | ShutterWorth | 3882 |
| `https://diner-bell.<tailnet>.ts.net` | Diner Bell | 3894 |
| `https://listify.<tailnet>.ts.net` | Listify | 3898 |

## One-time setup (Umbrel, over SSH)
Needs (already done): HTTPS certificates on, `tag:public` with the `funnel` attribute in your policy, and a reusable auth key tagged `tag:public`.

1. **Remove the old manual tunnel**, if you set it up:
   ```
   cd ~/joolzapp-tunnel && sudo docker compose down
   ```
   Then in the Tailscale admin console, Machines, delete the old `joolzapp` and `shutterworth` machines. Otherwise the new ones get a `-1` added to the name.
2. **Update the apps** in the Umbrel App Store (Portal Admin, ShutterWorth, Diner Bell). The update adds the labels and ports.
3. **Get this folder onto the Umbrel and run setup:**
   ```
   mkdir -p ~/tsdproxy && cd ~/tsdproxy
   for f in docker-compose.yml setup.sh; do curl -fsSLO https://raw.githubusercontent.com/joolay/umbrel-apps/main/deploy/tsdproxy/$f; done
   chmod +x setup.sh && sudo ./setup.sh
   ```
   It asks for the auth key (hidden), writes it into TSDProxy's config and starts it.
4. **Check:** `sudo docker compose logs -f` should show a proxy starting for each app. In the Tailscale Machines page the three names appear, tagged `tag:public`.
5. **Check the guard** (important): open `https://joolzapp.<tailnet>.ts.net/config` from your phone on mobile data. It must contain `"public":true`. Admin sign-in is refused on this address by design.

## Adding another app
In that app's compose file, on the container that serves it, publish a host port and add three labels (use your own name and ports):
```yaml
    ports:
      - "3895:3000"
    labels:
      tsdproxy.enable: "true"
      tsdproxy.name: "myapp"
      tsdproxy.port.1: "443/https:3895/http, no_autodetect, tailscale_funnel"
```
Publish it only if the app locks itself behind the JoolzApp account (as ShutterWorth and Diner Bell do), because Funnel makes it public.
Never label an app that relies on Umbrel's own login (Portal Admin's normal address, Services Manager).
Then register its address under Portal Admin > Apps > URL so it gets an Open button.

## Good to know
- **Docker access:** TSDProxy reads the Docker socket, which lets it see (and control) all containers on this machine. That is more privilege than a plain tunnel. It only publishes containers that carry `tsdproxy.enable`.
- **Funnel is public:** anyone on the internet can reach a labelled app. Portal Admin's public port is user-only on purpose.
- **Not working?** Set `log: level: trace` in `config/tsdproxy.yaml`, then `sudo docker compose restart tsdproxy`. The log shows which addresses it tried for each app.
- **Switch off:** `sudo docker compose down` removes every public address. The apps keep running.
