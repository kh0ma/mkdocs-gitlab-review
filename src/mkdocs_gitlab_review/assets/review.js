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
      banner.textContent = "Файл не змінено в цьому MR";
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
    if (cleaned && cleaned.charAt(0) === "<") {
      body.innerHTML = fixRelativeUrls(cleaned);
    } else {
      body.innerHTML = fixRelativeUrls(renderMarkdown(cleaned));
    }
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

  // --- WYSIWYG Editor ---

  function createEditor(placeholder) {
    var wrapper = document.createElement("div");
    wrapper.className = "glr-editor";

    // Toolbar
    var toolbar = document.createElement("div");
    toolbar.className = "glr-editor__toolbar";

    var buttons = [
      { cmd: "bold", icon: "<b>B</b>", title: "Bold (Ctrl+B)" },
      { cmd: "italic", icon: "<i>I</i>", title: "Italic (Ctrl+I)" },
      { cmd: "strikeThrough", icon: "<s>S</s>", title: "Strikethrough" },
      { sep: true },
      { cmd: "formatBlock", icon: "H", title: "Heading", value: "h3" },
      { cmd: "insertUnorderedList", icon: "&#8226;", title: "Bullet list" },
      { cmd: "insertOrderedList", icon: "1.", title: "Numbered list" },
      { sep: true },
      { cmd: "formatBlock", icon: "&#10077;", title: "Quote", value: "blockquote" },
      { custom: "code", icon: "&lt;/&gt;", title: "Inline code" },
      { cmd: "createLink", icon: "&#128279;", title: "Link", prompt: true },
      { cmd: "insertHorizontalRule", icon: "&#8213;", title: "Horizontal rule" },
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
      btn.addEventListener("mousedown", function (e) {
        e.preventDefault();
        if (b.custom === "code") {
          // Wrap selection in <code>
          var sel = window.getSelection();
          if (sel.rangeCount) {
            var range = sel.getRangeAt(0);
            var code = document.createElement("code");
            range.surroundContents(code);
          }
        } else if (b.prompt) {
          var url = prompt("URL:");
          if (url) document.execCommand(b.cmd, false, url);
        } else if (b.value) {
          document.execCommand(b.cmd, false, b.value);
        } else {
          document.execCommand(b.cmd, false, null);
        }
      });
      toolbar.appendChild(btn);
    });

    wrapper.appendChild(toolbar);

    // Editable area
    var editable = document.createElement("div");
    editable.className = "glr-editor__content";
    editable.contentEditable = "true";
    editable.setAttribute("data-placeholder", placeholder || "Написати коментар...");

    // Image paste
    editable.addEventListener("paste", function (e) {
      var items = (e.clipboardData || {}).items;
      if (!items) return;

      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          uploadImage(file).then(function (url) {
            if (url) {
              var img = document.createElement("img");
              img.src = url;
              img.style.maxWidth = "100%";
              document.execCommand("insertHTML", false, img.outerHTML);
            }
          });
          return;
        }
      }
    });

    // Drag & drop images
    editable.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;

      for (var i = 0; i < files.length; i++) {
        if (files[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          (function (f) {
            uploadImage(f).then(function (url) {
              if (url) {
                editable.focus();
                document.execCommand("insertHTML", false,
                  '<img src="' + url + '" style="max-width:100%">');
              }
            });
          })(files[i]);
          return;
        }
      }
    });

    editable.addEventListener("dragover", function (e) { e.preventDefault(); });

    wrapper.appendChild(editable);

    return {
      el: wrapper,
      getMarkdown: function () {
        return htmlToMarkdown(editable.innerHTML);
      },
      clear: function () {
        editable.innerHTML = "";
      },
      focus: function () {
        editable.focus();
      },
    };
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
          // GitLab returns URL relative to project (e.g. /uploads/hash/image.png)
          // Build full URL using project_url
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

  function htmlToMarkdown(html) {
    if (!html) return "";
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p>/gi, "\n\n")
      .replace(/<p>/gi, "")
      .replace(/<\/p>/gi, "")
      // Headings
      .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, function (_, level, text) {
        return "#".repeat(parseInt(level)) + " " + text + "\n\n";
      })
      // Bold
      .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
      .replace(/<b>(.*?)<\/b>/gi, "**$1**")
      // Italic
      .replace(/<em>(.*?)<\/em>/gi, "*$1*")
      .replace(/<i>((?:(?!<\/?i>).)*)<\/i>/gi, "*$1*")
      // Strikethrough
      .replace(/<del>(.*?)<\/del>/gi, "~~$1~~")
      .replace(/<s>(.*?)<\/s>/gi, "~~$1~~")
      .replace(/<strike>(.*?)<\/strike>/gi, "~~$1~~")
      // Code
      .replace(/<code>(.*?)<\/code>/gi, "`$1`")
      // Blockquote
      .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, function (_, text) {
        return text.trim().split("\n").map(function (l) { return "> " + l; }).join("\n") + "\n\n";
      })
      // Links and images
      .replace(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
      .replace(/<img[^>]+src="([^"]*)"[^>]*>/gi, "![]($1)")
      // Lists
      .replace(/<li>(.*?)<\/li>/gi, "- $1\n")
      .replace(/<\/?[uo]l>/gi, "")
      // Horizontal rule
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      // Cleanup
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
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
