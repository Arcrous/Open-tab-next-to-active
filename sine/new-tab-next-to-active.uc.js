// ==UserScript==
// @name         New tab next to active tab
// @description  Opens new tabs right after the active (or opener) tab, also in Zen split view.
// @include      main
// ==/UserScript==

// Works as a .uc.js (chrome/JS) and can also be pasted into the Browser Console
// (Ctrl+Shift+J) for a quick test; re-pasting replaces the previous copy.

(() => {
  const DEBUG = false;  // set to true to log what the mod does
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const gb = win.gBrowser;
  const log = (...a) => console.log("[newtabnext]", ...a);
  const dbg = (...a) => { if (DEBUG) log(...a); };
  const d = (t) => t ? `#${t._tPos} "${String(t.label || "").slice(0, 28)}"` : "none";

  if (win.__newTabNext) win.__newTabNext.cleanup();   // safe to re-run

  let cur = gb.selectedTab;
  let prev = null;
  let lastPlaced = new Map();   // anchor tab -> last tab we placed after it

  // If the anchor is half of a Zen split view, go to the end of that split group
  // (best effort: Zen's internals are not documented, so this is defensive).
  function endOfSplit(anchor) {
    try {
      const data = win.gZenViewSplitter?._data;
      dbg("split data:", Array.isArray(data) ? `${data.length} group(s)` : typeof data);
      if (Array.isArray(data)) {
        const group = data.find(g => g.tabs?.includes(anchor));
        if (group?.tabs?.length) {
          const last = group.tabs.reduce((a, b) => (b._tPos > a._tPos ? b : a));
          dbg("anchor is in a split group:", group.tabs.map(d).join(" | "));
          return last;
        }
      }
    } catch (e) { log("split lookup failed", e); }
    return anchor;
  }

  function moveAfter(tab, after) {
    if (typeof gb.moveTabAfter === "function") gb.moveTabAfter(tab, after);
    else gb.moveTabTo(tab, { tabIndex: after._tPos + 1 });
  }

  // Zen scrolls the sidebar to wherever it first inserted the new tab (the top).
  // After we move the tab next to the active one, scroll it back into view.
  function reveal(tab) {
    if (!tab.isConnected || !tab.selected) return;
    try { tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch (e) {}
  }

  function place(tab, anchor) {
    if (!anchor || anchor === tab || !anchor.isConnected) return;
    let after = endOfSplit(anchor);
    const chained = lastPlaced.get(anchor);
    if (chained && chained.isConnected && chained !== tab) after = chained;
    dbg("new tab", d(tab), "| anchor", d(anchor), "| placing after", d(after));
    try {
      moveAfter(tab, after);
      lastPlaced.set(anchor, tab);
      reveal(tab);
      dbg("now", d(tab), "| tab before it:", d(gb.tabs[tab._tPos - 1]), "| after it:", d(gb.tabs[tab._tPos + 1]));
    } catch (e) { log("move failed", e); return; }

    // Zen may reposition / scroll on its own a moment later: check again and win.
    for (const ms of [50, 150, 600]) {
      setTimeout(() => {
        if (!tab.isConnected || !after.isConnected) return;
        if (tab._tPos !== after._tPos + 1) {
          dbg(`moved by something else (${ms}ms): now`, d(tab), "-> re-placing after", d(after));
          try { moveAfter(tab, after); } catch (e) {}
        }
        reveal(tab);
      }, ms);
    }
  }

  const onSelect = (e) => { prev = cur; cur = e.target; lastPlaced = new Map(); };

  const onOpen = (e) => {
    const tab = e.target;
    if (tab.pinned) return;
    const owner = tab.owner;                 // set for tabs opened from another tab
    const selectedNow = gb.selectedTab;      // TabOpen fires before a foreground tab is selected
    dbg("TabOpen: owner", d(owner), "| selected at open", d(selectedNow));
    setTimeout(() => {
      if (!tab.isConnected) return;
      if (owner) {
        place(tab, owner);                   // links / related tabs: next to the opener
      } else if (tab.selected) {
        place(tab, selectedNow !== tab ? selectedNow : prev);   // Ctrl+T etc.
      } else {
        dbg("background tab without opener: left alone");
      }
    }, 0);
  };

  gb.tabContainer.addEventListener("TabSelect", onSelect);
  gb.tabContainer.addEventListener("TabOpen", onOpen);

  win.__newTabNext = {
    cleanup() {
      gb.tabContainer.removeEventListener("TabSelect", onSelect);
      gb.tabContainer.removeEventListener("TabOpen", onOpen);
    },
  };
  log("loaded");
})();
