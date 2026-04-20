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

  it("getDiscussions supports page and perPage params", async () => {
    fetchMock.mockResolvedValueOnce([]);
    await window.GitlabAPI.getDiscussions(7, { page: 2, perPage: 100 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7/discussions?page=2&per_page=100"
    );
  });

  it("getDiscussions omits query string when no opts", async () => {
    fetchMock.mockResolvedValueOnce([]);
    await window.GitlabAPI.getDiscussions(7);
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/42/merge_requests/7/discussions"
    );
  });

  it("rejects with {status, message, body} shape on HTTP error", async () => {
    fetchMock.mockRejectedValueOnce({ status: 403, message: "Forbidden", body: { error: "x" } });
    await expect(window.GitlabAPI.getMR(7)).rejects.toMatchObject({
      status: 403,
      message: "Forbidden",
    });
  });
});
