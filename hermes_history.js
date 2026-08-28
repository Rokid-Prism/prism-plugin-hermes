"use strict";

const ACTIVE_MODEL_DIRECTIVE = /^\[System: The active model for this chat has changed to [^\]\r\n]+ via provider [^\]\r\n]+\. From this point forward, use this runtime metadata when answering questions about what model\/provider is active\.\]$/;

function isHermesInternalHistoryRow(row) {
  const role = String(row && row.role || "").trim().toLowerCase();
  const content = String(row && row.content || "").trim();
  return role === "user" && ACTIVE_MODEL_DIRECTIVE.test(content);
}

module.exports = {
  isHermesInternalHistoryRow,
};
