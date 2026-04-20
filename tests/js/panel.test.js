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
