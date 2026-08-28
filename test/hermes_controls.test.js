"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const controls = require("../hermes_controls");
const { HermesDesktopController, selectDesktopComposerCandidate } = require("../hermes_cdp");

test("Hermes session subscription replays a Prism-owned run from its start", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /const subscribedRun = activeRunForSession\(subscribedSessionID\)/);
  assert.match(source, /runStartedAtMs - 2000/);
  assert.doesNotMatch(source, /let sinceMs = Date\.now\(\) - 1000;/);
});

test("Hermes model options keep the provider/model pair as one stable target", () => {
  const rows = controls.modelsFromGateway({
    providers: [{
      slug: "openai-api",
      authenticated: true,
      models: ["gpt-5.6-terra"],
    }],
  });

  assert.deepEqual(rows[0].option, {
    key: "openai-api::gpt-5.6-terra",
    value: "openai-api::gpt-5.6-terra",
    label: "gpt-5.6-terra",
    displayName: "gpt-5.6-terra",
    disabled: false,
    provider: "openai-api",
    available: true,
    target: { option_id: "openai-api::gpt-5.6-terra" },
  });
  assert.deepEqual(controls.parseModelOptionID(rows[0].option_id), {
    provider: "openai-api",
    model: "gpt-5.6-terra",
  });
});

test("Hermes controls reject malformed model identities and preserve disabled providers", () => {
  assert.equal(controls.parseModelOptionID("gpt-5.6-terra"), null);
  const rows = controls.modelsFromGateway({
    providers: [{ slug: "missing-auth", authenticated: false, models: ["example"] }],
  });
  assert.equal(rows[0].disabled, true);
  assert.equal(rows[0].option.available, false);
  assert.deepEqual(rows[0].option.target, { option_id: "missing-auth::example" });
});

test("Hermes reasoning projection follows the Gateway's stable effort contract", () => {
  assert.equal(controls.currentReasoningFromConfig({ reasoning_config: { enabled: false } }), "none");
  assert.equal(controls.currentReasoningFromConfig({ reasoning_config: { enabled: true, effort: "high" } }), "high");
  assert.equal(controls.currentReasoningFromConfig({ reasoning_config: { effort: "invalid" } }), "");
  const current = controls.reasoningOptions("medium", true).find((row) => row.current);
  assert.equal(current.key, "medium");
  assert.equal(current.available, true);
  assert.deepEqual(current.target, { option_id: "medium" });
  assert.deepEqual(controls.reasoningOptions("medium", false), []);
});

test("Hermes current runtime comes from the live Gateway session info", () => {
  assert.deepEqual(controls.runtimeInfoFromGatewaySession({
    model: "gpt-5.6-terra",
    provider: "openai-api",
    reasoning_effort: "medium",
  }), {
    model: "gpt-5.6-terra",
    provider: "openai-api",
    reasoning: "medium",
  });
  assert.deepEqual(controls.runtimeInfoFromGatewaySession({
    info: {
      model: "gpt-5.6-terra",
      provider: "openai-api",
      reasoning_effort: "HIGH",
    },
  }), {
    model: "gpt-5.6-terra",
    provider: "openai-api",
    reasoning: "high",
  });
  assert.deepEqual(controls.runtimeInfoFromGatewaySession({
    info: { model: "gpt-5.6-terra", reasoning_effort: "unsupported" },
  }), {
    model: "gpt-5.6-terra",
    provider: "",
    reasoning: "",
  });
});

test("Hermes Native keeps a confirmed model switch ahead of stale active-session state", () => {
  assert.deepEqual(controls.mergeRuntimeControlState(
    { model: "old-model", provider: "old-provider", providers: [] },
    { model: "old-model", provider: "old-provider", reasoning: "medium" },
    { model: "new-model", provider: "new-provider" },
  ), {
    options: { model: "new-model", provider: "new-provider", providers: [] },
    reasoning: "medium",
  });
});

test("Hermes Native keeps a confirmed reasoning switch ahead of stale active-session state", () => {
  assert.deepEqual(controls.mergeRuntimeControlState(
    { model: "current-model", provider: "current-provider" },
    { model: "current-model", provider: "current-provider", reasoning: "low" },
    { reasoning: "high" },
  ), {
    options: { model: "current-model", provider: "current-provider" },
    reasoning: "high",
  });
});

test("Hermes control action and target normalization does not inspect labels", () => {
  assert.equal(controls.normalizeAction("reasoning_switch"), "reasoning.switch");
  assert.equal(controls.optionTarget({ option_id: "high" }), "high");
  assert.equal(controls.optionTarget({ label: "High" }), "");
});

test("Hermes context projection preserves only formal aggregate fields", () => {
  assert.deepEqual(controls.contextFromGateway({
    context_max: 400000,
    context_used: "181085",
    context_percent: 45,
    categories: [{ label: "not a Prism field", tokens: 1 }],
  }), {
    context_window_total: "400000",
    context_tokens_used: "181085",
    context_window_usage_percent: "45",
    context_window: "上下文窗口 400000",
  });
});

test("Hermes context projection rejects missing, estimated, and invalid values", () => {
  assert.deepEqual(controls.contextFromGateway({
    context_max: "400000 tokens",
    context_used: -1,
    context_percent: 101,
  }), {
    context_window_total: "",
    context_tokens_used: "",
    context_window_usage_percent: "",
    context_window: "",
  });
});

test("Hermes refreshes context when the Gateway reports agent readiness or a turn boundary", () => {
  assert.equal(controls.gatewayEventRefreshesContext("session.info"), true);
  assert.equal(controls.gatewayEventRefreshesContext("message.start"), true);
  assert.equal(controls.gatewayEventRefreshesContext("message.complete"), true);
  assert.equal(controls.gatewayEventRefreshesContext("status.update"), false);
  assert.equal(controls.gatewayEventRefreshesContext("context.updated"), false);
});

test("Hermes Desktop pairs a verified live session only with its current route", () => {
  const candidates = [
    { stored: "", live: "old-live" },
    { stored: "", live: "target-live" },
  ];

  assert.deepEqual(
    selectDesktopComposerCandidate("target-stored", "target-stored", "target-live", candidates),
    { stored: "", live: "target-live" },
  );
  assert.deepEqual(
    selectDesktopComposerCandidate("other-stored", "target-stored", "target-live", candidates),
    { stored: "", live: "" },
  );
});

test("Hermes Desktop keeps a healthy current session without changing its route", async () => {
  const controller = new HermesDesktopController();
  const routes = [];
  controller.ensureReady = async () => {};
  controller.desktopIdentity = async () => ({
    stored_session_id: "stored-1",
    live_session_id: "live-1",
  });
  controller.desktopSessionHealth = async () => ({ reachable: true, reason: "" });
  controller.setDesktopRoute = async (route) => { routes.push(route); };

  const selected = await controller.selectDesktopSession("stored-1", 1000);

  assert.deepEqual(selected, { storedSessionID: "stored-1", liveSessionID: "live-1" });
  assert.deepEqual(routes, []);
});

test("Hermes Desktop rebinds the current route when its live session was reaped", async () => {
  const controller = new HermesDesktopController();
  const identities = [
    { stored_session_id: "stored-1", live_session_id: "stale-live" },
    { stored_session_id: "", live_session_id: "" },
    { stored_session_id: "stored-1", live_session_id: "fresh-live" },
  ];
  const routes = [];
  controller.ensureReady = async () => {};
  controller.desktopIdentity = async () => identities.shift()
    || { stored_session_id: "stored-1", live_session_id: "fresh-live" };
  controller.desktopSessionHealth = async () => ({ reachable: false, reason: "session_not_found" });
  controller.setDesktopRoute = async (route) => { routes.push(route); };

  const selected = await controller.selectDesktopSession("stored-1", 1000);

  assert.deepEqual(selected, { storedSessionID: "stored-1", liveSessionID: "fresh-live" });
  assert.deepEqual(routes, ["", "stored-1"]);
});

test("Hermes Desktop create waits for the empty draft before using the native composer", async () => {
  const controller = new HermesDesktopController();
  const identities = [
    { stored_session_id: "new-stored", live_session_id: "new-live" },
  ];
  const operations = [];
  controller.ensureReady = async () => {};
  controller.openDesktopDraft = async () => {
    operations.push("open-new-draft");
    return { fingerprint: "draft-fingerprint-1" };
  };
  controller.desktopIdentity = async () => identities.shift() || { stored_session_id: "new-stored", live_session_id: "new-live" };
  controller.submitDesktopPrompt = async (stored, live, text, paths, _timeout, fingerprint) => {
    operations.push(`submit:${stored}:${live}:${text}:${paths.length}:${fingerprint}`);
    return { outcome: "submitted", storedSessionID: "", liveSessionID: "" };
  };

  const created = await controller.createDesktopSessionWithPrompt("native create", [], 1000);

  assert.deepEqual(created, {
    storedSessionID: "new-stored",
    liveSessionID: "new-live",
    outcome: "submitted",
    queueItemID: "",
  });
  assert.deepEqual(operations, [
    "open-new-draft",
    "submit:::native create:0:draft-fingerprint-1",
  ]);
});

test("Hermes Desktop revalidates an existing mobile draft fingerprint before first submit", async () => {
  const controller = new HermesDesktopController();
  const operations = [];
  controller.ensureReady = async () => {};
  controller.assertDesktopDraft = async (fingerprint) => { operations.push(`assert:${fingerprint}`); };
  controller.desktopIdentity = async () => ({ stored_session_id: "new-stored", live_session_id: "new-live" });
  controller.submitDesktopPrompt = async (stored, live, text, paths, _timeout, fingerprint) => {
    operations.push(`submit:${stored}:${live}:${text}:${paths.length}:${fingerprint}`);
    return { outcome: "submitted", storedSessionID: "", liveSessionID: "" };
  };

  const created = await controller.createDesktopSessionWithPrompt(
    "draft create",
    [],
    1000,
    "draft-fingerprint-2",
  );

  assert.equal(created.storedSessionID, "new-stored");
  assert.deepEqual(operations, [
    "assert:draft-fingerprint-2",
    "submit:::draft create:0:draft-fingerprint-2",
  ]);
});

test("Hermes Desktop Gateway requests stay inside the revalidated renderer", async () => {
  const controller = new HermesDesktopController();
  let source = "";
  controller.ensureReady = async () => {};
  controller.evaluate = async (expression) => {
    source = expression;
    return { ok: true, result: { status: "idle" } };
  };

  const result = await controller.desktopGatewayRequest(
    "stored-1",
    "live-1",
    "session.status",
    { session_id: "live-1" },
    1500,
  );

  assert.deepEqual(result, { status: "idle" });
  assert.match(source, /runtime\.gateway\.request\(method, params, timeout\)/);
  assert.match(source, /desktop_identity_changed/);
  assert.doesNotMatch(source, /getGatewayWsUrl/);
});

test("Hermes Desktop Gateway mutations are accepted without waiting for the native promise", async () => {
  const controller = new HermesDesktopController();
  let source = "";
  controller.ensureReady = async () => {};
  controller.evaluate = async (expression) => {
    source = expression;
    return { ok: true, mutation_id: "desktop-gateway-mutation-1" };
  };

  const result = await controller.desktopGatewayMutation(
    "stored-1",
    "live-1",
    "config.set",
    { session_id: "live-1", key: "reasoning", value: "high" },
  );

  assert.deepEqual(result, { mutationID: "desktop-gateway-mutation-1" });
  assert.match(source, /Promise\.resolve\(runtime\.gateway\.request\(method, params, timeout\)\)\.then/);
  assert.match(source, /status: 'pending'/);
  assert.doesNotMatch(source, /await runtime\.gateway\.request/);
});

test("Hermes Desktop returns the real native queue item identity", async () => {
  const controller = new HermesDesktopController();
  let source = "";
  controller.ensureReady = async () => {};
  controller.evaluate = async (expression) => {
    source = expression;
    return {
      ok: true,
      outcome: "queue_visible",
      queue_item_id: "queue-native-1",
      stored_session_id: "stored-1",
      live_session_id: "live-1",
    };
  };

  const result = await controller.submitDesktopPrompt(
    "stored-1",
    "live-1",
    "queued text",
    ["/tmp/example.txt"],
    1500,
  );

  assert.deepEqual(result, {
    outcome: "queue_visible",
    queueItemID: "queue-native-1",
    storedSessionID: "stored-1",
    liveSessionID: "live-1",
  });
  assert.match(source, /onAttachDroppedItems/);
  assert.match(source, /runtime\.composer\.dispatchEvent\(new Event\('submit'/);
  assert.match(source, /desktop_submit_not_handled/);
  assert.match(source, /gateway\.onEvent/);
  assert.match(source, /hermes\.desktop\.composerQueue\.v1/);
  assert.match(source, /desktop_submit_timeout/);
  assert.match(source, /submitted\.attachments\.length === 0/);
  assert.doesNotMatch(source, /localStorage\.setItem/);
});

test("Hermes Desktop interrupt invokes only the current composer cancel callback", async () => {
  const controller = new HermesDesktopController();
  let source = "";
  controller.ensureReady = async () => {};
  controller.evaluate = async (expression) => {
    source = expression;
    return { ok: true };
  };

  await controller.cancelDesktopRun("stored-1", "live-1");

  assert.match(source, /runtime\.props\.busy !== true/);
  assert.match(source, /runtime\.props\.onCancel\(\)/);
  assert.doesNotMatch(source, /session\.interrupt/);
});

test("Hermes Desktop rename applies only a revalidated native preload action", async () => {
  const controller = new HermesDesktopController();
  let source = "";
  controller.ensureReady = async () => {};
  controller.evaluate = async (expression) => {
    source = expression;
    return { ok: true, result: { title: "renamed" } };
  };

  const result = await controller.renameDesktopSession(
    "stored-1",
    "live-1",
    "hermes.session.rename.session-rename-1",
    "renamed",
  );

  assert.deepEqual(result, { title: "renamed" });
  assert.match(source, /state\.session_actions\.rename_action_id/);
  assert.match(source, /window\.hermesDesktop && window\.hermesDesktop\.api/);
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /encodeURIComponent\(expectedStored\)/);
});

test("Hermes Desktop rename rejects a stale native action", async () => {
  const controller = new HermesDesktopController();
  controller.ensureReady = async () => {};
  controller.evaluate = async () => ({ ok: false, stale: true });

  await assert.rejects(
    controller.renameDesktopSession("stored-1", "live-1", "stale", "renamed"),
    /control_target_stale/,
  );
});

test("Hermes Desktop session actions support current header and collection callback ownership", async () => {
  const controller = new HermesDesktopController();
  let source = "";
  controller.ensureReady = async () => {};
  controller.evaluate = async (expression) => {
    source = expression;
    return true;
  };

  await controller.executeDesktopInteraction("session", "stored-1", "live-1", {
    actionID: "hermes.session.archive.session-archive-1",
  });

  assert.match(source, /props\.sessionId/);
  assert.match(source, /props\.onPin/);
  assert.match(source, /props\.onDelete/);
  assert.match(source, /props\.sessions/);
  assert.match(source, /props\.entries/);
  assert.match(source, /props\.onTogglePin/);
  assert.match(source, /props\.onArchiveSession/);
  assert.match(source, /props\.onDeleteSession/);
  assert.match(source, /collection\[0\]\(\"stored-1\"\)/);
});
