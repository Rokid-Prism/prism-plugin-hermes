"use strict";

const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHermesNativeRuntime, readyPort } = require("../hermes_native");

test("Hermes Native reads only the ready port and keeps its loopback token private", async () => {
  let spawned = null;
  const runtime = createHermesNativeRuntime({
    resolveHermesBin: async () => "/usr/local/bin/hermes",
    cwd: "/tmp/project",
    spawnImpl(bin, args, options) {
      const child = new EventEmitter();
      child.pid = 4242;
      child.exitCode = null;
      child.killed = false;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("close", 0); };
      spawned = { bin, args, options, child };
      queueMicrotask(() => child.stdout.emit("data", "HERMES_DASHBOARD_READY port=43123\n"));
      return child;
    },
  });
  const connection = await runtime.connection();
  assert.equal(connection.port, 43123);
  assert.equal(connection.pid, 4242);
  assert.match(connection.wsUrl, /^ws:\/\/127\.0\.0\.1:43123\/api\/ws\?token=/);
  assert.equal(spawned.bin, "/usr/local/bin/hermes");
  assert.deepEqual(spawned.args, ["serve", "--host", "127.0.0.1", "--port", "0", "--skip-build"]);
  assert.equal(spawned.options.argv0, "prism-hermes-native");
  assert.match(spawned.options.env.HERMES_DASHBOARD_SESSION_TOKEN, /^[A-Za-z0-9_-]{40,}$/);
  await runtime.close();
});

test("Hermes Native accepts only a valid ready port", () => {
  assert.equal(readyPort("HERMES_DASHBOARD_READY port=9119"), 9119);
  assert.equal(readyPort("HERMES_DASHBOARD_READY port=0"), 0);
  assert.equal(readyPort("ready port=9119"), 0);
});
