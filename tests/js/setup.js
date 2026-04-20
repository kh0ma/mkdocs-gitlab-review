// Global test setup.
// Because the plugin scripts attach to window (IIFE pattern, no ES modules),
// tests load them by reading the file text and evaluating inside a scoped function.
// This helper is used by every test file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

globalThis.loadAsset = function loadAsset(relPath) {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src).call(globalThis);
};

// Minimal OAuth stub used by multiple tests; override via window.GitLabOAuth in individual tests.
globalThis.installOAuthStub = function installOAuthStub(impl) {
  window.GitLabOAuth = {
    isLoggedIn: () => true,
    apiFetch: impl && impl.apiFetch ? impl.apiFetch : () => Promise.resolve([]),
    login: () => {},
    handleCallback: () => Promise.resolve(),
  };
};
