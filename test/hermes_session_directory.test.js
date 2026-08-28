"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeDirectoryRows, nativeDirectoryTitle } = require("../hermes_session_directory");

const firstNonEmpty = (...values) => values.find((value) => String(value || "").trim()) || "";

test("Hermes Native keeps durable CLI sessions when its private Gateway has not resumed them", () => {
  const rows = nativeDirectoryRows([
    { id: "cli-ceshi", title: "ceshi-cli", source: "cli", last_activity: 30 },
    { id: "desktop-1", title: "Desktop", source: "tui", last_activity: 20 },
  ], [
    { session_key: "desktop-1", session_id: "live-1", title: "Desktop live" },
  ], firstNonEmpty);

  assert.deepEqual(rows.map((row) => row.id), ["cli-ceshi", "desktop-1"]);
  assert.equal(rows[0].gateway_session, null);
  assert.equal(rows[1].gateway_session.session_id, "live-1");
});

test("Hermes Native retains a Gateway session only until its durable row appears", () => {
  const rows = nativeDirectoryRows([], [
    { session_key: "new-session", session_id: "live-new", title: "pending" },
  ], firstNonEmpty);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "new-session");
  assert.equal(rows[0].source, "native_pending");
});

test("Hermes Native keeps a durable conversation title over Gateway instance metadata", () => {
  const [row] = nativeDirectoryRows([
    { id: "cli-ceshi", title: "ceshi-xxx", source: "cli" },
  ], [
    { session_key: "cli-ceshi", title: "desktop-app" },
  ], firstNonEmpty);

  assert.equal(nativeDirectoryTitle(row, firstNonEmpty), "ceshi-xxx");
});
