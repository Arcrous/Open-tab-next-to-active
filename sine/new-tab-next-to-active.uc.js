// ==UserScript==
// @name         New tab next to active tab (split view fix)
// @description  Leaves Firefox's own "insert after current" behaviour alone and only steps in when the
//               active/opener tab is part of a Zen split view: the new tab goes after the whole split group.
// @include      main
// ==/UserScript==

// Works as a .uc.js (Sine mod / chrome/JS) and can also be pasted into the Browser Console
// (Ctrl+Shift+J) for a quick test; re-pasting replaces the previous copy.
//
// Firefox's built-in browser.tabs.insertAfterCurrent puts a new tab at
// (lastRelatedTab || openerTab || selectedTab)._tPos + 1. With split view the selected tab is one
// half of the pair, so the new tab lands in the middle of it (and Zen then pushes it elsewhere).
// This script only handles that case; everything else is untouched.

(() => {
  const DEBUG = true;   // logs how split view is detected; set to false once it works
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const gb = win.gBrowser;
  const log = (...a) => console.log("[newtabnext]", ...a);
  const dbg = (...a) => { if (DEBUG) log(...a); };
  const d = (t) => t ? `#${t._tPos} "${String(t.label || "").slice(0, 28)}"` : "none";

  if (win.__newTabNext) win.__newTabNext.cleanup();   // safe to re-run

  let cur = gb.selectedTab;
  let prev = null;
  let lastPlaced = new Map();   // anchor tab -> last tab we placed after its split group
  let pending = null;           // set by the addTab wrapper, consumed by TabOpen

  // ---- split view detection (Zen internals are undocumented, so try several ways) -------------

  const attrNames = (el) => el ? [...el.attributes].map(a => a.name) : [];

  function splitTabs(tab) {
    try {
      // 1) Zen's splitter bookkeeping
      const data = win.gZenViewSplitter?._data;
      if (Array.isArray(data)) {
        const g = data.find(x => x.tabs?.includes(tab));
        if (g?.tabs?.length > 1) { dbg("split via gZenViewSplitter._data:", g.tabs.map(d).join(" | ")); return [...g.tabs]; }
      }
      // 2) split view modelled as a tab group / folder with a "split" attribute
      const grp = tab.group;
      if (grp && attrNames(grp).some(n => /split/i.test(n))) {
        const tabs = [...(grp.tabs || [])];
        if (tabs.length > 1) { dbg("split via tab group attrs", attrNames(grp), tabs.map(d).join(" | ")); return tabs; }
      }
      // 3) split marker attribute on the tab itself: take the run of neighbours carrying it
      const mark = attrNames(tab).find(n => /split/i.test(n) && tab.getAttribute(n) !== "false");
      if (mark) {
        const all = [...gb.tabs];
        let i = all.indexOf(tab), lo = i, hi = i;
        while (lo > 0 && all[lo - 1].hasAttribute(mark)) lo--;
        while (hi < all.length - 1 && all[hi + 1].hasAttribute(mark)) hi++;
        if (hi > lo) { dbg(`split via tab attribute "${mark}":`, all.slice(lo, hi + 1).map(d).join(" | ")); return all.slice(lo, hi + 1); }
      }
      dbg("not in a split group:", d(tab), "| tab attrs:", attrNames(tab).join(","),
          "| group:", tab.group ? `${tab.group.localName} [${attrNames(tab.group).join(",")}]` : "none",
          "| _data:", Array.isArray(data) ? `${data.length} group(s)` : typeof data);
    } catch (e) { log("split lookup failed", e); }
    return null;
  }

  const lastOf = (tabs) => tabs.reduce((a, b) => (b._tPos > a._tPos ? b : a));

  // ---- helpers ---------------------------------------------------------------------------------

  function moveAfter(tab, after) {
    if (typeof gb.moveTabAfter === "function") gb.moveTabAfter(tab, after);
    else gb.moveTabTo(tab, { tabIndex: after._tPos + 1 });
  }

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

  // Firefox's own logic and Zen may reposition / scroll right after the tab opens: check again and win.
  function settle(tab, after, snap) {
    for (const ms of [0, 50, 150, 400, 900]) {
      setTimeout(() => {
        if (!tab.isConnected) return;
        if (after?.isConnected && tab._tPos !== after._tPos + 1) {
          dbg(`tab is at ${d(tab)} (${ms}ms) -> moving after`, d(after));
          try { moveAfter(tab, after); } catch (e) {}
        }
        if (tab.selected) { restoreScroll(snap); reveal(tab); }
      }, ms);
    }
  }

  function targetAfter(anchor, tab) {
    const group = splitTabs(anchor);
    if (!group) return null;
    let after = lastOf(group);
    const chained = lastPlaced.get(anchor);
    if (chained && chained.isConnected && chained !== tab && chained._tPos > after._tPos) after = chained;
    return after;
  }

  // ---- 1) wrap addTab: only for split-view anchors, ask for the right index up front -------------

  const origAddTab = gb.addTab;
  function wrappedAddTab(uri, opts) {
    try {
      opts = opts || {};
      if (opts.tabIndex === undefined && !opts.pinned && !opts.createLazyBrowser) {
        // same anchor Firefox uses: opener, else (for foreground tabs) the selected tab
        let anchor = opts.ownerTab || (opts.relatedToCurrent ? gb.selectedTab : null);
        if (!anchor && !opts.inBackground) anchor = gb.selectedTab;
        if (anchor && anchor.isConnected) {
          const after = targetAfter(anchor, null);
          if (after) {
            pending = { anchor, after, snap: scrollSnapshot(anchor) };
            opts = Object.assign({}, opts, { tabIndex: after._tPos + 1 });
            dbg("addTab in split view: anchor", d(anchor), "-> tabIndex", opts.tabIndex);
          }
        }
      }
    } catch (e) { log("addTab wrapper failed", e); pending = null; }
    return origAddTab.call(this, uri, opts);
  }
  gb.addTab = wrappedAddTab;

  // ---- 2) events -----------------------------------------------------------------------------------

  const onSelect = (e) => { prev = cur; cur = e.target; lastPlaced = new Map(); };

  const onOpen = (e) => {
    const tab = e.target;
    if (tab.pinned) { pending = null; return; }

    if (pending) {                                   // set up by the wrapper (split view)
      const p = pending; pending = null;
      lastPlaced.set(p.anchor, tab);
      dbg("TabOpen: expected after", d(p.after), "| tab is at", d(tab));
      settle(tab, p.after, p.snap);
      return;
    }

    // Fallback: tab opened some way that bypassed addTab(); only act for split view
    const owner = tab.owner;
    const selectedNow = gb.selectedTab;
    const snap = scrollSnapshot(owner || selectedNow);
    setTimeout(() => {
      if (!tab.isConnected) return;
      let anchor = null;
      if (owner) anchor = owner;
      else if (tab.selected) anchor = selectedNow !== tab ? selectedNow : prev;
      if (!anchor || anchor === tab || !anchor.isConnected) return;
      const after = targetAfter(anchor, tab);
      if (!after) return;                            // not split view: leave Firefox's placement
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
  log("loaded (split-view only; Firefox's insertAfterCurrent does the rest)");
})();
