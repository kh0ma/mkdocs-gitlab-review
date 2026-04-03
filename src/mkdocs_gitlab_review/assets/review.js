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

      if (OAuth.isLoggedIn()) {
        // Auto-activate if logged in or ?review param present
        activateReview(toggleBtn);
      } else if (new URLSearchParams(window.location.search).has("review")) {
        // ?review param → login then activate
        OAuth.login();
      }

      toggleBtn.addEventListener("click", function () {
        if (!OAuth.isLoggedIn()) {
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

    var btn = document.createElement("button");
    btn.id = "glr-share-btn";
    btn.className = "glr-toolbar-btn";
    btn.title = "Запросити рев'ю";
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>' +
      '<span class="glr-toolbar-btn__label">Запросити рев\'ю</span>';

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      showShareDialog();
    });

    // Insert after toggle button
    toggleBtn.insertAdjacentElement("afterend", btn);
  }

  function showShareDialog() {
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
        if (!dialog.contains(e.target) && e.target.id !== "glr-share-btn") {
          dialog.remove();
          document.removeEventListener("click", closeDialog);
        }
      });
    }, 0);

    // Position below the share button
    var shareBtn = document.getElementById("glr-share-btn");
    if (shareBtn) {
      shareBtn.insertAdjacentElement("afterend", dialog);
    } else {
      document.body.appendChild(dialog);
    }
  }

  function activateReview(toggleBtn) {
    state.reviewActive = true;
    toggleBtn.classList.add("glr-toolbar-btn--active");
    toggleBtn.querySelector(".glr-toolbar-btn__label").innerHTML = "\u25CF Рев'ю";
    toggleBtn.title = "Вимкнути рев'ю";

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
    });
  }

  function deactivateReview(toggleBtn) {
    state.reviewActive = false;
    toggleBtn.classList.remove("glr-toolbar-btn--active");
    toggleBtn.querySelector(".glr-toolbar-btn__label").textContent = "Рев'ю";
    toggleBtn.title = "Увімкнути рев'ю";

    // Remove all overlay elements
    document.querySelectorAll(".glr-block").forEach(function (el) {
      el.classList.remove("glr-block", "glr-block--commentable", "glr-block--has-comments",
        "glr-block--added", "glr-block--context");
    });
    document.querySelectorAll(".glr-action-btn, .glr-threads, .glr-file-status, #glr-dashboard, #glr-share-btn, #glr-share-dialog, .glr-block--deleted").forEach(function (el) {
      el.remove();
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
        var parsed = parseDiff(change.diff || "");
        state.changedFiles[change.new_path] = {
          old_path: change.old_path,
          new_path: change.new_path,
          new_lines: parsed.new_lines,
          lineMap: parsed.lineMap,
          deletedLines: parsed.deletedLines,
          new_file: change.new_file,
          deleted_file: change.deleted_file,
        };
      });
    }).catch(function () {});
  }

  function fetchDiscussions() {
    var basePath = "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/discussions";
    state.discussions = [];

    function fetchPage(page) {
      return OAuth.apiFetch(basePath + "?per_page=100&page=" + page)
        .then(function (discussions) {
          if (!discussions || !discussions.length) return;
          state.discussions = state.discussions.concat(discussions);
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

      var btn = document.createElement("span");
      btn.className = "glr-action-btn";
      var isExpanded = false;
      var count = discussions.length;

      function updateBtn() {
        if (isExpanded) {
          btn.textContent = "−";
          btn.title = "Згорнути";
        } else if (count > 0) {
          btn.textContent = String(count);
          btn.title = "Показати коментарі";
        } else {
          btn.textContent = "+";
          btn.title = "Додати коментар";
        }
      }

      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var existing = block.nextElementSibling;
        if (existing && existing.classList.contains("glr-threads")) {
          existing.remove();
          isExpanded = false;
          updateBtn();
        } else {
          showThreads(block, file, line, discussions, canComment);
          isExpanded = true;
          updateBtn();
        }
      });

      block.appendChild(btn);

      // Show badge count but keep collapsed
      if (count > 0) {
        block.classList.add("glr-block--has-comments");
      }
      updateBtn();
    });

    // Insert ghost blocks for deleted lines
    if (isChanged && fileInfo.deletedLines && fileInfo.deletedLines.length > 0) {
      insertDeletedBlocks(fileInfo.deletedLines);
    }

    // Render file status banner
    renderFileStatus(isChanged);

    // Render comments dashboard panel
    renderCommentsDashboard();
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

    var panel = document.createElement("div");
    panel.id = "glr-dashboard";
    panel.className = "glr-dashboard";

    var header = document.createElement("div");
    header.className = "glr-dashboard__header";

    var resolved = userDiscussions.filter(function (d) {
      return d.notes && d.notes.some(function (n) { return n.resolved; });
    }).length;
    var total = userDiscussions.length;

    header.innerHTML = '<span class="glr-dashboard__title">\uD83D\uDCAC Коментарі</span>' +
      '<span class="glr-dashboard__count">' + resolved + '/' + total + ' вирішено</span>';

    var toggle = document.createElement("button");
    toggle.className = "glr-dashboard__toggle";
    toggle.textContent = "▼";
    toggle.addEventListener("click", function () {
      var list = panel.querySelector(".glr-dashboard__list");
      if (list.style.display === "none") {
        list.style.display = "";
        toggle.textContent = "▼";
      } else {
        list.style.display = "none";
        toggle.textContent = "▶";
      }
    });
    header.appendChild(toggle);
    panel.appendChild(header);

    var list = document.createElement("div");
    list.className = "glr-dashboard__list";

    // Group discussions by file — skip system notes
    var byFile = {};
    state.discussions.forEach(function (d) {
      var note = d.notes && d.notes[0];
      if (!note) return;
      // Skip system-generated discussions (commits, merges, thread events)
      if (note.system) return;
      if (!note.body || note.body.length === 0) return;
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
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push({ discussion: d, line: line, note: note });
    });

    Object.keys(byFile).forEach(function (file) {
      var section = document.createElement("div");
      section.className = "glr-dashboard__section";

      var fileHeader = document.createElement("div");
      fileHeader.className = "glr-dashboard__file";
      fileHeader.textContent = file;
      section.appendChild(fileHeader);

      byFile[file].forEach(function (item) {
        var entry = document.createElement("div");
        entry.className = "glr-dashboard__entry";
        var isRes = item.discussion.notes.some(function (n) { return n.resolved; });
        if (isRes) entry.classList.add("glr-dashboard__entry--resolved");

        var author = item.note.author ? item.note.author.name : "";
        var body = stripFilePrefix(item.note.body || "").substring(0, 80);

        entry.innerHTML =
          '<span class="glr-dashboard__status">' + (isRes ? "✓" : "○") + '</span>' +
          '<span class="glr-dashboard__line">:' + item.line + '</span> ' +
          '<span class="glr-dashboard__author">' + author + '</span> ' +
          '<span class="glr-dashboard__text">' + body + '</span>';

        // Click → scroll to the block on this page and expand thread
        entry.style.cursor = "pointer";
        entry.addEventListener("click", function () {
          var target = document.querySelector('[data-source-file="' + file + '"][data-source-line="' + item.line + '"]');
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            // Expand thread if not already
            var next = target.nextElementSibling;
            if (!next || !next.classList.contains("glr-threads")) {
              var actionBtn = target.querySelector(".glr-action-btn");
              if (actionBtn) actionBtn.click();
            }
            target.style.outline = "2px solid var(--md-accent-fg-color, #536dfe)";
            setTimeout(function () { target.style.outline = ""; }, 2000);
          }
        });

        section.appendChild(entry);
      });

      list.appendChild(section);
    });

    panel.appendChild(list);

    var content = document.querySelector(".md-content__inner");
    if (content) content.insertBefore(panel, content.querySelector(".glr-file-status"));
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

  function renderFileStatus(isChanged) {
    var banner = document.createElement("div");
    banner.className = "glr-file-status";
    if (isChanged) {
      banner.classList.add("glr-file-status--changed");
      banner.textContent = "Файл змінено в цьому MR";
    } else {
      banner.classList.add("glr-file-status--unchanged");
      banner.textContent = "Файл не змінено в цьому MR";
    }
    var content = document.querySelector(".md-content__inner");
    if (content) content.insertBefore(banner, content.firstChild);
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
      container.appendChild(form);
    }

    block.insertAdjacentElement("afterend", container);
  }

  function renderNote(note) {
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

    var noteUrl = (config.project_url || config.gitlab_url).replace(/\/$/, "") +
      "/-/merge_requests/" + state.mrIid + "#note_" + note.id;

    var time = document.createElement("a");
    time.className = "glr-note__time";
    time.textContent = formatTime(note.created_at);
    time.href = noteUrl;
    time.target = "_blank";
    time.rel = "noopener";
    time.title = "Відкрити в GitLab";
    header.appendChild(time);

    noteEl.appendChild(header);

    var body = document.createElement("div");
    body.className = "glr-note__body";

    var cleaned = stripFilePrefix(note.body);
    // Strip GitLab-specific image attributes
    cleaned = cleaned.replace(/\{width=\d+\s+height=\d+\}/g, "");
    if (cleaned && cleaned.charAt(0) === "<") {
      body.innerHTML = fixRelativeUrls(cleaned);
    } else {
      body.innerHTML = renderMd(cleaned);
    }
    // Replace upload images with placeholder linking to this note in GitLab
    loadAuthImages(body, note.id);
    noteEl.appendChild(body);

    return noteEl;
  }

  function renderThread(discussion) {
    var div = document.createElement("div");
    div.className = "glr-thread";
    if (discussion.notes && discussion.notes[0] && discussion.notes[0].resolved) {
      div.classList.add("glr-thread--resolved");
    }

    (discussion.notes || []).forEach(function (note) {
      if (note.system) return;
      div.appendChild(renderNote(note));
    });

    // Thread actions: resolve + reply
    var actions = document.createElement("div");
    actions.className = "glr-thread__actions";

    // Resolve/unresolve button
    var isResolved = discussion.notes && discussion.notes.some(function (n) { return n.resolved; });
    var resolveBtn = document.createElement("button");
    resolveBtn.className = "glr-thread__resolve";
    resolveBtn.textContent = isResolved ? "Відновити" : "Вирішено";
    resolveBtn.addEventListener("click", function () {
      var noteId = discussion.notes[0].id;
      var newState = !isResolved;
      OAuth.apiFetch(
        "/projects/" + config.project_id + "/merge_requests/" + state.mrIid +
          "/discussions/" + discussion.id + "/notes/" + noteId,
        { method: "PUT", body: JSON.stringify({ resolved: newState }) }
      ).then(function () {
        isResolved = newState;
        resolveBtn.textContent = newState ? "Відновити" : "Вирішено";
        div.classList.toggle("glr-thread--resolved", newState);
      }).catch(function () {});
    });
    actions.appendChild(resolveBtn);

    div.appendChild(actions);

    // Reply form
    var replyForm = renderReplyForm(discussion.id, div);
    div.appendChild(replyForm);

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

  // --- Editor (Quill.js WYSIWYG) ---

  function createEditor(placeholder) {
    var wrapper = document.createElement("div");
    wrapper.className = "glr-editor";

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

    if (!mapping) {
      // Line not in any diff hunk — general discussion
      return postGeneralComment(file, line, body);
    }

    var position = {
      position_type: "text",
      base_sha: state.diffRefs.base_sha,
      start_sha: state.diffRefs.start_sha,
      head_sha: state.diffRefs.head_sha,
      old_path: fileInfo.old_path,
      new_path: fileInfo.new_path,
    };

    if (fileInfo.new_file || mapping.type === "added") {
      position.new_line = mapping.new_line;
    } else {
      if (mapping.old_line !== null) position.old_line = mapping.old_line;
      position.new_line = mapping.new_line;
    }

    // Try inline comment, fallback to general on error
    return OAuth.apiFetch(
      "/projects/" + config.project_id + "/merge_requests/" + state.mrIid + "/discussions",
      { method: "POST", body: JSON.stringify({ body: body, position: position }) }
    ).catch(function () {
      // Inline failed (line outside diff context) — fallback
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
