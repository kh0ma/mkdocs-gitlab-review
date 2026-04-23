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
      '<input type="text" class="glr-panel__member-popover__input" placeholder="Пошук…" />' +
      '<ul class="glr-panel__member-popover__list" role="listbox"></ul>';
    // Append to body with position:fixed to escape overflow:auto containers
    document.body.appendChild(pop);
    pop.style.position = "fixed";
    pop.style.zIndex = "10500";

    // Width: match the parent block width for visual alignment
    var blockEl = anchor.closest(".glr-panel__block") || anchor.closest(".glr-panel");
    if (blockEl) {
      pop.style.width = blockEl.getBoundingClientRect().width + "px";
    }

    var anchorRect = anchor.getBoundingClientRect();
    var popTop = anchorRect.bottom + 4;
    // Align popover left edge with the block left edge (or anchor if no block)
    var popLeft = blockEl ? blockEl.getBoundingClientRect().left : anchorRect.left;
    pop.style.top = popTop + "px";
    pop.style.left = popLeft + "px";
    // After rendering, adjust if overflowing viewport
    requestAnimationFrame(function () {
      var popRect = pop.getBoundingClientRect();
      if (popRect.bottom > window.innerHeight) {
        pop.style.top = (anchorRect.top - popRect.height - 4) + "px";
      }
      if (popRect.right > window.innerWidth) {
        pop.style.left = (window.innerWidth - popRect.width - 8) + "px";
      }
    });

    var input = pop.querySelector(".glr-panel__member-popover__input");
    var list = pop.querySelector(".glr-panel__member-popover__list");
    var timer = null;
    var sequence = 0;

    function showLoading() {
      list.innerHTML = '<li class="glr-panel__member-popover__loading">Пошук…</li>';
    }

    function showEmpty() {
      list.innerHTML = '<li class="glr-panel__member-popover__empty">Нікого не знайдено</li>';
    }

    function render(members) {
      list.innerHTML = "";
      if (!members || members.length === 0) {
        showEmpty();
        return;
      }
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
      showLoading();
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

  var SVG_CHECK = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M5 10.5L8.5 14L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  var SVG_CROSS = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M6 6L14 14M14 6L6 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function collectMandatoryUsernames(approvals) {
    var set = new Set();
    if (!approvals || !approvals.rules) return set;
    approvals.rules.forEach(function (rule) {
      (rule.eligible_approvers || []).forEach(function (u) {
        if (u.username) set.add(u.username);
      });
    });
    return set;
  }

  function renderAvatarRow(users, opts) {
    // opts: {getStatus(user), onRemove(user), onAdd, api, emptyText, mandatoryUsernames}
    var row = document.createElement("div");
    row.className = "glr-panel__avatar-row";

    if (!users || users.length === 0) {
      var empty = document.createElement("p");
      empty.className = "glr-panel__empty";
      empty.textContent = opts.emptyText || "";
      row.appendChild(empty);
    } else {
      users.forEach(function (u) {
        var status = opts.getStatus ? opts.getStatus(u) : null;
        var isMandatory = opts.mandatoryUsernames && opts.mandatoryUsernames.has(u.username);
        var item = document.createElement("span");
        item.className = "glr-panel__avatar-item";
        if (status) item.classList.add("glr-panel__avatar-item--" + status);
        if (isMandatory) item.classList.add("glr-panel__avatar-item--mandatory");

        var tooltipName = u.name || u.username;
        var tooltipStatus = status === "approved" ? " — Схвалив" : status === "requested" ? " — Очікує" : "";
        if (isMandatory) tooltipName += " (обов'язковий)";
        item.title = tooltipName + tooltipStatus;

        if (u.avatar_url) {
          var img = document.createElement("img");
          img.className = "glr-panel__avatar-img";
          img.src = u.avatar_url;
          img.alt = "";
          item.appendChild(img);
        } else {
          var ph = document.createElement("span");
          ph.className = "glr-panel__avatar-img glr-panel__avatar-img--placeholder";
          item.appendChild(ph);
        }

        if (status === "approved") {
          var badge = document.createElement("span");
          badge.className = "glr-panel__avatar-badge glr-panel__avatar-badge--approved";
          badge.textContent = "✓";
          item.appendChild(badge);
        }

        // Click avatar → small popover with remove option
        if (opts.onRemove) {
          item.style.cursor = "pointer";
          item.addEventListener("click", function (e) {
            e.stopPropagation();
            var existing = document.querySelector(".glr-panel__avatar-popover");
            if (existing) existing.remove();
            var pop = document.createElement("div");
            pop.className = "glr-panel__avatar-popover";
            pop.innerHTML =
              '<div class="glr-panel__avatar-popover__name">' + escapeHtml(u.name || u.username) + '</div>' +
              '<button type="button" class="glr-panel__avatar-popover__remove">Видалити</button>';
            pop.querySelector(".glr-panel__avatar-popover__remove").addEventListener("click", function () {
              pop.remove();
              opts.onRemove(u);
            });
            item.appendChild(pop);
            setTimeout(function () {
              document.addEventListener("click", function closePop(ev) {
                if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener("click", closePop); }
              });
            }, 0);
          });
        }

        row.appendChild(item);
      });
    }

    // Add button (dashed circle)
    if (opts.onAdd) {
      var addCircle = document.createElement("button");
      addCircle.type = "button";
      addCircle.className = "glr-panel__avatar-add";
      addCircle.title = "Додати";
      addCircle.textContent = "+";
      addCircle.addEventListener("click", function () {
        openMemberPopover(addCircle, {
          api: opts.api,
          onSelect: opts.onAdd,
        });
      });
      row.appendChild(addCircle);
    }

    return row;
  }

  function renderReviewersBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";

    var approvedUsernames = new Set(
      (ctx && ctx.approvals && ctx.approvals.approved_by || []).map(function (u) { return u.username; })
    );
    var mandatoryUsernames = ctx && ctx.approvals ? collectMandatoryUsernames(ctx.approvals) : new Set();

    var row = renderAvatarRow(mr.reviewers, {
      emptyText: "Рецензентів не призначено",
      mandatoryUsernames: mandatoryUsernames,
      getStatus: function (r) {
        return approvedUsernames.has(r.username) ? "approved" : "requested";
      },
      onRemove: ctx && ctx.api ? function (r) {
        var remaining = mr.reviewers.filter(function (u) { return u.id !== r.id; }).map(function (u) { return u.id; });
        ctx.api.setReviewers(ctx.mrIid, remaining).then(function () {
          if (ctx.onChange) ctx.onChange();
        }).catch(function (err) {
          showToast("Не вдалося видалити: " + (err && err.message || "помилка"), "error");
        });
      } : null,
      onAdd: ctx && ctx.api ? function (user) {
        var ids = (mr.reviewers || []).map(function (u) { return u.id; });
        if (ids.indexOf(user.id) >= 0) return;
        ids.push(user.id);
        ctx.api.setReviewers(ctx.mrIid, ids).then(function () {
          if (ctx.onChange) ctx.onChange();
        }).catch(function (err) {
          showToast("Не вдалося додати: " + (err && err.message || "помилка"), "error");
        });
      } : null,
      api: ctx && ctx.api,
    });

    body.appendChild(row);
    return body;
  }

  function renderApprovalsBlock(approvals, mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    var approved = (approvals.approved_by || []);
    var required = Number(approvals.required) || 0;

    // Summary row: show approval count if there are rules/required approvals
    if (required > 0 || (approvals.rules && approvals.rules.length > 0)) {
      var summary = document.createElement("p");
      summary.className = "glr-panel__approvals-counter";
      summary.innerHTML = '<span class="glr-panel__approvals-counter-icon">' + SVG_CHECK + '</span> ' +
        '<strong>' + (Number(approved.length) || 0) + '</strong>/' +
        '<strong>' + required + '</strong> схвалено';
      body.appendChild(summary);
    }

    // Interactive Approve / Reject buttons (only for open MRs)
    if (ctx && ctx.api && ctx.currentUser && mr.state === "opened") {
      var alreadyApproved = approved.some(function (u) {
        return u.username === ctx.currentUser.username;
      });

      var actions = document.createElement("div");
      actions.className = "glr-panel__approval-actions";

      // Approve button
      var approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "glr-panel__approve-btn" + (alreadyApproved ? " glr-panel__approve-btn--active" : "");
      approveBtn.innerHTML = SVG_CHECK + ' <span>' + (alreadyApproved ? "Схвалено" : "Схвалити") + '</span>';
      approveBtn.addEventListener("click", function () {
        if (approveBtn.disabled) return;
        approveBtn.disabled = true;
        var call = alreadyApproved ? ctx.api.revokeApproval(ctx.mrIid) : ctx.api.approve(ctx.mrIid);
        call
          .then(function () {
            showToast(alreadyApproved ? "Схвалення відкликано" : "Схвалено", "success");
            if (ctx.onChange) ctx.onChange();
          })
          .catch(function (err) {
            approveBtn.disabled = false;
            showToast("Не вдалося: " + (err && err.message || "помилка"), "error");
          });
      });
      actions.appendChild(approveBtn);

      body.appendChild(actions);

      // Emoji reactions — horizontal row, synced with GitLab award emojis
      // Emoji name → visual emoji mapping
      var EMOJI_MAP = {
        thumbsup: "👍", thumbsdown: "👎", rocket: "🚀", lemon: "🍋",
        see_no_evil: "🙈", robot: "🤖", black_cat: "🐈‍⬛", eggplant: "🍆",
        cucumber: "🥒", corn: "🌽", carrot: "🥕",
      };
      // Random pool (excluding thumbsup/thumbsdown — those are fixed/server)
      var RANDOM_POOL = ["lemon", "rocket", "see_no_evil", "robot", "black_cat", "eggplant", "cucumber", "corn", "carrot"];

      function pickRandom(arr, n) {
        var copy = arr.slice();
        var result = [];
        for (var i = 0; i < n && copy.length > 0; i++) {
          var idx = Math.floor(Math.random() * copy.length);
          result.push(copy.splice(idx, 1)[0]);
        }
        return result;
      }

      function makeReactionBtn(name, count, isMine) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "glr-panel__reaction-btn" + (isMine ? " glr-panel__reaction-btn--active" : "");
        btn.innerHTML = '<span class="glr-panel__reaction-emoji">' + (EMOJI_MAP[name] || name) + '</span>' +
          (count > 0 ? '<span class="glr-panel__reaction-count">' + count + '</span>' : '');
        btn.title = name;
        btn.addEventListener("click", function () {
          if (btn.disabled) return;
          btn.disabled = true;
          ctx.api.toggleAwardEmoji(ctx.mrIid, name, ctx.currentUser.id).then(function () {
            if (ctx.onChange) ctx.onChange();
          }).catch(function () {
            btn.disabled = false;
            showToast("Не вдалося", "error");
          });
        });
        return btn;
      }

      var grid = document.createElement("div");
      grid.className = "glr-panel__reaction-grid";

      ctx.api.getAwardEmojis(ctx.mrIid).then(function (emojis) {
        var userId = ctx.currentUser.id;

        // Count emojis by name
        var counts = {};
        var myEmojis = {};
        emojis.forEach(function (e) {
          counts[e.name] = (counts[e.name] || 0) + 1;
          if (e.user && String(e.user.id) === String(userId)) myEmojis[e.name] = true;
        });

        // Build display list: thumbsup always first, then server emojis by count
        var display = ["thumbsup"];
        var serverNames = Object.keys(counts).filter(function (n) { return n !== "thumbsup"; });
        serverNames.sort(function (a, b) { return (counts[b] || 0) - (counts[a] || 0); });
        serverNames.forEach(function (n) { display.push(n); });

        // Fill remaining slots to reach 4 with random emojis (not already in display)
        if (display.length < 4) {
          var available = RANDOM_POOL.filter(function (n) { return display.indexOf(n) === -1; });
          var fillers = pickRandom(available, 4 - display.length);
          fillers.forEach(function (n) { display.push(n); });
        }

        display.forEach(function (name) {
          grid.appendChild(makeReactionBtn(name, counts[name] || 0, !!myEmojis[name]));
        });
      }).catch(function () {
        // API failed — thumbsup + 3 random
        grid.appendChild(makeReactionBtn("thumbsup", 0, false));
        pickRandom(RANDOM_POOL, 3).forEach(function (name) {
          grid.appendChild(makeReactionBtn(name, 0, false));
        });
      });

      body.appendChild(grid);
    } else if (mr.state === "opened") {
      // Fallback: link to GitLab (when no currentUser provided)
      var a = document.createElement("a");
      a.className = "glr-panel__action-link glr-panel__action-link--primary";
      a.href = mrWebUrl(mr.iid);
      a.textContent = "Схвалити в GitLab";
      body.appendChild(a);
    }
    return body;
  }

  function renderFilesBlock(files, viewed, mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";
    if (!files || files.length === 0) {
      body.innerHTML = '<p class="glr-panel__empty">Немає змінених файлів</p>';
      return body;
    }
    var headSha = (mr && mr.diff_refs && mr.diff_refs.head_sha) || "unknown";

    // Detect MR preview prefix (e.g. /mr-80/) from current URL
    var siteBase = config.site_url || "";
    var mrMatch = window.location.pathname.match(/(\/mr-\d+\/)/);
    if (mrMatch) {
      siteBase = siteBase.replace(/\/$/, "") + mrMatch[1];
    }
    var viewedCount = 0;
    files.forEach(function (f) {
      if (viewed.has(f.path + ":" + headSha)) viewedCount++;
    });

    // Store subtitle text for the block header (set after replaceBody)
    body.__subtitleText = viewedCount + ' з ' + files.length + ' переглянуто';

    var ul = document.createElement("ul");
    ul.className = "glr-panel__file-list";
    files.forEach(function (f) {
      var knownStatuses = { added: 1, modified: 1, deleted: 1, renamed: 1 };
      var safeStatus = knownStatuses[f.status] ? f.status : "modified";
      var additions = Number(f.additions) || 0;
      var deletions = Number(f.deletions) || 0;
      var li = document.createElement("li");
      li.className = "glr-panel__file glr-panel__file--" + safeStatus;
      var key = f.path + ":" + headSha;
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "glr-panel__file-viewed";
      checkbox.dataset.path = f.path;
      checkbox.checked = viewed.has(key);
      checkbox.addEventListener("change", function () {
        if (!ctx || !ctx.api) return;
        if (checkbox.checked) {
          if (ctx.api.markFileViewed) ctx.api.markFileViewed(ctx.mrIid, f.path, headSha);
          viewedCount++;
        } else {
          if (ctx.api.unmarkFileViewed) ctx.api.unmarkFileViewed(ctx.mrIid, f.path, headSha);
          viewedCount--;
        }
        var block = body.closest ? body.closest(".glr-panel__block") : body.parentNode;
        if (block) {
          var sub = block.querySelector(".glr-panel__block-subtitle");
          if (sub) sub.textContent = viewedCount + ' з ' + files.length + ' переглянуто';
        }
      });
      li.appendChild(checkbox);
      var statusLetter = { added: "A", modified: "M", deleted: "D", renamed: "R" }[safeStatus];
      var fileName = f.path.split("/").pop();
      var pageMap = window.__GITLAB_REVIEW_PAGE_MAP__ || {};
      var pageUrl = pageMap[f.path];
      var pathTag;
      if (pageUrl) {
        pathTag = '<a class="glr-panel__file-path" href="' + escapeHtml(siteBase + pageUrl) + '" title="' + escapeHtml(f.path) + '">' + escapeHtml(fileName) + '</a>';
      } else {
        pathTag = '<span class="glr-panel__file-path" title="' + escapeHtml(f.path) + '">' + escapeHtml(fileName) + '</span>';
      }
      var statsHtml = "";
      if (additions > 0 || deletions > 0) {
        statsHtml = ' <span class="glr-panel__file-stats">' +
          (additions > 0 ? '<span class="glr-panel__additions">+' + additions + '</span> ' : '') +
          (deletions > 0 ? '<span class="glr-panel__deletions">−' + deletions + '</span>' : '') +
          '</span>';
      }
      var labelHtml = '<span class="glr-panel__file-status--inline glr-panel__file-status--' + safeStatus + '">' + statusLetter + '</span>' +
        pathTag + statsHtml;
      var span = document.createElement("span");
      span.innerHTML = labelHtml;
      li.appendChild(span);
      if (ctx && ctx.currentFile && f.path === ctx.currentFile) {
        li.classList.add("glr-panel__file--active");
      }
      ul.appendChild(li);
    });
    body.appendChild(ul);
    // Scroll the active file into view after the list is rendered
    requestAnimationFrame(function () {
      var active = ul.querySelector(".glr-panel__file--active");
      if (active) active.scrollIntoView({ block: "nearest" });
    });
    return body;
  }

  function renderAssigneesBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body";

    var row = renderAvatarRow(mr.assignees, {
      emptyText: "Не призначено",
      onRemove: ctx && ctx.api ? function (a) {
        var remaining = mr.assignees.filter(function (u) { return u.id !== a.id; }).map(function (u) { return u.id; });
        ctx.api.setAssignees(ctx.mrIid, remaining).then(function () {
          if (ctx.onChange) ctx.onChange();
        }).catch(function (err) {
          showToast("Не вдалося видалити: " + (err && err.message || "помилка"), "error");
        });
      } : null,
      onAdd: ctx && ctx.api ? function (user) {
        var ids = (mr.assignees || []).map(function (u) { return u.id; });
        if (ids.indexOf(user.id) >= 0) return;
        ids.push(user.id);
        ctx.api.setAssignees(ctx.mrIid, ids).then(function () {
          if (ctx.onChange) ctx.onChange();
        }).catch(function (err) {
          showToast("Не вдалося додати: " + (err && err.message || "помилка"), "error");
        });
      } : null,
      api: ctx && ctx.api,
    });

    body.appendChild(row);
    return body;
  }

  function renderActionsBlock(mr, ctx) {
    var body = document.createElement("div");
    body.className = "glr-panel__block-body glr-panel__actions";

    if (mr.state === "opened") {
      // No state badge for open MRs — the presence of Merge/Close buttons
      // makes the state obvious. Saves vertical space.

      // Merge button (primary)
      var mergeBtn = document.createElement("button");
      mergeBtn.type = "button";
      mergeBtn.className = "glr-panel__actions-btn glr-panel__actions-btn--primary glr-panel__merge-btn";
      mergeBtn.textContent = "Злити MR";

      var disabledReasons = [];
      if (mr.has_conflicts) disabledReasons.push("Конфлікти злиття");
      if (ctx && ctx.pipelineStatus && ctx.pipelineStatus.status &&
          ctx.pipelineStatus.status !== "success" &&
          ctx.pipelineStatus.status !== "manual" &&
          ctx.pipelineStatus.status !== "skipped") {
        disabledReasons.push("Pipeline не пройшов (" + ctx.pipelineStatus.status + ")");
      }
      if (ctx && ctx.approvals &&
          (ctx.approvals.approved_by || []).length < (ctx.approvals.required || 0)) {
        disabledReasons.push("Схвалень недостатньо");
      }
      if (disabledReasons.length > 0) {
        mergeBtn.disabled = true;
        mergeBtn.title = disabledReasons.join("; ");
      }
      mergeBtn.addEventListener("click", function () {
        if (mergeBtn.disabled) return;
        mergeBtn.disabled = true;
        mergeBtn.textContent = "Злиття…";
        ctx.api.mergeMR(ctx.mrIid, {
          sha: mr.diff_refs && mr.diff_refs.head_sha,
          shouldRemoveSourceBranch: true,
        }).then(function () {
          showToast("MR замерджено", "success");
          if (ctx.onChange) ctx.onChange();
        }).catch(function (err) {
          mergeBtn.disabled = false;
          mergeBtn.textContent = "Злити MR";
          showToast("Злиття не вдалось: " + (err && err.message || "помилка"), "error");
        });
      });
      body.appendChild(mergeBtn);

      // Close button (secondary / danger)
      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "glr-panel__actions-btn glr-panel__actions-btn--danger glr-panel__close-btn";
      closeBtn.textContent = "Закрити MR";
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
          closeBtn.textContent = "Закриття…";
          ctx.api.closeMR(ctx.mrIid).then(function () {
            showToast("MR закрито", "success");
            if (ctx.onChange) ctx.onChange();
          }).catch(function (err) {
            closeBtn.disabled = false;
            closeBtn.textContent = "Закрити MR";
            showToast("Закриття не вдалось: " + (err && err.message || "помилка"), "error");
          });
        });
      });
      body.appendChild(closeBtn);
    } else if (mr.state === "merged") {
      var mergedBadge = document.createElement("span");
      mergedBadge.className = "glr-panel__state-badge glr-panel__state-badge--merged";
      mergedBadge.textContent = "Злито";
      body.appendChild(mergedBadge);

      var mergedLink = document.createElement("a");
      mergedLink.className = "glr-panel__action-link glr-panel__action-link--secondary";
      mergedLink.href = mrWebUrl(mr.iid);
      mergedLink.textContent = "Переглянути в GitLab";
      body.appendChild(mergedLink);
    } else if (mr.state === "closed") {
      var closedBadge = document.createElement("span");
      closedBadge.className = "glr-panel__state-badge glr-panel__state-badge--closed";
      closedBadge.textContent = "Закрито";
      body.appendChild(closedBadge);

      var closedLink = document.createElement("a");
      closedLink.className = "glr-panel__action-link glr-panel__action-link--secondary";
      closedLink.href = mrWebUrl(mr.iid);
      closedLink.textContent = "Переглянути в GitLab";
      body.appendChild(closedLink);

      if (ctx && ctx.api && ctx.api.reopenMR) {
        var reopenBtn = document.createElement("button");
        reopenBtn.type = "button";
        reopenBtn.className = "glr-panel__actions-btn";
        reopenBtn.textContent = "Відкрити знову";
        reopenBtn.addEventListener("click", function () {
          if (reopenBtn.disabled) return;
          reopenBtn.disabled = true;
          reopenBtn.textContent = "Відкриття…";
          ctx.api.reopenMR(ctx.mrIid).then(function () {
            showToast("MR відкрито знову", "success");
            if (ctx.onChange) ctx.onChange();
          }).catch(function (err) {
            reopenBtn.disabled = false;
            reopenBtn.textContent = "Відкрити знову";
            showToast("Не вдалося відкрити: " + (err && err.message || "помилка"), "error");
          });
        });
        body.appendChild(reopenBtn);
      }
    }
    return body;
  }

  // -------- Panel lifecycle --------

  var BLOCK_DEFS = [
    { key: "reviewers",  title: "Рецензенти" },
    { key: "approvals",  title: "Схвалення" },
    { key: "files",      title: "Змінено" },
    { key: "assignees",  title: "Призначені" },
    { key: "actions",    title: "Дії з MR" },
  ];

  function buildBlockWrapper(def) {
    var el = document.createElement("section");
    el.className = "glr-panel__block glr-panel__block--" + def.key;
    el.dataset.block = def.key;
    el.innerHTML =
      '<header class="glr-panel__block-header">' +
      '<h3 class="glr-panel__block-title">' + def.title + '</h3>' +
      '<span class="glr-panel__block-subtitle"></span>' +
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
    // Update block header subtitle if the body provides one
    if (newBody.__subtitleText) {
      var sub = blockEl.querySelector(".glr-panel__block-subtitle");
      if (sub) sub.textContent = newBody.__subtitleText;
    }
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

    // MkDocs Material hides .md-sidebar--secondary below 76.25em (~1220px).
    // Use the same breakpoint so the chip-bar mode activates whenever the
    // sidebar that normally hosts the panel is hidden.
    var mql = window.matchMedia("(max-width: 76.1875em)");
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

    // Insert at the TOP of the container so the panel sits above existing
    // sibling content (e.g., MkDocs Material's ToC inside .md-sidebar--secondary).
    if (container.firstChild) {
      container.insertBefore(panel, container.firstChild);
    } else {
      container.appendChild(panel);
    }

    var unmounted = false;
    var sheetEl = null;
    var sheetSourceEl = null;
    var sheetSourceParent = null;

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
      // Move the LIVE block (preserving event listeners) into the sheet.
      sheetSourceEl = source;
      sheetSourceParent = source.parentNode;
      source.style.display = "";
      sheet.querySelector(".glr-panel__sheet-body").appendChild(source);
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
        // Move the live block back to its original parent (hidden).
        if (sheetSourceEl && sheetSourceParent) {
          sheetSourceEl.style.display = "none";
          sheetSourceParent.appendChild(sheetSourceEl);
        }
        if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
        sheetEl = null;
        sheetSourceEl = null;
        sheetSourceParent = null;
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

      Promise.all([mrPromise.catch(function () { return null; }), filesPromise])
        .then(function (results) {
          if (unmounted) return;
          var mrForSha = results[0];
          var files = results[1];
          var viewed = api.getViewedFiles ? api.getViewedFiles(mrIid) : new Set();
          replaceBody(blockEls.files, renderFilesBlock(files, viewed, mrForSha || { diff_refs: {} }, {
            api: api, mrIid: mrIid, currentFile: opts.currentFile,
          }));
          updateChipValue("files", String((files || []).length));
        })
        .catch(function () {
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
