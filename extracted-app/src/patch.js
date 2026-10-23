/*
 * ThunderBolt launcher 1.8.5 — local verification bypass (fetch + remote-WS shim).
 *
 * 1. fetch shim: verify.thunderbolt.click (/ and /check) -> canned success.
 *    Original auth handler runs its normal success path untouched.
 * 2. WebSocket stub for ws://137.74.43.22:3000: the swarm alert feed rejects
 *    any non-genuine token (close 1008 "Invalid token"). Replace it with an
 *    always-open dummy so the status stays green and no reconnect churn.
 *    localhost connections keep the real WebSocket.
 */
(function () {
  'use strict';

  /* ---------- 1. verify shim ---------- */
  var VERIFY_HOST = 'verify.thunderbolt.click';
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  function fakeBody() {
    return {
      success: true,
      access_profiles: 100,
      user: 'Mongoose',
      days_left: 9999,
      ends_at: 'never'
    };
  }
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf(VERIFY_HOST) !== -1) {
          console.log('[patch] canned verify response for', url);
          return Promise.resolve(new Response(JSON.stringify(fakeBody()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
      } catch (e) { /* fallthrough */ }
      return origFetch(input, init);
    };
  }

  /* ---------- 2. remote WS stub ---------- */
  var REMOTE_HOST = '137.74.43.22:3000';
  var RealWS = window.WebSocket;
  function DummyWS(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null;
    var self = this;
    setTimeout(function () {
      if (typeof self.onopen === 'function') self.onopen({ type: 'open' });
    }, 50);
  }
  DummyWS.prototype.send = function () { /* absorb */ };
  DummyWS.prototype.close = function () { this.readyState = 3; };
  DummyWS.CONNECTING = 0; DummyWS.OPEN = 1; DummyWS.CLOSING = 2; DummyWS.CLOSED = 3;
  DummyWS.prototype.addEventListener = function (t, fn) {
    if (t === 'open') this.onopen = fn;
    else if (t === 'close') this.onclose = fn;
    else if (t === 'message') this.onmessage = fn;
    else if (t === 'error') this.onerror = fn;
  };
  DummyWS.prototype.removeEventListener = function () { /* no-op */ };
  window.WebSocket = function (url, protocols) {
    if (String(url).indexOf(REMOTE_HOST) !== -1) {
      console.log('[patch] stubbed remote WS', url);
      return new DummyWS(url);
    }
    return protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
  };
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

  // 3. UI Status Indicator: Keep statusDot connected and statusText Connected
  function updateUIStatus() {
    var dot = document.getElementById('statusDot');
    var text = document.getElementById('statusText');
    if (dot && dot.className.indexOf('connected') === -1) {
      dot.className = 'status-dot connected';
    }
    if (text && text.textContent !== 'Connected') {
      text.textContent = 'Connected';
    }
  }
  setInterval(updateUIStatus, 1000);

  console.log('[patch] ThunderBolt 1.8.5 shims active (verify + remote WS + UI status)');
})();
