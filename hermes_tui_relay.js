"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MAX_FRAME_BYTES = 1024 * 1024;
const TERMINAL_HANDOFF_TTL_MS = 60_000;

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'"'"'`)}'`;
}

function webSocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function encodeFrame(opcode, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (payload.length > MAX_FRAME_BYTES) throw new Error("managed TUI frame too large");
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

class RelayPeer {
  constructor(socket, onText) {
    this.socket = socket;
    this.onText = onText;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  send(value) {
    if (this.closed || this.socket.destroyed) return;
    try { this.socket.write(encodeFrame(0x1, JSON.stringify(value))); } catch { this.close(); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch {}
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127 || length > MAX_FRAME_BYTES) {
        this.close();
        return;
      }
      if (!masked || this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        try { this.socket.write(encodeFrame(0xA, payload)); } catch { this.close(); }
        continue;
      }
      if (opcode !== 0x1 || (first & 0x80) === 0) {
        this.close();
        return;
      }
      this.onText(payload.toString("utf8"));
    }
  }
}

function createHermesTuiRelay({ gateway, createServer = http.createServer } = {}) {
  if (!gateway || typeof gateway.request !== "function" || typeof gateway.subscribeEvents !== "function") {
    throw new Error("Hermes TUI relay requires an event-bearing Gateway client");
  }
  let server = null;
  let token = "";
  let port = 0;
  let unsubscribe = null;
  let unsubscribeRequests = null;
  const peers = new Set();

  function broadcast(params) {
    for (const peer of [...peers]) {
      if (peer.closed) peers.delete(peer);
      else peer.send({ jsonrpc: "2.0", method: "event", params });
    }
  }

  async function handleRequest(peer, text) {
    let request;
    try { request = JSON.parse(text); } catch {
      peer.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const id = Object.prototype.hasOwnProperty.call(request || {}, "id") ? request.id : null;
    const method = String(request && request.method || "").trim();
    if (!method) {
      peer.send({ jsonrpc: "2.0", id, error: { code: -32600, message: "method required" } });
      return;
    }
    try {
      const result = await gateway.request(
        method,
        request && request.params && typeof request.params === "object" ? request.params : {},
        undefined,
        { source: "managed_tui" },
      );
      if (id !== null) peer.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (error) {
      if (id !== null) peer.send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error && error.message || "gateway request failed").slice(0, 500) } });
    }
  }

  async function start() {
    if (server && port) return { wsUrl: `ws://127.0.0.1:${port}/prism/hermes/tui?token=${encodeURIComponent(token)}` };
    await gateway.ensureReady();
    token = crypto.randomBytes(32).toString("base64url");
    server = createServer((_, response) => { response.writeHead(404); response.end(); });
    server.on("upgrade", (request, socket) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const key = String(request.headers["sec-websocket-key"] || "");
      if (url.pathname !== "/prism/hermes/tui" || url.searchParams.get("token") !== token || !key) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${webSocketAccept(key)}`,
        "\r\n",
      ].join("\r\n"));
      const peer = new RelayPeer(socket, (text) => { void handleRequest(peer, text); });
      peers.add(peer);
      peer.send({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
    });
    unsubscribe = gateway.subscribeEvents((event) => broadcast(event));
    if (typeof gateway.subscribeRequestSuccesses === "function") {
      unsubscribeRequests = gateway.subscribeRequestSuccesses((request) => {
        if (request?.method !== "prompt.submit" || request?.metadata?.source === "managed_tui") return;
        const sessionID = String(request?.params?.session_id || "").trim();
        const text = String(request?.params?.text || "");
        if (!sessionID || !text) return;
        broadcast({ type: "message.user", session_id: sessionID, payload: { text } });
      });
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    port = server.address().port;
    return { wsUrl: `ws://127.0.0.1:${port}/prism/hermes/tui?token=${encodeURIComponent(token)}` };
  }

  async function close() {
    for (const peer of peers) peer.close();
    peers.clear();
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (unsubscribeRequests) unsubscribeRequests();
    unsubscribeRequests = null;
    const active = server;
    server = null;
    port = 0;
    token = "";
    if (active) await new Promise((resolve) => active.close(() => resolve()));
  }

  return { start, close };
}

function createTerminalHandoff(wsUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-hermes-tui-"));
  const file = path.join(dir, "gateway-url");
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, String(wsUrl), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    dir,
    file,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function launchManagedHermesTui({ bin, cwd, wsUrl, platform = process.platform, spawnImpl = spawn, handoffFactory = createTerminalHandoff } = {}) {
  if (platform !== "darwin") throw new Error("managed Hermes TUI currently supports macOS only");
  if (!bin || !wsUrl) throw new Error("managed Hermes TUI requires executable and Gateway URL");
  const handoff = handoffFactory(wsUrl);
  if (!handoff || !handoff.file || !handoff.dir) throw new Error("managed Hermes TUI could not prepare the local relay handoff");
  // Keep the URL out of osascript/Terminal argv. The shell reads it once,
  // removes the 0600 handoff file, then supplies it only to the TUI environment.
  const handoffFile = shellQuote(handoff.file);
  const handoffDir = shellQuote(handoff.dir);
  const command = `cd ${shellQuote(cwd || process.cwd())}; relay_url="$(cat ${handoffFile})"; relay_status=$?; rm -f ${handoffFile}; rmdir ${handoffDir} 2>/dev/null || true; if [ $relay_status -ne 0 ] || [ -z "$relay_url" ]; then exit 1; fi; export HERMES_TUI_GATEWAY_URL="$relay_url"; exec ${shellQuote(bin)} --tui`;
  let child;
  try {
    child = spawnImpl("/usr/bin/osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], { detached: true, stdio: "ignore" });
  } catch (error) {
    handoff.cleanup?.();
    throw error;
  }
  child.once?.("error", () => handoff.cleanup?.());
  const timer = setTimeout(() => handoff.cleanup?.(), TERMINAL_HANDOFF_TTL_MS);
  timer.unref?.();
  child.unref?.();
  return child;
}

module.exports = { createHermesTuiRelay, createTerminalHandoff, launchManagedHermesTui };
