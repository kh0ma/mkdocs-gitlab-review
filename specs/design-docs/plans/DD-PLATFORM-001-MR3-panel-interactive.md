# DD-PLATFORM-001 — MR #3: Panel interactivity (approve, merge, close, reviewer/assignee management)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only action links in the ReviewPanel with real interactive controls: Approve/Revoke, Merge (with confirm dialog + source-branch-delete checkbox), Close (with confirm), Delete source branch, Add/Remove reviewers & assignees, "viewed" checkboxes for changed files.

**Architecture:** Extend `panel.js` with interactive handlers + optimistic UI + rollback. Extend `api.js` with remaining write methods (`mergeMR`, `closeMR`, `deleteSourceBranch`, `markFileViewed` wiring, `getPipelineStatus`). Add member-search popover (shared by reviewer/assignee widgets) and `<dialog>`-based confirm for destructive actions. Toast system for success/failure notifications.

**Tech Stack:** Extends MR #1 + MR #2. No new runtime deps. Vitest + happy-dom harness already in place.

**Working directory:** `/Users/olek/Development/repos/local/mkdocs-gitlab-review`.

**Prerequisites:** MR #1 (`v0.3.0`) and MR #2 (`v0.4.0`) both merged to `main`.

**Before starting:**

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
git checkout main && git pull --ff-only origin main
git checkout -b feat/panel-interactivity
# Sanity
test -f src/mkdocs_gitlab_review/assets/panel.js || echo "MR #2 missing — abort"
pnpm test
pytest
```

---

## File Structure

| File | Status | Purpose |
|---|---|---|
| `src/mkdocs_gitlab_review/assets/api.js` | modify | Add `mergeMR`, `closeMR`, `reopenMR`, `deleteSourceBranch`, `getPipelineStatus` methods. |
| `src/mkdocs_gitlab_review/assets/panel.js` | modify | Replace read-only links with real handlers. Add: confirm dialogs, member-search popover, viewed-checkboxes, toast notifications. |
| `src/mkdocs_gitlab_review/assets/panel.css` | modify | Styles for popover, confirm dialog, toast, disabled button states. |
| `tests/js/api.test.js` | modify | Add tests for new API methods. |
| `tests/js/panel.test.js` | modify | Add interactive flow tests. |
| `tests/js/mr-actions.test.js` | **NEW** | Focused tests for Merge/Close gating, confirm dialogs, rollback. |

No plugin.py changes — just code edits to existing asset files.

---

## Task 1: Extend `api.js` with write methods

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/api.js`
- Modify: `tests/js/api.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/js/api.test.js` inside the `describe("GitlabAPI")` block:

```js
  it("mergeMR PUTs to /merge with default options", async () => {
    fetchMock.mockResolvedValueOnce({ id: 1, state: "merged" });
    await window.GitlabAPI.mergeMR(7, { sha: "abc123", shouldRemoveSourceBranch: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7/merge",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ sha: "abc123", should_remove_source_branch: true }),
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("mergeMR supports squash option", async () => {
    fetchMock.mockResolvedValueOnce({});
    await window.GitlabAPI.mergeMR(7, { sha: "abc", shouldRemoveSourceBranch: false, squash: true });
    const call = fetchMock.mock.calls[0][1];
    expect(JSON.parse(call.body)).toMatchObject({
      sha: "abc",
      should_remove_source_branch: false,
      squash: true,
    });
  });

  it("closeMR PUTs state_event=close", async () => {
    fetchMock.mockResolvedValueOnce({ state: "closed" });
    await window.GitlabAPI.closeMR(7);
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ state_event: "close" }),
      })
    );
  });

  it("reopenMR PUTs state_event=reopen", async () => {
    fetchMock.mockResolvedValueOnce({ state: "opened" });
    await window.GitlabAPI.reopenMR(7);
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ state_event: "reopen" }),
      })
    );
  });

  it("deleteSourceBranch DELETEs /repository/branches/:branch", async () => {
    fetchMock.mockResolvedValueOnce({});
    await window.GitlabAPI.deleteSourceBranch("feat/x");
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/repository/branches/" + encodeURIComponent("feat/x"),
      { method: "DELETE" }
    );
  });

  it("getPipelineStatus returns head pipeline state", async () => {
    fetchMock.mockResolvedValueOnce({
      pipeline: { status: "success", web_url: "https://g/p/-/pipelines/1" },
    });
    const status = await window.GitlabAPI.getPipelineStatus(7);
    expect(status).toEqual({ status: "success", web_url: "https://g/p/-/pipelines/1" });
  });

  it("getPipelineStatus returns null-shape when no pipeline", async () => {
    fetchMock.mockResolvedValueOnce({ pipeline: null });
    const status = await window.GitlabAPI.getPipelineStatus(7);
    expect(status).toEqual({ status: null, web_url: null });
  });
```

- [ ] **Step 2: Run tests — new ones fail**

```bash
pnpm test tests/js/api.test.js
```

Expected: existing api tests pass; 7 new tests fail.

- [ ] **Step 3: Implement the new methods in `api.js`**

Inside the `GitlabAPI` object in `src/mkdocs_gitlab_review/assets/api.js`, add these methods (append before the closing `};`):

```js
    mergeMR: function (iid, opts) {
      opts = opts || {};
      var body = {};
      if (opts.sha) body.sha = opts.sha;
      if (typeof opts.shouldRemoveSourceBranch === "boolean") {
        body.should_remove_source_branch = opts.shouldRemoveSourceBranch;
      }
      if (opts.squash) body.squash = true;
      return apiFetch(projectPath("/merge_requests/" + iid + "/merge"), {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
    },

    closeMR: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid), {
        method: "PUT",
        body: JSON.stringify({ state_event: "close" }),
        headers: { "Content-Type": "application/json" },
      });
    },

    reopenMR: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid), {
        method: "PUT",
        body: JSON.stringify({ state_event: "reopen" }),
        headers: { "Content-Type": "application/json" },
      });
    },

    deleteSourceBranch: function (branch) {
      return apiFetch(
        projectPath("/repository/branches/" + encodeURIComponent(branch)),
        { method: "DELETE" }
      );
    },

    getPipelineStatus: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid)).then(function (mr) {
        var p = mr && mr.pipeline;
        return {
          status: p ? p.status : null,
          web_url: p ? p.web_url : null,
        };
      });
    },
```

- [ ] **Step 4: Run tests — green**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/api.js tests/js/api.test.js
git commit -m "feat(api): add merge/close/reopen/deleteSourceBranch/pipelineStatus methods"
```

---

## Task 2: Add toast + confirm dialog infrastructure

Shared UI primitives used by every interactive flow. Build once, use everywhere.

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js` (add helpers at top of IIFE)
- Modify: `src/mkdocs_gitlab_review/assets/panel.css` (toast + confirm dialog styles)

- [ ] **Step 1: Add helpers to panel.js (inside IIFE, before BLOCK_DEFS)**

Add these functions after `escapeHtml` in `panel.js`:

```js
  // -------- Toasts --------

  function showToast(message, type) {
    type = type || "info";
    var host = document.getElementById("glr-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "glr-toast-host";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    var toast = document.createElement("div");
    toast.className = "glr-toast glr-toast--" + type;
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(function () {
      toast.classList.add("glr-toast--leaving");
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 4000);
  }

  // -------- Confirm dialog --------

  function confirmDialog(opts) {
    // opts: {title, body, confirmLabel, cancelLabel, danger, extraFields}
    // extraFields: array of {name, label, type, default} rendered inside the dialog
    // Returns Promise<result | null> where result = {[fieldName]: value, ...} on confirm, null on cancel
    return new Promise(function (resolve) {
      var dlg = document.createElement("dialog");
      dlg.className = "glr-confirm" + (opts.danger ? " glr-confirm--danger" : "");

      var fieldsHtml = "";
      (opts.extraFields || []).forEach(function (f) {
        if (f.type === "checkbox") {
          fieldsHtml += '<label class="glr-confirm__field">' +
            '<input type="checkbox" name="' + escapeHtml(f.name) + '"' + (f.default ? " checked" : "") + '>' +
            ' <span>' + escapeHtml(f.label) + '</span>' +
            '</label>';
        }
      });

      dlg.innerHTML =
        '<h3 class="glr-confirm__title">' + escapeHtml(opts.title || "Підтвердіть дію") + '</h3>' +
        '<p class="glr-confirm__body">' + escapeHtml(opts.body || "") + '</p>' +
        fieldsHtml +
        '<div class="glr-confirm__buttons">' +
        '<button type="button" class="glr-confirm__cancel">' + escapeHtml(opts.cancelLabel || "Скасувати") + '</button>' +
        '<button type="button" class="glr-confirm__ok">' + escapeHtml(opts.confirmLabel || "OK") + '</button>' +
        '</div>';
      document.body.appendChild(dlg);

      function close(result) {
        if (typeof dlg.close === "function") { try { dlg.close(); } catch (e) {} }
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        resolve(result);
      }

      dlg.querySelector(".glr-confirm__cancel").addEventListener("click", function () { close(null); });
      dlg.querySelector(".glr-confirm__ok").addEventListener("click", function () {
        var result = {};
        (opts.extraFields || []).forEach(function (f) {
          var input = dlg.querySelector('[name="' + f.name + '"]');
          if (!input) return;
          if (f.type === "checkbox") result[f.name] = input.checked;
        });
        close(result);
      });
      dlg.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
      });

      if (typeof dlg.showModal === "function") {
        try { dlg.showModal(); } catch (e) { /* noop */ }
      } else {
        dlg.setAttribute("open", "");
      }
    });
  }
```

- [ ] **Step 2: Add CSS to panel.css**

Append:

```css
/* Toast */

#glr-toast-host {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 11000;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  pointer-events: none;
}

.glr-toast {
  pointer-events: auto;
  min-width: 16rem;
  max-width: 22rem;
  padding: 0.6rem 0.8rem;
  border-radius: 0.5rem;
  background: rgba(33, 37, 41, 0.92);
  color: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  font-size: 0.85rem;
  animation: glr-toast-in 180ms ease-out;
}

.glr-toast--error { background: rgba(207, 34, 46, 0.95); }
.glr-toast--success { background: rgba(31, 136, 61, 0.95); }
.glr-toast--leaving { opacity: 0; transition: opacity 220ms; }

@keyframes glr-toast-in {
  from { transform: translateY(0.5rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* Confirm dialog */

.glr-confirm[open] {
  max-width: 22rem;
  padding: 1rem;
  border: 0;
  border-radius: 0.5rem;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  background: var(--md-default-bg-color, #fff);
}
.glr-confirm::backdrop { background: rgba(0, 0, 0, 0.35); }

.glr-confirm__title { margin: 0 0 0.5rem; font-size: 1rem; }
.glr-confirm__body { margin: 0 0 0.75rem; font-size: 0.85rem; }

.glr-confirm__field {
  display: flex; align-items: center; gap: 0.4rem;
  margin-bottom: 0.5rem; font-size: 0.85rem;
}

.glr-confirm__buttons {
  display: flex; gap: 0.4rem; justify-content: flex-end; margin-top: 0.75rem;
}

.glr-confirm__cancel,
.glr-confirm__ok {
  padding: 0.4rem 0.8rem;
  border-radius: 0.25rem;
  border: 0;
  font: inherit;
  cursor: pointer;
}

.glr-confirm__cancel { background: rgba(0, 0, 0, 0.08); }
.glr-confirm__ok {
  background: var(--md-primary-fg-color, #0d7377);
  color: #fff;
}

.glr-confirm--danger .glr-confirm__ok { background: #cf222e; }
```

- [ ] **Step 3: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js src/mkdocs_gitlab_review/assets/panel.css
git commit -m "feat(panel): add toast + confirm dialog helpers"
```

---

## Task 3: Approve/Revoke interactive with optimistic UI

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js`
- Modify: `tests/js/panel.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/js/panel.test.js`:

```js
describe("ReviewPanel — Approve interactivity", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = {
      getMR: vi.fn().mockResolvedValue({
        iid: 7, reviewers: [], assignees: [], state: "opened",
        web_url: "https://g/p/-/merge_requests/7",
      }),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      getApprovalState: vi.fn()
        .mockResolvedValueOnce({ required: 2, approved_by: [], rules: [] })
        .mockResolvedValueOnce({ required: 2, approved_by: [{ username: "me" }], rules: [] }),
      approve: vi.fn().mockResolvedValue({}),
      revokeApproval: vi.fn().mockResolvedValue({}),
      getViewedFiles: vi.fn().mockReturnValue(new Set()),
      _currentUser: { username: "me" },
    };
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://git.example.com", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("Approvals block has a real button when opts.currentUser set", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 10));
    const block = container.querySelector('[data-block="approvals"]');
    const btn = block.querySelector("button.glr-panel__approve-btn");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/approve/i);
  });

  it("clicking Approve calls api.approve and flips to Revoke on success", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 10));
    const btn = container.querySelector("button.glr-panel__approve-btn");
    btn.click();
    await new Promise(r => setTimeout(r, 20));
    expect(api.approve).toHaveBeenCalledWith(7);
    const btnAfter = container.querySelector("button.glr-panel__approve-btn");
    expect(btnAfter.textContent).toMatch(/revoke/i);
  });

  it("failed Approve rolls back UI and shows error toast", async () => {
    api.approve = vi.fn().mockRejectedValue({ status: 500, message: "boom" });
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 10));
    const btn = container.querySelector("button.glr-panel__approve-btn");
    btn.click();
    await new Promise(r => setTimeout(r, 20));
    // Button back to "Approve" (not "Revoke") after rollback
    const btnAfter = container.querySelector("button.glr-panel__approve-btn");
    expect(btnAfter.textContent).toMatch(/approve/i);
    // Toast visible
    expect(document.querySelector(".glr-toast--error")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — fail**

```bash
pnpm test tests/js/panel.test.js
```

- [ ] **Step 3: Replace `renderApprovalsBlock` to accept context and render real button**

In `panel.js`, modify `renderApprovalsBlock` signature to `(approvals, mr, ctx)` where `ctx = {api, mrIid, currentUser, onChange}`. Replace the read-only `<a>` link with a button that wires up click handler.

Find the existing `renderApprovalsBlock` and replace its body:

```js
  function renderApprovalsBlock(approvals, mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    var approved = (approvals.approved_by || []);
    var required = approvals.required || 0;

    var html = "";
    if (required === 0 && (!approvals.rules || approvals.rules.length === 0)) {
      html += '<p class="glr-panel__empty">No approval rules configured</p>';
    } else {
      html += '<p class="glr-panel__approvals-counter"><strong>' +
        approved.length + '</strong> of <strong>' + required + '</strong> approvals</p>';
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

    body.innerHTML = html;

    // Interactive Approve / Revoke
    if (ctx && ctx.api && ctx.currentUser) {
      var alreadyApproved = approved.some(function (u) {
        return u.username === ctx.currentUser.username;
      });
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "glr-panel__approve-btn";
      btn.textContent = alreadyApproved ? "Revoke approval" : "Approve";
      if (alreadyApproved) btn.classList.add("glr-panel__approve-btn--approved");
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        var wasApproved = alreadyApproved;
        btn.disabled = true;
        btn.textContent = wasApproved ? "Revoking…" : "Approving…";
        var call = wasApproved ? ctx.api.revokeApproval(ctx.mrIid) : ctx.api.approve(ctx.mrIid);
        call
          .then(function () {
            showToast(wasApproved ? "Схвалення відкликано" : "Схвалено", "success");
            if (ctx.onChange) ctx.onChange();
          })
          .catch(function (err) {
            // Rollback
            btn.disabled = false;
            btn.textContent = wasApproved ? "Revoke approval" : "Approve";
            showToast("Не вдалося: " + (err && err.message || "помилка"), "error");
          });
      });
      body.appendChild(btn);
    } else {
      // Fallback: link to GitLab (when no currentUser provided)
      var a = document.createElement("a");
      a.className = "glr-panel__action-link glr-panel__action-link--primary";
      a.href = mrWebUrl(mr.iid);
      a.textContent = "Approve in GitLab";
      body.appendChild(a);
    }
    return body;
  }
```

- [ ] **Step 4: Thread `currentUser` and `onChange` through `mount`**

In `mount`, capture `opts.currentUser` and `opts.onChange`, and pass them into the render ctx:

Change the `Promise.all(...).then(function (results) { ... })` block — inside, where we call `renderApprovalsBlock(approvals, mr)`, change to `renderApprovalsBlock(approvals, mr.__error ? { iid: mrIid } : mr, { api: api, mrIid: mrIid, currentUser: opts.currentUser, onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); } })`.

- [ ] **Step 5: Run tests — pass**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js tests/js/panel.test.js
git commit -m "feat(panel): interactive Approve/Revoke with optimistic UI + rollback"
```

---

## Task 4: Get current user — integrate into review.js mount call

For Approve to know whether the user already approved, we need the current user's username. GitLab exposes this via `GET /user`.

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/api.js` (add `getCurrentUser`)
- Modify: `src/mkdocs_gitlab_review/assets/review.js` (fetch user, pass to panel)
- Modify: `tests/js/api.test.js`

- [ ] **Step 1: Add failing test**

In `tests/js/api.test.js`:

```js
  it("getCurrentUser GETs /user", async () => {
    fetchMock.mockResolvedValueOnce({ id: 9, username: "me", name: "Me" });
    const u = await window.GitlabAPI.getCurrentUser();
    expect(fetchMock).toHaveBeenCalledWith("/user");
    expect(u.username).toBe("me");
  });
```

- [ ] **Step 2: Add to `api.js`**

Inside `GitlabAPI`:

```js
    getCurrentUser: function () {
      return apiFetch("/user");
    },
```

Note: `/user` is not project-scoped. `apiFetch` takes the path as-is.

- [ ] **Step 3: Fetch user in review.js before mounting panel**

In `review.js`, inside `activateReview`, before the `ReviewPanel.mount(...)` call, fetch the user:

```js
      window.GitlabAPI.getCurrentUser()
        .then(function (user) {
          state.panelHandle = window.ReviewPanel.mount(rail, {
            mrIid: state.mrIid,
            api: window.GitlabAPI,
            currentUser: user,
          });
        })
        .catch(function () {
          // No user → mount in read-only mode (buttons link to GitLab).
          state.panelHandle = window.ReviewPanel.mount(rail, {
            mrIid: state.mrIid,
            api: window.GitlabAPI,
          });
        });
```

- [ ] **Step 4: Run tests**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/api.js src/mkdocs_gitlab_review/assets/review.js tests/js/api.test.js
git commit -m "feat: fetch current user for authenticated panel interactions"
```

---

## Task 5: Merge + Close + Delete source branch

The most impactful actions — require confirm dialogs and optimistic UI. Keep them in one task because they share confirm-dialog plumbing and actions block render.

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js`
- Create: `tests/js/mr-actions.test.js`

- [ ] **Step 1: Create failing test file**

```js
import { describe, it, expect, beforeEach, vi } from "vitest";

function makeApi(overrides) {
  return Object.assign({
    getMR: vi.fn().mockResolvedValue({
      iid: 7,
      reviewers: [], assignees: [],
      state: "opened",
      source_branch: "feat/x",
      web_url: "https://g/p/-/merge_requests/7",
      has_conflicts: false,
      diff_refs: { head_sha: "abc123" },
    }),
    getChangedFiles: vi.fn().mockResolvedValue([]),
    getApprovalState: vi.fn().mockResolvedValue({ required: 1, approved_by: [{ username: "me" }], rules: [] }),
    getPipelineStatus: vi.fn().mockResolvedValue({ status: "success", web_url: "https://p" }),
    getViewedFiles: vi.fn().mockReturnValue(new Set()),
    mergeMR: vi.fn().mockResolvedValue({ state: "merged" }),
    closeMR: vi.fn().mockResolvedValue({ state: "closed" }),
    deleteSourceBranch: vi.fn().mockResolvedValue({}),
  }, overrides);
}

describe("MR Actions — Merge gating", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = makeApi();
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://g", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("Merge button enabled when pipeline success + approvals met + no conflicts", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    const btn = container.querySelector("button.glr-panel__merge-btn");
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
  });

  it("Merge button disabled when pipeline failing, with tooltip", async () => {
    api.getPipelineStatus = vi.fn().mockResolvedValue({ status: "failed", web_url: "https://p" });
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    const btn = container.querySelector("button.glr-panel__merge-btn");
    expect(btn.disabled).toBe(true);
    expect(btn.title.toLowerCase()).toContain("pipeline");
  });

  it("Merge disabled when approvals not met", async () => {
    api.getApprovalState = vi.fn().mockResolvedValue({ required: 2, approved_by: [], rules: [] });
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    const btn = container.querySelector("button.glr-panel__merge-btn");
    expect(btn.disabled).toBe(true);
    expect(btn.title.toLowerCase()).toMatch(/approval/);
  });

  it("Merge disabled with conflicts", async () => {
    api.getMR = vi.fn().mockResolvedValue({
      iid: 7, reviewers: [], assignees: [], state: "opened",
      source_branch: "feat/x", web_url: "https://g/p/-/merge_requests/7",
      has_conflicts: true, diff_refs: { head_sha: "abc" },
    });
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    const btn = container.querySelector("button.glr-panel__merge-btn");
    expect(btn.disabled).toBe(true);
    expect(btn.title.toLowerCase()).toContain("conflict");
  });
});

describe("MR Actions — Merge flow", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = makeApi();
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://g", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("click Merge opens confirm dialog", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector("button.glr-panel__merge-btn").click();
    expect(document.querySelector(".glr-confirm")).not.toBeNull();
  });

  it("confirm dialog has 'delete source branch' checkbox checked by default", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector("button.glr-panel__merge-btn").click();
    const cb = document.querySelector(".glr-confirm input[name='delete_source_branch']");
    expect(cb).not.toBeNull();
    expect(cb.checked).toBe(true);
  });

  it("confirm + OK calls api.mergeMR with sha and delete=true", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector("button.glr-panel__merge-btn").click();
    document.querySelector(".glr-confirm__ok").click();
    await new Promise(r => setTimeout(r, 20));
    expect(api.mergeMR).toHaveBeenCalledWith(7, {
      sha: "abc123",
      shouldRemoveSourceBranch: true,
    });
  });

  it("failed merge shows error toast + rolls back", async () => {
    api.mergeMR = vi.fn().mockRejectedValue({ status: 409, message: "conflicts appeared" });
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector("button.glr-panel__merge-btn").click();
    document.querySelector(".glr-confirm__ok").click();
    await new Promise(r => setTimeout(r, 20));
    expect(document.querySelector(".glr-toast--error")).not.toBeNull();
    // Merge button back to enabled
    const btn = container.querySelector("button.glr-panel__merge-btn");
    expect(btn.disabled).toBe(false);
  });
});

describe("MR Actions — Close flow", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = makeApi();
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://g", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("Close button visible on Opened MR", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector("button.glr-panel__close-btn")).not.toBeNull();
  });

  it("Close click opens confirm then calls api.closeMR on OK", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector("button.glr-panel__close-btn").click();
    document.querySelector(".glr-confirm__ok").click();
    await new Promise(r => setTimeout(r, 20));
    expect(api.closeMR).toHaveBeenCalledWith(7);
  });
});

describe("MR Actions — Delete source branch", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = makeApi({
      getMR: vi.fn().mockResolvedValue({
        iid: 7, reviewers: [], assignees: [],
        state: "merged", source_branch: "feat/x",
        web_url: "https://g/p/-/merge_requests/7",
      }),
    });
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://g", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("Delete source branch button visible on merged MR with existing source branch", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector("button.glr-panel__delete-branch-btn")).not.toBeNull();
  });

  it("click calls api.deleteSourceBranch(branch) after confirm", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector("button.glr-panel__delete-branch-btn").click();
    document.querySelector(".glr-confirm__ok").click();
    await new Promise(r => setTimeout(r, 20));
    expect(api.deleteSourceBranch).toHaveBeenCalledWith("feat/x");
  });
});
```

- [ ] **Step 2: Run — fails**

```bash
pnpm test tests/js/mr-actions.test.js
```

- [ ] **Step 3: Rewrite `renderActionsBlock` for interactivity + pipeline fetch**

In `panel.js`, replace `renderActionsBlock`:

```js
  function renderActionsBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";

    if (mr.state === "opened") {
      // Merge button — enable only when: pipeline passing + approvals met + no conflicts
      var mergeBtn = document.createElement("button");
      mergeBtn.type = "button";
      mergeBtn.className = "glr-panel__merge-btn glr-panel__action-link--primary";
      mergeBtn.textContent = "Merge MR";

      var disabledReasons = [];
      if (mr.has_conflicts) disabledReasons.push("Merge conflicts");
      if (ctx && ctx.pipelineStatus && ctx.pipelineStatus.status &&
          ctx.pipelineStatus.status !== "success" &&
          ctx.pipelineStatus.status !== "manual" &&
          ctx.pipelineStatus.status !== "skipped") {
        disabledReasons.push("Pipeline not passing (" + ctx.pipelineStatus.status + ")");
      }
      if (ctx && ctx.approvals &&
          (ctx.approvals.approved_by || []).length < (ctx.approvals.required || 0)) {
        disabledReasons.push("Approvals not met");
      }
      if (disabledReasons.length > 0) {
        mergeBtn.disabled = true;
        mergeBtn.title = disabledReasons.join("; ");
      }
      mergeBtn.addEventListener("click", function () {
        if (mergeBtn.disabled) return;
        confirmDialog({
          title: "Підтвердіть merge",
          body: "Об'єднати " + mr.source_branch + " → " + (mr.target_branch || "target") + "?",
          confirmLabel: "Merge",
          cancelLabel: "Скасувати",
          extraFields: [
            { name: "delete_source_branch", type: "checkbox", label: "Видалити source branch після merge", default: true },
          ],
        }).then(function (result) {
          if (!result) return;
          mergeBtn.disabled = true;
          mergeBtn.textContent = "Merging…";
          ctx.api.mergeMR(ctx.mrIid, {
            sha: mr.diff_refs && mr.diff_refs.head_sha,
            shouldRemoveSourceBranch: !!result.delete_source_branch,
          }).then(function () {
            showToast("MR замерджено", "success");
            if (ctx.onChange) ctx.onChange();
          }).catch(function (err) {
            mergeBtn.disabled = false;
            mergeBtn.textContent = "Merge MR";
            showToast("Merge failed: " + (err && err.message || "помилка"), "error");
          });
        });
      });
      body.appendChild(mergeBtn);

      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "glr-panel__close-btn glr-panel__action-link";
      closeBtn.textContent = "Close MR";
      closeBtn.addEventListener("click", function () {
        confirmDialog({
          title: "Закрити MR?",
          body: "Закриття MR без merge. Можна буде переобрати у GitLab.",
          confirmLabel: "Закрити",
          danger: true,
        }).then(function (result) {
          if (!result) return;
          closeBtn.disabled = true;
          closeBtn.textContent = "Closing…";
          ctx.api.closeMR(ctx.mrIid).then(function () {
            showToast("MR закрито", "success");
            if (ctx.onChange) ctx.onChange();
          }).catch(function (err) {
            closeBtn.disabled = false;
            closeBtn.textContent = "Close MR";
            showToast("Close failed: " + (err && err.message || "помилка"), "error");
          });
        });
      });
      body.appendChild(closeBtn);
    } else if (mr.state === "merged") {
      var mergedBadge = document.createElement("p");
      mergedBadge.className = "glr-panel__state-badge glr-panel__state-badge--merged";
      mergedBadge.textContent = "Merged";
      body.appendChild(mergedBadge);

      if (mr.source_branch) {
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "glr-panel__delete-branch-btn glr-panel__action-link";
        delBtn.textContent = "Видалити source branch (" + mr.source_branch + ")";
        delBtn.addEventListener("click", function () {
          confirmDialog({
            title: "Видалити source branch?",
            body: "Галка '" + mr.source_branch + "' буде видалена з origin. Дію неможливо відмінити.",
            confirmLabel: "Видалити",
            danger: true,
          }).then(function (result) {
            if (!result) return;
            delBtn.disabled = true;
            delBtn.textContent = "Видалення…";
            ctx.api.deleteSourceBranch(mr.source_branch).then(function () {
              showToast("Branch видалено", "success");
              delBtn.remove();
            }).catch(function (err) {
              delBtn.disabled = false;
              delBtn.textContent = "Видалити source branch (" + mr.source_branch + ")";
              showToast("Delete failed: " + (err && err.message || "помилка"), "error");
            });
          });
        });
        body.appendChild(delBtn);
      }
    } else if (mr.state === "closed") {
      var closedBadge = document.createElement("p");
      closedBadge.className = "glr-panel__state-badge glr-panel__state-badge--closed";
      closedBadge.textContent = "Closed";
      body.appendChild(closedBadge);

      var openLink = document.createElement("a");
      openLink.className = "glr-panel__action-link";
      openLink.href = mrWebUrl(mr.iid);
      openLink.textContent = "Open in GitLab";
      body.appendChild(openLink);
    }
    return body;
  }
```

- [ ] **Step 4: Fetch pipeline status in mount + pass context**

In `mount`, extend `fetchAndRender` to also fetch pipeline status and pass to `renderActionsBlock`:

Change the `Promise.all` to include pipeline:

```js
      Promise.all([
        mrPromise.catch(function (e) { return { __error: e }; }),
        approvalsPromise.catch(function (e) { return { __error: e }; }),
        api.getPipelineStatus(mrIid).catch(function () { return { status: null, web_url: null }; }),
      ]).then(function (results) {
        if (unmounted) return;
        var mr = results[0];
        var approvals = results[1];
        var pipeline = results[2];

        // Reviewers (unchanged except passing ctx for later tasks)
        if (mr.__error) {
          replaceBody(blockEls.reviewers, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("reviewers", "⚠");
        } else {
          replaceBody(blockEls.reviewers, renderReviewersBlock(mr, {
            approvals: approvals.__error ? null : approvals,
            api: api, mrIid: mrIid, currentUser: opts.currentUser,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("reviewers", String((mr.reviewers || []).length));
        }

        // Approvals
        if (approvals.__error) {
          replaceBody(blockEls.approvals, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("approvals", "⚠");
        } else {
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, mr.__error ? { iid: mrIid } : mr, {
            api: api, mrIid: mrIid, currentUser: opts.currentUser,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("approvals", (approvals.approved_by || []).length + "/" + (approvals.required || 0));
        }

        // Assignees
        if (mr.__error) {
          replaceBody(blockEls.assignees, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("assignees", "⚠");
        } else {
          replaceBody(blockEls.assignees, renderAssigneesBlock(mr, {
            api: api, mrIid: mrIid,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("assignees", String((mr.assignees || []).length));
        }

        // Actions — now has pipeline + approvals context
        if (mr.__error) {
          replaceBody(blockEls.actions, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("actions", "⚠");
        } else {
          replaceBody(blockEls.actions, renderActionsBlock(mr, {
            api: api, mrIid: mrIid,
            approvals: approvals.__error ? null : approvals,
            pipelineStatus: pipeline,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("actions", mr.state === "opened" ? "●" : mr.state);
        }
      });
```

- [ ] **Step 5: Run tests — all pass**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js tests/js/mr-actions.test.js
git commit -m "feat(panel): interactive Merge/Close/Delete-branch with confirm + rollback"
```

---

## Task 6: Reviewers & Assignees add/remove with member-search popover

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js`
- Modify: `src/mkdocs_gitlab_review/assets/panel.css`
- Modify: `tests/js/panel.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/js/panel.test.js`:

```js
describe("ReviewPanel — Reviewers/Assignees interactivity", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = {
      getMR: vi.fn().mockResolvedValue({
        iid: 7, state: "opened",
        reviewers: [{ id: 1, username: "andriy", name: "Andriy" }],
        assignees: [],
        source_branch: "feat/x",
      }),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      getApprovalState: vi.fn().mockResolvedValue({ required: 0, approved_by: [], rules: [] }),
      getPipelineStatus: vi.fn().mockResolvedValue({ status: null, web_url: null }),
      getViewedFiles: vi.fn().mockReturnValue(new Set()),
      searchMembers: vi.fn().mockResolvedValue([
        { id: 2, username: "maria", name: "Maria" },
      ]),
      setReviewers: vi.fn().mockResolvedValue({}),
      setAssignees: vi.fn().mockResolvedValue({}),
    };
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://g", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("reviewer × button calls setReviewers without that user", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    const removeBtn = container.querySelector('[data-block="reviewers"] .glr-panel__user-remove');
    expect(removeBtn).not.toBeNull();
    removeBtn.click();
    await new Promise(r => setTimeout(r, 20));
    expect(api.setReviewers).toHaveBeenCalledWith(7, []);
  });

  it("add-reviewer button opens member search popover", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    const addBtn = container.querySelector('[data-block="reviewers"] .glr-panel__add-user');
    expect(addBtn).not.toBeNull();
    addBtn.click();
    await new Promise(r => setTimeout(r, 10));
    expect(document.querySelector(".glr-panel__member-popover")).not.toBeNull();
  });

  it("typing in search popover filters member list", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector('[data-block="reviewers"] .glr-panel__add-user').click();
    const input = document.querySelector(".glr-panel__member-popover__input");
    input.value = "ma";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    expect(api.searchMembers).toHaveBeenCalledWith("ma", expect.anything());
  });

  it("click on member in popover calls setReviewers with merged IDs", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api, currentUser: { username: "me" } });
    await new Promise(r => setTimeout(r, 20));
    container.querySelector('[data-block="reviewers"] .glr-panel__add-user').click();
    const input = document.querySelector(".glr-panel__member-popover__input");
    input.value = "ma";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const item = document.querySelector(".glr-panel__member-popover__item");
    item.click();
    await new Promise(r => setTimeout(r, 20));
    // Current reviewers: [andriy(1)]; adding maria(2) → [1, 2]
    expect(api.setReviewers).toHaveBeenCalledWith(7, [1, 2]);
  });
});
```

- [ ] **Step 2: Run — fails**

```bash
pnpm test tests/js/panel.test.js
```

- [ ] **Step 3: Implement member-search popover helper + rewrite renderReviewersBlock/renderAssigneesBlock**

Add to `panel.js` (after `confirmDialog`, before BLOCK_DEFS):

```js
  function openMemberPopover(anchor, opts) {
    // opts: {api, onSelect(user)}
    var existing = document.querySelector(".glr-panel__member-popover");
    if (existing) existing.remove();

    var pop = document.createElement("div");
    pop.className = "glr-panel__member-popover";
    pop.innerHTML =
      '<input type="text" class="glr-panel__member-popover__input" placeholder="Пошук користувача…" />' +
      '<ul class="glr-panel__member-popover__list" role="listbox"></ul>';
    document.body.appendChild(pop);
    var rect = anchor.getBoundingClientRect();
    pop.style.position = "absolute";
    pop.style.left = (rect.left + window.scrollX) + "px";
    pop.style.top = (rect.bottom + window.scrollY + 4) + "px";

    var input = pop.querySelector(".glr-panel__member-popover__input");
    var list = pop.querySelector(".glr-panel__member-popover__list");
    var timer = null;
    var sequence = 0;

    function render(members) {
      list.innerHTML = "";
      members.forEach(function (m) {
        var li = document.createElement("li");
        li.className = "glr-panel__member-popover__item";
        li.dataset.userId = m.id;
        var avatar = m.avatar_url
          ? '<img class="glr-panel__avatar" src="' + escapeHtml(m.avatar_url) + '" alt="">'
          : '<span class="glr-panel__avatar glr-panel__avatar--placeholder"></span>';
        li.innerHTML = avatar +
          '<span class="glr-panel__member-popover__name">' + escapeHtml(m.name || m.username) + '</span>' +
          '<span class="glr-panel__member-popover__username">@' + escapeHtml(m.username) + '</span>';
        li.addEventListener("click", function () {
          opts.onSelect(m);
          close();
        });
        list.appendChild(li);
      });
    }

    input.addEventListener("input", function () {
      var query = input.value;
      clearTimeout(timer);
      var mySeq = ++sequence;
      timer = setTimeout(function () {
        opts.api.searchMembers(query, { perPage: 10 }).then(function (members) {
          if (mySeq !== sequence) return;
          render(members || []);
        }).catch(function () {
          if (mySeq !== sequence) return;
          render([]);
        });
      }, 200);
    });

    function onOutsideClick(e) {
      if (!pop.contains(e.target) && e.target !== anchor) close();
    }
    function close() {
      document.removeEventListener("click", onOutsideClick);
      if (pop.parentNode) pop.parentNode.removeChild(pop);
    }
    setTimeout(function () {
      document.addEventListener("click", onOutsideClick);
    }, 0);
    input.focus();
  }
```

Now rewrite `renderReviewersBlock`:

```js
  function renderReviewersBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!mr.reviewers || mr.reviewers.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">Рецензентів не призначено</p>';
    } else {
      var approvedUsernames = new Set(
        (ctx && ctx.approvals && ctx.approvals.approved_by || []).map(function (u) { return u.username; })
      );
      var list = document.createElement("ul");
      list.className = "glr-panel__user-list";
      mr.reviewers.forEach(function (r) {
        var status = approvedUsernames.has(r.username) ? "approved" : "requested";
        var statusLabel = status === "approved" ? "✓ approved" : "⏳ requested";
        var li = document.createElement("li");
        li.className = "glr-panel__user-row glr-panel__user-row--" + status;
        var chipHtml = '<span class="glr-panel__user">' +
          (r.avatar_url
            ? '<img class="glr-panel__avatar" src="' + escapeHtml(r.avatar_url) + '" alt="">'
            : '<span class="glr-panel__avatar glr-panel__avatar--placeholder"></span>') +
          '<span class="glr-panel__user-name">' + escapeHtml(r.name || r.username) + '</span>' +
          '</span>';
        li.innerHTML = chipHtml +
          ' <span class="glr-panel__user-status">' + statusLabel + '</span>';
        if (ctx && ctx.api) {
          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.className = "glr-panel__user-remove";
          rmBtn.setAttribute("aria-label", "Видалити " + (r.name || r.username));
          rmBtn.textContent = "×";
          rmBtn.addEventListener("click", function () {
            var remaining = mr.reviewers.filter(function (u) { return u.id !== r.id; }).map(function (u) { return u.id; });
            ctx.api.setReviewers(ctx.mrIid, remaining).then(function () {
              if (ctx.onChange) ctx.onChange();
            }).catch(function (err) {
              showToast("Remove failed: " + (err && err.message || "помилка"), "error");
            });
          });
          li.appendChild(rmBtn);
        }
        list.appendChild(li);
      });
      body.appendChild(list);
    }

    if (ctx && ctx.api) {
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "glr-panel__add-user glr-panel__action-link";
      addBtn.textContent = "+ Запросити рев'ю";
      addBtn.addEventListener("click", function () {
        openMemberPopover(addBtn, {
          api: ctx.api,
          onSelect: function (user) {
            var ids = (mr.reviewers || []).map(function (u) { return u.id; });
            if (ids.indexOf(user.id) >= 0) return;
            ids.push(user.id);
            ctx.api.setReviewers(ctx.mrIid, ids).then(function () {
              if (ctx.onChange) ctx.onChange();
            }).catch(function (err) {
              showToast("Add failed: " + (err && err.message || "помилка"), "error");
            });
          },
        });
      });
      body.appendChild(addBtn);
    }
    return body;
  }
```

Rewrite `renderAssigneesBlock` symmetrically:

```js
  function renderAssigneesBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!mr.assignees || mr.assignees.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">Не призначено</p>';
    } else {
      var list = document.createElement("ul");
      list.className = "glr-panel__user-list";
      mr.assignees.forEach(function (a) {
        var li = document.createElement("li");
        li.className = "glr-panel__user-row";
        li.innerHTML = '<span class="glr-panel__user">' +
          (a.avatar_url
            ? '<img class="glr-panel__avatar" src="' + escapeHtml(a.avatar_url) + '" alt="">'
            : '<span class="glr-panel__avatar glr-panel__avatar--placeholder"></span>') +
          '<span class="glr-panel__user-name">' + escapeHtml(a.name || a.username) + '</span>' +
          '</span>';
        if (ctx && ctx.api) {
          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.className = "glr-panel__user-remove";
          rmBtn.textContent = "×";
          rmBtn.setAttribute("aria-label", "Видалити " + (a.name || a.username));
          rmBtn.addEventListener("click", function () {
            var remaining = mr.assignees.filter(function (u) { return u.id !== a.id; }).map(function (u) { return u.id; });
            ctx.api.setAssignees(ctx.mrIid, remaining).then(function () {
              if (ctx.onChange) ctx.onChange();
            }).catch(function (err) {
              showToast("Remove failed: " + (err && err.message || "помилка"), "error");
            });
          });
          li.appendChild(rmBtn);
        }
        list.appendChild(li);
      });
      body.appendChild(list);
    }

    if (ctx && ctx.api) {
      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "glr-panel__add-user glr-panel__action-link";
      addBtn.textContent = "+ Призначити";
      addBtn.addEventListener("click", function () {
        openMemberPopover(addBtn, {
          api: ctx.api,
          onSelect: function (user) {
            var ids = (mr.assignees || []).map(function (u) { return u.id; });
            if (ids.indexOf(user.id) >= 0) return;
            ids.push(user.id);
            ctx.api.setAssignees(ctx.mrIid, ids).then(function () {
              if (ctx.onChange) ctx.onChange();
            }).catch(function (err) {
              showToast("Add failed: " + (err && err.message || "помилка"), "error");
            });
          },
        });
      });
      body.appendChild(addBtn);
    }
    return body;
  }
```

- [ ] **Step 4: Add CSS for popover + × button**

Append to `panel.css`:

```css
.glr-panel__user-remove {
  margin-left: auto;
  width: 1.25rem;
  height: 1.25rem;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: rgba(0, 0, 0, 0.4);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}
.glr-panel__user-remove:hover { background: rgba(207, 34, 46, 0.12); color: #cf222e; }

.glr-panel__add-user { width: 100%; text-align: center; }

.glr-panel__member-popover {
  z-index: 10500;
  width: 18rem;
  background: var(--md-default-bg-color, #fff);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 0.375rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  padding: 0.4rem;
}

.glr-panel__member-popover__input {
  width: 100%;
  padding: 0.35rem 0.5rem;
  margin-bottom: 0.3rem;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 0.25rem;
  font: inherit;
}

.glr-panel__member-popover__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 14rem;
  overflow-y: auto;
}

.glr-panel__member-popover__item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.4rem;
  border-radius: 0.25rem;
  cursor: pointer;
}

.glr-panel__member-popover__item:hover { background: rgba(13, 115, 119, 0.1); }
.glr-panel__member-popover__username { margin-left: auto; color: rgba(0, 0, 0, 0.5); font-size: 0.78rem; }
```

- [ ] **Step 5: Run tests — pass**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js src/mkdocs_gitlab_review/assets/panel.css tests/js/panel.test.js
git commit -m "feat(panel): interactive reviewer/assignee add+remove with search popover"
```

---

## Task 7: "Viewed" checkboxes for changed files

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/panel.js`
- Modify: `src/mkdocs_gitlab_review/assets/api.js` — already has markFileViewed from MR #1
- Modify: `tests/js/panel.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/js/panel.test.js`:

```js
describe("ReviewPanel — Changed files viewed state", () => {
  let container, api;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount");
    api = {
      getMR: vi.fn().mockResolvedValue({
        iid: 7, state: "opened",
        reviewers: [], assignees: [],
        source_branch: "feat/x",
        diff_refs: { head_sha: "sha1" },
      }),
      getChangedFiles: vi.fn().mockResolvedValue([
        { path: "a.md", status: "modified", additions: 1, deletions: 0 },
        { path: "b.md", status: "modified", additions: 2, deletions: 1 },
      ]),
      getApprovalState: vi.fn().mockResolvedValue({ required: 0, approved_by: [], rules: [] }),
      getPipelineStatus: vi.fn().mockResolvedValue({ status: null }),
      getViewedFiles: vi.fn().mockReturnValue(new Set(["a.md:sha1"])),
      markFileViewed: vi.fn(),
    };
    window.__GITLAB_REVIEW__ = { gitlab_url: "https://g", project_id: "42" };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() });
    loadAsset("src/mkdocs_gitlab_review/assets/panel.js");
  });

  it("files block shows checkboxes with 'a.md' already checked from localStorage", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 20));
    const checkboxes = container.querySelectorAll('[data-block="files"] input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    // a.md checked, b.md not
    const a = Array.from(checkboxes).find(c => c.dataset.path === "a.md");
    const b = Array.from(checkboxes).find(c => c.dataset.path === "b.md");
    expect(a.checked).toBe(true);
    expect(b.checked).toBe(false);
  });

  it("files block shows 'N of M viewed' summary", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 20));
    const block = container.querySelector('[data-block="files"]');
    expect(block.textContent).toMatch(/1.*of.*2.*viewed/i);
  });

  it("checking a box calls api.markFileViewed", async () => {
    window.ReviewPanel.mount(container, { mrIid: 7, api });
    await new Promise(r => setTimeout(r, 20));
    const b = container.querySelector('input[data-path="b.md"]');
    b.checked = true;
    b.dispatchEvent(new Event("change", { bubbles: true }));
    expect(api.markFileViewed).toHaveBeenCalledWith(7, "b.md", "sha1");
  });
});
```

Note: we need the sha per-file for the key. The current `getChangedFiles` doesn't return it. For MR #3, use the MR's `diff_refs.head_sha` as a global per-MR sha (files change together per commit). That's a simplification — full per-file sha would require `/diffs` raw. We'll accept this trade-off and note it.

- [ ] **Step 2: Run — fails**

```bash
pnpm test tests/js/panel.test.js
```

- [ ] **Step 3: Implement**

Rewrite `renderFilesBlock` signature to `(files, viewed, mr, ctx)`:

```js
  function renderFilesBlock(files, viewed, mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!files || files.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">No changed files</p>';
      return body;
    }
    var headSha = (mr && mr.diff_refs && mr.diff_refs.head_sha) || "unknown";
    var viewedCount = 0;
    files.forEach(function (f) {
      if (viewed.has(f.path + ":" + headSha)) viewedCount++;
    });

    var summary = document.createElement("p");
    summary.className = "glr-panel__files-count";
    summary.innerHTML = '<strong>' + viewedCount + '</strong> of <strong>' + files.length + '</strong> viewed';
    body.appendChild(summary);

    var ul = document.createElement("ul");
    ul.className = "glr-panel__file-list";
    files.forEach(function (f) {
      var li = document.createElement("li");
      li.className = "glr-panel__file glr-panel__file--" + f.status;
      var key = f.path + ":" + headSha;
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "glr-panel__file-viewed";
      checkbox.dataset.path = f.path;
      checkbox.checked = viewed.has(key);
      checkbox.addEventListener("change", function () {
        if (ctx && ctx.api && ctx.api.markFileViewed && checkbox.checked) {
          ctx.api.markFileViewed(ctx.mrIid, f.path, headSha);
          var newCount = viewedCount + 1;
          summary.innerHTML = '<strong>' + newCount + '</strong> of <strong>' + files.length + '</strong> viewed';
          viewedCount = newCount;
        }
      });
      li.appendChild(checkbox);
      var statusIcon = { added: "●", modified: "◐", deleted: "✕", renamed: "→" }[f.status] || "◐";
      var labelHtml = ' <span class="glr-panel__file-status">' + statusIcon + '</span>' +
        ' <span class="glr-panel__file-path">' + escapeHtml(f.path) + '</span>' +
        ' <span class="glr-panel__file-stats">' +
        '<span class="glr-panel__additions">+' + f.additions + '</span> ' +
        '<span class="glr-panel__deletions">−' + f.deletions + '</span>' +
        '</span>';
      var span = document.createElement("span");
      span.innerHTML = labelHtml;
      li.appendChild(span);
      ul.appendChild(li);
    });
    body.appendChild(ul);
    return body;
  }
```

Update the `filesPromise.then(...)` in `mount` to pass `mr` and `ctx`:

```js
      filesPromise.then(function (files) {
        if (unmounted) return;
        var viewed = api.getViewedFiles ? api.getViewedFiles(mrIid) : new Set();
        // Need mr for headSha — use cached mr from the parallel fan-out if available
        Promise.resolve().then(function () {
          return api.getMR(mrIid);
        }).then(function (mrForSha) {
          replaceBody(blockEls.files, renderFilesBlock(files, viewed, mrForSha, {
            api: api, mrIid: mrIid,
          }));
          updateChipValue("files", String((files || []).length));
        });
      }).catch(function () { ... existing error handling ... });
```

Simpler and better — already fetching MR in parallel; wait for both:

Replace entire files-promise branch with:

```js
      Promise.all([mrPromise.catch(function () { return null; }), filesPromise])
        .then(function (results) {
          if (unmounted) return;
          var mrForSha = results[0];
          var files = results[1];
          var viewed = api.getViewedFiles ? api.getViewedFiles(mrIid) : new Set();
          replaceBody(blockEls.files, renderFilesBlock(files, viewed, mrForSha || { diff_refs: {} }, {
            api: api, mrIid: mrIid,
          }));
          updateChipValue("files", String((files || []).length));
        })
        .catch(function () {
          if (unmounted) return;
          replaceBody(blockEls.files, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("files", "⚠");
        });
```

- [ ] **Step 4: Run tests**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/panel.js tests/js/panel.test.js
git commit -m "feat(panel): add viewed-checkboxes for changed files (localStorage)"
```

---

## Task 8: Final sweep + push + tag

- [ ] **Step 1: Run everything**

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
pnpm test
pytest
```

Expected: fully green.

- [ ] **Step 2: Manual smoke test checklist**

Open a real MR preview in browser, activate review mode. Verify each:

- [ ] Approve button: click → flips to Revoke, counter increments
- [ ] Revoke → counter decrements
- [ ] Merge disabled with tooltip when pipeline failing; enabled when pass
- [ ] Merge click → confirm dialog with "Delete source branch" checkbox (default on)
- [ ] Merge confirm OK → toast "merged"
- [ ] Close click → confirm → toast "closed"
- [ ] × on reviewer → reviewer disappears, still gone after refresh
- [ ] + Запросити рев'ю → popover, type → list filters, click → reviewer added
- [ ] Viewed checkbox → `1 of N viewed` summary updates
- [ ] Mobile (resize to ≤768px) → chip bar, tap chip → sheet, click Approve in sheet → works

Document any failures as follow-up tasks (not blocking this MR).

- [ ] **Step 3: Merge to main + push**

```bash
git checkout main
git merge --ff-only feat/panel-interactivity || git merge --no-ff feat/panel-interactivity -m "Merge feat/panel-interactivity into main"
git push origin main
```

- [ ] **Step 4: Tag release**

```bash
git tag v0.5.0 -m "v0.5.0: interactive ReviewPanel — approve, merge, close, reviewer/assignee mgmt, viewed files"
git push origin v0.5.0
```

- [ ] **Step 5: Cleanup**

```bash
git branch -d feat/panel-interactivity
```

---

## Task 9: Bump plugin version in SDD Hub (separate repo)

**Files:**
- Modify: `/Users/olek/Development/repos/local/sdd-hub/.gitlab-ci.yml:27`

- [ ] **Step 1: Switch to SDD Hub repo**

```bash
cd /Users/olek/Development/repos/local/sdd-hub
git checkout main
git pull --ff-only origin main
git checkout -b chore/bump-plugin-v0.5.0
```

- [ ] **Step 2: Update pinned plugin version**

Edit `.gitlab-ci.yml` line 27. Find:

```
"mkdocs-gitlab-review @ https://github.com/kh0ma/mkdocs-gitlab-review/archive/refs/heads/main.zip"
```

Replace with:

```
"mkdocs-gitlab-review @ https://github.com/kh0ma/mkdocs-gitlab-review/archive/refs/tags/v0.5.0.zip"
```

- [ ] **Step 3: Commit**

```bash
git add .gitlab-ci.yml
git commit -m "chore: pin mkdocs-gitlab-review to v0.5.0 (full interactive panel)"
```

- [ ] **Step 4: Push + create MR on SDD Hub**

```bash
git push -u origin chore/bump-plugin-v0.5.0
```

Then use the `create-mr` skill or open via GitLab UI. Title: `chore: bump mkdocs-gitlab-review to v0.5.0`. Body summarizes what changed (panel, interactivity).

---

## Self-Review

Spec coverage for MR #3 scope:

| Spec criterion | Task |
|---|---|
| Approve/Revoke with optimistic UI + rollback + toast | Task 3 |
| Fetch current user | Task 4 |
| Merge button gated on pipeline + approvals + conflicts | Task 5 |
| Merge confirm dialog with "delete source branch" checkbox | Task 5 |
| Close confirm + state transition | Task 5 |
| Delete source branch (post-merge) | Task 5 |
| Failed merge rolls back UI | Task 5 (tested in mr-actions.test.js) |
| Reviewer × (remove) | Task 6 |
| Add reviewer via search popover | Task 6 |
| Assignee add/remove symmetric | Task 6 |
| Viewed checkboxes for files | Task 7 |
| `N of M viewed` summary | Task 7 |
| Version bump in SDD Hub | Task 9 |

Placeholder scan — no "TBD", no incomplete code, every handler has full impl.

Type consistency:

- `ctx` object passed to every render function has the shape `{api, mrIid, currentUser?, approvals?, pipelineStatus?, onChange}` — consistent across `renderReviewersBlock`, `renderApprovalsBlock`, `renderAssigneesBlock`, `renderActionsBlock`, `renderFilesBlock`.
- `opts.onChange` plumbed from `mount(container, opts)` through every block's `ctx.onChange`. Consistent.
- `api.markFileViewed(iid, path, sha)` — signature matches MR #1 definition + MR #3 use sites.

**Known trade-off noted inline:** the "viewed" state uses MR's head sha rather than per-file sha. This means changing one file invalidates the "viewed" state of all files in the MR. That's simpler to reason about (whole-MR refresh vs per-file) and matches how GitHub's "viewed" actually behaves after a force-push. Acceptable.

**One area that may need runtime adjustment:** the `openMemberPopover` positioning uses `anchor.getBoundingClientRect()`. If the panel is inside a scrolling sidebar, the popover may detach from the anchor on scroll. The code appends to `document.body` so scroll of the sidebar doesn't affect the popover, but scroll of the page does. For phase 1 this is acceptable (reviewer adds are short interactions); phase 2+ could use a scroll listener to reposition.

All three MR plans complete. Ready for execution.
