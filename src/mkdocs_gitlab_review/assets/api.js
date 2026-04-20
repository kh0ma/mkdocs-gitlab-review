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
      var qs = opts && opts.page ? "?page=" + opts.page : "";
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
