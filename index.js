#!/usr/bin/env node

process.title = process.env.PRISM_PLUGIN_PROCESS_LABEL || "prism-plugin-hermes";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { pathToFileURL } = require("url");
const { createHermesDesktopController, hermesAppPath } = require("./hermes_cdp");
const {
  createGatewayClient,
  sessionRunActive,
  nativeDetailStateEvent,
} = require("./hermes_gateway");
const { createHermesNativeRuntime } = require("./hermes_native");
const { createHermesTuiRelay, launchManagedHermesTui } = require("./hermes_tui_relay");
const { desktopDirectoryRows, nativeDirectoryRows, nativeDirectoryTitle } = require("./hermes_session_directory");
const {
  currentReasoningFromConfig,
  modelOptionID,
  modelsFromGateway,
  mergeRuntimeControlState,
  normalizeAction,
  optionObject,
  optionTarget,
  parseModelOptionID,
  reasoningOptions,
  runtimeInfoFromGatewaySession,
  supportsReasoning,
  contextFromGateway,
  gatewayEventRefreshesContext,
} = require("./hermes_controls");
const { isHermesInternalHistoryRow } = require("./hermes_history");
const { nativeApprovalID } = require("./hermes_approval");

const pluginBridge = require("@rokid-prism/pluginbridge-plugin-sdk");

const execFileAsync = promisify(execFile);

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const SESSION_DB = path.join(HERMES_HOME, "state.db");
const DEFAULT_PROJECT_DIR = path.join(os.homedir(), ".prism", "projects", "default");
const START_STATE_FILE = path.join(os.homedir(), ".prism", "hermes.starts.json");
const SQLITE_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 15000;
const READY_WAIT_TIMEOUT_MS = 10000;
// Hermes Desktop exposes stored/live session identity before its asynchronous
// first prompt has committed to state.db. Keep this bounded, but long enough
// to confirm the native user turn instead of returning a false failed receipt.
const VISIBILITY_WAIT_TIMEOUT_MS = 30000;
const FINAL_RESULT_WAIT_MS = 5 * 60 * 1000;
const FINAL_RESULT_POLL_MS = 400;
const POST_EXIT_FLUSH_WAIT_MS = 5000;
const HISTORY_WATCH_DEBOUNCE_MS = 150;
const HERMES_APP = hermesAppPath();
const HERMES_CONNECTION_MODE = firstNonEmpty(process.env.PRISM_PLUGIN_MODE, "desktop").toLowerCase();

let resolvedHermesBin = "";
const activeRuns = new Map();
const completedRuns = new Map();
const latestRunBySession = new Map();
const canonicalSessionByLiveID = new Map();
const activeSubscriptionsBySessionID = new Map();
const approvalLiveSessionByID = new Map();
const resolvedNativeApprovalByID = new Map();
const desktopApprovalByID = new Map();
const modelOptionsByLiveSession = new Map();
const contextByLiveSession = new Map();
const desktopDrafts = new Map();
const nativeDrafts = new Map();
const localStateChangeListeners = new Set();
const cdpController = createHermesDesktopController();
const APPROVAL_EVENT_LOOKBACK_MS = 15 * 60 * 1000;
const GATEWAY_EVENT_LIMIT = 512;
const MODEL_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_OPTIONS_BACKGROUND_TIMEOUT_MS = 60 * 1000;
const MODEL_OPTIONS_CACHE_LIMIT = 64;
const CONTEXT_CACHE_TTL_MS = 60 * 1000;
const CONTEXT_BACKGROUND_TIMEOUT_MS = 60 * 1000;
const CONTEXT_EMPTY_RETRY_MS = 1500;
const CONTEXT_EMPTY_RETRY_LIMIT = 10;
const DESKTOP_INTERACTION_POLL_MS = 1500;
const DRAFT_TTL_MS = 30 * 60 * 1000;
let desktopIdentityCache = { storedID: "", liveID: "", expiresAt: 0, refreshPromise: null };
const gatewayEvents = [];
let desktopGatewayEventCursor = 0;
let gatewayClient = null;
let gatewayDiscoveryClient = null;
let gatewayConnectionResolver = async () => {
  throw new Error("Hermes private Gateway is available only in native mode");
};

function recordGatewayEvent(event) {
  if (!event || typeof event !== "object") {
    return;
  }
  gatewayEvents.push({ ...event, received_at: Number(event.received_at || 0) || Date.now() });
  if (gatewayEvents.length > GATEWAY_EVENT_LIMIT) {
    gatewayEvents.splice(0, gatewayEvents.length - GATEWAY_EVENT_LIMIT);
  }
  const eventType = firstNonEmpty(event.type);
  const liveID = firstNonEmpty(event.session_id);
  if (liveID && eventType === "session.info") {
    const runtime = runtimeInfoFromGatewaySession(event.payload);
    if (runtime.model || runtime.provider || runtime.reasoning) {
      const cached = modelOptionsByLiveSession.get(liveID);
      const options = cached && cached.options && typeof cached.options === "object"
        ? cached.options
        : {};
      modelOptionsByLiveSession.set(liveID, {
        options: {
          ...options,
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.provider ? { provider: runtime.provider } : {}),
        },
        reasoning: firstNonEmpty(runtime.reasoning, cached && cached.reasoning),
        updatedAt: Number(cached && cached.updatedAt || 0),
        refreshPromise: cached && cached.refreshPromise || null,
        revision: Number(cached && cached.revision || 0) + 1,
        optimistic: runtime,
        refreshAfterCurrent: Boolean(cached && cached.refreshPromise),
      });
      pruneModelOptionsCache();
    }
  }
  if (liveID && gatewayEventRefreshesContext(eventType)) {
    const cached = contextByLiveSession.get(liveID);
    const refreshWasPending = Boolean(cached && cached.refreshPromise);
    if (cached) {
      contextByLiveSession.set(liveID, {
        ...cached,
        updatedAt: 0,
        emptyRetryCount: 0,
      });
    }
    setTimeout(() => {
      const refresh = refreshContext(liveID, canonicalSessionIDForLive(liveID));
      void refresh.catch(() => {});
      if (refreshWasPending) {
        // session.info is Hermes' agent-ready signal. If it races with the
        // initial zero-valued request, issue one more read after that request
        // settles instead of returning the same in-flight promise forever.
        void refresh.catch(() => {}).then(() => {
          const current = contextByLiveSession.get(liveID);
          if (current && !current.refreshPromise
            && Number(current.context && current.context.context_window_total || 0) <= 0) {
            current.updatedAt = 0;
            current.emptyRetryCount = 0;
            void refreshContext(liveID, canonicalSessionIDForLive(liveID)).catch(() => {});
          }
        });
      }
    }, 0);
  }
}

function hermesGateway() {
  if (!gatewayClient) {
    gatewayClient = createGatewayClient({
      // Native mode owns a private Gateway. Desktop mode never reaches this
      // client; it reuses Hermes Desktop's renderer-owned HermesGateway.
      resolveConnection: () => gatewayConnectionResolver(),
      onEvent: recordGatewayEvent,
    });
  }
  return gatewayClient;
}

function hermesDiscoveryGateway() {
  if (!gatewayDiscoveryClient) {
    gatewayDiscoveryClient = createGatewayClient({
      resolveConnection: () => gatewayConnectionResolver(),
    });
  }
  return gatewayDiscoveryClient;
}

function canonicalSessionIDForLive(liveSessionID) {
  const normalized = firstNonEmpty(liveSessionID);
  if (!normalized) {
    return "";
  }
  return firstNonEmpty(canonicalSessionByLiveID.get(normalized), normalized);
}

function retainSessionSubscription(sessionID) {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) {
    return () => {};
  }
  activeSubscriptionsBySessionID.set(
    normalized,
    (activeSubscriptionsBySessionID.get(normalized) || 0) + 1,
  );
  return () => {
    const count = activeSubscriptionsBySessionID.get(normalized) || 0;
    if (count <= 1) {
      activeSubscriptionsBySessionID.delete(normalized);
    } else {
      activeSubscriptionsBySessionID.set(normalized, count - 1);
    }
  };
}

// Hermes documents message/reasoning/status events without session_id as the
// focused turn. Attribute those only when an adapter-owned run targets this
// session, or when it is the sole detail subscription. This matches Hermes
// Desktop without leaking an unscoped event across concurrent conversations.
function canonicalSessionIDForUnscopedEvent(subscribedSessionID, eventType) {
  const normalized = firstNonEmpty(subscribedSessionID);
  if (!normalized || String(eventType || "").startsWith("subagent.")) {
    return "";
  }
  for (const run of activeRuns.values()) {
    if (firstNonEmpty(run && run.canonicalSessionID) === normalized) {
      return normalized;
    }
  }
  const subscribedSessions = Array.from(activeSubscriptionsBySessionID.keys());
  return subscribedSessions.length === 1 && subscribedSessions[0] === normalized
    ? normalized
    : "";
}

async function recentGatewayEvents(sinceMs = 0) {
  if (HERMES_CONNECTION_MODE === "desktop") {
    await syncDesktopGatewayEvents();
  } else {
    const client = hermesGateway();
    await client.ensureReady();
  }
  return gatewayEvents.filter((event) => Number(event.received_at || 0) > Number(sinceMs || 0));
}

async function syncDesktopGatewayEvents() {
  const identity = await cdpController.desktopIdentity();
  const storedID = firstNonEmpty(identity && identity.stored_session_id);
  const liveID = firstNonEmpty(identity && identity.live_session_id);
  if (!storedID || !liveID) return;
  canonicalSessionByLiveID.set(liveID, storedID);
  let update = await cdpController.desktopGatewayEvents(storedID, liveID, desktopGatewayEventCursor);
  if (update.cursor < desktopGatewayEventCursor) {
    desktopGatewayEventCursor = 0;
    update = await cdpController.desktopGatewayEvents(storedID, liveID, 0);
  }
  for (const event of update.events) recordGatewayEvent(event);
  desktopGatewayEventCursor = update.cursor;
}

function nowISO() {
  return new Date().toISOString();
}

function randomID() {
  return crypto.randomUUID();
}

function draftControls() {
  return { interactive_controls: [], actions: [] };
}

function purgeDrafts(drafts) {
  const deadline = Date.now() - DRAFT_TTL_MS;
  for (const [draftID, draft] of drafts.entries()) {
    if (!draft || Number(draft.openedAt || 0) < deadline) drafts.delete(draftID);
  }
}

function activeDraft(drafts, draftID, runtimeName) {
  purgeDrafts(drafts);
  const id = firstNonEmpty(draftID);
  const draft = drafts.get(id);
  if (!draft) throw new Error(`draft_stale: Hermes ${runtimeName} draft is no longer active`);
  return draft;
}

function readStartedSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(START_STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStartedSession(messageID, patch) {
  const starts = readStartedSessions();
  const next = { ...(starts[messageID] || {}), ...patch, updated_at: nowISO() };
  fs.mkdirSync(path.dirname(START_STATE_FILE), { recursive: true });
  fs.writeFileSync(START_STATE_FILE, `${JSON.stringify({ ...starts, [messageID]: next }, null, 2)}\n`, "utf8");
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function attachmentFileName(attachment) {
  const supplied = firstNonEmpty(attachment && attachment.Name);
  const localPath = firstNonEmpty(attachment && attachment.LocalPath);
  const candidate = supplied || path.basename(localPath);
  // Attachment names cross a public history boundary. A filename is enough for
  // the UI and avoids putting a local path or control characters in the body.
  return path.basename(String(candidate || "")).replace(/[\r\n\0]/g, "").trim();
}

function attachmentMIMEType(attachment) {
  return firstNonEmpty(attachment && attachment.MIMEType).toLowerCase();
}

function isImageAttachment(attachment) {
  const mimeType = attachmentMIMEType(attachment);
  if (mimeType.startsWith("image/")) return true;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(attachmentFileName(attachment));
}

function isPDFAttachment(attachment) {
  return attachmentMIMEType(attachment) === "application/pdf" || /\.pdf$/i.test(attachmentFileName(attachment));
}

async function validateAttachment(attachment, index) {
  const name = attachmentFileName(attachment);
  const localPath = firstNonEmpty(attachment && attachment.LocalPath);
  if (!name || !localPath) {
    throw new Error(`hermes attachment ${index + 1} requires a name and local path`);
  }
  let stat;
  try {
    stat = await fs.promises.stat(localPath);
  } catch {
    throw new Error(`hermes attachment ${index + 1} local file is unavailable: ${name}`);
  }
  if (!stat.isFile()) {
    throw new Error(`hermes attachment ${index + 1} is not a regular file: ${name}`);
  }
  return { ...attachment, Name: name, LocalPath: localPath };
}

function attachmentPromptMarker(kind, name) {
  return `[Attached ${kind}: ${name}]`;
}

// Stage all local files before prompt.submit. The Gateway owns the active
// Desktop session, so this must run only after create/resume has yielded a
// live session ID. File refs are deliberately kept inside the native prompt;
// public history sanitizes them back to filenames below.
async function prepareHermesPrompt(gateway, liveSessionID, text, attachments) {
  const normalized = [];
  for (let index = 0; index < attachments.length; index += 1) {
    normalized.push(await validateAttachment(attachments[index], index));
  }
  const additions = [];
  const attachedImagePaths = [];
  try {
    for (const attachment of normalized) {
      const name = attachment.Name;
      if (isImageAttachment(attachment)) {
        const result = await gateway.attachImage(liveSessionID, attachment);
        const imagePath = firstNonEmpty(result && result.path);
        if (imagePath) attachedImagePaths.push(imagePath);
        additions.push(attachmentPromptMarker("image", name));
        continue;
      }
      if (isPDFAttachment(attachment)) {
        try {
          const result = await gateway.attachPDF(liveSessionID, attachment);
          for (const page of Array.isArray(result && result.pages) ? result.pages : []) {
            const imagePath = firstNonEmpty(page && page.path);
            if (imagePath) attachedImagePaths.push(imagePath);
          }
          additions.push(attachmentPromptMarker("PDF", name));
          continue;
        } catch {
          // PDF vision has a lower native size/tooling limit than Prism's
          // 100 MiB attachment contract. Preserve a usable file attachment
          // when page rendering is unavailable instead of rejecting the send.
          const result = await gateway.attachFile(liveSessionID, attachment);
          const refText = firstNonEmpty(result && result.ref_text);
          if (!refText) throw new Error(`Hermes did not return a file reference for ${name}`);
          additions.push(attachmentPromptMarker("file", name), refText);
          continue;
        }
      }
      const result = await gateway.attachFile(liveSessionID, attachment);
      const refText = firstNonEmpty(result && result.ref_text);
      if (!refText) {
        throw new Error(`Hermes did not return a file reference for ${name}`);
      }
      additions.push(attachmentPromptMarker("file", name), refText);
    }
  } catch (error) {
    // image.attach queues inputs for the next prompt. Undo those queues if a
    // later attachment fails so a retry never picks up an abandoned image.
    await Promise.allSettled(attachedImagePaths.map((imagePath) => gateway.detachImage(liveSessionID, imagePath)));
    throw error;
  }
  const normalizedText = String(text || "").trim();
  const submittedText = [normalizedText, ...additions].filter(Boolean).join("\n\n");
  if (!submittedText) {
    throw new Error("hermes send requires text or attachments");
  }
  return {
    submittedText,
    attachments: normalized,
    visibilityMarker: firstNonEmpty(normalizedText, additions[0]),
  };
}

function publicAttachmentName(value) {
  return path.basename(String(value || "").replace(/\\/g, "/")).replace(/[\r\n\0]/g, "").trim();
}

function publicHistoryAttachments(content) {
  const attachments = [];
  const add = (name, mimeType, kind) => {
    const safeName = publicAttachmentName(name);
    if (!safeName || attachments.some((item) => item.name === safeName && item.kind === kind)) return;
    attachments.push({ name: safeName, mime_type: mimeType, kind });
  };
  const text = String(content || "");
  const explicitMarkers = Array.from(text.matchAll(/\[Attached (image|PDF|file): ([^\]\r\n]+)\]/g));
  for (const match of explicitMarkers) {
    const type = String(match[1]).toLowerCase();
    const kind = type === "image" ? "image" : "file";
    const mimeType = type === "image"
      ? "image/*"
      : type === "pdf"
        ? "application/pdf"
        : "application/octet-stream";
    add(match[2], mimeType, kind);
  }
  // Gateway-generated refs point at its staging path. When Prism supplied an
  // explicit marker, it is the authoritative user filename, so do not expose
  // a second internal staging filename in the public metadata.
  if (explicitMarkers.length === 0) {
    for (const match of text.matchAll(/@file:(`([^`]+)`|"([^"]+)"|'([^']+)'|[^\s]+)/g)) {
      add(firstNonEmpty(match[2], match[3], match[4], match[1]), "application/octet-stream", "file");
    }
  }
  return attachments;
}

function publicHistoryContent(content) {
  // Hermes expands @file references before storing a user turn. That expanded
  // block contains local file contents for the agent, not for a remote viewer.
  // Remove it at the Plugin boundary; attachment metadata above preserves the
  // only public detail Prism needs: the original display name.
  const withoutInjectedFileContext = String(content || "").replace(/\n*--- Attached Context ---[\s\S]*$/m, "");
  // The Gateway's non-native image fallback prepends a vision hint containing
  // its temporary local path. It is agent-only context, like @file expansion,
  // and must not become public history.
  const withoutInjectedImageContext = withoutInjectedFileContext.replace(
    /\[The user attached an image[\s\S]*?\n\[You can examine it with vision_analyze using image_url:[^\r\n]*\]\s*/g,
    "",
  );
  return withoutInjectedImageContext
    .replace(/\[Attached (image|PDF|file): [^\]\r\n]+\]\s*/g, "")
    .replace(/@file:(`([^`]+)`|"([^"]+)"|'([^']+)'|[^\s]+)/g, (match, raw, backtick, doubleQuoted, singleQuoted) => {
      const name = publicAttachmentName(firstNonEmpty(backtick, doubleQuoted, singleQuoted, raw));
      return name ? `@file:${name}` : match;
    });
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function epochSecondsToISO(value) {
  const seconds = asNumber(value);
  if (seconds <= 0) {
    return nowISO();
  }
  return new Date(seconds * 1000).toISOString();
}

function escapeSQLite(value) {
  return String(value || "").replace(/'/g, "''");
}

function sessionEndpoint(sessionID) {
  return sessionID ? `hermes://sessions/${sessionID}` : "Hermes Desktop gateway";
}

function normalizeCwd(value) {
  const cwd = firstNonEmpty(value, DEFAULT_PROJECT_DIR);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveHermesBin() {
  if (resolvedHermesBin) {
    return resolvedHermesBin;
  }
  const candidates = [
    firstNonEmpty(process.env.HERMES_BIN),
    path.join(os.homedir(), ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      resolvedHermesBin = candidate;
      return resolvedHermesBin;
    }
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["hermes"], {
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    const found = firstNonEmpty(stdout);
    if (found) {
      resolvedHermesBin = found;
      return resolvedHermesBin;
    }
  } catch {
    // Ignore resolution failure; probe will report unavailable.
  }
  return "";
}

async function hermesDesktopAvailable() {
  const bin = await resolveHermesBin();
  if (!(Boolean(bin) || fs.existsSync(HERMES_APP) || fs.existsSync(hermesAppPath())) || !fs.existsSync(SESSION_DB)) {
    return false;
  }
  try {
    // An empty sidebar is valid. Reaching the renderer is what distinguishes
    // an actual Desktop runtime from stale state.db/CLI history.
    await cdpController.desktopSessionDirectoryIDs();
    return true;
  } catch {
    return false;
  }
}

async function queryJSON(sql) {
  if (!fs.existsSync(SESSION_DB)) {
    return [];
  }
  const databaseURI = (immutable = false) => {
    const suffix = immutable ? "?mode=ro&immutable=1" : "?mode=ro";
    return `${pathToFileURL(SESSION_DB).href}${suffix}`;
  };
  const runQuery = (immutable) => execFileAsync(
    "/usr/bin/sqlite3",
    ["-readonly", "-cmd", `.timeout ${SQLITE_TIMEOUT_MS}`, "-json", databaseURI(immutable), sql],
    {
      timeout: QUERY_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  let stdout;
  try {
    ({ stdout } = await runQuery(false));
  } catch (error) {
    // Some macOS Hermes builds temporarily reject even read-only SQLite opens
    // while replacing their journal. The immutable fallback never writes or
    // takes a lock. It is only used for that CANTOPEN case: normal read-only
    // mode remains first so WAL-backed profiles retain their latest frames.
    if (!/unable to open database file \(14\)/i.test(String(error && error.message || error))) {
      throw error;
    }
    ({ stdout } = await runQuery(true));
  }
  const raw = String(stdout || "").trim();
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function queryOne(sql) {
  const rows = await queryJSON(sql);
  return rows.length ? rows[0] : null;
}

async function listSessionRows(limit = 50) {
  const sql = `
    WITH RECURSIVE ancestry(session_id, ancestor_id, parent_session_id) AS (
      SELECT id, id, parent_session_id FROM sessions
      UNION ALL
      SELECT ancestry.session_id, parent.id, parent.parent_session_id
      FROM ancestry JOIN sessions parent ON ancestry.parent_session_id = parent.id
    ), roots AS (
      SELECT session_id, ancestor_id AS lineage_root_id
      FROM ancestry WHERE parent_session_id IS NULL
    )
    SELECT
      s.id AS id,
      COALESCE(
        NULLIF(s.title, ''),
        (
          SELECT substr(trim(COALESCE(m.content, '')), 1, 160)
          FROM messages m
          WHERE m.session_id = s.id
            AND lower(COALESCE(m.role, '')) = 'user'
            AND trim(COALESCE(m.content, '')) != ''
          ORDER BY m.timestamp ASC, m.id ASC
          LIMIT 1
        ),
        ''
      ) AS title,
      COALESCE(s.cwd, '') AS cwd,
      COALESCE(s.source, '') AS source,
      COALESCE(roots.lineage_root_id, s.id) AS lineage_root_id,
      COALESCE(s.archived, 0) AS archived,
      COALESCE(s.message_count, 0) AS message_count,
      COALESCE(s.started_at, 0) AS started_at,
      COALESCE(s.ended_at, 0) AS ended_at,
      COALESCE(
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id),
        s.started_at,
        0
      ) AS last_activity
    FROM sessions s
    LEFT JOIN roots ON roots.session_id = s.id
    WHERE COALESCE(s.archived, 0) = 0
      AND COALESCE(s.source, '') != 'tool'
      AND json_extract(COALESCE(s.model_config, '{}'), '$._delegate_from') IS NULL
    ORDER BY last_activity DESC
    ${Number(limit) > 0 ? `LIMIT ${Math.max(1, Number(limit))}` : ""};
  `;
  return queryJSON(sql);
}

async function findSessionByID(sessionID) {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) {
    return null;
  }
  const sql = `
    WITH RECURSIVE ancestry(session_id, ancestor_id, parent_session_id) AS (
      SELECT id, id, parent_session_id FROM sessions
      UNION ALL
      SELECT ancestry.session_id, parent.id, parent.parent_session_id
      FROM ancestry JOIN sessions parent ON ancestry.parent_session_id = parent.id
    ), roots AS (
      SELECT session_id, ancestor_id AS lineage_root_id
      FROM ancestry WHERE parent_session_id IS NULL
    )
    SELECT
      s.id AS id,
      COALESCE(
        NULLIF(s.title, ''),
        (
          SELECT substr(trim(COALESCE(m.content, '')), 1, 160)
          FROM messages m
          WHERE m.session_id = s.id
            AND lower(COALESCE(m.role, '')) = 'user'
            AND trim(COALESCE(m.content, '')) != ''
          ORDER BY m.timestamp ASC, m.id ASC
          LIMIT 1
        ),
        ''
      ) AS title,
      COALESCE(s.cwd, '') AS cwd,
      COALESCE(s.source, '') AS source,
      COALESCE(roots.lineage_root_id, s.id) AS lineage_root_id,
      COALESCE(s.archived, 0) AS archived,
      COALESCE(s.message_count, 0) AS message_count,
      COALESCE(s.started_at, 0) AS started_at,
      COALESCE(s.ended_at, 0) AS ended_at,
      COALESCE(
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id),
        s.started_at,
        0
      ) AS last_activity
    FROM sessions s
    LEFT JOIN roots ON roots.session_id = s.id
    WHERE s.id = '${escapeSQLite(normalized)}'
    LIMIT 1;
  `;
  return queryOne(sql);
}

async function readSessionControlState(sessionID) {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) {
    return { model: "", provider: "", reasoning: "" };
  }
  const row = await queryOne(`
    SELECT
      COALESCE(s.model, '') AS model,
      COALESCE(s.model_config, '') AS model_config,
      COALESCE(s.billing_provider, '') AS provider
    FROM sessions s
    WHERE s.id = '${escapeSQLite(normalized)}'
    LIMIT 1;
  `);
  let modelConfig = {};
  try {
    const parsed = JSON.parse(firstNonEmpty(row && row.model_config, "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      modelConfig = parsed;
    }
  } catch {
    // A malformed historical config cannot manufacture a control target.
  }
  return {
    model: firstNonEmpty(row && row.model),
    provider: firstNonEmpty(row && row.provider),
    reasoning: currentReasoningFromConfig(modelConfig),
  };
}

function liveSessionID(row) {
  return firstNonEmpty(row && row.session_id, row && row.id, row && row.live_session_id);
}

function storedSessionID(row) {
  return firstNonEmpty(row && row.session_key, row && row.stored_session_id);
}

function pruneModelOptionsCache() {
  if (modelOptionsByLiveSession.size <= MODEL_OPTIONS_CACHE_LIMIT) return;
  const oldest = Array.from(modelOptionsByLiveSession.entries())
    .sort((a, b) => Number(a[1].updatedAt || 0) - Number(b[1].updatedAt || 0));
  for (const [liveID] of oldest.slice(0, modelOptionsByLiveSession.size - MODEL_OPTIONS_CACHE_LIMIT)) {
    modelOptionsByLiveSession.delete(liveID);
  }
}

function refreshModelOptions(liveID, storedID = "") {
  const cached = modelOptionsByLiveSession.get(liveID);
  if (cached && cached.refreshPromise) return cached.refreshPromise;
  const revision = Number(cached && cached.revision || 0);
  const canonicalID = firstNonEmpty(storedID, canonicalSessionIDForLive(liveID));
  const request = HERMES_CONNECTION_MODE === "desktop"
    ? cdpController.desktopGatewayRequest(
      canonicalID,
      liveID,
      "model.options",
      { session_id: liveID },
      MODEL_OPTIONS_BACKGROUND_TIMEOUT_MS,
    )
    : hermesDiscoveryGateway().modelOptions(liveID, MODEL_OPTIONS_BACKGROUND_TIMEOUT_MS);
  const refreshPromise = request
    .then((value) => {
      const received = value && typeof value === "object" ? value : {};
      const current = modelOptionsByLiveSession.get(liveID);
      const changedDuringRequest = Number(current && current.revision || 0) !== revision;
      const optimistic = changedDuringRequest && current && current.optimistic;
      const options = optimistic && optimistic.model
        ? { ...received, model: optimistic.model, provider: optimistic.provider }
        : received;
      // model.options is the native picker's authoritative catalog. Reasoning
      // is session state, so retain a just-applied optimistic effort until the
      // durable mirror has caught up.
      modelOptionsByLiveSession.set(liveID, {
        options,
        reasoning: firstNonEmpty(optimistic && optimistic.reasoning, current && current.reasoning),
        updatedAt: Date.now(),
        refreshPromise: null,
        revision: Number(current && current.revision || revision),
        optimistic: optimistic || null,
      });
      recordGatewayEvent({
        type: "controls.updated",
        session_id: liveID,
        payload: {},
      });
      pruneModelOptionsCache();
      if (current && current.refreshAfterCurrent === true) {
        const settled = modelOptionsByLiveSession.get(liveID);
        if (settled) settled.refreshAfterCurrent = false;
        // A write raced an existing catalog read. Start a new read after that
        // stale result has settled; never make the user wait for either one.
        void refreshModelOptions(liveID, canonicalID).catch(() => {});
      }
      return options;
    })
    .catch(() => {
      const current = modelOptionsByLiveSession.get(liveID);
      if (current) current.refreshPromise = null;
      throw new Error("Hermes model options refresh failed");
    });
  modelOptionsByLiveSession.set(liveID, {
    options: cached && cached.options && typeof cached.options === "object" ? cached.options : {},
    reasoning: firstNonEmpty(cached && cached.reasoning),
    updatedAt: Number(cached && cached.updatedAt || 0),
    refreshPromise,
    revision,
    optimistic: cached && cached.optimistic || null,
    refreshAfterCurrent: false,
  });
  return refreshPromise;
}

async function modelOptionsForDetail(liveID, storedID = "") {
  const cached = modelOptionsByLiveSession.get(liveID);
  if (!cached || Date.now() - Number(cached.updatedAt || 0) >= MODEL_OPTIONS_CACHE_TTL_MS) {
    // Model picker discovery includes provider pricing/capabilities. Detail
    // reads use the latest verified result and refresh without delaying UI.
    void refreshModelOptions(liveID, storedID).catch(() => {});
  }
  return cached && cached.options && typeof cached.options === "object" ? cached.options : {};
}

function refreshContext(liveID, storedID = "") {
  const cached = contextByLiveSession.get(liveID);
  if (cached && cached.refreshPromise) return cached.refreshPromise;
  // Hermes binds context accounting to the asynchronously built live agent.
  // Keep this on the event-bearing client so session.info can deterministically
  // trigger the first non-empty read when that agent becomes ready.
  const canonicalID = firstNonEmpty(storedID, canonicalSessionIDForLive(liveID));
  const request = HERMES_CONNECTION_MODE === "desktop"
    ? cdpController.desktopGatewayRequest(
      canonicalID,
      liveID,
      "session.context_breakdown",
      { session_id: liveID },
      CONTEXT_BACKGROUND_TIMEOUT_MS,
    )
    : hermesGateway().sessionContextBreakdown(liveID, CONTEXT_BACKGROUND_TIMEOUT_MS);
  const refreshPromise = request.then((value) => {
    const context = contextFromGateway(value);
    const empty = Number(context.context_window_total || 0) <= 0;
    const emptyRetryCount = empty ? Number(cached && cached.emptyRetryCount || 0) + 1 : 0;
    contextByLiveSession.set(liveID, {
      context,
      updatedAt: Date.now(),
      refreshPromise: null,
      emptyRetryCount,
    });
    if (empty && emptyRetryCount <= CONTEXT_EMPTY_RETRY_LIMIT) {
      setTimeout(() => {
        const current = contextByLiveSession.get(liveID);
        if (current && current.emptyRetryCount === emptyRetryCount && !current.refreshPromise) {
          void refreshContext(liveID, canonicalID).catch(() => {});
        }
      }, CONTEXT_EMPTY_RETRY_MS);
    } else if (!empty) {
      recordGatewayEvent({
        type: "context.updated",
        session_id: liveID,
        payload: {},
      });
    }
    if (contextByLiveSession.size > MODEL_OPTIONS_CACHE_LIMIT) {
      const oldest = Array.from(contextByLiveSession.entries())
        .sort((a, b) => Number(a[1].updatedAt || 0) - Number(b[1].updatedAt || 0));
      for (const [id] of oldest.slice(0, contextByLiveSession.size - MODEL_OPTIONS_CACHE_LIMIT)) {
        contextByLiveSession.delete(id);
      }
    }
    return context;
  }).catch((error) => {
    const current = contextByLiveSession.get(liveID);
    if (current) current.refreshPromise = null;
    const message = firstNonEmpty(error && error.message, "unknown error");
    console.error(`Hermes context refresh failed: ${message}`);
    throw new Error("Hermes context refresh failed");
  });
  contextByLiveSession.set(liveID, {
    context: cached && cached.context || contextFromGateway(null),
    updatedAt: Number(cached && cached.updatedAt || 0),
    emptyRetryCount: Number(cached && cached.emptyRetryCount || 0),
    refreshPromise,
  });
  return refreshPromise;
}

function contextForDetail(liveID, storedID = "") {
  const cached = contextByLiveSession.get(liveID);
  if (!cached || Date.now() - Number(cached.updatedAt || 0) >= CONTEXT_CACHE_TTL_MS) {
    void refreshContext(liveID, storedID).catch(() => {});
  }
  return cached && cached.context || contextFromGateway(null);
}

async function readDesktopLiveControlState(sessionID, { includeContext = false } = {}) {
  const canonicalID = firstNonEmpty(sessionID);
  if (!canonicalID) return null;
  const interactions = await readDesktopInteractionProjection(canonicalID);
  if (!interactions.foreground || !interactions.live_session_id) return null;
  const liveID = interactions.live_session_id;
  canonicalSessionByLiveID.set(liveID, canonicalID);
  const options = await modelOptionsForDetail(liveID, canonicalID);
  const runtime = {
    model: firstNonEmpty(interactions.composer && interactions.composer.model),
    provider: firstNonEmpty(interactions.composer && interactions.composer.provider),
    reasoning: "",
  };
  const cached = modelOptionsByLiveSession.get(liveID);
  const effective = mergeRuntimeControlState(options, runtime, cached && cached.optimistic);
  return {
    storedID: canonicalID,
    liveID,
    controlsLocked: Boolean(interactions.composer && (
      interactions.composer.busy === true || interactions.composer.disabled === true
    )),
    options: effective.options,
    reasoning: firstNonEmpty(effective.reasoning, cached && cached.reasoning),
    context: includeContext ? contextForDetail(liveID, canonicalID) : contextFromGateway(null),
  };
}

// Native Gateway live ids are process-local. Resolve them only from active_list
// and never manufacture a live identity from durable SQLite state.
async function readNativeLiveControlState(sessionID, { includeContext = false } = {}) {
  const canonicalID = firstNonEmpty(sessionID);
  if (!canonicalID) return null;
  const gateway = hermesGateway();
  await gateway.ensureReady();
  const matches = (await gateway.activeSessions()).filter((item) => (
    storedSessionID(item) === canonicalID && Boolean(liveSessionID(item))
  ));
  if (matches.length !== 1) return null;
  const active = matches[0];
  const liveID = liveSessionID(active);
  const options = await modelOptionsForDetail(liveID, canonicalID);
  const runtime = runtimeInfoFromGatewaySession(active);
  const context = includeContext ? contextForDetail(liveID, canonicalID) : contextFromGateway(null);
  const cached = modelOptionsByLiveSession.get(liveID);
  const effective = mergeRuntimeControlState(options, runtime, cached && cached.optimistic);
  canonicalSessionByLiveID.set(liveID, canonicalID);
  const status = firstNonEmpty(active && active.status).toLowerCase();
  return {
    liveID,
    controlsLocked: Boolean(active && active.running === true)
      || ["starting", "waiting", "working", "running"].includes(status),
    options: effective.options,
    reasoning: firstNonEmpty(effective.reasoning, cached && cached.reasoning),
    context,
  };
}

async function readLiveControlState(sessionID, options = {}) {
  return HERMES_CONNECTION_MODE === "desktop"
    ? readDesktopLiveControlState(sessionID, options)
    : readNativeLiveControlState(sessionID, options);
}

// `activeRuns` contains only turns started by Prism. Desktop-originated and
// native-composer turns remain visible through Gateway active_list, which is
// read-only and does not take the Desktop event transport.
async function readGatewayRunState(sessionID) {
  const canonicalID = firstNonEmpty(sessionID);
  if (!canonicalID) return null;
  if (HERMES_CONNECTION_MODE === "desktop") {
    const interactions = await readDesktopInteractionProjection(canonicalID);
    if (!interactions.foreground || !interactions.live_session_id) return null;
    const running = Boolean(interactions.composer && interactions.composer.busy === true);
    return {
      liveID: interactions.live_session_id,
      running,
      status: running ? "running" : "idle",
      preview: "",
    };
  }
  try {
    const gateway = hermesGateway();
    await gateway.ensureReady();
    const matches = (await gateway.activeSessions()).filter((item) => (
      storedSessionID(item) === canonicalID && Boolean(liveSessionID(item))
    ));
    if (matches.length !== 1) return null;
    const active = matches[0];
    const running = sessionRunActive(active);
    return {
      liveID: liveSessionID(active),
      running,
      status: running ? "running" : "idle",
      preview: firstNonEmpty(active && active.preview),
    };
  } catch {
    return null;
  }
}

function controlProjection(stored, live) {
  const options = live && live.options && typeof live.options === "object" ? live.options : {};
  const model = firstNonEmpty(options.model, stored && stored.model);
  const provider = firstNonEmpty(options.provider, stored && stored.provider);
  const modelKey = modelOptionID(provider, model);
  const reasoningEnabled = Boolean(live && supportsReasoning(options, provider, model));
  const reasoning = firstNonEmpty(live && live.reasoning, stored && stored.reasoning);
  return {
    live_session_id: live ? live.liveID : "",
    controls_locked: Boolean(live && live.controlsLocked),
    model: modelKey ? optionObject(modelKey, model) : null,
    reasoning: reasoning ? optionObject(reasoning, reasoning) : null,
    model_options: live ? modelsFromGateway(options).map((row) => row.option) : [],
    reasoning_options: reasoningOptions(reasoning, reasoningEnabled),
    context: live && live.context ? live.context : contextFromGateway(null),
  };
}

async function readControlProjection(sessionID) {
  const stored = await readSessionControlState(sessionID);
  try {
    return controlProjection(stored, await readLiveControlState(sessionID, { includeContext: true }));
  } catch {
    // Durable values remain useful context, but options are only published when
    // the native session is still live and has a verified Gateway identity.
    return controlProjection(stored, null);
  }
}

async function readDesktopInteractionProjection(sessionID, liveSessionID = "") {
  const canonicalID = firstNonEmpty(sessionID);
  const liveID = firstNonEmpty(liveSessionID);
  if (!canonicalID) {
    return { foreground: false, live_session_id: "", queue: null, approval: null, composer: null, session_actions: null };
  }
  try {
    const state = await cdpController.desktopInteractions(canonicalID, liveID);
    if (!state || state.scoped !== true
      || firstNonEmpty(state.selected_stored_session_id) !== canonicalID
      || !firstNonEmpty(state.active_live_session_id)
      || (liveID && firstNonEmpty(state.active_live_session_id) !== liveID)) {
      return { foreground: false, live_session_id: "", queue: null, approval: null, composer: null, session_actions: null };
    }
    const activeLiveID = firstNonEmpty(state.active_live_session_id);
    const approval = state.approval && typeof state.approval === "object" ? state.approval : null;
    const approvalID = firstNonEmpty(approval && approval.approval_request_id);
    if (approvalID) {
      desktopApprovalByID.set(approvalID, { canonicalID, liveID: activeLiveID });
    }
    return {
      foreground: true,
      live_session_id: activeLiveID,
      queue: state.queue && typeof state.queue === "object" ? state.queue : null,
      approval,
      composer: state.composer && typeof state.composer === "object" ? state.composer : null,
      session_actions: state.session_actions && typeof state.session_actions === "object" ? state.session_actions : null,
    };
  } catch {
    return { foreground: false, live_session_id: "", queue: null, approval: null, composer: null, session_actions: null };
  }
}

async function currentDesktopIdentity() {
  const now = Date.now();
  if (desktopIdentityCache.expiresAt > now) {
    return { storedID: desktopIdentityCache.storedID, liveID: desktopIdentityCache.liveID };
  }
  if (!desktopIdentityCache.refreshPromise) {
    desktopIdentityCache.refreshPromise = cdpController.desktopIdentity()
      .then((state) => {
        desktopIdentityCache = {
          storedID: firstNonEmpty(state && state.stored_session_id),
          liveID: firstNonEmpty(state && state.live_session_id),
          expiresAt: Date.now() + DESKTOP_INTERACTION_POLL_MS,
          refreshPromise: null,
        };
        return desktopIdentityCache;
      })
      .catch(() => {
        desktopIdentityCache = { storedID: "", liveID: "", expiresAt: Date.now() + DESKTOP_INTERACTION_POLL_MS, refreshPromise: null };
        return desktopIdentityCache;
      });
  }
  const state = await desktopIdentityCache.refreshPromise;
  return { storedID: state.storedID, liveID: state.liveID };
}

async function latestPrismSession(startedAfterMs, cwd = "") {
  const normalized = firstNonEmpty(cwd);
  const startedAfterSeconds = Math.max(0, Math.floor((asNumber(startedAfterMs) - 2000) / 1000));
  const sql = `
    SELECT
      s.id AS id,
      COALESCE(
        NULLIF(s.title, ''),
        (
          SELECT substr(trim(COALESCE(m.content, '')), 1, 160)
          FROM messages m
          WHERE m.session_id = s.id
            AND lower(COALESCE(m.role, '')) = 'user'
            AND trim(COALESCE(m.content, '')) != ''
          ORDER BY m.timestamp ASC, m.id ASC
          LIMIT 1
        ),
        ''
      ) AS title,
      COALESCE(s.cwd, '') AS cwd,
      COALESCE(s.source, '') AS source,
      COALESCE(s.message_count, 0) AS message_count,
      COALESCE(s.started_at, 0) AS started_at,
      COALESCE(
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id),
        s.started_at,
        0
      ) AS last_activity
    FROM sessions s
    WHERE COALESCE(s.archived, 0) = 0
      AND COALESCE(s.source, '') = 'prism'
      AND COALESCE(s.started_at, 0) >= ${startedAfterSeconds}
    ORDER BY last_activity DESC
    LIMIT 10;
  `;
  const rows = await queryJSON(sql);
  if (!rows.length) {
    return null;
  }
  if (!normalized) {
    return rows[0];
  }
  const exact = rows.find((row) => firstNonEmpty(row.cwd) === normalized);
  return exact || rows[0];
}

async function maxMessageID(sessionID) {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) {
    return 0;
  }
  const row = await queryOne(`
    SELECT COALESCE(MAX(id), 0) AS max_id
    FROM messages
    WHERE session_id = '${escapeSQLite(normalized)}';
  `);
  return row ? asNumber(row.max_id) : 0;
}

async function readMessagesAfter(sessionID, afterID) {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) {
    return [];
  }
  const sql = `
    SELECT
      id,
      COALESCE(role, '') AS role,
      COALESCE(content, '') AS content,
      COALESCE(finish_reason, '') AS finish_reason,
      COALESCE(timestamp, 0) AS timestamp
    FROM messages
    WHERE session_id = '${escapeSQLite(normalized)}'
      AND id > ${Math.max(0, asNumber(afterID))}
    ORDER BY id ASC;
  `;
  return queryJSON(sql);
}

async function messageContainsMarker(sessionID, marker) {
  const normalizedSessionID = firstNonEmpty(sessionID);
  const normalizedMarker = String(marker || "");
  if (!normalizedSessionID || !normalizedMarker) {
    return false;
  }
  const row = await queryOne(`
    SELECT COUNT(1) AS count
    FROM messages
    WHERE session_id = '${escapeSQLite(normalizedSessionID)}'
      AND COALESCE(content, '') LIKE '%${escapeSQLite(normalizedMarker)}%';
  `);
  return row ? asNumber(row.count) > 0 : false;
}

async function userMessageDelivered(sessionID, text, startedAtMs, marker = "") {
  const normalizedSessionID = firstNonEmpty(sessionID);
  const normalizedText = String(text || "");
  const normalizedMarker = firstNonEmpty(marker);
  if (!normalizedSessionID || (!normalizedText && !normalizedMarker)) {
    return false;
  }
  const startedAfterSeconds = Math.max(0, (asNumber(startedAtMs) - 2000) / 1000);
  const exact = await queryOne(`
    SELECT COUNT(1) AS count
    FROM messages
    WHERE session_id = '${escapeSQLite(normalizedSessionID)}'
      AND COALESCE(role, '') = 'user'
      AND COALESCE(content, '') = '${escapeSQLite(normalizedText)}'
      AND COALESCE(timestamp, 0) >= ${startedAfterSeconds};
  `);
  if (exact && asNumber(exact.count) > 0) return true;
  if (!normalizedMarker) return false;
  const marked = await queryOne(`
    SELECT COUNT(1) AS count
    FROM messages
    WHERE session_id = '${escapeSQLite(normalizedSessionID)}'
      AND COALESCE(role, '') = 'user'
      AND instr(COALESCE(content, ''), '${escapeSQLite(normalizedMarker)}') > 0
      AND COALESCE(timestamp, 0) >= ${startedAfterSeconds};
  `);
  return marked ? asNumber(marked.count) > 0 : false;
}

function parseHermesOutput(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  let sessionID = "";
  const content = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^session_id:\s*(\S+)$/i);
    if (match) {
      sessionID = firstNonEmpty(match[1]);
      continue;
    }
    if (trimmed.startsWith("↻ Resumed session ")) {
      continue;
    }
    if (!trimmed && content.length === 0) {
      continue;
    }
    content.push(line);
  }
  return {
    sessionID,
    summary: content.join("\n").trim(),
  };
}

function latestAssistantSummary(rows) {
  let summary = "";
  for (const row of rows) {
    if (firstNonEmpty(row && row.role) === "assistant" && firstNonEmpty(row && row.content)) {
      summary = String(row.content).trim();
    }
  }
  return summary;
}

async function readHistory(session, limit) {
  const sessionID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  if (!sessionID) {
    throw new Error("hermes readHistory requires a resolved Hermes session id");
  }
  const innerLimit = limit > 0 ? `LIMIT ${Math.max(1, Number(limit) || 0)}` : "";
  const rows = await queryJSON(`
    SELECT * FROM (
      SELECT
        id,
        COALESCE(role, '') AS role,
        COALESCE(content, '') AS content,
        COALESCE(finish_reason, '') AS finish_reason,
        COALESCE(timestamp, 0) AS timestamp
      FROM messages
      WHERE session_id = '${escapeSQLite(sessionID)}'
      ORDER BY id DESC
      ${innerLimit}
    )
    ORDER BY id ASC;
  `);
  return rows.filter((row) => !isHermesInternalHistoryRow(row)).map((row) => {
    const createdAt = epochSecondsToISO(row.timestamp);
    const attachments = publicHistoryAttachments(row.content);
    return {
      ID: firstNonEmpty(String(row.id || "")),
      Role: firstNonEmpty(row.role, "assistant").toLowerCase(),
      Type: "text",
      Content: publicHistoryContent(firstNonEmpty(row.content)),
      Status: firstNonEmpty(row.finish_reason),
      CreatedAt: createdAt,
      UpdatedAt: createdAt,
      Metadata: {
        session_id: sessionID,
        ...(attachments.length ? { attachments } : {}),
      },
    };
  });
}

// Detail reads are deliberately non-interactive. Explicit Desktop selection is
// exposed separately through selectSession so stream refreshes cannot steal
// focus from a user working in another Hermes conversation. For the selected
// session, use the same CDP projection as the wide watcher so an online detail
// query cannot overwrite a verified foreground snapshot with stale detail.
async function readDetail(session) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  if (!sessionID) {
    throw new Error("hermes readDetail requires a resolved Hermes session id");
  }
  const row = await findSessionByID(sessionID);
  if (!row || asNumber(row.archived) === 1) {
    throw new Error("hermes session not found");
  }
  return (await describeControls(toSession(sessionID, row.cwd, row.title))).details;
}

async function selectSession(session) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  if (!sessionID) throw new Error("hermes selectSession requires a resolved Hermes session id");
  const row = await findSessionByID(sessionID);
  if (!row || asNumber(row.archived) === 1) throw new Error("hermes session not found");
  const selected = await cdpController.selectDesktopSession(sessionID, 10000);
  if (selected.liveSessionID) canonicalSessionByLiveID.set(selected.liveSessionID, sessionID);
  // A successful native route switch invalidates the short read cache. Without
  // this, the immediate detail refresh can compare the new session against the
  // previous Desktop identity and falsely report it as non-current.
  desktopIdentityCache = { storedID: "", liveID: "", expiresAt: 0, refreshPromise: null };
  return toSession(sessionID, row.cwd, row.title);
}

function historyMessageFromRow(sessionID, row) {
  const createdAt = epochSecondsToISO(row.timestamp);
  const attachments = publicHistoryAttachments(row.content);
  return {
    ID: `hermes:${sessionID}:message:${row.id}`,
    Role: firstNonEmpty(row.role, "assistant").toLowerCase(),
    Type: "text",
    Content: publicHistoryContent(firstNonEmpty(row.content)),
    Status: firstNonEmpty(row.finish_reason),
    CreatedAt: createdAt,
    UpdatedAt: createdAt,
    ...(attachments.length ? { Metadata: { attachments } } : {}),
  };
}

async function historyRows(sessionID, limit) {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) return [];
  const innerLimit = limit > 0 ? `LIMIT ${Math.max(1, Number(limit) || 0) * 8}` : "";
  return queryJSON(`
    SELECT * FROM (
      SELECT
        id,
        COALESCE(role, '') AS role,
        COALESCE(content, '') AS content,
        COALESCE(finish_reason, '') AS finish_reason,
        COALESCE(timestamp, 0) AS timestamp
      FROM messages
      WHERE session_id = '${escapeSQLite(normalized)}'
        AND LOWER(COALESCE(role, '')) IN ('user', 'assistant')
      ORDER BY id DESC
      ${innerLimit}
    )
    ORDER BY id ASC;
  `);
}

// The public body wire is built from user/assistant pairs. Hermes also stores
// internal system and tool rows in this table; emitting those directly would
// make Mobile and Panel Hermes-specific, so they remain native-only here.
function historyTurnsFromRows(sessionID, rows, limit) {
  const turns = [];
  let current = null;
  for (const row of rows) {
    if (isHermesInternalHistoryRow(row)) continue;
    const role = firstNonEmpty(row && row.role).toLowerCase();
    if (role === "user") {
      if (current) turns.push(current);
      current = {
        turn_id: `hermes:${sessionID}:turn:${row.id}`,
        order_key: `${String(Math.floor(asNumber(row.timestamp) * 1000)).padStart(16, "0")}:${String(row.id).padStart(12, "0")}`,
        messages: [historyMessageFromRow(sessionID, row)],
      };
      continue;
    }
    if (role === "assistant" && current) {
      current.messages.push(historyMessageFromRow(sessionID, row));
    }
  }
  if (current) turns.push(current);
  const bounded = limit > 0 ? turns.slice(-Math.max(1, Number(limit) || 1)) : turns;
  return bounded;
}

function historyTurnSignature(turn) {
  return JSON.stringify(turn.messages.map((message) => [
    message.ID,
    message.Role,
    message.Content,
    message.Status,
    message.UpdatedAt,
  ]));
}

function createHistoryWatcher(signal) {
  let closed = false;
  let failure = null;
  let pending = false;
  let wake = null;
  let debounce = null;
  const watchers = [];

  const notify = () => {
    pending = true;
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };
  const schedule = () => {
    if (closed || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      notify();
    }, HISTORY_WATCH_DEBOUNCE_MS);
  };
  localStateChangeListeners.add(schedule);
  // macOS may reject directory-level fs.watch with EMFILE once the system
  // FSEvents budget is exhausted. Watching the two SQLite files directly is
  // both cheaper and sufficient for a running Hermes Desktop in WAL mode.
  for (const target of [SESSION_DB, `${SESSION_DB}-wal`]) {
    if (!fs.existsSync(target)) continue;
    try {
      const watcher = fs.watch(target, { persistent: false }, schedule);
      watcher.on("error", (error) => {
        if (closed) return;
        failure = error instanceof Error ? error : new Error(String(error));
        notify();
      });
      watchers.push(watcher);
    } catch {
      // The other SQLite file remains a valid source of committed changes.
    }
  }
  if (!watchers.length) {
    failure = new Error("Hermes SQLite change watcher is unavailable");
  }
  const abort = () => {
    closed = true;
    localStateChangeListeners.delete(schedule);
    if (debounce) clearTimeout(debounce);
    for (const watcher of watchers) {
      try { watcher.close(); } catch {}
    }
    notify();
  };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  return {
    async next(timeoutMs = 0) {
      if (!pending && !closed && !failure) {
        await new Promise((resolve) => {
          let timeout = null;
          wake = () => {
            if (timeout) clearTimeout(timeout);
            wake = null;
            resolve();
          };
          if (timeoutMs > 0) {
            timeout = setTimeout(() => {
              if (wake) wake();
            }, timeoutMs);
          }
        });
      }
      if (failure) throw failure;
      const changed = pending;
      pending = false;
      return changed && !closed;
    },
    close() {
      if (signal) signal.removeEventListener("abort", abort);
      abort();
    },
  };
}

function notifyHermesStateChanged() {
  for (const listener of localStateChangeListeners) {
    listener();
  }
}

function desktopSessionHint(session, detail) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  return {
    plugin_id: "hermes",
    native_session_id: sessionID,
    native_thread_id: sessionID,
    surface: firstNonEmpty(session && session.Surface, "hermes-desktop-gateway"),
    endpoint: firstNonEmpty(session && session.Endpoint, sessionEndpoint(sessionID)),
    cwd: firstNonEmpty(session && session.Cwd),
    title: firstNonEmpty(session && session.Title),
    last_activity_at: nowISO(),
    metadata: {
      status: firstNonEmpty(detail && detail.status, "idle"),
      sort_at: String(Date.now()),
      pinned: String(Boolean(detail && detail.pinned)),
    },
  };
}

function desktopDetailSignature(sessionID, detail) {
  if (!sessionID || !detail || typeof detail !== "object") return "";
  const { updated_at: _updatedAt, ...stableDetail } = detail;
  return JSON.stringify([sessionID, stableDetail]);
}

async function pluginWideDesktopDetailEvent(previousSignature = "") {
  const identity = await currentDesktopIdentity();
  const sessionID = firstNonEmpty(identity && identity.storedID);
  if (!sessionID) return { signature: "", event: null };
  const row = await findSessionByID(sessionID);
  if (!row || asNumber(row.archived) === 1) return { signature: "", event: null };
  const session = toSession(sessionID, row.cwd, row.title);
  const described = await describeControls(session);
  const detail = described && described.details;
  if (!detail || detail.desktop_foreground !== true) return { signature: "", event: null };
  const signature = desktopDetailSignature(sessionID, detail);
  if (!signature || signature === previousSignature) return { signature, event: null };
  const hint = desktopSessionHint(session, detail);
  return {
    signature,
    event: {
      ID: `hermes:desktop-detail:${sessionID}:${Date.now()}`,
      Type: "desktop.state.changed",
      Status: firstNonEmpty(detail.status, "idle"),
      Summary: firstNonEmpty(detail.run && detail.run.summary, "Hermes Desktop state changed"),
      CreatedAt: nowISO(),
      Payload: {
        desktop_live: true,
        detail_snapshot: detail,
        native_session: {
          plugin_id: "hermes",
          native_session_id: sessionID,
          native_thread_id: sessionID,
          surface: session.Surface,
          endpoint: session.Endpoint,
          cwd: session.Cwd,
        },
        session_hint: hint,
      },
    },
  };
}

async function* readHistoryStream(session, request = {}, signal) {
  const sessionID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  const streamID = firstNonEmpty(request.stream_id, request.StreamID, randomID());
  if (!sessionID) {
    yield { stream_id: streamID, type: "error", source: "initial", operation: "append", error: "hermes readHistoryStream requires a resolved Hermes session id" };
    return;
  }
  const limit = Math.max(1, Number(request.limit ?? request.Limit) || 20);
  const watcher = request.live ? createHistoryWatcher(signal) : null;
  const revisions = new Map();
  const signatures = new Map();
  try {
    const initial = historyTurnsFromRows(sessionID, await historyRows(sessionID, limit), limit);
    for (const turn of initial) {
      const signature = historyTurnSignature(turn);
      revisions.set(turn.turn_id, 1);
      signatures.set(turn.turn_id, signature);
      yield {
        stream_id: streamID,
        type: "turn",
        source: "initial",
        operation: "append",
        turn: { ...turn, revision: 1 },
      };
    }
    yield { stream_id: streamID, type: request.live ? "page_end" : "end", source: "initial", operation: "append" };
    if (!request.live) return;

    while (!signal || !signal.aborted) {
      if (!await watcher.next()) break;
      const latest = historyTurnsFromRows(sessionID, await historyRows(sessionID, limit), limit);
      const latestIDs = new Set(latest.map((turn) => turn.turn_id));
      for (const turn of latest) {
        const signature = historyTurnSignature(turn);
        const previous = signatures.get(turn.turn_id);
        if (previous === signature) continue;
        const operation = previous === undefined ? "append" : "replace";
        const revision = (revisions.get(turn.turn_id) || 0) + 1;
        signatures.set(turn.turn_id, signature);
        revisions.set(turn.turn_id, revision);
        yield {
          stream_id: streamID,
          type: "turn",
          source: "live",
          operation,
          turn: { ...turn, revision },
        };
      }
      for (const turnID of Array.from(signatures.keys())) {
        if (!latestIDs.has(turnID)) {
          signatures.delete(turnID);
          revisions.delete(turnID);
        }
      }
    }
  } catch (error) {
    if (!signal || !signal.aborted) {
      yield {
        stream_id: streamID,
        type: "error",
        source: "live",
        operation: "replace",
        error: `hermes history watcher failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
  } finally {
    if (watcher) watcher.close();
  }
}

function toSession(sessionID, cwd = "", title = "") {
  const normalizedID = firstNonEmpty(sessionID);
  return {
    PluginID: "hermes",
    NativeSessionID: normalizedID,
    NativeThreadID: normalizedID,
    Surface: "hermes-desktop-gateway",
    Endpoint: normalizedID ? sessionEndpoint(normalizedID) : "Hermes Desktop gateway",
    Cwd: firstNonEmpty(cwd),
    Title: firstNonEmpty(title),
    Visible: true,
  };
}

function capability(available) {
  return {
    PluginID: "hermes",
    Available: available,
    NativeVisibleInput: available,
    NativeVisibleOutput: available,
    CanAttachSession: available,
    CanStartSessionWithMessage: available,
    CanOpenDraft: available,
    CanListSessions: available,
    CanReadHistory: available,
    CanInterrupt: available,
    CanApproval: available,
    CanForwardSync: available,
    // state.db emits durable session/body mutations for Desktop-originated
    // work. Gateway events remain only for Prism-owned live runs because a
    // Gateway session has one owning transport.
    CanReverseSync: available,
    CanPluginWideWatch: available,
    CanWaitRun: available,
    CanReadStatus: available,
    // Controls are session-gated at runtime. A historical session returns
    // control_target_stale rather than letting config.set fall back to Hermes'
    // global profile configuration.
    CanControlSession: available,
    CanOpenManagedTerminal: false,
    IntegrationMode: "protocol-native",
    VisibilitySurface: "hermes-desktop-gateway",
    UnavailableReason: available ? "" : "hermes_desktop_renderer_or_state_db_unavailable",
  };
}

async function discovery() {
  const available = await hermesDesktopAvailable();
  const bin = await resolveHermesBin();
  return {
    PluginID: "hermes",
    Surface: "hermes-desktop-gateway",
    Endpoint: "Hermes Desktop Gateway RPC",
    ProcessID: 0,
    SessionHints: {
      session_db: SESSION_DB,
      hermes_bin: firstNonEmpty(bin, "hermes"),
      default_cwd: DEFAULT_PROJECT_DIR,
      app_bundle: HERMES_APP,
      mode: "desktop-gateway-rpc-plus-sqlite",
    },
    Verified: available,
    Detail: available
      ? "Hermes Desktop renderer and ~/.hermes/state.db are available"
      : "Hermes Desktop renderer or ~/.hermes/state.db is unavailable",
  };
}

async function listSessions() {
  // Hermes Desktop's renderer is the directory authority. `state.db` retains
  // CLI/ACP history and sessions not shown by the Desktop, so it may only
  // enrich the exact opaque IDs currently exposed by the Desktop sidebar.
  const desktopOrder = await cdpController.desktopSessionDirectoryIDs();
  const items = await listSessionRows(0);
  const ordered = desktopDirectoryRows(desktopOrder, items, firstNonEmpty);
  let pinnedIDs = new Set();
  try {
    pinnedIDs = new Set(await cdpController.desktopPinnedSessionIDs());
  } catch {
    // Pins are local renderer presentation only. Their absence must not turn
    // the Desktop's authoritative session directory into a SQLite fallback.
  }
  return ordered.map((item) => ({
    PluginID: "hermes",
    NativeSessionID: firstNonEmpty(item.id),
    NativeThreadID: firstNonEmpty(item.id),
    Surface: "hermes-desktop-gateway",
    Endpoint: sessionEndpoint(firstNonEmpty(item.id)),
    Cwd: firstNonEmpty(item.cwd),
    Title: firstNonEmpty(item.title),
    PrismConversationID: "",
    Active: asNumber(item.ended_at) <= 0,
    Visible: true,
    LastActivityAt: epochSecondsToISO(item.last_activity),
    Metadata: {
      source: firstNonEmpty(item.source),
      message_count: String(asNumber(item.message_count)),
      ...(pinnedIDs.has(firstNonEmpty(item.lineage_root_id, item.id)) ? { pinned: "true" } : {}),
    },
  }));
}

async function attachSession(req) {
  const sessionID = firstNonEmpty(req && req.NativeSessionID, req && req.NativeThreadID);
  if (!sessionID) {
    throw new Error("hermes attachSession requires a real Hermes session id");
  }
  const existing = await findSessionByID(sessionID);
  if (!existing) {
    throw new Error(`hermes session not found: ${sessionID}`);
  }
  return toSession(existing.id, existing.cwd, existing.title);
}

function trackCompletedRun(run) {
  completedRuns.set(run.id, run);
  while (completedRuns.size > 100) {
    const firstKey = completedRuns.keys().next().value;
    completedRuns.delete(firstKey);
  }
}

function activeRunForSession(sessionID = "", runID = "") {
  const direct = activeRuns.get(firstNonEmpty(runID));
  if (direct) return direct;
  const latestRunID = sessionID ? latestRunBySession.get(sessionID) : "";
  return latestRunID ? activeRuns.get(latestRunID) || null : null;
}

function settleInterruptedRun(run) {
  if (!run || run.finalEvent) {
    return run && run.finalEvent;
  }
  run.finalEvent = {
    ID: run.id,
    Type: "run.failed",
    Status: "failed",
    Summary: "Hermes run interrupted",
    CreatedAt: nowISO(),
    Payload: {
      native_session_id: firstNonEmpty(run.canonicalSessionID),
      native_thread_id: firstNonEmpty(run.canonicalSessionID),
      live_session_id: firstNonEmpty(run.liveSessionID),
      cwd: firstNonEmpty(run.cwd),
      interrupted: true,
    },
  };
  activeRuns.delete(run.id);
  if (run.canonicalSessionID && latestRunBySession.get(run.canonicalSessionID) === run.id) {
    latestRunBySession.delete(run.canonicalSessionID);
  }
  trackCompletedRun(run);
  return run.finalEvent;
}

function completedRunForSession(sessionID = "", runID = "") {
  const direct = completedRuns.get(firstNonEmpty(runID));
  if (direct) return direct;
  if (!sessionID) return null;
  for (const run of Array.from(completedRuns.values()).reverse()) {
    if (firstNonEmpty(run && run.canonicalSessionID) === sessionID) {
      return run;
    }
  }
  return null;
}

function hermesApprovalActions() {
  // Hermes Desktop exposes these two direct actions in its approval bar.
  return [
    { id: "once", label: "Run", style: "primary", requires_input: false, available: true },
    { id: "deny", label: "Reject", style: "danger", requires_input: false, available: true },
  ];
}

function nativeApprovalWasResolved(approvalID, eventReceivedAt = 0) {
  const resolvedAt = Number(resolvedNativeApprovalByID.get(firstNonEmpty(approvalID)) || 0);
  if (!resolvedAt) return false;
  if (Date.now() - resolvedAt > APPROVAL_EVENT_LOOKBACK_MS) {
    resolvedNativeApprovalByID.delete(firstNonEmpty(approvalID));
    return false;
  }
  return resolvedAt >= Number(eventReceivedAt || 0);
}

async function recentApprovalForSession(sessionID = "") {
  const normalized = firstNonEmpty(sessionID);
  if (!normalized) return null;
  let events = [];
  try {
    events = await recentGatewayEvents(Date.now() - APPROVAL_EVENT_LOOKBACK_MS);
  } catch {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = event && event.payload && typeof event.payload === "object" ? event.payload : {};
    if (firstNonEmpty(event && event.type) !== "approval.request") continue;
    const eventLiveSessionID = firstNonEmpty(event && event.session_id, payload.session_id, payload.live_session_id);
    const eventSessionID = eventLiveSessionID
      ? canonicalSessionIDForLive(eventLiveSessionID)
      : canonicalSessionIDForUnscopedEvent(normalized, event && event.type);
    if (eventSessionID !== normalized) continue;
    const approvalID = nativeApprovalID(event, normalized);
    if (nativeApprovalWasResolved(approvalID, event && event.received_at)) continue;
    const approvalLiveSessionID = firstNonEmpty(
      eventLiveSessionID,
      activeRunForSession(eventSessionID) && activeRunForSession(eventSessionID).liveSessionID,
    );
    if (approvalID && approvalLiveSessionID) {
      approvalLiveSessionByID.set(approvalID, approvalLiveSessionID);
    }
    return {
      id: approvalID,
      approval_request_id: approvalID,
      title: firstNonEmpty(payload.command, "Hermes approval required"),
      summary: firstNonEmpty(payload.command, payload.description, "Hermes is waiting for approval"),
      description: firstNonEmpty(payload.description),
      command: firstNonEmpty(payload.command),
      status: "waiting_approval",
      source: "desktop_live",
      created_at: Number(event && event.received_at || Date.now()),
      actions: hermesApprovalActions(),
    };
  }
  return null;
}

async function readStatus(session, runID) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const activeRun = activeRunForSession(sessionID, runID);
  const desktopInteractions = HERMES_CONNECTION_MODE === "desktop"
    ? await readDesktopInteractionProjection(sessionID)
    : null;
  const desktopCanQueue = Boolean(desktopInteractions && desktopInteractions.foreground
    && desktopInteractions.composer && desktopInteractions.composer.editable === true);
  const approval = HERMES_CONNECTION_MODE === "native"
    ? await recentApprovalForSession(sessionID)
    : null;
  if (approval) {
    return {
      Available: true,
      Active: true,
      Status: "waiting_approval",
      TurnID: firstNonEmpty(activeRun && activeRun.id, approval.approval_request_id),
      ThreadID: firstNonEmpty(sessionID),
      StartedAt: activeRun && activeRun.startedAtMs ? new Date(activeRun.startedAtMs).toISOString() : "",
      UpdatedAt: new Date(Number(approval.created_at) || Date.now()).toISOString(),
      Interruptible: true,
      ApprovalBlocked: true,
      ApprovalRequestID: approval.approval_request_id,
      PrimaryAction: "approval",
      CanQueue: desktopCanQueue,
      DesktopState: { waiting_approval: true, primary_action: "approval", approval },
      Preview: approval.summary || "Hermes 正在等待审批…",
      Final: "",
      Error: "",
      Steps: [],
    };
  }
  if (activeRun) {
    return {
      Available: true,
      Active: true,
      Status: "running",
      TurnID: firstNonEmpty(activeRun.id),
      ThreadID: firstNonEmpty(sessionID, activeRun.canonicalSessionID),
      StartedAt: activeRun.startedAtMs ? new Date(activeRun.startedAtMs).toISOString() : "",
      UpdatedAt: nowISO(),
      Interruptible: true,
      ApprovalBlocked: false,
      ApprovalRequestID: "",
      PrimaryAction: desktopCanQueue ? "queue" : "interrupt",
      CanQueue: desktopCanQueue,
      DesktopState: { running: true, primary_action: desktopCanQueue ? "queue" : "interrupt" },
      Preview: "Hermes 正在回复…",
      Final: "",
      Error: "",
      Steps: [],
    };
  }
  const gatewayRun = await readGatewayRunState(sessionID);
  if (gatewayRun && gatewayRun.running) {
    return {
      Available: true,
      Active: true,
      Status: "running",
      TurnID: firstNonEmpty(gatewayRun.liveID),
      ThreadID: firstNonEmpty(sessionID),
      StartedAt: "",
      UpdatedAt: nowISO(),
      Interruptible: true,
      ApprovalBlocked: false,
      ApprovalRequestID: "",
      PrimaryAction: desktopCanQueue ? "queue" : "interrupt",
      CanQueue: desktopCanQueue,
      DesktopState: { running: true, primary_action: desktopCanQueue ? "queue" : "interrupt" },
      Preview: firstNonEmpty(gatewayRun.preview, "Hermes 正在回复…"),
      Final: "",
      Error: "",
      Steps: [],
    };
  }
  const completedRun = completedRunForSession(sessionID, runID);
  if (completedRun && completedRun.finalEvent) {
    const status = firstNonEmpty(completedRun.finalEvent.Status).toLowerCase() === "failed"
      ? (completedRun.interrupted ? "interrupted" : "failed")
      : "completed";
    const summary = firstNonEmpty(completedRun.finalEvent.Summary);
    return {
      Available: true,
      Active: false,
      Status: status,
      TurnID: firstNonEmpty(completedRun.id),
      ThreadID: firstNonEmpty(sessionID, completedRun.canonicalSessionID),
      StartedAt: completedRun.startedAtMs ? new Date(completedRun.startedAtMs).toISOString() : "",
      UpdatedAt: firstNonEmpty(completedRun.finalEvent.CreatedAt, nowISO()),
      CompletedAt: firstNonEmpty(completedRun.finalEvent.CreatedAt, nowISO()),
      Interruptible: false,
      ApprovalBlocked: false,
      ApprovalRequestID: "",
      PrimaryAction: "send",
      CanQueue: desktopCanQueue,
      DesktopState: { running: false, primary_action: "send" },
      Preview: summary,
      Final: status === "completed" ? summary : "",
      Error: status === "completed" ? "" : summary,
      Steps: [],
    };
  }
  return {
    Available: true,
    Active: false,
    Status: "idle",
    TurnID: "",
    ThreadID: firstNonEmpty(sessionID),
    UpdatedAt: nowISO(),
    Interruptible: false,
    ApprovalBlocked: false,
    ApprovalRequestID: "",
    PrimaryAction: "send",
    CanQueue: desktopCanQueue,
    DesktopState: { running: false, primary_action: "send" },
    Preview: "",
    Final: "",
    Error: "",
    Steps: [],
  };
}

function actionAvailable(runtime, action, controls = {}) {
  const status = firstNonEmpty(runtime && runtime.Status).toLowerCase();
  switch (action) {
    case "interrupt":
      return Boolean(runtime && runtime.Interruptible) || status === "running" || status === "waiting_approval";
    case "approval.resolve":
      return Boolean(runtime && runtime.ApprovalBlocked) || status === "waiting_approval";
    case "message.send":
      return status !== "waiting_approval";
    case "model.switch":
      return status === "idle" && !controls.controls_locked && Boolean(controls.live_session_id) && controls.model_options.length > 0;
    case "reasoning.switch":
      return status === "idle" && !controls.controls_locked && Boolean(controls.live_session_id) && controls.reasoning_options.length > 0;
    case "rename":
      return controls.desktop_foreground === true
        && Boolean(controls.session_actions && controls.session_actions.rename_action_id);
    case "pin":
      return controls.desktop_foreground === true
        && Boolean(controls.session_actions && controls.session_actions.pin_action_id)
        && typeof controls.session_actions.pinned === "boolean";
    case "archive":
      return controls.desktop_foreground === true
        && Boolean(controls.session_actions && controls.session_actions.archive_action_id);
    case "delete":
      return controls.desktop_foreground === true
        && Boolean(controls.session_actions && controls.session_actions.delete_action_id);
    default:
      return false;
  }
}

function detailSnapshot(session, runtime, controls = {}) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const context = controls.context && typeof controls.context === "object"
    ? controls.context
    : contextFromGateway(null);
  // Gateway approval events cannot be queried or safely reattached. Only a
  // currently rendered Desktop approval is published as actionable state.
  const approval = controls.approval || null;
  // Hermes has no approval query RPC. A renderer approval is therefore the
  // authoritative live state even when the Gateway event cache has not yet
  // observed the original request.
  const approvalBlocked = Boolean(approval);
  const status = approvalBlocked ? "waiting_approval" : firstNonEmpty(runtime && runtime.Status, "idle").toLowerCase();
  const active = approvalBlocked || Boolean(runtime && runtime.Active);
  const canQueue = controls.desktop_foreground === true
    && Boolean(controls.composer && controls.composer.editable === true)
    && !approvalBlocked;
  const primaryAction = approvalBlocked || Boolean(runtime && runtime.ApprovalBlocked)
    ? "approval"
    : status === "waiting_approval"
      ? (runtime && runtime.Interruptible ? "interrupt" : "send")
      : firstNonEmpty(runtime && runtime.PrimaryAction, "send");
  return {
    plugin_id: "hermes",
    conversation_id: sessionID,
    desktop_foreground: controls.desktop_foreground === true,
    detail_stale: controls.desktop_foreground !== true,
    updated_at: Date.now(),
    status,
    primary_action: primaryAction,
    can_queue: canQueue,
    current_model: controls.model || null,
    current_reasoning: controls.reasoning || null,
    current_permission: null,
    model_options: Array.isArray(controls.model_options) ? controls.model_options : [],
    reasoning_options: Array.isArray(controls.reasoning_options) ? controls.reasoning_options : [],
    permission_options: [],
    interactive_controls: [],
    composer: controls.composer || null,
    queue: controls.queue || null,
    approval,
    context_window_total: context.context_window_total || "0",
    context_tokens_used: context.context_tokens_used || "0",
    context_window_usage_percent: context.context_window_usage_percent || "0",
    context_window: context.context_window || "",
    pinned: Boolean(controls.session_actions && controls.session_actions.pinned),
    actions: [
      { id: "message.send", available: actionAvailable(runtime, "message.send") },
      { id: "interrupt", available: actionAvailable(runtime, "interrupt") },
      { id: "approval.resolve", available: approvalBlocked },
      { id: "model.switch", available: actionAvailable(runtime, "model.switch", controls) },
      { id: "reasoning.switch", available: actionAvailable(runtime, "reasoning.switch", controls) },
      { id: "rename", label: "重命名", available: actionAvailable(runtime, "rename", controls) },
      {
        id: "pin",
        label: controls.session_actions && controls.session_actions.pinned ? "取消置顶" : "置顶",
        available: actionAvailable(runtime, "pin", controls),
        target: { enabled: !Boolean(controls.session_actions && controls.session_actions.pinned) },
      },
      { id: "archive", label: "归档", available: actionAvailable(runtime, "archive", controls) },
      { id: "delete", label: "删除", available: actionAvailable(runtime, "delete", controls) },
    ],
    run: {
      status,
      active,
      interruptible: Boolean(runtime && runtime.Interruptible),
      approval_blocked: approvalBlocked || Boolean(runtime && runtime.ApprovalBlocked),
      approval,
      primary_action: primaryAction,
      summary: firstNonEmpty(runtime && runtime.Preview, runtime && runtime.Final, runtime && runtime.Error),
    },
  };
}

async function describeControls(session) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const identity = await currentDesktopIdentity();
  if (!sessionID || identity.storedID !== sessionID) {
    return {
      ok: true,
      action: "controls.describe",
      message: "Hermes controls are unavailable outside the current Desktop conversation.",
      thread_id: firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID),
      details: detailSnapshot(session, await readStatus(session, ""), {
        desktop_foreground: false,
        live_session_id: "",
        controls_locked: false,
        model: null,
        reasoning: null,
        model_options: [],
        reasoning_options: [],
        context: contextFromGateway(null),
        session_actions: null,
      }),
    };
  }
  const runtime = await readStatus(session, "");
  // Hermes may briefly drop queueSessionKey from the composer Fiber after a
  // route switch. Recover only an unambiguous Gateway live session for this
  // durable ID; readDesktopInteractionProjection revalidates that exact pair
  // against the current renderer before exposing controls.
  const gatewayRun = identity.liveID ? null : await readGatewayRunState(sessionID);
  const verifiedLiveID = firstNonEmpty(identity.liveID, gatewayRun && gatewayRun.liveID);
  // Avoid a model picker/context request for every background subscription.
  // Only the native foreground composer is eligible to produce strict detail.
  const interactions = await readDesktopInteractionProjection(sessionID, verifiedLiveID);
  const controls = interactions.foreground
    ? await readControlProjection(sessionID)
    : { live_session_id: "", controls_locked: false, model: null, reasoning: null, model_options: [], reasoning_options: [], context: contextFromGateway(null) };
  // CDP is the authoritative source for which Hermes Desktop conversation is
  // visible. Gateway active-list is only an enhancement for model/context
  // controls: it can legitimately lag the renderer or omit a renderer-owned
  // session, and must not turn a verified foreground conversation stale.
  const foreground = interactions.foreground;
  const snapshot = detailSnapshot(session, runtime, {
    ...controls,
    desktop_foreground: foreground,
    queue: foreground ? interactions.queue : null,
    approval: foreground ? interactions.approval : null,
    composer: foreground ? interactions.composer : null,
    session_actions: foreground ? interactions.session_actions : null,
  });
  return {
    ok: true,
    action: "controls.describe",
    message: "Hermes 控制状态已刷新。",
    thread_id: firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID),
    details: snapshot,
  };
}

function controlTargetStale(reason) {
  return new Error(`control_target_stale: ${reason}`);
}

async function requireLiveControl(sessionID) {
  // Match Hermes Desktop: selection uses the picker row already shown to the
  // user. Revalidate the live session and lock state, but never block a click
  // on a slow catalog rebuild. The target check below is against that last
  // verified native picker, and a background refresh reconciles afterward.
  const live = await readLiveControlState(sessionID);
  if (!live) {
    throw controlTargetStale("Hermes session is no longer live in the Desktop Gateway");
  }
  if (live.controlsLocked) {
    throw controlTargetStale("Hermes session is running and its controls are locked");
  }
  return live;
}

async function confirmSessionTitle(sessionID, title) {
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    const row = await findSessionByID(sessionID);
    if (row && firstNonEmpty(row.title) === title) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Hermes did not persist the renamed conversation title");
}

async function renameHermesConversation(sessionID, name) {
  const canonicalID = firstNonEmpty(sessionID);
  const title = firstNonEmpty(name);
  if (!title) {
    throw new Error("Hermes conversation rename requires a non-empty name");
  }
  const interactions = await readDesktopInteractionProjection(canonicalID);
  const sessionActions = interactions.session_actions;
  if (!interactions.foreground || !sessionActions || !firstNonEmpty(sessionActions.rename_action_id)) {
    throw controlTargetStale("Hermes session rename action is no longer present on the current Desktop conversation");
  }
  await cdpController.renameDesktopSession(
    canonicalID,
    interactions.live_session_id,
    sessionActions.rename_action_id,
    title,
  );
  await confirmSessionTitle(canonicalID, title);
  notifyHermesStateChanged();
}

function requestedPinState(target, current) {
  if (target && typeof target === "object" && typeof target.enabled === "boolean") return target.enabled;
  if (typeof target === "boolean") return target;
  return !current;
}

async function setHermesSessionPin(sessionID, target) {
  const canonicalID = firstNonEmpty(sessionID);
  const interactions = await readDesktopInteractionProjection(canonicalID);
  const sessionActions = interactions.session_actions;
  if (!interactions.foreground || !sessionActions || typeof sessionActions.pinned !== "boolean"
    || !firstNonEmpty(sessionActions.pin_action_id)) {
    throw controlTargetStale("Hermes session pin action is no longer present on the current Desktop conversation");
  }
  const expectedPinned = requestedPinState(target, sessionActions.pinned);
  if (expectedPinned === sessionActions.pinned) return;
  await cdpController.executeDesktopInteraction("session", canonicalID, interactions.live_session_id, {
    actionID: sessionActions.pin_action_id,
    expectedPinned,
  });
  notifyHermesStateChanged();
}

async function archiveHermesSession(sessionID) {
  const canonicalID = firstNonEmpty(sessionID);
  const interactions = await readDesktopInteractionProjection(canonicalID);
  const sessionActions = interactions.session_actions;
  if (!interactions.foreground || !sessionActions || !firstNonEmpty(sessionActions.archive_action_id)) {
    throw controlTargetStale("Hermes archive action is no longer present on the current Desktop conversation");
  }
  await cdpController.executeDesktopInteraction("session", canonicalID, interactions.live_session_id, {
    actionID: sessionActions.archive_action_id,
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = await findSessionByID(canonicalID);
    if (row && asNumber(row.archived) === 1) {
      notifyHermesStateChanged();
      return;
    }
    await sleep(100);
  }
  throw new Error("Hermes Desktop did not persist the archived conversation");
}

async function deleteHermesSession(sessionID) {
  const canonicalID = firstNonEmpty(sessionID);
  const interactions = await readDesktopInteractionProjection(canonicalID);
  const sessionActions = interactions.session_actions;
  if (!interactions.foreground || !sessionActions || !firstNonEmpty(sessionActions.delete_action_id)) {
    throw controlTargetStale("Hermes delete action is no longer present on the current Desktop conversation");
  }
  await cdpController.executeDesktopInteraction("session", canonicalID, interactions.live_session_id, {
    actionID: sessionActions.delete_action_id,
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await findSessionByID(canonicalID)) {
      notifyHermesStateChanged();
      return;
    }
    await sleep(100);
  }
  throw new Error("Hermes Desktop did not permanently delete the conversation");
}

async function pinResultSnapshot(session) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const interactions = await readDesktopInteractionProjection(sessionID);
  if (!interactions.foreground || !interactions.session_actions) {
    throw controlTargetStale("Hermes session pin state is no longer visible in the current Desktop conversation");
  }
  // Pinning is renderer-local. Return the verified renderer result directly
  // instead of serializing this UI action behind Gateway model/context reads.
  const runtime = {
    Available: true,
    Active: false,
    Status: "idle",
    ThreadID: sessionID,
    PrimaryAction: "send",
    Interruptible: false,
    ApprovalBlocked: false,
  };
  return {
    ok: true,
    action: "pin",
    message: "Hermes pin state updated in Desktop.",
    thread_id: sessionID,
    details: detailSnapshot(session, runtime, {
      desktop_foreground: true,
      live_session_id: interactions.live_session_id,
      controls_locked: false,
      model: null,
      reasoning: null,
      model_options: [],
      reasoning_options: [],
      context: contextFromGateway(null),
      composer: interactions.composer,
      queue: interactions.queue,
      approval: interactions.approval,
      session_actions: interactions.session_actions,
    }),
  };
}

function updateOptimisticControlState(liveID, update) {
  const cached = modelOptionsByLiveSession.get(liveID);
  if (!cached) return;
  const options = cached.options && typeof cached.options === "object" ? cached.options : {};
  const optimistic = {
    model: firstNonEmpty(update.model, options.model),
    provider: firstNonEmpty(update.provider, options.provider),
    reasoning: firstNonEmpty(update.reasoning, cached.reasoning),
  };
  modelOptionsByLiveSession.set(liveID, {
    ...cached,
    options: {
      ...options,
      ...(optimistic.model ? { model: optimistic.model, provider: optimistic.provider } : {}),
    },
    reasoning: optimistic.reasoning,
    revision: Number(cached.revision || 0) + 1,
    optimistic,
    refreshAfterCurrent: Boolean(cached.refreshPromise),
  });
}

function enabledModelTarget(live, target) {
  const requested = parseModelOptionID(optionTarget(target));
  if (!requested) {
    throw controlTargetStale("model option identity is missing or malformed");
  }
  const row = modelsFromGateway(live.options).find((candidate) => (
    candidate.provider === requested.provider
      && candidate.model === requested.model
      && candidate.disabled !== true
  ));
  if (!row) {
    throw controlTargetStale("model option is no longer available in Hermes");
  }
  return row;
}

function enabledReasoningTarget(live, target) {
  const requested = optionTarget(target).toLowerCase();
  const model = firstNonEmpty(live && live.options && live.options.model);
  const provider = firstNonEmpty(live && live.options && live.options.provider);
  const available = supportsReasoning(live.options, provider, model);
  if (!reasoningOptions("", available).some((option) => option.key === requested)) {
    throw controlTargetStale("reasoning option is no longer available for the current Hermes model");
  }
  return requested;
}

async function switchHermesModel(sessionID, target) {
  const live = await requireLiveControl(sessionID);
  const model = enabledModelTarget(live, target);
  const result = HERMES_CONNECTION_MODE === "desktop"
    ? await cdpController.desktopGatewayMutation(
      sessionID,
      live.liveID,
      "config.set",
      {
        session_id: live.liveID,
        key: "model",
        value: `${model.model} --provider ${model.provider}`,
      },
      120000,
    )
    : await hermesGateway().configSet(
      "model",
      `${model.model} --provider ${model.provider} --session`,
      live.liveID,
    );
  if (result && result.confirm_required === true) {
    throw new Error("control_confirmation_required: Hermes requires Desktop confirmation before switching this model");
  }
  updateOptimisticControlState(live.liveID, model);
  // This is equivalent to Desktop's query invalidation after config.set. It
  // must not delay the already accepted selection.
  void refreshModelOptions(live.liveID, sessionID).catch(() => {});
}

async function switchHermesReasoning(sessionID, target) {
  const live = await requireLiveControl(sessionID);
  const reasoning = enabledReasoningTarget(live, target);
  if (HERMES_CONNECTION_MODE === "desktop") {
    await cdpController.desktopGatewayMutation(
      sessionID,
      live.liveID,
      "config.set",
      { session_id: live.liveID, key: "reasoning", value: reasoning },
      120000,
    );
  } else {
    await hermesGateway().configSet("reasoning", reasoning, live.liveID);
  }
  updateOptimisticControlState(live.liveID, { reasoning });
  void refreshModelOptions(live.liveID, sessionID).catch(() => {});
}

async function controlSession(req) {
  const session = req && req.session ? req.session : req && req.Session ? req.Session : req;
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const action = normalizeAction(req && req.action || req && req.Action || "");
  let awaitingDesktopSnapshot = false;
  switch (action) {
    case "conversation.select":
      await selectSession(session);
      return {
        ok: true,
        action: "conversation.select",
        thread_id: sessionID,
        message: "Hermes Desktop conversation selected.",
        details: (await describeControls(session)).details,
      };
    case "controls.describe":
    case "describe.controls":
      return describeControls(session);
    case "model.switch":
      await switchHermesModel(sessionID, req && (req.target || req.Target));
      break;
    case "reasoning.switch":
      await switchHermesReasoning(sessionID, req && (req.target || req.Target));
      break;
    case "rename":
      await renameHermesConversation(sessionID, req && (req.name || req.Name));
      break;
    case "pin":
      await setHermesSessionPin(sessionID, req && (req.target || req.Target));
      return pinResultSnapshot(session);
    case "archive":
      await archiveHermesSession(sessionID);
      return {
        ok: true,
        action: "archive",
        message: "Hermes conversation archived in Desktop.",
        thread_id: sessionID,
        details: {},
      };
    case "delete":
      await deleteHermesSession(sessionID);
      return {
        ok: true,
        action: "delete",
        message: "Hermes conversation permanently deleted in Desktop.",
        thread_id: sessionID,
        details: {},
      };
    default:
      if (action.startsWith("queue.")) {
        const target = req && (req.target || req.Target);
        const itemID = firstNonEmpty(
          target && target.queue_item_id,
          target && target.queueItemID,
          target && target.item_id,
        );
        if (!itemID) {
          throw controlTargetStale("queue item identity is missing");
        }
        const controls = await readControlProjection(sessionID);
        const interactions = await readDesktopInteractionProjection(sessionID, controls.live_session_id);
        const item = interactions.queue && Array.isArray(interactions.queue.items)
          ? interactions.queue.items.find((candidate) => firstNonEmpty(candidate && candidate.id) === itemID)
          : null;
        if (!item || !Array.isArray(item.actions)
          || !item.actions.some((candidate) => firstNonEmpty(candidate && candidate.id) === action && candidate.available !== false)) {
          throw controlTargetStale("queue action is no longer present on the current Hermes Desktop conversation");
        }
        await cdpController.executeDesktopInteraction("queue", sessionID, controls.live_session_id, {
          itemID,
          actionID: action,
        });
        awaitingDesktopSnapshot = true;
        break;
      }
      throw new Error(`unsupported Hermes control action: ${action || "unknown"}`);
  }
  const refreshed = await describeControls(session);
  return {
    ...refreshed,
    action,
    message: awaitingDesktopSnapshot
      ? "Hermes queue action submitted; waiting for the Desktop snapshot."
      : "Hermes control applied; Desktop state is refreshing.",
  };
}

async function finalizeRun(run) {
  if (!run || run.finalized) {
    return;
  }
  run.finalized = true;
  const parsed = parseHermesOutput(run.stdout);
  if (!run.canonicalSessionID) {
    run.canonicalSessionID = firstNonEmpty(parsed.sessionID);
  }
  if (!run.canonicalSessionID) {
    const latest = await latestPrismSession(run.startedAtMs, run.cwd);
    if (latest && latest.id) {
      run.canonicalSessionID = latest.id;
    }
  }
  let rows = [];
  let summary = "";
  const deadline = Date.now() + POST_EXIT_FLUSH_WAIT_MS;
  while (Date.now() <= deadline) {
    if (run.canonicalSessionID) {
      rows = await readMessagesAfter(run.canonicalSessionID, run.beforeMessageID);
      summary = latestAssistantSummary(rows);
      if (summary) {
        break;
      }
    }
    summary = firstNonEmpty(summary, parseHermesOutput(run.stdout).summary);
    if (summary) {
      break;
    }
    await sleep(FINAL_RESULT_POLL_MS);
  }
  if (!summary) {
    summary = firstNonEmpty(parseHermesOutput(run.stdout).summary);
  }
  let status = "completed";
  let type = "run.completed";
  if (run.interrupted) {
    status = "failed";
    type = "run.failed";
    summary = firstNonEmpty(summary, "Hermes run interrupted");
  } else if (asNumber(run.exitCode) !== 0) {
    status = "failed";
    type = "run.failed";
    summary = firstNonEmpty(summary, String(run.stderr || "").trim(), `hermes chat exited with code ${run.exitCode}`);
  } else if (!summary) {
    status = "failed";
    type = "run.failed";
    summary = "hermes completed the request but no assistant message content was found";
  }
  run.finalEvent = {
    ID: run.id,
    Type: type,
    Status: status,
    Summary: summary,
    CreatedAt: nowISO(),
    Payload: {
      native_session_id: firstNonEmpty(run.canonicalSessionID),
      native_thread_id: firstNonEmpty(run.canonicalSessionID),
      cwd: run.cwd,
      exit_code: asNumber(run.exitCode),
      interrupted: Boolean(run.interrupted),
    },
  };
  activeRuns.delete(run.id);
  if (run.canonicalSessionID && latestRunBySession.get(run.canonicalSessionID) === run.id) {
    latestRunBySession.delete(run.canonicalSessionID);
  }
  trackCompletedRun(run);
}

async function startRun(existingSessionID, cwd, text) {
  const bin = await resolveHermesBin();
  if (!bin) {
    throw new Error("hermes could not find the hermes executable");
  }
  const canonicalCwd = normalizeCwd(cwd);
  const beforeMessageID = existingSessionID ? await maxMessageID(existingSessionID) : 0;
  const args = ["chat"];
  if (existingSessionID) {
    args.push("--resume", existingSessionID);
  }
  args.push("-q", text, "-Q", "--source", "prism", "--accept-hooks");
  const child = spawn(bin, args, {
    cwd: canonicalCwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = {
    id: randomID(),
    child,
    stdout: "",
    stderr: "",
    exitCode: 0,
    interrupted: false,
    finalized: false,
    finalEvent: null,
    canonicalSessionID: firstNonEmpty(existingSessionID),
    beforeMessageID,
    cwd: canonicalCwd,
    startedAtMs: Date.now(),
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    run.stdout += String(chunk || "");
    const parsed = parseHermesOutput(run.stdout);
    if (parsed.sessionID && parsed.sessionID !== run.canonicalSessionID) {
      if (run.canonicalSessionID && parsed.sessionID !== run.canonicalSessionID) {
        run.beforeMessageID = 0;
      }
      run.canonicalSessionID = parsed.sessionID;
    }
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += String(chunk || "");
  });
  run.donePromise = new Promise((resolve) => {
    child.on("close", async (code) => {
      run.exitCode = asNumber(code);
      await finalizeRun(run);
      resolve(run.finalEvent);
    });
  });
  child.on("error", async (err) => {
    run.stderr += `${err instanceof Error ? err.message : String(err)}\n`;
    run.exitCode = 1;
    await finalizeRun(run);
  });
  return run;
}

async function startDesktopRun(existingSessionID, cwd, text, options = {}) {
  const canonicalCwd = normalizeCwd(cwd);
  const startedAtMs = Date.now();
  let liveSessionID = "";
  let storedSessionID = firstNonEmpty(existingSessionID);
  let beforeMessageID = storedSessionID ? await maxMessageID(storedSessionID) : 0;
  const attachments = [];
  for (const [index, attachment] of (Array.isArray(options.attachments) ? options.attachments : []).entries()) {
    attachments.push(await validateAttachment(attachment, index));
  }
  const attachmentPaths = attachments.map((attachment) => attachment.LocalPath);
  let submission;
  if (storedSessionID) {
    const selected = await cdpController.selectDesktopSession(storedSessionID, 10000);
    liveSessionID = firstNonEmpty(selected && selected.liveSessionID);
    storedSessionID = firstNonEmpty(selected && selected.storedSessionID, storedSessionID);
    beforeMessageID = await maxMessageID(storedSessionID);
    submission = await cdpController.submitDesktopPrompt(
      storedSessionID,
      liveSessionID,
      text,
      attachmentPaths,
      15000,
    );
  } else {
    // New sessions, including attachment-first sessions, are created through
    // Hermes' mounted composer so the Desktop owns route, queue and upload state.
    const created = await cdpController.createDesktopSessionWithPrompt(
      text,
      attachmentPaths,
      60000,
      firstNonEmpty(options.draftFingerprint),
    );
    liveSessionID = firstNonEmpty(created && created.liveSessionID);
    storedSessionID = firstNonEmpty(created && created.storedSessionID);
    submission = created;
  }
  if (!liveSessionID) {
    throw new Error("hermes could not activate a Hermes Desktop session");
  }
  if (!existingSessionID) {
    const persistDeadline = Date.now() + VISIBILITY_WAIT_TIMEOUT_MS;
    let persisted = null;
    while (Date.now() < persistDeadline) {
      persisted = await findSessionByID(storedSessionID);
      if (persisted) break;
      await sleep(150);
    }
    if (!persisted) {
      throw new Error("Hermes Desktop created a route but did not persist the new session");
    }
  }
  if (!existingSessionID && options.requireDirectNativeID && !storedSessionID) {
    throw new Error("hermes createSession did not return a direct native session id");
  }
  const run = {
    id: firstNonEmpty(submission && submission.queueItemID, randomID()),
    child: null,
    stdout: "",
    stderr: "",
    exitCode: 0,
    interrupted: false,
    finalized: false,
    finalEvent: null,
    canonicalSessionID: storedSessionID,
    liveSessionID,
    beforeMessageID,
    cwd: canonicalCwd,
    startedAtMs,
    text: String(text || "").trim(),
    requestedText: text,
    attachments,
    desktop: true,
    queued: submission && (submission.outcome === "queue_visible" || submission.outcome === "queue_pending"),
    queueItemID: firstNonEmpty(submission && submission.queueItemID),
    visibilityMarker: firstNonEmpty(text, attachmentFileName(attachments[0])),
  };
  if (liveSessionID && storedSessionID) {
    canonicalSessionByLiveID.set(liveSessionID, storedSessionID);
  }

  if (typeof options.onSessionReady === "function") {
    await options.onSessionReady(run);
  }

  if (run.queued) {
    return run;
  }
  activeRuns.set(run.id, run);
  latestRunBySession.set(storedSessionID, run.id);
  run.donePromise = (async () => {
    const deadline = Date.now() + FINAL_RESULT_WAIT_MS;
    while (!run.finalEvent && Date.now() < deadline) {
      if (!run.canonicalSessionID) {
        const latest = await latestPrismSession(run.startedAtMs, run.cwd);
        if (latest && latest.id) {
          run.canonicalSessionID = latest.id;
          latestRunBySession.set(latest.id, run.id);
        }
      }
      if (run.canonicalSessionID) {
        const rows = await readMessagesAfter(run.canonicalSessionID, run.beforeMessageID);
        const summary = latestAssistantSummary(rows);
        if (summary) {
          if (run.interrupted) {
            return settleInterruptedRun(run);
          }
          run.finalEvent = {
            ID: run.id,
            Type: "run.completed",
            Status: "completed",
            Summary: summary,
            CreatedAt: nowISO(),
            Payload: {
              native_session_id: run.canonicalSessionID,
              native_thread_id: run.canonicalSessionID,
              live_session_id: run.liveSessionID,
              cwd: run.cwd,
            },
          };
          activeRuns.delete(run.id);
          if (latestRunBySession.get(run.canonicalSessionID) === run.id) {
            latestRunBySession.delete(run.canonicalSessionID);
          }
          trackCompletedRun(run);
          return run.finalEvent;
        }
      }
      await sleep(FINAL_RESULT_POLL_MS);
    }
    if (!run.finalEvent) {
      if (run.interrupted) {
        return settleInterruptedRun(run);
      }
      run.finalEvent = {
        ID: run.id,
        Type: "run.failed",
        Status: "failed",
        Summary: "hermes waitForRun timed out before Hermes produced the final result",
        CreatedAt: nowISO(),
        Payload: {
          native_session_id: firstNonEmpty(run.canonicalSessionID),
          native_thread_id: firstNonEmpty(run.canonicalSessionID),
          live_session_id: run.liveSessionID,
          cwd: run.cwd,
        },
      };
      activeRuns.delete(run.id);
      trackCompletedRun(run);
    }
    return run.finalEvent;
  })();
  return run;
}

async function waitForCanonicalSession(run) {
  const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (run.canonicalSessionID) {
      return run.canonicalSessionID;
    }
    if (run.finalized) {
      break;
    }
    await sleep(100);
  }
  if (!run.canonicalSessionID) {
    const latest = await latestPrismSession(run.startedAtMs, run.cwd);
    if (latest && latest.id) {
      run.canonicalSessionID = latest.id;
    }
  }
  return run.canonicalSessionID;
}

async function waitForVisibleUserMessage(run) {
  const deadline = Date.now() + VISIBILITY_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!run.canonicalSessionID) {
      const latest = await latestPrismSession(run.startedAtMs, run.cwd);
      if (latest && latest.id) {
        run.canonicalSessionID = latest.id;
      }
    }
    if (run.canonicalSessionID && await userMessageDelivered(run.canonicalSessionID, run.text, run.startedAtMs, run.visibilityMarker)) {
      return true;
    }
    if (run.finalized) {
      break;
    }
    await sleep(150);
  }
  return Boolean(run.canonicalSessionID && await userMessageDelivered(run.canonicalSessionID, run.text, run.startedAtMs, run.visibilityMarker));
}

async function send(session, msg) {
  const available = await hermesDesktopAvailable();
  if (!available) {
    throw new Error("hermes desktop mode requires the running Hermes Desktop renderer and ~/.hermes/state.db");
  }
  const text = firstNonEmpty(msg && msg.Text);
  const attachments = Array.isArray(msg && msg.Attachments) ? msg.Attachments : [];
  if (!text && attachments.length === 0) {
    throw new Error("hermes send requires text or attachments");
  }
  let sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  let sessionRow = null;
  if (sessionID) {
    sessionRow = await findSessionByID(sessionID);
    if (!sessionRow) {
      throw new Error(`hermes session not found: ${sessionID}`);
    }
    sessionID = sessionRow.id;
  } else {
    sessionID = "";
  }
  const cwd = normalizeCwd(firstNonEmpty(sessionRow && sessionRow.cwd, session && session.Cwd));
  const run = await startDesktopRun(sessionID, cwd, text, { attachments });
  const canonicalSessionID = await waitForCanonicalSession(run);
  if (canonicalSessionID && !run.queued) {
    latestRunBySession.set(canonicalSessionID, run.id);
  }
  if (run.queued) {
    return {
      NativeMessageID: firstNonEmpty(run.queueItemID, run.id),
      CanonicalNativeSessionID: firstNonEmpty(canonicalSessionID),
      CanonicalNativeThreadID: firstNonEmpty(canonicalSessionID),
      Accepted: true,
      Visible: true,
      Detail: run.queueItemID
        ? "Hermes Desktop added the message to its native queue"
        : "Hermes Desktop accepted the message and is publishing its native queue",
    };
  }
  const visible = await waitForVisibleUserMessage(run);
  if (!visible) {
    throw new Error("hermes could not confirm that the user message reached the target Hermes session");
  }
  return {
    NativeMessageID: run.id,
    CanonicalNativeSessionID: firstNonEmpty(canonicalSessionID),
    CanonicalNativeThreadID: firstNonEmpty(canonicalSessionID),
    Accepted: true,
    Visible: visible,
    Detail: canonicalSessionID
      ? "Hermes Desktop accepted the message through CDP"
      : "Hermes Desktop started the message run through CDP",
  };
}

async function startSessionWithMessage(req, options = {}) {
  const message = req && req.Message && typeof req.Message === "object" ? req.Message : {};
  const messageID = firstNonEmpty(message.PrismMessageID);
  const text = firstNonEmpty(message.Text);
  const attachments = Array.isArray(message.Attachments) ? message.Attachments : [];
  const visibilityMarker = firstNonEmpty(text, attachmentFileName(attachments[0]));
  if (!messageID || !visibilityMarker) {
    throw new Error("hermes startSessionWithMessage requires PrismMessageID and text or attachments");
  }
  const previous = readStartedSessions()[messageID];
  if (previous && previous.status === "visible" && previous.session_id) {
    const session = toSession(previous.session_id, previous.cwd, "Hermes");
    return {
      Session: session,
      Receipt: {
        NativeMessageID: firstNonEmpty(previous.native_message_id, messageID),
        CanonicalNativeSessionID: previous.session_id,
        CanonicalNativeThreadID: previous.session_id,
        Accepted: true,
        Visible: true,
        Detail: "duplicate Hermes conversation start",
      },
      Visibility: {
        Visible: true,
        Marker: text,
        Evidence: "persisted start result",
        CheckedAt: nowISO(),
        FailureReason: "",
      },
    };
  }
  if (previous && previous.session_id) {
    throw new Error("hermes start outcome is unknown; refusing to create or send a duplicate first message");
  }
  const cwd = normalizeCwd(req && req.Cwd);
  const run = await startDesktopRun("", cwd, text, {
    requireDirectNativeID: true,
    attachments,
    draftFingerprint: firstNonEmpty(options.draftFingerprint),
    onSessionReady: async (ready) => {
      writeStartedSession(messageID, {
        status: "created",
        session_id: ready.canonicalSessionID,
        cwd: ready.cwd,
      });
    },
  });
  const sessionID = firstNonEmpty(run.canonicalSessionID);
  if (!sessionID) {
    throw new Error("hermes start did not receive a direct native session id");
  }
  const visible = await waitForVisibleUserMessage(run);
  if (!visible) {
    throw new Error("hermes could not confirm that the first message reached the created session");
  }
  writeStartedSession(messageID, {
    status: "visible",
    session_id: sessionID,
    cwd: run.cwd,
    native_message_id: run.id,
  });
  return {
    Session: toSession(sessionID, run.cwd, "Hermes"),
    Receipt: {
      NativeMessageID: run.id,
      CanonicalNativeSessionID: sessionID,
      CanonicalNativeThreadID: sessionID,
      Accepted: true,
      Visible: true,
      Detail: "first message submitted to a new Hermes Desktop session",
    },
    Visibility: {
      Visible: true,
      Marker: text,
      Evidence: `session:${sessionID}`,
      CheckedAt: nowISO(),
      FailureReason: "",
    },
  };
}

async function desktopOpenDraft(req) {
  const draftID = firstNonEmpty(req && req.DraftID);
  if (!draftID) throw new Error("Hermes Desktop openDraft requires DraftID");
  purgeDrafts(desktopDrafts);
  const cwd = normalizeCwd(req && req.Cwd);
  const opened = await cdpController.openDesktopDraft(10000);
  const fingerprint = firstNonEmpty(opened && opened.fingerprint);
  if (!fingerprint) throw new Error("Hermes Desktop did not return a draft fingerprint");
  desktopDrafts.set(draftID, { draftID, cwd, fingerprint, openedAt: Date.now() });
  return { DraftID: draftID, Cwd: cwd, Controls: draftControls(), DraftFingerprint: fingerprint };
}

async function desktopControlDraft(req) {
  const draft = activeDraft(desktopDrafts, req && req.DraftID, "Desktop");
  await cdpController.assertDesktopDraft(draft.fingerprint);
  throw new Error(`unsupported draft control action: ${firstNonEmpty(req && req.Action, "unknown")}`);
}

async function desktopStartDraftWithMessage(req) {
  const draft = activeDraft(desktopDrafts, req && req.DraftID, "Desktop");
  await cdpController.assertDesktopDraft(draft.fingerprint);
  const result = await startSessionWithMessage(
    { ...req, Cwd: draft.cwd },
    { draftFingerprint: draft.fingerprint },
  );
  desktopDrafts.delete(draft.draftID);
  return result;
}

async function* subscribe(_session, signal) {
  const seen = new Set();
  const subscribedSessionID = firstNonEmpty(_session && _session.NativeSessionID, _session && _session.NativeThreadID);
  const releaseSubscription = retainSessionSubscription(subscribedSessionID);
  try {
    // `session.resume` is an owning operation in Hermes: it moves the live
    // session's single event transport to the caller. A detail subscription
    // must never call it, or merely opening Prism would steal Desktop events.
    // Mobile-originated runs register their live-to-stored mapping in
    // startDesktopRun(), before prompt.submit owns the transport.
    // The Hub creates this subscription after the forward send is accepted.
    // A fast Desktop rejection/completion can therefore already be in the
    // renderer's bounded Gateway event history. Start from this exact
    // Prism-owned run instead of an arbitrary one-second wall-clock window,
    // otherwise Mobile remains permanently "running" after that terminal
    // event is missed.
    const subscribedRun = activeRunForSession(subscribedSessionID);
    const runStartedAtMs = Number(subscribedRun && subscribedRun.startedAtMs) || 0;
    let sinceMs = runStartedAtMs > 0
      ? Math.max(0, runStartedAtMs - 2000)
      : Date.now() - 1000;
    let sequence = 0;
    while (!signal || !signal.aborted) {
      // Desktop foreground snapshots are produced exclusively by the
      // plugin-wide watcher. This per-session subscription carries only
      // Gateway lifecycle events for Prism-owned runs.
      let events = [];
      try {
        events = await recentGatewayEvents(sinceMs);
      } catch {
        await sleep(1000);
        continue;
      }
      for (const event of events) {
        sinceMs = Math.max(sinceMs, Number(event.received_at || Date.now()));
        const eventType = firstNonEmpty(event && event.type);
        const liveSessionID = firstNonEmpty(event && event.session_id);
        const sessionID = liveSessionID
          ? canonicalSessionIDForLive(liveSessionID)
          : canonicalSessionIDForUnscopedEvent(subscribedSessionID, eventType);
        const payload = event && event.payload && typeof event.payload === "object" ? event.payload : {};
        if (!sessionID || (subscribedSessionID && sessionID !== subscribedSessionID)) {
          continue;
        }
        const eventID = `gateway:${eventType}:${sessionID}:${Number(event.received_at || Date.now())}:${sequence++}`;
        const basePayload = {
          native_session_id: sessionID,
          native_thread_id: sessionID,
          live_session_id: liveSessionID,
        };
        if (eventType === "message.start") {
          yield {
            ID: eventID,
            Type: "message.started",
            Status: "running",
            Summary: "Hermes is responding",
            CreatedAt: nowISO(),
            Payload: basePayload,
          };
          continue;
        }
        if (eventType === "message.delta") {
          const text = firstNonEmpty(payload.text, payload.rendered);
          if (!text) continue;
          yield {
            ID: eventID,
            Type: "message.delta",
            Status: "running",
            Summary: text,
            CreatedAt: nowISO(),
            Payload: { ...basePayload, text },
          };
          continue;
        }
        if (eventType === "message.complete") {
          const text = firstNonEmpty(payload.text, payload.rendered);
          const interruptedRun = activeRunForSession(sessionID);
          if (interruptedRun && interruptedRun.interrupted) {
            const finalEvent = settleInterruptedRun(interruptedRun);
            yield {
              ID: eventID,
              Type: "run.failed",
              Status: "failed",
              Summary: finalEvent.Summary,
              CreatedAt: finalEvent.CreatedAt,
              Payload: finalEvent.Payload,
            };
            continue;
          }
          yield {
            ID: eventID,
            Type: "message.completed",
            Status: firstNonEmpty(payload.status, "completed"),
            Summary: text,
            CreatedAt: nowISO(),
            Payload: { ...basePayload, text, usage: payload.usage || null, reasoning: firstNonEmpty(payload.reasoning) },
          };
          continue;
        }
        if (eventType === "context.updated") {
          yield {
            ID: eventID,
            Type: "desktop.state.changed",
            Status: "idle",
            Summary: "Hermes context updated",
            CreatedAt: nowISO(),
            Payload: basePayload,
          };
          continue;
        }
        if (eventType !== "approval.request") {
          if (new Set(["thinking.delta", "reasoning.delta", "reasoning.available", "status.update", "tool.start", "tool.progress", "tool.complete", "tool.generating"]).has(eventType)) {
            yield {
              ID: eventID,
              Type: "run.progress",
              Status: "running",
              Summary: firstNonEmpty(payload.summary, payload.context, payload.preview, payload.text, payload.name, payload.kind, eventType),
              CreatedAt: nowISO(),
              Payload: { ...basePayload, kind: eventType, progress: payload },
            };
          } else if (eventType === "error") {
            yield {
              ID: eventID,
              Type: "run.failed",
              Status: "failed",
              Summary: firstNonEmpty(payload.message, payload.text, "Hermes Gateway error"),
              CreatedAt: nowISO(),
              Payload: basePayload,
            };
          }
          continue;
        }
        const approvalID = nativeApprovalID(event, sessionID);
        if (nativeApprovalWasResolved(approvalID, event && event.received_at)) {
          continue;
        }
        const dedupeID = `approval:${approvalID}:${sessionID}`;
        if (seen.has(dedupeID)) {
          continue;
        }
        seen.add(dedupeID);
        const approvalLiveSessionID = firstNonEmpty(
          liveSessionID,
          activeRunForSession(sessionID) && activeRunForSession(sessionID).liveSessionID,
        );
        if (approvalID && approvalLiveSessionID) {
          approvalLiveSessionByID.set(approvalID, approvalLiveSessionID);
        }
        yield {
          ID: dedupeID,
          Type: "approval.required",
          Status: "waiting_approval",
          Summary: firstNonEmpty(payload.command, payload.description, "Hermes is waiting for approval"),
          CreatedAt: nowISO(),
          Payload: {
            method: "approval.respond",
            approval_kind: "command_execution",
            approval_request_id: approvalID,
            native_session_id: sessionID,
            native_thread_id: sessionID,
            live_session_id: approvalLiveSessionID,
            command: firstNonEmpty(payload.command),
            description: firstNonEmpty(payload.description),
            title: firstNonEmpty(payload.command, "Hermes approval required"),
            summary: firstNonEmpty(payload.command, payload.description),
            allow_permanent: payload.allow_permanent !== false,
            actions: hermesApprovalActions(),
          },
        };
      }
      await sleep(800);
    }
  } finally {
    releaseSubscription();
  }
}

// The wide watcher keeps durable directory changes and the single visible
// Desktop surface separate. It never resumes Gateway transports, but does
// publish a verified CDP foreground snapshot so a mobile-initiated selection
// can become actionable after the renderer has switched sessions.
async function* subscribePlugin(signal) {
  const watcher = createHistoryWatcher(signal);
  let foregroundSignature = "";
  try {
    while (!signal || !signal.aborted) {
      const directoryChanged = await watcher.next(DESKTOP_INTERACTION_POLL_MS);
      if (directoryChanged) {
        yield {
          ID: `hermes:state-db:${Date.now()}`,
          Type: "desktop.session.directory.reconciled",
          Status: "completed",
          Summary: "Hermes Desktop session directory changed",
          CreatedAt: nowISO(),
          Payload: {},
        };
      }
      try {
        await syncDesktopGatewayEvents();
        const update = await pluginWideDesktopDetailEvent(foregroundSignature);
        foregroundSignature = update.signature;
        if (update.event) yield update.event;
      } catch {
        // CDP can be unavailable while Hermes Desktop is restarting. Keep the
        // directory watcher alive and retry on the next bounded poll.
      }
    }
  } finally {
    watcher.close();
  }
}

async function interrupt(session, taskID) {
  const direct = activeRuns.get(firstNonEmpty(taskID));
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const bySession = sessionID ? activeRuns.get(latestRunBySession.get(sessionID)) : null;
  const run = direct || bySession;
  if (HERMES_CONNECTION_MODE === "desktop") {
    const interactions = await readDesktopInteractionProjection(sessionID);
    if (!interactions.foreground || !interactions.live_session_id
      || !interactions.composer || interactions.composer.busy !== true) {
      throw new Error("hermes has no running Desktop turn for this conversation");
    }
    if (run) run.interrupted = true;
    await cdpController.cancelDesktopRun(sessionID, interactions.live_session_id);
    if (run) settleInterruptedRun(run);
    // A cancellation can finish without a SQLite write or Gateway terminal
    // event. Wake the wide watcher so the settled Composer snapshot reaches
    // remote clients instead of leaving their interrupt control stale.
    notifyHermesStateChanged();
    return;
  }
  if (!run) {
    throw new Error("hermes has no running Hermes process for this session");
  }
  run.interrupted = true;
  if (run.liveSessionID) {
    await hermesGateway().interrupt(run.liveSessionID);
    settleInterruptedRun(run);
    return;
  }
  if (run.child) {
    run.child.kill("SIGINT");
    settleInterruptedRun(run);
    return;
  }
  throw new Error("hermes has no interrupt target for this session");
}

async function resolveApproval(req) {
  const approvalID = firstNonEmpty(req && req.ApprovalRequestID, req && req.approval_request_id);
  const session = req && req.Session ? req.Session : {};
  const canonicalSessionID = firstNonEmpty(session.NativeSessionID, session.NativeThreadID);
  const actionID = firstNonEmpty(req && req.ActionID, req && req.action_id);
  const input = firstNonEmpty(req && req.Input, req && req.input);
  if (!approvalID || !actionID) {
    throw new Error("hermes resolveApproval requires an action id");
  }
  if (input) {
    throw new Error(`Hermes approval action does not accept input: ${actionID}`);
  }
  const known = desktopApprovalByID.get(approvalID);
  const controls = await readControlProjection(canonicalSessionID);
  const liveSessionID = firstNonEmpty(
    known && known.canonicalID === canonicalSessionID ? known.liveID : "",
    controls.live_session_id,
  );
  const interactions = await readDesktopInteractionProjection(canonicalSessionID, liveSessionID);
  const approval = interactions.approval;
  if (!approval
    || firstNonEmpty(approval.approval_request_id) !== approvalID
    || !Array.isArray(approval.actions)
    || !approval.actions.some((candidate) => firstNonEmpty(candidate && candidate.id) === actionID && candidate.available !== false)) {
    throw controlTargetStale("approval is no longer present on the current Hermes Desktop conversation");
  }
  await cdpController.executeDesktopInteraction("approval", canonicalSessionID, liveSessionID, {
    approvalID,
    actionID,
  });
}

async function verifyVisibility(session, marker) {
  const sessionID = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  if (!sessionID) {
    return {
      Visible: false,
      Marker: marker,
      Evidence: SESSION_DB,
      CheckedAt: nowISO(),
      FailureReason: "hermes session id is not resolved yet",
    };
  }
  const visible = await messageContainsMarker(sessionID, marker);
  return {
    Visible: visible,
    Marker: marker,
    Evidence: SESSION_DB,
    CheckedAt: nowISO(),
    FailureReason: visible ? "" : "marker not found in ~/.hermes/state.db messages",
  };
}

async function waitForRun(session, runID) {
  const run = activeRuns.get(firstNonEmpty(runID)) || completedRuns.get(firstNonEmpty(runID));
  if (!run) {
    throw new Error(`hermes run not found: ${runID}`);
  }
  const deadline = Date.now() + FINAL_RESULT_WAIT_MS;
  while (!run.finalEvent && Date.now() < deadline) {
    await Promise.race([run.donePromise, sleep(FINAL_RESULT_POLL_MS)]);
  }
  if (!run.finalEvent) {
    throw new Error("hermes waitForRun timed out before Hermes produced the final result");
  }
  if (run.canonicalSessionID && (!session || !firstNonEmpty(session.NativeSessionID))) {
    latestRunBySession.set(run.canonicalSessionID, run.id);
  }
  return run.finalEvent;
}

async function close() {
  const runs = Array.from(activeRuns.values());
  for (const run of runs) {
    try {
      run.interrupted = true;
      if (run.child) {
        run.child.kill("SIGINT");
      }
    } catch {
      // Best effort shutdown.
    }
  }
  if (gatewayClient) {
    gatewayClient.close();
    gatewayClient = null;
  }
  if (gatewayDiscoveryClient) {
    gatewayDiscoveryClient.close();
    gatewayDiscoveryClient = null;
  }
  cdpController.close();
}

const desktopAdapter = {
  id() {
    return "hermes";
  },
  async probe() {
    return capability(await hermesDesktopAvailable());
  },
  discover: discovery,
  startSessionWithMessage,
  openDraft: desktopOpenDraft,
  controlDraft: desktopControlDraft,
  startDraftWithMessage: desktopStartDraftWithMessage,
  listSessions,
  attachSession,
  selectSession,
  readHistory,
  readDetail,
  readHistoryStream,
  readStatus,
  controlSession,
  send,
  subscribe,
  subscribePlugin,
  interrupt,
  resolveApproval,
  verifyVisibility,
  waitForRun,
  close,
};

let nativeRuntime = null;
let nativeTuiRelay = null;

function nativeGatewayRuntime() {
  if (!nativeRuntime) {
    nativeRuntime = createHermesNativeRuntime({
      resolveHermesBin,
      cwd: DEFAULT_PROJECT_DIR,
    });
  }
  return nativeRuntime;
}

async function nativeEnsureLiveSession(sessionID, cwd = "") {
  const canonicalID = firstNonEmpty(sessionID);
  const gateway = hermesGateway();
  await gateway.ensureReady();
  const active = (await gateway.activeSessions()).filter((item) => (
    storedSessionID(item) === canonicalID && Boolean(liveSessionID(item))
  ));
  if (active.length === 1) {
    const liveID = liveSessionID(active[0]);
    canonicalSessionByLiveID.set(liveID, canonicalID);
    return { canonicalID, liveID };
  }
  const resumed = await gateway.resumeSession(canonicalID, cwd);
  const liveID = firstNonEmpty(resumed && resumed.session_id);
  const resolvedID = firstNonEmpty(resumed && resumed.session_key, resumed && resumed.resumed, canonicalID);
  if (!liveID || !resolvedID) throw new Error("Hermes Native could not resume the requested session");
  canonicalSessionByLiveID.set(liveID, resolvedID);
  return { canonicalID: resolvedID, liveID };
}

async function nativeListSessions() {
  const gateway = hermesGateway();
  await gateway.ensureReady();
  const rows = await listSessionRows(0);
  const listed = await gateway.listSessions();
  return nativeDirectoryRows(rows, listed, firstNonEmpty).map((row) => {
    const item = row.gateway_session || {};
    const id = firstNonEmpty(row && row.id);
    return {
      PluginID: "hermes",
      NativeSessionID: id,
      NativeThreadID: id,
      Surface: "hermes-native-gateway",
      Endpoint: sessionEndpoint(id),
      Cwd: firstNonEmpty(row.cwd, DEFAULT_PROJECT_DIR),
      // Gateway titles describe a short-lived terminal instance and can be a
      // project directory. The durable session title is the conversation name.
      Title: nativeDirectoryTitle(row, firstNonEmpty),
      Active: sessionRunActive(item),
      Visible: false,
      LastActivityAt: epochSecondsToISO(row.last_activity),
      Metadata: { source: firstNonEmpty(item && item.source, row.source, "native") },
    };
  }).filter((session) => session.NativeSessionID);
}

async function nativeAttachSession(req) {
  const id = firstNonEmpty(req && req.NativeSessionID, req && req.NativeThreadID);
  if (!id) throw new Error("hermes attachSession requires a native session id");
  const row = await findSessionByID(id);
  if (!row || asNumber(row.archived) === 1) throw new Error("hermes native session not found");
  return {
    ...toSession(id, row.cwd, row.title),
    Surface: "hermes-native-gateway",
    Endpoint: sessionEndpoint(id),
    Visible: false,
  };
}

async function nativeSelectSession(session) {
  const id = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const row = await findSessionByID(id);
  if (!row || asNumber(row.archived) === 1) throw new Error("hermes native session not found");
  const selected = await nativeEnsureLiveSession(id, row.cwd);
  // Resume can return before model/context metadata is ready. Warm the
  // read-only cache while the API opens the conversation state stream so the
  // first detail snapshot can include context without blocking selection.
  void refreshContext(selected.liveID).catch(() => {});
  return {
    ...toSession(selected.canonicalID, row.cwd, row.title),
    Surface: "hermes-native-gateway",
    Endpoint: sessionEndpoint(selected.canonicalID),
    Visible: false,
  };
}

async function nativeStartRun(existingSessionID, cwd, text, attachments = []) {
  const gateway = hermesGateway();
  await gateway.ensureReady();
  let canonicalSessionID = firstNonEmpty(existingSessionID);
  let liveSessionID = "";
  const canonicalCwd = normalizeCwd(cwd);
  let beforeMessageID = 0;
  if (canonicalSessionID) {
    const resumed = await nativeEnsureLiveSession(canonicalSessionID, canonicalCwd);
    canonicalSessionID = resumed.canonicalID;
    liveSessionID = resumed.liveID;
    beforeMessageID = await maxMessageID(canonicalSessionID);
  } else {
    const created = await gateway.createSession(canonicalCwd);
    liveSessionID = firstNonEmpty(created && created.session_id);
    canonicalSessionID = firstNonEmpty(created && created.stored_session_id, created && created.session_key);
    if (!liveSessionID || !canonicalSessionID) throw new Error("Hermes Native did not return a session identity");
    canonicalSessionByLiveID.set(liveSessionID, canonicalSessionID);
  }
  const prepared = await prepareHermesPrompt(gateway, liveSessionID, text, attachments);
  const run = {
    id: randomID(), child: null, stdout: "", stderr: "", exitCode: 0,
    interrupted: false, finalized: false, finalEvent: null,
    canonicalSessionID, liveSessionID, beforeMessageID, cwd: canonicalCwd,
    startedAtMs: Date.now(), text: prepared.submittedText,
    requestedText: text, attachments: prepared.attachments,
    visibilityMarker: prepared.visibilityMarker, native: true,
  };
  activeRuns.set(run.id, run);
  latestRunBySession.set(canonicalSessionID, run.id);
  await gateway.submitPromptAsync(liveSessionID, prepared.submittedText);
  run.donePromise = (async () => {
    const deadline = Date.now() + FINAL_RESULT_WAIT_MS;
    while (!run.finalEvent && Date.now() < deadline) {
      const rows = await readMessagesAfter(canonicalSessionID, beforeMessageID);
      const summary = latestAssistantSummary(rows);
      if (summary) {
        if (run.interrupted) {
          return settleInterruptedRun(run);
        }
        run.finalEvent = {
          ID: run.id, Type: "run.completed", Status: "completed", Summary: summary, CreatedAt: nowISO(),
          Payload: { native_session_id: canonicalSessionID, native_thread_id: canonicalSessionID, live_session_id: liveSessionID, cwd: canonicalCwd },
        };
        activeRuns.delete(run.id);
        if (latestRunBySession.get(canonicalSessionID) === run.id) latestRunBySession.delete(canonicalSessionID);
        trackCompletedRun(run);
        return run.finalEvent;
      }
      await sleep(FINAL_RESULT_POLL_MS);
    }
    if (!run.finalEvent) {
      if (run.interrupted) {
        return settleInterruptedRun(run);
      }
      run.finalEvent = {
        ID: run.id, Type: "run.failed", Status: "failed", Summary: "Hermes Native did not produce a final result before timeout", CreatedAt: nowISO(),
        Payload: { native_session_id: canonicalSessionID, native_thread_id: canonicalSessionID, live_session_id: liveSessionID, cwd: canonicalCwd },
      };
      activeRuns.delete(run.id);
      trackCompletedRun(run);
    }
    return run.finalEvent;
  })();
  return run;
}

async function nativeSend(session, msg) {
  const text = firstNonEmpty(msg && msg.Text);
  const attachments = Array.isArray(msg && msg.Attachments) ? msg.Attachments : [];
  if (!text && attachments.length === 0) throw new Error("hermes send requires text or attachments");
  const id = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const row = await findSessionByID(id);
  if (!row) throw new Error("hermes native session not found");
  const run = await nativeStartRun(id, row.cwd, text, attachments);
  const visible = await waitForVisibleUserMessage(run);
  if (!visible) throw new Error("Hermes Native could not confirm the user message");
  return {
    NativeMessageID: run.id, CanonicalNativeSessionID: run.canonicalSessionID,
    CanonicalNativeThreadID: run.canonicalSessionID, Accepted: true, Visible: true,
    Detail: "accepted by Hermes Native Gateway",
  };
}

async function nativeStartSessionWithMessage(req) {
  const message = req && req.Message && typeof req.Message === "object" ? req.Message : {};
  const messageID = firstNonEmpty(message.PrismMessageID);
  const text = firstNonEmpty(message.Text);
  const attachments = Array.isArray(message.Attachments) ? message.Attachments : [];
  if (!messageID || (!text && attachments.length === 0)) throw new Error("hermes startSessionWithMessage requires a message");
  const prior = readStartedSessions()[messageID];
  if (prior && prior.status === "visible" && prior.session_id) {
    return { Session: toSession(prior.session_id, prior.cwd, "Hermes"), Receipt: { NativeMessageID: firstNonEmpty(prior.native_message_id, messageID), CanonicalNativeSessionID: prior.session_id, CanonicalNativeThreadID: prior.session_id, Accepted: true, Visible: true, Detail: "duplicate Hermes Native start" }, Visibility: { Visible: true, Marker: text, Evidence: "persisted start result", CheckedAt: nowISO(), FailureReason: "" } };
  }
  if (prior && prior.session_id) throw new Error("hermes native start outcome is unknown; refusing duplicate first message");
  const run = await nativeStartRun("", normalizeCwd(req && req.Cwd), text, attachments);
  writeStartedSession(messageID, { status: "created", session_id: run.canonicalSessionID, cwd: run.cwd });
  const visible = await waitForVisibleUserMessage(run);
  if (!visible) throw new Error("Hermes Native could not confirm the first user message");
  writeStartedSession(messageID, { status: "visible", session_id: run.canonicalSessionID, cwd: run.cwd, native_message_id: run.id });
  return { Session: { ...toSession(run.canonicalSessionID, run.cwd, "Hermes"), Surface: "hermes-native-gateway", Visible: false }, Receipt: { NativeMessageID: run.id, CanonicalNativeSessionID: run.canonicalSessionID, CanonicalNativeThreadID: run.canonicalSessionID, Accepted: true, Visible: true, Detail: "first message submitted to Hermes Native Gateway" }, Visibility: { Visible: true, Marker: run.visibilityMarker, Evidence: `session:${run.canonicalSessionID}`, CheckedAt: nowISO(), FailureReason: "" } };
}

async function nativeOpenDraft(req) {
  const draftID = firstNonEmpty(req && req.DraftID);
  if (!draftID) throw new Error("Hermes Native openDraft requires DraftID");
  purgeDrafts(nativeDrafts);
  const cwd = normalizeCwd(req && req.Cwd);
  const fingerprint = randomID();
  nativeDrafts.set(draftID, { draftID, cwd, fingerprint, openedAt: Date.now() });
  return { DraftID: draftID, Cwd: cwd, Controls: draftControls(), DraftFingerprint: fingerprint };
}

async function nativeControlDraft(req) {
  activeDraft(nativeDrafts, req && req.DraftID, "Native");
  throw new Error(`unsupported draft control action: ${firstNonEmpty(req && req.Action, "unknown")}`);
}

async function nativeStartDraftWithMessage(req) {
  const draft = activeDraft(nativeDrafts, req && req.DraftID, "Native");
  const result = await nativeStartSessionWithMessage({ ...req, Cwd: draft.cwd });
  nativeDrafts.delete(draft.draftID);
  return result;
}

async function nativeDescribeControls(session) {
  const id = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  if (!id) throw new Error("hermes native controls require a session id");
  const row = await findSessionByID(id);
  if (!row) throw new Error("hermes native session not found");
  const runtime = await readStatus(session, "");
  const controls = await readControlProjection(id);
  const approval = await recentApprovalForSession(id);
  const snapshot = detailSnapshot({ ...session, NativeSessionID: id, NativeThreadID: id }, runtime, { ...controls, desktop_foreground: false, approval, session_actions: null });
  snapshot.detail_stale = false;
  snapshot.actions = snapshot.actions.map((action) => ({
    ...action,
    available: action.id === "model.switch"
      ? runtime.Status === "idle" && Boolean(controls.live_session_id) && controls.model_options.length > 0
      : action.id === "reasoning.switch"
        ? runtime.Status === "idle" && Boolean(controls.live_session_id) && controls.reasoning_options.length > 0
        : action.id === "rename" || action.id === "pin" || action.id === "archive" || action.id === "delete"
          ? false
          : action.available,
  }));
  return {
    ok: true,
    action: "controls.describe",
    message: "Hermes Native controls refreshed.",
    thread_id: id,
    details: snapshot,
    details_confirmed: true,
  };
}

async function nativeControlSession(req) {
  const session = req && (req.session || req.Session) || req;
  const id = firstNonEmpty(session && session.NativeSessionID, session && session.NativeThreadID);
  const action = normalizeAction(req && (req.action || req.Action));
  if (action === "conversation.select") {
    const selected = await nativeSelectSession(session);
    const described = await nativeDescribeControls(selected);
    return {
      ...described,
      action,
      thread_id: selected.NativeThreadID,
      message: "Hermes Native conversation selected.",
      details_confirmed: true,
    };
  }
  if (action === "controls.describe" || action === "describe.controls") return nativeDescribeControls(session);
  if (action === "model.switch") await switchHermesModel(id, req && (req.target || req.Target));
  else if (action === "reasoning.switch") await switchHermesReasoning(id, req && (req.target || req.Target));
  else throw new Error(`unsupported Hermes Native control action: ${action || "unknown"}`);
  const refreshed = await nativeDescribeControls(session);
  return { ...refreshed, action, message: "Hermes Native control applied.", details_confirmed: true };
}

async function nativeResolveApproval(req) {
  const approvalID = firstNonEmpty(req && req.ApprovalRequestID, req && req.approval_request_id);
  const actionID = firstNonEmpty(req && req.ActionID, req && req.action_id);
  const session = req && req.Session ? req.Session : {};
  const canonicalID = firstNonEmpty(session.NativeSessionID, session.NativeThreadID);
  if (!approvalID || !actionID || !canonicalID) throw new Error("hermes native approval requires session, request and action ids");
  // Hermes' Gateway responds by session + choice, not request ID. Re-read the
  // latest native event first so an old Mobile click cannot resolve a newer
  // approval that appeared on the same session.
  const latest = await recentApprovalForSession(canonicalID);
  if (!latest || firstNonEmpty(latest.approval_request_id) !== approvalID) {
    throw controlTargetStale("Hermes Native approval is no longer current");
  }
  if (!Array.isArray(latest.actions)
    || !latest.actions.some((candidate) => firstNonEmpty(candidate && candidate.id) === actionID && candidate.available !== false)) {
    throw controlTargetStale("Hermes Native approval action is no longer available");
  }
  const selected = await nativeEnsureLiveSession(canonicalID);
  const liveID = firstNonEmpty(approvalLiveSessionByID.get(approvalID), selected.liveID);
  await hermesGateway().respondApproval(actionID, liveID);
  resolvedNativeApprovalByID.set(approvalID, Date.now());
  approvalLiveSessionByID.delete(approvalID);
}

async function nativeDiscovery() {
  const runtime = nativeGatewayRuntime();
  const connection = await runtime.connection();
  return { PluginID: "hermes", Surface: "hermes-native-gateway", Endpoint: "Hermes Native Gateway RPC", ProcessID: runtime.pid(), SessionHints: { session_db: SESSION_DB, hermes_bin: firstNonEmpty(await resolveHermesBin(), "hermes"), default_cwd: DEFAULT_PROJECT_DIR, mode: "native-gateway-rpc", loopback_port: String(connection.port) }, Verified: true, Detail: "Hermes Native Gateway is running" };
}

async function nativeClose() {
  if (nativeTuiRelay) { await nativeTuiRelay.close(); nativeTuiRelay = null; }
  if (gatewayClient) { gatewayClient.close(); gatewayClient = null; }
  if (gatewayDiscoveryClient) { gatewayDiscoveryClient.close(); gatewayDiscoveryClient = null; }
  await nativeRuntime?.close();
  nativeRuntime = null;
}

async function nativeOpenManagedTerminal(req = {}) {
  const gateway = hermesGateway();
  await gateway.ensureReady();
  if (!nativeTuiRelay) nativeTuiRelay = createHermesTuiRelay({ gateway });
  const connection = await nativeTuiRelay.start();
  const bin = await resolveHermesBin();
  if (!bin) throw new Error("hermes executable is unavailable for managed TUI");
  launchManagedHermesTui({ bin, cwd: normalizeCwd(req.Cwd || DEFAULT_PROJECT_DIR), wsUrl: connection.wsUrl });
  return { ok: true, message: "Hermes managed terminal opened" };
}

async function* subscribeNativePlugin(signal) {
  const watcher = createHistoryWatcher(signal);
  let gatewayCursorMs = Date.now() - 1000;
  try {
    while (!signal || !signal.aborted) {
      if (await watcher.next(DESKTOP_INTERACTION_POLL_MS)) {
        yield {
          ID: `hermes:native:state-db:${Date.now()}`,
          Type: "desktop.session.directory.reconciled",
          Status: "completed",
          Summary: "Hermes Native session directory changed",
          CreatedAt: nowISO(),
          Payload: {},
        };
      }
      let events = [];
      try {
        events = await recentGatewayEvents(gatewayCursorMs);
      } catch {
        continue;
      }
      for (const event of events) {
        gatewayCursorMs = Math.max(gatewayCursorMs, Number(event.received_at || Date.now()));
        const eventType = firstNonEmpty(event && event.type);
        if (eventType !== "context.updated" && eventType !== "controls.updated") continue;
        const liveID = firstNonEmpty(event && event.session_id);
        const sessionID = canonicalSessionIDForLive(liveID);
        if (!sessionID || sessionID === liveID) continue;
        const row = await findSessionByID(sessionID);
        if (!row || asNumber(row.archived) === 1) continue;
        const session = {
          ...toSession(sessionID, row.cwd, row.title),
          Surface: "hermes-native-gateway",
          Endpoint: sessionEndpoint(sessionID),
          Visible: false,
        };
        const detail = (await nativeDescribeControls(session)).details;
        yield nativeDetailStateEvent(session, detail, liveID, nowISO());
      }
    }
  } finally {
    watcher.close();
  }
}

const nativeAdapter = {
  id() { return "hermes"; },
  async probe() {
    try { await nativeGatewayRuntime().connection(); await hermesGateway().ensureReady(); return { ...capability(true), NativeVisibleInput: false, NativeVisibleOutput: false, CanOpenManagedTerminal: true, VisibilitySurface: "hermes-native-gateway" }; }
    catch (error) { return { ...capability(false), NativeVisibleInput: false, NativeVisibleOutput: false, VisibilitySurface: "hermes-native-gateway", UnavailableReason: firstNonEmpty(error && error.message, "hermes_native_gateway_unavailable") }; }
  },
  discover: nativeDiscovery,
  startSessionWithMessage: nativeStartSessionWithMessage,
  openDraft: nativeOpenDraft,
  controlDraft: nativeControlDraft,
  startDraftWithMessage: nativeStartDraftWithMessage,
  listSessions: nativeListSessions,
  attachSession: nativeAttachSession,
  selectSession: nativeSelectSession,
  readHistory,
  readDetail: async (session) => (await nativeDescribeControls(session)).details,
  readHistoryStream,
  readStatus,
  controlSession: nativeControlSession,
  openManagedTerminal: nativeOpenManagedTerminal,
  send: nativeSend,
  subscribe,
  subscribePlugin: subscribeNativePlugin,
  interrupt,
  resolveApproval: nativeResolveApproval,
  verifyVisibility,
  waitForRun,
  close: nativeClose,
};

function unavailableAdapter(reason) {
  const fail = async () => { throw new Error(reason); };
  return {
    id() { return "hermes"; },
    async probe() { return { ...capability(false), UnavailableReason: reason }; },
    async discover() { return { PluginID: "hermes", Surface: "hermes", Endpoint: "", ProcessID: 0, SessionHints: {}, Verified: false, Detail: reason }; },
    startSessionWithMessage: fail,
    listSessions: fail,
    attachSession: fail,
    readHistory: fail,
    readDetail: fail,
    readHistoryStream: async function* () { yield { type: "error", source: "initial", operation: "append", error: reason }; },
    readStatus: fail,
    send: fail,
    subscribe: async function* () {},
    subscribePlugin: async function* () {},
    interrupt: fail,
    resolveApproval: fail,
    verifyVisibility: fail,
    waitForRun: fail,
    close,
  };
}

const adapter = HERMES_CONNECTION_MODE === "desktop"
  ? desktopAdapter
  : HERMES_CONNECTION_MODE === "native"
    ? (gatewayConnectionResolver = () => nativeGatewayRuntime().connection(), nativeAdapter)
    : unavailableAdapter(`unsupported Hermes connection mode: ${HERMES_CONNECTION_MODE}`);

pluginBridge.serve(adapter)
  .then(() => adapter.close())
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
