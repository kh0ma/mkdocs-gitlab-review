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
    diffRefs: null,       // {base_sha, start_sha, head_sha}
    changedFiles: {},      // {filepath: {new_lines: Set, old_path, new_path}}
    discussions: [],       // raw GitLab discussions
    currentFile: null,     // source file of current page
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

      if (!OAuth.isLoggedIn()) {
        renderLoginButton();
        return;
      }

      // Fetch MR data in parallel
      Promise.all([
        fetchDiffRefs(),
        fetchChangedFiles(),
        fetchDiscussions(),
      ]).then(function () {
        renderOverlay();
      });
    });
  }

  // --- Context detection ---

  function detectMrContext() {
    // Fallback: parse URL first (instant, no network)
    var match = window.location.pathname.match(/\/mr-(\d+)\//);
    if (match) return Promise.resolve(parseInt(match[1], 10));

    // Try version.json at site root
    var base = document.querySelector('link[rel="canonical"]');
    var versionUrl = base ? new URL("version.json", base.href).href : "version.json";

    return fetch(versionUrl)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        return (data && data.mr_iid) ? data.mr_iid : null;
      })
      .catch(function () { return null; });
  }

  function detectCurrentFile() {
    // Find the first element with data-source-file
    var el = document.querySelector("[data-source-file]");
    return el ? el.getAttribute("data-source-file") : null;
  }

  // --- API calls ---

  function fetchDiffRefs() {
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid
    ).then(function (mr) {
      if (mr.diff_refs) {
        state.diffRefs = mr.diff_refs;
      }
    }).catch(function () {});
  }

  function fetchChangedFiles() {
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/changes?per_page=100"
    ).then(function (data) {
      var changes = data.changes || [];
      changes.forEach(function (change) {
        var newLines = parseDiffNewLines(change.diff || "");
        state.changedFiles[change.new_path] = {
          old_path: change.old_path,
          new_path: change.new_path,
          new_lines: newLines,
          new_file: change.new_file,
        };
      });
    }).catch(function () {});
  }

  function fetchDiscussions() {
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/discussions?per_page=100"
    ).then(function (discussions) {
      state.discussions = discussions || [];
    }).catch(function () {});
  }

  // --- Diff parsing ---

  function parseDiffNewLines(diff) {
    // Parse unified diff to find new line numbers (added/changed lines)
    var lines = diff.split("\n");
    var newLines = new Set();
    var newLine = 0;

    lines.forEach(function (line) {
      var hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[1], 10);
        return;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        newLines.add(newLine);
        newLine++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        // deleted line — don't increment newLine
      } else {
        newLine++;
      }
    });

    return newLines;
  }

  // --- Rendering ---

  function renderLoginButton() {
    var btn = document.createElement("button");
    btn.className = "glr-login-btn";
    btn.textContent = "Увійти для рев'ю";
    btn.addEventListener("click", function () { OAuth.login(); });
    document.body.appendChild(btn);
  }

  function renderOverlay() {
    var fileInfo = state.changedFiles[state.currentFile];
    var isChanged = !!fileInfo;

    // Find all annotated blocks
    var blocks = document.querySelectorAll("[data-source-file][data-source-line]");

    blocks.forEach(function (block) {
      var file = block.getAttribute("data-source-file");
      var line = parseInt(block.getAttribute("data-source-line"), 10);

      if (file !== state.currentFile) return;

      var canComment = isChanged;
      var discussions = findDiscussionsForLine(file, line);

      // Add comment gutter icon
      block.classList.add("glr-block");
      if (canComment) block.classList.add("glr-block--commentable");

      // Render existing threads
      if (discussions.length > 0) {
        var badge = document.createElement("span");
        badge.className = "glr-badge";
        badge.textContent = String(discussions.length);
        badge.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleThreads(block, file, line, discussions, canComment);
        });
        block.appendChild(badge);
      }

      // Click "+" to add comment
      if (canComment) {
        var addBtn = document.createElement("span");
        addBtn.className = "glr-add-btn";
        addBtn.textContent = "+";
        addBtn.title = "Додати коментар";
        addBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleThreads(block, file, line, discussions, canComment);
        });
        block.appendChild(addBtn);
      } else if (!isChanged) {
        block.title = "Файл не змінено в цьому MR";
      }
    });

    // Render file status banner
    renderFileStatus(isChanged);

    // Add logout button
    renderLogoutButton();
  }

  function renderFileStatus(isChanged) {
    var banner = document.createElement("div");
    banner.className = "glr-file-status";
    if (isChanged) {
      banner.classList.add("glr-file-status--changed");
      banner.textContent = "Файл змінено в цьому MR";
    } else {
      banner.classList.add("glr-file-status--unchanged");
      banner.textContent = "Файл не змінено в цьому MR — коментарі недоступні";
    }
    var content = document.querySelector(".md-content__inner");
    if (content) content.insertBefore(banner, content.firstChild);
  }

  function renderLogoutButton() {
    var btn = document.createElement("button");
    btn.className = "glr-logout-btn";
    btn.textContent = "Вийти";
    btn.addEventListener("click", function () { OAuth.logout(); });
    document.body.appendChild(btn);
  }

  // --- Thread UI ---

  function toggleThreads(block, file, line, discussions, canComment) {
    var existing = block.nextElementSibling;
    if (existing && existing.classList.contains("glr-threads")) {
      existing.remove();
      return;
    }

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
      container.appendChild(form);
    }

    block.insertAdjacentElement("afterend", container);
  }

  function renderThread(discussion) {
    var div = document.createElement("div");
    div.className = "glr-thread";

    (discussion.notes || []).forEach(function (note) {
      if (note.system) return; // skip system notes

      var noteEl = document.createElement("div");
      noteEl.className = "glr-note";

      var header = document.createElement("div");
      header.className = "glr-note__header";

      if (note.author && note.author.avatar_url) {
        var avatar = document.createElement("img");
        avatar.className = "glr-note__avatar";
        avatar.src = note.author.avatar_url;
        avatar.width = 20;
        avatar.height = 20;
        header.appendChild(avatar);
      }

      var authorSpan = document.createElement("strong");
      authorSpan.textContent = note.author ? note.author.name : "Unknown";
      header.appendChild(authorSpan);

      var time = document.createElement("span");
      time.className = "glr-note__time";
      time.textContent = formatTime(note.created_at);
      header.appendChild(time);

      noteEl.appendChild(header);

      var body = document.createElement("div");
      body.className = "glr-note__body";
      body.innerHTML = note.body;
      noteEl.appendChild(body);

      div.appendChild(noteEl);
    });

    // Reply form
    var replyForm = renderReplyForm(discussion.id);
    div.appendChild(replyForm);

    return div;
  }

  function renderCommentForm(file, line, onSuccess) {
    var form = document.createElement("div");
    form.className = "glr-form";

    var textarea = document.createElement("textarea");
    textarea.className = "glr-form__input";
    textarea.placeholder = "Написати коментар...";
    textarea.rows = 3;

    var btn = document.createElement("button");
    btn.className = "glr-form__submit";
    btn.textContent = "Відправити";

    btn.addEventListener("click", function () {
      var body = textarea.value.trim();
      if (!body) return;

      btn.disabled = true;
      btn.textContent = "...";

      postComment(file, line, body).then(function (discussion) {
        textarea.value = "";
        btn.disabled = false;
        btn.textContent = "Відправити";
        if (onSuccess) onSuccess(discussion);
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = "Відправити";
      });
    });

    form.appendChild(textarea);
    form.appendChild(btn);
    return form;
  }

  function renderReplyForm(discussionId) {
    var form = document.createElement("div");
    form.className = "glr-form glr-form--reply";

    var toggle = document.createElement("button");
    toggle.className = "glr-form__toggle";
    toggle.textContent = "Відповісти";
    form.appendChild(toggle);

    var inputArea = document.createElement("div");
    inputArea.className = "glr-form__area";
    inputArea.style.display = "none";

    var textarea = document.createElement("textarea");
    textarea.className = "glr-form__input";
    textarea.placeholder = "Відповідь...";
    textarea.rows = 2;

    var btn = document.createElement("button");
    btn.className = "glr-form__submit";
    btn.textContent = "Відправити";

    btn.addEventListener("click", function () {
      var body = textarea.value.trim();
      if (!body) return;

      btn.disabled = true;
      postReply(discussionId, body).then(function () {
        textarea.value = "";
        btn.disabled = false;
        inputArea.style.display = "none";
      }).catch(function () {
        btn.disabled = false;
      });
    });

    inputArea.appendChild(textarea);
    inputArea.appendChild(btn);
    form.appendChild(inputArea);

    toggle.addEventListener("click", function () {
      inputArea.style.display = inputArea.style.display === "none" ? "block" : "none";
      if (inputArea.style.display === "block") textarea.focus();
    });

    return form;
  }

  // --- API actions ---

  function postComment(file, line, body) {
    var fileInfo = state.changedFiles[file];
    var payload = { body: body };

    if (state.diffRefs && fileInfo) {
      var position = {
        position_type: "text",
        base_sha: state.diffRefs.base_sha,
        start_sha: state.diffRefs.start_sha,
        head_sha: state.diffRefs.head_sha,
        old_path: fileInfo.old_path,
        new_path: fileInfo.new_path,
      };

      if (fileInfo.new_file || fileInfo.new_lines.has(line)) {
        // Added line — only new_line
        position.new_line = line;
      } else {
        // Context line — both old and new
        position.old_line = line;
        position.new_line = line;
      }

      payload.position = position;
    }

    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/discussions",
      { method: "POST", body: JSON.stringify(payload) }
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

  function findDiscussionsForLine(file, line) {
    return state.discussions.filter(function (d) {
      var firstNote = d.notes && d.notes[0];
      if (!firstNote || !firstNote.position) return false;
      var pos = firstNote.position;
      return pos.new_path === file && pos.new_line === line;
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
