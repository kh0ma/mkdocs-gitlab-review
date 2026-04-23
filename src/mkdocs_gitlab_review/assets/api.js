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
      var qs = "per_page=" + perPage;
      if (query) qs = "query=" + encodeURIComponent(query) + "&" + qs;
      return apiFetch(projectPath("/members/all?" + qs));
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

    getAwardEmojis: function (iid) {
      return apiFetch(projectPath("/merge_requests/" + iid + "/award_emoji"));
    },

    toggleAwardEmoji: function (iid, name) {
      // Check if user already awarded this emoji; if so, delete it; otherwise, create.
      return apiFetch(projectPath("/merge_requests/" + iid + "/award_emoji")).then(function (emojis) {
        var userId = window.__glr_current_user_id;
        var existing = emojis.find(function (e) {
          return e.name === name && e.user && e.user.id === userId;
        });
        if (existing) {
          return apiFetch(
            projectPath("/merge_requests/" + iid + "/award_emoji/" + existing.id),
            { method: "DELETE" }
          ).then(function () { return { action: "removed", name: name }; });
        }
        return apiFetch(
          projectPath("/merge_requests/" + iid + "/award_emoji"),
          { method: "POST", body: JSON.stringify({ name: name }), headers: { "Content-Type": "application/json" } }
        ).then(function () { return { action: "added", name: name }; });
      });
    },

    getCurrentUser: function () {
      return apiFetch("/user");
    },
  };

  window.GitlabAPI = GitlabAPI;
})();
