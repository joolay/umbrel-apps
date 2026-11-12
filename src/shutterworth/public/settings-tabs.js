// Settings tabs: Account, Inventory, Data, and Admin (AI key, users, ads, sign-up rules).
// Other scripts add their panels to #setView at their own pace, so panels are sorted into tabs as they appear.
(() => {
  "use strict";
  const KEY = "sw.setTab";
  const TABS = [
    { id: "account", label: "Account" },
    { id: "inventory", label: "Inventory" },
    { id: "data", label: "Data" },
    { id: "admin", label: "Admin" },
  ];
  const ADMIN_IDS = new Set(["aiPanel", "swUsersPanel", "swAdsPanel"]);

  const css = document.createElement("style");
  css.textContent = `
#swTabs{position:sticky;top:calc(env(safe-area-inset-top,0px) + var(--hh,0px));z-index:4;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;background:var(--bg);padding:8px 0;margin:-8px 0 6px;box-shadow:0 1px 0 var(--line)}
#swTabs::-webkit-scrollbar{display:none}
#swTabs button{flex:none;font:inherit;font-weight:600;font-size:.9rem;border:1px solid var(--line);background:var(--paper);color:var(--muted);border-radius:999px;padding:8px 16px;cursor:pointer;min-height:40px}
#swTabs button[aria-selected="true"]{background:var(--forest,#145f4f);border-color:var(--forest,#145f4f);color:var(--cream,#f8f4ea)}
#swTabs button:focus-visible{outline:2px solid var(--gold,#d9ab55);outline-offset:2px}
#setView[data-tab="account"] .panel:not([data-tab="account"]),
#setView[data-tab="inventory"] .panel:not([data-tab="inventory"]),
#setView[data-tab="data"] .panel:not([data-tab="data"]),
#setView[data-tab="admin"] .panel:not([data-tab="admin"]){display:none}
`;
  document.head.appendChild(css);

  const view = document.getElementById("setView");
  if (!view) return;
  const bar = document.createElement("div");
  bar.id = "swTabs"; bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "Settings sections");
  view.insertBefore(bar, view.firstChild);

  let accountsOn = false, current = "";
  try { current = sessionStorage.getItem(KEY) || ""; } catch (e) {}

  function tabFor(p) {
    if (ADMIN_IDS.has(p.id)) return "admin";
    if (p.id === "swAccountPanel") return "account";
    if (p.id === "swStorePanel" || p.querySelector("#bkList")) return "data";
    if (p.querySelector(".rates")) return "inventory";
    return "data";
  }
  // Admin tab: always there when accounts are off (the owner is the only user); with accounts on, only admins see it.
  const adminVisible = () => !accountsOn || !!document.getElementById("swUsersPanel");
  const visibleTabs = () => TABS.filter(t => (t.id === "account" ? accountsOn : t.id === "admin" ? adminVisible() : true));

  function paint() {
    const tabs = visibleTabs();
    if (!tabs.some(t => t.id === current)) current = tabs[0].id;
    view.dataset.tab = current;
    bar.textContent = "";
    for (const t of tabs) {
      const b = document.createElement("button");
      b.type = "button"; b.role = "tab"; b.textContent = t.label; b.setAttribute("aria-selected", String(t.id === current));
      b.onclick = () => { current = t.id; try { sessionStorage.setItem(KEY, current); } catch (e) {} paint(); window.scrollTo(0, 0); };
      bar.appendChild(b);
    }
  }
  function sort() {
    if (view.firstChild !== bar) view.insertBefore(bar, view.firstChild); // other scripts add panels above it
    for (const p of view.querySelectorAll(":scope > .panel")) { const t = tabFor(p); if (p.dataset.tab !== t) p.dataset.tab = t; }
    paint();
  }

  new MutationObserver(sort).observe(view, { childList: true });
  fetch("api/app-config", { cache: "no-store" }).then(r => r.json()).then(c => { accountsOn = !!c.accounts; sort(); }).catch(() => sort());
  sort();
})();
