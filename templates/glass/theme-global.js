/* JoolzApp global theme loader (Theme Editor). Add as the LAST stylesheet-related tag in <head>:
     <script src="theme-global.js"></script>                       (portal at the same address, port 3886 by default)
     <script src="theme-global.js" data-portal="."></script>       (this app IS the portal: same origin)
     <script src="theme-global.js" data-portal="https://x.ts.net"></script>
   It adds <link href="<portal>/theme.css"> after the page's other CSS, so the admin's global theme (colours, sizes, font) wins over glass.css.
   It also marks TV browsers (webOS, Tizen, Android TV, Fire TV, or ?view=tv in the address) with <html data-view="tv"> so the TV template applies; phones, tablets and desktops
   are told apart by screen width (under 600px, 600-1023px, 1024px and up) in the generated CSS.
   If the portal can't be reached the link simply fails and the app keeps its normal Glass look. */
(function () {
  try {
    var de = document.documentElement;
    if (!de.getAttribute('data-view') && (/[?&]view=tv\b/.test(location.search) || /Web0S|webOS|SMART-TV|SmartTV|Tizen|HbbTV|BRAVIA|AFTM|Android TV|GoogleTV/i.test(navigator.userAgent))) de.setAttribute('data-view', 'tv');
    var s = (window.JZ_SCRIPT || document.currentScript), p = (s && s.getAttribute('data-portal')) || window.JZ_PORTAL || '';
    var base = p === '.' ? '' : (p || (location.protocol + '//' + location.hostname + ':3886')).replace(/\/+$/, '');
    function add() { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = base + '/theme.css'; l.setAttribute('data-jz-theme', ''); document.head.appendChild(l); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  } catch (e) {}
})();
