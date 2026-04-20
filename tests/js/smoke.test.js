import { describe, it, expect } from "vitest";

describe("toolchain smoke", () => {
  it("loads happy-dom globals", () => {
    const el = document.createElement("div");
    el.textContent = "hello";
    document.body.appendChild(el);
    expect(document.body.textContent).toBe("hello");
  });

  it("loadAsset helper exists", () => {
    expect(typeof globalThis.loadAsset).toBe("function");
  });
});
