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
