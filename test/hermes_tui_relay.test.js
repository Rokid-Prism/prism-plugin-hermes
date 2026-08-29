"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHermesTuiRelay, launchManagedHermesTui } = require("../hermes_tui_relay");

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket message failed")), { once: true });
  });
}

test("managed TUI relay keeps one Gateway owner while preserving JSON-RPC and events", async (t) => {
  const requests = [];
  const listeners = new Set();
  const requestListeners = new Set();
  const gateway = {
    async ensureReady() {},
    async request(method, params) {
      requests.push({ method, params });
      return { sessions: [{ id: "native-1" }] };
    },
    subscribeEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeRequestSuccesses(listener) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
  };
  const relay = createHermesTuiRelay({ gateway });
  t.after(async () => { await relay.close(); });

  const { wsUrl } = await relay.start();
  assert.match(wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/prism\/hermes\/tui\?token=/);
  const socket = new WebSocket(wsUrl);
  t.after(() => socket.close());
  await onceOpen(socket);

  const ready = await nextMessage(socket);
  assert.deepEqual(ready, { jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });

  const responsePromise = nextMessage(socket);
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: "tui-request-1", method: "session.list", params: { limit: 20 } }));
  assert.deepEqual(await responsePromise, {
    jsonrpc: "2.0",
    id: "tui-request-1",
    result: { sessions: [{ id: "native-1" }] },
  });
  assert.deepEqual(requests, [{ method: "session.list", params: { limit: 20 } }]);

  const userMessagePromise = nextMessage(socket);
  for (const listener of requestListeners) {
    listener({ method: "prompt.submit", params: { session_id: "native-1", text: "sent from mobile" }, metadata: {} });
  }
  assert.deepEqual(await userMessagePromise, {
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.user", session_id: "native-1", payload: { text: "sent from mobile" } },
  });

  const eventPromise = nextMessage(socket);
  for (const listener of listeners) listener({ type: "session.info", session_id: "native-1", payload: { title: "Managed" } });
  assert.deepEqual(await eventPromise, {
    jsonrpc: "2.0",
    method: "event",
    params: { type: "session.info", session_id: "native-1", payload: { title: "Managed" } },
  });
});

test("managed TUI launch only injects the loopback relay URL into Terminal", () => {
  let spawnCall = null;
  const child = { unref() {} };
  const handoff = { file: "/private/tmp/prism-hermes-tui-test/gateway-url", dir: "/private/tmp/prism-hermes-tui-test", cleanup() {} };
  launchManagedHermesTui({
    bin: "/Users/test/.local/bin/hermes",
    cwd: "/private/tmp/prism-hermes-native-e2e",
    wsUrl: "ws://127.0.0.1:32123/prism/hermes/tui?token=secret-token",
    platform: "darwin",
    spawnImpl: (...args) => {
      spawnCall = args;
      return child;
    },
    handoffFactory: (url) => {
      assert.equal(url, "ws://127.0.0.1:32123/prism/hermes/tui?token=secret-token");
      return handoff;
    },
  });
  assert.equal(spawnCall[0], "/usr/bin/osascript");
  assert.deepEqual(spawnCall[2], { detached: true, stdio: "ignore" });
  assert.doesNotMatch(spawnCall[1][1], /secret-token|HERMES_TUI_GATEWAY_URL='ws:/);
  assert.match(spawnCall[1][1], /cat '\/private\/tmp\/prism-hermes-tui-test\/gateway-url'/);
  assert.match(spawnCall[1][1], /export HERMES_TUI_GATEWAY_URL=\\"\$relay_url\\"/);
  assert.match(spawnCall[1][1], /'\/Users\/test\/\.local\/bin\/hermes' --tui/);
});
