//! SQLite schema for the evolution event store.
//!
//! Uses `CREATE TABLE IF NOT EXISTS` for idempotent initialization.
//! Schema migrations are tracked in the `schema_migrations` table.

/// Current schema version. Increment when changing the DDL.
pub const SCHEMA_VERSION: u32 = 1;

/// Full schema SQL for initialization.
pub const SCHEMA_SQL: &str = r#"
-- Append-only event log.
CREATE TABLE IF NOT EXISTS events (
    event_id       TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    causation_id   TEXT,
    event_type     TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    timestamp      INTEGER NOT NULL,
    payload        TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    idempotency_key TEXT
);

-- Composite index: events for a run in chronological order.
CREATE INDEX IF NOT EXISTS idx_events_run_time
    ON events(run_id, timestamp);

-- Content hash for idempotent deduplication.
CREATE INDEX IF NOT EXISTS idx_events_content_hash
    ON events(content_hash);

-- Unique index on idempotency key for dedup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency_key
    ON events(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Run projection (terminal state per run).
CREATE TABLE IF NOT EXISTS runs (
    run_id       TEXT PRIMARY KEY,
    state        TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER,
    error        TEXT
);

-- Experience projection (materialized from events, rebuildable).
CREATE TABLE IF NOT EXISTS experience_projection (
    experience_id TEXT PRIMARY KEY,
    revision      INTEGER NOT NULL,
    parent_id     TEXT,
    state         TEXT NOT NULL,
    confidence    REAL NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    scope_json    TEXT NOT NULL,
    content_hash  TEXT NOT NULL
);

-- Lineage edges between experience revisions.
CREATE TABLE IF NOT EXISTS lineage_edges (
    parent_id TEXT NOT NULL,
    child_id  TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);

-- Reuse observations from subsequent tasks.
CREATE TABLE IF NOT EXISTS reuse_observations (
    observation_id TEXT PRIMARY KEY,
    experience_id  TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    outcome        TEXT NOT NULL,
    observed_at    INTEGER NOT NULL,
    context_hash   TEXT NOT NULL
);

-- Evidence manifests linking runs to artifacts.
CREATE TABLE IF NOT EXISTS evidence_manifests (
    manifest_id   TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    artifact_size INTEGER NOT NULL,
    scrubbed      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);

-- Schema migration tracking.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
"#;

/// Upcast an event payload from `from_version` to `to_version`.
///
/// Supports upgrading through at most two versions. Returns `None` if the
/// payload is already at `to_version`. Returns `Err` if the gap is too large
/// or the source version is from the future.
pub fn upcast_event(
    payload: &serde_json::Value,
    from_version: u32,
    to_version: u32,
) -> Result<Option<serde_json::Value>, crate::error::EvolutionError> {
    if from_version == to_version {
        return Ok(None);
    }
    if from_version > to_version {
        return Err(crate::error::EvolutionError::FutureSchemaVersion {
            got: from_version,
            current: to_version,
        });
    }
    if to_version - from_version > 2 {
        return Err(crate::error::EvolutionError::FutureSchemaVersion {
            got: from_version,
            current: to_version,
        });
    }

    let mut result = payload.clone();
    let mut version = from_version;

    while version < to_version {
        result = upcast_one(&result, version)?;
        version += 1;
    }

    Ok(Some(result))
}

/// Upcast from version N to version N+1.
///
/// Currently a no-op at schema version 1. Add migration logic here as
/// the schema evolves.
fn upcast_one(
    payload: &serde_json::Value,
    from_version: u32,
) -> Result<serde_json::Value, crate::error::EvolutionError> {
    match from_version {
        // v1 → v2: placeholder for future migration
        1 => Ok(payload.clone()),
        _ => Err(crate::error::EvolutionError::Internal(format!(
            "no upcaster for version {}",
            from_version
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upcast_same_version_returns_none() {
        let payload = json!({"type": "RunStarted"});
        let result = upcast_event(&payload, 1, 1).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn upcast_future_version_errors() {
        let payload = json!({"type": "RunStarted"});
        let result = upcast_event(&payload, 2, 1);
        assert!(result.is_err());
    }

    #[test]
    fn upcast_gap_too_large_errors() {
        let payload = json!({"type": "RunStarted"});
        let result = upcast_event(&payload, 1, 5);
        assert!(result.is_err());
    }

    #[test]
    fn upcast_single_step_v1_to_v2() {
        let payload = json!({"type": "RunStarted"});
        let result = upcast_event(&payload, 1, 2).unwrap().unwrap();
        assert_eq!(result, payload);
    }
}
