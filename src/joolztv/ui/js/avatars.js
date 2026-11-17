/* 24 built-in profile pictures, drawn as SVG (no files, no emoji: those draw differently on every TV). ES5. */
var Avatars = (function () {
  var W = 'fill="#fff"', E = 'fill="rgba(0,0,0,.45)"', S = 'fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"';
  /* id, name, gradient light, gradient dark, glyph on a 100 x 100 grid */
  var LIST = [
    ['a01', 'Star', '#ffd60a', '#ff9f0a', '<polygon ' + W + ' points="50,16 61,39 86,42 68,60 73,85 50,73 27,85 32,60 14,42 39,39"/>'],
    ['a02', 'Heart', '#ff7ab8', '#e0246f', '<path ' + W + ' d="M50 82C8 54 20 20 50 40 80 20 92 54 50 82z"/>'],
    ['a03', 'Moon', '#8f8cff', '#4b3fd8', '<path ' + W + ' d="M60 16A34 34 0 1 0 84 64 28 28 0 1 1 60 16z"/>'],
    ['a04', 'Sun', '#ffd23f', '#ff7a1a', '<circle ' + W + ' cx="50" cy="50" r="17"/><g ' + S + '><path d="M50 14v10M50 76v10M14 50h10M76 50h10M25 25l7 7M68 68l7 7M75 25l-7 7M32 68l-7 7"/></g>'],
    ['a05', 'Bolt', '#64d2ff', '#0a63c9', '<polygon ' + W + ' points="58,12 28,56 47,56 40,88 72,42 52,42"/>'],
    ['a06', 'Flower', '#ff9ccf', '#c2247a', '<g ' + W + '><circle cx="50" cy="28" r="15"/><circle cx="72" cy="44" r="15"/><circle cx="64" cy="70" r="15"/><circle cx="36" cy="70" r="15"/><circle cx="28" cy="44" r="15"/></g><circle fill="#ffd60a" cx="50" cy="51" r="11"/>'],
    ['a07', 'Leaf', '#7be0a5', '#1e7a4c', '<path ' + W + ' d="M22 78C16 36 48 16 82 20 84 56 62 82 22 78z"/><path fill="none" stroke="rgba(0,0,0,.35)" stroke-width="5" stroke-linecap="round" d="M26 74C42 56 56 44 72 30"/>'],
    ['a08', 'Paw', '#ffb27a', '#d9480f', '<g ' + W + '><ellipse cx="50" cy="66" rx="22" ry="17"/><ellipse cx="25" cy="46" rx="9" ry="12"/><ellipse cx="42" cy="32" rx="9" ry="12"/><ellipse cx="58" cy="32" rx="9" ry="12"/><ellipse cx="75" cy="46" rx="9" ry="12"/></g>'],
    ['a09', 'Cat', '#ffc46b', '#e8590c', '<g ' + W + '><circle cx="50" cy="56" r="29"/><polygon points="24,44 24,14 46,30"/><polygon points="76,44 76,14 54,30"/></g><circle ' + E + ' cx="40" cy="54" r="4.5"/><circle ' + E + ' cx="60" cy="54" r="4.5"/><path d="M45 66q5 5 10 0" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="4" stroke-linecap="round"/>'],
    ['a10', 'Dog', '#c9a07a', '#7a4a21', '<g ' + W + '><ellipse cx="50" cy="52" rx="24" ry="28"/><ellipse cx="22" cy="48" rx="11" ry="22" transform="rotate(12 22 48)"/><ellipse cx="78" cy="48" rx="11" ry="22" transform="rotate(-12 78 48)"/></g><circle ' + E + ' cx="41" cy="46" r="4.5"/><circle ' + E + ' cx="59" cy="46" r="4.5"/><ellipse ' + E + ' cx="50" cy="60" rx="7" ry="5"/>'],
    ['a11', 'Bear', '#d9b38c', '#8a5a33', '<g ' + W + '><circle cx="50" cy="54" r="30"/><circle cx="24" cy="26" r="12"/><circle cx="76" cy="26" r="12"/></g><ellipse fill="rgba(0,0,0,.18)" cx="50" cy="64" rx="13" ry="10"/><circle ' + E + ' cx="39" cy="48" r="4.5"/><circle ' + E + ' cx="61" cy="48" r="4.5"/><circle ' + E + ' cx="50" cy="61" r="4.5"/>'],
    ['a12', 'Fox', '#ffa05a', '#d9480f', '<polygon ' + W + ' points="14,18 40,38 60,38 86,18 82,60 50,86 18,60"/><circle ' + E + ' cx="38" cy="52" r="4.5"/><circle ' + E + ' cx="62" cy="52" r="4.5"/><polygon ' + E + ' points="45,68 55,68 50,75"/>'],
    ['a13', 'Robot', '#9aa7bd', '#3a4660', '<rect ' + W + ' x="22" y="32" width="56" height="46" rx="12"/><path d="M50 32V18" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle ' + W + ' cx="50" cy="15" r="6"/><circle fill="#64d2ff" cx="38" cy="52" r="7"/><circle fill="#64d2ff" cx="62" cy="52" r="7"/><rect ' + E + ' x="36" y="66" width="28" height="5" rx="2.5"/>'],
    ['a14', 'Rocket', '#8fe3ff', '#0e7bd8', '<path ' + W + ' d="M50 12C68 28 70 52 64 70H36C30 52 32 28 50 12z"/><circle fill="#0e7bd8" cx="50" cy="42" r="8"/><polygon ' + W + ' points="36,56 22,76 38,72"/><polygon ' + W + ' points="64,56 78,76 62,72"/><path d="M43 76q7 14 14 0z" fill="#ffd60a"/>'],
    ['a15', 'Planet', '#c79cff', '#5b2fb8', '<circle ' + W + ' cx="50" cy="50" r="22"/><ellipse cx="50" cy="52" rx="40" ry="11" fill="none" stroke="#fff" stroke-width="6" transform="rotate(-20 50 52)" opacity=".85"/>'],
    ['a16', 'Ghost', '#b9c4ff', '#4b5bd8', '<path ' + W + ' d="M22 84V46A28 28 0 0 1 78 46V84L67 74 58 84 50 74 42 84 33 74z"/><circle ' + E + ' cx="40" cy="46" r="5.5"/><circle ' + E + ' cx="60" cy="46" r="5.5"/>'],
    ['a17', 'Crown', '#ffe27a', '#e0a020', '<polygon ' + W + ' points="16,72 16,30 36,50 50,22 64,50 84,30 84,72"/><rect ' + W + ' x="16" y="76" width="68" height="8" rx="4"/>'],
    ['a18', 'Music', '#ff8fa3', '#c2185b', '<ellipse ' + W + ' cx="36" cy="72" rx="13" ry="10"/><path d="M47 72V24l30 10v14L58 42v30" fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>'],
    ['a19', 'Gamepad', '#7ee0c8', '#0a7c8a', '<rect ' + W + ' x="12" y="34" width="76" height="40" rx="20"/><path d="M30 46v16M22 54h16" stroke="rgba(0,0,0,.45)" stroke-width="5" stroke-linecap="round"/><circle ' + E + ' cx="66" cy="48" r="5"/><circle ' + E + ' cx="76" cy="58" r="5"/>'],
    ['a20', 'Camera', '#a0a8b8', '#2b3140', '<path ' + W + ' d="M16 34h16l6-10h24l6 10h16a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V38a4 4 0 0 1 4-4z"/><circle fill="#2b3140" cx="50" cy="56" r="16"/><circle ' + W + ' cx="50" cy="56" r="10"/>'],
    ['a21', 'Popcorn', '#ffb27a', '#d9480f', '<path ' + W + ' d="M24 46h52l-7 40H31z"/><g fill="rgba(217,72,15,.45)"><rect x="35" y="52" width="7" height="30" rx="3"/><rect x="47" y="52" width="7" height="30" rx="3"/><rect x="59" y="52" width="7" height="30" rx="3"/></g><g ' + W + '><circle cx="34" cy="40" r="11"/><circle cx="50" cy="32" r="13"/><circle cx="66" cy="40" r="11"/></g>'],
    ['a22', 'Pizza', '#ffd27a', '#d9480f', '<path ' + W + ' d="M50 88L14 28Q50 10 86 28z"/><path d="M20 32Q50 18 80 32" fill="none" stroke="#e0a020" stroke-width="7" stroke-linecap="round"/><circle fill="#e0246f" cx="42" cy="44" r="6"/><circle fill="#e0246f" cx="60" cy="48" r="6"/><circle fill="#e0246f" cx="50" cy="64" r="5"/>'],
    ['a23', 'Fish', '#7fd6ff', '#0a63c9', '<ellipse ' + W + ' cx="44" cy="50" rx="28" ry="20"/><polygon ' + W + ' points="68,50 90,32 90,68"/><circle ' + E + ' cx="32" cy="45" r="4.5"/>'],
    ['a24', 'Diamond', '#9ef0ff', '#1f7ad8', '<polygon ' + W + ' points="30,28 70,28 88,46 50,88 12,46"/><path d="M12 46h76M30 28l20 18 20-18M50 46v42" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="3.5" stroke-linejoin="round"/>']
  ];
  var uid = 0;
  function find(id) { for (var i = 0; i < LIST.length; i++) if (LIST[i][0] === id) return LIST[i]; return null; }
  function svg(a) {
    var g = 'ag' + (++uid);
    return '<svg class="pimg" viewBox="0 0 100 100"><defs><linearGradient id="' + g + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + a[2] + '"/><stop offset="1" stop-color="' + a[3] + '"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#' + g + ')"/><circle cx="30" cy="20" r="46" fill="#fff" opacity=".14"/>' + a[4] + '</svg>';
  }
  /* what to draw for a profile: the JoolzApp photo (if chosen, or if nothing else was chosen), else a built-in picture */
  function html(p, index) {
    var c = p && p.avatar || '';
    if (p && p.photo && (c === 'photo' || !c)) return '<img class="pimg" alt="" src="' + p.photo + '">';
    var a = find(c) || LIST[(index || 0) % LIST.length];
    return svg(a);
  }
  return { LIST: LIST, find: find, html: html, svg: svg };
})();
if (typeof module !== 'undefined') module.exports = Avatars;
