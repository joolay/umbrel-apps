import subprocess,os
D=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))  # repo root
def svg(a,c1,c2,glyph):
    # v3 (crystal clear): no frame, no frosted square, no sheen or haze at all. The brand gradient fills the whole icon edge to edge
    # (the system rounds it on a phone), and a bold white glyph (20% larger than v1) sits on it with one tight, sharp shadow for definition.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c2}"/><stop offset="1" stop-color="{c1}"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="4" stdDeviation="2.5" flood-color="#000" flood-opacity=".28"/></filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g filter="url(#sh)"><g transform="translate(256 256) scale(1.2) translate(-256 -256)">{glyph}</g></g>
</svg>
'''
W='fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"'
icons={
 'jolly-grocer':('#1E7A4C','#4FC083',f'<g {W} stroke-width="30"><path d="M146 206h220l-25 124H171z"/><path d="M200 206l30-58M312 206l-30-58"/></g>'),
 'listify':('#0A6C8F','#3FB0D6',f'<path d="M168 266l62 62 118-132" {W} stroke-width="44"/>'),
 'diner-bell':('#d9480f','#ff8a4c',f'<g {W} stroke-width="24"><circle cx="256" cy="262" r="112"/><circle cx="256" cy="262" r="60"/><path d="M352 166l56-56M382 110h26v26"/></g>'),
 'services-manager':('#5b7cf5','#8f6bff',f'<g {W} stroke-width="22"><rect x="130" y="156" width="252" height="86" rx="24"/><rect x="130" y="282" width="252" height="86" rx="24"/></g><g fill="#fff"><circle cx="182" cy="199" r="14"/><circle cx="182" cy="325" r="14"/></g>'),
 'app-updater':('#c2347a','#ff6fae',f'<g {W} stroke-width="26"><path d="M350 222A100 100 0 0 0 162 222"/><path d="M162 290A100 100 0 0 0 350 290"/><path d="M140 204l22 26 22-26"/><path d="M328 308l22-26 22 26"/></g>'),
 'cctv':('#3d2fb8','#8b7dff',f'<g {W} stroke-width="24"><path d="M138 200h190v112H138z"/><path d="M328 236l56-30v100l-56-30"/></g><circle cx="233" cy="256" r="26" fill="#fff"/>'),
 'tv-remote':('#0b6e8a','#3fb6d6',f'<g {W} stroke-width="24"><rect x="126" y="150" width="260" height="164" rx="30"/><path d="M196 372h120M256 314v58"/></g><circle cx="256" cy="232" r="22" fill="#fff"/><g fill="#fff"><circle cx="256" cy="186" r="7"/><circle cx="256" cy="278" r="7"/><circle cx="210" cy="232" r="7"/><circle cx="302" cy="232" r="7"/></g>'),
 'joolztv':('#0a63c9','#64d2ff',f'<g {W} stroke-width="24"><circle cx="256" cy="262" r="112"/></g><path d="M230 208l86 54-86 54z" fill="#fff"/>'),
 'routing-reporter':('#0f766e','#2dd4bf',f'<path d="M150 342C150 262 256 292 256 232S362 198 362 160" {W} stroke-width="26"/><g fill="#fff"><circle cx="150" cy="344" r="26"/><circle cx="256" cy="246" r="26"/><circle cx="362" cy="158" r="26"/></g>'),
 'project-tracker':('#b45309','#f59e0b',f'<g {W} stroke-width="24"><path d="M146 184h128M146 256h128M146 328h128"/><path d="M352 330V190M312 228l40-40 40 40"/></g>'),
 'shutterworth':('#0b6b4f','#3ccb95',f'<g {W} stroke-width="24"><path d="M130 190v-60h60M322 130h60v60M130 322v60h60M322 382h60v-60"/></g><g transform="rotate(-35 256 256)"><path fill="#fff" fill-rule="evenodd" d="M168 256l46-52h108a22 22 0 0 1 22 22v60a22 22 0 0 1-22 22H214zM196 256a12 12 0 1 0 24 0a12 12 0 1 0-24 0z"/></g>'),
 'theme-editor':('#7c3aed','#f472b6',f'<g {W} stroke-width="24"><path d="M256 138c-70 0-122 50-122 112 0 60 46 124 112 124 30 0 34-22 18-40-14-16-4-36 20-36h46c40 0 68-26 68-62 0-58-60-98-142-98z"/></g><g fill="#fff"><circle cx="196" cy="226" r="20"/><circle cx="256" cy="190" r="20"/><circle cx="318" cy="226" r="20"/><circle cx="188" cy="296" r="20"/></g>'),
 'kiosk-manager':('#be123c','#fb7185',f'<g {W} stroke-width="24"><rect x="126" y="150" width="260" height="170" rx="28"/><path d="M256 320v46M196 366h120"/></g>'),
}
def run(*a): subprocess.run(a,check=True)
import sys

# ---- JoolzApp Dashboard, Portal Admin and the home screen's own tiles (Family, Settings, Admin) ----
# Same glass tile as every app. Glyphs drawn on a 24x24 grid are placed with line24(); the brand bolts are filled shapes.
GOLD='<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset="1" stop-color="#e0a92f"/></linearGradient>'
def line24(paths,scale=10.5,dy=4,extra=''):
    off=256-12*scale
    return f'<g transform="translate({off:g} {off+dy:g}) scale({scale:g})"><g {W} stroke-width="{26/scale:.2f}">{paths}</g>{extra}</g>'
# Store: a 2x2 grid of app tiles where the fourth tile is the JoolzApp bolt (gold). Same bold white shapes and 260px glyph box as every other icon.
BOLTS=GOLD+'<g fill="#fff"><rect x="126" y="126" width="120" height="120" rx="34"/><rect x="266" y="126" width="120" height="120" rx="34"/><rect x="126" y="266" width="120" height="120" rx="34"/></g><path transform="translate(326 326) scale(6.2) translate(-12 -12)" d="M13 2 4 14h7l-1 8 9-12h-7z" fill="url(#gold)" stroke="url(#gold)" stroke-width="1" stroke-linejoin="round"/>'
SHIELD='<path d="M12 3.2 5 5.8v5.6c0 4.3 2.8 7.6 7 9.4 4.2-1.8 7-5.1 7-9.4V5.8z"/>'
HOME='<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.8 9.8V20h12.4V9.8"/><path d="M12 18c-2.6-1.7-3.9-3.1-3.9-4.7a2.1 2.1 0 0 1 3.9-1.1 2.1 2.1 0 0 1 3.9 1.1c0 1.6-1.3 3-3.9 4.7z"/>'
GEAR='<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
ADMIN=GOLD+line24(SHIELD,11.5,2,'<path d="M13 7.6 9.4 12.7h2.4l-.9 3.9 3.8-5.2h-2.5z" fill="url(#gold)"/>')
# name: (dark, light, glyph, [files to write], folder that also gets the PNG set or None)
special={
 # JoolzApp Dashboard: the twin bolts. Also the home-screen (PWA) icon of the dashboard, which is served from Portal Admin's public folder.
 'portal':('#2a35b8','#7482ff',BOLTS,['joolay-portal/icon.svg','src/portal-admin/public/icon.svg'],'src/portal-admin/public'),
 # Portal Admin: a shield holding the gold bolt. The dashboard's Admin tile is the same picture.
 'portal-admin':('#1e2a52','#5b6fc4',ADMIN,['joolay-portal-admin/icon.svg','src/portal-admin/public/icons/admin.svg'],None),
 'family':('#e8590c','#ff8fa3',line24(HOME,12.2,2),['src/portal-admin/public/icons/family.svg'],None),
 'settings':('#475569','#9aa7bd',line24(GEAR,10,4),['src/portal-admin/public/icons/settings.svg'],None),
 # Portal Admin's own tools and the folders: same solid tile as the apps (colours = the tile gradients in src/portal-admin/public/app.js, ADMIN_TOOLS).
 'overview':('#7c5cf0','#5b8cff',line24('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',10.5,4),['src/portal-admin/public/icons/overview.svg'],None),
 'global':('#475569','#94a3b8',line24('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.6 5.2 3.6 8.5s-1 6.1-3.6 8.5c-2.6-2.4-3.6-5.2-3.6-8.5s1-6.1 3.6-8.5z"/>',10.5,4),['src/portal-admin/public/icons/global.svg'],None),
 'apps':('#6366f1','#a855f7',line24('<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 12.5l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5"/>',10.5,4),['src/portal-admin/public/icons/apps.svg'],None),
 'users':('#0ea5e9','#10b981',line24('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.5-4 3.2-6 7-6s6.5 2 7 6"/>',10.5,4),['src/portal-admin/public/icons/users.svg'],None),
 'requests':('#fb923c','#f43f5e',line24('<path d="M4 13l2.5-7.5h11L20 13v5.5H4z"/><path d="M4 13h4.5l1 2.5h5l1-2.5H20"/>',10.5,4),['src/portal-admin/public/icons/requests.svg'],None),
 'cleanup':('#22c55e','#14b8a6',line24('<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/>',10.5,4),['src/portal-admin/public/icons/cleanup.svg'],None),
 'paywall':('#0ea5e9','#22c55e',line24('<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10.5h17M7 14.5h3.5"/>',10.5,4),['src/portal-admin/public/icons/paywall.svg'],None),
 'keys':('#ef4444','#f59e0b',line24('<circle cx="8.5" cy="15.5" r="3.8"/><path d="M11.4 12.7 19.5 4.5M16.5 7.5l2.5 2.5M14 10l2 2"/>',10.5,4),['src/portal-admin/public/icons/keys.svg'],None),
 'joolzapps':('#0f766e','#2dd4bf',line24('<path d="M5 18c0-5.5 7-3.5 7-8.5S19 7 19 5"/><circle cx="5" cy="18.5" r="1.6"/><circle cx="12" cy="11" r="1.6"/><circle cx="19" cy="5.5" r="1.6"/>',10.5,4),['src/portal-admin/public/icons/joolzapps.svg'],None),
 'names':('#6366f1','#06b6d4',line24('<path d="M4 16.5V20h3.5L18.2 9.3l-3.5-3.5z"/><path d="M13 7.5l3.5 3.5"/>',10.5,4),['src/portal-admin/public/icons/names.svg'],None),
 'audit':('#f97316','#eab308',line24('<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',10.5,4),['src/portal-admin/public/icons/audit.svg'],None),
 'changes':('#ec4899','#8b5cf6',line24('<path d="M5 8h10M12 5l3 3-3 3M19 16H9M12 13l-3 3 3 3"/>',10.5,4),['src/portal-admin/public/icons/changes.svg'],None),
 'gatekeeper':('#334155','#64748b',line24('<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.2v2.6"/>',10.5,4),['src/portal-admin/public/icons/gatekeeper.svg'],None),
}
def pngs(pub,c1):
    run('rsvg-convert','-w','180','-h','180',f'{pub}/icon.svg','-o',f'{pub}/icon-180.png')
    run('rsvg-convert','-w','512','-h','512',f'{pub}/icon.svg','-o',f'{pub}/icon-512.png')
    run('rsvg-convert','-w','360','-h','360',f'{pub}/icon.svg','-o','/tmp/mi-in.png')
    run('convert','/tmp/mi-in.png','-background',c1,'-gravity','center','-extent','512x512',f'{pub}/icon-maskable-512.png')

# usage: python3 templates/glass/make-icons.py <name> [<name>...]   (names from `icons` or `special`; with no names it only lists them,
# so nobody rebuilds, and overwrites, every app's icon by accident)
want=sys.argv[1:]
if not want: print('apps:',' '.join(icons),'\nspecial:',' '.join(special)); sys.exit()
for a in want:
    if a in special:
        c1,c2,g,files,pub=special[a]; s=svg(a,c1,c2,g)
        for p in files: os.makedirs(os.path.dirname(f'{D}/{p}'),exist_ok=True); open(f'{D}/{p}','w').write(s)
        if pub: pngs(f'{D}/{pub}',c1)
    else:
        c1,c2,g=icons[a]; s=svg(a,c1,c2,g); pub=f'{D}/src/{a}/public'
        for p in (f'{pub}/icon.svg',f'{D}/joolay-{a}/icon.svg'): open(p,'w').write(s)
        pngs(pub,c1)
print('ok')
