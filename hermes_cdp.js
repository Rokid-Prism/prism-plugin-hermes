"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

function requireCdpRuntime() {
  return require("@rokid/pluginbridge-plugin-sdk/cdp-runtime");
}

const {
  CdpPageClient,
  firstNonEmpty,
  sleep,
} = requireCdpRuntime();

const execFileAsync = promisify(execFile);

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_COMMAND_TIMEOUT_MS = 70000;

function desktopRouteSessionIDSource() {
  return `(() => {
    const raw = String(window.location.hash || '').replace(/^#\\/?/, '').split(/[?#]/)[0].trim();
    if (!raw || ['settings', 'profiles', 'skills', 'agents', 'cron', 'artifacts', 'command-center'].includes(raw)) return '';
    try { return decodeURIComponent(raw); } catch { return raw; }
  })()`;
}

function desktopIdentitySource() {
  return `(() => {
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    // HashRouter is the Desktop's authoritative selected durable session.
    // Composer props carry the separate live Gateway session and, depending on
    // the renderer version, can expose a queue key that is not the sidebar ID.
    const route = ${desktopRouteSessionIDSource()};
    const composer = document.querySelector('[data-slot="composer-root"]');
    const candidates = [];
    for (let fiber = fiberFor(composer), depth = 0; fiber && depth < 36; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const stored = typeof props.queueSessionKey === 'string' ? props.queueSessionKey.trim() : '';
      const live = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
      if (stored || live) candidates.push({ stored, live });
    }
    // A route mutation happens before the composer rebinds its live Gateway
    // session. Never combine the new route with the old composer's live ID:
    // that false pair makes a mobile selection appear successful and causes
    // the following detail read to target a different conversation.
    const routeMatch = route ? candidates.find((item) => item.stored === route) : null;
    const selected = routeMatch
      || (!route && (candidates.find((item) => item.stored) || candidates[0]))
      || { stored: '', live: '' };
    const stored = route || selected.stored;
    return { stored_session_id: stored, live_session_id: selected.live };
  })()`;
}

function desktopSessionHealthSource(expectedStoredSessionID, expectedLiveSessionID, timeoutMs = 1500) {
  return `(async () => {
    const expectedStored = ${JSON.stringify(String(expectedStoredSessionID || "").trim())};
    const expectedLive = ${JSON.stringify(String(expectedLiveSessionID || "").trim())};
    const timeout = ${Math.max(250, Number(timeoutMs) || 1500)};
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const route = ${desktopRouteSessionIDSource()};
    if (!expectedStored || !expectedLive || route !== expectedStored) {
      return { reachable: false, reason: 'desktop_identity_changed' };
    }
    const footer = document.querySelector('[data-slot="statusbar"]');
    let requestGateway = null;
    let activeLive = '';
    for (let fiber = fiberFor(footer), depth = 0; fiber && depth < 40; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const items of [props.items, props.leftItems]) {
        if (!Array.isArray(items)) continue;
        const contextItem = items.find((item) => item && item.id === 'context-usage');
        const contextProps = contextItem && contextItem.menuContent && contextItem.menuContent.props;
        if (contextProps && typeof contextProps.requestGateway === 'function') {
          requestGateway = contextProps.requestGateway;
          activeLive = String(contextProps.sessionId || '').trim();
          break;
        }
      }
      if (requestGateway) break;
    }
    if (!requestGateway || activeLive !== expectedLive) {
      return { reachable: null, reason: 'desktop_gateway_route_unavailable' };
    }
    const check = Promise.resolve()
      .then(() => requestGateway('session.status', { session_id: expectedLive }))
      .then(() => ({ reachable: true, reason: '' }))
      .catch((error) => {
        const message = String(error && error.message || error || '').trim();
        return /session not found/i.test(message)
          ? { reachable: false, reason: 'session_not_found' }
          : { reachable: null, reason: message || 'session_status_failed' };
      });
    return Promise.race([
      check,
      new Promise((resolve) => setTimeout(
        () => resolve({ reachable: null, reason: 'session_status_timeout' }),
        timeout,
      )),
    ]);
  })()`;
}

function selectDesktopComposerCandidate(route, expectedStored, expectedLive, candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const routeMatch = route ? rows.find((item) => item.stored === route) : null;
  const verifiedLiveMatch = route && route === expectedStored && expectedLive
    ? rows.find((item) => item.live === expectedLive)
    : null;
  return routeMatch
    || verifiedLiveMatch
    || (!route && (rows.find((item) => item.stored) || rows[0]))
    || { stored: "", live: "" };
}

// Resolve the one mounted ChatBar that owns the current route. The returned
// object intentionally contains live React values and is only embedded inside
// renderer-side operations; it must never be returned over CDP directly.
function desktopComposerRuntimeSource(expectedStoredSessionID = "", expectedLiveSessionID = "") {
  return `(() => {
    const expectedStored = ${JSON.stringify(String(expectedStoredSessionID || "").trim())};
    const expectedLive = ${JSON.stringify(String(expectedLiveSessionID || "").trim())};
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const propsFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactProps$'));
      return key ? element[key] : null;
    };
    const route = ${desktopRouteSessionIDSource()};
    const composer = document.querySelector('[data-slot="composer-root"]');
    if (!composer) return null;
    const candidates = [];
    const seenProps = new Set();
    for (let fiber = fiberFor(composer), depth = 0; fiber && depth < 48; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object' || seenProps.has(props)
        || !Object.prototype.hasOwnProperty.call(props, 'sessionId')
        || !Object.prototype.hasOwnProperty.call(props, 'queueSessionKey')
        || typeof props.busy !== 'boolean' || typeof props.disabled !== 'boolean'
        || typeof props.onSubmit !== 'function' || typeof props.onCancel !== 'function') continue;
      seenProps.add(props);
      candidates.push({
        props,
        stored: typeof props.queueSessionKey === 'string' ? props.queueSessionKey.trim() : '',
        live: typeof props.sessionId === 'string' ? props.sessionId.trim() : '',
      });
    }
    const matches = candidates.filter((candidate) => {
      if (!expectedStored) {
        return !route && !candidate.stored && !candidate.live;
      }
      if (route !== expectedStored) return false;
      if (expectedLive && candidate.live !== expectedLive) return false;
      return candidate.stored === expectedStored
        || (!candidate.stored && expectedLive && candidate.live === expectedLive);
    });
    if (matches.length !== 1) return null;
    const selected = matches[0];
    const editor = composer.querySelector('[data-slot="composer-rich-input"]');
    let attachmentProps = null;
    const attachmentSurface = composer.querySelector('[data-slot="composer-attachments"]');
    for (let fiber = fiberFor(attachmentSurface), depth = 0; fiber && depth < 24; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      if (props && Array.isArray(props.attachments)) {
        attachmentProps = props;
        break;
      }
    }
    return {
      route,
      stored: expectedStored || selected.stored,
      live: selected.live,
      props: selected.props,
      gateway: selected.props.gateway,
      composer,
      editor,
      formProps: propsFor(composer),
      attachmentProps,
    };
  })()`;
}

function desktopDraftStateSource(expectedFingerprint = "", createFingerprint = false) {
  const runtimeSource = desktopComposerRuntimeSource("", "");
  return `(() => {
    const runtime = ${runtimeSource};
    if (!runtime || !runtime.composer || !runtime.editor) {
      return { ok: false, error: 'desktop_draft_unavailable' };
    }
    const text = String(runtime.editor.innerText || runtime.editor.textContent || '').trim();
    const attachments = runtime.attachmentProps && Array.isArray(runtime.attachmentProps.attachments)
      ? runtime.attachmentProps.attachments : [];
    if (text || attachments.length > 0) {
      return { ok: false, error: 'desktop_draft_occupied' };
    }
    if (runtime.props.disabled === true || runtime.editor.getAttribute('contenteditable') !== 'true') {
      return { ok: false, error: 'desktop_draft_disabled' };
    }
    const key = Symbol.for('prism.hermes.desktop-draft-fingerprint.v1');
    const expected = ${JSON.stringify(String(expectedFingerprint || "").trim())};
    let fingerprint = String(runtime.composer[key] || '').trim();
    if (!fingerprint && ${createFingerprint === true}) {
      fingerprint = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : [Date.now(), Math.random()].join('-');
      Object.defineProperty(runtime.composer, key, {
        value: fingerprint,
        configurable: true,
      });
    }
    if (expected && fingerprint !== expected) {
      return { ok: false, error: 'desktop_draft_changed' };
    }
    return { ok: true, fingerprint };
  })()`;
}

function desktopGatewayRequestSource(expectedStoredSessionID, expectedLiveSessionID, method, params, timeoutMs) {
  const runtimeSource = desktopComposerRuntimeSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(async () => {
    const runtime = ${runtimeSource};
    const method = ${JSON.stringify(String(method || "").trim())};
    const params = ${JSON.stringify(params && typeof params === "object" ? params : {})};
    const timeout = ${Math.max(250, Number(timeoutMs) || 15000)};
    if (!runtime || !runtime.gateway || typeof runtime.gateway.request !== 'function') {
      return { ok: false, error: 'desktop_gateway_unavailable' };
    }
    if (params.session_id && String(params.session_id) !== runtime.live) {
      return { ok: false, error: 'desktop_identity_changed' };
    }
    try {
      const result = await runtime.gateway.request(method, params, timeout);
      const verified = ${runtimeSource};
      if (!verified || verified.gateway !== runtime.gateway || verified.live !== runtime.live) {
        return { ok: false, error: 'desktop_identity_changed' };
      }
      return { ok: true, result: result === undefined ? null : result };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error || 'desktop_gateway_request_failed') };
    }
  })()`;
}

function desktopGatewayMutationSource(expectedStoredSessionID, expectedLiveSessionID, method, params, timeoutMs) {
  const runtimeSource = desktopComposerRuntimeSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(() => {
    const runtime = ${runtimeSource};
    const method = ${JSON.stringify(String(method || "").trim())};
    const params = ${JSON.stringify(params && typeof params === "object" ? params : {})};
    const timeout = ${Math.max(250, Number(timeoutMs) || 120000)};
    if (!runtime || !runtime.gateway || typeof runtime.gateway.request !== 'function') {
      return { ok: false, error: 'desktop_gateway_unavailable' };
    }
    if (params.session_id && String(params.session_id) !== runtime.live) {
      return { ok: false, error: 'desktop_identity_changed' };
    }
    const key = Symbol.for('prism.hermes.desktop-gateway-mutations.v1');
    const registry = window[key] || (window[key] = { next: 0, entries: new Map() });
    const mutationId = 'desktop-gateway-mutation-' + (++registry.next).toString(36);
    const entry = {
      id: mutationId,
      method,
      params,
      stored_session_id: runtime.stored,
      live_session_id: runtime.live,
      status: 'pending',
      started_at: Date.now(),
    };
    registry.entries.set(mutationId, entry);
    while (registry.entries.size > 64) registry.entries.delete(registry.entries.keys().next().value);
    try {
      Promise.resolve(runtime.gateway.request(method, params, timeout)).then(
        (result) => {
          entry.status = 'completed';
          entry.completed_at = Date.now();
          entry.result_received = result !== undefined;
        },
        (error) => {
          entry.status = 'failed';
          entry.completed_at = Date.now();
          entry.error = String(error && error.message || error || 'desktop_gateway_request_failed');
        },
      );
    } catch (error) {
      registry.entries.delete(mutationId);
      return { ok: false, error: String(error && error.message || error || 'desktop_gateway_request_failed') };
    }
    return { ok: true, mutation_id: mutationId };
  })()`;
}

function desktopGatewayEventRegistrySource(runtimeVariable = "runtime") {
  return `(() => {
    const owner = ${runtimeVariable};
    if (!owner || !owner.gateway || typeof owner.gateway.onEvent !== 'function') return null;
    const key = Symbol.for('prism.hermes.desktop-gateway-events.v1');
    const registry = window[key] || (window[key] = {
      next: 0,
      events: [],
      subscriptions: new WeakMap(),
    });
    if (!registry.subscriptions.has(owner.gateway)) {
      const unsubscribe = owner.gateway.onEvent((event) => {
        let payload = null;
        try { payload = JSON.parse(JSON.stringify(event)); } catch {}
        if (!payload || typeof payload !== 'object') return;
        registry.events.push({
          ...payload,
          prism_sequence: ++registry.next,
          received_at: Date.now(),
        });
        if (registry.events.length > 512) registry.events.splice(0, registry.events.length - 512);
      });
      registry.subscriptions.set(owner.gateway, unsubscribe || true);
    }
    return registry;
  })()`;
}

function desktopGatewayEventsSource(expectedStoredSessionID, expectedLiveSessionID, afterSequence = 0) {
  const runtimeSource = desktopComposerRuntimeSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(() => {
    const runtime = ${runtimeSource};
    const registry = ${desktopGatewayEventRegistrySource("runtime")};
    if (!registry) {
      return { ok: false, error: 'desktop_gateway_unavailable', cursor: ${Math.max(0, Number(afterSequence) || 0)}, events: [] };
    }
    const after = ${Math.max(0, Number(afterSequence) || 0)};
    return {
      ok: true,
      cursor: registry.next,
      events: registry.events.filter((event) => Number(event.prism_sequence || 0) > after),
    };
  })()`;
}

function desktopSubmitPromptSource(expectedStoredSessionID, expectedLiveSessionID, text, attachmentPaths, timeoutMs, expectedDraftFingerprint = "") {
  const runtimeSource = desktopComposerRuntimeSource(expectedStoredSessionID, expectedLiveSessionID);
  const prompt = String(text || "");
  const paths = Array.isArray(attachmentPaths)
    ? attachmentPaths.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return `(async () => {
    const expectedText = ${JSON.stringify(prompt)};
    const attachmentPaths = ${JSON.stringify(paths)};
    const deadline = Date.now() + ${Math.max(1000, Number(timeoutMs) || 15000)};
    const plainText = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.dataset && node.dataset.refText) return node.dataset.refText;
      if (node.tagName === 'BR') return '\\n';
      const value = Array.from(node.childNodes).map(plainText).join('');
      const block = node.tagName === 'DIV' || node.tagName === 'P';
      return block && value && node.dataset.slot !== 'composer-rich-input' ? value + '\\n' : value;
    };
    const queueEntries = (stored) => {
      try {
        const parsed = JSON.parse(localStorage.getItem('hermes.desktop.composerQueue.v1') || '{}');
        return parsed && Array.isArray(parsed[stored]) ? parsed[stored] : [];
      } catch { return []; }
    };
    const submittedComposerState = () => {
      const route = ${desktopRouteSessionIDSource()};
      const composer = document.querySelector('[data-slot="composer-root"]');
      const editor = composer && composer.querySelector('[data-slot="composer-rich-input"]');
      const fiberFor = (element) => {
        const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
        return key ? element[key] : null;
      };
      let attachments = [];
      const attachmentSurface = composer && composer.querySelector('[data-slot="composer-attachments"]');
      for (let fiber = fiberFor(attachmentSurface), depth = 0; fiber && depth < 24; fiber = fiber.return, depth += 1) {
        const props = fiber.memoizedProps;
        if (props && Array.isArray(props.attachments)) {
          attachments = props.attachments;
          break;
        }
      }
      return { route, text: plainText(editor), attachments };
    };
    const clearInjectedAttachments = async () => {
      const current = ${runtimeSource};
      const items = current && current.attachmentProps && Array.isArray(current.attachmentProps.attachments)
        ? current.attachmentProps.attachments : [];
      if (!current || typeof current.props.onRemoveAttachment !== 'function') return;
      for (const item of items) {
        const id = String(item && item.id || '');
        if (id) await current.props.onRemoveAttachment(id);
      }
    };
    let runtime = ${runtimeSource};
    if (!runtime || !runtime.editor || !runtime.formProps || typeof runtime.formProps.onSubmit !== 'function') {
      return { ok: false, error: 'desktop_composer_unavailable' };
    }
    const expectedDraftFingerprint = ${JSON.stringify(String(expectedDraftFingerprint || "").trim())};
    if (expectedDraftFingerprint) {
      const key = Symbol.for('prism.hermes.desktop-draft-fingerprint.v1');
      if (String(runtime.composer && runtime.composer[key] || '').trim() !== expectedDraftFingerprint) {
        return { ok: false, error: 'desktop_draft_changed' };
      }
    }
    if (!${desktopGatewayEventRegistrySource("runtime")}) {
      return { ok: false, error: 'desktop_gateway_unavailable' };
    }
    const initialAttachments = runtime.attachmentProps && Array.isArray(runtime.attachmentProps.attachments)
      ? runtime.attachmentProps.attachments : [];
    if (plainText(runtime.editor).trim() || initialAttachments.length > 0) {
      return { ok: false, error: 'composer_occupied' };
    }
    if (runtime.props.disabled === true || runtime.editor.getAttribute('contenteditable') !== 'true') {
      return { ok: false, error: 'desktop_composer_disabled' };
    }
    if (attachmentPaths.length > 0) {
      if (typeof runtime.props.onAttachDroppedItems !== 'function') {
        return { ok: false, error: 'desktop_attachments_unavailable' };
      }
      const attached = await runtime.props.onAttachDroppedItems(
        attachmentPaths.map((path) => ({ path, isDirectory: false })),
      );
      if (attached === false) {
        await clearInjectedAttachments();
        return { ok: false, error: 'desktop_attachment_failed' };
      }
      while (Date.now() < deadline) {
        runtime = ${runtimeSource};
        const items = runtime && runtime.attachmentProps && Array.isArray(runtime.attachmentProps.attachments)
          ? runtime.attachmentProps.attachments : [];
        if (items.some((item) => item && item.uploadState === 'error')) {
          await clearInjectedAttachments();
          return { ok: false, error: 'desktop_attachment_failed' };
        }
        if (items.length >= attachmentPaths.length
          && !items.some((item) => item && item.uploadState === 'uploading')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      runtime = ${runtimeSource};
      const attachedItems = runtime && runtime.attachmentProps && Array.isArray(runtime.attachmentProps.attachments)
        ? runtime.attachmentProps.attachments : [];
      if (attachedItems.length < attachmentPaths.length
        || attachedItems.some((item) => item && item.uploadState)) {
        await clearInjectedAttachments();
        return { ok: false, error: 'desktop_attachment_timeout' };
      }
    }
    runtime = ${runtimeSource};
    if (!runtime || !runtime.editor || !runtime.formProps || typeof runtime.formProps.onSubmit !== 'function') {
      return { ok: false, error: 'desktop_identity_changed' };
    }
    runtime.editor.replaceChildren();
    expectedText.split('\\n').forEach((line, index) => {
      if (index > 0) runtime.editor.append(document.createElement('br'));
      if (line) runtime.editor.append(document.createTextNode(line));
    });
    const input = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: expectedText })
      : new Event('input', { bubbles: true });
    runtime.editor.dispatchEvent(input);
    await Promise.resolve();
    runtime = ${runtimeSource};
    if (!runtime || plainText(runtime.editor) !== expectedText) {
      await clearInjectedAttachments();
      return { ok: false, error: 'desktop_composer_write_failed' };
    }
    const beforeQueue = new Set(queueEntries(runtime.stored).map((entry) => String(entry && entry.id || '')).filter(Boolean));
    const busy = runtime.props.busy === true;
    // Dispatch through the mounted form rather than invoking React's prop
    // directly. Hermes routes a busy Composer through submitDraft(), which
    // enqueues the draft; calling the captured prop bypasses that state
    // machine and sends a second turn immediately.
    const submitted = runtime.composer.dispatchEvent(new Event('submit', {
      bubbles: true,
      cancelable: true,
    }));
    if (submitted !== false) {
      await clearInjectedAttachments();
      return { ok: false, error: 'desktop_submit_not_handled' };
    }
    // Let React commit the input handler and Hermes' queue atom before
    // reading localStorage below.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (busy && runtime.stored) {
      while (Date.now() < deadline) {
        const added = queueEntries(runtime.stored).find((entry) => {
          const id = String(entry && entry.id || '');
          return id && !beforeQueue.has(id);
        });
        if (added) {
          return {
            ok: true,
            outcome: 'queue_visible',
            queue_item_id: String(added.id),
            stored_session_id: runtime.stored,
            live_session_id: runtime.live,
          };
        }
        const current = ${runtimeSource};
        if (!current) return { ok: false, error: 'desktop_identity_changed' };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        ok: true,
        outcome: 'queue_pending',
        queue_item_id: '',
        stored_session_id: runtime.stored,
        live_session_id: runtime.live,
      };
    }
    while (Date.now() < deadline) {
      const submitted = submittedComposerState();
      const routeReady = runtime.stored
        ? submitted.route === runtime.stored
        : Boolean(submitted.route);
      if (routeReady && !submitted.text.trim() && submitted.attachments.length === 0) {
        return {
          ok: true,
          outcome: 'submitted',
          queue_item_id: '',
          stored_session_id: runtime.stored || submitted.route,
          live_session_id: runtime.live,
        };
      }
      if (runtime.stored && submitted.route !== runtime.stored) {
        return { ok: false, error: 'desktop_identity_changed' };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, error: 'desktop_submit_timeout' };
  })()`;
}

function desktopCancelSource(expectedStoredSessionID, expectedLiveSessionID) {
  const runtimeSource = desktopComposerRuntimeSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(async () => {
    const runtime = ${runtimeSource};
    if (!runtime || runtime.props.busy !== true || typeof runtime.props.onCancel !== 'function') {
      return { ok: false, error: 'desktop_interrupt_unavailable' };
    }
    await runtime.props.onCancel();
    return { ok: true };
  })()`;
}

function desktopSessionDirectorySource() {
  return `(() => {
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    const sidebarFiber = fiberFor(sidebar);
    if (!sidebarFiber) return [];
    const visited = new Set();
    const groups = [];
    const collect = (fiber) => {
      const props = fiber && fiber.memoizedProps;
      const sessions = props && Array.isArray(props.sessions) ? props.sessions : null;
      if (sessions && sessions.length > 0 && sessions.every((session) => session && typeof session.id === 'string' && session.id.trim())) {
        groups.push(sessions.map((session) => session.id.trim()));
      }
    };
    const visit = (fiber, depth) => {
      if (!fiber || visited.has(fiber) || depth > 220) return;
      visited.add(fiber);
      collect(fiber);
      visit(fiber.child, depth + 1);
      visit(fiber.sibling, depth);
    };
    // A sidebar list can be owned by a React component immediately above the
    // host element, so inspect that ancestor chain. Do not start from the
    // application root: it would also see session arrays from the composer,
    // history and other non-directory surfaces.
    for (let fiber = sidebarFiber, depth = 0; fiber && depth < 80; fiber = fiber.return, depth += 1) collect(fiber);
    visit(sidebarFiber.child, 0);
    const seen = new Set();
    const ordered = [];
    for (const group of groups) {
      for (const id of group) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
    return ordered;
  })()`;
}

// These IDs are deliberately renderer-runtime scoped. They bind an opaque
// Prism target to the exact React handler currently mounted by Hermes Desktop;
// a re-render or session switch makes the old target stale instead of guessing
// from translated labels or a button position.
function desktopInteractionSource(expectedStoredSessionID = "", expectedLiveSessionID = "") {
  return `(() => {
    const expectedStored = ${JSON.stringify(String(expectedStoredSessionID || "").trim())};
    const expectedLive = ${JSON.stringify(String(expectedLiveSessionID || "").trim())};
    const registryKey = Symbol.for('prism.hermes.desktop-interactions.v1');
    const registry = window[registryKey] || (window[registryKey] = {
      actions: new WeakMap(), requests: new WeakMap(), next: 0,
    });
    const token = (map, value, prefix) => {
      if (!value || (typeof value !== 'function' && typeof value !== 'object')) return '';
      let valueToken = map.get(value);
      if (!valueToken) {
        valueToken = prefix + '-' + (++registry.next).toString(36);
        map.set(value, valueToken);
      }
      return valueToken;
    };
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const propsFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactProps$'));
      return key ? element[key] : null;
    };
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const text = (element) => String(element && element.textContent || '').replace(/\\s+/g, ' ').trim();
    // The selected durable ID belongs to the Router, while sessionId below
    // is the live Gateway identity used to scope transient Desktop controls.
    const route = ${desktopRouteSessionIDSource()};
    const composer = document.querySelector('[data-slot="composer-root"]');
    const selectedCandidates = [];
    for (let fiber = fiberFor(composer), depth = 0; fiber && depth < 36; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const stored = typeof props.queueSessionKey === 'string' ? props.queueSessionKey.trim() : '';
      const live = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
      if (stored || live) selectedCandidates.push({ stored, live });
    }
    // See desktopIdentitySource: the current route must be paired only with a
    // composer that explicitly names that same durable session.
    // A verified Gateway live ID can bridge the short renderer window where
    // the composer has rebound its live session but has not restored the
    // durable queueSessionKey prop yet. The caller only supplies expectedLive
    // after resolving exactly one active Gateway session for expectedStored.
    const composerSelected = (${selectDesktopComposerCandidate.toString()})(
      route, expectedStored, expectedLive, selectedCandidates,
    );
    const selected = { stored: route || composerSelected.stored, live: composerSelected.live };
    const scoped = Boolean(selected.stored
      && (!expectedStored || selected.stored === expectedStored)
      && (!expectedLive || selected.live === expectedLive));
    const runtime = ${desktopComposerRuntimeSource(expectedStoredSessionID, expectedLiveSessionID)};
    const runtimeAttachments = runtime && runtime.attachmentProps && Array.isArray(runtime.attachmentProps.attachments)
      ? runtime.attachmentProps.attachments : [];
    const composerState = scoped && runtime && runtime.editor ? {
      content: String(runtime.editor.textContent || ''),
      editable: runtime.editor.getAttribute('contenteditable') === 'true'
        && runtime.editor.getAttribute('aria-disabled') !== 'true'
        && runtime.props.disabled !== true,
      busy: runtime.props.busy === true,
      disabled: runtime.props.disabled === true,
      cwd: String(runtime.props.cwd || ''),
      model: String(runtime.props.state && runtime.props.state.model && runtime.props.state.model.model || ''),
      provider: String(runtime.props.state && runtime.props.state.model && runtime.props.state.model.provider || ''),
      attachments: runtimeAttachments.map((item) => ({
        id: String(item && item.id || ''),
        label: String(item && item.label || ''),
        kind: String(item && item.kind || ''),
        upload_state: String(item && item.uploadState || ''),
      })),
    } : null;
    let storedQueue = {};
    try {
      const raw = localStorage.getItem('hermes.desktop.composerQueue.v1');
      const parsed = raw ? JSON.parse(raw) : {};
      storedQueue = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
    const entries = scoped && Array.isArray(storedQueue[selected.stored]) ? storedQueue[selected.stored] : [];
    const entryIDs = new Set(entries.map((entry) => String(entry && entry.id || '').trim()).filter(Boolean));
    const sameEntrySet = (candidate) => Array.isArray(candidate)
      && candidate.length === entries.length
      && candidate.length > 0
      && candidate.every((entry) => entry && entryIDs.has(String(entry.id || '').trim()));
    const rootFor = (element) => {
      let root = fiberFor(element);
      while (root && root.return) root = root.return;
      return root;
    };
    const queuePanel = (() => {
      if (!scoped || !composer || entryIDs.size === 0) return null;
      const seen = new Set();
      const visit = (fiber, depth) => {
        if (!fiber || seen.has(fiber) || depth > 180) return null;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        if (props && sameEntrySet(props.entries)
          && typeof props.onEdit === 'function'
          && typeof props.onDelete === 'function'
          && typeof props.onSendNow === 'function') {
          return { fiber, props };
        }
        return visit(fiber.child, depth + 1) || visit(fiber.sibling, depth);
      };
      return visit(rootFor(composer), 0);
    })();
    const actionsByItem = new Map();
    if (queuePanel) {
      const actions = [
        { handler: queuePanel.props.onEdit, kind: 'edit' },
        { handler: queuePanel.props.onSendNow, kind: 'send_now' },
        { handler: queuePanel.props.onDelete, kind: 'delete' },
      ];
      for (const entry of entries) {
        const itemID = String(entry && entry.id || '').trim();
        if (!itemID) continue;
        actionsByItem.set(itemID, actions.map(({ handler, kind }) => {
          const actionToken = token(registry.actions, handler, 'queue-action');
          // The semantic key is not inferred from a translated DOM label. Hub
          // keeps it opaque and Mobile renders the returned display label.
          return actionToken ? { id: 'queue.hermes.' + itemID + '.' + actionToken, label: kind, available: true } : null;
        }).filter(Boolean));
      }
    }
    const queueItems = entries.map((entry) => {
      const id = String(entry && entry.id || '').trim();
      return {
        id,
        content: String(entry && entry.text || '').trim() || '[attachment]',
        actions: actionsByItem.get(id) || [],
        has_more_actions: false,
      };
    }).filter((item) => item.id && item.content);
    // Sidebar session actions are passed from the same session row that owns
    // the stored session object. Do not discover them by menu text or button
    // placement: duplicated Fiber wrappers are accepted only when they retain
    // the exact same callback identity and pinned state.
    const directSessionActionCandidates = [];
    const collectionSessionActionCandidates = [];
    const legacySessionActionCandidates = [];
    if (scoped && composer) {
      let pinnedSessionIDs = new Set();
      try {
        const raw = localStorage.getItem('hermes.desktop.pinnedSessions');
        const parsed = raw ? JSON.parse(raw) : [];
        pinnedSessionIDs = new Set(Array.isArray(parsed)
          ? parsed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
          : []);
      } catch {}
      const seen = new Set();
      const visit = (fiber, depth) => {
        if (!fiber || seen.has(fiber) || depth > 240) return;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const rowSession = props && typeof props === 'object' && props.session && typeof props.session === 'object'
          ? props.session : null;
        const rowID = rowSession ? String(rowSession.id || '') : '';
        const pinID = rowSession ? String(rowSession._lineage_root_id || rowID) : '';
        const pinned = Boolean(pinID && pinnedSessionIDs.has(pinID));
        const rowPinned = Boolean(props && (props.isPinned === true || props.pinned === true));
        const directSessionID = props && typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
        if (directSessionID === selected.stored
          && typeof props.pinned === 'boolean'
          && (typeof props.onPin === 'function' || typeof props.onDelete === 'function')) {
          directSessionActionCandidates.push({
            pinned: props.pinned,
            pin_action_id: typeof props.onPin === 'function'
              ? 'hermes.session.pin.' + token(registry.actions, props.onPin, 'session-pin') : '',
            delete_action_id: typeof props.onDelete === 'function'
              ? 'hermes.session.delete.' + token(registry.actions, props.onDelete, 'session-delete') : '',
          });
        }
        const ownsSelectedSession = (Array.isArray(props && props.sessions)
          && props.sessions.some((item) => item && String(item.id || '') === selected.stored))
          || (Array.isArray(props && props.entries)
            && props.entries.some((item) => item && item.session
              && String(item.session.id || '') === selected.stored));
        if (ownsSelectedSession && String(props.activeSessionId || '') === selected.stored
          && (typeof props.onTogglePin === 'function'
            || typeof props.onArchiveSession === 'function'
            || typeof props.onDeleteSession === 'function')) {
          collectionSessionActionCandidates.push({
            pinned,
            pin_action_id: typeof props.onTogglePin === 'function'
              ? 'hermes.session.pin.' + token(registry.actions, props.onTogglePin, 'session-pin') : '',
            archive_action_id: typeof props.onArchiveSession === 'function'
              ? 'hermes.session.archive.' + token(registry.actions, props.onArchiveSession, 'session-archive') : '',
            delete_action_id: typeof props.onDeleteSession === 'function'
              ? 'hermes.session.delete.' + token(registry.actions, props.onDeleteSession, 'session-delete') : '',
          });
        }
        if (rowSession && rowID === selected.stored
          // A pinned session is intentionally rendered twice: once in the
          // PINNED group and once in its ordinary project group. Only the row
          // matching localStorage's current pin state is its native action
          // owner; the other is a display duplicate with another callback.
          && rowPinned === pinned
          && (typeof props.onPin === 'function'
            || typeof props.onArchive === 'function'
            || typeof props.onDelete === 'function')) {
          const pinToken = token(registry.actions, props.onPin, 'session-pin');
          const archiveToken = token(registry.actions, props.onArchive, 'session-archive');
          const deleteToken = token(registry.actions, props.onDelete, 'session-delete');
          const renameToken = token(
            registry.actions,
            window.hermesDesktop && window.hermesDesktop.api,
            'session-rename',
          );
          if (pinToken || archiveToken || deleteToken || renameToken) {
            legacySessionActionCandidates.push({
              pinned,
              rename_action_id: renameToken ? 'hermes.session.rename.' + renameToken : '',
              pin_action_id: pinToken ? 'hermes.session.pin.' + pinToken : '',
              archive_action_id: archiveToken ? 'hermes.session.archive.' + archiveToken : '',
              delete_action_id: deleteToken ? 'hermes.session.delete.' + deleteToken : '',
            });
          }
        }
        visit(fiber.child, depth + 1);
        visit(fiber.sibling, depth);
      };
      visit(rootFor(composer), 0);
    }
    const uniqueAction = (candidates, key) => {
      const values = [...new Set(candidates.map((candidate) => candidate[key]).filter(Boolean))];
      return values.length === 1 ? values[0] : '';
    };
    const directPinnedStates = new Set(directSessionActionCandidates.map((candidate) => String(candidate.pinned)));
    const allSessionActionCandidates = [
      ...directSessionActionCandidates,
      ...collectionSessionActionCandidates,
      ...legacySessionActionCandidates,
    ];
    const api = window.hermesDesktop && window.hermesDesktop.api;
    const renameToken = typeof api === 'function' ? token(registry.actions, api, 'session-rename') : '';
    const pinAction = uniqueAction(directSessionActionCandidates, 'pin_action_id')
      || uniqueAction(collectionSessionActionCandidates, 'pin_action_id')
      || uniqueAction(legacySessionActionCandidates, 'pin_action_id');
    const archiveAction = uniqueAction(collectionSessionActionCandidates, 'archive_action_id')
      || uniqueAction(legacySessionActionCandidates, 'archive_action_id');
    const deleteAction = uniqueAction(directSessionActionCandidates, 'delete_action_id')
      || uniqueAction(collectionSessionActionCandidates, 'delete_action_id')
      || uniqueAction(legacySessionActionCandidates, 'delete_action_id');
    const sessionActions = (renameToken || pinAction || archiveAction || deleteAction) ? {
      pinned: directPinnedStates.size === 1
        ? directSessionActionCandidates[0].pinned
        : Boolean(allSessionActionCandidates[0] && allSessionActionCandidates[0].pinned),
      rename_action_id: renameToken ? 'hermes.session.rename.' + renameToken : '',
      pin_action_id: pinAction,
      archive_action_id: archiveAction,
      delete_action_id: deleteAction,
    } : null;
    const approvalCandidates = [];
    if (scoped) {
      for (const surface of document.querySelectorAll('[data-slot="tool-approval-inline"], [data-slot="tool-approval-actions"]')) {
        let request = null;
        for (let fiber = fiberFor(surface), depth = 0; fiber && depth < 28; fiber = fiber.return, depth += 1) {
          const props = fiber.memoizedProps;
          const candidate = props && typeof props === 'object' ? props.request : null;
          if (candidate && typeof candidate === 'object' && typeof candidate.sessionId === 'string') {
            request = candidate;
            break;
          }
        }
        if (!request || request.sessionId !== selected.live) continue;
        const actions = [];
        for (const button of surface.querySelectorAll('button[data-slot="button"]')) {
          if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
          // Drop the dropdown opener and local command-expander. The remaining
          // direct buttons are the actual current approval decision handlers.
          if (button.getAttribute('aria-haspopup') || button.hasAttribute('aria-expanded')) continue;
          const props = propsFor(button) || fiberFor(button)?.memoizedProps;
          const onClick = props && typeof props.onClick === 'function' ? props.onClick : null;
          const actionToken = token(registry.actions, onClick, 'approval-action');
          const label = text(button);
          if (actionToken && label) actions.push({ id: 'hermes.approval.' + actionToken, label, available: true });
        }
        const requestToken = token(registry.requests, request, 'approval-request');
        if (requestToken && actions.length) {
          approvalCandidates.push({
            approval_request_id: 'hermes.desktop.' + requestToken,
            live_session_id: selected.live,
            title: String(request.command || '').trim(),
            summary: String(request.command || request.description || '').trim(),
            description: String(request.description || '').trim(),
            actions,
          });
        }
      }
    }
    const approval = approvalCandidates.length === 1 ? approvalCandidates[0] : null;
    return {
      selected_stored_session_id: selected.stored,
      active_live_session_id: selected.live,
      scoped,
      composer: composerState,
      queue: queueItems.length ? { items: queueItems, actions: [] } : null,
      session_actions: sessionActions,
      approval,
    };
  })()`;
}

function applySessionRenameSource(expectedStoredSessionID = "", expectedLiveSessionID = "", actionID = "", title = "") {
  const snapshotSource = desktopInteractionSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(async () => {
    const state = ${snapshotSource};
    const requiredActionID = ${JSON.stringify(String(actionID || '').trim())};
    const expectedStored = ${JSON.stringify(String(expectedStoredSessionID || '').trim())};
    const nextTitle = ${JSON.stringify(String(title || '').trim())};
    if (!state || state.scoped !== true || !expectedStored || !nextTitle
      || !state.session_actions
      || state.session_actions.rename_action_id !== requiredActionID) {
      return { ok: false, stale: true };
    }
    const registry = window[Symbol.for('prism.hermes.desktop-interactions.v1')];
    const api = window.hermesDesktop && window.hermesDesktop.api;
    const actionToken = registry && api && registry.actions.get(api);
    if (!actionToken || 'hermes.session.rename.' + actionToken !== requiredActionID) {
      return { ok: false, stale: true };
    }
    const result = await api({
      path: '/api/sessions/' + encodeURIComponent(expectedStored),
      method: 'PATCH',
      body: { title: nextTitle },
    });
    return { ok: true, result: result || null };
  })()`;
}

function interactionActionTargetSource(kind = "", expectedStoredSessionID = "", expectedLiveSessionID = "", itemID = "", actionID = "", approvalID = "") {
  const snapshotSource = desktopInteractionSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(() => {
    const state = ${snapshotSource};
    if (!state || state.scoped !== true) return null;
    const requiredID = ${JSON.stringify(String(actionID || "").trim())};
    const requiredItemID = ${JSON.stringify(String(itemID || "").trim())};
    const requiredApprovalID = ${JSON.stringify(String(approvalID || "").trim())};
    const prefix = ${JSON.stringify(String(kind || "").trim())};
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const propsFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactProps$'));
      return key ? element[key] : null;
    };
    const registry = window[Symbol.for('prism.hermes.desktop-interactions.v1')];
    if (!registry) return null;
    const actionIDFor = (onClick, actionPrefix) => {
      const token = onClick && registry.actions.get(onClick);
      return token ? actionPrefix + token : '';
    };
    if (prefix === 'approval' && state.approval && state.approval.approval_request_id === requiredApprovalID) {
      for (const surface of document.querySelectorAll('[data-slot="tool-approval-inline"], [data-slot="tool-approval-actions"]')) {
        for (const button of surface.querySelectorAll('button[data-slot="button"]')) {
          if (button.getAttribute('aria-haspopup') || button.hasAttribute('aria-expanded')) continue;
          const props = propsFor(button) || fiberFor(button)?.memoizedProps;
          const actual = actionIDFor(props && props.onClick, 'hermes.approval.');
          if (actual === requiredID && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return button;
        }
      }
    }
    return null;
  })()`;
}

function applyQueuePanelActionSource(expectedStoredSessionID = "", expectedLiveSessionID = "", itemID = "", actionID = "") {
  const snapshotSource = desktopInteractionSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(() => {
    const state = ${snapshotSource};
    const requiredItemID = ${JSON.stringify(String(itemID || '').trim())};
    const requiredActionID = ${JSON.stringify(String(actionID || '').trim())};
    if (!state || state.scoped !== true || !state.queue || !Array.isArray(state.queue.items)) return false;
    const item = state.queue.items.find((candidate) => candidate && String(candidate.id || '') === requiredItemID);
    if (!item || !Array.isArray(item.actions) || !item.actions.some((action) => action && action.id === requiredActionID && action.available !== false)) return false;
    const registry = window[Symbol.for('prism.hermes.desktop-interactions.v1')];
    if (!registry) return false;
    const ids = new Set(state.queue.items.map((candidate) => String(candidate.id || '')).filter(Boolean));
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const composer = document.querySelector('[data-slot="composer-root"]');
    let root = fiberFor(composer);
    while (root && root.return) root = root.return;
    const seen = new Set();
    const findPanel = (fiber, depth) => {
      if (!fiber || seen.has(fiber) || depth > 180) return null;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      const entries = props && props.entries;
      if (Array.isArray(entries) && entries.length === ids.size
        && entries.every((entry) => entry && ids.has(String(entry.id || '')))
        && typeof props.onEdit === 'function' && typeof props.onDelete === 'function' && typeof props.onSendNow === 'function') return fiber;
      return findPanel(fiber.child, depth + 1) || findPanel(fiber.sibling, depth);
    };
    const panel = findPanel(root, 0);
    if (!panel || !panel.memoizedProps) return false;
    const props = panel.memoizedProps;
    const entries = Array.isArray(props.entries) ? props.entries : [];
    const entry = entries.find((candidate) => candidate && String(candidate.id || '') === requiredItemID);
    if (!entry) return false;
    const candidates = [
      { callback: props.onEdit, argument: entry },
      { callback: props.onSendNow, argument: requiredItemID },
      { callback: props.onDelete, argument: requiredItemID },
    ];
    for (const candidate of candidates) {
      const token = candidate.callback && registry.actions.get(candidate.callback);
      if ('queue.hermes.' + requiredItemID + '.' + token !== requiredActionID) continue;
      candidate.callback(candidate.argument);
      return true;
    }
    return false;
  })()`;
}

function applySessionRowActionSource(expectedStoredSessionID = "", expectedLiveSessionID = "", actionID = "") {
  const snapshotSource = desktopInteractionSource(expectedStoredSessionID, expectedLiveSessionID);
  return `(() => {
    const state = ${snapshotSource};
    const requiredActionID = ${JSON.stringify(String(actionID || '').trim())};
    if (!state || state.scoped !== true || !state.session_actions
      || (state.session_actions.pin_action_id !== requiredActionID
        && state.session_actions.archive_action_id !== requiredActionID
        && state.session_actions.delete_action_id !== requiredActionID)) return false;
    const registry = window[Symbol.for('prism.hermes.desktop-interactions.v1')];
    if (!registry) return false;
    const fiberFor = (element) => {
      const key = element && Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
      return key ? element[key] : null;
    };
    const composer = document.querySelector('[data-slot="composer-root"]');
    let root = fiberFor(composer);
    while (root && root.return) root = root.return;
    const seen = new Set();
    const directCandidates = [];
    const collectionCandidates = [];
    const legacyCandidates = [];
    const visit = (fiber, depth) => {
      if (!fiber || seen.has(fiber) || depth > 240) return;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      const rowSession = props && typeof props === 'object' && props.session && typeof props.session === 'object'
        ? props.session : null;
      const rawPins = (() => { try { return JSON.parse(localStorage.getItem('hermes.desktop.pinnedSessions') || '[]'); } catch { return []; } })();
      const pinnedIDs = new Set(Array.isArray(rawPins) ? rawPins.filter((item) => typeof item === 'string') : []);
      const rowID = rowSession ? String(rowSession.id || '') : '';
      const pinID = rowSession ? String(rowSession._lineage_root_id || rowID) : '';
      const pinned = Boolean(pinID && pinnedIDs.has(pinID));
      const rowPinned = props && (props.isPinned === true || props.pinned === true);
      const directSessionID = props && typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
      if (directSessionID === ${JSON.stringify(String(expectedStoredSessionID || '').trim())}) {
        const directPinToken = props.onPin && registry.actions.get(props.onPin);
        const directDeleteToken = props.onDelete && registry.actions.get(props.onDelete);
        if ('hermes.session.pin.' + directPinToken === requiredActionID) directCandidates.push(props.onPin);
        if ('hermes.session.delete.' + directDeleteToken === requiredActionID) directCandidates.push(props.onDelete);
      }
      const ownsExpectedSession = (Array.isArray(props && props.sessions)
        && props.sessions.some((item) => item && String(item.id || '') === ${JSON.stringify(String(expectedStoredSessionID || '').trim())}))
        || (Array.isArray(props && props.entries)
          && props.entries.some((item) => item && item.session
            && String(item.session.id || '') === ${JSON.stringify(String(expectedStoredSessionID || '').trim())}));
      if (ownsExpectedSession
        && String(props.activeSessionId || '') === ${JSON.stringify(String(expectedStoredSessionID || '').trim())}) {
        const collectionPinToken = props.onTogglePin && registry.actions.get(props.onTogglePin);
        const collectionArchiveToken = props.onArchiveSession && registry.actions.get(props.onArchiveSession);
        const collectionDeleteToken = props.onDeleteSession && registry.actions.get(props.onDeleteSession);
        if ('hermes.session.pin.' + collectionPinToken === requiredActionID) collectionCandidates.push(props.onTogglePin);
        if ('hermes.session.archive.' + collectionArchiveToken === requiredActionID) collectionCandidates.push(props.onArchiveSession);
        if ('hermes.session.delete.' + collectionDeleteToken === requiredActionID) collectionCandidates.push(props.onDeleteSession);
      }
      if (rowSession && rowID === ${JSON.stringify(String(expectedStoredSessionID || '').trim())}
        && rowPinned === pinned
        && (typeof props.onPin === 'function'
          || typeof props.onArchive === 'function'
          || typeof props.onDelete === 'function')) {
        const pinToken = registry.actions.get(props.onPin);
        const archiveToken = props.onArchive && registry.actions.get(props.onArchive);
        const deleteToken = props.onDelete && registry.actions.get(props.onDelete);
        if ('hermes.session.pin.' + pinToken === requiredActionID) legacyCandidates.push(props.onPin);
        if ('hermes.session.archive.' + archiveToken === requiredActionID) legacyCandidates.push(props.onArchive);
        if ('hermes.session.delete.' + deleteToken === requiredActionID) legacyCandidates.push(props.onDelete);
      }
      visit(fiber.child, depth + 1);
      visit(fiber.sibling, depth);
    };
    visit(root, 0);
    const direct = [...new Set(directCandidates.filter(Boolean))];
    if (direct.length === 1) {
      direct[0]();
      return true;
    }
    const collection = [...new Set(collectionCandidates.filter(Boolean))];
    if (collection.length === 1) {
      collection[0](${JSON.stringify(String(expectedStoredSessionID || '').trim())});
      return true;
    }
    const legacy = [...new Set(legacyCandidates.filter(Boolean))];
    if (legacy.length !== 1) return false;
    legacy[0]();
    return true;
  })()`;
}

function defaultProfileDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Hermes");
  }
  if (process.platform === "win32") {
    const appData = firstNonEmpty(process.env.APPDATA, process.env.LOCALAPPDATA);
    return appData ? path.join(appData, "Hermes") : path.join(os.homedir(), "AppData", "Roaming", "Hermes");
  }
  const xdg = firstNonEmpty(process.env.XDG_CONFIG_HOME);
  return xdg ? path.join(xdg, "Hermes") : path.join(os.homedir(), ".config", "Hermes");
}

function defaultAppPath() {
  if (process.platform === "darwin") {
    const managed = path.join(os.homedir(), ".hermes", "hermes-agent", "apps", "desktop", "release", "mac-arm64", "Hermes.app", "Contents", "MacOS", "Hermes");
    if (fs.existsSync(managed)) {
      return managed;
    }
    return "/Applications/Hermes.app/Contents/MacOS/Hermes-Setup";
  }
  if (process.platform === "win32") {
    return firstNonEmpty(
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Hermes", "Hermes.exe") : "",
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Hermes", "Hermes.exe") : "",
    );
  }
  return firstNonEmpty(process.env.PRISM_HERMES_LINUX_COMMAND, "hermes-desktop", "hermes");
}

function hermesAppPath() {
  const override = firstNonEmpty(process.env.PRISM_HERMES_APP_EXECUTABLE, process.env.PRISM_HERMES_APP_PATH);
  if (override && override.endsWith(".app") && process.platform === "darwin") {
    return path.join(override, "Contents", "MacOS", "Hermes");
  }
  return firstNonEmpty(override, defaultAppPath());
}

function defaultDevtoolsFile(userDataDir = defaultProfileDir()) {
  return path.join(userDataDir, "DevToolsActivePort");
}

async function commandOutput(command, args = [], opts = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: opts.timeout || 4000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
      windowsHide: true,
    });
    return firstNonEmpty(result.stdout);
  } catch {
    return "";
  }
}

async function listHermesProcesses() {
  if (process.platform === "darwin" || process.platform === "linux") {
    const output = await commandOutput("/bin/sh", ["-lc", "ps ax -o pid=,command= | grep -Ei 'Hermes(\\.app| Helper| )|/Hermes$|/Contents/MacOS/Hermes|hermes-desktop' || true"], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(output || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(Boolean)
      .filter((proc) => /Hermes\.app|\/Hermes\b|hermes-desktop/i.test(proc.command));
  }
  if (process.platform === "win32") {
    const output = await commandOutput("cmd.exe", ["/c", "wmic process where \"name='Hermes.exe'\" get ProcessId,CommandLine /format:list"], {
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(output || "")
      .split(/\n\s*\n/)
      .map((block) => {
        const command = firstNonEmpty((block.match(/^CommandLine=(.*)$/m) || [])[1]);
        const pid = Number(firstNonEmpty((block.match(/^ProcessId=(.*)$/m) || [])[1]));
        return pid ? { pid, command } : null;
      })
      .filter(Boolean);
  }
  return [];
}

function processMatchesUserDataDir(proc, userDataDir = "") {
  const normalized = firstNonEmpty(userDataDir);
  if (!normalized) return true;
  return String((proc && proc.command) || "").includes(`--user-data-dir=${normalized}`);
}

async function isHermesRunning(userDataDir = "") {
  const processes = await listHermesProcesses();
  return processes.some((proc) => processMatchesUserDataDir(proc, userDataDir));
}

async function stopExistingHermesProcess(userDataDir = "") {
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/osascript", ["-e", 'tell application id "com.nousresearch.hermes" to quit'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }).catch(() => {});
  }
  const processes = await listHermesProcesses();
  for (const proc of processes) {
    if (!processMatchesUserDataDir(proc, userDataDir)) continue;
    if (process.platform === "win32") {
      await commandOutput("cmd.exe", ["/c", `taskkill /PID ${proc.pid} /F`], { timeout: 8000, maxBuffer: 1024 * 1024 });
    } else {
      await commandOutput("/bin/sh", ["-lc", `kill ${proc.pid} || true`], { timeout: 3000, maxBuffer: 1024 * 1024 });
    }
  }
}

async function waitForHermesStopped(timeoutMs = 15000, userDataDir = "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isHermesRunning(userDataDir))) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

class HermesDesktopController extends CdpPageClient {
  constructor(options = {}) {
    super({
      ...options,
      commandTimeoutMs: options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    });
    this.pageTarget = null;
    this.managedProcess = null;
  }

  async ensureReady() {
    if (!this.connected) {
      const target = await this.resolvePageTarget();
      this.pageTarget = target;
      await this.connectToPage(target.webSocketDebuggerUrl);
    }
    await this.waitForReady();
    return this;
  }

  async resolvePageTarget() {
    const userDataDir = firstNonEmpty(this.options.userDataDir, process.env.PRISM_HERMES_USER_DATA_DIR, defaultProfileDir());
    const overrideUrl = firstNonEmpty(process.env.PRISM_HERMES_CDP_URL, this.options.cdpUrl);
    if (overrideUrl) {
      const listUrl = overrideUrl.endsWith("/json/list") ? overrideUrl : overrideUrl.replace(/\/$/, "") + "/json/list";
      return this.fetchPageTarget(listUrl);
    }
    const overridePort = firstNonEmpty(process.env.PRISM_HERMES_CDP_PORT, this.options.cdpPort ? String(this.options.cdpPort) : "");
    if (overridePort) {
      return this.fetchPageTarget(`http://127.0.0.1:${overridePort}/json/list`);
    }
    const devtoolsFile = firstNonEmpty(process.env.PRISM_HERMES_DEVTOOLS_FILE, this.options.devtoolsFile);
    if (devtoolsFile && fs.existsSync(devtoolsFile)) {
      return this.fetchPageTarget(await this.devtoolsListUrlFromFile(devtoolsFile));
    }
    const portFile = defaultDevtoolsFile(userDataDir);
    if (fs.existsSync(portFile)) {
      try {
        return await this.fetchPageTarget(await this.devtoolsListUrlFromFile(portFile));
      } catch (error) {
        // Chromium can leave this file behind after a crash or forced quit.
        // It is a connection cache, never proof that the target still exists.
        try { fs.unlinkSync(portFile); } catch {}
      }
    }
    const running = await isHermesRunning(userDataDir);
    if (running) {
      const allowManagedRelaunch = this.options.allowManagedRelaunch === true || process.env.PRISM_HERMES_ALLOW_MANAGED_RELAUNCH === "1";
      if (allowManagedRelaunch) {
        await stopExistingHermesProcess(userDataDir);
        const stopped = await waitForHermesStopped(this.options.stopTimeoutMs || 15000, userDataDir);
        if (!stopped) {
          throw new Error("Hermes 已在运行，但 Prism 在受控重启模式下未能及时关闭旧进程。");
        }
        return this.launchManagedTarget(userDataDir);
      }
      throw new Error("当前 Hermes 未暴露 CDP 端口。Prism 不会停止或重启正在使用的 Hermes；请在 Prism Desktop 的插件页显式执行托管启动，或由开发者显式配置 CDP 连接。");
    }
    const allowManagedLaunch = this.options.allowManagedLaunch === true || process.env.PRISM_HERMES_ALLOW_MANAGED_LAUNCH === "1";
    if (allowManagedLaunch) {
      return this.launchManagedTarget(userDataDir);
    }
    throw new Error("Hermes Desktop 未运行。请在 Prism Desktop 的插件页显式启动 Hermes；普通 Plugin 请求不会自动拉起 Electron。开发调试可显式设置 PRISM_HERMES_ALLOW_MANAGED_LAUNCH=1。");
  }

  async devtoolsListUrlFromFile(file) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const port = firstNonEmpty(lines[0]);
    if (!port) {
      throw new Error(`invalid DevToolsActivePort file: ${file}`);
    }
    return `http://127.0.0.1:${port}/json/list`;
  }

  async fetchPageTarget(listUrl) {
    const deadline = Date.now() + (this.options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(listUrl, { cache: "no-store" });
        const targets = await response.json();
        const pages = Array.isArray(targets)
          ? targets.filter((item) => item && item.type === "page" && item.webSocketDebuggerUrl)
          : [];
        const preferred = pages.find((item) => /hermes/i.test(`${item.title || ""} ${item.url || ""}`));
        if (preferred || pages[0]) {
          return preferred || pages[0];
        }
      } catch (err) {
        lastError = err;
      }
      await sleep(300);
    }
    throw lastError || new Error(`Hermes CDP page target not found from ${listUrl}`);
  }

  async launchManagedTarget(userDataDir) {
    const appPath = hermesAppPath();
    if (!appPath || !fs.existsSync(appPath)) {
      throw new Error("未找到 Hermes Desktop 可执行路径，请设置 PRISM_HERMES_APP_EXECUTABLE。");
    }
    const args = [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    const child = spawn(appPath, args, {
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    this.managedProcess = child;
    const devtoolsFile = defaultDevtoolsFile(userDataDir);
    const deadline = Date.now() + (this.options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (fs.existsSync(devtoolsFile)) {
        return this.fetchPageTarget(await this.devtoolsListUrlFromFile(devtoolsFile));
      }
      if (child.exitCode !== null) {
        throw new Error(`Hermes 启动失败，exit=${child.exitCode}`);
      }
      await sleep(250);
    }
    throw new Error("等待 Hermes CDP 端口超时。");
  }

  async waitForReady() {
    await this.waitFor(
      "Boolean(window.hermesDesktop && document.body)",
      this.options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS,
    );
  }

  // Kept for developer diagnostics only. Production Desktop operations reuse
  // the renderer's existing HermesGateway through desktopGatewayRequest();
  // they never create a second WebSocket from the Plugin process.
  async gatewayConnection() {
    await this.ensureReady();
    const result = await this.evaluate(`(async () => {
      if (!window.hermesDesktop || !window.hermesDesktop.getConnection) {
        return { ok: false, reason: "hermesDesktop gateway bridge unavailable" };
      }
      const connection = await window.hermesDesktop.getConnection(null);
      let wsUrl = connection && connection.wsUrl;
      if (window.hermesDesktop.getGatewayWsUrl) {
        try {
          const fresh = await window.hermesDesktop.getGatewayWsUrl(
            connection && connection.profile ? connection.profile : null,
          );
          if (fresh) wsUrl = fresh;
        } catch (error) {
          if (!wsUrl) throw error;
        }
      }
      if (typeof wsUrl !== "string" || !/^wss?:\\/\\//.test(wsUrl)) {
        return { ok: false, reason: "Hermes Desktop did not provide a Gateway WebSocket URL" };
      }
      return { ok: true, ws_url: wsUrl };
    })()`);
    if (!result || result.ok === false || !result.ws_url) {
      throw new Error((result && result.reason) || "Hermes Desktop gateway URL unavailable");
    }
    return { wsUrl: String(result.ws_url) };
  }

  async desktopGatewayRequest(storedSessionID, liveSessionID, method, params = {}, timeoutMs = 15000) {
    await this.ensureReady();
    const result = await this.evaluate(desktopGatewayRequestSource(
      storedSessionID,
      liveSessionID,
      method,
      params,
      timeoutMs,
    ));
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || "Hermes Desktop Gateway request failed");
    }
    return result.result;
  }

  async desktopGatewayMutation(storedSessionID, liveSessionID, method, params = {}, timeoutMs = 120000) {
    await this.ensureReady();
    const result = await this.evaluate(desktopGatewayMutationSource(
      storedSessionID,
      liveSessionID,
      method,
      params,
      timeoutMs,
    ));
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || "Hermes Desktop Gateway mutation failed");
    }
    return { mutationID: String(result.mutation_id || "") };
  }

  async desktopGatewayEvents(storedSessionID, liveSessionID, afterSequence = 0) {
    await this.ensureReady();
    const result = await this.evaluate(desktopGatewayEventsSource(
      storedSessionID,
      liveSessionID,
      afterSequence,
    ));
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || "Hermes Desktop Gateway events unavailable");
    }
    return {
      cursor: Math.max(0, Number(result.cursor) || 0),
      events: Array.isArray(result.events) ? result.events : [],
    };
  }

  // Read only the current renderer state. Queue entries belong to the durable
  // stored session id; approvals belong to the active Gateway session id.
  async desktopInteractions(storedSessionID, liveSessionID) {
    await this.ensureReady();
    return this.evaluate(desktopInteractionSource(storedSessionID, liveSessionID));
  }

  async desktopIdentity() {
    await this.ensureReady();
    return this.evaluate(desktopIdentitySource());
  }

  async desktopSessionHealth(storedSessionID, liveSessionID, timeoutMs = 1500) {
    await this.ensureReady();
    return this.evaluate(desktopSessionHealthSource(storedSessionID, liveSessionID, timeoutMs));
  }

  async setDesktopRoute(storedSessionID) {
    const normalized = String(storedSessionID || "").trim();
    await this.evaluate(`(() => {
      window.location.hash = ${JSON.stringify(normalized ? `#/${normalized}` : "#/")};
      return window.location.hash;
    })()`);
  }

  async openDesktopDraft(timeoutMs = 10000) {
    await this.ensureReady();
    await this.setDesktopRoute("");
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await this.evaluate(desktopDraftStateSource("", true));
      if (latest && latest.ok === true && latest.fingerprint) {
        return { fingerprint: String(latest.fingerprint) };
      }
      if (latest && latest.error && latest.error !== "desktop_draft_unavailable") break;
      await sleep(100);
    }
    throw new Error((latest && latest.error) || "Hermes Desktop did not open an empty draft");
  }

  async assertDesktopDraft(fingerprint) {
    await this.ensureReady();
    const result = await this.evaluate(desktopDraftStateSource(fingerprint, false));
    if (!result || result.ok !== true) {
      throw new Error(`draft_stale: ${(result && result.error) || "Hermes Desktop draft is no longer active"}`);
    }
    return result;
  }

  // Hermes persists pins only in this Desktop renderer's localStorage. This is
  // a best-effort Host-local directory projection: failure to read CDP must
  // never make the durable SQLite session list unavailable.
  async desktopPinnedSessionIDs() {
    await this.ensureReady();
    const value = await this.evaluate(`(() => {
      try {
        const raw = localStorage.getItem('hermes.desktop.pinnedSessions');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
          ? parsed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
          : [];
      } catch {
        return [];
      }
    })()`);
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  }

  // The sidebar's mounted React props provide the actual Desktop directory
  // identity and grouping order. This deliberately returns only opaque session
  // IDs: titles and projects remain sourced from Hermes' durable SQLite state.
  async desktopSessionDirectoryIDs() {
    await this.ensureReady();
    const value = await this.evaluate(desktopSessionDirectorySource());
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  }

  // Hermes Desktop selects sessions through its native HashRouter route. This
  // lets the renderer perform its own resume/state transitions instead of
  // Prism mutating private React state.
  async selectDesktopSession(storedSessionID, timeoutMs = 20000) {
    const expected = String(storedSessionID || "").trim();
    if (!expected) {
      throw new Error("Hermes Desktop session identity is missing");
    }
    await this.ensureReady();
    const current = await this.desktopIdentity();
    if (firstNonEmpty(current && current.stored_session_id) === expected
      && firstNonEmpty(current && current.live_session_id)) {
      const health = await this.desktopSessionHealth(
        expected,
        firstNonEmpty(current.live_session_id),
      );
      // A busy Gateway can make the bounded health probe inconclusive. Only a
      // definitive missing session is allowed to disrupt the current Desktop.
      if (!health || health.reachable !== false) {
        return {
          storedSessionID: expected,
          liveSessionID: firstNonEmpty(current.live_session_id),
        };
      }
    }

    // HashRouter ignores navigation to the current hash. Clear the route first
    // when that route has no live runtime (or its runtime was reaped), then let
    // Hermes run its normal session.resume path for the target conversation.
    if (firstNonEmpty(current && current.stored_session_id) === expected) {
      await this.setDesktopRoute("");
      const clearDeadline = Date.now() + Math.min(2000, Math.max(500, timeoutMs));
      while (Date.now() < clearDeadline) {
        const cleared = await this.desktopIdentity();
        if (!firstNonEmpty(cleared && cleared.stored_session_id)) break;
        await sleep(100);
      }
    }
    await this.setDesktopRoute(expected);
    const deadline = Date.now() + timeoutMs;
    let latest = { stored_session_id: "", live_session_id: "" };
    while (Date.now() < deadline) {
      latest = await this.desktopIdentity();
      if (firstNonEmpty(latest && latest.stored_session_id) === expected
        && firstNonEmpty(latest && latest.live_session_id)) {
        return {
          storedSessionID: expected,
          liveSessionID: firstNonEmpty(latest.live_session_id),
        };
      }
      await sleep(200);
    }
    throw new Error("Hermes Desktop did not activate the requested session");
  }

  // New Hermes conversations must be created by the renderer itself. A Gateway
  // session.create writes durable history, but does not make the Desktop select
  // that session. This uses the native composer submit path and proves the
  // result from the renderer's stored/live identities, without menu text or
  // React-state mutation.
  async createDesktopSessionWithPrompt(text, attachmentPaths = [], timeoutMs = 60000, expectedDraftFingerprint = "") {
    const prompt = String(text || "").trim();
    const paths = Array.isArray(attachmentPaths) ? attachmentPaths.filter(Boolean) : [];
    if (!prompt && paths.length === 0) {
      throw new Error("Hermes Desktop prompt or attachment is required to create a session");
    }
    await this.ensureReady();
    const draftFingerprint = String(expectedDraftFingerprint || "").trim();
    if (draftFingerprint) {
      await this.assertDesktopDraft(draftFingerprint);
    } else {
      const opened = await this.openDesktopDraft(timeoutMs);
      expectedDraftFingerprint = opened.fingerprint;
    }
    const submitted = await this.submitDesktopPrompt("", "", prompt, paths, timeoutMs, expectedDraftFingerprint);
    if (submitted.outcome !== "submitted") {
      throw new Error("Hermes Desktop did not submit the new-session draft");
    }

    const deadline = Date.now() + timeoutMs;
    let latest = { stored_session_id: "", live_session_id: "" };
    while (Date.now() < deadline) {
      latest = await this.desktopIdentity();
      if (firstNonEmpty(latest && latest.stored_session_id)
        && firstNonEmpty(latest && latest.live_session_id)) {
        return {
          storedSessionID: firstNonEmpty(latest.stored_session_id),
          liveSessionID: firstNonEmpty(latest.live_session_id),
          outcome: submitted.outcome,
          queueItemID: "",
        };
      }
      await sleep(200);
    }
    throw new Error("Hermes Desktop did not create and activate the submitted session");
  }

  async submitDesktopPrompt(storedSessionID, liveSessionID, text, attachmentPaths = [], timeoutMs = 15000, expectedDraftFingerprint = "") {
    await this.ensureReady();
    const result = await this.evaluate(desktopSubmitPromptSource(
      storedSessionID,
      liveSessionID,
      text,
      attachmentPaths,
      timeoutMs,
      expectedDraftFingerprint,
    ));
    if (!result || result.ok !== true) {
      const reason = (result && result.error) || "desktop_submit_failed";
      throw new Error(`${reason}: Hermes Desktop did not accept the composer submission`);
    }
    return {
      outcome: String(result.outcome || "submitted"),
      queueItemID: String(result.queue_item_id || ""),
      storedSessionID: String(result.stored_session_id || storedSessionID || ""),
      liveSessionID: String(result.live_session_id || liveSessionID || ""),
    };
  }

  async cancelDesktopRun(storedSessionID, liveSessionID) {
    await this.ensureReady();
    const result = await this.evaluate(desktopCancelSource(storedSessionID, liveSessionID));
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || "Hermes Desktop interrupt is unavailable");
    }
  }

  async executeDesktopInteraction(kind, storedSessionID, liveSessionID, {
    itemID = "",
    actionID = "",
    approvalID = "",
    expectedPinned,
  } = {}) {
    await this.ensureReady();
    if (kind === "queue") {
      const applied = await this.evaluate(applyQueuePanelActionSource(
        storedSessionID,
        liveSessionID,
        itemID,
        actionID,
      ));
      if (applied !== true) {
        throw new Error("control_target_stale: Hermes Desktop action is no longer available");
      }
      return;
    }
    if (kind === "session") {
      const applied = await this.evaluate(applySessionRowActionSource(
        storedSessionID,
        liveSessionID,
        actionID,
      ));
      if (applied !== true) {
        throw new Error("control_target_stale: Hermes Desktop action is no longer available");
      }
      if (typeof expectedPinned === "boolean") {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const refreshed = await this.evaluate(desktopInteractionSource(storedSessionID, liveSessionID));
          if (refreshed && refreshed.scoped === true && refreshed.session_actions
            && refreshed.session_actions.pinned === expectedPinned) {
            return;
          }
          await sleep(100);
        }
        throw new Error("Hermes Desktop did not apply the session pin state");
      }
      return;
    }
    let expression = interactionActionTargetSource(
      kind,
      storedSessionID,
      liveSessionID,
      itemID,
      actionID,
      approvalID,
    );
    try {
      // Approval handlers are React-runtime identities. Resolving an element
      // and dispatching the CDP mouse click in separate protocol calls leaves
      // a window where React can replace the mounted button. Revalidate and
      // invoke the native button click in one renderer evaluation instead.
      const applied = await this.evaluate(`(() => {
        const target = ${expression};
        if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return false;
        target.click();
        return true;
      })()`);
      if (applied !== true) throw new Error("target unavailable");
    } catch {
      throw new Error("control_target_stale: Hermes Desktop action is no longer available");
    }
  }

  async renameDesktopSession(storedSessionID, liveSessionID, actionID, title) {
    await this.ensureReady();
    const result = await this.evaluate(applySessionRenameSource(
      storedSessionID,
      liveSessionID,
      actionID,
      title,
    ));
    if (!result || result.ok !== true) {
      throw new Error("control_target_stale: Hermes Desktop rename action is no longer available");
    }
    return result.result;
  }

}

function createHermesDesktopController(options = {}) {
  return new HermesDesktopController(options);
}

module.exports = {
  HermesDesktopController,
  createHermesDesktopController,
  defaultProfileDir,
  hermesAppPath,
  selectDesktopComposerCandidate,
};
