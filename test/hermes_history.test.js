"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isHermesInternalHistoryRow } = require("../hermes_history");

test("Hermes hides its exact active-model runtime directive", () => {
  assert.equal(isHermesInternalHistoryRow({
    role: "user",
    content: "[System: The active model for this chat has changed to gpt-5.6-sol via provider openai-api. From this point forward, use this runtime metadata when answering questions about what model/provider is active.]",
  }), true);
});

test("Hermes preserves ordinary user messages about model or provider changes", () => {
  assert.equal(isHermesInternalHistoryRow({
    role: "user",
    content: "The active model changed to gpt-5.6-sol. Which provider is active?",
  }), false);
  assert.equal(isHermesInternalHistoryRow({
    role: "assistant",
    content: "[System: The active model for this chat has changed to gpt-5.6-sol via provider openai-api. From this point forward, use this runtime metadata when answering questions about what model/provider is active.]",
  }), false);
});
