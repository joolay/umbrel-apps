// App Store: how to install a JoolzApp app on this device. Pure functions (no DOM), so they are easy to test.
// An installed web app (PWA) has to be installed from the app's own address, by the browser itself: no page can do it for another
// address. So "Install" opens the app and shows the exact steps for this device; the apps already carry the manifest and icons.
(function (root) {
  "use strict";
  // env: { ua, platform, touch (maxTouchPoints), standalone }
  function detect(env) {
    const ua = String(env.ua || ""), ipad13 = env.platform === "MacIntel" && env.touch > 1;
    const ios = /iPhone|iPad|iPod/.test(ua) || ipad13, android = /Android/.test(ua);
    const other = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua);   // iOS browsers other than Safari
    const edge = /Edg\//.test(ua), chrome = /Chrome\//.test(ua) && !edge, firefox = /Firefox\//.test(ua);
    const safari = /Safari\//.test(ua) && !chrome && !edge && !firefox && !other;
    let kind = "other";
    if (ios) kind = other ? "ios-other" : "ios-safari";
    else if (android) kind = firefox ? "android-firefox" : "android-chrome";
    else if (edge) kind = "desktop-edge";
    else if (chrome) kind = "desktop-chrome";
    else if (safari) kind = "desktop-safari";
    else if (firefox) kind = "desktop-firefox";
    return { kind, ios, standalone: !!env.standalone };
  }
  const STEPS = {
    "ios-safari": ["Tap Open below. The app opens in Safari.", "Tap the Share button (the square with an arrow) at the bottom of the screen.", "Scroll down and tap Add to Home Screen, then Add."],
    "ios-other": ["Tap Open below. The app opens in this browser.", "Tap the Share button, then Add to Home Screen. If you don't see it, open the same address in Safari (use Copy address) and do it there."],
    "android-chrome": ["Tap Open below. The app opens in Chrome.", "Tap the menu (three dots) at the top right.", "Tap Install app (or Add to Home screen), then Install."],
    "android-firefox": ["Tap Open below. The app opens in Firefox.", "Tap the menu (three dots).", "Tap Install, then Add to Home screen."],
    "desktop-chrome": ["Click Open below. The app opens in a new tab.", "Click the install icon at the right end of the address bar (or the menu, then Cast, save and share, Install page as app).", "Click Install."],
    "desktop-edge": ["Click Open below. The app opens in a new tab.", "Click the install icon at the right end of the address bar (or the menu, then Apps, Install this site as an app).", "Click Install."],
    "desktop-safari": ["Click Open below. The app opens in a new tab.", "In the menu bar choose File, then Add to Dock.", "Click Add."],
    "desktop-firefox": ["Firefox on a computer can't install web apps. Use Chrome, Edge or Safari, or just use View on web.", "Open this page in one of those browsers (use Copy address) and tap Install again."],
    other: ["Click Open below. The app opens in a new tab.", "In your browser's menu look for Install app, Add to Home screen or Add to Dock."],
  };
  // The sign-in note only matters where an installed app does not share the browser's sign-in (iPhone and iPad).
  const steps = (d) => STEPS[d.kind] || STEPS.other;
  const signInNote = (d) => (d.ios ? "On iPhone and iPad an installed app keeps its own sign-in, so you sign in once inside it. Tick Remember me and it stays signed in." : "");
  // Why an app can't be installed right now (empty string = it can). Installing needs a secure (https) address and permission to use the app.
  function blocker(app, ok) {
    if (!app || !app.enabled) return "This app isn't available right now.";
    if (app.maintenance) return "This app is down for maintenance. Try again later.";
    if (!ok) return "Get access to this app first, then you can install it.";
    if (!/^https:\/\//i.test(app.url || "")) return /^http:\/\//i.test(app.url || "") ? "This app only has a home-network address, which can't be installed. Ask the admin to publish it, or use View on web at home." : "This app has no address yet.";
    return "";
  }
  const api = { detect, steps, signInNote, blocker };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.InstallHelp = api;
})(typeof window !== "undefined" ? window : globalThis);
