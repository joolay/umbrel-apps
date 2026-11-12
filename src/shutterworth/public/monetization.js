// ShutterWorth ads + "Remove ads" purchase.
//
// One place for everything money-related, so moving to Android means switching
// the provider, not rewriting the app.
//   - On the web (now): a dummy banner and a simulated purchase, for test audiences.
//   - In the Android app (later, wrapped with Capacitor): real AdMob banners and a
//     Google Play Billing one-time purchase. See AndroidProvider below.
//
// Who controls what:
//   - Admin (hidden; tap the "Settings" title 7 times): turn ads on/off for everyone
//     using this server, and switch test/live ads. Stored in the "settings/ads" doc.
//   - Each user: "Remove ads" purchase, remembered on their own device (on Android,
//     Google Play remembers it on their Google account).
(function () {
  "use strict";

  const CONFIG = {
    admobAppId: "ca-app-pub-8729825432640121~3634597366",   // goes in AndroidManifest.xml
    bannerLive: "ca-app-pub-8729825432640121/8639899077",
    bannerTest: "ca-app-pub-3940256099942544/6300978111",    // Google's public test banner
    removeAdsProduct: "remove_ads",                          // create this product in Play Console
    displayPrice: "R 29.99",                                 // web dummy only; Android shows Play's price
    adminTaps: 7,
  };
  const LS = { removed: "sw.ads.removed", admin: "sw.ads.admin" };
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const $ = id => document.getElementById(id);

  // ---------- state ----------
  let server = { enabled: true, testMode: true };   // admin settings, shared by all users of this server
  let removed = lsGet(LS.removed) === "1";           // this device's purchase
  let admin = lsGet(LS.admin) === "1";
  let db = null;

  const shouldShow = () => server.enabled && !removed;

  // ---------- providers ----------
  const WebDummyProvider = {
    name: "web",
    async init() {},
    async showBanner() { $("swAd").hidden = false; document.body.classList.add("has-ad"); rotateDummy(); },
    async hideBanner() { $("swAd").hidden = true; document.body.classList.remove("has-ad"); },
    async price() { return CONFIG.displayPrice; },
    purchase() {   // in-page sheet (no confirm(): embedded pages may block browser pop-ups)
      return new Promise(resolve => {
        const d = document.createElement("dialog"); d.id = "swBuySheet";
        d.innerHTML = `<div class="dlg" style="padding:16px;gap:12px"><b style="font-size:1.05rem">Remove ads</b>
          <p style="margin:0;color:var(--muted);font-size:.9rem">One-time purchase of ${CONFIG.displayPrice}. This is a test: no money is charged. In the Android app this opens Google Play.</p>
          <div class="prow"><button class="pbtn accent" type="button" data-a="1">Buy (test)</button><button class="pbtn" type="button" data-a="0">Cancel</button></div></div>`;
        document.body.appendChild(d);
        const done = v => { d.close(); d.remove(); resolve(v); };
        d.addEventListener("click", e => { const b = e.target.closest("[data-a]"); if (b) done(b.dataset.a === "1"); else if (e.target === d) done(false); });
        d.addEventListener("cancel", () => done(false));
        d.showModal ? d.showModal() : d.setAttribute("open", "");
      });
    },
    async restore() { return removed; },
  };

  // Used automatically when running inside the Capacitor Android app.
  // Needs: @capacitor-community/admob and cordova-plugin-purchase (CdvPurchase).
  // Check both plugins' current docs when wiring this up; the calls below follow their APIs.
  const AndroidProvider = {
    name: "android",
    async init() {
      const AdMob = window.Capacitor.Plugins.AdMob;
      await AdMob.initialize({ initializeForTesting: server.testMode });
      const store = window.CdvPurchase && window.CdvPurchase.store;
      if (store) {
        const { ProductType, Platform } = window.CdvPurchase;
        store.register([{ id: CONFIG.removeAdsProduct, type: ProductType.NON_CONSUMABLE, platform: Platform.GOOGLE_PLAY }]);
        store.when().approved(t => t.verify()).verified(r => r.finish()).finished(() => setRemoved(true));
        await store.initialize([Platform.GOOGLE_PLAY]);
        if (store.owned(CONFIG.removeAdsProduct)) setRemoved(true);
      }
    },
    async showBanner() {
      await window.Capacitor.Plugins.AdMob.showBanner({
        adId: server.testMode ? CONFIG.bannerTest : CONFIG.bannerLive,
        adSize: "ADAPTIVE_BANNER", position: "BOTTOM_CENTER", margin: 0, isTesting: server.testMode,
      });
      document.body.classList.add("has-ad");
    },
    async hideBanner() { await window.Capacitor.Plugins.AdMob.hideBanner().catch(() => {}); document.body.classList.remove("has-ad"); },
    async price() { const p = window.CdvPurchase?.store.get(CONFIG.removeAdsProduct); return p?.pricing?.price || ""; },
    async purchase() {
      const p = window.CdvPurchase?.store.get(CONFIG.removeAdsProduct);
      if (!p) throw new Error("Store not ready");
      await p.getOffer().order();   // success arrives via store.when().finished() → setRemoved(true)
      return false;
    },
    async restore() { await window.CdvPurchase?.store.restorePurchases(); return window.CdvPurchase?.store.owned(CONFIG.removeAdsProduct) || false; },
  };

  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const provider = isNative ? AndroidProvider : WebDummyProvider;

  // ---------- dummy banner ----------
  const DUMMIES = [
    ["Sample ad", "Real ads from Google appear here in the Android app"],
    ["Your brand here", "320 × 50 banner · tap Remove ads to hide"],
    ["Test advertiser", "Ads keep ShutterWorth free"],
  ];
  let dummyIx = 0, dummyTimer = null;
  function rotateDummy() {
    const d = DUMMIES[dummyIx++ % DUMMIES.length];
    $("swAdTitle").textContent = d[0]; $("swAdSub").textContent = d[1];
    clearTimeout(dummyTimer); dummyTimer = setTimeout(() => { if (!$("swAd").hidden) rotateDummy(); }, 30000);
  }

  // ---------- apply ----------
  async function apply() {
    try { shouldShow() ? await provider.showBanner() : await provider.hideBanner(); } catch (e) { console.warn("ads:", e); }
    renderPanel();
  }
  function setRemoved(v) { removed = !!v; lsSet(LS.removed, removed ? "1" : null); apply(); }

  async function buy() {
    try {
      if (await provider.purchase()) { setRemoved(true); note("Thanks! Ads are removed on this device."); }
    } catch (e) { note("Purchase didn't go through: " + (e.message || e), true); }
  }
  async function restore() {
    try { const owned = await provider.restore(); if (owned) setRemoved(true); note(owned ? "Purchase restored." : "No purchase found."); }
    catch (e) { note("Couldn't restore: " + (e.message || e), true); }
  }
  async function saveServer(patch) {
    server = { ...server, ...patch };
    apply();
    try { await db.doc("settings/ads").set(server); } catch (e) { note("Couldn't save: " + (e.message || e.code), true); }
  }

  // ---------- UI ----------
  function note(t, bad) { const n = $("swAdsNote"); if (!n) return; n.textContent = t; n.style.color = bad ? "var(--danger)" : ""; }

  function buildUI() {
    const css = document.createElement("style");
    css.textContent = `
#swAd{position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--paper);border-top:1px solid var(--line);padding:6px max(12px,env(safe-area-inset-left,0px)) calc(6px + env(safe-area-inset-bottom,0px));display:flex;justify-content:center}
#swAd .in{display:flex;align-items:center;gap:10px;width:100%;max-width:728px;height:50px}
#swAd .box{flex:1;min-width:0;height:100%;border:1px dashed var(--line);border-radius:6px;background:var(--bg);display:flex;align-items:center;gap:8px;padding:0 10px}
#swAd .lbl{font:600 .6rem var(--mono);letter-spacing:.06em;text-transform:uppercase;background:#f5c518;color:#222;border-radius:3px;padding:1px 4px;flex:none}
#swAd .tx{min-width:0;display:flex;flex-direction:column;line-height:1.2}
#swAd .tx b{font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#swAd .tx span{font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#swAd .rm{flex:none;height:32px;font-size:.75rem;padding:0 10px}
body.has-ad main .wrap{padding-bottom:110px}
.swadmin{border-top:1px dashed var(--line);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.swadmin h3{margin:0;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--warn)}`;
    document.head.appendChild(css);

    const bar = document.createElement("div");
    bar.id = "swAd"; bar.hidden = true; bar.setAttribute("role", "complementary"); bar.setAttribute("aria-label", "Advertisement");
    bar.innerHTML = `<div class="in"><div class="box"><span class="lbl">Ad</span><div class="tx"><b id="swAdTitle"></b><span id="swAdSub"></span></div></div><button class="pbtn rm" id="swAdRemove" type="button">Remove ads</button></div>`;
    document.body.appendChild(bar);
    $("swAdRemove").onclick = buy;

    const panel = document.createElement("div");
    panel.className = "panel"; panel.id = "swAdsPanel";
    panel.innerHTML = `<h2>Ads</h2><p id="swAdsStatus"></p>
      <div class="prow"><button class="pbtn accent" id="swBuy" type="button">Remove ads</button><button class="pbtn" id="swRestore" type="button">Restore purchase</button><span class="count" id="swAdsNote"></span></div>
      <div class="swadmin" id="swAdmin" hidden><h3>Admin · testing</h3>
        <label class="toggle"><input type="checkbox" id="swEnabled"> Show ads to everyone on this server</label>
        <label class="toggle"><input type="checkbox" id="swTest"> Use test ads (Android app)</label>
        <div class="prow"><button class="pbtn" id="swReset" type="button">Undo this device's purchase</button><button class="pbtn" id="swLock" type="button">Hide admin</button></div>
      </div>`;
    const setView = $("setView");
    setView.insertBefore(panel, setView.querySelector(".panel:not(#aiPanel)") || null);
    $("swBuy").onclick = buy;
    $("swRestore").onclick = restore;
    $("swEnabled").onchange = e => saveServer({ enabled: e.target.checked });
    $("swTest").onchange = e => saveServer({ testMode: e.target.checked });
    $("swReset").onclick = () => { setRemoved(false); note("Purchase undone on this device."); };
    $("swLock").onclick = () => { admin = false; lsSet(LS.admin, null); renderPanel(); };

    // hidden admin unlock: tap the Settings title 7 times within a few seconds
    let taps = 0, tapTimer = null;
    $("setTitle").addEventListener("click", () => {
      taps++; clearTimeout(tapTimer); tapTimer = setTimeout(() => { taps = 0; }, 3000);
      if (taps >= CONFIG.adminTaps) { taps = 0; admin = !admin; lsSet(LS.admin, admin ? "1" : null); renderPanel(); note(admin ? "Admin controls on." : "Admin controls hidden."); }
    });
  }

  async function renderPanel() {
    if (!$("swAdsPanel")) return;
    $("swAdsStatus").textContent =
      !server.enabled ? "Ads are switched off for everyone right now." :
      removed ? "Ads are removed on this device. Thank you for your support." :
      "A small banner helps keep ShutterWorth free. Remove it with a one-time purchase.";
    $("swBuy").hidden = removed || !server.enabled;
    const price = await provider.price().catch(() => "");
    $("swBuy").textContent = price ? `Remove ads · ${price}` : "Remove ads";
    $("swAdmin").hidden = !admin;
    $("swEnabled").checked = server.enabled;
    $("swTest").checked = server.testMode;
  }

  // ---------- start ----------
  async function start() {
    // Ads are disabled on the web version: no banner, no Ads panel, no admin toggle.
    // The Android app (Capacitor) still runs the full AdMob + remove-ads flow.
    if (!isNative) return;
    buildUI();
    db = await window.claude.use("db");
    let inited = false;
    db.doc("settings/ads").onSnapshot(async d => {
      if (d.exists) { const v = d.data(); server = { enabled: v.enabled !== false, testMode: v.testMode !== false }; }
      if (!inited) { inited = true; try { await provider.init(); } catch (e) { console.warn("ads init:", e); } }
      apply();
    }, () => apply());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  window.ShutterAds = { config: CONFIG, provider: () => provider.name, removeAds: buy, restore };
})();
