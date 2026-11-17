/* The household (up to 12 profiles, one JoolzApp account each) lives on the server; this keeps a copy on the device. */
var Profiles = (function () {
  var COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68', '#5e5ce6', '#32ade6', '#ff6482', '#63e6be'];
  function all() { return Store.get('household', []) || []; }
  function setAll(list) { Store.set('household', list || []); }
  function get(id) { var l = all(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function active() { var id = Store.active(); return id ? get(id) : null; }
  function setActive(id) { Store.setActive(id); }
  function max() { return (window.JTV && JTV.maxProfiles) || 12; }
  return { all: all, setAll: setAll, get: get, active: active, setActive: setActive, max: max, COLORS: COLORS };
})();
