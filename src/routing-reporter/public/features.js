// Port Master: what it does now and what is proposed. Shown from the TSDProxy tab ("Port Master features"). s: live | built (written, waiting for your yes to push) | proposed.
window.PM_FEATURES = [
  { g: "Watching routes", items: [
    { t: "Route checks", s: "live", d: "Every few minutes: LAN, .local, Tailscale address, Tailscale name and Public (Funnel) for every installed app, with the reason and time a route broke." },
    { t: "Needs attention summary, Fix help, Recheck, Open", s: "live", d: "Names the apps that need attention, explains the fix in plain steps, tests one route again straight away and opens an app on any route." },
    { t: "Port clash finder", s: "live", d: "Compares every port with your apps and the official Umbrel store, and says which app should move and to which free port." },
    { t: "Report to Portal Admin and the status feed", s: "live", d: "Fills the JoolzApp apps page, lets an admin tap Notify Claude on a broken route, and keeps a feed Claude can read." }
  ]},
  { g: "Switching routes", items: [
    { t: "Tap a tick to turn a route off or on", s: "built", d: "Every tick in the list is a switch. Grey dash means off. Off routes are never counted as a problem." },
    { t: "Real off switch for Public and Tailscale name", s: "built", d: "Pauses the app's TSDProxy proxy (the address stops answering) and resumes it. Kept in place after a TSDProxy restart. One switch covers both routes of an app." },
    { t: "LAN, .local and Tailscale address ticks", s: "built", d: "These stay monitoring-only: they reach the app's own port, so Port Master can only stop counting them." }
  ]},
  { g: "JoolzApp Store", items: [
    { t: "Add any app to the JoolzApp Store", s: "built", d: "Tap the Portal cell of any installed app that does not use the JoolzApp account (Stremio, OpenClaw...) to put a tile on the store, choosing the address it opens, and tap again to hide it. Choose Admin (only admins see the tile) or Portal (everyone with an account). A Login column shows which apps sit behind the JoolzApp account. JoolzApp apps still get theirs automatically." }
  ]},
  { g: "TSDProxy", items: [
    { t: "TSDProxy tab", s: "built", d: "Version, image, whether Port Master can control it, every proxy with its state, and Pause or Resume for each." },
    { t: "Version and automatic updates", s: "built", d: "Services Manager checks for a newer image about every 12 hours and installs it in the nightly window (or on Update now in App Updater), putting the old one back if the new one fails. App Updater shows the version." }
  ]},
  { g: "Proposed", items: [
    { t: "Login for added apps", s: "proposed", d: "Now Gatekeeper's job (it checks the JoolzApp account and the per-app access in front of the app). Port Master only points the app's name at it." },
    { t: "Tailscale tag upkeep", s: "proposed", d: "Port Master keeps the Tailscale tag on every app and dashboard name, so routing stays in one place and Gatekeeper only does access control. Waiting for which tag to use and where it is applied." },
    { t: "Access denied page instead of nothing", s: "proposed", d: "For apps published through TSDProxy's list file (like OpenClaw), point the address at a small Access denied page. Not possible for apps whose route comes from their own compose labels." },
    { t: "Switch LAN and Tailscale address with a firewall", s: "proposed", d: "Needs a root-level helper on the Umbrel and the rules re-applied after a reboot. Higher risk of locking yourself out, so only with your go-ahead." },
    { t: "Schedules", s: "proposed", d: "For example, Public off from 23:00 to 05:00, or off whenever nobody has used the app for a week." },
    { t: "Alerts when a route goes down", s: "proposed", d: "A notice in the JoolzApp ticker or a push when a route breaks and again when it is back." },
    { t: "History", s: "proposed", d: "A short record of when each route was up or down, so a flaky route shows up as a pattern." },
    { t: "One-tap repair", s: "proposed", d: "A Restart app button on a broken route, done through Services Manager instead of opening Umbrel." },
    { t: "Open TSDProxy's own dashboard from your network", s: "proposed", d: "Its dashboard only answers on the Umbrel itself today. It could be published on the tailnet only." }
  ]}
];
