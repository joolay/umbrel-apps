import subprocess,os
D=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))  # repo root
def svg(a,c1,c2,glyph):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c2}"/><stop offset="1" stop-color="{c1}"/></linearGradient>
    <radialGradient id="glow" cx="0.2" cy="0.12" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity=".4"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="10" stdDeviation="9" flood-color="#000" flood-opacity=".28"/></filter>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#glow)"/>
  <rect x="86" y="86" width="340" height="340" rx="90" fill="url(#panel)" stroke="url(#rim)" stroke-width="3"/>
  <path d="M120 130a60 60 0 0 1 60-44h152" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="5" stroke-linecap="round"/>
  <g filter="url(#sh)">{glyph}</g>
</svg>
'''
W='fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"'
icons={
 'jolly-grocer':('#1E7A4C','#4FC083',f'<g {W} stroke-width="30"><path d="M146 206h220l-25 124H171z"/><path d="M200 206l30-58M312 206l-30-58"/></g>'),
 'listify':('#0A6C8F','#3FB0D6',f'<path d="M168 266l62 62 118-132" {W} stroke-width="44"/>'),
 'grubtogo':('#d9480f','#ff8a4c',f'<g {W} stroke-width="24"><circle cx="256" cy="262" r="112"/><circle cx="256" cy="262" r="60"/><path d="M352 166l56-56M382 110h26v26"/></g>'),
 'portal-admin':('#3b6df0','#8f6bff','<g transform="translate(96 96) scale(1.25)"><g fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="14" stroke-linecap="round"><path d="M56 88h144M56 128h144M56 168h144"/></g><g fill="#fff"><circle cx="92" cy="88" r="20"/><circle cx="164" cy="128" r="20"/><circle cx="112" cy="168" r="20"/></g></g>'),
 'services-manager':('#5b7cf5','#8f6bff',f'<g {W} stroke-width="22"><rect x="130" y="156" width="252" height="86" rx="24"/><rect x="130" y="282" width="252" height="86" rx="24"/></g><g fill="#fff"><circle cx="182" cy="199" r="14"/><circle cx="182" cy="325" r="14"/></g>'),
 'app-updater':('#c2347a','#ff6fae',f'<g {W} stroke-width="26"><path d="M350 222A100 100 0 0 0 162 222"/><path d="M162 290A100 100 0 0 0 350 290"/><path d="M140 204l22 26 22-26"/><path d="M328 308l22-26 22 26"/></g>'),
 'shutterworth':('#145f4f','#2f8571','''<g fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"><path d="M128 190v-56h56"/><path d="M328 134h56v56"/><path d="M128 322v56h56"/><path d="M328 378h56v-56"/></g><circle cx="352" cy="164" r="11" fill="#f0645a"/><g transform="translate(256 262) rotate(-27) scale(.82)"><defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1d28a"/><stop offset=".5" stop-color="#d9ab55"/><stop offset="1" stop-color="#b98633"/></linearGradient></defs><path d="M-118 0 L-66 -54 H104 Q122 -54 122 -36 V36 Q122 54 104 54 H-66 Z" fill="url(#gold)" stroke="#c99a46" stroke-width="2" stroke-linejoin="round"/><circle cx="-68" cy="0" r="11" fill="#0f5a4b"/><text x="30" y="2" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-weight="700" font-size="86" fill="#0f5a4b">$</text></g>'''),
}
def run(*a): subprocess.run(a,check=True)
for a,(c1,c2,g) in icons.items():
    s=svg(a,c1,c2,g); pub=f'{D}/src/{a}/public'
    for p in (f'{pub}/icon.svg',f'{D}/joolay-{a}/icon.svg'): open(p,'w').write(s)
    run('rsvg-convert','-w','180','-h','180',f'{pub}/icon.svg','-o',f'{pub}/icon-180.png')
    run('rsvg-convert','-w','512','-h','512',f'{pub}/icon.svg','-o',f'{pub}/icon-512.png')
    run('rsvg-convert','-w','360','-h','360',f'{pub}/icon.svg','-o',f'/tmp/{a}-in.png')
    run('convert',f'/tmp/{a}-in.png','-background',c1,'-gravity','center','-extent','512x512',f'{pub}/icon-maskable-512.png')
print('ok')
