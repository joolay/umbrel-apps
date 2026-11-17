/* Download ahead: the server reads a whole file from the streaming server into its cache, and says when it is done. ES5. */
var Dl = (function () {
  var jobs = [], timer = null, told = {}, listeners = [];
  function title(x) { return (x.name || x.imdb) + (x.sub ? ' ' + x.sub : ''); }
  function announce() {
    jobs.forEach(function (x) {
      if (x.notified || told[x.id]) return;
      if (x.status === 'ready') { told[x.id] = 1; Views.toast('Ready to watch: ' + title(x), 9000); Backend.call('POST', '/api/downloads/' + x.id + '/notified', {}).catch(function () {}); }
      else if (x.status === 'failed') { told[x.id] = 1; Views.toast('Download failed: ' + title(x) + (x.error ? ' (' + x.error + ')' : ''), 9000); Backend.call('POST', '/api/downloads/' + x.id + '/notified', {}).catch(function () {}); }
    });
  }
  function refresh() {
    if (!Backend.token()) return Promise.resolve(jobs);
    return Backend.call('GET', '/api/downloads', undefined, undefined, 10000).then(function (j) {
      jobs = j.jobs || []; announce(); listeners.forEach(function (f) { try { f(jobs); } catch (e) {} }); return jobs;
    }).catch(function () { return jobs; });
  }
  function start() { stop(); refresh(); timer = setInterval(refresh, 20000); }
  function stop() { clearInterval(timer); timer = null; jobs = []; told = {}; }
  function pct(x) { return x.size ? Math.min(100, Math.floor(x.bytes / x.size * 100)) : 0; }
  function fmtBytes(n) { n = +n || 0; return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? Math.round(n / 1048576) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function state(x) {
    if (x.status === 'ready') return 'Ready to watch';
    if (x.status === 'failed') return 'Failed' + (x.error ? ' (' + x.error + ')' : '');
    if (x.status === 'queued') return 'Waiting';
    return 'Downloading ' + pct(x) + '%' + (x.speed ? ' (' + fmtBytes(x.speed) + '/s)' : '');
  }
  return {
    start: start, stop: stop, refresh: refresh, jobs: function () { return jobs; }, title: title, state: state, pct: pct, fmtBytes: fmtBytes,
    onChange: function (f) { listeners.push(f); },
    forVideo: function (videoId) { var r = null; jobs.forEach(function (x) { if (x.videoId === videoId && (!r || x.created > r.created)) r = x; }); return r; },
    ready: function () { return jobs.filter(function (x) { return x.status === 'ready'; }).sort(function (a, b) { return b.done - a.done; }); },
    add: function (body) { return Backend.call('POST', '/api/downloads', body, undefined, 20000); },
    remove: function (id) { return Backend.call('DELETE', '/api/downloads/' + id).then(refresh); }
  };
})();
