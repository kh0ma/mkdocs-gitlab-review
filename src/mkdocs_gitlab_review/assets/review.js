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
    // GitLab uploads are only accessible via GitLab's internal rendering.
    // Replace <img> with clickable placeholder linking to the specific note.
    var imgs = Array.from(container.querySelectorAll("img"));

    imgs.forEach(function (img) {
      var src = img.getAttribute("src") || "";
      // Match /uploads/ in src or in resolved URL
      var isUpload = src.indexOf("/uploads/") !== -1 ||
        (img.src && img.src.indexOf("/uploads/") !== -1);
      // Skip avatar images
      if (src.indexOf("avatar") !== -1) return;
      if (!isUpload) return;

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
    });
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
