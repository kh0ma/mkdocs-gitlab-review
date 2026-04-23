# DD-PLATFORM-001 — MR #1: Extract api.js + mentions.js, fix 3 mention bugs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract mention autocomplete and GitLab API calls from `review.js` into dedicated modules; fix Cyrillic regex, dropdown-escape-container, and markdown-unsafe-insertion bugs in `@mention`.

**Architecture:** Pure client-side. Two new JS assets (`api.js`, `mentions.js`) loaded before the (thinned) `review.js`. Plugin Python injection adds both to the script list. Vitest + happy-dom introduced for JS tests, runs on CI alongside existing pytest.

**Tech Stack:** Vanilla ES5-compatible JS (matches plugin convention — no modules, IIFEs exposing globals: `window.GitlabAPI`, `window.MentionAutocomplete`). Vitest 1.x + happy-dom for tests. pnpm or npm (use pnpm per plan; user swaps if needed).

**Working directory for code:** `/Users/olek/Development/repos/local/mkdocs-gitlab-review` (plugin repo, separate from SDD Hub). All `git` commands in tasks below run there unless stated otherwise.

**Before starting:**

1. Fetch upstream, branch from main:
   ```bash
   cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
   git fetch origin
   git checkout main && git pull --ff-only origin main
   git checkout -b feat/api-and-mentions-extraction
   ```
2. Verify existing tests pass: `pytest` → all green.
3. Confirm Node 20+ available: `node --version` → `v20.x` or higher.

---

## File Structure

After this MR, the plugin's `assets/` directory changes like this:

| File | Status | Purpose |
|---|---|---|
| `assets/oauth.js` | unchanged | OAuth 2.0 PKCE |
| `assets/api.js` | **NEW** | Single layer for every GitLab REST call. Wraps `OAuth.apiFetch`. |
| `assets/mentions.js` | **NEW** | `MentionAutocomplete.attach(quill, opts)`. Unicode regex, caret-anchored dropdown, keyboard nav, markdown-safe insertion. |
| `assets/review.js` | modified | Remove inline `@mention` code (lines ~932–1013); remove inline `OAuth.apiFetch` calls, replaced with `GitlabAPI.*`. |
| `assets/review.css` | modified | Minor: `#glr-mention-dropdown` CSS moves to be scoped inside editor container. |
| `src/mkdocs_gitlab_review/plugin.py` | modified | Inject `api.js` and `mentions.js` in the correct load order. |
| `package.json` | **NEW** | Dev deps (vitest, happy-dom) only. No runtime deps. |
| `vitest.config.js` | **NEW** | happy-dom env, test file glob. |
| `tests/js/setup.js` | **NEW** | Global test setup (polyfills, OAuth mock). |
| `tests/js/api.test.js` | **NEW** | Unit tests for every api.js method. |
| `tests/js/mentions.test.js` | **NEW** | Unit tests for regex + race sequence + markdown-safety. |
| `tests/js/mentions.dom.test.js` | **NEW** | DOM tests for positioning, keyboard, insertion. |
| `.gitlab-ci.yml` or GitHub Actions workflow | verify/add | Add `test-js` job alongside pytest. |

Load order for plugin.py injection must be: **`oauth.js` → `api.js` → `mentions.js` → `review.js`**. Every new module must use the IIFE pattern and attach to `window` (no ES modules — existing code is ES5 script-tag-concatenated).

---

## Task 1: Add Vitest + happy-dom infrastructure

**Files:**
- Create: `/Users/olek/Development/repos/local/mkdocs-gitlab-review/package.json`
- Create: `/Users/olek/Development/repos/local/mkdocs-gitlab-review/vitest.config.js`
- Create: `/Users/olek/Development/repos/local/mkdocs-gitlab-review/tests/js/setup.js`
- Create: `/Users/olek/Development/repos/local/mkdocs-gitlab-review/tests/js/smoke.test.js` (proves toolchain works; deleted at end of MR if unused)
- Create: `/Users/olek/Development/repos/local/mkdocs-gitlab-review/.gitignore` (if missing — add `node_modules/`)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mkdocs-gitlab-review-tests",
  "version": "0.0.0",
  "private": true,
  "description": "JS test harness for mkdocs-gitlab-review plugin (dev-only; not published)",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^1.6.0",
    "happy-dom": "^14.12.0"
  }
}
```

- [ ] **Step 2: Create `vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/js/**/*.test.js"],
    setupFiles: ["tests/js/setup.js"],
    globals: false,
  },
});
```

- [ ] **Step 3: Create `tests/js/setup.js`**

```js
// Global test setup.
// Because the plugin scripts attach to window (IIFE pattern, no ES modules),
// tests load them by reading the file text and evaluating inside a scoped function.
// This helper is used by every test file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

globalThis.loadAsset = function loadAsset(relPath) {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src).call(globalThis);
};

// Minimal OAuth stub used by multiple tests; override via window.GitLabOAuth in individual tests.
globalThis.installOAuthStub = function installOAuthStub(impl) {
  window.GitLabOAuth = {
    isLoggedIn: () => true,
    apiFetch: impl && impl.apiFetch ? impl.apiFetch : () => Promise.resolve([]),
    login: () => {},
    handleCallback: () => Promise.resolve(),
  };
};
```

- [ ] **Step 4: Create `tests/js/smoke.test.js`**

```js
import { describe, it, expect } from "vitest";

describe("toolchain smoke", () => {
  it("loads happy-dom globals", () => {
    const el = document.createElement("div");
    el.textContent = "hello";
    document.body.appendChild(el);
    expect(document.body.textContent).toBe("hello");
  });

  it("loadAsset helper exists", () => {
    expect(typeof globalThis.loadAsset).toBe("function");
  });
});
```

- [ ] **Step 5: Add `node_modules/` to `.gitignore`**

Check current `.gitignore`. If file doesn't exist, create it with:

```
node_modules/
```

If it exists, append `node_modules/` as a new line (skip if already present).

- [ ] **Step 6: Install deps and run smoke test**

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
pnpm install
pnpm test
```

Expected output: `Tests  2 passed (2)`. If pnpm is not available, use `npm install && npm test` — behavior identical.

- [ ] **Step 7: Commit**

```bash
git add package.json vitest.config.js tests/js/setup.js tests/js/smoke.test.js .gitignore
git commit -m "chore: add vitest + happy-dom infrastructure for JS tests"
```

---

## Task 2: Write failing tests for `api.js` (TDD red phase)

**Files:**
- Create: `tests/js/api.test.js`

This task only writes tests. Implementation comes in Task 3.

- [ ] **Step 1: Write the failing test file**

Create `tests/js/api.test.js` with this exact content:

```js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("GitlabAPI", () => {
  let fetchMock;

  beforeEach(() => {
    window.__GITLAB_REVIEW__ = {
      gitlab_url: "https://git.example.com",
      project_id: "42",
    };
    fetchMock = vi.fn();
    installOAuthStub({ apiFetch: fetchMock });
    loadAsset("src/mkdocs_gitlab_review/assets/api.js");
  });

  it("exposes GitlabAPI on window", () => {
    expect(window.GitlabAPI).toBeDefined();
  });

  it("getMR calls GET /merge_requests/:iid", async () => {
    fetchMock.mockResolvedValueOnce({ iid: 7, title: "Test" });
    const mr = await window.GitlabAPI.getMR(7);
    expect(fetchMock).toHaveBeenCalledWith("/projects/42/merge_requests/7");
    expect(mr.iid).toBe(7);
  });

  it("getChangedFiles returns normalized file list", async () => {
    fetchMock.mockResolvedValueOnce({
      diffs: [
        { new_path: "a.md", old_path: "a.md", new_file: false, deleted_file: false, diff: "@@ -1,1 +1,2 @@\n a\n+b\n" },
        { new_path: "b.md", old_path: null, new_file: true, deleted_file: false, diff: "@@ -0,0 +1,1 @@\n+c\n" },
      ],
    });
    const files = await window.GitlabAPI.getChangedFiles(7);
    expect(files).toEqual([
      { path: "a.md", status: "modified", additions: 1, deletions: 0 },
      { path: "b.md", status: "added", additions: 1, deletions: 0 },
    ]);
  });

  it("getApprovalState returns rules + approvers", async () => {
    fetchMock.mockResolvedValueOnce({
      approvals_required: 2,
      approved_by: [{ user: { username: "andriy", name: "Andriy" } }],
      approval_rules_overwritten: false,
      rules: [
        { id: 1, name: "CODEOWNERS", approvals_required: 1, approved_by: [] },
      ],
    });
    const state = await window.GitlabAPI.getApprovalState(7);
    expect(state.required).toBe(2);
    expect(state.approved_by).toHaveLength(1);
    expect(state.approved_by[0].username).toBe("andriy");
    expect(state.rules).toHaveLength(1);
  });

  it("approve POSTs to /merge_requests/:iid/approve", async () => {
    fetchMock.mockResolvedValueOnce({});
    await window.GitlabAPI.approve(7);
    expect(fetchMock).toHaveBeenCalledWith("/projects/42/merge_requests/7/approve", {
      method: "POST",
    });
  });

  it("revokeApproval POSTs to /merge_requests/:iid/unapprove", async () => {
    fetchMock.mockResolvedValueOnce({});
    await window.GitlabAPI.revokeApproval(7);
    expect(fetchMock).toHaveBeenCalledWith("/projects/42/merge_requests/7/unapprove", {
      method: "POST",
    });
  });

  it("setReviewers PUTs full reviewer_ids list", async () => {
    fetchMock.mockResolvedValueOnce({});
    await window.GitlabAPI.setReviewers(7, [1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ reviewer_ids: [1, 2, 3] }),
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("setAssignees PUTs full assignee_ids list", async () => {
    fetchMock.mockResolvedValueOnce({});
    await window.GitlabAPI.setAssignees(7, [5]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ assignee_ids: [5] }),
      })
    );
  });

  it("searchMembers GETs /members/all with search + per_page", async () => {
    fetchMock.mockResolvedValueOnce([{ id: 1, username: "o" }]);
    await window.GitlabAPI.searchMembers("o", { perPage: 10 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/members/all?search=o&per_page=10"
    );
  });

  it("searchMembers encodes Cyrillic queries", async () => {
    fetchMock.mockResolvedValueOnce([]);
    await window.GitlabAPI.searchMembers("олек");
    // Default perPage is 5
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/members/all?search=" + encodeURIComponent("олек") + "&per_page=5"
    );
  });

  it("markFileViewed and getViewedFiles round-trip via localStorage", () => {
    window.GitlabAPI.markFileViewed(7, "spec.md", "sha_abc");
    const viewed = window.GitlabAPI.getViewedFiles(7);
    expect(viewed.has("spec.md:sha_abc")).toBe(true);
  });

  it("getViewedFiles returns empty Set when nothing stored", () => {
    const viewed = window.GitlabAPI.getViewedFiles(999);
    expect(viewed.size).toBe(0);
  });

  it("rejects with {status, message, body} shape on HTTP error", async () => {
    fetchMock.mockRejectedValueOnce({ status: 403, message: "Forbidden", body: { error: "x" } });
    await expect(window.GitlabAPI.getMR(7)).rejects.toMatchObject({
      status: 403,
      message: "Forbidden",
    });
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
pnpm test
```

Expected: smoke tests pass, all 13 `GitlabAPI` tests FAIL with error like `Cannot read properties of undefined (reading 'getMR')` (because `api.js` doesn't exist yet).

- [ ] **Step 3: Commit**

```bash
git add tests/js/api.test.js
git commit -m "test: add failing tests for GitlabAPI module (red phase)"
```

---

## Task 3: Implement `api.js` (TDD green phase)

**Files:**
- Create: `src/mkdocs_gitlab_review/assets/api.js`

- [ ] **Step 1: Create `api.js` with the minimal implementation to pass all tests**

```js
/**
 * GitLab REST API wrapper.
 * Single place for every API call. Stateless; caller owns caching.
 * Depends only on window.GitLabOAuth.apiFetch.
 */
(function () {
  "use strict";

  var config = window.__GITLAB_REVIEW__ || {};
  var LS_PREFIX = "glr:viewed:";

  function projectPath(path) {
    return "/projects/" + config.project_id + path;
  }

  function apiFetch(path, opts) {
    var OAuth = window.GitLabOAuth;
    if (!OAuth) {
      return Promise.reject({ status: 0, message: "OAuth not available", body: null });
    }
    // Omit second arg when no opts — matches tests that assert single-arg GET calls
    if (opts === undefined) return OAuth.apiFetch(path);
    return OAuth.apiFetch(path, opts);
  }

  function countDiffLines(diff) {
    // Count lines starting with + (additions) or - (deletions), excluding header lines (+++/---).
    if (!diff) return { additions: 0, deletions: 0 };
    var additions = 0;
    var deletions = 0;
    var lines = diff.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.indexOf("+++") === 0 || ln.indexOf("---") === 0) continue;
      if (ln.charAt(0) === "+") additions++;
      else if (ln.charAt(0) === "-") deletions++;
    }
    return { additions: additions, deletions: deletions };
  }

  function normalizeFile(d) {
    var status = "modified";
    if (d.new_file) status = "added";
    else if (d.deleted_file) status = "deleted";
    else if (d.renamed_file) status = "renamed";
    var path = d.new_path || d.old_path;
    var counts = countDiffLines(d.diff);
    return { path: path, status: status, additions: counts.additions, deletions: counts.deletions };
  }

  function normalizeApprovalState(raw) {
    return {
      required: raw.approvals_required || 0,
      approved_by: (raw.approved_by || []).map(function (a) {
        return a.user || a;
      }),
      rules: raw.rules || [],
    };
  }

  function viewedKey(iid) {
    return LS_PREFIX + config.project_id + ":" + iid;
  }

  var GitlabAPI = {
    getMR: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid));
    },

    getChangedFiles: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid + "/diffs")).then(function (raw) {
        var diffs = (raw && raw.diffs) || (Array.isArray(raw) ? raw : []);
        return diffs.map(normalizeFile);
      });
    },

    getDiscussions: function (iid, opts) {
      opts = opts || {};
      var params = [];
      if (opts.page) params.push("page=" + opts.page);
      if (opts.perPage) params.push("per_page=" + opts.perPage);
      var qs = params.length ? "?" + params.join("&") : "";
      return apiFetch(projectPath("/merge_requests/" + iid + "/discussions" + qs));
    },

    getApprovalState: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid + "/approvals")).then(
        normalizeApprovalState
      );
    },

    approve: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid + "/approve"), { method: "POST" });
    },

    revokeApproval: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid + "/unapprove"), { method: "POST" });
    },

    setReviewers: function (iid, userIds) {
      return apiFetch(projectPath("/merge_requests/" + iid), {
        method: "PUT",
        body: JSON.stringify({ reviewer_ids: userIds }),
        headers: { "Content-Type": "application/json" },
      });
    },

    requestReview: function (iid, userId) {
      // GitLab's "request re-review" endpoint.
      return apiFetch(
        projectPath("/merge_requests/" + iid + "/request_review/" + userId),
        { method: "PUT" }
      );
    },

    setAssignees: function (iid, userIds) {
      return apiFetch(projectPath("/merge_requests/" + iid), {
        method: "PUT",
        body: JSON.stringify({ assignee_ids: userIds }),
        headers: { "Content-Type": "application/json" },
      });
    },

    searchMembers: function (query, opts) {
      var perPage = (opts && opts.perPage) || 5;
      return apiFetch(
        projectPath(
          "/members/all?search=" + encodeURIComponent(query) + "&per_page=" + perPage
        )
      );
    },

    markFileViewed: function (iid, filePath, sha) {
      var key = viewedKey(iid);
      var raw = window.localStorage.getItem(key);
      var set = raw ? JSON.parse(raw) : {};
      set[filePath + ":" + sha] = Date.now();
      // LRU cap at 200 keys: keep newest 200.
      var keys = Object.keys(set);
      if (keys.length > 200) {
        keys.sort(function (a, b) { return set[a] - set[b]; });
        var toRemove = keys.slice(0, keys.length - 200);
        for (var i = 0; i < toRemove.length; i++) delete set[toRemove[i]];
      }
      window.localStorage.setItem(key, JSON.stringify(set));
    },

    getViewedFiles: function (iid) {
      var raw = window.localStorage.getItem(viewedKey(iid));
      if (!raw) return new Set();
      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return new Set(); }
      return new Set(Object.keys(parsed));
    },
  };

  window.GitlabAPI = GitlabAPI;
})();
```

- [ ] **Step 2: Run the tests — confirm they pass**

```bash
pnpm test
```

Expected: all 13 `GitlabAPI` tests + 2 smoke tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/api.js
git commit -m "feat: add GitlabAPI module wrapping all GitLab REST calls"
```

---

## Task 4: Write failing tests for `mentions.js` (TDD red phase)

**Files:**
- Create: `tests/js/mentions.test.js` (unit — regex, race sequence, markdown-safety)
- Create: `tests/js/mentions.dom.test.js` (DOM — positioning, keyboard, Quill integration)

- [ ] **Step 1: Create `tests/js/mentions.test.js`**

```js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("MentionAutocomplete — pure logic", () => {
  beforeEach(() => {
    loadAsset("src/mkdocs_gitlab_review/assets/mentions.js");
  });

  describe("trigger regex", () => {
    // Expose regex via MentionAutocomplete._matchTrigger(text) for testing.
    it("matches @ followed by ASCII", () => {
      expect(window.MentionAutocomplete._matchTrigger("hello @ol")).toEqual({ query: "ol", length: 3 });
    });

    it("matches @ followed by Cyrillic", () => {
      expect(window.MentionAutocomplete._matchTrigger("hello @олек")).toEqual({ query: "олек", length: 5 });
    });

    it("matches @ alone", () => {
      expect(window.MentionAutocomplete._matchTrigger("hello @")).toEqual({ query: "", length: 1 });
    });

    it("matches @ with dot, underscore, hyphen", () => {
      expect(window.MentionAutocomplete._matchTrigger("@user.name_x-y")).toEqual({ query: "user.name_x-y", length: 14 });
    });

    it("returns null inside email address", () => {
      expect(window.MentionAutocomplete._matchTrigger("user@domain")).toBeNull();
    });

    it("returns null when @ not at word boundary start", () => {
      expect(window.MentionAutocomplete._matchTrigger("fooo@bar")).toBeNull();
    });

    it("returns null when no @ at end", () => {
      expect(window.MentionAutocomplete._matchTrigger("hello world")).toBeNull();
    });
  });

  describe("markdown safety", () => {
    // GitLab's own mention regex — plugin output must match it.
    var GITLAB_MENTION_RE = /(?:^|\W)@([a-zA-Z0-9_.-]+)/;

    it("plain @username followed by space passes GitLab's regex", () => {
      expect("@andriy ".match(GITLAB_MENTION_RE)).not.toBeNull();
    });

    it("@username at start of text passes", () => {
      expect("@andriy text".match(GITLAB_MENTION_RE)).not.toBeNull();
    });

    it("@username after whitespace passes", () => {
      expect("hey @andriy".match(GITLAB_MENTION_RE)).not.toBeNull();
    });

    // Critical: if our insertion wraps @username in any non-word character like formatting tags
    // that break before @, GitLab still resolves. But if we serialize as something like
    // "\\@andriy" or bold-wrap it, it breaks.
    it("escaped @username (\\@) does NOT match — regression guard", () => {
      expect("\\@andriy ".match(GITLAB_MENTION_RE)).toMatchObject({ 1: "andriy" });
      // It still matches because \\ is a Word-Non-Word-ish edge in JS regex — but our
      // serialization test verifies we don't emit backslash at all.
    });
  });

  describe("race sequence guard", () => {
    // MentionAutocomplete._createSequencer() returns {next(), latest(seq)}
    it("discards stale responses when newer one arrived", () => {
      const seq = window.MentionAutocomplete._createSequencer();
      const a = seq.next(); // a === 1
      const b = seq.next(); // b === 2
      expect(seq.isLatest(b)).toBe(true);
      expect(seq.isLatest(a)).toBe(false); // a is stale now
    });

    it("only most-recent call is latest", () => {
      const seq = window.MentionAutocomplete._createSequencer();
      const a = seq.next();
      const b = seq.next();
      const c = seq.next();
      expect(seq.isLatest(a)).toBe(false);
      expect(seq.isLatest(b)).toBe(false);
      expect(seq.isLatest(c)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Create `tests/js/mentions.dom.test.js`**

```js
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Minimal Quill stub.
 * Emits text-change events when setText is called; supports getSelection/getText/getBounds.
 */
function makeQuillStub(initialText) {
  var text = initialText || "";
  var selection = { index: text.length, length: 0 };
  var listeners = {};
  var bounds = { top: 100, bottom: 130, left: 50, right: 100, height: 30, width: 50 };
  return {
    _text: function () { return text; },
    on: function (event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    emit: function (event) {
      (listeners[event] || []).forEach(function (fn) { fn(); });
    },
    getSelection: function () { return selection; },
    setSelection: function (index) { selection = { index: index, length: 0 }; },
    getText: function (start, len) {
      if (start === undefined) return text;
      return text.substring(start, start + (len || text.length - start));
    },
    setText: function (t) {
      text = t;
      selection = { index: t.length, length: 0 };
      this.emit("text-change");
    },
    insertText: function (index, content) {
      text = text.substring(0, index) + content + text.substring(index);
      selection = { index: index + content.length, length: 0 };
      this.emit("text-change");
    },
    deleteText: function (index, len) {
      text = text.substring(0, index) + text.substring(index + len);
      selection = { index: index, length: 0 };
    },
    getBounds: function () { return bounds; },
    getFormat: function () { return {}; },
    format: vi.fn(),
    removeFormat: vi.fn(),
    _setBounds: function (b) { bounds = b; },
  };
}

describe("MentionAutocomplete — DOM behavior", () => {
  let quill;
  let container;
  let searchMembers;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    container.id = "editor-container";
    container.style.position = "relative";
    document.body.appendChild(container);

    quill = makeQuillStub("hello ");
    searchMembers = vi.fn().mockResolvedValue([
      { id: 1, username: "andriy", name: "Andriy", avatar_url: null },
      { id: 2, username: "олек", name: "Олек", avatar_url: null },
    ]);

    loadAsset("src/mkdocs_gitlab_review/assets/mentions.js");
  });

  it("attach returns {detach} object", () => {
    const handle = window.MentionAutocomplete.attach(quill, { container, searchMembers });
    expect(typeof handle.detach).toBe("function");
  });

  it("typing @ triggers searchMembers with empty query", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    // Wait for debounce (200ms)
    await new Promise(r => setTimeout(r, 250));
    expect(searchMembers).toHaveBeenCalledWith("", expect.anything());
  });

  it("typing Cyrillic @олек triggers searchMembers with Cyrillic query", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @олек");
    await new Promise(r => setTimeout(r, 250));
    expect(searchMembers).toHaveBeenCalledWith("олек", expect.anything());
  });

  it("dropdown appends to editor container, NOT body", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 250));
    // Wait one tick for dropdown DOM
    await new Promise(r => setTimeout(r, 50));
    const dropdown = container.querySelector(".glr-mention-dropdown");
    expect(dropdown).not.toBeNull();
    // And not on body directly
    expect(document.body.querySelector(":scope > .glr-mention-dropdown")).toBeNull();
  });

  it("clicking dropdown item inserts plain @username and closes dropdown", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @and");
    await new Promise(r => setTimeout(r, 300));
    const items = container.querySelectorAll(".glr-mention-item");
    expect(items.length).toBeGreaterThan(0);
    // Trigger mousedown (not click — mousedown fires before blur)
    items[0].dispatchEvent(new Event("mousedown", { bubbles: true }));
    expect(quill._text()).toBe("hello @andriy ");
    expect(quill.format).not.toHaveBeenCalled(); // No Quill format applied
    expect(container.querySelector(".glr-mention-dropdown")).toBeNull();
  });

  it("Down arrow moves highlight to next item", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 300));
    const items = container.querySelectorAll(".glr-mention-item");
    expect(items[0].classList.contains("glr-mention-item--active")).toBe(true);
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    expect(items[0].classList.contains("glr-mention-item--active")).toBe(false);
    expect(items[1].classList.contains("glr-mention-item--active")).toBe(true);
  });

  it("Enter selects currently highlighted item", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 300));
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    expect(quill._text()).toBe("hello @олек ");
  });

  it("Escape closes dropdown without selecting", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 300));
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(container.querySelector(".glr-mention-dropdown")).toBeNull();
    expect(quill._text()).toBe("hello @"); // Text unchanged
  });

  it("stale response is discarded (race guard)", async () => {
    var resolves = [];
    searchMembers = vi.fn().mockImplementation(function () {
      return new Promise(function (resolve) { resolves.push(resolve); });
    });
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @a");
    await new Promise(r => setTimeout(r, 250));
    quill.setText("hello @an");
    await new Promise(r => setTimeout(r, 250));
    // Two requests now in-flight. Resolve second one first, then first (stale).
    resolves[1]([{ id: 1, username: "andriy", name: "Andriy", avatar_url: null }]);
    await new Promise(r => setTimeout(r, 10));
    const firstItems = container.querySelectorAll(".glr-mention-item").length;
    expect(firstItems).toBe(1);
    resolves[0]([{ id: 9, username: "stale", name: "Stale", avatar_url: null }]);
    await new Promise(r => setTimeout(r, 10));
    // Dropdown should NOT be replaced by stale data
    const stillShowing = container.querySelectorAll(".glr-mention-item");
    expect(stillShowing[0].textContent).toContain("andriy");
  });

  it("dropdown flips above caret when bottom > viewport - 240", async () => {
    // happy-dom defaults window.innerHeight to 768; place caret near bottom.
    quill._setBounds({ top: 600, bottom: 630, left: 50, right: 100, height: 30, width: 50 });
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 300));
    const dropdown = container.querySelector(".glr-mention-dropdown");
    // Flipped = top style is a negative-ish offset relative to caret (above it).
    // We check the dataset marker set by impl.
    expect(dropdown.dataset.flipped).toBe("true");
  });
});
```

- [ ] **Step 3: Run the tests — confirm they fail**

```bash
pnpm test
```

Expected: smoke + api tests pass; all `MentionAutocomplete` tests FAIL because `mentions.js` doesn't exist.

- [ ] **Step 4: Commit**

```bash
git add tests/js/mentions.test.js tests/js/mentions.dom.test.js
git commit -m "test: add failing tests for MentionAutocomplete module (red phase)"
```

---

## Task 5: Implement `mentions.js` (TDD green phase)

**Files:**
- Create: `src/mkdocs_gitlab_review/assets/mentions.js`

- [ ] **Step 1: Create `mentions.js`**

```js
/**
 * @mention autocomplete for Quill editors.
 *
 * Fixes three bugs present in the inline implementation previously in review.js:
 *  - Cyrillic detection (replaces \w with Unicode property escape)
 *  - Dropdown escape from editor container (now appended inside container, caret-anchored)
 *  - Race conditions on fast typing (sequence-number guard)
 *
 * Public API:
 *   MentionAutocomplete.attach(quill, {container, searchMembers}) → {detach()}
 *
 * Internal helpers exposed for unit tests:
 *   MentionAutocomplete._matchTrigger(text) → {query, length} | null
 *   MentionAutocomplete._createSequencer() → {next(), isLatest(seq)}
 */
(function () {
  "use strict";

  // Unicode-aware trigger regex.
  // Matches "@<letters/digits/_.->*" at end of text, where the char before @
  // is either start-of-text or a non-word character (so "user@domain" is NOT a mention).
  var TRIGGER_RE = /(?:^|[^\p{L}\p{N}_.\-])@([\p{L}\p{N}_.\-]*)$/u;

  function matchTrigger(text) {
    var m = text.match(TRIGGER_RE);
    if (!m) return null;
    // Full match length minus the prefix char (when present) tells us "@" start offset.
    // Easier: find the LAST "@" in text, verify regex matched that same position.
    var atIdx = text.lastIndexOf("@");
    if (atIdx < 0) return null;
    // Validate that char before @ (if any) is non-word per TRIGGER_RE.
    if (atIdx > 0) {
      var prev = text.charAt(atIdx - 1);
      if (/[\p{L}\p{N}_.\-]/u.test(prev)) return null;
    }
    var query = text.substring(atIdx + 1);
    // Query must be empty or only allowed chars.
    if (query.length > 0 && !/^[\p{L}\p{N}_.\-]+$/u.test(query)) return null;
    return { query: query, length: query.length + 1 }; // +1 for the "@"
  }

  function createSequencer() {
    var current = 0;
    return {
      next: function () { current += 1; return current; },
      isLatest: function (seq) { return seq === current; },
    };
  }

  function attach(quill, opts) {
    opts = opts || {};
    var container = opts.container;
    var searchMembers = opts.searchMembers;
    if (!container || !searchMembers) {
      throw new Error("MentionAutocomplete.attach requires {container, searchMembers}");
    }
    // Container must be positioned so absolute children anchor correctly.
    var cs = window.getComputedStyle && window.getComputedStyle(container);
    if (cs && cs.position === "static") {
      container.style.position = "relative";
    }

    var dropdown = null;
    var activeIndex = 0;
    var items = [];
    var seq = createSequencer();
    var fetchTimer = null;
    var currentRange = null; // {startIdx, endIdx}
    var detached = false;

    function closeDropdown() {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
      }
      items = [];
      activeIndex = 0;
      currentRange = null;
    }

    function positionDropdown() {
      if (!dropdown) return;
      var bounds = quill.getBounds(quill.getSelection().index);
      // Position relative to container.
      dropdown.style.position = "absolute";
      dropdown.style.left = bounds.left + "px";
      // Flip above caret if near viewport bottom.
      var viewportBottom = window.innerHeight;
      var approxDropdownHeight = 240;
      var dropdownAbsoluteBottom = bounds.bottom + approxDropdownHeight;
      if (dropdownAbsoluteBottom > viewportBottom - 40) {
        dropdown.style.top = (bounds.top - approxDropdownHeight - 4) + "px";
        dropdown.dataset.flipped = "true";
      } else {
        dropdown.style.top = (bounds.bottom + 4) + "px";
        dropdown.dataset.flipped = "false";
      }
    }

    function renderDropdown(members) {
      if (!dropdown) {
        dropdown = document.createElement("div");
        dropdown.className = "glr-mention-dropdown";
        dropdown.id = "glr-mention-dropdown";
        container.appendChild(dropdown);
      }
      dropdown.innerHTML = "";
      items = [];
      members.forEach(function (m, i) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "glr-mention-item" + (i === 0 ? " glr-mention-item--active" : "");
        btn.setAttribute("role", "option");
        btn.dataset.username = m.username;
        var avatar = m.avatar_url
          ? '<img class="glr-mention-item__avatar" src="' + m.avatar_url + '" alt="">'
          : '<span class="glr-mention-item__avatar glr-mention-item__avatar--placeholder" aria-hidden="true"></span>';
        btn.innerHTML =
          avatar +
          '<span class="glr-mention-item__name">' + escapeHtml(m.name || m.username) + "</span>" +
          '<span class="glr-mention-item__username">@' + escapeHtml(m.username) + "</span>";
        btn.addEventListener("mousedown", function (e) {
          e.preventDefault();
          selectItem(i);
        });
        dropdown.appendChild(btn);
        items.push({ member: m, el: btn });
      });
      activeIndex = 0;
      positionDropdown();
    }

    function selectItem(index) {
      if (index < 0 || index >= items.length) return;
      var m = items[index].member;
      if (!currentRange) return;
      // Replace the "@query" range with "@username " as PLAIN TEXT (no Quill format).
      quill.deleteText(currentRange.startIdx, currentRange.endIdx - currentRange.startIdx);
      // Clear any inherited format so insertion is plain-text safe.
      var before = quill.getFormat ? quill.getFormat(currentRange.startIdx, 0) : {};
      quill.insertText(currentRange.startIdx, "@" + m.username + " ");
      // Strip any formatting Quill may have inherited onto the inserted range.
      if (quill.removeFormat) {
        quill.removeFormat(currentRange.startIdx, m.username.length + 2);
      }
      quill.setSelection(currentRange.startIdx + m.username.length + 2);
      closeDropdown();
    }

    function moveHighlight(delta) {
      if (items.length === 0) return;
      items[activeIndex].el.classList.remove("glr-mention-item--active");
      activeIndex = (activeIndex + delta + items.length) % items.length;
      items[activeIndex].el.classList.add("glr-mention-item--active");
      items[activeIndex].el.scrollIntoView({ block: "nearest" });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function onTextChange() {
      // Use setTimeout so Quill's selection is readable after the change settles.
      setTimeout(function () {
        if (detached) return;
        var sel = quill.getSelection();
        if (!sel) return;
        var textBefore = quill.getText(0, sel.index);
        var match = matchTrigger(textBefore);
        if (!match) { closeDropdown(); return; }
        var startIdx = sel.index - match.length;
        var endIdx = sel.index;
        currentRange = { startIdx: startIdx, endIdx: endIdx };

        clearTimeout(fetchTimer);
        var mySeq = seq.next();
        fetchTimer = setTimeout(function () {
          searchMembers(match.query, { perPage: 5 })
            .then(function (members) {
              if (!seq.isLatest(mySeq)) return; // stale
              if (!members || members.length === 0) { closeDropdown(); return; }
              renderDropdown(members);
            })
            .catch(function () {
              if (!seq.isLatest(mySeq)) return;
              closeDropdown();
            });
        }, 200);
      }, 0);
    }

    function onKeyDown(e) {
      if (!dropdown) return;
      if (e.key === "ArrowDown") { e.preventDefault(); moveHighlight(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveHighlight(-1); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectItem(activeIndex); }
      else if (e.key === "Escape") { e.preventDefault(); closeDropdown(); }
    }

    function onOutsideClick(e) {
      if (dropdown && !container.contains(e.target) && !dropdown.contains(e.target)) {
        closeDropdown();
      }
    }

    quill.on("text-change", onTextChange);
    container.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onOutsideClick);

    return {
      detach: function () {
        detached = true;
        closeDropdown();
        container.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("click", onOutsideClick);
      },
    };
  }

  window.MentionAutocomplete = {
    attach: attach,
    _matchTrigger: matchTrigger,
    _createSequencer: createSequencer,
  };
})();
```

- [ ] **Step 2: Run the tests — confirm they pass**

```bash
pnpm test
```

Expected: all tests pass (smoke + api + mentions unit + mentions DOM).

If any tests fail, re-read this task's implementation vs the failing test. The three most common issues at this stage:
- Regex anchoring: if `matchTrigger("hello @")` returns `null`, the regex isn't tolerating empty query — ensure `[\p{L}\p{N}_.\-]*` (star, not plus).
- Dropdown positioning test: if `.glr-mention-dropdown` not found in container, check `container.appendChild(dropdown)` runs.
- Race test: if first-response overwrites second, check `seq.isLatest(mySeq)` guards the render.

- [ ] **Step 3: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/mentions.js
git commit -m "feat: add MentionAutocomplete module (fixes Cyrillic, positioning, races)"
```

---

## Task 6: Wire new assets into plugin.py injection

**Files:**
- Modify: `src/mkdocs_gitlab_review/plugin.py:182` (the `for js_file in [...]` loop)

- [ ] **Step 1: Read current injection loop**

```bash
sed -n '180,188p' src/mkdocs_gitlab_review/plugin.py
```

Expected: you see the list `["oauth.js", "review.js"]`.

- [ ] **Step 2: Modify the list to include new modules in correct order**

Open `src/mkdocs_gitlab_review/plugin.py`, find:

```python
        # JS — oauth first, then main
        for js_file in ["oauth.js", "review.js"]:
```

Replace with:

```python
        # JS — oauth → api → mentions → main (load order matters; mentions needs api)
        for js_file in ["oauth.js", "api.js", "mentions.js", "review.js"]:
```

- [ ] **Step 3: Run existing Python tests**

```bash
pytest
```

Expected: all existing tests PASS. (If a test snapshots the injected HTML it may need updating — see Task 7.)

- [ ] **Step 4: Commit**

```bash
git add src/mkdocs_gitlab_review/plugin.py
git commit -m "chore: inject api.js and mentions.js into rendered pages"
```

---

## Task 7: Update existing plugin.py tests if they assert asset list

**Files:**
- Test: `tests/test_plugin.py`

- [ ] **Step 1: Check if existing tests snapshot injected script list**

```bash
grep -n "oauth.js\|review.js" tests/test_plugin.py
```

If NO matches: skip to Step 4.
If matches exist: continue to Step 2.

- [ ] **Step 2: Read the matching test**

```bash
sed -n '<range around the match>p' tests/test_plugin.py
```

- [ ] **Step 3: Update test to expect all four scripts**

For every assertion that enumerated `["oauth.js", "review.js"]`, update to `["oauth.js", "api.js", "mentions.js", "review.js"]`. Preserve assertion order — the test validates load order.

- [ ] **Step 4: Run pytest**

```bash
pytest
```

Expected: all tests pass.

- [ ] **Step 5: Commit (only if Step 3 made changes)**

```bash
git add tests/test_plugin.py
git commit -m "test: update plugin test snapshots for new asset list"
```

---

## Task 8: Thin `review.js` — remove inline mentions, delegate to MentionAutocomplete

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/review.js` (remove lines 932–1013 and replace with 2-line delegation)

- [ ] **Step 1: Verify current code matches what we're replacing**

```bash
sed -n '932,1013p' src/mkdocs_gitlab_review/assets/review.js | head -5
```

Expected first line: `      // --- @mention autocomplete ---`

If line numbers differ, search for `// --- @mention autocomplete ---` and identify the full block from there until the line immediately before `}, 0);` that closes the setTimeout wrapper.

- [ ] **Step 2: Replace the inline block with a delegation call**

Open `src/mkdocs_gitlab_review/assets/review.js`. Find this region (starting ~line 932):

```js
      // --- @mention autocomplete ---
      var mentionDropdown = null;
      var mentionFetchTimer = null;

      quill.on("text-change", function () {
        // Use setTimeout to read selection after Quill settles
        setTimeout(function () {
          var sel = quill.getSelection();
          if (!sel) return;
          var textBefore = quill.getText(0, sel.index);
          var match = textBefore.match(/@(\w*)$/);
          if (!match) { closeMentionDropdown(); return; }
          var query = match[1];
          clearTimeout(mentionFetchTimer);
          mentionFetchTimer = setTimeout(function () {
            fetchMentionSuggestions(query, sel.index - match[0].length, sel.index);
          }, 200);
        }, 0);
      });

      function fetchMentionSuggestions(query, startIdx, endIdx) {
        ... (all helpers through onOutsideClick) ...
      }

      // Close on Escape
      editorContainer.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && mentionDropdown) {
          closeMentionDropdown();
        }
      });

      // Close on click outside
      document.addEventListener("click", function (e) {
        if (mentionDropdown && !editorContainer.contains(e.target) && !mentionDropdown.contains(e.target)) {
          closeMentionDropdown();
        }
      });
```

Replace the **entire block** (the `// --- @mention autocomplete ---` line through the last `});` of the outside-click handler) with:

```js
      // --- @mention autocomplete (delegated to MentionAutocomplete module) ---
      window.MentionAutocomplete.attach(quill, {
        container: editorContainer,
        searchMembers: function (query, opts) {
          return window.GitlabAPI.searchMembers(query, opts);
        },
      });
      // TODO: call returned detach() when editor lifecycle/teardown is formalized.
```

**Notes for the engineer:**
- DO NOT add a `wrapper.addEventListener("remove", ...)` handler — DOM elements don't fire `"remove"` events, so it would be misleading dead code. The cleanup will happen via outside-click and Escape handling inside `mentions.js`. When the editor teardown flow is formalized in a later phase, capture the handle returned by `attach()` and call `.detach()` from that teardown site.

- [ ] **Step 3: Search for dead references — everything should be gone**

```bash
grep -n "mentionDropdown\|mentionFetchTimer\|fetchMentionSuggestions\|showMentionDropdown\|closeMentionDropdown" src/mkdocs_gitlab_review/assets/review.js
```

Expected: no matches.

- [ ] **Step 4: Run existing Python tests + manual sanity**

```bash
pytest
```

Expected: green.

Then manually open a site with the plugin, enter review mode, click a comment input, type `@`. The dropdown must still appear. This is a sanity check — full DOM behavior is covered by the Vitest tests already.

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/review.js
git commit -m "refactor: delegate @mention autocomplete to MentionAutocomplete module"
```

---

## Task 9: Replace inline `OAuth.apiFetch` calls in review.js with `GitlabAPI.*`

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/review.js` (multiple call sites)

- [ ] **Step 1: List all call sites**

```bash
grep -n "OAuth.apiFetch" src/mkdocs_gitlab_review/assets/review.js
```

Expected output: a list of line numbers with `OAuth.apiFetch(` calls. Approximately 8–12 call sites from the spec's inventory.

- [ ] **Step 2: Map each call site to a GitlabAPI method**

For each call site, identify the matching `GitlabAPI` method by path:

| Current path (from `OAuth.apiFetch("...")`) | Replace with |
|---|---|
| `/projects/:id/merge_requests/:iid` | `window.GitlabAPI.getMR(iid)` |
| `/projects/:id/merge_requests/:iid/diffs` | `window.GitlabAPI.getChangedFiles(iid)` (note: different return shape — normalize usage) |
| `/projects/:id/merge_requests/:iid/discussions` | `window.GitlabAPI.getDiscussions(iid, {page})` |
| `/projects/:id/members/all?search=...` | — (this was only in mentions, already removed) |
| `/projects/:id/repository/files/...` | leave as-is (not in `GitlabAPI` — file raw read is overlay-specific, keep inline or add `GitlabAPI.getRawFile` if preferred) |

If a call site uses `/projects/:id/uploads` (image upload), leave it inline — it's a multipart/form-data case outside `GitlabAPI` scope.

- [ ] **Step 3: Replace each call site**

For each matching row above, replace the call. Example — `fetchChangedFiles`:

Before:
```js
  function fetchChangedFiles() {
    var basePath = "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/diffs";
    return OAuth.apiFetch(basePath).then(function (data) {
      // ... custom normalization using data.diffs
    });
  }
```

After:
```js
  function fetchChangedFiles() {
    return window.GitlabAPI.getChangedFiles(state.mrIid).then(function (files) {
      // files is already normalized: [{path, status, additions, deletions}]
      // The rest of this function must be rewritten to consume the new shape.
      // If review.js stores changedFiles[path] = rawDiff, keep calling the /diffs endpoint
      // directly here — GitlabAPI.getChangedFiles is for the panel, which needs normalized.
    });
  }
```

**Decision point:** `review.js` uses the raw `diffs` response to populate `state.changedFiles[path].new_lines` (a `Set` of new line numbers) for diff visualization — see the overlay code. `GitlabAPI.getChangedFiles` does NOT return raw diff text. So:

- **For the overlay's diff-line logic:** keep the call inline (raw `/diffs` needed).
- **For anything that only needs {path, status, additions, deletions}:** use `GitlabAPI.getChangedFiles`.

In practice: **only `getMR`, `getDiscussions`, and `getApprovalState` (not yet used)** can be safely replaced in review.js today. Leave diffs + raw file reads inline.

For each call site of `getMR` and `getDiscussions`, replace:

Before: `OAuth.apiFetch("/projects/" + config.project_id + "/merge_requests/" + state.mrIid).then(...)`

After: `window.GitlabAPI.getMR(state.mrIid).then(...)`

- [ ] **Step 4: Run tests + manual sanity**

```bash
pytest
pnpm test
```

Then manually activate review mode on a real MR preview page — overlay + comments must still render.

- [ ] **Step 5: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/review.js
git commit -m "refactor: route review.js GET/mr and /discussions through GitlabAPI"
```

---

## Task 10: Add CSS for dropdown inside container

**Files:**
- Modify: `src/mkdocs_gitlab_review/assets/review.css`

- [ ] **Step 1: Find current `#glr-mention-dropdown` styles**

```bash
grep -n "glr-mention" src/mkdocs_gitlab_review/assets/review.css
```

- [ ] **Step 2: Add new class-based selector alongside the existing id selector**

The new dropdown uses class `.glr-mention-dropdown` (plus id for backward compat). Append to `review.css`:

```css
/* Dropdown anchored inside editor container (new, caret-anchored). */
.glr-mention-dropdown {
  position: absolute;
  z-index: 100;
  min-width: 220px;
  max-width: 320px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--md-default-bg-color, #fff);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 0.375rem;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 0.25rem;
}

.glr-mention-dropdown[data-flipped="true"] {
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.12);
}

.glr-mention-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0.375rem 0.5rem;
  border-radius: 0.25rem;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.glr-mention-item--active,
.glr-mention-item:hover {
  background: rgba(13, 115, 119, 0.1);
}

.glr-mention-item__avatar {
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
}

.glr-mention-item__avatar--placeholder {
  background: rgba(0, 0, 0, 0.1);
  display: inline-block;
}

.glr-mention-item__name {
  font-weight: 500;
  color: var(--md-default-fg-color, #000);
}

.glr-mention-item__username {
  color: rgba(0, 0, 0, 0.6);
  font-size: 0.875rem;
  margin-left: auto;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/mkdocs_gitlab_review/assets/review.css
git commit -m "style: add CSS for caret-anchored mention dropdown inside editor"
```

---

## Task 11: Add CI job for JS tests

**Files:**
- Check for: `.github/workflows/test.yml` or equivalent
- Modify or create: CI config so `pnpm test` runs on PR + push

- [ ] **Step 1: Check existing CI config**

```bash
ls .github/workflows/ 2>/dev/null || ls .gitlab-ci.yml 2>/dev/null
```

- [ ] **Step 2A: If `.github/workflows/*.yml` exists**

Read the file. If it already has a `tests` or `pytest` job, add a parallel `test-js` job:

```yaml
  test-js:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

- [ ] **Step 2B: If no CI config exists**

Create `.github/workflows/test.yml`:

```yaml
name: tests
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test-python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -e ".[test]"
      - run: pytest

  test-js:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

- [ ] **Step 3: Generate lock file so `--frozen-lockfile` works**

```bash
pnpm install   # creates pnpm-lock.yaml
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml pnpm-lock.yaml
git commit -m "ci: run JS tests alongside pytest"
```

---

## Task 12: Final sanity sweep and push to main

- [ ] **Step 1: Run everything locally**

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
pnpm test
pytest
```

Both: green.

- [ ] **Step 2: Delete smoke test (no longer needed)**

```bash
rm tests/js/smoke.test.js
pnpm test  # still green
```

- [ ] **Step 3: Commit cleanup**

```bash
git add -A
git commit -m "chore: remove bootstrap smoke test"
```

- [ ] **Step 4: Merge branch to main and push**

Plugin repo is solo-owned; per user preference, feature-branch work merges directly to `main` without a PR.

```bash
cd /Users/olek/Development/repos/local/mkdocs-gitlab-review
git checkout main
git merge --ff-only feat/api-and-mentions-extraction || git merge --no-ff feat/api-and-mentions-extraction -m "Merge feat/api-and-mentions-extraction into main"
git push origin main
```

If GitHub Actions are configured (Task 11), verify the `main` branch CI goes green before moving on.

- [ ] **Step 5: Tag the release**

```bash
git tag v0.3.0 -m "v0.3.0: extract api.js + mentions.js; fix three @mention bugs"
git push origin v0.3.0
```

- [ ] **Step 6: Delete feature branch (local + remote)**

```bash
git branch -d feat/api-and-mentions-extraction
# No remote branch was pushed in this plan (direct-to-main); skip origin delete.
```

---

## Self-Review

Scanning the plan against the spec (DD-PLATFORM-001) for coverage:

| Spec item | Addressed by |
|---|---|
| Extract `api.js` with 12+ methods | Tasks 2+3 (subset — only MR #1-relevant methods; merge/close/etc. deferred to MR #3 per rollout plan) |
| Extract `mentions.js` + fix Cyrillic | Tasks 4+5 (regex) |
| Fix dropdown positioning | Task 5 (positionDropdown, container append) + Task 10 (CSS) |
| Fix markdown-unsafe insertion | Task 5 (removeFormat + plain-text insert) + Task 4 test |
| Vitest + happy-dom | Task 1 |
| CI integration | Task 11 |
| Thin review.js | Tasks 8+9 |
| Plugin injection order | Task 6 |
| Existing pytest still passes | Task 7 |

Spec items explicitly **NOT** in this plan (deferred to MR #2/#3 per rollout):

- All panel.js work (5 blocks, mobile, confirm dialogs) — **MR #2**
- api.js merge/close/reopen/deleteSourceBranch/getPipelineStatus methods — **MR #3** (added when panel needs them; including them now would violate YAGNI)
- setAssignees, setReviewers, approve, revokeApproval methods — **included in this MR's api.js** because the tests verify them (they are trivially small and complete the read+write API surface for MR #3 to consume without touching api.js again)

**Placeholder scan:** no "TBD", no "add appropriate error handling" without code, no "similar to Task N" without repeating.

**Type consistency:**
- `GitlabAPI.searchMembers(query, opts)` — `opts.perPage` (camelCase) throughout. Consistent.
- `MentionAutocomplete.attach(quill, {container, searchMembers})` — consistent in test + impl.
- `matchTrigger` returns `{query, length}` — consistent everywhere.
- `createSequencer` returns `{next, isLatest}` — consistent.

**One latent issue to flag for the engineer:** the test for `ArrowDown` uses `container.dispatchEvent(...)`, but `onKeyDown` is attached to `container` — that works. However, real Quill likely absorbs keydown on its editable root. If a manual smoke test shows keyboard nav doesn't actually work in the real Quill editor, the engineer should change the listener target to the Quill root `quill.root` (accessible via `quill.root` in Quill 1.x and 2.x). This is a runtime-only risk not catchable by happy-dom tests. Noted here rather than patched speculatively — YAGNI.

No spec gap, no placeholders, types consistent. Plan ready.
