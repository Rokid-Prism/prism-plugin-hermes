"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeApprovalID } = require("../hermes_approval");

test("Hermes Native approval IDs are stable opaque URL path segments", () => {
  const event = {
    type: "approval.request",
    session_id: "live/session with spaces",
    received_at: 1786892413632,
    payload: {
      request_id: "unsafe/request:id",
      command: "rm -f /private/tmp/审批 canary",
      description: "Allow this command?",
    },
  };

  const first = nativeApprovalID(event, "stored/session");
  const second = nativeApprovalID(structuredClone(event), "stored/session");

  assert.equal(first, second);
  assert.match(first, /^hermes\.native\.approval\.[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(first, /rm -f|private|unsafe|\/|:|\s/);
});

test("Hermes Native approval IDs distinguish separate requests", () => {
  const base = {
    type: "approval.request",
    session_id: "live-1",
    received_at: 1786892413632,
    payload: { command: "echo hello" },
  };

  assert.notEqual(
    nativeApprovalID(base, "stored-1"),
    nativeApprovalID({ ...base, received_at: base.received_at + 1 }, "stored-1"),
  );
  assert.notEqual(
    nativeApprovalID(base, "stored-1"),
    nativeApprovalID(base, "stored-2"),
  );
});
