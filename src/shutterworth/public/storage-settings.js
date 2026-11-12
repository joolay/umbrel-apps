// Settings → Storage panel: choose between this server and the user's own Google Drive.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const D = window.SWDrive;
  if (!D) return;

  const STATUS = { saving: "Saving…", saved: "All changes saved to Google Drive.", loading: "Loading from Google Drive…",
    offline: "Couldn't reach Google Drive. Changes are kept on this device and saved when it's back.",
    signin: "Google needs you to sign in again before changes can be saved.", idle: "" };

  function build() {
    const css = document.createElement("style");
    css.textContent = `#swReconnect{position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top,0px));z-index:30;box-shadow:0 2px 10px rgba(0,0,0,.2)}`;
    document.head.appendChild(css);

    const panel = document.createElement("div");
    panel.className = "panel"; panel.id = "swStorePanel";
    panel.innerHTML = `<h2>Storage</h2><p id="swStoreWhere"></p><p id="swStoreInfo"></p>
      <div class="prow" id="swStoreBtns"></div><span class="count" id="swStoreNote"></span>`;
    const setView = $("setView");
    setView.insertBefore(panel, setView.firstChild);

    const re = document.createElement("button");
    re.id = "swReconnect"; re.className = "pbtn accent"; re.type = "button"; re.hidden = true;
    re.textContent = "Reconnect Google Drive to save";
    re.onclick = () => D.retrySave().then(() => { re.hidden = true; }).catch(e => note(e.message, true));
    document.body.appendChild(re);

    D.onStatus(s => { re.hidden = s !== "signin"; render(); });
    render();
  }

  function note(t, bad) { const n = $("swStoreNote"); if (!n) return; n.textContent = t === "needs_tap" ? "Tap again to open Google sign-in." : t; n.style.color = bad ? "var(--danger)" : ""; }
  function btn(label, fn, accent) {
    const b = document.createElement("button"); b.type = "button"; b.className = "pbtn" + (accent ? " accent" : ""); b.textContent = label;
    b.onclick = async () => { const all = [...document.querySelectorAll("#swStoreBtns button")]; all.forEach(x => x.disabled = true); try { await fn(); } catch (e) { note(e.message || String(e), true); } finally { all.forEach(x => x.disabled = false); } };
    $("swStoreBtns").appendChild(b);
  }

  async function render() {
    if (!$("swStorePanel")) return;
    $("swStoreBtns").textContent = "";
    if (D.active()) {
      $("swStoreWhere").innerHTML = `This device keeps your inventory in <b>your Google Drive</b>${D.account() ? " (" + D.account() + ")" : ""}, in a private app folder.`;
      $("swStoreInfo").textContent = STATUS[D.status()] || "";
      if (D.status() === "offline" || D.status() === "signin") btn("Save now", () => D.retrySave(), true);
      btn("Use this server instead", async () => {
        if (!confirm("Switch this device back to this server?\n\nYour Drive copy stays in your Google Drive. Changes made there won't appear on the server.")) return;
        D.setMode("server"); location.reload();
      });
      btn("Sign out of Google", async () => {
        if (!confirm("Sign out of Google and switch this device back to this server?")) return;
        D.signOut(); D.setMode("server"); location.reload();
      });
      return;
    }
    $("swStoreWhere").innerHTML = "This device keeps your inventory on <b>this ShutterWorth server</b>.";
    const id = await D.getClientId(), bad = D.originProblem();
    if (!id) { $("swStoreInfo").textContent = "Saving to your own Google Drive isn't set up on this server yet (the admin adds a Google client ID, see README)."; return; }
    if (bad) { $("swStoreInfo").textContent = bad + " Open ShutterWorth from its https address to use Google Drive."; return; }
    $("swStoreInfo").textContent = "Or keep it in your own Google Drive: sign in with Google and ShutterWorth saves your lists, items and photos in a private app folder that only ShutterWorth can see.";
    btn("Use my Google Drive", switchToDrive, true);
  }

  async function switchToDrive() {
    note("Opening Google sign-in…");
    await D.getToken(true);
    note("Checking your Drive…");
    if (await D.driveHasData()) {
      if (confirm("Your Google Drive already has a ShutterWorth inventory.\n\nOK: open that inventory on this device.\nCancel: more options.")) { D.setMode("gdrive"); location.reload(); return; }
      if (!confirm("Replace the inventory in your Drive with this server's inventory (lists, items and photos)?\n\nThe one in Drive will be overwritten.")) { note(""); return; }
    } else if (!confirm("Copy this server's inventory (lists, items and photos) to your Google Drive?\n\nOK: copy it.\nCancel: start with an empty inventory in Drive.")) {
      D.setMode("gdrive"); location.reload(); return;
    }
    await D.copyServerToDrive(t => note(t));
    D.setMode("gdrive"); location.reload();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
