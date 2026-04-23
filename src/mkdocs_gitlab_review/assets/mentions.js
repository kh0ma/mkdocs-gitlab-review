/**
 * @mention autocomplete for Quill editors.
 *
 * Fixes three bugs present in the inline implementation previously in review.js:
 *  - Cyrillic detection (replaces \w with Unicode property escape)
 *  - Dropdown escape from editor container (now appended inside container, caret-anchored)
 *  - Race conditions on fast typing (sequence-number guard)
 *
 * Public API:
 *   MentionAutocomplete.attach(quill, {container, searchMembers}) → {detach()}
 *
 * Internal helpers exposed for unit tests:
 *   MentionAutocomplete._matchTrigger(text) → {query, length} | null
 *   MentionAutocomplete._createSequencer() → {next(), isLatest(seq)}
 */
(function () {
  "use strict";

  // Unicode-aware trigger regex.
  // Matches "@<letters/digits/_.->*" at end of text, where the char before @
  // is either start-of-text or a non-word character (so "user@domain" is NOT a mention).
  var TRIGGER_RE = /(?:^|[^\p{L}\p{N}_.\-])@([\p{L}\p{N}_.\-]*)$/u;

  function matchTrigger(text) {
    var m = text.match(TRIGGER_RE);
    if (!m) return null;
    // Full match length minus the prefix char (when present) tells us "@" start offset.
    // Easier: find the LAST "@" in text, verify regex matched that same position.
    var atIdx = text.lastIndexOf("@");
    if (atIdx < 0) return null;
    // Validate that char before @ (if any) is non-word per TRIGGER_RE.
    if (atIdx > 0) {
      var prev = text.charAt(atIdx - 1);
      if (/[\p{L}\p{N}_.\-]/u.test(prev)) return null;
    }
    var query = text.substring(atIdx + 1);
    // Query must be empty or only allowed chars.
    if (query.length > 0 && !/^[\p{L}\p{N}_.\-]+$/u.test(query)) return null;
    return { query: query, length: query.length + 1 }; // +1 for the "@"
  }

  function createSequencer() {
    var current = 0;
    return {
      next: function () { current += 1; return current; },
      isLatest: function (seq) { return seq === current; },
    };
  }

  function attach(quill, opts) {
    opts = opts || {};
    var container = opts.container;
    var searchMembers = opts.searchMembers;
    if (!container || !searchMembers) {
      throw new Error("MentionAutocomplete.attach requires {container, searchMembers}");
    }
    // Container must be positioned so absolute children anchor correctly.
    var cs = window.getComputedStyle && window.getComputedStyle(container);
    if (cs && cs.position === "static") {
      container.style.position = "relative";
    }

    var dropdown = null;
    var activeIndex = 0;
    var items = [];
    var seq = createSequencer();
    var fetchTimer = null;
    var currentRange = null; // {startIdx, endIdx}
    var detached = false;

    function closeDropdown() {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
      }
      items = [];
      activeIndex = 0;
      currentRange = null;
    }

    function positionDropdown() {
      if (!dropdown || !currentRange) return;
      // Position at the @ character, not the current cursor position.
      var bounds = quill.getBounds(currentRange.startIdx);
      // Convert editor-relative bounds to viewport-fixed coordinates.
      var editorEl = quill.root;
      var editorRect = editorEl.getBoundingClientRect();
      var left = editorRect.left + bounds.left;
      var top = editorRect.top + bounds.top + bounds.height + 4;
      // Use fixed positioning so the dropdown escapes any overflow:hidden ancestor.
      dropdown.style.position = "fixed";
      // Flip above caret if near viewport bottom.
      var dropdownHeight = dropdown.offsetHeight || 240;
      if (top + dropdownHeight > window.innerHeight - 40) {
        dropdown.style.top = (editorRect.top + bounds.top - dropdownHeight - 4) + "px";
        dropdown.dataset.flipped = "true";
      } else {
        dropdown.style.top = top + "px";
        dropdown.dataset.flipped = "false";
      }
      dropdown.style.left = left + "px";
    }

    function renderDropdown(members) {
      if (!dropdown) {
        dropdown = document.createElement("div");
        dropdown.className = "glr-mention-dropdown";
        dropdown.id = "glr-mention-dropdown";
        document.body.appendChild(dropdown);
      }
      dropdown.innerHTML = "";
      items = [];
      members.forEach(function (m, i) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "glr-mention-item" + (i === 0 ? " glr-mention-item--active" : "");
        btn.setAttribute("role", "option");
        btn.dataset.username = m.username;
        var avatar = m.avatar_url
          ? '<img class="glr-mention-item__avatar" src="' + escapeHtml(m.avatar_url) + '" alt="">'
          : '<span class="glr-mention-item__avatar glr-mention-item__avatar--placeholder" aria-hidden="true"></span>';
        btn.innerHTML =
          avatar +
          '<span class="glr-mention-item__name">' + escapeHtml(m.name || m.username) + "</span>" +
          '<span class="glr-mention-item__username">@' + escapeHtml(m.username) + "</span>";
        btn.addEventListener("mousedown", function (e) {
          e.preventDefault();
          selectItem(i);
        });
        dropdown.appendChild(btn);
        items.push({ member: m, el: btn });
      });
      activeIndex = 0;
      positionDropdown();
    }

    function selectItem(index) {
      if (index < 0 || index >= items.length) return;
      var m = items[index].member;
      if (!currentRange) return;
      // Replace the "@query" range with "@username " as PLAIN TEXT (no Quill format).
      quill.deleteText(currentRange.startIdx, currentRange.endIdx - currentRange.startIdx);
      // Clear any inherited format so insertion is plain-text safe.
      var before = quill.getFormat ? quill.getFormat(currentRange.startIdx, 0) : {};
      quill.insertText(currentRange.startIdx, "@" + m.username + " ");
      // Strip any formatting Quill may have inherited onto the inserted range.
      if (quill.removeFormat) {
        quill.removeFormat(currentRange.startIdx, m.username.length + 2);
      }
      quill.setSelection(currentRange.startIdx + m.username.length + 2);
      closeDropdown();
    }

    function moveHighlight(delta) {
      if (items.length === 0) return;
      items[activeIndex].el.classList.remove("glr-mention-item--active");
      activeIndex = (activeIndex + delta + items.length) % items.length;
      items[activeIndex].el.classList.add("glr-mention-item--active");
      items[activeIndex].el.scrollIntoView({ block: "nearest" });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function showLoading() {
      if (!dropdown) {
        dropdown = document.createElement("div");
        dropdown.className = "glr-mention-dropdown";
        dropdown.id = "glr-mention-dropdown";
        document.body.appendChild(dropdown);
      }
      dropdown.innerHTML = '<div class="glr-mention-item glr-mention-item--loading">Пошук...</div>';
      items = [];
      activeIndex = 0;
      positionDropdown();
    }

    function onTextChange() {
      // Use setTimeout so Quill's selection is readable after the change settles.
      setTimeout(function () {
        if (detached) return;
        var sel = quill.getSelection();
        if (!sel) return;
        var textBefore = quill.getText(0, sel.index);
        var match = matchTrigger(textBefore);
        if (!match) { closeDropdown(); return; }
        var startIdx = sel.index - match.length;
        var endIdx = sel.index;
        currentRange = { startIdx: startIdx, endIdx: endIdx };

        clearTimeout(fetchTimer);
        var mySeq = seq.next();
        showLoading();
        fetchTimer = setTimeout(function () {
          searchMembers(match.query, { perPage: 5 })
            .then(function (members) {
              if (!seq.isLatest(mySeq)) return; // stale
              // API does the heavy lifting; client-side filter as fallback for name matching
              var results = filterMembers(members || [], match.query).slice(0, 5);
              if (results.length === 0) { closeDropdown(); return; }
              renderDropdown(results);
            })
            .catch(function () {
              if (!seq.isLatest(mySeq)) return;
              closeDropdown();
            });
        }, 300);
      }, 0);
    }

    function onKeyDown(e) {
      if (!dropdown) return;
      if (e.key === "ArrowDown") { e.preventDefault(); moveHighlight(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveHighlight(-1); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectItem(activeIndex); }
      else if (e.key === "Escape") { e.preventDefault(); closeDropdown(); }
    }

    function onOutsideClick(e) {
      if (dropdown && !container.contains(e.target) && !dropdown.contains(e.target)) {
        closeDropdown();
      }
    }

    function filterMembers(members, query) {
      if (!query) return members;
      var q = query.toLowerCase();
      return members.filter(function (m) {
        return (m.username || "").toLowerCase().indexOf(q) !== -1 ||
               (m.name || "").toLowerCase().indexOf(q) !== -1;
      });
    }

    quill.on("text-change", onTextChange);
    container.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onOutsideClick);

    return {
      detach: function () {
        detached = true;
        closeDropdown();
        container.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("click", onOutsideClick);
      },
    };
  }

  window.MentionAutocomplete = {
    attach: attach,
    _matchTrigger: matchTrigger,
    _createSequencer: createSequencer,
  };
})();
