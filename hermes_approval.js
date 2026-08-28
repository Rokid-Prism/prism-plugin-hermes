"use strict";

const crypto = require("crypto");

function firstString(...values) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function nativeApprovalID(event = {}, canonicalSessionID = "") {
  const payload = event && event.payload && typeof event.payload === "object"
    ? event.payload
    : {};
  const identity = JSON.stringify({
    version: 1,
    canonical_session_id: firstString(canonicalSessionID),
    live_session_id: firstString(event.session_id, payload.session_id, payload.live_session_id),
    native_request_id: firstString(payload.request_id, payload.approval_request_id, payload.id),
    received_at: Number(event.received_at || 0),
    command: firstString(payload.command),
    description: firstString(payload.description),
  });
  const digest = crypto.createHash("sha256").update(identity).digest("base64url");
  return `hermes.native.approval.${digest}`;
}

module.exports = { nativeApprovalID };
