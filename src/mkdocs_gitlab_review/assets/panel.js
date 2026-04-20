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
    var nameHtml = user.name
      ? '<span class="glr-panel__user-name">' + escapeHtml(user.name) + '</span>'
      : '';
    var usernameHtml = '<span class="glr-panel__user-username">@' + escapeHtml(user.username) + '</span>';
    return '<span class="glr-panel__user">' +
      avatar +
      nameHtml +
      usernameHtml +
      '</span>';
  }

  // -------- Block renderers --------
  // Each returns a DOM node (full block body).

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

  function wrapError(errEl) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    body.appendChild(errEl);
    return body;
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
        } else {
          replaceBody(blockEls.reviewers, renderReviewersBlock(mr, { approvals: approvals.__error ? null : approvals }));
        }
        if (approvals.__error) {
          replaceBody(blockEls.approvals, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        } else if (mr.__error) {
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, { iid: mrIid }));
        } else {
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, mr));
        }
        if (mr.__error) {
          replaceBody(blockEls.assignees, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
        } else {
          replaceBody(blockEls.assignees, renderAssigneesBlock(mr));
        }
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
