/**
 * Right-rail MR review panel.
 *
 * Mounts 5 blocks: Reviewers, Approvals, Changed Files, Assignees, MR Actions.
 * Desktop: vertical stack above MkDocs ToC.
 * Mobile (≤768px): horizontal chip bar + <dialog> bottom sheet.
 *
 * MR #2 scope: READ-ONLY. All action buttons link to GitLab UI.
 * MR #3 replaces links with real handlers.
 *
 * Public API:
 *   ReviewPanel.mount(container, {mrIid, api, onChange?}) → {unmount(), refresh()}
 */
(function () {
  "use strict";

  var BLOCK_DEFS = [
    { key: "reviewers",  title: "Reviewers" },
    { key: "approvals",  title: "Approvals" },
    { key: "files",      title: "Changed files" },
    { key: "assignees",  title: "Assignees" },
    { key: "actions",    title: "MR Actions" },
  ];

  function createBlockSkeleton(def) {
    var el = document.createElement("section");
    el.className = "glr-panel__block glr-panel__block--" + def.key;
    el.dataset.block = def.key;
    el.innerHTML =
      '<header class="glr-panel__block-header">' +
      '<h3 class="glr-panel__block-title">' + def.title + '</h3>' +
      '</header>' +
      '<div class="glr-panel__block-body">' +
      '<div class="glr-panel__skeleton" aria-hidden="true">' +
      '<div class="glr-panel__skeleton-line"></div>' +
      '<div class="glr-panel__skeleton-line"></div>' +
      '</div>' +
      '</div>';
    return el;
  }

  function createPanel() {
    var root = document.createElement("aside");
    root.className = "glr-panel";
    root.setAttribute("aria-label", "Merge Request review panel");
    BLOCK_DEFS.forEach(function (def) {
      root.appendChild(createBlockSkeleton(def));
    });
    return root;
  }

  function mount(container, opts) {
    opts = opts || {};
    if (!container) throw new Error("ReviewPanel.mount: container required");
    if (!opts.mrIid) throw new Error("ReviewPanel.mount: opts.mrIid required");
    if (!opts.api) throw new Error("ReviewPanel.mount: opts.api required");

    var panel = createPanel();
    container.appendChild(panel);

    var unmounted = false;

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }

    function refresh() {
      // Task 2+ will implement
    }

    return { unmount: unmount, refresh: refresh };
  }

  window.ReviewPanel = { mount: mount };
})();
