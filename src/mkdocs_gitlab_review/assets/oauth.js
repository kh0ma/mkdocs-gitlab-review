/**
 * GitLab OAuth PKCE helper.
 * Provides login/logout/token management for client-side GitLab auth.
 */
window.GitLabOAuth = (function () {
  "use strict";

  var TOKEN_KEY = "gitlab-review-token";
  var STATE_KEY = "gitlab-review-state";
  var VERIFIER_KEY = "gitlab-review-verifier";

  function getConfig() {
    return window.__GITLAB_REVIEW__ || {};
  }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
  }

  function setToken(token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) {}
  }

  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }

  function isLoggedIn() {
    return !!getToken();
  }

  // --- PKCE helpers ---

  function generateRandom(length) {
    var arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function base64UrlEncode(buffer) {
    var bytes = new Uint8Array(buffer);
    var str = "";
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function sha256(plain) {
    var encoder = new TextEncoder();
    return crypto.subtle.digest("SHA-256", encoder.encode(plain));
  }

  // --- Login flow ---

  function login() {
    var config = getConfig();
    if (!config.gitlab_url || !config.oauth_client_id) return;

    var verifier = generateRandom(32);
    var state = generateRandom(16);

    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    sha256(verifier).then(function (hash) {
      var challenge = base64UrlEncode(hash);
      var redirectUri = window.location.origin + window.location.pathname;
      var url = config.gitlab_url + "/oauth/authorize" +
        "?client_id=" + encodeURIComponent(config.oauth_client_id) +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&response_type=code" +
        "&scope=api" +
        "&state=" + encodeURIComponent(state) +
        "&code_challenge=" + encodeURIComponent(challenge) +
        "&code_challenge_method=S256";
      window.location.href = url;
    });
  }

  function handleCallback() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var state = params.get("state");

    if (!code || !state) return Promise.resolve(false);

    var savedState = sessionStorage.getItem(STATE_KEY);
    var verifier = sessionStorage.getItem(VERIFIER_KEY);

    if (state !== savedState || !verifier) return Promise.resolve(false);

    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);

    var config = getConfig();
    var redirectUri = window.location.origin + window.location.pathname;

    var body = "grant_type=authorization_code" +
      "&code=" + encodeURIComponent(code) +
      "&client_id=" + encodeURIComponent(config.oauth_client_id) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&code_verifier=" + encodeURIComponent(verifier);

    return fetch(config.gitlab_url + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.access_token) {
          setToken(data.access_token);
          // Clean URL params
          var clean = window.location.pathname + window.location.hash;
          window.history.replaceState(null, "", clean);
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  function logout() {
    clearToken();
    window.location.reload();
  }

  // --- API helper ---

  function apiFetch(path, options) {
    var config = getConfig();
    var token = getToken();
    if (!token) return Promise.reject(new Error("Not authenticated"));

    var url = config.gitlab_url + "/api/v4" + path;
    var opts = Object.assign({}, options || {}, {
      headers: Object.assign({
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      }, (options && options.headers) || {}),
    });

    return fetch(url, opts).then(function (r) {
      if (r.status === 401) {
        clearToken();
        return Promise.reject(new Error("Token expired"));
      }
      return r.json();
    });
  }

  return {
    getToken: getToken,
    isLoggedIn: isLoggedIn,
    login: login,
    logout: logout,
    handleCallback: handleCallback,
    apiFetch: apiFetch,
  };
})();
