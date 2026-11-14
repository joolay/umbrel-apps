// Settings → AI photo identification panel.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  let cfg = null, wasConfigured = false;
  const tok = () => { try { const t = (localStorage.getItem("sw.token") || sessionStorage.getItem("sw.token")); return t ? { "x-sw-token": t } : {}; } catch (e) { return {}; } };

  function note(t, bad) { const n = $("aiNote"); n.textContent = t; n.style.color = bad ? "#b42318" : ""; }
  function presetFor(p) { return (cfg && cfg.presets && cfg.presets[p]) || {}; }

  function fill() {
    $("aiProvider").value = cfg.provider;
    $("aiKey").value = "";
    $("aiKey").placeholder = cfg.hasKey ? "Saved key " + cfg.keyHint + " (leave blank to keep)" : "Paste your API key";
    $("aiUrl").value = cfg.baseUrl || "";
    $("aiModel").value = cfg.model || "";
    $("aiQuick").value = cfg.quickModel || "";
    syncProvider(false);
  }
  function syncProvider(applyPreset) {
    const p = $("aiProvider").value, pre = presetFor(p);
    $("aiUrlRow").hidden = p === "anthropic";
    $("aiUrl").placeholder = pre.baseUrl || "";
    $("aiModel").placeholder = pre.model || "Model name";
    if (applyPreset) { $("aiUrl").value = pre.baseUrl || ""; $("aiModel").value = pre.model || ""; $("aiQuick").value = pre.quickModel || ""; }
  }

  async function load() {
    try {
      cfg = await fetch("api/ai/config", { cache: "no-store", headers: tok() }).then(r => r.json());
      wasConfigured = !!(cfg.model && (cfg.hasKey || cfg.provider === "openai"));
      fill();
      note(wasConfigured ? "Photo identification is on." : "Add a key to turn on photo identification.");
    } catch (e) { note("Couldn't load AI settings.", true); }
  }

  async function save() {
    const body = { provider: $("aiProvider").value, apiKey: $("aiKey").value, baseUrl: $("aiUrl").value, model: $("aiModel").value, quickModel: $("aiQuick").value };
    if (body.provider === "anthropic") body.baseUrl = presetFor("anthropic").baseUrl;
    try {
      const r = await fetch("api/ai/config", { method: "POST", headers: { "content-type": "application/json", ...tok() }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      cfg = await r.json(); fill();
      const now = !!(cfg.model && (cfg.hasKey || cfg.provider === "openai"));
      if (now && !wasConfigured) { note("Saved. Reloading to turn on photo identification…"); setTimeout(() => location.reload(), 900); }
      else note("Saved.");
      wasConfigured = now;
    } catch (e) { note("Couldn't save: " + e.message, true); }
  }

  async function test() {
    note("Testing…");
    try {
      const r = await fetch("api/ai", { method: "POST", headers: { "content-type": "application/json", ...tok() },
        body: JSON.stringify({ prompt: 'Reply with JSON only: {"ok":true}', images: [] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.code);
      note(j.result && j.result.ok ? "Connection works." : "Connected, but the reply was unexpected.");
    } catch (e) { note("Test failed: " + e.message, true); }
  }

  $("aiProvider").addEventListener("change", () => syncProvider(true));
  $("aiSave").addEventListener("click", save);
  $("aiTest").addEventListener("click", test);
  $("setBtn").addEventListener("click", load);
  load();
})();
