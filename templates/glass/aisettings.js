/* AI choice for one app (Settings screen). JZAI.mount(el, { url: "api/ai/choice" }) draws a drop-down that picks where this app's AI comes from:
   the default (the Master key during the free trial, then the key a parent shares with the family, or the person's own default), the Master key with a model,
   or one of the person's own saved keys (any provider) with a model from that provider. Keys are managed in Portal Admin; only labels and last 4 characters are shown here.
   The app's server answers GET url, POST url { id, model } and GET url/models?id= by passing them to Portal API (ai.mine / ai.choose / ai.models). */
(function () {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function j(url, body) {
    return fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" } : { credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.message || "That did not work."); return d; }); });
  }
  function mount(el, o) {
    var url = (o && o.url) || "api/ai/choice";
    if (!el) return;
    el.innerHTML = '<p class="muted small">Loading AI settings…</p>';
    j(url).then(function (st) {
      var master = st.master && st.master.set, fam = st.family && st.family.shared;
      var defTxt = fam ? "Default (" + esc(fam.byName) + "\u2019s family key)" : master ? "Default (free trial on the Master key)" : "Default";
      var opts = '<option value="">' + defTxt + "</option>" + (master ? '<option value="master"' + (st.choice === "master" ? " selected" : "") + ">Master key · " + esc(st.master.providerLabel) + "</option>" : "") +
        (st.keys || []).map(function (k) { return '<option value="' + esc(k.id) + '"' + (st.choice === k.id ? " selected" : "") + ">" + esc(k.label) + " · " + esc((st.providers[k.provider] || {}).label || k.provider) + "</option>"; }).join("");
      el.innerHTML = '<label>AI provider for this app<select data-jzai="key">' + opts + '</select></label>' +
        '<label data-jzai-m' + (st.choice ? "" : " hidden") + '>Model<select data-jzai="model"><option value="">' + esc(st.model || "The key’s own model") + "</option></select></label>" +
        '<p class="muted small">Add or remove keys, set a Master key and share one with your family in Portal Admin › My settings › AI.</p><p class="error" data-jzai="err"></p>';
      var ks = el.querySelector('[data-jzai=key]'), ms = el.querySelector('[data-jzai=model]'), box = el.querySelector("[data-jzai-m]"), err = el.querySelector('[data-jzai=err]'), loaded = "";
      var fail = function (e) { err.textContent = e.message || "That did not work."; };
      var save = function () { err.textContent = ""; return j(url, { id: ks.value, model: ms.value || "" }).catch(fail); };
      function load() {
        if (!ks.value || loaded === ks.value) return; var id = ks.value; loaded = id;
        j(url + "/models?id=" + encodeURIComponent(id)).then(function (r) { var cur = ms.value || st.model || r.current; ms.innerHTML = r.models.map(function (m) { return "<option" + (m === cur ? " selected" : "") + ">" + esc(m) + "</option>"; }).join(""); }).catch(function (e) { loaded = ""; fail(e); });
      }
      ks.onchange = function () { box.hidden = !ks.value; ms.innerHTML = '<option value=""></option>'; st.model = ""; loaded = ""; save().then(load); };
      ms.onfocus = ms.onmousedown = load; ms.onchange = save;
    }).catch(function (e) { el.innerHTML = '<p class="muted small">' + esc(e.message) + "</p>"; });
  }
  window.JZAI = { mount: mount };
})();
