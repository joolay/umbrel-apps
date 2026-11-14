// Settings → Account (sign in, trial) and, for admins, Settings → Users (edit, delete, trial and unlimited access).
// Only active when the server has accounts switched on (see POCKETBASE_URL in docker-compose.yml).
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const TOKEN = "sw.token";
  // Remember me on: localStorage. Off: sessionStorage (gone when the browser closes).
  const getToken = () => { try { return localStorage.getItem(TOKEN) || sessionStorage.getItem(TOKEN) || ""; } catch (e) { return ""; } };
  const setToken = (t, remember) => { try { localStorage.removeItem(TOKEN); sessionStorage.removeItem(TOKEN); if (t) (remember === false ? sessionStorage : localStorage).setItem(TOKEN, t); } catch (e) {} };

  // If the sign-in runs out while the app is open, go back to the sign-in page.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await nativeFetch(input, init);
    try {
      const u = typeof input === "string" ? input : (input && input.url) || "";
      if ((r.status === 401 || r.status === 403) && /\/api\/(docs|write|assets|ai\/status)|\/_blob\//.test(u)) {
        const c = await r.clone().json().catch(() => ({}));
        if ((c.code === "signin_required" || c.code === "no_access") && !window.__swReload) { window.__swReload = 1; location.reload(); }
      }
    } catch (e) {}
    return r;
  };

  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json", ...(getToken() ? { "x-sw-token": getToken() } : {}) };
    const r = await fetch(path, { cache: "no-store", ...opts, headers });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || "Something went wrong (" + r.status + ")"); e.code = j.code; e.status = r.status; throw e; }
    return j;
  }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  let cfg = null, user = null, accountPanel = null, adminPanel = null, mode = "in";

  const CSS = `
.acct form{display:grid;gap:8px}
.acct label,.udlg label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;font-weight:600}
.acct input,.udlg input[type=text],.udlg input[type=email],.udlg input[type=password],.udlg input[type=number],.usearch input{font:inherit;font-size:16px;font-weight:400;height:40px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);min-width:0;width:100%}
.acct input:focus,.udlg input:focus,.usearch input:focus{outline:2px solid var(--accent);outline-offset:1px}
.acct .err,.udlg .err{color:var(--danger);font-size:.85rem;min-height:1.2em;margin:0}
.acct .link{border:0;background:none;color:var(--accent);font:inherit;font-weight:600;padding:6px 0;cursor:pointer;text-align:left}
.meter{height:8px;border-radius:99px;background:var(--accent-soft);overflow:hidden}
.meter i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--gold-pale,#f1d28a),var(--gold,#d9ab55))}
.ulist{display:flex;flex-direction:column;gap:8px}
.urow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;align-items:center;border-top:1px solid var(--line);padding-top:10px}
.urow:first-child{border-top:0;padding-top:0}
.uwho{min-width:0;display:flex;flex-direction:column}
.uwho b{font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uwho span{font-size:.78rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ubadges{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:.72rem}
.ubadge{border-radius:99px;padding:1px 8px;font-weight:700;background:var(--accent-soft);color:var(--accent)}
.ubadge.gold{background:#f6e7bf;color:#6b4a0e}
:root[data-theme="dark"] .ubadge.gold{background:#3b2f12;color:#e6c274}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ubadge.gold{background:#3b2f12;color:#e6c274}}
.utrial{font-family:var(--mono);color:var(--muted)}
.uacts{grid-column:1 / -1;display:flex;gap:6px;flex-wrap:wrap}
.uacts .pbtn{height:32px;padding:0 12px;font-size:.78rem}
.usearch{display:flex;gap:8px;align-items:center}
.udlg{display:flex;flex-direction:column;gap:10px;padding:16px}
.udlg h2{margin:0;font-family:var(--display);font-stretch:90%;font-size:1.15rem}
.udlg .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.udlg .hint2{font-size:.76rem;color:var(--muted);font-weight:400}
.udlg .tg{flex-direction:row;align-items:center;gap:10px;font-weight:500;font-size:.9rem}
.udlg .tg input{width:18px;height:18px;accent-color:var(--accent)}
`;

  function mount(panel, first) {
    const setView = $("setView");
    if (first) setView.insertBefore(panel, setView.firstChild); else setView.appendChild(panel);
  }

  /* ---------- account panel ---------- */
  function trialText(t) {
    if (t.unlimited) return "Unlimited photo identification.";
    return `${t.remaining} of ${t.limit} free photo identifications left.`;
  }
  function renderAccount() {
    const p = accountPanel; p.textContent = "";
    p.appendChild(el("h2", "", "JoolzApp account"));
    if (user) {
      p.appendChild(el("p", "", "Signed in as " + (user.name ? user.name + " (" + user.email + ")" : user.email) + (user.isAdmin ? " · admin" : "") + "."));
      p.appendChild(el("p", "", trialText(user.trial)));
      if (!user.trial.unlimited && user.trial.limit > 0) {
        const m = el("div", "meter"), i = el("i"); i.style.width = Math.min(100, Math.round(100 * user.trial.used / user.trial.limit)) + "%"; m.appendChild(i); p.appendChild(m);
      }
      const row = el("div", "prow"), out = el("button", "pbtn", "Sign out"); out.type = "button";
      out.onclick = () => { setToken(""); fetch("api/account/logout", { method: "POST" }).catch(() => {}).then(() => location.reload()); };
      row.appendChild(out); p.appendChild(row);
      return;
    }
    if (mode === "forgot") {
      p.appendChild(el("p", "", "Enter your email and we'll send a link to reset your password."));
      const f = el("form"); f.noValidate = true;
      const l = el("label", "", "Email"), em = el("input"); em.type = "email"; em.name = "email"; em.autocomplete = "email"; l.appendChild(em); f.appendChild(l);
      const msg = el("p", "err"); msg.setAttribute("role", "alert");
      const go = el("button", "pbtn accent", "Email me a reset link"); go.type = "submit"; go.style.height = "42px";
      const back = el("button", "link", "Back to sign in"); back.type = "button"; back.onclick = () => { mode = "in"; renderAccount(); };
      f.append(msg, go, back);
      f.onsubmit = async ev => {
        ev.preventDefault(); msg.className = "err"; msg.textContent = ""; go.disabled = true;
        try { await api("api/account/forgot", { method: "POST", body: JSON.stringify({ email: em.value }) }); msg.className = ""; msg.textContent = "If that email has a JoolzApp account, a reset link is on its way."; }
        catch (e) { msg.textContent = e.message; }
        go.disabled = false;
      };
      p.appendChild(f); return;
    }
    const reg = mode === "up";
    p.appendChild(el("p", "", reg
      ? `Create your JoolzApp account to use photo identification. One account works in all JoolzApp apps. You get ${cfg.trialLimit} free photo identifications to start.`
      : "Sign in with your JoolzApp account to use photo identification."));
    if (reg && cfg.signups === false) { p.appendChild(el("p", "err", "New sign-ups are closed right now.")); }
    const f = el("form"); f.noValidate = true;
    const field = (label, type, name, auto) => { const l = el("label", "", label), i = el("input"); i.type = type; i.name = name; i.autocomplete = auto; l.appendChild(i); f.appendChild(l); return i; };
    const name = reg ? field("Name (optional)", "text", "name", "name") : null;
    const email = field("Email", "email", "email", "email"), pass = field("Password", "password", "password", reg ? "new-password" : "current-password");
    if (reg) pass.placeholder = "At least 8 characters";
    const rem = el("input"); rem.type = "checkbox"; rem.checked = true; rem.style.cssText = "width:auto;margin-right:6px";
    const remL = el("label", ""); remL.style.cssText = "display:flex;align-items:center;flex-direction:row"; remL.append(rem, document.createTextNode("Remember me")); f.appendChild(remL);
    const err = el("p", "err"); err.setAttribute("role", "alert");
    const go = el("button", "pbtn accent", reg ? "Create account" : "Sign in"); go.type = "submit"; go.style.height = "42px";
    const sw = el("button", "link", reg ? "I already have a JoolzApp account" : "Create a JoolzApp account"); sw.type = "button";
    sw.onclick = () => { mode = reg ? "in" : "up"; renderAccount(); };
    f.append(err, go, sw);
    if (!reg) { const fg = el("button", "link", "Forgot password?"); fg.type = "button"; fg.onclick = () => { mode = "forgot"; renderAccount(); }; f.appendChild(fg); }
    f.onsubmit = async ev => {
      ev.preventDefault(); err.textContent = ""; go.disabled = true;
      try {
        const j = await api(reg ? "api/account/register" : "api/account/login", { method: "POST", body: JSON.stringify({ email: email.value, password: pass.value, name: name ? name.value : "", remember: rem.checked }) });
        setToken(j.token, rem.checked); location.reload();
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    };
    p.appendChild(f);
  }

  /* ---------- admin: users ---------- */
  let users = [], settings = { trialLimit: 10, signups: true }, meId = "", query = "", listBox = null, countEl = null, noteEl = null;

  function note(t, bad) { if (!noteEl) return; noteEl.textContent = t || ""; noteEl.style.color = bad ? "var(--danger)" : ""; }

  async function loadUsers() {
    try {
      const j = await api("api/admin/users" + (query ? "?q=" + encodeURIComponent(query) : ""));
      users = j.users; settings = j.settings; meId = j.me;
      $("swTrialLimit").value = settings.trialLimit; $("swSignups").checked = settings.signups;
      renderUsers(); note("");
    } catch (e) { note(e.message, true); }
  }

  function userRow(u) {
    const r = el("div", "urow");
    const who = el("div", "uwho"); who.append(el("b", "", u.name || u.email), el("span", "", u.name ? u.email : "No name"));
    const badges = el("div", "ubadges");
    if (u.isAdmin) badges.appendChild(el("span", "ubadge", "Admin"));
    if (u.unlimited) badges.appendChild(el("span", "ubadge gold", "Unlimited"));
    if (!u.isAdmin && !u.access) badges.appendChild(el("span", "ubadge", "No inventory access"));
    badges.appendChild(el("span", "utrial", u.trial.unlimited ? "no limit" : `${u.trial.used} of ${u.trial.limit} used`));
    r.append(who, badges);
    const acts = el("div", "uacts");
    const edit = el("button", "pbtn", "Edit"); edit.type = "button"; edit.onclick = () => openEdit(u);
    const reset = el("button", "pbtn", "Reset trial"); reset.type = "button"; reset.disabled = u.trial.used === 0;
    reset.onclick = () => patch(u, { resetTrial: true }, `Reset the trial for ${u.email}.`);
    const unl = el("button", "pbtn", u.unlimited ? "Remove unlimited" : "Allow unlimited"); unl.type = "button";
    unl.onclick = () => patch(u, { unlimited: !u.unlimited }, u.unlimited ? `${u.email} is back on the trial.` : `${u.email} can now use your key without a limit.`);
    const acc = el("button", "pbtn", u.access ? "Remove access" : "Allow access"); acc.type = "button"; acc.disabled = u.isAdmin;
    acc.onclick = () => patch(u, { access: !u.access }, u.access ? `${u.email} can no longer open the inventory.` : `${u.email} can now open the inventory.`);
    const del = el("button", "pbtn", "Delete"); del.type = "button"; del.disabled = u.id === meId;
    let t = null;
    del.onclick = async () => {
      if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Tap again to delete"; clearTimeout(t); t = setTimeout(() => { del.classList.remove("confirm"); del.textContent = "Delete"; }, 3500); return; }
      try { await api("api/admin/users/" + u.id, { method: "DELETE" }); note(`Deleted ${u.email}.`); await loadUsers(); } catch (e) { note(e.message, true); }
    };
    acts.append(edit, reset, unl, acc, del);
    r.appendChild(acts);
    return r;
  }
  function renderUsers() {
    listBox.textContent = "";
    countEl.textContent = users.length + (users.length === 1 ? " user" : " users");
    if (!users.length) { listBox.appendChild(el("p", "", query ? "No users match that search." : "No one has signed up yet.")); return; }
    users.forEach(u => listBox.appendChild(userRow(u)));
  }
  async function patch(u, data, okMsg) {
    try { await api("api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify(data) }); note(okMsg); await loadUsers(); }
    catch (e) { note(e.message, true); throw e; }
  }

  let dlg = null;
  function openEdit(u) {
    if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "swUserDlg"; document.body.appendChild(dlg); dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); }); }
    dlg.textContent = "";
    const f = el("form", "udlg"); f.noValidate = true; f.method = "dialog";
    f.appendChild(el("h2", "", "Edit user"));
    const input = (label, type, value, extra) => { const l = el("label", "", label), i = el("input"); i.type = type; i.value = value; if (extra) Object.assign(i, extra); l.appendChild(i); f.appendChild(l); return i; };
    const name = input("Name", "text", u.name, { maxLength: 80, autocomplete: "off" });
    const email = input("Email", "email", u.email, { autocomplete: "off" });
    const pass = input("New password", "password", "", { autocomplete: "new-password", placeholder: "Leave blank to keep the current one" });
    const row = el("div", "row2");
    const mk = (label, value, hint) => { const l = el("label", "", label), i = el("input"); i.type = "number"; i.min = "0"; i.inputMode = "numeric"; i.value = value; l.appendChild(i); if (hint) l.appendChild(el("span", "hint2", hint)); row.appendChild(l); return i; };
    const limit = mk("Trial limit", u.trialLimit, `0 uses the default (${settings.trialLimit})`);
    const used = mk("Used so far", u.trialUsed);
    f.appendChild(row);
    const tg = (label, on) => { const l = el("label", "tg"), i = el("input"); i.type = "checkbox"; i.checked = on; l.append(i, document.createTextNode(label)); f.appendChild(l); return i; };
    const acc = tg("Can open this inventory (admins always can)", u.access); if (u.isAdmin) acc.disabled = true;
    const unl = tg("Allow unlimited use of my API key", u.unlimited);
    const adm = tg("Admin", u.isAdmin); if (u.id === meId) { adm.disabled = true; }
    const err = el("p", "err"); err.setAttribute("role", "alert"); f.appendChild(err);
    const btns = el("div", "prow"), save = el("button", "pbtn accent", "Save changes"), cancel = el("button", "pbtn", "Cancel");
    save.type = "submit"; cancel.type = "button"; cancel.onclick = () => dlg.close(); btns.append(save, cancel); f.appendChild(btns);
    f.onsubmit = async ev => {
      ev.preventDefault(); err.textContent = ""; save.disabled = true;
      const data = { name: name.value, email: email.value, unlimited: unl.checked, access: acc.checked, trialLimit: limit.value, trialUsed: used.value };
      if (u.id !== meId) data.isAdmin = adm.checked;
      if (pass.value) data.password = pass.value;
      try { await api("api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify(data) }); dlg.close(); note("Saved " + (email.value || u.email) + "."); await loadUsers(); }
      catch (e) { err.textContent = e.message; save.disabled = false; }
    };
    dlg.appendChild(f); dlg.showModal();
  }

  function buildAdmin() {
    const p = adminPanel = el("div", "panel"); p.id = "swUsersPanel";
    p.appendChild(el("h2", "", "Users"));
    p.appendChild(el("p", "", "Everyone with a JoolzApp account. Only admins and people you allow can open this inventory. Deleting a user removes their account from all your apps. Trials count photo identifications only; admins and users with unlimited access are never counted."));
    const top = el("div", "prow");
    countEl = el("span", "count", ""); top.appendChild(countEl);
    p.appendChild(top);
    const s = el("div", "usearch"), q = el("input"); q.type = "search"; q.placeholder = "Search name or email"; q.setAttribute("aria-label", "Search users");
    let tm = null; q.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { query = q.value.trim(); loadUsers(); }, 250); };
    const rf = el("button", "pbtn", "Refresh"); rf.type = "button"; rf.onclick = loadUsers;
    s.append(q, rf); p.appendChild(s);
    listBox = el("div", "ulist"); p.appendChild(listBox);
    noteEl = el("span", "count", ""); p.appendChild(noteEl);

    const st = el("div", "aiform acct"); st.style.borderTop = "1px solid var(--line)"; st.style.paddingTop = "12px";
    st.appendChild(el("h2", "", "Trial and sign-ups")); st.firstChild.style.fontSize = "1rem";
    const l1 = el("label", "", "Free photo identifications for new users"), n = el("input"); n.type = "number"; n.min = "0"; n.id = "swTrialLimit"; n.inputMode = "numeric"; l1.appendChild(n);
    const l2 = el("label", "toggle"), c = el("input"); c.type = "checkbox"; c.id = "swSignups"; l2.append(c, document.createTextNode("Let new people create accounts"));
    const sv = el("button", "pbtn accent", "Save"); sv.type = "button"; sv.style.alignSelf = "start";
    sv.onclick = async () => {
      try { settings = await api("api/admin/settings", { method: "POST", body: JSON.stringify({ trialLimit: n.value, signups: c.checked }) }); note("Saved the trial settings."); await loadUsers(); }
      catch (e) { note(e.message, true); }
    };
    st.append(l1, l2, sv); p.appendChild(st);
    mount(p, false);
    // put it right under the account panel
    accountPanel.after(p);
    loadUsers();
  }

  /* ---------- start ---------- */
  // Shared Portal Admin preferences (currency, theme, time zone...). Kept locally too so the next page load starts with them.
  function applyPrefs(p) {
    p = p || {};
    try { const was = localStorage.getItem("sw_prefs") || "{}", now = JSON.stringify(p); if (was === now) return; localStorage.setItem("sw_prefs", now); } catch (e) {}
    if (window.swApplyPrefs) window.swApplyPrefs(p);
  }
  async function refreshMe() {
    if (!getToken()) return;
    try { const j = await api("api/account/me"); user = j.user; applyPrefs(user.prefs); renderAccount(); }
    catch (e) { if (e.status === 401) { setToken(""); location.reload(); } }
  }

  async function start() {
    try { cfg = await fetch("api/app-config", { cache: "no-store" }).then(r => r.json()); } catch (e) { return; }
    if (!cfg || !cfg.accounts) return;
    const css = document.createElement("style"); css.textContent = CSS; document.head.appendChild(css);
    accountPanel = el("div", "panel acct"); accountPanel.id = "swAccountPanel";
    mount(accountPanel, true);
    if (getToken()) {
      try { user = (await api("api/account/me")).user; applyPrefs(user.prefs); }
      catch (e) { if (e.status === 401) setToken(""); }
    }
    renderAccount();
    // only admins see the AI key settings
    const ai = $("aiPanel"); if (ai) ai.hidden = !(user && user.isAdmin);
    if (user && user.isAdmin) buildAdmin();
    // the trial count changes as photos are identified, so refresh it whenever Settings opens
    new MutationObserver(() => { if (!$("setView").hidden) { refreshMe(); if (user && user.isAdmin) loadUsers(); } }).observe($("setView"), { attributes: true, attributeFilter: ["hidden"] });
  }
  // Sign out sits in the top bar (shown only when accounts are on).
  const signOut = () => { setToken(""); try { localStorage.removeItem("sw_prefs"); } catch (e) {} fetch("api/account/logout", { method: "POST" }).catch(() => {}).then(() => location.reload()); };
  const showOut = () => nativeFetch("api/app-config", { cache: "no-store" }).then(r => r.json()).then(c => {
    const b = document.getElementById("outBtn"); if (c.accounts && b) { b.hidden = false; b.onclick = signOut; }
  }).catch(() => {});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { showOut(); start(); }); else { showOut(); start(); }
})();
