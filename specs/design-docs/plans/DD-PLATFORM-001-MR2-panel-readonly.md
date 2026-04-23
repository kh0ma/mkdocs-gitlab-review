# DD-PLATFORM-001 — MR #2: Review panel (read-only, 5 blocks)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the right-rail review panel with five read-only blocks (Reviewers, Approvals, Changed Files, Assignees, MR Actions) on desktop, plus mobile chip-bar fallback. No write operations — every action button links to GitLab UI.

**Architecture:** New `panel.js` module (IIFE attaching `window.ReviewPanel`). Five block sub-renderers. Mobile breakpoint toggles between vertical stack (desktop) and horizontal chip bar (`≤768px`) with `<dialog>` bottom-sheet. Depends on `GitlabAPI` from MR #1. Mounted by `review.js` on review-mode activation.

**Tech Stack:** Vanilla ES5-compatible IIFE JS. Existing Vitest + happy-dom harness from MR #1. CSS scoped via `.glr-panel-*` prefix.

**Working directory:** `/Users/olek/Development/repos/local/mkdocs-gitlab-review` (plugin repo).

**Prerequisites:** MR #1 merged to `main` + tagged `v0.3.0`. `GitlabAPI` available in `window`.

**Before starting:**

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
git checkout main && git pull --ff-only origin main
git checkout -b feat/review-panel-readonly
# Sanity: MR #1 changes present?
test -f src/mkdocs_gitlab_review/assets/api.js || echo "MR #1 missing — abort"
test -f src/mkdocs_gitlab_review/assets/mentions.js || echo "MR #1 missing — abort"
pnpm test   # MR #1 tests still green
```

---

## File Structure

| File | Status | Purpose |
|---|---|---|
| `src/mkdocs_gitlab_review/assets/panel.js` | **NEW** | `ReviewPanel.mount(container, opts) → {unmount, refresh}`. Owns desktop vertical stack + mobile chip bar + bottom sheet. Delegates to 5 block renderers. |
| `src/mkdocs_gitlab_review/assets/panel.css` | **NEW** | Panel + blocks + mobile chip bar + bottom sheet styles. Loaded alongside `review.css`. |
| `src/mkdocs_gitlab_review/assets/review.js` | modified | Call `ReviewPanel.mount()` in `activateReview()`; `unmount()` in `deactivateReview()`. |
| `src/mkdocs_gitlab_review/plugin.py` | modified | Inject `panel.js` after `mentions.js`; inject `panel.css` alongside `review.css`. |
| `tests/js/panel.test.js` | **NEW** | Block-level render, skeleton → content, per-block error, breakpoint behavior. |

Load order for JS injection becomes: `oauth.js → api.js → mentions.js → panel.js → review.js`.

---

## Design decisions baked in

- **All block renderers in one file (`panel.js`)** — splitting each block into its own file creates import cycles in an IIFE world. They're ~60-120 LOC each; one file of ~750 LOC is the right boundary.
- **Read-only means Action buttons are links.** The Approve button in this MR is `<a href="https://git.kbyte.app/.../merge_requests/:iid">Approve in GitLab</a>`. Same for Merge / Close / Delete source branch. MR #3 replaces these with real handlers.
- **Panel mount selector:** `.md-sidebar--secondary` (MkDocs Material's ToC sidebar). Panel is inserted as the sidebar's **first child** — above ToC, below any sticky header in the sidebar. Fallback: if selector misses (theme change), mount to `body` with `position: fixed; right: 1rem; top: 5rem; width: 18rem;`.
- **Mobile breakpoint:** `matchMedia("(max-width: 768px)")`. On match → chip bar. Listener updates live on resize.
- **Skeleton strategy:** every block starts with a skeleton element; replaced when its own fetch resolves. Other blocks not affected by one block's failure.

---

## Task 1: Create `panel.js` skeleton + mount/unmount lifecycle

This task establishes the module, mount/unmount, and empty-block rendering. No real data yet.

**Files:**
- Create: `src/mkdocs_gitlab_review/assets/panel.js`
- Create: `tests/js/panel.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/js/panel.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from "vitest";

function makeApiStub() {
  return {
    getMR: vi.fn().mockResolvedValue({ iid: 7, reviewers: [], assignees: [], source_branch: "feat/x", target_branch: "main", state: "opened" }),
    getChangedFiles: vi.fn().mockResolvedValue([]),
    getApprovalState: vi.fn().mockResolvedValue({ required: 0, approved_by: [], rules: [] }),
    getViewedFiles: vi.fn().mockReturnValue(new Set()),
  };
}

describe("ReviewPanel — mount/unmount lifecycle", () => {
  let container;
  let api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = makeApiStub();
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://git.example.com", project_id: "42" };
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("exposes ReviewPanel on window", () => {
    expect(window.ReviewPanel).toBeDefined();
    expect(typeof window.ReviewPanel.mount).toBe("function");
  });

  it("mount returns object with unmount and refresh", () => {
    const handle = window.ReviewPanel.mount(container, { mrIid: 7, api });
    expect(typeof handle.unmount).toBe("function");
    expect(typeof handle.refresh).toBe("function");
  });

  it("mount inserts a .glr-panel element into container", () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    expect(container.querySelector(".glr-panel")).not.toBeNull();
  });

  it("mount renders 5 block wrappers", () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    const blocks = container.querySelectorAll(".glr-panel__block");
    expect(blocks.length).toBe(5);
  });

  it("each block has a distinct data-block attribute", () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    const slots = Array.from(container.querySelectorAll(".glr-panel__block")).map(
      el => el.dataset.block
    );
    expect(new Set(slots).size).toBe(5);
    expect(slots).toEqual(
      expect.arrayContaining(["reviewers", "approvals", "files", "assignees", "actions"])
    );
  });

  it("blocks show skeleton immediately before fetches resolve", () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    const skeletons = container.querySelectorAll(".glr-panel__skeleton");
    expect(skeletons.length).toBe(5);
  });

  it("unmount removes the panel from the DOM", () => {
    const handle = window.ReviewPanel.mount(container, { mrIid: 7, api });
    handle.unmount();
    expect(container.querySelector(".glr-panel")).toBeNull();
  });

  it("unmount is idempotent — calling twice is safe", () => {
    const handle = window.ReviewPanel.mount(container, { mrIid: 7, api });
    handle.unmount();
    expect(() => handle.unmount()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — confirm all fail**

```bash
pnpm test tests/js/panel.test.js
```

Expected: all 8 `ReviewPanel` tests fail (module doesn't exist).

- [ ] **Step 3: Create `panel.js` minimal skeleton**

```js
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
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
pnpm test
```

Expected: all MR #1 tests + 8 new `ReviewPanel` tests = PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js tests/js/panel.test.js
git commit -m "feat: add ReviewPanel skeleton module with mount/unmount lifecycle"
```

---

## Task 2: Implement block data-fetching + parallel fan-out

Each block fetches its own data on mount. Blocks resolve independently.

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js`
- Modify: `tests/js/panel.test.js` (add tests)

- [ ] **Step 1: Add failing tests**

Append to `tests/js/panel.test.js`:

```js
describe("ReviewPanel — data fetching", () => {
  let container;
  let api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = {
      getMR: vi.fn().mockResolvedValue({
        iid: 7,
        reviewers: [{ id: 1, username: "andriy", name: "Andriy", avatar_url: null }],
        assignees: [{ id: 2, username: "olek", name: "Olek", avatar_url: null }],
        source_branch: "feat/x",
        target_branch: "main",
        state: "opened",
        web_url: "https://git.example.com/g/p/-/merge_requests/7",
        has_conflicts: false,
      }),
      getChangedFiles: vi.fn().mockResolvedValue([
        { path: "a.md", status: "modified", additions: 5, deletions: 2 },
      ]),
      getApprovalState: vi.fn().mockResolvedValue({
        required: 2,
        approved_by: [{ username: "maria", name: "Maria" }],
        rules: [{ id: 1, name: "CODEOWNERS", approvals_required: 1, approved_by: [] }],
      }),
      getViewedFiles: vi.fn().mockReturnValue(new Set()),
    };
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://git.example.com", project_id: "42" };
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("fires fetches in parallel on mount", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    expect(api.getMR).toHaveBeenCalledTimes(1);
    expect(api.getApprovalState).toHaveBeenCalledTimes(1);
    expect(api.getChangedFiles).toHaveBeenCalledTimes(1);
  });

  it("reviewers block renders reviewer list after fetch", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    const block = container.querySelector('[data-block="reviewers"]');
    expect(block.textContent).toContain("andriy");
  });

  it("approvals block renders 'N of M' counter", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    const block = container.querySelector('[data-block="approvals"]');
    expect(block.textContent).toMatch(/1.*of.*2/i);
  });

  it("files block renders file list with +/- stats", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    const block = container.querySelector('[data-block="files"]');
    expect(block.textContent).toContain("a.md");
    expect(block.textContent).toMatch(/\+5/);
    expect(block.textContent).toMatch(/[-−]2/);
  });

  it("assignees block renders assignee list", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    const block = container.querySelector('[data-block="assignees"]');
    expect(block.textContent).toContain("olek");
  });

  it("actions block shows merge/close links (read-only MR#2)", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    const block = container.querySelector('[data-block="actions"]');
    const links = block.querySelectorAll("a[href]");
    expect(links.length).toBeGreaterThanOrEqual(1);
    // Link goes to GitLab UI for MR
    expect(Array.from(links).some(a => a.href.includes("/merge_requests/7"))).toBe(true);
  });

  it("skeleton is replaced by content after fetch resolves", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    expect(container.querySelectorAll(".glr-panel__skeleton").length).toBe(5);
    await new Promise(r => setTimeout(r, 10));
    expect(container.querySelectorAll(".glr-panel__skeleton").length).toBe(0);
  });

  it("one block error does not break other blocks", async () => {
    api.getApprovalState = vi.fn().mockRejectedValue({ status: 500, message: "boom" });
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    // approvals block shows error state
    const approvals = container.querySelector('[data-block="approvals"]');
    expect(approvals.querySelector(".glr-panel__error")).not.toBeNull();
    // reviewers still rendered normally
    const reviewers = container.querySelector('[data-block="reviewers"]');
    expect(reviewers.textContent).toContain("andriy");
  });
});
```

- [ ] **Step 2: Run — confirm new tests fail**

```bash
pnpm test tests/js/panel.test.js
```

Expected: 8 lifecycle tests pass; 8 data-fetching tests fail (blocks still show skeletons).

- [ ] **Step 3: Implement block renderers**

Rewrite `panel.js` to replace the `createBlockSkeleton` / `mount` implementation with one that actually fetches and renders. Keep the IIFE and public API unchanged.

Full replacement for `panel.js`:

```js
/**
 * Right-rail MR review panel.
 *
 * Mounts 5 blocks: Reviewers, Approvals, Changed Files, Assignees, MR Actions.
 * Desktop: vertical stack above MkDocs ToC.
 * Mobile (≤768px): horizontal chip bar + <dialog> bottom sheet.
 *
 * MR #2 scope: READ-ONLY. All action buttons link to GitLab UI.
 * MR #3 replaces links with real handlers.
 */
(function () {
  "use strict";

  var config = window.__GITLAB_REVIEW__ || {};

  // -------- Utilities --------

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function mrWebUrl(mrIid) {
    return (config.project_url || config.gitlab_url || "") +
      "/-/merge_requests/" + mrIid;
  }

  function makeSkeleton() {
    var sk = document.createElement("div");
    sk.className = "glr-panel__skeleton";
    sk.setAttribute("aria-hidden", "true");
    sk.innerHTML = '<div class="glr-panel__skeleton-line"></div>' +
      '<div class="glr-panel__skeleton-line"></div>';
    return sk;
  }

  function makeError(message, onRetry) {
    var div = document.createElement("div");
    div.className = "glr-panel__error";
    div.setAttribute("role", "alert");
    div.innerHTML = '<span class="glr-panel__error-msg">' + escapeHtml(message) + '</span>' +
      ' <button type="button" class="glr-panel__error-retry">Спробувати знову</button>';
    if (onRetry) {
      div.querySelector(".glr-panel__error-retry").addEventListener("click", onRetry);
    }
    return div;
  }

  function userChip(user) {
    var avatar = user.avatar_url
      ? '<img class="glr-panel__avatar" src="' + escapeHtml(user.avatar_url) + '" alt="">'
      : '<span class="glr-panel__avatar glr-panel__avatar--placeholder" aria-hidden="true"></span>';
    return '<span class="glr-panel__user">' +
      avatar +
      '<span class="glr-panel__user-name">' + escapeHtml(user.name || user.username) + '</span>' +
      '</span>';
  }

  // -------- Block renderers --------
  // Each returns a DOM node (full block body, not the header).

  function renderReviewersBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!mr.reviewers || mr.reviewers.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">Рецензентів не призначено</p>';
      return body;
    }
    var approvedUsernames = new Set(
      (ctx.approvals && ctx.approvals.approved_by || []).map(function (u) { return u.username; })
    );
    var html = '<ul class="glr-panel__user-list">';
    mr.reviewers.forEach(function (r) {
      var status = approvedUsernames.has(r.username) ? "approved" : "requested";
      var statusLabel = status === "approved" ? "✓ approved" : "⏳ requested";
      html += '<li class="glr-panel__user-row glr-panel__user-row--' + status + '">' +
        userChip(r) +
        ' <span class="glr-panel__user-status">' + statusLabel + '</span>' +
        '</li>';
    });
    html += '</ul>';
    // MR #2: link to GitLab for adding reviewers (no inline control yet).
    html += '<a class="glr-panel__action-link" href="' + mrWebUrl(mr.iid) + '">+ Запросити рев\'ю в GitLab</a>';
    body.innerHTML = html;
    return body;
  }

  function renderApprovalsBlock(approvals, mr) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    var approved = (approvals.approved_by || []).length;
    var required = approvals.required || 0;

    var html = '';
    if (required === 0 && (!approvals.rules || approvals.rules.length === 0)) {
      html += '<p class="glr-panel__empty">No approval rules configured</p>';
    } else {
      html += '<p class="glr-panel__approvals-counter"><strong>' + approved + '</strong> of <strong>' + required + '</strong> approvals</p>';
      if (approvals.rules && approvals.rules.length > 0) {
        html += '<ul class="glr-panel__rule-list">';
        approvals.rules.forEach(function (rule) {
          var ruleApproved = (rule.approved_by || []).length;
          var ruleReq = rule.approvals_required || 0;
          html += '<li class="glr-panel__rule">' +
            '<span class="glr-panel__rule-name">' + escapeHtml(rule.name) + '</span>' +
            ' <span class="glr-panel__rule-count">' + ruleApproved + '/' + ruleReq + '</span>' +
            '</li>';
        });
        html += '</ul>';
      }
    }
    // MR #2: link to GitLab for Approve (no inline button yet).
    html += '<a class="glr-panel__action-link glr-panel__action-link--primary" href="' + mrWebUrl(mr.iid) + '">Approve in GitLab</a>';
    body.innerHTML = html;
    return body;
  }

  function renderFilesBlock(files, viewed) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!files || files.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">No changed files</p>';
      return body;
    }
    var html = '<p class="glr-panel__files-count"><strong>' + files.length + '</strong> files</p>';
    html += '<ul class="glr-panel__file-list">';
    files.forEach(function (f) {
      var statusIcon = { added: "●", modified: "◐", deleted: "✕", renamed: "→" }[f.status] || "◐";
      html += '<li class="glr-panel__file glr-panel__file--' + f.status + '">' +
        '<span class="glr-panel__file-status" aria-label="' + f.status + '">' + statusIcon + '</span>' +
        ' <span class="glr-panel__file-path">' + escapeHtml(f.path) + '</span>' +
        ' <span class="glr-panel__file-stats">' +
        '<span class="glr-panel__additions">+' + f.additions + '</span> ' +
        '<span class="glr-panel__deletions">−' + f.deletions + '</span>' +
        '</span>' +
        '</li>';
    });
    html += '</ul>';
    body.innerHTML = html;
    return body;
  }

  function renderAssigneesBlock(mr) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!mr.assignees || mr.assignees.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">Не призначено</p>';
      return body;
    }
    var html = '<ul class="glr-panel__user-list">';
    mr.assignees.forEach(function (a) {
      html += '<li class="glr-panel__user-row">' + userChip(a) + '</li>';
    });
    html += '</ul>';
    body.innerHTML = html;
    return body;
  }

  function renderActionsBlock(mr) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    var url = mrWebUrl(mr.iid);
    var html = '';
    if (mr.state === "opened") {
      html += '<a class="glr-panel__action-link glr-panel__action-link--primary" href="' + url + '">Merge in GitLab</a>';
      html += '<a class="glr-panel__action-link" href="' + url + '">Close in GitLab</a>';
    } else if (mr.state === "merged") {
      html += '<p class="glr-panel__state-badge glr-panel__state-badge--merged">Merged</p>';
      html += '<a class="glr-panel__action-link" href="' + url + '">Delete source branch in GitLab</a>';
    } else if (mr.state === "closed") {
      html += '<p class="glr-panel__state-badge glr-panel__state-badge--closed">Closed</p>';
      html += '<a class="glr-panel__action-link" href="' + url + '">Open in GitLab</a>';
    }
    body.innerHTML = html;
    return body;
  }

  // -------- Panel lifecycle --------

  var BLOCK_DEFS = [
    { key: "reviewers",  title: "Reviewers" },
    { key: "approvals",  title: "Approvals" },
    { key: "files",      title: "Changed files" },
    { key: "assignees",  title: "Assignees" },
    { key: "actions",    title: "MR Actions" },
  ];

  function buildBlockWrapper(def) {
    var el = document.createElement("section");
    el.className = "glr-panel__block glr-panel__block--" + def.key;
    el.dataset.block = def.key;
    el.innerHTML =
      '<header class="glr-panel__block-header">' +
      '<h3 class="glr-panel__block-title">' + def.title + '</h3>' +
      '</header>';
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    body.appendChild(makeSkeleton());
    el.appendChild(body);
    return el;
  }

  function replaceBody(blockEl, newBody) {
    var old = blockEl.querySelector(".glr-panel__block-body");
    if (old) blockEl.replaceChild(newBody, old);
    else blockEl.appendChild(newBody);
  }

  function mount(container, opts) {
    opts = opts || {};
    if (!container) throw new Error("ReviewPanel.mount: container required");
    if (!opts.mrIid) throw new Error("ReviewPanel.mount: opts.mrIid required");
    if (!opts.api) throw new Error("ReviewPanel.mount: opts.api required");

    var api = opts.api;
    var mrIid = opts.mrIid;

    var panel = document.createElement("aside");
    panel.className = "glr-panel";
    panel.setAttribute("aria-label", "Merge Request review panel");

    var blockEls = {};
    BLOCK_DEFS.forEach(function (def) {
      var el = buildBlockWrapper(def);
      blockEls[def.key] = el;
      panel.appendChild(el);
    });
    container.appendChild(panel);

    var unmounted = false;

    function fetchAndRender() {
      // Kick off three parallel fetches.
      var mrPromise = api.getMR(mrIid);
      var approvalsPromise = api.getApprovalState(mrIid);
      var filesPromise = api.getChangedFiles(mrIid);

      // Reviewers + Approvals block depend on BOTH MR and approvals, so we wait on both.
      // Use Promise.allSettled so one failure doesn't cascade.
      Promise.all([
        mrPromise.catch(function (e) { return { __error: e }; }),
        approvalsPromise.catch(function (e) { return { __error: e }; }),
      ]).then(function (results) {
        if (unmounted) return;
        var mr = results[0];
        var approvals = results[1];

        // Reviewers block
        if (mr.__error) {
          replaceBody(blockEls.reviewers, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        } else {
          replaceBody(blockEls.reviewers, renderReviewersBlock(mr, { approvals: approvals.__error ? null : approvals }));
        }
        // Approvals block (needs only approvals + mr for link)
        if (approvals.__error) {
          replaceBody(blockEls.approvals, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        } else if (mr.__error) {
          // Fall back: render approvals without MR link (shouldn't happen often)
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, { iid: mrIid }));
        } else {
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, mr));
        }
        // Assignees block (from mr)
        if (mr.__error) {
          replaceBody(blockEls.assignees, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        } else {
          replaceBody(blockEls.assignees, renderAssigneesBlock(mr));
        }
        // Actions block (from mr)
        if (mr.__error) {
          replaceBody(blockEls.actions, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        } else {
          replaceBody(blockEls.actions, renderActionsBlock(mr));
        }
      });

      filesPromise.then(function (files) {
        if (unmounted) return;
        var viewed = api.getViewedFiles ? api.getViewedFiles(mrIid) : new Set();
        replaceBody(blockEls.files, renderFilesBlock(files, viewed));
      }).catch(function () {
        if (unmounted) return;
        replaceBody(blockEls.files, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
      });
    }

    function wrapError(errEl) {
      var body = document.createElement("div");
      body.className = "glr-panel__block-body";
      body.appendChild(errEl);
      return body;
    }

    fetchAndRender();

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }

    return {
      unmount: unmount,
      refresh: fetchAndRender,
    };
  }

  window.ReviewPanel = { mount: mount };
})();
```

- [ ] **Step 4: Run tests — all pass**

```bash
pnpm test
```

Expected: MR #1 tests + 16 `ReviewPanel` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js tests/js/panel.test.js
git commit -m "feat: implement 5 ReviewPanel blocks with parallel data fetch"
```

---

## Task 3: Mobile breakpoint — chip bar + bottom sheet

Below 768px, the vertical panel becomes a horizontal chip bar. Tapping a chip opens a `<dialog>` sheet with the full block.

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js`
- Modify: `tests/js/panel.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/js/panel.test.js`:

```js
describe("ReviewPanel — mobile", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = {
      getMR: vi.fn().mockResolvedValue({ iid: 7, reviewers: [], assignees: [], state: "opened" }),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      getApprovalState: vi.fn().mockResolvedValue({ required: 0, approved_by: [], rules: [] }),
      getViewedFiles: vi.fn().mockReturnValue(new Set()),
    };
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://git.example.com", project_id: "42" };
    // Force mobile breakpoint
    window.matchMedia = vi.fn().mockImplementation(function (query) {
      return {
        matches: query.indexOf("max-width: 768px") >= 0,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("on mobile breakpoint, renders chip bar instead of vertical stack", () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    expect(container.querySelector(".glr-panel--mobile")).not.toBeNull();
    expect(container.querySelectorAll(".glr-panel__chip").length).toBe(5);
  });

  it("mobile chips have block-specific keys", () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    const keys = Array.from(container.querySelectorAll(".glr-panel__chip"))
      .map(c => c.dataset.block);
    expect(keys).toEqual(
      expect.arrayContaining(["reviewers", "approvals", "files", "assignees", "actions"])
    );
  });

  it("tapping a chip opens a <dialog> with that block's content", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    const reviewersChip = container.querySelector('.glr-panel__chip[data-block="reviewers"]');
    reviewersChip.click();
    const dlg = document.querySelector(".glr-panel__sheet");
    expect(dlg).not.toBeNull();
    expect(dlg.textContent.toLowerCase()).toContain("reviewers");
  });

  it("Escape closes bottom sheet", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 10));
    container.querySelector('.glr-panel__chip[data-block="reviewers"]').click();
    const dlg = document.querySelector(".glr-panel__sheet");
    dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // happy-dom may not auto-close <dialog> on Escape; we listen ourselves.
    expect(document.querySelector(".glr-panel__sheet")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — tests fail**

```bash
pnpm test tests/js/panel.test.js
```

Expected: 4 new mobile tests fail.

- [ ] **Step 3: Implement mobile mode in `panel.js`**

Modify `panel.js` — replace the `mount` function body (from "var panel = document.createElement" through the `return`) with a version that checks the breakpoint and branches:

```js
  function mount(container, opts) {
    opts = opts || {};
    if (!container) throw new Error("ReviewPanel.mount: container required");
    if (!opts.mrIid) throw new Error("ReviewPanel.mount: opts.mrIid required");
    if (!opts.api) throw new Error("ReviewPanel.mount: opts.api required");

    var api = opts.api;
    var mrIid = opts.mrIid;

    var mql = window.matchMedia("(max-width: 768px)");
    var isMobile = mql.matches;

    var panel = document.createElement("aside");
    panel.className = "glr-panel" + (isMobile ? " glr-panel--mobile" : "");
    panel.setAttribute("aria-label", "Merge Request review panel");

    var blockEls = {};
    var chipEls = {};
    var blockBodies = {}; // hold pre-rendered bodies for mobile sheet display

    if (isMobile) {
      var chipBar = document.createElement("div");
      chipBar.className = "glr-panel__chip-bar";
      BLOCK_DEFS.forEach(function (def) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "glr-panel__chip glr-panel__chip--" + def.key;
        chip.dataset.block = def.key;
        chip.innerHTML = '<span class="glr-panel__chip-label">' + def.title + '</span>' +
          '<span class="glr-panel__chip-value glr-panel__skeleton-inline"></span>';
        chipBar.appendChild(chip);
        chipEls[def.key] = chip;
        // Hidden block wrapper used as content source for the sheet
        var hidden = buildBlockWrapper(def);
        hidden.style.display = "none";
        panel.appendChild(hidden);
        blockEls[def.key] = hidden;
      });
      panel.insertBefore(chipBar, panel.firstChild);
    } else {
      BLOCK_DEFS.forEach(function (def) {
        var el = buildBlockWrapper(def);
        blockEls[def.key] = el;
        panel.appendChild(el);
      });
    }

    container.appendChild(panel);

    var unmounted = false;
    var sheetEl = null;

    function updateChipValue(key, text) {
      if (!chipEls[key]) return;
      var val = chipEls[key].querySelector(".glr-panel__chip-value");
      if (val) {
        val.classList.remove("glr-panel__skeleton-inline");
        val.textContent = text;
      }
    }

    function openSheet(key) {
      closeSheet();
      var source = blockEls[key];
      if (!source) return;
      var sheet = document.createElement("dialog");
      sheet.className = "glr-panel__sheet glr-panel__sheet--" + key;
      sheet.innerHTML = '<button type="button" class="glr-panel__sheet-close" aria-label="Закрити">×</button>' +
        '<div class="glr-panel__sheet-body"></div>';
      var body = source.cloneNode(true);
      body.style.display = "";
      sheet.querySelector(".glr-panel__sheet-body").appendChild(body);
      document.body.appendChild(sheet);
      sheet.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeSheet();
      });
      sheet.querySelector(".glr-panel__sheet-close").addEventListener("click", closeSheet);
      // happy-dom may not implement showModal; guard it.
      if (typeof sheet.showModal === "function") {
        try { sheet.showModal(); } catch (e) { /* already open */ }
      } else {
        sheet.setAttribute("open", "");
      }
      sheetEl = sheet;
    }

    function closeSheet() {
      if (sheetEl) {
        if (typeof sheetEl.close === "function") {
          try { sheetEl.close(); } catch (e) { /* noop */ }
        }
        if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
        sheetEl = null;
      }
    }

    if (isMobile) {
      BLOCK_DEFS.forEach(function (def) {
        chipEls[def.key].addEventListener("click", function () { openSheet(def.key); });
      });
    }

    function fetchAndRender() {
      var mrPromise = api.getMR(mrIid);
      var approvalsPromise = api.getApprovalState(mrIid);
      var filesPromise = api.getChangedFiles(mrIid);

      Promise.all([
        mrPromise.catch(function (e) { return { __error: e }; }),
        approvalsPromise.catch(function (e) { return { __error: e }; }),
      ]).then(function (results) {
        if (unmounted) return;
        var mr = results[0];
        var approvals = results[1];

        if (mr.__error) {
          replaceBody(blockEls.reviewers, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("reviewers", "⚠");
        } else {
          replaceBody(blockEls.reviewers, renderReviewersBlock(mr, { approvals: approvals.__error ? null : approvals }));
          updateChipValue("reviewers", String((mr.reviewers || []).length));
        }
        if (approvals.__error) {
          replaceBody(blockEls.approvals, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("approvals", "⚠");
        } else {
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, mr.__error ? { iid: mrIid } : mr));
          updateChipValue("approvals", (approvals.approved_by || []).length + "/" + (approvals.required || 0));
        }
        if (mr.__error) {
          replaceBody(blockEls.assignees, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("assignees", "⚠");
        } else {
          replaceBody(blockEls.assignees, renderAssigneesBlock(mr));
          updateChipValue("assignees", String((mr.assignees || []).length));
        }
        if (mr.__error) {
          replaceBody(blockEls.actions, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("actions", "⚠");
        } else {
          replaceBody(blockEls.actions, renderActionsBlock(mr));
          updateChipValue("actions", mr.state === "opened" ? "●" : mr.state);
        }
      });

      filesPromise.then(function (files) {
        if (unmounted) return;
        var viewed = api.getViewedFiles ? api.getViewedFiles(mrIid) : new Set();
        replaceBody(blockEls.files, renderFilesBlock(files, viewed));
        updateChipValue("files", String((files || []).length));
      }).catch(function () {
        if (unmounted) return;
        replaceBody(blockEls.files, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        updateChipValue("files", "⚠");
      });
    }

    function wrapError(errEl) {
      var body = document.createElement("div");
      body.className = "glr-panel__block-body";
      body.appendChild(errEl);
      return body;
    }

    fetchAndRender();

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      closeSheet();
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }

    return {
      unmount: unmount,
      refresh: fetchAndRender,
    };
  }
```

- [ ] **Step 4: Run tests — green**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js tests/js/panel.test.js
git commit -m "feat: add mobile chip-bar + bottom sheet for ReviewPanel"
```

---

## Task 4: Style the panel — `panel.css`

**Files:**
- Create: `src/mkdocs_gitlab_review/assets/panel.css`
- Modify: `src/mkdocs_gitlab_review/plugin.py` (add CSS injection)

- [ ] **Step 1: Create `panel.css`**

```css
/* ReviewPanel — right rail (desktop) + mobile chip bar */

.glr-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  font-size: 0.875rem;
  color: var(--md-default-fg-color, #000);
}

.glr-panel__block {
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 0.5rem;
  background: var(--md-default-bg-color, #fff);
  overflow: hidden;
}

.glr-panel__block-header {
  padding: 0.4rem 0.6rem 0.2rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}

.glr-panel__block-title {
  margin: 0;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(0, 0, 0, 0.6);
}

.glr-panel__block-body {
  padding: 0.5rem 0.6rem 0.6rem;
}

.glr-panel__empty {
  margin: 0;
  color: rgba(0, 0, 0, 0.5);
  font-style: italic;
}

.glr-panel__skeleton-line,
.glr-panel__skeleton-inline {
  height: 0.75rem;
  background: linear-gradient(90deg, rgba(0,0,0,0.06), rgba(0,0,0,0.12), rgba(0,0,0,0.06));
  background-size: 200% 100%;
  animation: glr-shimmer 1.4s linear infinite;
  border-radius: 0.25rem;
}
.glr-panel__skeleton-line { margin-bottom: 0.35rem; }
.glr-panel__skeleton-line:last-child { width: 70%; margin-bottom: 0; }

@keyframes glr-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.glr-panel__user-list,
.glr-panel__rule-list,
.glr-panel__file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.glr-panel__user-row,
.glr-panel__rule,
.glr-panel__file {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.glr-panel__user {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.glr-panel__avatar {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
}

.glr-panel__avatar--placeholder {
  background: rgba(0, 0, 0, 0.1);
  display: inline-block;
}

.glr-panel__user-status {
  margin-left: auto;
  font-size: 0.75rem;
  color: rgba(0, 0, 0, 0.6);
}

.glr-panel__user-row--approved .glr-panel__user-status { color: #1f883d; }
.glr-panel__user-row--requested .glr-panel__user-status { color: #d97706; }

.glr-panel__action-link {
  display: inline-block;
  margin-top: 0.5rem;
  padding: 0.35rem 0.6rem;
  border-radius: 0.25rem;
  text-decoration: none;
  color: var(--md-primary-fg-color, #0d7377);
  background: rgba(13, 115, 119, 0.08);
  font-size: 0.8rem;
}

.glr-panel__action-link:hover { background: rgba(13, 115, 119, 0.16); }

.glr-panel__action-link--primary {
  color: #fff;
  background: var(--md-primary-fg-color, #0d7377);
  font-weight: 600;
}

.glr-panel__action-link--primary:hover { background: #0a5e61; }

.glr-panel__approvals-counter { margin: 0 0 0.4rem; }

.glr-panel__file-status { flex: none; width: 1rem; }
.glr-panel__file-path { flex: 1; font-family: ui-monospace, monospace; font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.glr-panel__file-stats { flex: none; font-size: 0.72rem; }
.glr-panel__additions { color: #1f883d; }
.glr-panel__deletions { color: #cf222e; }

.glr-panel__file--added .glr-panel__file-path { color: #1f883d; }
.glr-panel__file--deleted .glr-panel__file-path { color: #cf222e; text-decoration: line-through; }

.glr-panel__state-badge {
  margin: 0 0 0.4rem;
  padding: 0.3rem 0.5rem;
  border-radius: 0.25rem;
  font-weight: 600;
  font-size: 0.8rem;
}
.glr-panel__state-badge--merged { background: rgba(130, 80, 223, 0.1); color: #8250df; }
.glr-panel__state-badge--closed { background: rgba(207, 34, 46, 0.1); color: #cf222e; }

.glr-panel__error {
  padding: 0.4rem;
  background: rgba(207, 34, 46, 0.08);
  border-radius: 0.25rem;
  font-size: 0.8rem;
}
.glr-panel__error-retry {
  margin-left: 0.3rem;
  border: 0;
  background: rgba(207, 34, 46, 0.16);
  color: #cf222e;
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
  cursor: pointer;
}

/* Mobile chip bar */

.glr-panel--mobile { flex-direction: row; padding: 0.25rem; }
.glr-panel--mobile .glr-panel__block { display: none !important; }

.glr-panel__chip-bar {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  padding: 0.2rem;
  -webkit-overflow-scrolling: touch;
}

.glr-panel__chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 44px;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 999px;
  background: var(--md-default-bg-color, #fff);
  font: inherit;
  cursor: pointer;
}

.glr-panel__chip-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.glr-panel__chip-value {
  font-size: 0.8rem;
  color: rgba(0, 0, 0, 0.7);
  min-width: 1.5rem;
  text-align: center;
}

.glr-panel__chip-value.glr-panel__skeleton-inline {
  display: inline-block;
  width: 1.5rem;
  height: 0.7rem;
}

/* Bottom sheet */

.glr-panel__sheet[open] {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  top: auto;
  width: 100%;
  max-height: 75vh;
  margin: 0;
  padding: 1rem;
  border: 0;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 1rem 1rem 0 0;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.15);
  background: var(--md-default-bg-color, #fff);
}

.glr-panel__sheet::backdrop {
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(2px);
}

.glr-panel__sheet-close {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  width: 44px;
  height: 44px;
  border: 0;
  background: transparent;
  font-size: 1.5rem;
  cursor: pointer;
}
```

- [ ] **Step 2: Inject CSS via plugin.py**

Modify `src/mkdocs_gitlab_review/plugin.py`. Find the existing CSS injection block (around line 176):

```python
        # CSS
        css_path = self._assets_dir / "review.css"
        if css_path.exists():
            css = css_path.read_text()
            parts.append(f"<style>{css}</style>")
```

Replace with a loop over both files:

```python
        # CSS — review.css (core) + panel.css (review panel)
        for css_file in ["review.css", "panel.css"]:
            css_path = self._assets_dir / css_file
            if css_path.exists():
                css = css_path.read_text()
                parts.append(f"<style>{css}</style>")
```

- [ ] **Step 3: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.css src/mkdocs_gitlab_review/plugin.py
git commit -m "style: add panel.css with desktop rail + mobile chip bar + sheet"
```

---

## Task 5: Wire `panel.js` into plugin injection + `review.js` lifecycle

**Files:**
- Modify: `src/mkdocs_gitlab_review/plugin.py` (JS injection list)
- Modify: `src/mkdocs_gitlab_review/assets/review.js` (mount/unmount calls)

- [ ] **Step 1: Add `panel.js` to injection list**

In `src/mkdocs_gitlab_review/plugin.py`, find:

```python
        # JS — oauth → api → mentions → main (load order matters; mentions needs api)
        for js_file in ["oauth.js", "api.js", "mentions.js", "review.js"]:
```

Replace with:

```python
        # JS — oauth → api → mentions → panel → main (load order matters)
        for js_file in ["oauth.js", "api.js", "mentions.js", "panel.js", "review.js"]:
```

- [ ] **Step 2: Wire mount/unmount in review.js**

Open `src/mkdocs_gitlab_review/assets/review.js`. Find the `activateReview(toggleBtn)` function:

```bash
grep -n "function activateReview" src/mkdocs_gitlab_review/assets/review.js
```

Read the function. It activates review mode — fetches diff refs, changed files, discussions, renders overlay. After the overlay renders, add panel mount:

Inside `activateReview`, at the end of the `.then(...)` success chain (right before it ends), insert:

```js
      // Mount right-rail panel.
      var rail = document.querySelector(".md-sidebar--secondary") || document.body;
      if (state.panelHandle) state.panelHandle.unmount();
      state.panelHandle = window.ReviewPanel.mount(rail, {
        mrIid: state.mrIid,
        api: window.GitlabAPI,
      });
```

**To locate the insertion point precisely:** find the last `.then(function () {` chain call in `activateReview` that renders the overlay or dashboard. Insert the mount block after that rendering completes.

In `deactivateReview(toggleBtn)`:

```bash
grep -n "function deactivateReview" src/mkdocs_gitlab_review/assets/review.js
```

Inside, add before the function returns:

```js
    if (state.panelHandle) {
      state.panelHandle.unmount();
      state.panelHandle = null;
    }
```

- [ ] **Step 3: Initialize `state.panelHandle = null` in state object**

Find the initial `state = { ... }` declaration near the top of `review.js`. Add:

```js
    panelHandle: null,
```

- [ ] **Step 4: Run Python tests — still green**

```bash
pytest
```

- [ ] **Step 5: Manual sanity — serve docs, activate review**

Boot the local SDD Hub site (in a separate terminal: `cd ~/Development/repos/local/sdd-hub && mkdocs serve`), open an MR preview URL in browser, click "Review mode". The panel must appear on the right sidebar above the ToC.

- [ ] **Step 6: Commit**

```bash
git add src/mkdocs_gitlab_review/plugin.py src/mkdocs_gitlab_review/assets/review.js
git commit -m "feat: mount ReviewPanel when review mode activates"
```

---

## Task 6: Push to main + tag release

- [ ] **Step 1: Final test run**

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
pnpm test
pytest
```

Both: green.

- [ ] **Step 2: Merge to main and push**

```bash
git checkout main
git merge --ff-only feat/review-panel-readonly || git merge --no-ff feat/review-panel-readonly -m "Merge feat/review-panel-readonly into main"
git push origin main
```

Verify GitHub Actions CI passes.

- [ ] **Step 3: Tag release**

```bash
git tag v0.4.0 -m "v0.4.0: add read-only ReviewPanel (5 blocks + mobile chip bar)"
git push origin v0.4.0
```

- [ ] **Step 4: Delete feature branch locally**

```bash
git branch -d feat/review-panel-readonly
```

---

## Self-Review

Spec coverage:

| Spec item | Addressed by |
|---|---|
| 5 blocks: Reviewers, Approvals, Files, Assignees, Actions | Task 2 |
| Skeleton on load → content | Task 1 + 2 |
| Per-block error with retry | Task 2 |
| Parallel fan-out fetch | Task 2 |
| Desktop vertical stack above ToC | Task 5 (mount to `.md-sidebar--secondary`) |
| Mobile chip bar + bottom sheet | Task 3 |
| Read-only action buttons link to GitLab | Task 2 (render*Block functions use `mrWebUrl`) |
| Panel CSS | Task 4 |
| Injection via plugin.py | Task 4 + 5 |
| `review.js` mounts/unmounts | Task 5 |
| Works without approval rules | Task 2 — `renderApprovalsBlock` handles `required === 0 && rules.length === 0` |

Explicit deferrals (per MR #2 scope):

- No interactivity — Approve/Merge/Close all link to GitLab. MR #3 replaces.
- No reviewer/assignee add/remove UI. MR #3 adds.
- No "viewed" checkboxes for files. MR #3 adds.
- No confirm dialogs. MR #3 adds.

Placeholder scan: no "TBD", no "similar to Task N", no "add error handling" without code.

Type consistency:

- `api.getMR(iid)` returns `{iid, reviewers, assignees, source_branch, target_branch, state, web_url}` — consistent between tests and impl.
- `api.getApprovalState(iid)` returns `{required, approved_by, rules}` — matches MR #1's api.js contract.
- `api.getChangedFiles(iid)` returns `[{path, status, additions, deletions}]` — matches MR #1.
- `ReviewPanel.mount(container, opts) → {unmount, refresh}` — consistent throughout.

**Known limitation flagged for engineer:** The `renderReviewersBlock` uses `mr.reviewers` / `mr.assignees` — GitLab's MR response shape. If the MR endpoint response for your instance has these as `null` (no reviewers assigned), the code handles it via the `!mr.reviewers || .length === 0` guard. However, if your instance returns reviewers in a nested shape like `mr.reviewers_data.users`, you may need to adjust `renderReviewersBlock` accordingly. Check your GitLab instance's API response before assuming.
