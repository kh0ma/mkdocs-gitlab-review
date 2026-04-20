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
