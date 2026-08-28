"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createGatewayClient,
  sessionRunActive,
  nativeDetailStateEvent,
} = require("../hermes_gateway");

test("Hermes session starting state locks setup without reporting an active reply", () => {
  assert.equal(sessionRunActive({ status: "starting" }), false);
  assert.equal(sessionRunActive({ status: "idle" }), false);
  assert.equal(sessionRunActive({ status: "working" }), true);
  assert.equal(sessionRunActive({ running: true, status: "idle" }), true);
});

test("Hermes Native wide state events carry a resolvable session and full detail snapshot", () => {
  const detail = { status: "idle", context_window_total: "400000", context_tokens_used: "21415" };
  const event = nativeDetailStateEvent({
    NativeSessionID: "stored-1",
    NativeThreadID: "stored-1",
    Surface: "hermes-native-gateway",
    Endpoint: "hermes://sessions/stored-1",
    Cwd: "/tmp/project",
  }, detail, "live-1", "2026-08-14T15:31:25.000Z");

  assert.equal(event.Type, "desktop.state.changed");
  assert.equal(event.Payload.live_session_id, "live-1");
  assert.equal(event.Payload.detail_snapshot, detail);
  assert.deepEqual(event.Payload.native_session, {
    plugin_id: "hermes",
    native_session_id: "stored-1",
    native_thread_id: "stored-1",
    surface: "hermes-native-gateway",
    endpoint: "hermes://sessions/stored-1",
    cwd: "/tmp/project",
  });
});

test("Hermes active session lookup retries one timeout without resuming a session", async () => {
  const originalWebSocket = global.WebSocket;
  const calls = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, listener, options = {}) {
      const entries = this.listeners.get(type) || [];
      entries.push({ listener, once: options.once === true });
      this.listeners.set(type, entries);
    }

    emit(type, event) {
      const entries = this.listeners.get(type) || [];
      this.listeners.set(type, entries.filter((entry) => !entry.once));
      for (const entry of entries) entry.listener(event);
    }

    send(raw) {
      const request = JSON.parse(raw);
      calls.push(request.method);
      const first = calls.length === 1;
      queueMicrotask(() => this.emit("message", first
        ? { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "session.active_list timed out" } }) }
        : { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "live-1" }] } }) }));
    }

    close() {
      this.readyState = 3;
      this.emit("close", {});
    }
  }

  global.WebSocket = FakeWebSocket;
  try {
    const client = createGatewayClient({
      resolveConnection: async () => ({ wsUrl: "ws://127.0.0.1:1/api/ws" }),
    });
    assert.deepEqual(await client.activeSessions(), [{ id: "live-1" }]);
    assert.deepEqual(calls, ["session.active_list", "session.active_list"]);
    client.close();
  } finally {
    global.WebSocket = originalWebSocket;
  }
});
