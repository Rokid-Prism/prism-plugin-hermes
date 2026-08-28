// Hermes Gateway client compatible with Hermes' @hermes/shared
// JsonRpcGatewayClient. CDP is only used by the caller to obtain the current
// Desktop-owned, authorized WebSocket URL.
//
// @hermes/shared is a private workspace package rather than a distributable
// dependency. Keeping this small compatibility layer in the Plugin makes the
// adapter work with released Hermes Desktop bundles, while following its public
// JSON-RPC framing and connection lifecycle.
//
// Protocol: standard JSON-RPC 2.0 over WebSocket.
//   request:  {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}
//   response: {"jsonrpc":"2.0","id":N,"result":{...}} | {"jsonrpc":"2.0","id":N,"error":{...}}
//   event:    {"jsonrpc":"2.0","method":"event","params":{"type":"...",...}}
//
// The normal Desktop path obtains an already-authorized wsUrl through the
// Desktop preload. Explicit PRISM_HERMES_BACKEND_URL/TOKEN remains a
// developer-only path for a separately managed local Gateway.

"use strict";

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

// Build a ws:// URL carrying the auth token as a query param. The Hermes gateway
// accepts ?token= for loopback-style auth on the WebSocket handshake.
function buildWsUrl(endpoint, token) {
  let url = String(endpoint || "").trim();
  if (!url) return "";
  if (url.startsWith("http://")) url = "ws://" + url.slice(7);
  else if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  else if (!/^wss?:\/\//.test(url)) url = "ws://" + url;
  // Normalize path: ensure /api/ws.
  if (!/\/api\/ws\/?$/.test(url)) {
    url = url.replace(/\/+$/, "") + "/api/ws";
  }
  if (token) {
    url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
  return url;
}

function sessionRunActive(session) {
  const status = String(session && session.status || "").trim().toLowerCase();
  return Boolean(session && session.running === true)
    || ["waiting", "working", "running"].includes(status);
}

function nativeDetailStateEvent(session, detail, liveSessionID, createdAt = new Date().toISOString()) {
  const nativeSessionID = String(session && (session.NativeSessionID || session.NativeThreadID) || "").trim();
  const nativeThreadID = String(session && (session.NativeThreadID || session.NativeSessionID) || "").trim();
  const timestamp = Date.parse(createdAt) || Date.now();
  return {
    ID: `hermes:native-detail:${nativeSessionID || nativeThreadID}:${timestamp}`,
    Type: "desktop.state.changed",
    Status: String(detail && detail.status || "idle"),
    Summary: "Hermes Native state changed",
    CreatedAt: createdAt,
    Payload: {
      desktop_live: false,
      live_session_id: String(liveSessionID || "").trim(),
      detail_snapshot: detail && typeof detail === "object" ? detail : {},
      native_session: {
        plugin_id: "hermes",
        native_session_id: nativeSessionID,
        native_thread_id: nativeThreadID,
        surface: String(session && session.Surface || "hermes-native-gateway"),
        endpoint: String(session && session.Endpoint || ""),
        cwd: String(session && session.Cwd || ""),
      },
    },
  };
}

// resolveBackend is a developer-only explicit endpoint override.
function resolveBackend() {
  const url = String(process.env.PRISM_HERMES_BACKEND_URL || process.env.HERMES_BACKEND_URL || "").trim();
  const token = String(process.env.PRISM_HERMES_BACKEND_TOKEN || process.env.HERMES_BACKEND_TOKEN || process.env.HERMES_DASHBOARD_SESSION_TOKEN || "").trim();
  if (url) return { endpoint: url, token, source: "PRISM_HERMES_BACKEND_URL" };
  return null;
}

// Create a Gateway client. `resolveConnection` is the normal Desktop path and
// must return its authorized wsUrl. `onEvent` receives pushed Gateway events.
function createGatewayClient({ onEvent, resolveConnection } = {}) {
  let ws = null;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const eventListeners = new Set();
  const requestListeners = new Set();
  let connecting = null; // promise during connect()

  function notifyRequestSucceeded(entry, result) {
    for (const listener of requestListeners) {
      try {
        listener({
          method: entry.method,
          params: entry.params,
          metadata: entry.metadata,
          result,
        });
      } catch {}
    }
  }

  function handleRaw(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // Response to a request.
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(rpcError(msg.error));
      else {
        const result = msg.result !== undefined ? msg.result : msg.params;
        entry.resolve(result);
        notifyRequestSucceeded(entry, result);
      }
      return;
    }
    // Gateway events, including gateway.ready, are part of the normal event
    // stream. Hermes Desktop's official client considers the connection ready
    // on WebSocket open and does not turn gateway.ready into a second handshake.
    if (onEvent && msg.method === "event" && msg.params && msg.params.type) {
      onEvent(msg.params);
      for (const listener of eventListeners) {
        try { listener(msg.params); } catch {}
      }
    }
  }

  function rpcError(err) {
    const e = new Error((err && err.message) || "hermes gateway rpc error");
    if (err && err.code !== undefined) e.code = err.code;
    return e;
  }

  async function resolveWsUrl() {
    if (typeof resolveConnection === "function") {
      try {
        const connection = await resolveConnection();
        const wsUrl = String(connection && (connection.wsUrl || connection.ws_url) || "").trim();
        if (/^wss?:\/\//.test(wsUrl)) {
          return wsUrl;
        }
        throw new Error("Hermes Desktop did not provide a valid Gateway WebSocket URL");
      } catch (desktopError) {
        const backend = resolveBackend();
        if (!backend) {
          throw desktopError;
        }
        const wsUrl = buildWsUrl(backend.endpoint, backend.token);
        if (!wsUrl) {
          throw new Error("Hermes Gateway URL is invalid");
        }
        return wsUrl;
      }
    }
    const backend = resolveBackend();
    if (!backend) {
      throw new Error("Hermes Gateway connection is unavailable");
    }
    const wsUrl = buildWsUrl(backend.endpoint, backend.token);
    if (!wsUrl) {
      throw new Error("Hermes Gateway URL is invalid");
    }
    return wsUrl;
  }

  function connect() {
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      void (async () => {
        let socket;
        let settled = false;
        let openTimer = null;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          if (openTimer) clearTimeout(openTimer);
          connecting = null;
          if (error) reject(error);
          else resolve();
        };
        try {
          const wsUrl = await resolveWsUrl();
          if (typeof WebSocket !== "function") {
            throw new Error("Hermes Gateway requires a Node runtime with WebSocket support");
          }
          socket = new WebSocket(wsUrl);
          ws = socket;
          openTimer = setTimeout(() => {
            try { socket.close(); } catch {}
            settle(new Error("Hermes Gateway ready timeout"));
          }, 15000);
          socket.addEventListener("message", (ev) => handleRaw(ev.data));
          socket.addEventListener("open", () => settle(), { once: true });
          socket.addEventListener("close", () => {
            if (ws === socket) ws = null;
            for (const [, entry] of pending) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.reject(new Error("Hermes Gateway closed"));
            }
            pending.clear();
            settle(new Error("Hermes Gateway closed before opening"));
          });
          socket.addEventListener("error", () => {
            settle(new Error("Hermes Gateway connection failed"));
          });
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    return connecting;
  }

  async function ensureReady() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    await connect();
  }

  function request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, metadata = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        await ensureReady();
      } catch (err) {
        return reject(err);
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("hermes gateway not connected"));
      }
      const id = nextId++;
      const entry = { resolve, reject, timer: null, method, params, metadata };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`hermes gateway ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(id, entry);
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  function close() {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
  }

  // The managed TUI relay subscribes here instead of opening a second Hermes
  // Gateway connection. The selected session's event transport stays unique.
  function subscribeEvents(listener) {
    if (typeof listener !== "function") return () => {};
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  // A local relay may need to mirror a successfully accepted mutation into an
  // attached UI. This observes the one existing Gateway connection; it never
  // opens another connection or exposes request contents outside the process.
  function subscribeRequestSuccesses(listener) {
    if (typeof listener !== "function") return () => {};
    requestListeners.add(listener);
    return () => requestListeners.delete(listener);
  }

  // --- High-level adapter helpers (mirror the CDP controller surface so
  //     index.js can switch with minimal changes) ---

  async function listSessions() {
    const r = await request("session.list", {});
    return (r && r.sessions) || [];
  }

  async function modelOptions(sessionID = "", timeoutMs = 15000) {
    const params = {};
    if (sessionID) params.session_id = String(sessionID);
    // Detail snapshots must degrade one capability at a time. Waiting for the
    // generic request default here would block context and run projection for
    // two minutes when Hermes is temporarily busy rebuilding model options.
    return request("model.options", params, timeoutMs);
  }

  // `session.active_list` is deliberately read-only. It is the formal bridge
  // between Hermes' durable session_key and the Gateway's short-lived id; do
  // not use session.resume just to discover or control a Desktop-owned session.
  async function activeSessions() {
    // Gateway serializes some requests on one connection. In particular, a
    // background model catalog read can occasionally delay this read-only
    // durable-session -> live-session mapping past its first timeout. Retry
    // only this idempotent lookup; never retry a mutation or resume a Desktop
    // session just to recover the mapping.
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await request("session.active_list", {}, 15000);
        return Array.isArray(result && result.sessions) ? result.sessions : [];
      } catch (error) {
        lastError = error;
        if (attempt === 0 && /timed out/i.test(String(error && error.message || error))) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error("hermes gateway session.active_list failed");
  }

  async function configGet(key, sessionID = "") {
    const params = { key: String(key || "") };
    if (sessionID) params.session_id = String(sessionID);
    return request("config.get", params, 15000);
  }

  async function configSet(key, value, sessionID = "", extra = {}) {
    const params = {
      ...extra,
      key: String(key || ""),
      value: String(value ?? ""),
    };
    if (sessionID) params.session_id = String(sessionID);
    return request("config.set", params, 30000);
  }

  async function createSession(cwd = "") {
    const params = { cols: 120, rows: 40, source: "prism" };
    if (cwd) params.cwd = cwd;
    return request("session.create", params, 30000);
  }

  async function resumeSession(sessionID) {
    return request("session.resume", { session_id: sessionID, source: "prism" }, 30000);
  }

  // Hermes exposes title changes for the currently live session through the
  // Gateway. This is deliberately distinct from the Desktop REST endpoint:
  // callers must already have proven the live session belongs to the current
  // Desktop conversation before using it.
  async function sessionTitle(sessionID, title) {
    return request("session.title", {
      session_id: String(sessionID || ""),
      title: String(title || ""),
    }, 30000);
  }

  async function submitPrompt(sessionID, text) {
    return request("prompt.submit", { session_id: sessionID, text }, 1800000);
  }

  // Fire-and-forget submit that returns a run id immediately, like the CDP
  // version's submitPromptAsync. The completion surfaces later via events.
  async function submitPromptAsync(sessionID, text) {
    const runId = "prism-hermes-submit-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    // Don't await: let it run; events drive completion.
    request("prompt.submit", { session_id: sessionID, text }, 1800000)
      .catch(() => {});
    return runId;
  }

  // Prism Hub and Hermes Desktop run on the same machine. Keep attachment
  // transfer local: the Gateway stages the supplied path in its workspace and
  // returns a safe @file reference for the subsequent prompt.
  async function attachFile(sessionID, attachment) {
    return request("file.attach", {
      session_id: sessionID,
      path: String(attachment && attachment.LocalPath || ""),
      name: String(attachment && attachment.Name || ""),
    }, 30000);
  }

  async function attachImage(sessionID, attachment) {
    return request("image.attach", {
      session_id: sessionID,
      path: String(attachment && attachment.LocalPath || ""),
    }, 30000);
  }

  async function attachPDF(sessionID, attachment) {
    return request("pdf.attach", {
      session_id: sessionID,
      path: String(attachment && attachment.LocalPath || ""),
    }, 120000);
  }

  async function detachImage(sessionID, imagePath) {
    return request("image.detach", {
      session_id: sessionID,
      path: String(imagePath || ""),
    }, 30000);
  }

  async function interrupt(sessionID) {
    return request("session.interrupt", { session_id: sessionID }, 30000);
  }

  async function respondApproval(choice, sessionID = "") {
    const params = { choice: String(choice || "").trim().toLowerCase() };
    if (sessionID) params.session_id = sessionID;
    return request("approval.respond", params, 30000);
  }

  // Session-scoped queries. Some require the session to be resumed first.
  async function sessionStatus(sessionID) {
    return request("session.status", { session_id: sessionID }, 15000);
  }
  async function sessionUsage(sessionID) {
    return request("session.usage", { session_id: sessionID }, 15000);
  }
  async function sessionContextBreakdown(sessionID, timeoutMs = 15000) {
    return request("session.context_breakdown", { session_id: sessionID }, timeoutMs);
  }
  async function commandsCatalog() {
    return request("commands.catalog", {}, 15000);
  }

  return {
    ensureReady,
    request,
    subscribeEvents,
    subscribeRequestSuccesses,
    close,
    isReady: () => Boolean(ws && typeof WebSocket === "function" && ws.readyState === WebSocket.OPEN),
    // adapter helpers
    listSessions,
    modelOptions,
    activeSessions,
    configGet,
    configSet,
    createSession,
    resumeSession,
    sessionTitle,
    submitPrompt,
    submitPromptAsync,
    attachFile,
    attachImage,
    attachPDF,
    detachImage,
    interrupt,
    respondApproval,
    sessionStatus,
    sessionUsage,
    sessionContextBreakdown,
    commandsCatalog,
  };
}

module.exports = {
  createGatewayClient,
  resolveBackend,
  buildWsUrl,
  sessionRunActive,
  nativeDetailStateEvent,
};
