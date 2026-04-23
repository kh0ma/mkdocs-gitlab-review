import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Minimal Quill stub.
 * Emits text-change events when setText is called; supports getSelection/getText/getBounds.
 */
function makeQuillStub(initialText) {
  var text = initialText || "";
  var selection = { index: text.length, length: 0 };
  var listeners = {};
  var bounds = { top: 100, bottom: 130, left: 50, right: 100, height: 30, width: 50 };
  return {
    _text: function () { return text; },
    root: document.createElement("div"),
    on: function (event, fn) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    emit: function (event) {
      (listeners[event] || []).forEach(function (fn) { fn(); });
    },
    getSelection: function () { return selection; },
    setSelection: function (index) { selection = { index: index, length: 0 }; },
    getText: function (start, len) {
      if (start === undefined) return text;
      return text.substring(start, start + (len || text.length - start));
    },
    setText: function (t) {
      text = t;
      selection = { index: t.length, length: 0 };
      this.emit("text-change");
    },
    insertText: function (index, content) {
      text = text.substring(0, index) + content + text.substring(index);
      selection = { index: index + content.length, length: 0 };
      this.emit("text-change");
    },
    deleteText: function (index, len) {
      text = text.substring(0, index) + text.substring(index + len);
      selection = { index: index, length: 0 };
    },
    getBounds: function () { return bounds; },
    getFormat: function () { return {}; },
    format: vi.fn(),
    removeFormat: vi.fn(),
    _setBounds: function (b) { bounds = b; },
  };
}

/** Helper: find the mention dropdown in the DOM (appended to document.body). */
function getDropdown() {
  return document.querySelector(".glr-mention-dropdown");
}

function getDropdownItems() {
  var dd = getDropdown();
  return dd ? dd.querySelectorAll(".glr-mention-item:not(.glr-mention-item--loading)") : [];
}

describe("MentionAutocomplete — DOM behavior", () => {
  let quill;
  let container;
  let searchMembers;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    container.id = "editor-container";
    container.style.position = "relative";
    document.body.appendChild(container);

    quill = makeQuillStub("hello ");
    // Stub getBoundingClientRect on quill.root
    quill.root.getBoundingClientRect = () => ({
      top: 0, left: 0, bottom: 200, right: 600, width: 600, height: 200
    });
    searchMembers = vi.fn().mockResolvedValue([
      { id: 1, username: "andriy", name: "Andriy", avatar_url: null },
      { id: 2, username: "олек", name: "Олек", avatar_url: null },
    ]);

    loadAsset("src/mkdocs_gitlab_review/assets/mentions.js");
  });

  it("attach returns {detach} object", () => {
    const handle = window.MentionAutocomplete.attach(quill, { container, searchMembers });
    expect(typeof handle.detach).toBe("function");
  });

  it("typing @ triggers searchMembers with empty query", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    // Wait for debounce (300ms) + settle
    await new Promise(r => setTimeout(r, 350));
    expect(searchMembers).toHaveBeenCalledWith("", expect.anything());
  });

  it("typing Cyrillic @олек triggers searchMembers with Cyrillic query", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @олек");
    await new Promise(r => setTimeout(r, 350));
    expect(searchMembers).toHaveBeenCalledWith("олек", expect.anything());
  });

  it("shows loading indicator immediately after @, then renders results", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    // After the next tick (setTimeout 0), loading should appear before debounce fires
    await new Promise(r => setTimeout(r, 50));
    var dd = getDropdown();
    expect(dd).not.toBeNull();
    expect(dd.querySelector(".glr-mention-item--loading")).not.toBeNull();
    // After debounce, real results replace loading
    await new Promise(r => setTimeout(r, 350));
    var items = getDropdownItems();
    expect(items.length).toBe(2);
  });

  it("dropdown appends to document.body with fixed positioning", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 400));
    var dd = getDropdown();
    expect(dd).not.toBeNull();
    expect(dd.style.position).toBe("fixed");
  });

  it("requests perPage=5 from API", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @and");
    await new Promise(r => setTimeout(r, 350));
    expect(searchMembers).toHaveBeenCalledWith("and", { perPage: 5 });
  });

  it("clicking dropdown item inserts plain @username and closes dropdown", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @and");
    await new Promise(r => setTimeout(r, 400));
    var items = getDropdownItems();
    expect(items.length).toBeGreaterThan(0);
    // Trigger mousedown (not click — mousedown fires before blur)
    items[0].dispatchEvent(new Event("mousedown", { bubbles: true }));
    expect(quill._text()).toBe("hello @andriy ");
    expect(quill.format).not.toHaveBeenCalled(); // No Quill format applied
    expect(getDropdown()).toBeNull();
  });

  it("Down arrow moves highlight to next item", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 400));
    var items = getDropdownItems();
    expect(items[0].classList.contains("glr-mention-item--active")).toBe(true);
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    expect(items[0].classList.contains("glr-mention-item--active")).toBe(false);
    expect(items[1].classList.contains("glr-mention-item--active")).toBe(true);
  });

  it("Enter selects currently highlighted item", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 400));
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    expect(quill._text()).toBe("hello @олек ");
  });

  it("Escape closes dropdown without selecting", async () => {
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 400));
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(getDropdown()).toBeNull();
    expect(quill._text()).toBe("hello @"); // Text unchanged
  });

  it("stale response is discarded (race guard)", async () => {
    var resolves = [];
    searchMembers = vi.fn().mockImplementation(function () {
      return new Promise(function (resolve) { resolves.push(resolve); });
    });
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @a");
    await new Promise(r => setTimeout(r, 350));
    quill.setText("hello @an");
    await new Promise(r => setTimeout(r, 350));
    // Two requests now in-flight. Resolve second one first, then first (stale).
    resolves[1]([{ id: 1, username: "andriy", name: "Andriy", avatar_url: null }]);
    await new Promise(r => setTimeout(r, 10));
    var firstItems = getDropdownItems();
    expect(firstItems.length).toBe(1);
    resolves[0]([{ id: 9, username: "stale", name: "Stale", avatar_url: null }]);
    await new Promise(r => setTimeout(r, 10));
    // Dropdown should NOT be replaced by stale data
    var stillShowing = getDropdownItems();
    expect(stillShowing[0].textContent).toContain("andriy");
  });

  it("dropdown positions at the @ character using getBounds", async () => {
    quill._setBounds({ top: 100, bottom: 130, left: 50, right: 100, height: 30, width: 50 });
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 400));
    var dd = getDropdown();
    expect(dd).not.toBeNull();
    // top = editorRect.top(0) + bounds.top(100) + bounds.height(30) + 4 = 134
    expect(dd.style.top).toBe("134px");
    // left = editorRect.left(0) + bounds.left(50) = 50
    expect(dd.style.left).toBe("50px");
  });

  it("dropdown flips above caret when near viewport bottom", async () => {
    // happy-dom defaults window.innerHeight to 768; place caret near bottom.
    quill._setBounds({ top: 600, bottom: 630, left: 50, right: 100, height: 30, width: 50 });
    window.MentionAutocomplete.attach(quill, { container, searchMembers });
    quill.setText("hello @");
    await new Promise(r => setTimeout(r, 400));
    var dd = getDropdown();
    expect(dd).not.toBeNull();
    // We check the dataset marker set by impl.
    expect(dd.dataset.flipped).toBe("true");
  });
});
