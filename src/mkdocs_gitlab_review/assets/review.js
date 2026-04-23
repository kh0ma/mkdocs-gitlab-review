/**
 * GitLab MR Review Overlay.
 * Displays inline comment threads on MkDocs rendered pages.
 */
(function () {
  "use strict";

  var config = window.__GITLAB_REVIEW__ || {};
  var OAuth = window.GitLabOAuth;
  if (!config.gitlab_url || !config.project_id) return;

  var state = {
    mrIid: null,
    diffRefs: null,
    changedFiles: {},
    discussions: [],
    currentFile: null,
    reviewActive: false,
    baseBlocks: null,  // array of text blocks from base version
    panelHandle: null,
    tocStash: null,    // {node, parent, next} when ToC is detached for review mode
    lastMountUser: null,  // cached currentUser for re-mount on breakpoint change
    breakpointMql: null,  // matchMedia query for cleanup on deactivate
    footerScrollHandler: null, // scroll listener for footer overlap prevention
  };

  // --- Init ---

  function init() {
    // Handle OAuth callback if present
    var params = new URLSearchParams(window.location.search);
    if (params.has("code")) {
      OAuth.handleCallback().then(function () { boot(); });
      return;
    }
    boot();
  }

  function boot() {
    detectMrContext().then(function (mrIid) {
      if (!mrIid) return; // not an MR preview page

      state.mrIid = mrIid;
      state.currentFile = detectCurrentFile();
      if (!state.currentFile) return;

      // Show review toggle button
      var toggleBtn = document.getElementById("glr-review-toggle");
      if (!toggleBtn) return;
      toggleBtn.style.display = "";

      var hasReviewParam = new URLSearchParams(window.location.search).has("review");
      var sessionReview = sessionStorage.getItem("glr-review-active") === "true";

      if ((hasReviewParam || sessionReview) && OAuth.isLoggedIn()) {
        activateReview(toggleBtn);
      } else if (hasReviewParam && !OAuth.isLoggedIn()) {
        sessionStorage.setItem("glr-review-active", "true");
        OAuth.login();
      }

      toggleBtn.addEventListener("click", function () {
        if (!OAuth.isLoggedIn()) {
          sessionStorage.setItem("glr-review-active", "true");
          OAuth.login();
          return;
        }
        if (state.reviewActive) {
          deactivateReview(toggleBtn);
        } else {
          activateReview(toggleBtn);
        }
      });
    });
  }

  function showShareButton(toggleBtn) {
    if (document.getElementById("glr-share-btn")) return;

    var wrapper = document.createElement("span");
    wrapper.style.cssText = "position:relative;display:inline-flex;";

    var btn = document.createElement("button");
    btn.id = "glr-share-btn";
    btn.className = "glr-toolbar-btn";
    btn.title = "Запросити рев'ю";
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>' +
      '<span class="glr-toolbar-btn__label">Запросити рев\'ю</span>';

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      showShareDialog(wrapper);
    });

    wrapper.appendChild(btn);
    // Insert before toggle button
    toggleBtn.parentNode.insertBefore(wrapper, toggleBtn);
  }

  function showShareDialog(wrapper) {
    var existing = document.getElementById("glr-share-dialog");
    if (existing) { existing.remove(); return; }

    var reviewUrl = window.location.origin + window.location.pathname + "?review";

    var dialog = document.createElement("div");
    dialog.id = "glr-share-dialog";
    dialog.className = "glr-share-dialog";

    dialog.innerHTML =
      '<div class="glr-share-dialog__title">Запросити рев\'ю</div>' +
      '<div class="glr-share-dialog__desc">Надішліть це посилання рев\'юеру — сторінка відкриється одразу в режимі рев\'ю</div>' +
      '<div class="glr-share-dialog__url-row">' +
        '<input class="glr-share-dialog__url" type="text" value="' + reviewUrl + '" readonly>' +
        '<button class="glr-share-dialog__copy">Копіювати</button>' +
      '</div>';

    var copyBtn = dialog.querySelector(".glr-share-dialog__copy");
    var input = dialog.querySelector(".glr-share-dialog__url");

    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(reviewUrl).then(function () {
        copyBtn.textContent = "Скопійовано!";
        setTimeout(function () { copyBtn.textContent = "Копіювати"; }, 2000);
      });
    });

    input.addEventListener("click", function () { input.select(); });

    // Close on outside click
    setTimeout(function () {
      document.addEventListener("click", function closeDialog(e) {
        if (!dialog.contains(e.target) && e.target.id !== "glr-share-btn" && !e.target.closest("#glr-share-btn")) {
          dialog.remove();
          document.removeEventListener("click", closeDialog);
        }
      });
    }, 0);

    // Append to wrapper for proper positioning
    wrapper.appendChild(dialog);
  }

  function activateReview(toggleBtn) {
    state.reviewActive = true;
    sessionStorage.setItem("glr-review-active", "true");
    toggleBtn.classList.add("glr-toolbar-btn--active");
    toggleBtn.querySelector(".glr-toolbar-btn__label").innerHTML = "\u25CF Рев'ю";
    toggleBtn.title = "Вимкнути рев'ю";

    // Mark <body> so CSS can remove MkDocs' Table of Contents from the layout
    // (and JS below detaches the ToC node so it doesn't take up space or
    // receive focus while reviewing).
    document.body.classList.add("glr-review-on");
    detachToc();
    setupFooterObserver();

    // Show share button
    showShareButton(toggleBtn);

    Promise.all([
      fetchDiffRefs(),
      fetchChangedFiles(),
      fetchDiscussions(),
    ]).then(function () {
      return fetchBaseFile();
    }).then(function () {
      renderOverlay();
      scrollToHashLine();
      // Mount right-rail panel with current user (for Approve button authentication).
      // On mobile, .md-sidebar--secondary is hidden (display:none / zero height)
      // by MkDocs Material, so mount inside .md-content instead.
      var rail = document.querySelector(".md-sidebar--secondary");
      if (!rail || rail.offsetHeight === 0) {
        rail = document.querySelector(".md-content") || document.body;
      }
      if (state.panelHandle) state.panelHandle.unmount();
      window.GitlabAPI.getCurrentUser()
        .then(function (user) {
          state.lastMountUser = user;
          state.panelHandle = window.ReviewPanel.mount(rail, {
            mrIid: state.mrIid,
            api: window.GitlabAPI,
            currentUser: user,
            currentFile: state.currentFile,
          });
          setupBreakpointListener();
          // Mount comments chip after panel (chip bar now exists)
          mountCommentsDashboardChip();
        })
        .catch(function () {
          state.lastMountUser = null;
          // No user → mount in read-only mode (buttons link to GitLab).
          state.panelHandle = window.ReviewPanel.mount(rail, {
            mrIid: state.mrIid,
            api: window.GitlabAPI,
            currentFile: state.currentFile,
          });
          setupBreakpointListener();
          mountCommentsDashboardChip();
        });
    });
  }

  function setupBreakpointListener() {
    // Avoid duplicate listeners
    if (state.breakpointMql) return;

    var mql = window.matchMedia("(max-width: 76.1875em)");
    state.breakpointMql = mql;

    function handleBreakpointChange() {
      if (!state.reviewActive || !state.panelHandle) return;

      // Hide inline dashboard when switching to mobile
      var dashboard = document.getElementById("glr-dashboard");
      if (dashboard) {
        dashboard.style.display = mql.matches ? "none" : "";
      }

      // Unmount current panel
      state.panelHandle.unmount();

      // Re-detect the correct mount target
      var rail = document.querySelector(".md-sidebar--secondary");
      if (!rail || rail.offsetHeight === 0) {
        rail = document.querySelector(".md-content") || document.body;
      }

      // Re-mount with cached user context
      var mountOpts = {
        mrIid: state.mrIid,
        api: window.GitlabAPI,
        currentFile: state.currentFile,
      };
      if (state.lastMountUser) {
        mountOpts.currentUser = state.lastMountUser;
      }
      state.panelHandle = window.ReviewPanel.mount(rail, mountOpts);

      // Re-mount comments chip on mobile transition
      mountCommentsDashboardChip();
    }

    // Modern browsers
    if (mql.addEventListener) {
      mql.addEventListener("change", handleBreakpointChange);
    } else {
      // Safari <14 fallback
      mql.addListener(handleBreakpointChange);
    }
  }

  function deactivateReview(toggleBtn) {
    state.reviewActive = false;
    sessionStorage.removeItem("glr-review-active");
    toggleBtn.classList.remove("glr-toolbar-btn--active");
    toggleBtn.querySelector(".glr-toolbar-btn__label").textContent = "Рев'ю";
    toggleBtn.title = "Увімкнути рев'ю";

    // Restore MkDocs' Table of Contents that was detached on activate.
    document.body.classList.remove("glr-review-on");
    reattachToc();
    teardownFooterObserver();

    // Clean up breakpoint listener — the handler checks state.reviewActive
    // which is already false, so even if the listener lingers it is a no-op.
    state.breakpointMql = null;

    if (state.panelHandle) {
      state.panelHandle.unmount();
      state.panelHandle = null;
    }
    state.lastMountUser = null;

    // Remove all overlay elements
    document.querySelectorAll(".glr-block").forEach(function (el) {
      el.classList.remove("glr-block", "glr-block--commentable", "glr-block--has-comments",
        "glr-block--added", "glr-block--context");
    });
    document.querySelectorAll(".glr-comment-badge,.glr-threads, #glr-dashboard, #glr-share-dialog, .glr-block--deleted, .glr-panel__chip--comments, .glr-panel__sheet--comments").forEach(function (el) {
      el.remove();
    });
    // Remove share button wrapper
    var shareBtn = document.getElementById("glr-share-btn");
    if (shareBtn && shareBtn.parentNode) shareBtn.parentNode.remove();
  }

  // --- ToC detach / reattach ---
  //
  // When review mode is active, MkDocs' Table of Contents should not compete
  // for space or focus with the review panel. We detach the whole ToC subtree
  // from the DOM (not just hide it) and keep a handle so we can put it back.

  function detachToc() {
    if (state.tocStash) return; // already detached
    var toc = document.querySelector(
      ".md-sidebar--secondary .md-nav--secondary, .md-sidebar--secondary .md-nav[data-md-level=\"0\"]"
    );
    if (!toc || !toc.parentNode) return;
    state.tocStash = {
      node: toc,
      parent: toc.parentNode,
      next: toc.nextSibling,
    };
    toc.parentNode.removeChild(toc);
  }

  function reattachToc() {
    var stash = state.tocStash;
    if (!stash || !stash.parent) return;
    if (stash.next && stash.next.parentNode === stash.parent) {
      stash.parent.insertBefore(stash.node, stash.next);
    } else {
      stash.parent.appendChild(stash.node);
    }
    state.tocStash = null;
  }

  // --- Footer overlap prevention ---
  //
  // Instead of unsticking the sidebar (which makes the panel disappear),
  // dynamically shrink the panel's max-height as the footer enters the
  // viewport. The panel stays visible and sticky but stops before the footer.

  function setupFooterObserver() {
    if (state.footerObserver) return;
    var footer = document.querySelector(".md-footer");
    if (!footer) return;

    function adjustPanelHeight() {
      var panel = document.querySelector(".glr-panel:not(.glr-panel--mobile)");
      if (!panel) return;
      var footerRect = footer.getBoundingClientRect();
      var headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--md-header-height")) || 57.6;
      var availableH = Math.max(footerRect.top - headerH - 16, 120); // 16px breathing room, 120px minimum
      var fullH = window.innerHeight - headerH - 16;
      panel.style.maxHeight = Math.min(availableH, fullH) + "px";
    }

    // Use scroll listener (throttled via rAF) for smooth adjustment
    var ticking = false;
    state.footerScrollHandler = function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () {
          adjustPanelHeight();
          ticking = false;
        });
      }
    };
    window.addEventListener("scroll", state.footerScrollHandler, { passive: true });
    adjustPanelHeight(); // initial
  }

  function teardownFooterObserver() {
    if (state.footerScrollHandler) {
      window.removeEventListener("scroll", state.footerScrollHandler);
      state.footerScrollHandler = null;
    }
    var panel = document.querySelector(".glr-panel:not(.glr-panel--mobile)");
    if (panel) panel.style.maxHeight = "";
  }

  // --- Context detection ---

  function detectMrContext() {
    // 1. Build-time config (most reliable — injected from CI_MERGE_REQUEST_IID)
    if (config.mr_iid) return Promise.resolve(config.mr_iid);

    // 2. Parse current URL for /mr-{IID}/ prefix
    var match = window.location.pathname.match(/\/mr-(\d+)\//);
    if (match) return Promise.resolve(parseInt(match[1], 10));

    // 3. Fallback: version.json (resolve relative to current page, not canonical,
    //    so MR-scoped deployments get their own version.json)
    var versionUrl = "version.json";

    return fetch(versionUrl)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        return (data && data.mr_iid) ? data.mr_iid : null;
      })
      .catch(function () { return null; });
  }

  function scrollToInlineComment(selector, onNotFound, attempts) {
    attempts = attempts || 0;
    var target = document.querySelector(selector);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      var next = target.nextElementSibling;
      if (!next || !next.classList.contains("glr-threads")) {
        target.click(); // trigger block click to open threads
      }
      target.style.outline = "2px solid var(--md-accent-fg-color, #536dfe)";
      setTimeout(function () { target.style.outline = ""; }, 2000);
      return;
    }
    if (attempts < 10) {
      setTimeout(function () { scrollToInlineComment(selector, onNotFound, attempts + 1); }, 150);
    } else if (onNotFound) {
      onNotFound();
    }
  }

  function scrollToHashLine() {
    var hash = window.location.hash;
    var match = hash.match(/^#glr-line-(\d+)$/);
    if (!match) return;

    var line = match[1];
    var target = document.querySelector('[data-source-line="' + line + '"]');
    if (!target) return;

    setTimeout(function () {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      // Expand thread by clicking the block
      target.click();
      target.style.outline = "2px solid var(--md-accent-fg-color, #536dfe)";
      setTimeout(function () { target.style.outline = ""; }, 2000);
    }, 300);
  }

  function getCurrentSiteBase() {
    // Get site base URL from MkDocs config, preserving /mr-N/ prefix
    var configEl = document.getElementById("__config");
    if (configEl) {
      try {
        var mkConf = JSON.parse(configEl.textContent);
        if (mkConf.base) {
          return new URL(mkConf.base, window.location.href).href.replace(/\/$/, "") + "/";
        }
      } catch (_) {}
    }
    // Fallback: use site_url from plugin config
    return (config.site_url || window.location.origin + "/");
  }

  function detectCurrentFile() {
    // Find the first element with data-source-file
    var el = document.querySelector("[data-source-file]");
    return el ? el.getAttribute("data-source-file") : null;
  }

  // --- API calls ---

  function fetchDiffRefs() {
    return window.GitlabAPI.getMR(state.mrIid).then(function (mr) {
      if (mr.diff_refs) {
        state.diffRefs = mr.diff_refs;
      }
    }).catch(function () {});
  }

  function fetchChangedFiles() {
    var basePath = "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/diffs";

    function fetchPage(page) {
      return OAuth.apiFetch(basePath + "?per_page=20&page=" + page)
        .then(function (diffs) {
          if (!diffs || !diffs.length) return;
          diffs.forEach(function (change) {
            var parsed = parseDiff(change.diff || "");
            // If diff is empty/truncated but file has many lines, mark as large
            var isLarge = !change.diff || change.diff.length === 0;
            state.changedFiles[change.new_path] = {
              old_path: change.old_path,
              new_path: change.new_path,
              new_lines: parsed.new_lines,
              lineMap: parsed.lineMap,
              deletedLines: parsed.deletedLines,
              new_file: change.new_file,
              deleted_file: change.deleted_file,
              too_large: change.too_large || isLarge,
            };
          });
          if (diffs.length === 20) return fetchPage(page + 1);
        });
    }

    return fetchPage(1).catch(function () {});
  }

  function fetchDiscussions() {
    state.discussions = [];

    function fetchPage(page) {
      return window.GitlabAPI.getDiscussions(state.mrIid, { page: page, perPage: 100 })
        .then(function (discussions) {
          if (!discussions || !discussions.length) return;
          state.discussions = state.discussions.concat(discussions);
          // Keep fetching while full pages come back.
          if (discussions.length === 100) {
            return fetchPage(page + 1);
          }
        });
    }

    return fetchPage(1).catch(function () {});
  }

  function fetchBaseFile() {
    if (!state.diffRefs || !state.currentFile) return Promise.resolve();
    var fileInfo = state.changedFiles[state.currentFile];
    if (!fileInfo || fileInfo.new_file) {
      state.baseBlocks = []; // new file — no base
      return Promise.resolve();
    }

    var filePath = encodeURIComponent(fileInfo.old_path);
    var ref = state.diffRefs.base_sha;

    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/repository/files/" + filePath + "/raw?ref=" + ref,
      { headers: { "Accept": "text/plain" } }
    ).then(function (text) {
      // apiFetch returns JSON by default — for raw we get text
      state.baseBlocks = parseMarkdownBlocks(typeof text === "string" ? text : "");
    }).catch(function () {
      // Try fetching as blob/text
      var token = OAuth.getToken();
      if (!token) { state.baseBlocks = []; return; }
      return fetch(
        config.gitlab_url + "/api/v4/projects/" + config.project_id +
          "/repository/files/" + filePath + "/raw?ref=" + ref,
        { headers: { "Authorization": "Bearer " + token } }
      ).then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (text) {
          state.baseBlocks = parseMarkdownBlocks(text);
        })
        .catch(function () { state.baseBlocks = []; });
    });
  }

  function parseMarkdownBlocks(md) {
    // Split markdown into blocks (by blank lines), return trimmed text per block
    if (!md) return [];
    var blocks = [];
    var current = [];

    // Skip frontmatter
    var lines = md.split("\n");
    var start = 0;
    if (lines[0] && lines[0].trim() === "---") {
      for (var i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { start = i + 1; break; }
      }
    }

    for (var j = start; j < lines.length; j++) {
      var line = lines[j];
      if (line.trim() === "") {
        if (current.length > 0) {
          blocks.push(current.join("\n").trim());
          current = [];
        }
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) blocks.push(current.join("\n").trim());
    return blocks;
  }

  // --- Diff parsing ---

  function parseDiff(diff) {
    // Parse unified diff to build old↔new line mapping
    // Returns { new_lines: Set, lineMap: Map, deletedLines: [{old_line, text}] }
    var lines = diff.split("\n");
    var newLines = new Set();
    var lineMap = {};
    var deletedLines = [];
    var oldLine = 0;
    var newLine = 0;

    lines.forEach(function (line) {
      var hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[2], 10);
        return;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        newLines.add(newLine);
        lineMap[newLine] = { old_line: null, new_line: newLine, type: "added" };
        newLine++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletedLines.push({ old_line: oldLine, text: line.substring(1), after_new_line: newLine });
        oldLine++;
      } else if (!line.startsWith("\\")) {
        // Context line
        lineMap[newLine] = { old_line: oldLine, new_line: newLine, type: "context" };
        oldLine++;
        newLine++;
      }
    });

    return { new_lines: newLines, lineMap: lineMap, deletedLines: deletedLines };
  }

  // --- Rendering ---

  function renderOverlay() {
    // Guard: remove any existing overlay elements before re-rendering.
    // Rapid toggle cycles can cause overlapping async renderOverlay calls;
    // clearing first prevents duplicate dashboard entries and action buttons.
    document.querySelectorAll(".glr-comment-badge,.glr-threads, #glr-dashboard, .glr-block--deleted, .glr-panel__chip--comments, .glr-panel__sheet--comments").forEach(function (el) {
      el.remove();
    });
    document.querySelectorAll(".glr-block").forEach(function (el) {
      el.classList.remove("glr-block", "glr-block--commentable", "glr-block--has-comments",
        "glr-block--added", "glr-block--context");
    });

    var fileInfo = state.changedFiles[state.currentFile];
    var isChanged = !!fileInfo;

    // Find all annotated blocks
    var blocks = document.querySelectorAll("[data-source-file][data-source-line]");

    blocks.forEach(function (block) {
      var file = block.getAttribute("data-source-file");
      var line = parseInt(block.getAttribute("data-source-line"), 10);

      if (file !== state.currentFile) return;

      var canComment = true;
      var discussions = findDiscussionsForLine(file, line);

      // Diff visualization — mark block change type
      block.classList.add("glr-block");
      block.classList.add("glr-block--commentable");
      if (isChanged && fileInfo.new_file) {
        block.classList.add("glr-block--added");
      } else if (isChanged && fileInfo.new_lines.has(line)) {
        block.classList.add("glr-block--added");
      } else if (isChanged) {
        block.classList.add("glr-block--context");
      }

      var isExpanded = false;
      var count = discussions.length;

      // Click the block itself to toggle comments — no floating button needed
      block.style.cursor = "pointer";
      block.addEventListener("click", function (e) {
        // Don't trigger on clicks inside threads or editors
        if (e.target.closest(".glr-threads, .glr-form, .glr-editor__quill, .ql-editor")) return;
        var existing = block.nextElementSibling;
        if (existing && existing.classList.contains("glr-threads")) {
          existing.remove();
          isExpanded = false;
        } else {
          showThreads(block, file, line, discussions, canComment);
          isExpanded = true;
        }
      });

      // Small unobtrusive count badge for blocks with comments (no button for empty blocks)
      if (count > 0) {
        var badge = document.createElement("span");
        badge.className = "glr-comment-badge";
        badge.textContent = String(count);
        badge.title = count + " коментар" + (count > 1 ? "ів" : "");
        block.appendChild(badge);
        block.classList.add("glr-block--has-comments");
        // Auto-expand threads when comments exist
        showThreads(block, file, line, discussions, canComment);
        isExpanded = true;
      }
    });

    // Insert ghost blocks for deleted lines
    if (isChanged && fileInfo.deletedLines && fileInfo.deletedLines.length > 0) {
      insertDeletedBlocks(fileInfo.deletedLines);
    }

    // Render comments dashboard panel
    renderCommentsDashboard();

    // On mobile, mount comments dashboard as a chip in the chip bar
    mountCommentsDashboardChip();
  }

  function relativeDate(isoString) {
    var diff = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "щойно";
    if (mins < 60) return mins + " хв";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + " год";
    var days = Math.floor(hours / 24);
    if (days < 7) return days + " дн";
    var weeks = Math.floor(days / 7);
    if (weeks < 4) return weeks + " тиж";
    var months = Math.floor(days / 30);
    return months + " міс";
  }

  function startCardEdit(card, discussion, note) {
    var textEl = card.querySelector(".glr-dashboard__card-text");
    if (!textEl || textEl.dataset.editing) return;
    textEl.dataset.editing = "1";

    var originalText = textEl.textContent;
    var originalBody = note.body || "";

    // Replace text with textarea
    var textarea = document.createElement("textarea");
    textarea.className = "glr-dashboard__card-textarea";
    textarea.value = originalBody;
    textarea.addEventListener("click", function (e) { e.stopPropagation(); });

    var actions = document.createElement("div");
    actions.className = "glr-dashboard__card-edit-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "glr-dashboard__card-save";
    saveBtn.textContent = "Зберегти";

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "glr-dashboard__card-cancel";
    cancelBtn.textContent = "Скасувати";

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    textEl.textContent = "";
    textEl.style.display = "none";
    card.insertBefore(textarea, textEl.nextSibling);
    card.insertBefore(actions, textarea.nextSibling);
    textarea.focus();

    cancelBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      textarea.remove();
      actions.remove();
      textEl.textContent = originalText;
      textEl.style.display = "";
      delete textEl.dataset.editing;
    });

    saveBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var newBody = textarea.value;
      if (!newBody.trim()) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "Збереження...";
      cancelBtn.disabled = true;

      window.GitlabAPI.editNote(state.mrIid, discussion.id, note.id, newBody)
        .then(function () {
          note.body = newBody;
          var newPlain = stripFilePrefix(newBody).replace(/<[^>]+>/g, "").substring(0, 80);
          textarea.remove();
          actions.remove();
          textEl.textContent = newPlain;
          textEl.style.display = "";
          delete textEl.dataset.editing;
        })
        .catch(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = "Зберегти";
          cancelBtn.disabled = false;
        });
    });
  }

  function renderCommentsDashboard() {
    // Remove old dashboard
    var old = document.getElementById("glr-dashboard");
    if (old) old.remove();

    // Filter to user discussions only
    var userDiscussions = state.discussions.filter(function (d) {
      var note = d.notes && d.notes[0];
      return note && !note.system && note.body;
    });

    if (userDiscussions.length === 0) return;

    var resolved = userDiscussions.filter(function (d) {
      return d.notes && d.notes.some(function (n) { return n.resolved; });
    }).length;
    var total = userDiscussions.length;

    var panel = document.createElement("div");
    panel.id = "glr-dashboard";
    panel.className = "glr-dashboard";

    var header = document.createElement("header");
    header.className = "glr-dashboard__header";
    header.innerHTML = '<h3 class="glr-dashboard__title">КОМЕНТАРІ</h3>' +
      '<span class="glr-dashboard__count">' + resolved + '/' + total + ' вирішено</span>';
    panel.appendChild(header);

    var grid = document.createElement("div");
    grid.className = "glr-dashboard__grid";

    userDiscussions.forEach(function (d) {
      var note = d.notes && d.notes[0];
      if (!note) return;

      var file = "";
      var line = 0;
      if (note.position) {
        file = note.position.new_path || "";
        line = note.position.new_line || 0;
      } else if (note.body) {
        var match = note.body.match(/^\*\*([^:]+):(\d+)\*\*/);
        if (match) { file = match[1]; line = parseInt(match[2]); }
      }
      if (!file) file = "Загальні";

      var isRes = d.notes.some(function (n) { return n.resolved; });
      var bodyText = stripFilePrefix(note.body || "");
      // Strip HTML tags for plain text display
      var plainText = bodyText.replace(/<[^>]+>/g, "").substring(0, 80);
      var authorName = note.author ? note.author.name : "Невідомий";
      var avatarUrl = note.author && note.author.avatar_url ? note.author.avatar_url : "";
      var fileName = file.split("/").pop();
      var threadCount = d.notes.filter(function (n) { return !n.system; }).length;

      var card = document.createElement("div");
      card.className = "glr-dashboard__card";
      card.dataset.discussionId = d.id;

      // Card top: avatar + author + edit pencil
      var cardTop = document.createElement("div");
      cardTop.className = "glr-dashboard__card-top";

      if (avatarUrl) {
        var avatarWrapper = document.createElement("span");
        avatarWrapper.className = "glr-dashboard__card-avatar-wrap";
        var avatar = document.createElement("img");
        avatar.className = "glr-dashboard__card-avatar";
        avatar.src = avatarUrl;
        avatar.alt = "";
        avatarWrapper.appendChild(avatar);
        // Check if note author is MR author — add badge
        if (note.author && state._mrAuthorId && note.author.id === state._mrAuthorId) {
          avatarWrapper.classList.add("glr-dashboard__card-avatar--author");
        }
        cardTop.appendChild(avatarWrapper);
      }

      var authorEl = document.createElement("span");
      authorEl.className = "glr-dashboard__card-author";
      authorEl.textContent = authorName;
      cardTop.appendChild(authorEl);

      // Edit pencil — only for own notes
      if (state.lastMountUser && note.author && String(note.author.id) === String(state.lastMountUser.id)) {
        var editBtn = document.createElement("button");
        editBtn.className = "glr-dashboard__card-edit";
        editBtn.title = "Редагувати";
        editBtn.textContent = "\u270F";
        editBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          startCardEdit(card, d, note);
        });
        cardTop.appendChild(editBtn);
      }

      card.appendChild(cardTop);

      // File link
      var fileLink = document.createElement("a");
      fileLink.className = "glr-dashboard__card-file";
      fileLink.textContent = fileName;
      fileLink.href = "#";
      fileLink.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); });
      card.appendChild(fileLink);

      // Comment text
      var textEl = document.createElement("p");
      textEl.className = "glr-dashboard__card-text";
      textEl.textContent = plainText;
      card.appendChild(textEl);

      // Meta: status + threads + date
      var meta = document.createElement("div");
      meta.className = "glr-dashboard__card-meta";

      var statusEl = document.createElement("span");
      statusEl.className = "glr-dashboard__card-status " +
        (isRes ? "glr-dashboard__card-status--resolved" : "glr-dashboard__card-status--open");
      statusEl.textContent = isRes ? "✅" : "🟡";
      meta.appendChild(statusEl);

      if (threadCount > 1) {
        var threadsEl = document.createElement("span");
        threadsEl.className = "glr-dashboard__card-threads";
        threadsEl.textContent = "💬 " + threadCount;
        meta.appendChild(threadsEl);
      }

      var dateEl = document.createElement("span");
      dateEl.className = "glr-dashboard__card-date";
      dateEl.textContent = relativeDate(note.created_at);
      meta.appendChild(dateEl);

      card.appendChild(meta);

      // Reactions per card (thumbsup + 3 random from shared pool)
      if (state.lastMountUser) {
        var reactions = document.createElement("div");
        reactions.className = "glr-dashboard__card-reactions";
        var CARD_EMOJIS = {
          thumbsup: "\uD83D\uDC4D", thumbsdown: "\uD83D\uDC4E", rocket: "\uD83D\uDE80", lemon: "\uD83C\uDF4B",
          see_no_evil: "\uD83D\uDE48", robot: "\uD83E\uDD16", black_cat: "\uD83D\uDC08\u200D\u2B1B", eggplant: "\uD83C\uDF46",
          cucumber: "\uD83E\uDD52", corn: "\uD83C\uDF3D", carrot: "\uD83E\uDD55",
        };
        var CARD_RANDOM_POOL = ["lemon", "rocket", "see_no_evil", "robot", "black_cat", "eggplant", "cucumber", "corn", "carrot"];
        function cardPickRandom(arr, n) {
          var copy = arr.slice();
          var result = [];
          for (var i = 0; i < n && copy.length > 0; i++) {
            var idx = Math.floor(Math.random() * copy.length);
            result.push(copy.splice(idx, 1)[0]);
          }
          return result;
        }
        var cardEmojiNames = ["thumbsup"].concat(cardPickRandom(CARD_RANDOM_POOL, 3));

        cardEmojiNames.forEach(function (emojiName) {
          var reactionBtn = document.createElement("button");
          reactionBtn.type = "button";
          reactionBtn.className = "glr-dashboard__card-reaction";
          reactionBtn.textContent = CARD_EMOJIS[emojiName] || emojiName;
          reactionBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (reactionBtn.disabled) return;
            reactionBtn.disabled = true;
            window.GitlabAPI.toggleNoteEmoji(state.mrIid, note.id, emojiName, state.lastMountUser.id)
              .then(function (result) {
                reactionBtn.disabled = false;
                if (result.action === "added") {
                  reactionBtn.classList.add("glr-dashboard__card-reaction--active");
                } else {
                  reactionBtn.classList.remove("glr-dashboard__card-reaction--active");
                }
              })
              .catch(function () { reactionBtn.disabled = false; });
          });
          reactions.appendChild(reactionBtn);
        });

        card.appendChild(reactions);
      }

      // Click card → scroll to inline thread
      card.addEventListener("click", function () {
        var selector = '[data-source-file="' + file + '"][data-source-line="' + line + '"]';
        scrollToInlineComment(selector, function notFound() {
          var pageMap = window.__GITLAB_REVIEW_PAGE_MAP__ || {};
          var pageUrl = pageMap[file];
          var currentBase = getCurrentSiteBase();
          if (pageUrl !== undefined) {
            window.location.href = currentBase + pageUrl + "?review#glr-line-" + line;
          } else {
            var pagePath = file.replace(/\.md$/, "/").replace(/^index\/$/, "");
            if (pagePath.indexOf("/") === -1) pagePath = pagePath.toLowerCase();
            window.location.href = currentBase + pagePath + "?review#glr-line-" + line;
          }
        });
      });

      grid.appendChild(card);
    });

    panel.appendChild(grid);

    var content = document.querySelector(".md-content__inner");
    if (content) content.insertBefore(panel, content.firstChild);

    // Cache MR author ID for author badge (fetch once)
    if (!state._mrAuthorId && state.mrIid) {
      window.GitlabAPI.getMR(state.mrIid).then(function (mr) {
        if (mr && mr.author) state._mrAuthorId = mr.author.id;
      }).catch(function () {});
    }
  }

  function mountCommentsDashboardChip() {
    var mql = window.matchMedia("(max-width: 76.1875em)");
    if (!mql.matches) return;

    var chipBar = document.querySelector(".glr-panel__chip-bar");
    if (!chipBar) {
      // Panel not mounted yet — retry after a short delay
      setTimeout(mountCommentsDashboardChip, 200);
      return;
    }

    var dashboard = document.getElementById("glr-dashboard");

    // Remove any previously injected comments chip
    var existing = chipBar.querySelector(".glr-panel__chip--comments");
    if (existing) existing.remove();

    // Count open (unresolved) discussions
    var userDiscussions = state.discussions.filter(function (d) {
      var note = d.notes && d.notes[0];
      return note && !note.system && note.body;
    });
    // Create chip
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "glr-panel__chip glr-panel__chip--comments";
    chip.dataset.block = "comments";
    chip.innerHTML = '<span class="glr-panel__chip-label">Коментарі</span>' +
      '<span class="glr-panel__chip-value">' + String(userDiscussions.length) + '</span>';

    // Insert as first chip
    chipBar.insertBefore(chip, chipBar.firstChild);

    // Hide inline dashboard on mobile (content is in the chip sheet)
    if (dashboard) dashboard.style.display = "none";

    // Chip tap → open bottom sheet with dashboard content
    chip.addEventListener("click", function () {
      // Close any existing sheet opened by panel.js or previous click
      var existingSheet = document.querySelector(".glr-panel__sheet--comments");
      if (existingSheet) {
        if (typeof existingSheet.close === "function") {
          try { existingSheet.close(); } catch (e) {}
        }
        if (existingSheet.parentNode) existingSheet.parentNode.removeChild(existingSheet);
        return;
      }

      var sheet = document.createElement("dialog");
      sheet.className = "glr-panel__sheet glr-panel__sheet--comments";
      sheet.innerHTML = '<button type="button" class="glr-panel__sheet-close" aria-label="Закрити">\u00d7</button>' +
        '<div class="glr-panel__sheet-body"></div>';

      var sheetBody = sheet.querySelector(".glr-panel__sheet-body");

      // Move the live dashboard DOM into the sheet (preserves event listeners)
      var dashboardEl = document.getElementById("glr-dashboard");
      var dashboardParent = null;
      var dashboardNext = null;
      if (dashboardEl) {
        dashboardParent = dashboardEl.parentNode;
        dashboardNext = dashboardEl.nextSibling;
        dashboardEl.style.display = "";
        sheetBody.appendChild(dashboardEl);
      } else {
        // No discussions — show empty message
        var empty = document.createElement("p");
        empty.className = "glr-panel__empty";
        empty.textContent = "Немає коментарів";
        sheetBody.appendChild(empty);
      }

      document.body.appendChild(sheet);

      function closeSheet() {
        if (typeof sheet.close === "function") {
          try { sheet.close(); } catch (e) {}
        }
        // Move dashboard back and re-hide it
        if (dashboardEl && dashboardParent) {
          dashboardEl.style.display = "none";
          if (dashboardNext && dashboardNext.parentNode === dashboardParent) {
            dashboardParent.insertBefore(dashboardEl, dashboardNext);
          } else {
            dashboardParent.appendChild(dashboardEl);
          }
        }
        if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      }

      sheet.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeSheet();
      });
      sheet.addEventListener("click", function (e) {
        if (e.target === sheet) closeSheet();
      });
      sheet.querySelector(".glr-panel__sheet-close").addEventListener("click", closeSheet);

      if (typeof sheet.showModal === "function") {
        try { sheet.showModal(); } catch (e) {}
      } else {
        sheet.setAttribute("open", "");
      }
    });
  }

  function insertDeletedBlocks(deletedLines) {
    // Group consecutive deleted lines into blocks
    var blocks = [];
    var current = null;

    deletedLines.forEach(function (dl) {
      if (current && dl.old_line === current.endOld + 1 && dl.after_new_line === current.afterNew) {
        current.lines.push(dl.text);
        current.endOld = dl.old_line;
      } else {
        if (current) blocks.push(current);
        current = {
          lines: [dl.text],
          afterNew: dl.after_new_line,
          startOld: dl.old_line,
          endOld: dl.old_line,
        };
      }
    });
    if (current) blocks.push(current);

    // Insert each deleted block as ghost element before the corresponding new line block
    blocks.forEach(function (block) {
      var text = block.lines.join("\n");
      if (!text.trim()) return;

      var ghost = document.createElement("div");
      ghost.className = "glr-block--deleted";
      ghost.innerHTML = '<div class="glr-block--deleted__label">Видалено</div>' +
        '<div class="glr-block--deleted__content">' + escapeHtml(text) + '</div>';

      // Find the block at after_new_line to insert before
      var target = document.querySelector(
        '[data-source-file="' + state.currentFile + '"][data-source-line="' + block.afterNew + '"]'
      );
      if (target) {
        target.insertAdjacentElement("beforebegin", ghost);
      }
    });
  }

  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }


  // --- Thread UI ---

  function showThreads(block, file, line, discussions, canComment) {
    var container = document.createElement("div");
    container.className = "glr-threads";

    // Existing discussions
    discussions.forEach(function (discussion) {
      var thread = renderThread(discussion);
      container.appendChild(thread);
    });

    // New comment form
    if (canComment) {
      var form = renderCommentForm(file, line, function (discussion) {
        // On success: add rendered thread, refresh
        var thread = renderThread(discussion);
        container.insertBefore(thread, container.lastElementChild);
      });

      if (discussions.length > 0) {
        // Wrap form in a collapsible section when threads exist
        var formWrapper = document.createElement("div");
        formWrapper.style.display = "none";
        formWrapper.appendChild(form);

        var toggleBtn = document.createElement("button");
        toggleBtn.className = "glr-new-comment-toggle";
        toggleBtn.textContent = "Новий коментар";
        toggleBtn.addEventListener("click", function () {
          var hidden = formWrapper.style.display === "none";
          formWrapper.style.display = hidden ? "" : "none";
          toggleBtn.textContent = hidden ? "Сховати форму" : "Новий коментар";
        });

        container.appendChild(toggleBtn);
        container.appendChild(formWrapper);
      } else {
        container.appendChild(form);
      }
    }

    block.insertAdjacentElement("afterend", container);
  }

  function renderNote(note, opts) {
    opts = opts || {};
    var noteEl = document.createElement("div");
    noteEl.className = "glr-note";
    if (opts.isReply) noteEl.classList.add("glr-note--reply");

    var header = document.createElement("div");
    header.className = "glr-note__header";

    if (note.author && note.author.avatar_url) {
      var avatar = document.createElement("img");
      avatar.className = "glr-note__avatar";
      avatar.src = note.author.avatar_url;
      avatar.width = 22;
      avatar.height = 22;
      header.appendChild(avatar);
    }

    var authorEl;
    if (note.author) {
      authorEl = document.createElement("a");
      authorEl.href = (config.project_url || config.gitlab_url).replace(/\/$/, "") + "/" + note.author.username;
      authorEl.target = "_blank";
      authorEl.rel = "noopener";
      authorEl.className = "glr-note__author";
      authorEl.textContent = note.author.name || note.author.username;
    } else {
      authorEl = document.createElement("strong");
      authorEl.textContent = "Невідомий";
    }
    header.appendChild(authorEl);

    // Relative date
    var noteUrl = (config.project_url || config.gitlab_url).replace(/\/$/, "") +
      "/-/merge_requests/" + state.mrIid + "#note_" + note.id;

    var dateEl = document.createElement("a");
    dateEl.className = "glr-note__date";
    dateEl.textContent = relativeDate(note.created_at);
    dateEl.href = noteUrl;
    dateEl.target = "_blank";
    dateEl.rel = "noopener";
    dateEl.title = formatTime(note.created_at);
    header.appendChild(dateEl);

    // Edit pencil — only for own notes
    var currentUser = state.lastMountUser;
    if (currentUser && note.author && String(note.author.id) === String(currentUser.id) && opts.discussion) {
      var editBtn = document.createElement("button");
      editBtn.className = "glr-note__edit";
      editBtn.title = "Редагувати";
      editBtn.textContent = "\u270F";
      editBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        startNoteEdit(noteEl, opts.discussion, note);
      });
      header.appendChild(editBtn);
    }

    noteEl.appendChild(header);

    var body = document.createElement("div");
    body.className = "glr-note__body";

    var cleaned = stripFilePrefix(note.body);
    cleaned = cleaned.replace(/\{width=\d+\s+height=\d+\}/g, "");
    if (cleaned && cleaned.charAt(0) === "<") {
      body.innerHTML = fixRelativeUrls(cleaned);
    } else {
      body.innerHTML = renderMd(cleaned);
    }
    highlightMentions(body);
    loadAuthImages(body, note.id);
    noteEl.appendChild(body);

    // Per-note reactions — thumbsup + 3 random from shared pool
    if (currentUser) {
      var reactions = document.createElement("div");
      reactions.className = "glr-note__reactions";

      var NOTE_EMOJI_MAP = {
        thumbsup: "\uD83D\uDC4D", thumbsdown: "\uD83D\uDC4E", rocket: "\uD83D\uDE80", lemon: "\uD83C\uDF4B",
        see_no_evil: "\uD83D\uDE48", robot: "\uD83E\uDD16", black_cat: "\uD83D\uDC08\u200D\u2B1B", eggplant: "\uD83C\uDF46",
        cucumber: "\uD83E\uDD52", corn: "\uD83C\uDF3D", carrot: "\uD83E\uDD55",
      };
      var NOTE_RANDOM_POOL = ["lemon", "rocket", "see_no_evil", "robot", "black_cat", "eggplant", "cucumber", "corn", "carrot"];

      function notePickRandom(arr, n) {
        var copy = arr.slice();
        var result = [];
        for (var i = 0; i < n && copy.length > 0; i++) {
          var idx = Math.floor(Math.random() * copy.length);
          result.push(copy.splice(idx, 1)[0]);
        }
        return result;
      }

      var noteEmojiNames = ["thumbsup"].concat(notePickRandom(NOTE_RANDOM_POOL, 3));

      noteEmojiNames.forEach(function (emojiName) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "glr-note__reaction";
        btn.textContent = NOTE_EMOJI_MAP[emojiName] || emojiName;
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (btn.disabled) return;
          btn.disabled = true;
          window.GitlabAPI.toggleNoteEmoji(state.mrIid, note.id, emojiName, currentUser.id)
            .then(function (result) {
              btn.disabled = false;
              if (result.action === "added") {
                btn.classList.add("glr-note__reaction--active");
              } else {
                btn.classList.remove("glr-note__reaction--active");
              }
            })
            .catch(function () { btn.disabled = false; });
        });
        reactions.appendChild(btn);
      });

      noteEl.appendChild(reactions);
    }

    return noteEl;
  }

  function startNoteEdit(noteEl, discussion, note) {
    var body = noteEl.querySelector(".glr-note__body");
    if (!body || body.dataset.editing) return;
    body.dataset.editing = "1";

    var originalHtml = body.innerHTML;
    var originalBody = note.body || "";

    var textarea = document.createElement("textarea");
    textarea.className = "glr-dashboard__card-textarea";
    textarea.value = originalBody;
    textarea.style.width = "100%";
    textarea.addEventListener("click", function (e) { e.stopPropagation(); });

    var actions = document.createElement("div");
    actions.className = "glr-dashboard__card-edit-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "glr-dashboard__card-save";
    saveBtn.textContent = "Зберегти";

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "glr-dashboard__card-cancel";
    cancelBtn.textContent = "Скасувати";

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    body.innerHTML = "";
    body.appendChild(textarea);
    body.appendChild(actions);
    textarea.focus();

    cancelBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      body.innerHTML = originalHtml;
      delete body.dataset.editing;
    });

    saveBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var newBody = textarea.value;
      if (!newBody.trim()) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "Збереження...";
      cancelBtn.disabled = true;

      window.GitlabAPI.editNote(state.mrIid, discussion.id, note.id, newBody)
        .then(function () {
          note.body = newBody;
          var cleaned = stripFilePrefix(newBody);
          cleaned = cleaned.replace(/\{width=\d+\s+height=\d+\}/g, "");
          if (cleaned && cleaned.charAt(0) === "<") {
            body.innerHTML = fixRelativeUrls(cleaned);
          } else {
            body.innerHTML = renderMd(cleaned);
          }
          highlightMentions(body);
          delete body.dataset.editing;
        })
        .catch(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = "Зберегти";
          cancelBtn.disabled = false;
        });
    });
  }

  function renderThread(discussion) {
    var div = document.createElement("div");
    div.className = "glr-thread";
    if (discussion.notes && discussion.notes[0] && discussion.notes[0].resolved) {
      div.classList.add("glr-thread--resolved");
    }

    var userNotes = (discussion.notes || []).filter(function (n) { return !n.system; });
    userNotes.forEach(function (note, idx) {
      div.appendChild(renderNote(note, { isReply: idx > 0, discussion: discussion }));
    });

    // Thread actions bar
    var actionsBar = document.createElement("div");
    actionsBar.className = "glr-thread__actions";

    // Resolve toggle
    var isResolved = discussion.notes && discussion.notes.some(function (n) { return n.resolved; });
    var resolveBtn = document.createElement("button");
    resolveBtn.className = "glr-thread__action";
    resolveBtn.innerHTML = (isResolved ? "\u2705 \u0412\u0438\u0440\u0456\u0448\u0435\u043D\u043E" : "\u25CB \u0412\u0438\u0440\u0456\u0448\u0438\u0442\u0438");
    resolveBtn.addEventListener("click", function () {
      var noteId = discussion.notes[0].id;
      var newState = !isResolved;
      resolveBtn.disabled = true;
      OAuth.apiFetch(
        "/projects/" + config.project_id + "/merge_requests/" + state.mrIid +
          "/discussions/" + discussion.id + "/notes/" + noteId,
        { method: "PUT", body: JSON.stringify({ resolved: newState }) }
      ).then(function () {
        isResolved = newState;
        resolveBtn.innerHTML = (newState ? "\u2705 \u0412\u0438\u0440\u0456\u0448\u0435\u043D\u043E" : "\u25CB \u0412\u0438\u0440\u0456\u0448\u0438\u0442\u0438");
        resolveBtn.disabled = false;
        div.classList.toggle("glr-thread--resolved", newState);
      }).catch(function () { resolveBtn.disabled = false; });
    });
    actionsBar.appendChild(resolveBtn);

    // Reply button
    var replyBtn = document.createElement("button");
    replyBtn.className = "glr-thread__action";
    replyBtn.innerHTML = "\uD83D\uDCAC \u0412\u0456\u0434\u043F\u043E\u0432\u0456\u0441\u0442\u0438";
    actionsBar.appendChild(replyBtn);

    div.appendChild(actionsBar);

    // Reply form (hidden by default, opened by the actions bar reply button)
    var replyForm = renderReplyForm(discussion.id, div);
    replyForm.style.display = "none";
    // Hide the form's own toggle — the actions bar button replaces it
    var formToggle = replyForm.querySelector(".glr-form__toggle");
    if (formToggle) formToggle.style.display = "none";
    div.appendChild(replyForm);

    replyBtn.addEventListener("click", function () {
      var isHidden = replyForm.style.display === "none";
      replyForm.style.display = isHidden ? "" : "none";
      if (isHidden) {
        var inputArea = replyForm.querySelector(".glr-form__area");
        if (inputArea) inputArea.style.display = "block";
        var editorEl = replyForm.querySelector(".glr-editor__quill");
        if (editorEl) editorEl.focus();
      }
    });

    return div;
  }

  // --- Markdown rendering (using marked.js from CDN) ---

  function renderMd(text) {
    if (!text) return "";
    // Strip GitLab-specific {width=N height=N} image attributes
    text = text.replace(/\{width=\d+\s+height=\d+\}/g, "");
    if (typeof marked !== "undefined") {
      marked.setOptions({ breaks: true, gfm: true });
      return fixRelativeUrls(marked.parse(text));
    }
    return "<p>" + text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>") + "</p>";
  }

  // --- Editor (Quill.js WYSIWYG on desktop, plain textarea on mobile) ---

  function createEditor(placeholder) {
    var isMobile = window.matchMedia("(max-width: 76.1875em)").matches;

    if (isMobile) {
      var mobileWrapper = document.createElement("div");
      mobileWrapper.className = "glr-editor glr-editor--mobile";

      var textarea = document.createElement("textarea");
      textarea.className = "glr-editor__textarea";
      textarea.placeholder = placeholder || "Коментар (markdown)...";
      textarea.rows = 3;
      mobileWrapper.appendChild(textarea);

      return {
        el: mobileWrapper,
        getMarkdown: function () { return textarea.value; },
        clear: function () { textarea.value = ""; },
        focus: function () { textarea.focus(); },
      };
    }

    var wrapper = document.createElement("div");
    wrapper.className = "glr-editor";

    // Author identity bar
    var currentUser = state.lastMountUser;
    if (currentUser) {
      var identityBar = document.createElement("div");
      identityBar.className = "glr-editor__identity";
      identityBar.innerHTML =
        (currentUser.avatar_url ? '<img class="glr-editor__avatar" src="' + escapeHtml(currentUser.avatar_url) + '" />' : '') +
        '<span class="glr-editor__author">' + escapeHtml(currentUser.name || currentUser.username) + '</span>';
      wrapper.appendChild(identityBar);
    }

    var editorContainer = document.createElement("div");
    editorContainer.className = "glr-editor__quill";
    wrapper.appendChild(editorContainer);

    var quill = null;

    // Init Quill after DOM attachment
    setTimeout(function () {
      if (typeof Quill === "undefined") return;

      // Allow blob: URLs in Quill sanitizer
      var Link = Quill.import("formats/link");
      var origSanitize = Link.sanitize;
      Link.sanitize = function (url) {
        if (url && url.startsWith("blob:")) return url;
        return origSanitize.call(this, url);
      };
      var Image = Quill.import("formats/image");
      if (Image && Image.sanitize) {
        var origImgSanitize = Image.sanitize;
        Image.sanitize = function (url) {
          if (url && url.startsWith("blob:")) return url;
          return origImgSanitize.call(this, url);
        };
      }

      quill = new Quill(editorContainer, {
        theme: "snow",
        placeholder: placeholder || "Написати коментар...",
        modules: {
          toolbar: [
            ["bold", "italic", "underline", "strike"],
            [{ header: 3 }, "blockquote", "code-block"],
            [{ list: "ordered" }, { list: "bullet" }],
            ["link", "image"],
            ["clean"],
          ],
        },
      });

      // Override image handler for GitLab upload
      quill.getModule("toolbar").addHandler("image", function () {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addEventListener("change", function () {
          if (input.files && input.files[0]) {
            uploadAndInsertImage(quill, input.files[0]);
          }
        });
        input.click();
      });

      // Image paste
      editorContainer.addEventListener("paste", function (e) {
        var items = (e.clipboardData || {}).items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.indexOf("image/") === 0) {
            e.preventDefault();
            e.stopPropagation();
            uploadAndInsertImage(quill, items[i].getAsFile());
            return;
          }
        }
      }, true);

      // Image drop
      editorContainer.addEventListener("drop", function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        for (var i = 0; i < files.length; i++) {
          if (files[i].type.indexOf("image/") === 0) {
            e.preventDefault();
            e.stopPropagation();
            uploadAndInsertImage(quill, files[i]);
            return;
          }
        }
      }, true);

      // --- @mention autocomplete (delegated to MentionAutocomplete module) ---
      window.MentionAutocomplete.attach(quill, {
        container: editorContainer,
        searchMembers: function (query, opts) {
          return window.GitlabAPI.searchMembers(query, opts);
        },
      });
      // TODO: call returned detach() when editor lifecycle/teardown is formalized.
    }, 0);

    return {
      el: wrapper,
      getMarkdown: function () {
        if (!quill) return "";
        return quillToMarkdown(quill);
      },
      clear: function () {
        if (quill) quill.setText("");
      },
      focus: function () {
        if (quill) quill.focus();
      },
    };
  }

  function uploadAndInsertImage(quill, file) {
    var range = quill.getSelection(true);
    quill.insertText(range.index, "Завантаження...", { italic: true });

    // Show blob URL immediately in editor (works locally)
    var blobUrl = URL.createObjectURL(file);
    var img = new Image();

    img.onload = function () {
      var w = img.naturalWidth;
      var h = img.naturalHeight;

      uploadImage(file).then(function (url) {
        quill.deleteText(range.index, "Завантаження...".length);
        if (url) {
          // Display blob URL in editor (visible), store GitLab URL as data attr
          quill.insertEmbed(range.index, "image", blobUrl);
          var imgEl = quill.root.querySelector('img[src="' + blobUrl + '"]');
          if (imgEl) {
            imgEl.setAttribute("data-gitlab-url", url);
            imgEl.setAttribute("data-width", w);
            imgEl.setAttribute("data-height", h);
            imgEl.style.maxWidth = "100%";
          }
          quill.setSelection(range.index + 1);
        }
      });
    };
    img.src = blobUrl;
  }

  function quillToMarkdown(quill) {
    // Convert Quill delta to markdown
    var html = quill.root.innerHTML;
    if (!html || html === "<p><br></p>") return "";

    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p>/gi, "\n\n")
      .replace(/<p>/gi, "").replace(/<\/p>/gi, "")
      .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, function (_, l, t) { return "#".repeat(parseInt(l)) + " " + t + "\n\n"; })
      .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
      .replace(/<b>(.*?)<\/b>/gi, "**$1**")
      .replace(/<em>(.*?)<\/em>/gi, "*$1*")
      .replace(/<i>((?:(?!<\/?i>).)*)<\/i>/gi, "*$1*")
      .replace(/<u>(.*?)<\/u>/gi, "$1")
      .replace(/<del>(.*?)<\/del>/gi, "~~$1~~")
      .replace(/<s>(.*?)<\/s>/gi, "~~$1~~")
      .replace(/<code>(.*?)<\/code>/gi, "`$1`")
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
      .replace(/<pre[^>]*class="ql-syntax"[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
      .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, function (_, t) {
        return t.trim().split("\n").map(function (l) { return "> " + l; }).join("\n") + "\n\n";
      })
      .replace(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
      .replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, function (match, src) {
        // Use GitLab URL if available (blob URLs are editor-only)
        var gitlabMatch = match.match(/data-gitlab-url="([^"]*)"/);
        var finalSrc = gitlabMatch ? gitlabMatch[1] : src;
        // Ensure relative URL for GitLab uploads
        var idx = finalSrc.indexOf("/uploads/");
        if (idx !== -1) finalSrc = finalSrc.substring(idx);
        var wMatch = match.match(/data-width="(\d+)"/);
        var hMatch = match.match(/data-height="(\d+)"/);
        var dims = "";
        if (wMatch && hMatch) dims = "{width=" + wMatch[1] + " height=" + hMatch[1] + "}";
        return "\n![image](" + finalSrc + ")" + dims + "\n";
      })
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
      .replace(/<\/?[uo]l>/gi, "")
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
  }

  function uploadImage(file) {
    var formData = new FormData();
    formData.append("file", file);

    var token = OAuth.getToken();
    if (!token) return Promise.resolve(null);

    return fetch(
      config.gitlab_url + "/api/v4/projects/" + config.project_id + "/uploads",
      {
        method: "POST",
        headers: { "Authorization": "Bearer " + token },
        body: formData,
      }
    )
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        // Return relative URL — GitLab expects this in markdown comments
        // e.g. /uploads/hash/image.png
        if (data && data.url) return data.url;
        return null;
        return null;
      })
      .catch(function () { return null; });
  }

  // --- Forms ---

  function renderCommentForm(file, line, onSuccess) {
    var form = document.createElement("div");
    form.className = "glr-form";

    var editor = createEditor("Написати коментар...");

    var btn = document.createElement("button");
    btn.className = "glr-form__submit";
    btn.textContent = "Відправити";

    btn.addEventListener("click", function () {
      var body = editor.getMarkdown();
      if (!body) return;

      btn.disabled = true;
      btn.textContent = "...";

      postComment(file, line, body).then(function (discussion) {
        editor.clear();
        btn.disabled = false;
        btn.textContent = "Відправити";
        if (onSuccess) onSuccess(discussion);
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = "Відправити";
      });
    });

    form.appendChild(editor.el);
    form.appendChild(btn);
    return form;
  }

  function renderReplyForm(discussionId, threadDiv) {
    var form = document.createElement("div");
    form.className = "glr-form glr-form--reply";

    var toggle = document.createElement("button");
    toggle.className = "glr-form__toggle";
    toggle.textContent = "Відповісти";
    form.appendChild(toggle);

    var inputArea = document.createElement("div");
    inputArea.className = "glr-form__area";
    inputArea.style.display = "none";

    var editor = createEditor("Відповідь...");

    var btn = document.createElement("button");
    btn.className = "glr-form__submit";
    btn.textContent = "Відправити";

    btn.addEventListener("click", function () {
      var body = editor.getMarkdown();
      if (!body) return;

      btn.disabled = true;
      postReply(discussionId, body).then(function (note) {
        editor.clear();
        btn.disabled = false;
        inputArea.style.display = "none";
        if (note && threadDiv) {
          threadDiv.insertBefore(renderNote(note), form);
        }
      }).catch(function () {
        btn.disabled = false;
      });
    });

    inputArea.appendChild(editor.el);
    inputArea.appendChild(btn);
    form.appendChild(inputArea);

    toggle.addEventListener("click", function () {
      inputArea.style.display = inputArea.style.display === "none" ? "block" : "none";
      if (inputArea.style.display === "block") editor.focus();
    });

    return form;
  }

  // --- API actions ---

  function postComment(file, line, body) {
    var fileInfo = state.changedFiles[file];

    if (!state.diffRefs || !fileInfo) {
      return postGeneralComment(file, line, body);
    }

    // Resolve old_line/new_line from diff line mapping
    var mapping = fileInfo.lineMap[line];

    var position = {
      position_type: "text",
      base_sha: state.diffRefs.base_sha,
      start_sha: state.diffRefs.start_sha,
      head_sha: state.diffRefs.head_sha,
      old_path: fileInfo.old_path,
      new_path: fileInfo.new_path,
    };

    if (mapping) {
      if (fileInfo.new_file || mapping.type === "added") {
        position.new_line = mapping.new_line;
      } else {
        if (mapping.old_line !== null) position.old_line = mapping.old_line;
        position.new_line = mapping.new_line;
      }
    } else {
      // Line outside diff hunk — still try inline with new_line only
      // GitLab accepts inline comments on any line of changed files
      position.new_line = line;
    }

    // Try inline comment, fallback to general on error
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/discussions",
      { method: "POST", body: JSON.stringify({ body: body, position: position }) }
    ).catch(function (err) {
      // Log why inline failed for debugging
      console.warn("[glr] Inline comment failed, falling back to general. Error:", err,
        "Position:", JSON.stringify(position));
      // Inline failed — fallback to general discussion
      return postGeneralComment(file, line, body);
    });
  }

  function postGeneralComment(file, line, body) {
    var prefix = "**" + file + ":" + line + "**\n\n";
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/discussions",
      { method: "POST", body: JSON.stringify({ body: prefix + body }) }
    );
  }

  function postReply(discussionId, body) {
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid +
        "/discussions/" + discussionId + "/notes",
      { method: "POST", body: JSON.stringify({ body: body }) }
    );
  }

  // --- Helpers ---

  function highlightMentions(container) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var nodesToReplace = [];
    var node;
    while ((node = walker.nextNode())) {
      if (/@[\p{L}\p{N}_.\-]+/u.test(node.nodeValue)) {
        nodesToReplace.push(node);
      }
    }
    nodesToReplace.forEach(function (textNode) {
      var parts = textNode.nodeValue.split(/(@[\p{L}\p{N}_.\-]+)/gu);
      if (parts.length <= 1) return;
      var frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        if (/^@[\p{L}\p{N}_.\-]+$/u.test(part)) {
          var chip = document.createElement("span");
          chip.className = "glr-mention";
          chip.textContent = part;
          frag.appendChild(chip);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  function renderMarkdown(md) {
    if (!md) return "";
    var html = md
      // Escape HTML
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Images (before links)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      // Italic
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      // Strikethrough
      .replace(/~~(.+?)~~/g, "<del>$1</del>")
      // Inline code
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Headings
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      // Blockquote
      .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
      // Horizontal rule
      .replace(/^---$/gm, "<hr>")
      // List items
      .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
      .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
      // Paragraphs (double newline)
      .replace(/\n\n/g, "</p><p>")
      // Single newline → <br>
      .replace(/\n/g, "<br>");
    return "<p>" + html + "</p>";
  }

  function loadAuthImages(container, noteId) {
    // Download upload images via GitLab Uploads API (supports CORS + Bearer token)
    // GET /projects/:id/uploads/:secret/:filename
    var imgs = Array.from(container.querySelectorAll("img"));
    var apiBase = config.gitlab_url + "/api/v4/projects/" + config.project_id;

    imgs.forEach(function (img) {
      var src = img.getAttribute("src") || "";
      // Skip avatars
      if (src.indexOf("avatar") !== -1) return;

      // Match /uploads/{secret}/{filename}
      var match = src.match(/\/uploads\/([a-f0-9]{32})\/(.+)$/);
      if (!match) {
        // Also try resolved img.src
        match = (img.src || "").match(/\/uploads\/([a-f0-9]{32})\/(.+)$/);
      }
      if (!match) return;

      var secret = match[1];
      var filename = match[2];
      var apiUrl = apiBase + "/uploads/" + secret + "/" + filename;

      img.setAttribute("data-original-src", src);
      img.src = "";
      img.alt = "Завантаження...";
      img.style.maxWidth = "100%";

      var token = OAuth.getToken();
      if (!token) {
        // No token — show placeholder
        replaceWithPlaceholder(img, noteId);
        return;
      }

      fetch(apiUrl, {
        headers: { "Authorization": "Bearer " + token }
      })
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (blob) {
          if (blob) {
            img.src = URL.createObjectURL(blob);
            img.alt = "";
          } else {
            replaceWithPlaceholder(img, noteId);
          }
        })
        .catch(function () {
          replaceWithPlaceholder(img, noteId);
        });
    });
  }

  function replaceWithPlaceholder(img, noteId) {
    var noteUrl = (config.project_url || config.gitlab_url).replace(/\/$/, "") +
      "/-/merge_requests/" + state.mrIid;
    if (noteId) noteUrl += "#note_" + noteId;

    var link = document.createElement("a");
    link.className = "glr-image-placeholder";
    link.href = noteUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.innerHTML = '<span class="glr-image-placeholder__icon">\uD83D\uDDBC</span>' +
      '<span class="glr-image-placeholder__text">Зображення — відкрити в GitLab</span>';
    img.replaceWith(link);
  }

  function fixRelativeUrls(html) {
    if (!html) return html;
    var base = (config.project_url || config.gitlab_url).replace(/\/$/, "");
    // Fix relative links (not images — those are handled by loadAuthImages)
    return html
      .replace(/href="\/uploads\//g, 'href="' + base + '/uploads/');
  }

  function stripFilePrefix(text) {
    if (!text) return text;
    return text
      // Raw markdown: **file:N**\n\n or `file:N`\n\n
      .replace(/^\*\*[^*]+?:\d+\*\*\s*/, "")
      .replace(/^`[^`]+?:\d+`\s*/, "")
      // HTML rendered by GitLab — various structures:
      // <p><strong>file:N</strong></p>\n<p>text</p>
      .replace(/^<p><strong>[^<]+?:\d+<\/strong><\/p>\s*/i, "")
      .replace(/^<p><code>[^<]+?:\d+<\/code><\/p>\s*/i, "")
      // <p><strong>file:N</strong></p> text
      .replace(/^<p><strong>[^<]+?:\d+<\/strong><\/p>/i, "")
      .replace(/^<p><code>[^<]+?:\d+<\/code><\/p>/i, "")
      // <p><strong>file:N</strong><br>text</p>
      .replace(/^(<p>)<strong>[^<]+?:\d+<\/strong>\s*(?:<br\s*\/?>)?\s*/i, "$1")
      .replace(/^(<p>)<code>[^<]+?:\d+<\/code>\s*(?:<br\s*\/?>)?\s*/i, "$1")
      // <p><a ...><strong>file:N</strong></a></p> (GitLab may linkify)
      .replace(/^<p><a[^>]*><strong>[^<]+?:\d+<\/strong><\/a><\/p>\s*/i, "")
      // Trim leading whitespace/newlines left over
      .replace(/^\s+/, "");
  }

  function findDiscussionsForLine(file, line) {
    var tag1 = "`" + file + ":" + line + "`";
    var tag2 = "**" + file + ":" + line + "**";
    return state.discussions.filter(function (d) {
      var firstNote = d.notes && d.notes[0];
      if (!firstNote) return false;
      // Match inline diff comments
      if (firstNote.position) {
        var pos = firstNote.position;
        return pos.new_path === file && pos.new_line === line;
      }
      // Match general discussions with file:line prefix
      if (!firstNote.body) return false;
      return firstNote.body.indexOf(tag1) === 0 || firstNote.body.indexOf(tag2) === 0;
    });
  }

  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString("uk-UA") + " " +
      d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  }

  // --- Bootstrap ---

  if (typeof document$ !== "undefined") {
    document$.subscribe(function () { init(); });
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
