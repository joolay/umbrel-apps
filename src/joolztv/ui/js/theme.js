/* Dark / Light / Auto. Auto is light between sunrise and sunset, worked out on the device from the person's country (latitude) and the clock's time zone
   (longitude), so no location permission is needed. ES5 (runs on webOS 4). The choice is saved on the JoolzApp account (/api/theme). */
var Theme = (function () {
  var MODES = ['dark', 'light', 'auto'], mode = 'dark', timer = null;
  var LAT = { ZA: -29, GB: 54, IE: 53, US: 39, CA: 56, AU: -25, NZ: -41, DE: 51, FR: 46, ES: 40, IT: 42, NL: 52, BE: 51, PT: 39, SE: 62, NO: 61, DK: 56, FI: 64, PL: 52, AT: 47, CH: 47, GR: 39, TR: 39, IN: 21, CN: 35, JP: 36, KR: 36, SG: 1, AE: 24, SA: 24, IL: 31, EG: 27, NG: 9, KE: 0, GH: 8, ZW: -19, BW: -22, NA: -22, MZ: -18, ZM: -14, MX: 23, BR: -14, AR: -34, CL: -33, CO: 4, PE: -10, PH: 13, MY: 4, TH: 15, ID: -2, VN: 16, PK: 30, RU: 60, UA: 49 };
  function rad(d) { return d * Math.PI / 180; }
  /* sunrise and sunset as minutes after local midnight (NOAA approximation); null for polar day or night */
  function sun(date, lat, lon, tzOffsetMin) {
    var start = Date.UTC(date.getFullYear(), 0, 0), now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()), n = Math.round((now - start) / 86400000);
    var g = 2 * Math.PI / 365 * (n - 1);
    var eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var c = (Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl))) - Math.tan(rad(lat)) * Math.tan(decl);
    if (c > 1 || c < -1) return null;
    var ha = Math.acos(c) * 180 / Math.PI;
    var solarNoon = 720 - 4 * lon - eqt + tzOffsetMin;                      // local minutes (tzOffsetMin = minutes east of UTC)
    return { rise: solarNoon - 4 * ha, set: solarNoon + 4 * ha };
  }
  function isLightNow(now, region) {
    var lat = LAT[region], hasLat = typeof lat === 'number';
    var tz = -now.getTimezoneOffset(), lon = tz / 60 * 15;                  // the time zone's central meridian
    var min = now.getHours() * 60 + now.getMinutes();
    if (!hasLat) return min >= 6 * 60 + 30 && min < 18 * 60 + 30;           // no country known: 06:30 to 18:30
    var s = sun(now, lat, lon, tz);
    if (!s) return lat * (now.getMonth() < 3 || now.getMonth() > 8 ? 1 : -1) > 0 ? false : true;   // polar: winter dark, summer light (rough)
    return min >= s.rise && min < s.set;
  }
  function effective() { return mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : (isLightNow(new Date(), window.Tmdb && Tmdb.region ? Tmdb.region() : '') ? 'light' : 'dark'); }
  function apply() {
    var e = effective(), root = document.documentElement;
    if (root.className.indexOf('light') >= 0) { if (e === 'dark') root.className = root.className.replace(/\s*\blight\b/, ''); } else if (e === 'light') root.className += (root.className ? ' ' : '') + 'light';
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', e === 'light' ? '#f2f2f7' : '#0b0d12');
    return e;
  }
  function remember() { try { localStorage.setItem('jtv.theme', mode); } catch (e) {} }
  function set(m, save) {
    if (MODES.indexOf(m) < 0) return; mode = m; remember(); apply(); schedule();
    if (save !== false && window.Backend && Backend.token()) Backend.call('PUT', '/api/theme', { mode: m }).catch(function () {});
  }
  function schedule() { clearInterval(timer); if (mode === 'auto') timer = setInterval(apply, 60000); }
  function load() {                                                        // after sign-in: the account's choice wins
    if (!window.Backend || !Backend.token()) return;
    Backend.call('GET', '/api/theme', undefined, undefined, 8000).then(function (j) { if (MODES.indexOf(j.mode) >= 0) { mode = j.mode; remember(); apply(); schedule(); } }).catch(function () {});
  }
  try { var m0 = localStorage.getItem('jtv.theme'); if (MODES.indexOf(m0) >= 0) mode = m0; } catch (e) {}
  if (typeof document !== 'undefined') { apply(); schedule(); }
  return { set: set, mode: function () { return mode; }, load: load, apply: apply, effective: effective, sun: sun, isLightNow: isLightNow, MODES: MODES };
})();
if (typeof module !== 'undefined') module.exports = Theme;
