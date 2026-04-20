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

  // -------- Member search popover --------

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
          (r.name ? '<span class="glr-panel__user-name">' + escapeHtml(r.name) + '</span>' : '') +
          '<span class="glr-panel__user-username">@' + escapeHtml(r.username) + '</span>' +
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

  function renderApprovalsBlock(approvals, mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    var approved = (approvals.approved_by || []);
    var required = Number(approvals.required) || 0;

    var html = "";
    if (required === 0 && (!approvals.rules || approvals.rules.length === 0)) {
      html += '<p class="glr-panel__empty">No approval rules configured</p>';
    } else {
      html += '<p class="glr-panel__approvals-counter"><strong>' +
        (Number(approved.length) || 0) + '</strong> of <strong>' + required + '</strong> approvals</p>';
      if (approvals.rules && approvals.rules.length > 0) {
        html += '<ul class="glr-panel__rule-list">';
        approvals.rules.forEach(function (rule) {
          var ruleApproved = (rule.approved_by || []).length;
          var ruleReq = Number(rule.approvals_required) || 0;
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

  function renderFilesBlock(files, viewed) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!files || files.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">No changed files</p>';
      return body;
    }
    var html = '<p class="glr-panel__files-count"><strong>' + (Number(files.length) || 0) + '</strong> files</p>';
    html += '<ul class="glr-panel__file-list">';
    files.forEach(function (f) {
      var knownStatuses = { added: 1, modified: 1, deleted: 1, renamed: 1 };
      var safeStatus = knownStatuses[f.status] ? f.status : "modified";
      var statusIcon = { added: "●", modified: "◐", deleted: "✕", renamed: "→" }[safeStatus];
      var additions = Number(f.additions) || 0;
      var deletions = Number(f.deletions) || 0;
      html += '<li class="glr-panel__file glr-panel__file--' + safeStatus + '">' +
        '<span class="glr-panel__file-status" aria-label="' + safeStatus + '">' + statusIcon + '</span>' +
        ' <span class="glr-panel__file-path">' + escapeHtml(f.path) + '</span>' +
        ' <span class="glr-panel__file-stats">' +
        '<span class="glr-panel__additions">+' + additions + '</span> ' +
        '<span class="glr-panel__deletions">−' + deletions + '</span>' +
        '</span>' +
        '</li>';
    });
    html += '</ul>';
    body.innerHTML = html;
    return body;
  }

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
          (a.name ? '<span class="glr-panel__user-name">' + escapeHtml(a.name) + '</span>' : '') +
          '<span class="glr-panel__user-username">@' + escapeHtml(a.username) + '</span>' +
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
        mergeBtn.disabled = true;
        confirmDialog({
          title: "Підтвердіть merge",
          body: "Об'єднати " + mr.source_branch + " → " + (mr.target_branch || "target") + "?",
          confirmLabel: "Merge",
          cancelLabel: "Скасувати",
          extraFields: [
            { name: "delete_source_branch", type: "checkbox", label: "Видалити source branch після merge", default: true },
          ],
        }).then(function (result) {
          if (!result) {
            mergeBtn.disabled = false;
            return;
          }
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
        if (closeBtn.disabled) return;
        closeBtn.disabled = true;
        confirmDialog({
          title: "Закрити MR?",
          body: "Закриття MR без merge. Можна буде переобрати у GitLab.",
          confirmLabel: "Закрити",
          danger: true,
        }).then(function (result) {
          if (!result) {
            closeBtn.disabled = false;
            return;
          }
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
          if (delBtn.disabled) return;
          delBtn.disabled = true;
          confirmDialog({
            title: "Видалити source branch?",
            body: "Гілка '" + mr.source_branch + "' буде видалена з origin. Дію неможливо відмінити.",
            confirmLabel: "Видалити",
            danger: true,
          }).then(function (result) {
            if (!result) {
              delBtn.disabled = false;
              return;
            }
            delBtn.textContent = "Видалення…";
            ctx.api.deleteSourceBranch(mr.source_branch).then(function () {
              showToast("Branch видалено", "success");
              delBtn.remove();
              if (ctx.onChange) ctx.onChange();
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

    var mql = window.matchMedia("(max-width: 768px)");
    var isMobile = mql.matches;

    var panel = document.createElement("aside");
    panel.className = "glr-panel" + (isMobile ? " glr-panel--mobile" : "");
    panel.setAttribute("aria-label", "Merge Request review panel");

    var blockEls = {};
    var chipEls = {};

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
      var pipelinePromise = api.getPipelineStatus ? api.getPipelineStatus(mrIid) : Promise.resolve({ status: null, web_url: null });

      Promise.all([
        mrPromise.catch(function (e) { return { __error: e }; }),
        approvalsPromise.catch(function (e) { return { __error: e }; }),
        pipelinePromise.catch(function () { return { status: null, web_url: null }; }),
      ]).then(function (results) {
        if (unmounted) return;
        var mr = results[0];
        var approvals = results[1];
        var pipeline = results[2];

        if (mr.__error) {
          replaceBody(blockEls.reviewers, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("reviewers", "⚠");
        } else {
          replaceBody(blockEls.reviewers, renderReviewersBlock(mr, {
            api: api,
            mrIid: mrIid,
            approvals: approvals.__error ? null : approvals,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("reviewers", String((mr.reviewers || []).length));
        }
        if (approvals.__error) {
          replaceBody(blockEls.approvals, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("approvals", "⚠");
        } else if (mr.__error) {
          // MR fetch failed but approvals succeeded — render with synthetic MR for the GitLab link
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, { iid: mrIid }, {
            api: api,
            mrIid: mrIid,
            currentUser: opts.currentUser,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("approvals", (approvals.approved_by || []).length + "/" + (approvals.required || 0));
        } else {
          replaceBody(blockEls.approvals, renderApprovalsBlock(approvals, mr, {
            api: api,
            mrIid: mrIid,
            currentUser: opts.currentUser,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("approvals", (approvals.approved_by || []).length + "/" + (approvals.required || 0));
        }
        if (mr.__error) {
          replaceBody(blockEls.assignees, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("assignees", "⚠");
        } else {
          replaceBody(blockEls.assignees, renderAssigneesBlock(mr, {
            api: api,
            mrIid: mrIid,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
          updateChipValue("assignees", String((mr.assignees || []).length));
        }
        if (mr.__error) {
          replaceBody(blockEls.actions, wrapError(makeError("Не вдалося завантажити", fetchAndRender)));
          updateChipValue("actions", "⚠");
        } else {
          replaceBody(blockEls.actions, renderActionsBlock(mr, {
            api: api,
            mrIid: mrIid,
            approvals: approvals.__error ? null : approvals,
            pipelineStatus: pipeline,
            onChange: function () { fetchAndRender(); if (opts.onChange) opts.onChange(); },
          }));
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

  window.ReviewPanel = { mount: mount };
})();
