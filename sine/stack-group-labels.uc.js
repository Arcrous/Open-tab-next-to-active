// ==UserScript==
// @name         Stack-style group labels
// @description  Names every tab group after its last used tab, like Vivaldi stacks.
//               Groups you rename by hand are left alone; clear the name to go back to auto.
// @include      main
// ==/UserScript==

// Auto labels start with an invisible U+200B (same marker the extension version used), so a label
// WITHOUT it was typed by you and is never overwritten. Works as a Sine mod / chrome/JS script and can
// be pasted into the Browser Console (Ctrl+Shift+J) for a quick test; re-pasting replaces the old copy.

(() => {
  const MAX_LEN = 40;                 // longest label before "…"
  const MARK = "\u200B";
  const DEBUG = false;
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const gb = win.gBrowser;
  const dbg = (...a) => { if (DEBUG) console.log("[stacklabels]", ...a); };

  if (win.__stackLabels) win.__stackLabels.cleanup();   // safe to re-run

  const attrNames = (el) => [...el.attributes].map(a => a.name);
  const isSplitGroup = (g) => attrNames(g).some(n => /split/i.test(n));   // leave Zen split views alone

  function setLabel(group, text) {
    try { group.label = text; } catch (e) { group.setAttribute("label", text); }
  }

  function apply(group, tab) {
    if (!group || !tab || !group.isConnected || isSplitGroup(group)) return;
    let title = String(tab.label || "").trim();
    if (!title) return;
    if (title.length > MAX_LEN) title = title.slice(0, MAX_LEN - 1) + "…";
    const current = group.label || "";
    if (current && !current.startsWith(MARK)) return;   // named by the user
    const want = MARK + title;
    if (current === want) return;
    setLabel(group, want);
    dbg("label ->", title);
  }

  const allGroups = () =>
    (typeof gb.getAllTabGroups === "function" ? gb.getAllTabGroups() : gb.tabGroups) || [];

  function mostRecent(group) {
    let best = null;
    for (const t of group.tabs || []) {
      if (!best || (t.lastAccessed || 0) > (best.lastAccessed || 0)) best = t;
    }
    return best;
  }

  // Selecting a tab inside a group -> the group takes its title
  const onSelect = (e) => apply(e.target.group, e.target);

  // Title of the selected tab changes (page loaded, SPA navigation...)
  const onAttr = (e) => {
    const tab = e.target;
    if (tab.selected && tab.group && e.detail?.changed?.includes("label")) apply(tab.group, tab);
  };

  // A new group appears (e.g. from an import): name it
  const onGroupCreate = (e) => setTimeout(() => apply(e.target, mostRecent(e.target)), 500);

  gb.tabContainer.addEventListener("TabSelect", onSelect);
  gb.tabContainer.addEventListener("TabAttrModified", onAttr);
  gb.tabContainer.addEventListener("TabGroupCreate", onGroupCreate);

  // Label every existing group after its most recently used tab: after session restore settles
  const timers = [8000, 30000].map(ms => setTimeout(() => {
    let n = 0;
    for (const g of allGroups()) { apply(g, mostRecent(g)); n++; }
    dbg("startup pass over", n, "groups");
  }, ms));

  win.__stackLabels = {
    cleanup() {
      gb.tabContainer.removeEventListener("TabSelect", onSelect);
      gb.tabContainer.removeEventListener("TabAttrModified", onAttr);
      gb.tabContainer.removeEventListener("TabGroupCreate", onGroupCreate);
      timers.forEach(clearTimeout);
    },
  };
  console.log("[stacklabels] loaded");
})();
