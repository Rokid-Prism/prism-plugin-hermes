"use strict";

// Hermes Desktop's sidebar owns membership and order. SQLite is deliberately
// an enrichment store only because it also retains unrelated CLI/ACP history.
function desktopDirectoryRows(desktopIDs, rows, firstNonEmpty) {
  const byID = new Map((Array.isArray(rows) ? rows : []).map((row) => [firstNonEmpty(row && row.id), row]));
  return (Array.isArray(desktopIDs) ? desktopIDs : [])
    // Desktop can render a just-created session before its durable SQLite row
    // commits. Retain that opaque ID so index counts stay faithful; SQLite
    // enriches it on the next watcher pass.
    .map((id) => byID.get(firstNonEmpty(id)) || { id: firstNonEmpty(id), title: "", cwd: "", source: "desktop_pending", message_count: 0, ended_at: 0, last_activity: 0 })
    .filter(Boolean);
}

// Native Gateway `session.list` is a runtime inventory, not Hermes' durable
// conversation directory. CLI-created sessions can be absent until they are
// explicitly resumed in this particular Gateway. Keep state.db authoritative
// and use Gateway data only to enrich an already-persisted session.
function nativeDirectoryRows(rows, gatewaySessions, firstNonEmpty) {
  const gatewaysByID = new Map(
    (Array.isArray(gatewaySessions) ? gatewaySessions : [])
      .map((session) => [firstNonEmpty(
        session && session.session_key,
        session && session.stored_session_id,
        session && session.id,
        session && session.session_id,
      ), session])
      .filter(([id]) => Boolean(id)),
  );
  const durable = Array.isArray(rows) ? rows : [];
  const durableIDs = new Set(durable.map((row) => firstNonEmpty(row && row.id)).filter(Boolean));
  const merged = durable.map((row) => ({
    ...row,
    gateway_session: gatewaysByID.get(firstNonEmpty(row && row.id)) || null,
  }));

  // A just-created native session can briefly be visible to the Gateway before
  // its state.db transaction commits. Keep that bounded pending entry without
  // letting a Gateway-only historical list hide durable CLI sessions.
  for (const [id, gatewaySession] of gatewaysByID) {
    if (!durableIDs.has(id)) {
      merged.push({ id, title: "", cwd: "", source: "native_pending", message_count: 0, ended_at: 0, last_activity: 0, gateway_session: gatewaySession });
    }
  }
  return merged;
}

function nativeDirectoryTitle(row, firstNonEmpty) {
  return firstNonEmpty(
    row && row.title,
    row && row.gateway_session && row.gateway_session.title,
  );
}

module.exports = { desktopDirectoryRows, nativeDirectoryRows, nativeDirectoryTitle };
