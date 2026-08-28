"use strict";

// Hermes' Gateway accepts exactly these reasoning values. They come from
// hermes_constants.parse_reasoning_effort, not from Desktop display text.
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const MODEL_OPTION_SEPARATOR = "::";

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function optionObject(key, label = key, extra = {}) {
  const normalizedKey = firstString(key);
  return {
    key: normalizedKey,
    value: normalizedKey,
    label: firstString(label, normalizedKey),
    displayName: firstString(label, normalizedKey),
    ...extra,
  };
}

function modelOptionID(provider, model) {
  const normalizedProvider = firstString(provider);
  const normalizedModel = firstString(model);
  return normalizedProvider && normalizedModel
    ? `${normalizedProvider}${MODEL_OPTION_SEPARATOR}${normalizedModel}`
    : "";
}

function parseModelOptionID(value) {
  const normalized = firstString(value);
  const separator = normalized.indexOf(MODEL_OPTION_SEPARATOR);
  if (separator <= 0 || separator === normalized.length - MODEL_OPTION_SEPARATOR.length) {
    return null;
  }
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + MODEL_OPTION_SEPARATOR.length).trim();
  return provider && model ? { provider, model } : null;
}

function normalizeAction(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, ".");
}

function optionTarget(target) {
  if (typeof target === "string") return target.trim();
  if (!target || typeof target !== "object" || Array.isArray(target)) return "";
  return firstString(target.option_id, target.key, target.value, target.id);
}

function modelsFromGateway(options) {
  const providers = Array.isArray(options && options.providers) ? options.providers : [];
  const rows = [];
  for (const provider of providers) {
    const slug = firstString(provider && provider.slug);
    const models = Array.isArray(provider && provider.models) ? provider.models : [];
    const unavailable = new Set(Array.isArray(provider && provider.unavailable_models)
      ? provider.unavailable_models.map((value) => firstString(value)).filter(Boolean)
      : []);
    for (const model of models) {
      const normalizedModel = firstString(model);
      const optionID = modelOptionID(slug, normalizedModel);
      if (!optionID) continue;
      const disabled = provider && provider.authenticated !== true || unavailable.has(normalizedModel);
      rows.push({
        provider: slug,
        model: normalizedModel,
        option_id: optionID,
        disabled,
        option: optionObject(optionID, normalizedModel, {
          disabled,
          provider: slug,
          available: !disabled,
          target: { option_id: optionID },
        }),
      });
    }
  }
  return rows;
}

function currentReasoningFromConfig(modelConfig) {
  const config = modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig) ? modelConfig : {};
  const reasoning = config.reasoning_config;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return "";
  if (reasoning.enabled === false) return "none";
  const effort = firstString(reasoning.effort).toLowerCase();
  return REASONING_EFFORTS.includes(effort) ? effort : "";
}

function runtimeInfoFromGatewaySession(session) {
  const source = session && typeof session === "object" && !Array.isArray(session) ? session : {};
  const info = source.info && typeof source.info === "object" && !Array.isArray(source.info)
    ? source.info
    : source;
  const reasoning = firstString(info.reasoning_effort).toLowerCase();
  return {
    model: firstString(info.model),
    provider: firstString(info.provider),
    reasoning: REASONING_EFFORTS.includes(reasoning) ? reasoning : "",
  };
}

function mergeRuntimeControlState(options, runtime, optimistic) {
  const catalog = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const live = runtime && typeof runtime === "object" && !Array.isArray(runtime) ? runtime : {};
  const confirmed = optimistic && typeof optimistic === "object" && !Array.isArray(optimistic)
    ? optimistic
    : {};
  const model = firstString(confirmed.model, live.model, catalog.model);
  const provider = firstString(confirmed.provider, live.provider, catalog.provider);
  return {
    options: {
      ...catalog,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    },
    reasoning: firstString(confirmed.reasoning, live.reasoning),
  };
}

function supportsReasoning(options, provider, model) {
  const providers = Array.isArray(options && options.providers) ? options.providers : [];
  const row = providers.find((candidate) => firstString(candidate && candidate.slug) === firstString(provider));
  const capabilities = row && row.capabilities && typeof row.capabilities === "object" ? row.capabilities : {};
  const capability = capabilities[firstString(model)];
  return Boolean(capability && capability.reasoning === true);
}

function reasoningOptions(current, available) {
  if (!available) return [];
  return REASONING_EFFORTS.map((effort) => optionObject(effort, effort, {
    current: effort === current,
    available: true,
    target: { option_id: effort },
  }));
}

function nonNegativeInteger(value, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) return "";
    return String(value);
  }
  const normalized = firstString(value);
  if (!/^\d+$/.test(normalized)) return "";
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > max) return "";
  return String(parsed);
}

// session.context_breakdown is Hermes' formal per-session context source.
// Do not derive a percentage from token counts: a missing canonical field must
// stay unavailable rather than becoming a Prism estimate.
function contextFromGateway(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const total = nonNegativeInteger(source.context_max);
  const used = nonNegativeInteger(source.context_used);
  const percent = nonNegativeInteger(source.context_percent, 100);
  return {
    context_window_total: total,
    context_tokens_used: used,
    context_window_usage_percent: percent,
    context_window: total ? `上下文窗口 ${total}` : "",
  };
}

function gatewayEventRefreshesContext(eventType) {
  return ["session.info", "message.start", "message.complete"].includes(firstString(eventType));
}

module.exports = {
  REASONING_EFFORTS,
  currentReasoningFromConfig,
  modelOptionID,
  modelsFromGateway,
  normalizeAction,
  optionObject,
  optionTarget,
  parseModelOptionID,
  reasoningOptions,
  mergeRuntimeControlState,
  runtimeInfoFromGatewaySession,
  supportsReasoning,
  contextFromGateway,
  gatewayEventRefreshesContext,
};
