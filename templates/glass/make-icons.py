import subprocess,os
D=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))  # repo root
def svg(a,c1,c2,glyph):
    # v2 (crisper): the frosted square is much larger (444 of 512, was 340) and has no outline, rim line or corner arc, the glyph is 16% larger,
    # and the soft haze is gone: a clean gradient, one light sheen on the square and a tight shadow under the glyph.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c2}"/><stop offset="1" stop-color="{c1}"/></linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset=".55" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#000" stop-opacity=".10"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="#000" flood-opacity=".30"/></filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect x="34" y="34" width="444" height="444" rx="108" fill="#fff" fill-opacity=".16"/>
  <rect x="34" y="34" width="444" height="444" rx="108" fill="url(#sheen)"/>
  <g filter="url(#sh)"><g transform="translate(256 256) scale(1.16) translate(-256 -256)">{glyph}</g></g>
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
 'shutterworth':('#145f4f','#2f8571','''<g fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"><path d="M128 190v-56h56"/><path d="M328 134h56v56"/><path d="M128 322v56h56"/><path d="M328 378h56v-56"/></g><circle cx="352" cy="164" r="11" fill="#f0645a"/><g transform="translate(256 262) rotate(-27) scale(.82)"><defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1d28a"/><stop offset=".5" stop-color="#d9ab55"/><stop offset="1" stop-color="#b98633"/></linearGradient></defs><path d="M-118 0 L-66 -54 H104 Q122 -54 122 -36 V36 Q122 54 104 54 H-66 Z" fill="url(#gold)" stroke="#c99a46" stroke-width="2" stroke-linejoin="round"/><circle cx="-68" cy="0" r="11" fill="#0f5a4b"/><text x="30" y="2" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-weight="700" font-size="86" fill="#0f5a4b">$</text></g>'''),
 'kiosk-manager':('#be123c','#fb7185',f'<g {W} stroke-width="24"><rect x="126" y="150" width="260" height="170" rx="28"/><path d="M256 320v46M196 366h120"/></g>'),
}
def run(*a): subprocess.run(a,check=True)
import sys

# ---- JoolzApp Portal, Portal Admin and the home screen's own tiles (Family, Settings, Admin) ----
# Same glass tile as every app. Glyphs drawn on a 24x24 grid are placed with line24(); the brand bolts are filled shapes.
GOLD='<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset="1" stop-color="#e0a92f"/></linearGradient>'
def line24(paths,scale=10.5,dy=4,extra=''):
    off=256-12*scale
    return f'<g transform="translate({off:g} {off+dy:g}) scale({scale:g})"><g {W} stroke-width="{26/scale:.2f}">{paths}</g>{extra}</g>'
BOLTS=GOLD+'<g transform="translate(70 86) scale(3.5)"><path d="M50 10L24 46H42L34 72L62 36H44Z" fill="#fff"/><path d="M68 28L48 56H62L54 88L82 50H66Z" fill="url(#gold)"/></g>'
SHIELD='<path d="M12 3.2 5 5.8v5.6c0 4.3 2.8 7.6 7 9.4 4.2-1.8 7-5.1 7-9.4V5.8z"/>'
HOME='<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.8 9.8V20h12.4V9.8"/><path d="M12 18c-2.6-1.7-3.9-3.1-3.9-4.7a2.1 2.1 0 0 1 3.9-1.1 2.1 2.1 0 0 1 3.9 1.1c0 1.6-1.3 3-3.9 4.7z"/>'
GEAR='<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
ADMIN=GOLD+line24(SHIELD,11.5,2,'<path d="M13 7.6 9.4 12.7h2.4l-.9 3.9 3.8-5.2h-2.5z" fill="url(#gold)"/>')
# name: (dark, light, glyph, [files to write], folder that also gets the PNG set or None)
special={
 # JoolzApp Portal: the twin bolts. Also the home-screen (PWA) icon of the dashboard, which is served from Portal Admin's public folder.
 'portal':('#0a0f1f','#27386b',BOLTS,['joolay-portal/icon.svg','src/portal-admin/public/icon.svg'],'src/portal-admin/public'),
 # Portal Admin: a shield holding the gold bolt. The dashboard's Admin tile is the same picture.
 'portal-admin':('#1e2a52','#5b6fc4',ADMIN,['joolay-portal-admin/icon.svg','src/portal-admin/public/icons/admin.svg'],None),
 'family':('#e8590c','#ff8fa3',line24(HOME,12.2,2),['src/portal-admin/public/icons/family.svg'],None),
 'settings':('#475569','#9aa7bd',line24(GEAR,10,4),['src/portal-admin/public/icons/settings.svg'],None),
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
