// Injected before any page script runs. Draws a touch indicator for every
// pointerdown and keeps it while the pointer is held, so taps and holds read
// on video. Mounted on <html>, not <body>: it never enters the app's own DOM
// (body MutationObservers, portals) and pointer-events:none keeps it out of
// hit-testing.
(() => {
  if (window.__recordFlowTaps) return;
  window.__recordFlowTaps = true;
  const css = `
.__rf-tap{position:fixed;z-index:2147483647;pointer-events:none;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;
background:rgba(20,20,20,.28);border:3px solid rgba(255,255,255,.95);box-shadow:0 0 0 1.5px rgba(0,0,0,.35),0 2px 12px rgba(0,0,0,.35);
transform:scale(.75);opacity:1;transition:transform .1s ease-out}
.__rf-tap.__rf-on{transform:scale(1);opacity:1}
.__rf-tap.__rf-off{transform:scale(1.35);opacity:0;transition:transform .35s ease-out,opacity .35s ease-out}`;
  const live = new Map();
  const mount = () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  };
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  // Wall-clock pointerdown times: the recorder aligns its step log to these
  // (an automation call can resolve well after the touch actually landed).
  window.__recordFlowDowns = [];
  const down = (e) => {
    window.__recordFlowDowns.push(Date.now());
    const dot = document.createElement("div");
    dot.className = "__rf-tap";
    dot.style.left = e.clientX + "px";
    dot.style.top = e.clientY + "px";
    document.documentElement.appendChild(dot);
    requestAnimationFrame(() => dot.classList.add("__rf-on"));
    live.set(e.pointerId, { dot, at: performance.now() });
  };
  const up = (e) => {
    const entry = live.get(e.pointerId);
    if (!entry) return;
    live.delete(e.pointerId);
    // Visible for at least ~450ms so a quick tap lands on several frames even
    // when a heavy page only captures at ~15 fps.
    const wait = Math.max(0, 450 - (performance.now() - entry.at));
    setTimeout(() => {
      entry.dot.classList.add("__rf-off");
      setTimeout(() => entry.dot.remove(), 400);
    }, wait);
  };
  window.addEventListener("pointerdown", down, { capture: true, passive: true });
  window.addEventListener("pointerup", up, { capture: true, passive: true });
  window.addEventListener("pointercancel", up, { capture: true, passive: true });
})();
