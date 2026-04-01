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
        // Auto-activate review mode
        activateReview(toggleBtn);
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

  function activateReview(toggleBtn) {
    state.reviewActive = true;
    toggleBtn.classList.add("glr-toolbar-btn--active");
    toggleBtn.querySelector(".glr-toolbar-btn__label").innerHTML = "\u25CF Рев'ю";
    toggleBtn.title = "Вимкнути рев'ю";

    Promise.all([
      fetchDiffRefs(),
      fetchChangedFiles(),
      fetchDiscussions(),
    ]).then(function () {
      renderOverlay();
    });
  }

  function deactivateReview(toggleBtn) {
    state.reviewActive = false;
    toggleBtn.classList.remove("glr-toolbar-btn--active");
    toggleBtn.querySelector(".glr-toolbar-btn__label").textContent = "Рев'ю";
    toggleBtn.title = "Увімкнути рев'ю";

    // Remove all overlay elements
    document.querySelectorAll(".glr-block, .glr-block--commentable, .glr-block--has-comments").forEach(function (el) {
      el.classList.remove("glr-block", "glr-block--commentable", "glr-block--has-comments");
    });
    document.querySelectorAll(".glr-action-btn, .glr-threads, .glr-file-status").forEach(function (el) {
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

  function parseDiff(diff) {
    // Parse unified diff to build old↔new line mapping
    // Returns { new_lines: Set(added new_line numbers), lineMap: Map(new_line → {old_line, new_line, type}) }
    var lines = diff.split("\n");
    var newLines = new Set();
    var lineMap = {};  // new_line → {old_line, new_line, type}
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
        oldLine++;
      } else if (!line.startsWith("\\")) {
        // Context line
        lineMap[newLine] = { old_line: oldLine, new_line: newLine, type: "context" };
        oldLine++;
        newLine++;
      }
    });

    return { new_lines: newLines, lineMap: lineMap };
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

      // Add comment gutter icon
      block.classList.add("glr-block");
      block.classList.add("glr-block--commentable");

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

      // Auto-expand on initial load if has comments
      if (count > 0) {
        block.classList.add("glr-block--has-comments");
        showThreads(block, file, line, discussions, canComment);
        isExpanded = true;
      }
      updateBtn();
    });

    // Render file status banner
    renderFileStatus(isChanged);
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

    var time = document.createElement("span");
    time.className = "glr-note__time";
    time.textContent = formatTime(note.created_at);
    header.appendChild(time);

    noteEl.appendChild(header);

    var body = document.createElement("div");
    body.className = "glr-note__body";
    body.innerHTML = '<span style="color:#999">Завантаження...</span>';
    noteEl.appendChild(body);

    // Render via GitLab Markdown API for proper signed image URLs
    var cleaned = stripFilePrefix(note.body);
    renderViaGitlab(cleaned).then(function (html) {
      body.innerHTML = html;
    });

    return noteEl;
  }

  function renderThread(discussion) {
    var div = document.createElement("div");
    div.className = "glr-thread";

    (discussion.notes || []).forEach(function (note) {
      if (note.system) return;
      div.appendChild(renderNote(note));
    });

    // Reply form
    var replyForm = renderReplyForm(discussion.id, div);
    div.appendChild(replyForm);

    return div;
  }

  // --- Markdown rendering (using marked.js from CDN) ---

  function renderMd(text) {
    if (!text) return "";
    if (typeof marked !== "undefined") {
      marked.setOptions({ breaks: true, gfm: true });
      return fixRelativeUrls(marked.parse(text));
    }
    // Fallback: show as plain text with line breaks
    return "<p>" + text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>") + "</p>";
  }

  // --- Editor ---

  function createEditor(placeholder) {
    var wrapper = document.createElement("div");
    wrapper.className = "glr-editor";

    // Tabs: Write / Preview
    var tabs = document.createElement("div");
    tabs.className = "glr-editor__tabs";

    var writeTab = document.createElement("button");
    writeTab.className = "glr-editor__tab glr-editor__tab--active";
    writeTab.textContent = "Написати";
    writeTab.type = "button";

    var previewTab = document.createElement("button");
    previewTab.className = "glr-editor__tab";
    previewTab.textContent = "Перегляд";
    previewTab.type = "button";

    tabs.appendChild(writeTab);
    tabs.appendChild(previewTab);
    wrapper.appendChild(tabs);

    // Toolbar
    var toolbar = document.createElement("div");
    toolbar.className = "glr-editor__toolbar";

    var buttons = [
      { cmd: "bold", icon: "<b>B</b>", title: "Bold (Ctrl+B)", md: "**", mdWrap: true },
      { cmd: "italic", icon: "<i>I</i>", title: "Italic (Ctrl+I)", md: "_", mdWrap: true },
      { cmd: "strikeThrough", icon: "<s>S</s>", title: "Strikethrough", md: "~~", mdWrap: true },
      { sep: true },
      { prefix: "### ", icon: "H", title: "Heading" },
      { prefix: "- ", icon: "\u2022", title: "Bullet list" },
      { prefix: "1. ", icon: "1.", title: "Numbered list" },
      { sep: true },
      { prefix: "> ", icon: "\u275D", title: "Quote" },
      { md: "`", mdWrap: true, icon: "&lt;/&gt;", title: "Inline code" },
      { custom: "link", icon: "\uD83D\uDD17", title: "Link" },
      { custom: "image", icon: "\uD83D\uDDBC", title: "Image" },
      { insert: "\n---\n", icon: "\u2015", title: "Horizontal rule" },
    ];

    buttons.forEach(function (b) {
      if (b.sep) {
        var sep = document.createElement("span");
        sep.className = "glr-editor__sep";
        toolbar.appendChild(sep);
        return;
      }
      var btn = document.createElement("button");
      btn.className = "glr-editor__btn";
      btn.innerHTML = b.icon;
      btn.title = b.title;
      btn.type = "button";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        editorAction(textarea, b);
      });
      toolbar.appendChild(btn);
    });

    wrapper.appendChild(toolbar);

    // Textarea (markdown source)
    var textarea = document.createElement("textarea");
    textarea.className = "glr-editor__textarea";
    textarea.placeholder = placeholder || "Написати коментар...";
    textarea.rows = 4;

    // Image paste
    textarea.addEventListener("paste", function (e) {
      var items = (e.clipboardData || {}).items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          handleImageUpload(textarea, file);
          return;
        }
      }
    });

    // Drag & drop images
    textarea.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files) return;
      for (var i = 0; i < files.length; i++) {
        if (files[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          handleImageUpload(textarea, files[i]);
          return;
        }
      }
    });
    textarea.addEventListener("dragover", function (e) { e.preventDefault(); });

    wrapper.appendChild(textarea);

    // Preview pane
    var preview = document.createElement("div");
    preview.className = "glr-editor__preview";
    preview.style.display = "none";
    wrapper.appendChild(preview);

    // Tab switching
    writeTab.addEventListener("click", function () {
      writeTab.classList.add("glr-editor__tab--active");
      previewTab.classList.remove("glr-editor__tab--active");
      textarea.style.display = "";
      toolbar.style.display = "";
      preview.style.display = "none";
    });

    previewTab.addEventListener("click", function () {
      previewTab.classList.add("glr-editor__tab--active");
      writeTab.classList.remove("glr-editor__tab--active");
      textarea.style.display = "none";
      toolbar.style.display = "none";
      preview.innerHTML = renderMd(textarea.value) || '<p style="color:#999">Нічого для перегляду</p>';
      preview.style.display = "";
    });

    return {
      el: wrapper,
      getMarkdown: function () { return textarea.value.trim(); },
      clear: function () { textarea.value = ""; },
      focus: function () { textarea.focus(); },
    };
  }

  function editorAction(textarea, b) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var text = textarea.value;
    var selected = text.substring(start, end);

    if (b.mdWrap && b.md) {
      var wrapped = b.md + (selected || "text") + b.md;
      textarea.value = text.substring(0, start) + wrapped + text.substring(end);
      textarea.selectionStart = start + b.md.length;
      textarea.selectionEnd = start + wrapped.length - b.md.length;
    } else if (b.prefix) {
      // Find start of line
      var lineStart = text.lastIndexOf("\n", start - 1) + 1;
      textarea.value = text.substring(0, lineStart) + b.prefix + text.substring(lineStart);
      textarea.selectionStart = start + b.prefix.length;
      textarea.selectionEnd = end + b.prefix.length;
    } else if (b.insert) {
      textarea.value = text.substring(0, end) + b.insert + text.substring(end);
      textarea.selectionStart = textarea.selectionEnd = end + b.insert.length;
    } else if (b.custom === "link") {
      var url = prompt("URL:");
      if (url) {
        var linkText = selected || "link";
        var md = "[" + linkText + "](" + url + ")";
        textarea.value = text.substring(0, start) + md + text.substring(end);
      }
    } else if (b.custom === "image") {
      // Open file picker
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.addEventListener("change", function () {
        if (input.files && input.files[0]) {
          handleImageUpload(textarea, input.files[0]);
        }
      });
      input.click();
    }
    textarea.focus();
  }

  function handleImageUpload(textarea, file) {
    var start = textarea.selectionStart;
    var placeholder = "![Uploading...]()";
    textarea.value = textarea.value.substring(0, start) + placeholder + textarea.value.substring(start);
    textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;

    uploadImage(file).then(function (url) {
      if (url) {
        textarea.value = textarea.value.replace(placeholder, "![](" + url + ")");
      } else {
        textarea.value = textarea.value.replace(placeholder, "![Upload failed]()");
      }
    });
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
        if (data && data.url) {
          if (data.url.startsWith("http")) return data.url;
          var base = config.project_url || config.gitlab_url;
          return base.replace(/\/$/, "") + data.url;
        }
        if (data && data.full_path) {
          return config.gitlab_url + data.full_path;
        }
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

  function renderViaGitlab(markdown) {
    if (!markdown) return Promise.resolve("");
    // If already HTML, just fix URLs
    if (markdown.charAt(0) === "<") return Promise.resolve(fixRelativeUrls(markdown));

    // Use GitLab Markdown API — returns HTML with signed image URLs
    if (OAuth.isLoggedIn()) {
      return OAuth.apiFetch(
        "/projects/" + config.project_id + "/markdown",
        { method: "POST", body: JSON.stringify({ text: markdown, gfm: true }) }
      ).then(function (data) {
        return (data && data.html) ? data.html : renderMd(markdown);
      }).catch(function () {
        return renderMd(markdown);
      });
    }
    return Promise.resolve(renderMd(markdown));
  }

  function fixRelativeUrls(html) {
    // Fix relative /uploads/ URLs in GitLab-rendered HTML to point to project
    if (!html) return html;
    var base = (config.project_url || config.gitlab_url).replace(/\/$/, "");
    return html
      .replace(/src="\/uploads\//g, 'src="' + base + '/uploads/')
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
