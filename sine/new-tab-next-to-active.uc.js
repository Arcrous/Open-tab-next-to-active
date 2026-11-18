// ==UserScript==
// @name         New tab next to active tab
// @description  Opens new tabs right after the active (or opener) tab, also in Zen split view.
// @include      main
// ==/UserScript==

// Works as a .uc.js (Sine mod / chrome/JS) and can also be pasted into the Browser Console
// (Ctrl+Shift+J) for a quick test; re-pasting replaces the previous copy.
//
// How it works: addTab() is wrapped so the tab is inserted at the right index from the start
// (no later move, so no flash). A TabOpen fallback moves it afterwards if Zen ignored that.
// The sidebar scroll position is saved before the tab opens and restored afterwards.

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
  let pending = null;           // set by the addTab wrapper, consumed by TabOpen

  // ---- helpers ---------------------------------------------------------------------------

  // If the anchor is half of a Zen split view, go to the end of that split group
  // (best effort: Zen's internals are not documented, so this is defensive).
  function endOfSplit(anchor) {
    try {
      const data = win.gZenViewSplitter?._data;
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

  function computeAfter(anchor, tab) {
    let after = endOfSplit(anchor);
    const chained = lastPlaced.get(anchor);
    if (chained && chained.isConnected && chained !== tab) after = chained;
    return after;
  }

  function moveAfter(tab, after) {
    if (typeof gb.moveTabAfter === "function") gb.moveTabAfter(tab, after);
    else gb.moveTabTo(tab, { tabIndex: after._tPos + 1 });
  }

  // Remember every scrolled ancestor of an element (the sidebar's scroll container(s))
  function scrollSnapshot(el) {
    const snap = [];
    for (let n = el?.parentElement; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1) snap.push([n, n.scrollTop]);
    }
    return snap;
  }

  function restoreScroll(snap) {
    for (const [n, top] of snap) {
      if (Math.abs(n.scrollTop - top) > 1) {
        if (typeof n.scrollTo === "function") n.scrollTo({ top, behavior: "instant" });
        else n.scrollTop = top;
      }
    }
  }

  function reveal(tab) {
    try { tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch (e) {}
  }

  // Zen may move / scroll things a moment after the tab opens: check again and win.
  function settle(tab, after, snap) {
    for (const ms of [0, 50, 150, 400, 900]) {
      setTimeout(() => {
        if (!tab.isConnected) return;
        if (after?.isConnected && tab._tPos !== after._tPos + 1) {
          dbg(`moved by something else (${ms}ms): now`, d(tab), "-> re-placing after", d(after));
          try { moveAfter(tab, after); } catch (e) {}
        }
        if (tab.selected) { restoreScroll(snap); reveal(tab); }
      }, ms);
    }
  }

  // ---- 1) wrap addTab: insert at the right index from the start -----------------------------

  const origAddTab = gb.addTab;
  function wrappedAddTab(uri, opts) {
    try {
      opts = opts || {};
      if (opts.tabIndex === undefined && !opts.pinned && !opts.createLazyBrowser) {
        let anchor = opts.ownerTab || (opts.relatedToCurrent ? gb.selectedTab : null);
        if (!anchor && !opts.inBackground) anchor = gb.selectedTab;   // Ctrl+T etc.
        // background tab without an opener (e.g. scripted imports): leave alone
        if (anchor && anchor.isConnected && !anchor.pinned) {
          const after = computeAfter(anchor, null);
          pending = { anchor, after, snap: scrollSnapshot(anchor) };
          opts = Object.assign({}, opts, { tabIndex: after._tPos + 1 });
          dbg("addTab: anchor", d(anchor), "-> tabIndex", opts.tabIndex);
        }
      }
    } catch (e) { log("addTab wrapper failed", e); pending = null; }
    return origAddTab.call(this, uri, opts);
  }
  gb.addTab = wrappedAddTab;

  // ---- 2) events: bookkeeping + fallback for tabs we couldn't place up front ---------------

  const onSelect = (e) => { prev = cur; cur = e.target; lastPlaced = new Map(); };

  const onOpen = (e) => {
    const tab = e.target;
    if (tab.pinned) { pending = null; return; }

    if (pending) {                                   // placed by the addTab wrapper
      const p = pending; pending = null;
      lastPlaced.set(p.anchor, tab);
      dbg("TabOpen: expected after", d(p.after), "| tab is at", d(tab));
      settle(tab, p.after, p.snap);                  // fixes it if Zen ignored tabIndex
      return;
    }

    // Fallback: tab opened some way that bypassed addTab()
    const owner = tab.owner;
    const selectedNow = gb.selectedTab;
    const snap = scrollSnapshot(owner || selectedNow);
    setTimeout(() => {
      if (!tab.isConnected) return;
      let anchor = null;
      if (owner) anchor = owner;
      else if (tab.selected) anchor = selectedNow !== tab ? selectedNow : prev;
      if (!anchor || anchor === tab || !anchor.isConnected) return;
      const after = computeAfter(anchor, tab);
      dbg("fallback: new tab", d(tab), "| anchor", d(anchor), "| placing after", d(after));
      try { moveAfter(tab, after); lastPlaced.set(anchor, tab); } catch (err) { log("move failed", err); return; }
      settle(tab, after, snap);
    }, 0);
  };

  gb.tabContainer.addEventListener("TabSelect", onSelect);
  gb.tabContainer.addEventListener("TabOpen", onOpen);

  win.__newTabNext = {
    cleanup() {
      gb.tabContainer.removeEventListener("TabSelect", onSelect);
      gb.tabContainer.removeEventListener("TabOpen", onOpen);
      if (gb.addTab === wrappedAddTab) gb.addTab = origAddTab;
    },
  };
  log("loaded");
})();
