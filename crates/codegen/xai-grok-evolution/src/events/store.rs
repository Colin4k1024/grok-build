//! SQLite-backed event store.
//!
//! Provides append-only event storage with idempotent deduplication,
//! run projection queries, and projection rebuild capabilities.
//! Uses `xai-sqlite-journal` for safe journal mode selection.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::error::EvolutionError;
use crate::events::EvolutionEvent;
use crate::events::schema::{SCHEMA_SQL, SCHEMA_VERSION, apply_migrations};
use crate::rollout::{RolloutApproval, RolloutEvidence, RolloutReadiness};
use crate::types::*;

/// Append-only event store backed by SQLite.
///
/// All writes go through a `Mutex<Connection>` to ensure serial access
/// within a single process. Readers can open separate connections for
/// read-only queries (WAL mode supports concurrent reads).
#[derive(Clone)]
pub struct EvolutionStore {
    conn: Arc<Mutex<Connection>>,
}

impl EvolutionStore {
    /// Open or create the evolution database at the given path.
    ///
    /// Uses `xai-sqlite-journal` for journal mode selection (safe on NFS).
    pub fn open(db_path: &Path) -> Result<Self, EvolutionError> {
        let journal = xai_sqlite_journal::JournalMode::for_db_path(db_path);
        let conn = journal.open(db_path)?;

        // Initialize schema
        conn.execute_batch(SCHEMA_SQL)?;
        apply_migrations(&conn)?;

        // Record schema migration
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![SCHEMA_VERSION, now],
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an in-memory database for testing.
    #[cfg(any(feature = "test-support", test))]
    pub fn open_memory() -> Result<Self, EvolutionError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA_SQL)?;
        apply_migrations(&conn)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![SCHEMA_VERSION, now],
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Append an event. Returns `Ok(true)` if inserted, `Ok(false)` if
    /// deduplicated (same idempotency key already exists).
    pub fn append_event(
        &self,
        run_id: &str,
        event: &EvolutionEvent,
        causation_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<bool, EvolutionError> {
        self.append_and_project(run_id, event, causation_id, idempotency_key)
    }

    /// Atomically append an event and update all derived projections.
    ///
    /// This is the only production event-write path. The event log and the
    /// query projections therefore cannot diverge after a successful return.
    pub fn append_and_project(
        &self,
        run_id: &str,
        event: &EvolutionEvent,
        causation_id: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<bool, EvolutionError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Check idempotency
        if let Some(key) = idempotency_key {
            let exists: bool = tx.query_row(
                "SELECT COUNT(*) > 0 FROM events WHERE idempotency_key = ?1",
                params![key],
                |row| row.get(0),
            )?;
            if exists {
                return Ok(false);
            }
        }

        let event_type = event_type_name(event);
        let payload = serde_json::to_string(event)
            .map_err(|e| EvolutionError::Internal(format!("serialize event: {}", e)))?;
        let content_hash = blake3::hash(payload.as_bytes()).to_hex().to_string();

        let event_id = uuid::Uuid::new_v4().to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        tx.execute(
            "INSERT INTO events (event_id, run_id, causation_id, event_type, schema_version, timestamp, payload, content_hash, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event_id,
                run_id,
                causation_id,
                event_type,
                SCHEMA_VERSION,
                timestamp,
                payload,
                content_hash,
                idempotency_key,
            ],
        )?;

        Self::apply_event_to_projection(&tx, event, timestamp)?;
        tx.commit()?;

        Ok(true)
    }

    /// Query all events for a given run, ordered by timestamp.
    pub fn events_for_run(&self, run_id: &str) -> Result<Vec<StoredEvent>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;

        let mut stmt = conn.prepare(
            "SELECT event_id, run_id, causation_id, event_type, schema_version, timestamp, payload, content_hash, idempotency_key FROM events WHERE run_id = ?1 ORDER BY timestamp",
        )?;

        let rows = stmt.query_map(params![run_id], |row| {
            Ok(StoredEvent {
                event_id: row.get(0)?,
                run_id: row.get(1)?,
                causation_id: row.get(2)?,
                event_type: row.get(3)?,
                schema_version: row.get(4)?,
                timestamp: row.get(5)?,
                payload_json: row.get(6)?,
                content_hash: row.get(7)?,
                idempotency_key: row.get(8)?,
            })
        })?;

        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    /// Return a single run projection, if it exists.
    pub fn get_run(&self, run_id: &str) -> Result<Option<EvolutionRun>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        conn.query_row(
            "SELECT run_id, state, trigger_type, trigger_json, config_json, started_at, completed_at, error FROM runs WHERE run_id = ?1",
            params![run_id],
            decode_run,
        )
        .optional()
        .map_err(Into::into)
    }

    /// List runs in reverse chronological order with an optional state filter.
    pub fn list_runs(
        &self,
        state_filter: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<EvolutionRun>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let limit = limit.clamp(1, 500);
        let mut runs = Vec::new();
        if let Some(state) = state_filter {
            let mut stmt = conn.prepare(
                "SELECT run_id, state, trigger_type, trigger_json, config_json, started_at, completed_at, error FROM runs WHERE state = ?1 ORDER BY started_at DESC, run_id DESC LIMIT ?2 OFFSET ?3",
            )?;
            let rows = stmt.query_map(params![state, limit, offset], decode_run)?;
            for row in rows {
                runs.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT run_id, state, trigger_type, trigger_json, config_json, started_at, completed_at, error FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?1 OFFSET ?2",
            )?;
            let rows = stmt.query_map(params![limit, offset], decode_run)?;
            for row in rows {
                runs.push(row?);
            }
        }
        Ok(runs)
    }

    /// Count runs, optionally filtered by state.
    pub fn count_runs(&self, state_filter: Option<&str>) -> Result<u32, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let count: u32 = if let Some(state) = state_filter {
            conn.query_row(
                "SELECT COUNT(*) FROM runs WHERE state = ?1",
                params![state],
                |row| row.get(0),
            )?
        } else {
            conn.query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))?
        };
        Ok(count)
    }

    /// Return an experience projection by id.
    pub fn get_experience(
        &self,
        experience_id: &str,
    ) -> Result<Option<ExperienceRevision>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        conn.query_row(
            "SELECT experience_id, revision, parent_id, state, confidence, success_count, failure_count, created_at, updated_at, scope_json, content_hash FROM experience_projection WHERE experience_id = ?1",
            params![experience_id],
            decode_experience,
        )
        .optional()
        .map_err(Into::into)
    }

    /// Return all experience projections.
    pub fn all_experiences(&self) -> Result<Vec<ExperienceRevision>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let mut stmt = conn.prepare(
            "SELECT experience_id, revision, parent_id, state, confidence, success_count, failure_count, created_at, updated_at, scope_json, content_hash FROM experience_projection ORDER BY updated_at DESC, experience_id",
        )?;
        let rows = stmt.query_map([], decode_experience)?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Update the run projection.
    pub fn upsert_run(&self, run: &EvolutionRun) -> Result<(), EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;

        let state_str = serde_json::to_value(run.state)
            .map_err(|e| EvolutionError::Internal(format!("serialize run state: {}", e)))?
            .as_str()
            .unwrap_or("running")
            .to_string();
        let trigger_str = serde_json::to_value(run.trigger.trigger_type)
            .map_err(|e| EvolutionError::Internal(format!("serialize trigger: {}", e)))?
            .as_str()
            .unwrap_or("manual")
            .to_string();
        let trigger_json = serde_json::to_string(&run.trigger)
            .map_err(|e| EvolutionError::Internal(format!("serialize trigger: {e}")))?;
        let config_json = serde_json::to_string(&run.config_snapshot)
            .map_err(|e| EvolutionError::Internal(format!("serialize config: {e}")))?;

        conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, state, trigger_type, trigger_json, config_json, started_at, completed_at, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run.run_id,
                state_str,
                trigger_str,
                trigger_json,
                config_json,
                run.started_at,
                run.completed_at,
                run.error,
            ],
        )?;

        Ok(())
    }

    /// Upsert an experience projection record.
    pub fn upsert_experience(&self, exp: &ExperienceRevision) -> Result<(), EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;

        let state_str = serde_json::to_value(exp.state)
            .map_err(|e| EvolutionError::Internal(format!("serialize state: {}", e)))?
            .as_str()
            .unwrap_or("candidate")
            .to_string();
        let scope_json = serde_json::to_string(&exp.scope)
            .map_err(|e| EvolutionError::Internal(format!("serialize scope: {}", e)))?;

        conn.execute(
            "INSERT OR REPLACE INTO experience_projection (experience_id, revision, parent_id, state, confidence, success_count, failure_count, created_at, updated_at, scope_json, content_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                exp.experience_id,
                exp.revision,
                exp.parent_id,
                state_str,
                exp.confidence,
                exp.success_count,
                exp.failure_count,
                exp.created_at,
                exp.updated_at,
                scope_json,
                exp.content_hash,
            ],
        )?;

        Ok(())
    }

    /// Query experiences by state.
    pub fn experiences_by_state(
        &self,
        state: ExperienceState,
    ) -> Result<Vec<ExperienceRevision>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;

        let state_str = serde_json::to_value(state)
            .map_err(|e| EvolutionError::Internal(format!("serialize state: {}", e)))?
            .as_str()
            .unwrap_or("candidate")
            .to_string();

        let mut stmt = conn.prepare(
            "SELECT experience_id, revision, parent_id, state, confidence, success_count, failure_count, created_at, updated_at, scope_json, content_hash FROM experience_projection WHERE state = ?1",
        )?;

        let rows = stmt.query_map(params![state_str], decode_experience)?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Insert a lineage edge between two experiences.
    pub fn insert_lineage_edge(
        &self,
        parent_id: &str,
        child_id: &str,
        edge_type: &str,
    ) -> Result<(), EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        conn.execute(
            "INSERT OR IGNORE INTO lineage_edges (parent_id, child_id, edge_type) VALUES (?1, ?2, ?3)",
            params![parent_id, child_id, edge_type],
        )?;
        Ok(())
    }

    /// Query lineage edges where the given experience is a parent.
    pub fn lineage_children(
        &self,
        parent_id: &str,
    ) -> Result<Vec<(String, String, String)>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let mut stmt = conn.prepare(
            "SELECT parent_id, child_id, edge_type FROM lineage_edges WHERE parent_id = ?1",
        )?;
        let rows = stmt.query_map(params![parent_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Query lineage edges where the given experience is a child.
    pub fn lineage_parents(
        &self,
        child_id: &str,
    ) -> Result<Vec<(String, String, String)>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let mut stmt = conn.prepare(
            "SELECT parent_id, child_id, edge_type FROM lineage_edges WHERE child_id = ?1",
        )?;
        let rows = stmt.query_map(params![child_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Rebuild all projections from events.
    ///
    /// Clears projection tables and replays all events. During rebuild,
    /// the caller should degrade to Shadow mode.
    pub fn rebuild_projection(&self) -> Result<(), EvolutionError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Clear projections
        tx.execute("DELETE FROM experience_projection", [])?;
        tx.execute("DELETE FROM runs", [])?;
        tx.execute("DELETE FROM lineage_edges", [])?;
        tx.execute("DELETE FROM reuse_observations", [])?;

        // Replay all events in order
        let payloads: Vec<(i64, String)> = {
            let mut stmt =
                tx.prepare("SELECT timestamp, payload FROM events ORDER BY timestamp, rowid")?;

            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?
        };

        for (timestamp, payload_json) in payloads {
            let event: EvolutionEvent = serde_json::from_str(&payload_json)
                .map_err(|e| EvolutionError::Internal(format!("deserialize event: {}", e)))?;
            Self::apply_event_to_projection(&tx, &event, timestamp)?;
        }

        tx.commit()?;
        Ok(())
    }

    /// Apply a single event to the projection tables.
    fn apply_event_to_projection(
        conn: &Connection,
        event: &EvolutionEvent,
        event_timestamp: i64,
    ) -> Result<(), EvolutionError> {
        match event {
            EvolutionEvent::RunStarted {
                run_id,
                trigger,
                config_snapshot,
            } => {
                let trigger_str = serde_json::to_value(trigger.trigger_type)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "manual".to_string());
                let trigger_json = serde_json::to_string(trigger)
                    .map_err(|e| EvolutionError::Internal(format!("serialize trigger: {e}")))?;
                let config_json = serde_json::to_string(config_snapshot)
                    .map_err(|e| EvolutionError::Internal(format!("serialize config: {e}")))?;
                conn.execute(
                    "INSERT OR IGNORE INTO runs (run_id, state, trigger_type, trigger_json, config_json, started_at) VALUES (?1, 'running', ?2, ?3, ?4, ?5)",
                    params![run_id, trigger_str, trigger_json, config_json, event_timestamp],
                )?;
            }
            EvolutionEvent::RunFinished {
                run_id,
                state,
                error,
            } => {
                let state_str = enum_string(state, "failed");
                conn.execute(
                    "UPDATE runs SET state = ?1, completed_at = ?2, error = ?3 WHERE run_id = ?4",
                    params![state_str, event_timestamp, error, run_id],
                )?;
            }
            EvolutionEvent::RevisionPublished {
                run_id: _,
                revision,
            } => {
                let state_str = serde_json::to_value(revision.state)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "candidate".to_string());
                let scope_json = serde_json::to_string(&revision.scope).unwrap_or_default();
                conn.execute(
                    "INSERT OR REPLACE INTO experience_projection (experience_id, revision, parent_id, state, confidence, success_count, failure_count, created_at, updated_at, scope_json, content_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        revision.experience_id,
                        revision.revision,
                        revision.parent_id,
                        state_str,
                        revision.confidence,
                        revision.success_count,
                        revision.failure_count,
                        revision.created_at,
                        revision.updated_at,
                        scope_json,
                        revision.content_hash,
                    ],
                )?;
                // Record lineage edge
                if let Some(parent_id) = &revision.parent_id {
                    conn.execute(
                        "INSERT OR IGNORE INTO lineage_edges (parent_id, child_id, edge_type) VALUES (?1, ?2, 'derives_from')",
                        params![parent_id, revision.experience_id],
                    )?;
                }
            }
            EvolutionEvent::ConfidenceTransitioned {
                run_id: _,
                experience_id,
                to,
                ..
            } => {
                // Update experience state based on confidence transition
                let (state_str, confidence) = match to {
                    ConfidenceState::Candidate { .. } => ("candidate", 0.0),
                    ConfidenceState::Active { confidence } => ("active", *confidence),
                    ConfidenceState::Decaying { confidence, .. } => ("decaying", *confidence),
                    ConfidenceState::Revalidating { .. } => ("revalidating", 0.0),
                    ConfidenceState::Quarantined { .. } => ("quarantined", 0.0),
                    ConfidenceState::Revoked { .. } => ("revoked", 0.0),
                };
                conn.execute(
                    "UPDATE experience_projection SET state = ?1, confidence = ?2, updated_at = ?3 WHERE experience_id = ?4",
                    params![state_str, confidence, event_timestamp, experience_id],
                )?;
            }
            EvolutionEvent::Quarantined { experience_id, .. } => {
                conn.execute(
                    "UPDATE experience_projection SET state = 'quarantined', confidence = 0.0, updated_at = ?1 WHERE experience_id = ?2",
                    params![event_timestamp, experience_id],
                )?;
            }
            EvolutionEvent::ReuseObserved {
                run_id: _,
                observation,
            } => {
                conn.execute(
                    "INSERT OR IGNORE INTO reuse_observations (observation_id, experience_id, run_id, outcome, observed_at, context_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        observation.observation_id,
                        observation.experience_id,
                        observation.run_id,
                        serde_json::to_value(observation.outcome).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "unknown".to_string()),
                        observation.observed_at,
                        observation.context_hash,
                    ],
                )?;
                // Update success/failure counts
                match observation.outcome {
                    ReuseOutcome::Helped => {
                        conn.execute(
                            "UPDATE experience_projection SET success_count = success_count + 1, updated_at = ?1 WHERE experience_id = ?2",
                            params![observation.observed_at, observation.experience_id],
                        )?;
                    }
                    ReuseOutcome::Hindered => {
                        conn.execute(
                            "UPDATE experience_projection SET failure_count = failure_count + 1, updated_at = ?1 WHERE experience_id = ?2",
                            params![observation.observed_at, observation.experience_id],
                        )?;
                    }
                    _ => {}
                }
            }
            _ => {} // Other events don't affect projections
        }
        Ok(())
    }

    /// Atomically commit an already-published evidence manifest and its
    /// associated event/projection update. The artifact file must be renamed
    /// into content-addressed storage before this method is called.
    pub fn append_with_evidence(
        &self,
        run_id: &str,
        event: &EvolutionEvent,
        bundle: &EvidenceBundle,
        causation_id: Option<&str>,
        idempotency_key: &str,
    ) -> Result<bool, EvolutionError> {
        if !bundle.scrubbed {
            return Err(EvolutionError::PreflightFailed(
                "evidence bundle was not scrubbed".to_string(),
            ));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT COUNT(*) > 0 FROM events WHERE idempotency_key = ?1",
            params![idempotency_key],
            |row| row.get(0),
        )?;
        if exists {
            return Ok(false);
        }

        let payload = serde_json::to_string(event)
            .map_err(|e| EvolutionError::Internal(format!("serialize event: {e}")))?;
        let content_hash = blake3::hash(payload.as_bytes()).to_hex().to_string();
        let event_id = uuid::Uuid::new_v4().to_string();
        let timestamp = now_epoch();
        tx.execute(
            "INSERT INTO events (event_id, run_id, causation_id, event_type, schema_version, timestamp, payload, content_hash, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event_id,
                run_id,
                causation_id,
                event_type_name(event),
                SCHEMA_VERSION,
                timestamp,
                payload,
                content_hash,
                idempotency_key,
            ],
        )?;
        let bundle_json = serde_json::to_string(bundle)
            .map_err(|e| EvolutionError::Internal(format!("serialize evidence: {e}")))?;
        tx.execute(
            "INSERT INTO evidence_manifests (manifest_id, run_id, artifact_hash, artifact_size, scrubbed, bundle_json, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
            params![
                bundle.bundle_id,
                run_id,
                bundle.content_hash,
                bundle.total_bytes,
                bundle_json,
                bundle.created_at,
            ],
        )?;
        Self::apply_event_to_projection(&tx, event, timestamp)?;
        tx.commit()?;
        Ok(true)
    }

    pub fn evidence_for_run(&self, run_id: &str) -> Result<Option<EvidenceBundle>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let json: Option<String> = conn
            .query_row(
                "SELECT bundle_json FROM evidence_manifests WHERE run_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| {
            serde_json::from_str(&value)
                .map_err(|e| EvolutionError::Internal(format!("deserialize evidence: {e}")))
        })
        .transpose()
    }

    pub fn known_artifact_hashes(&self) -> Result<Vec<ContentHash>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let mut stmt = conn.prepare(
            "SELECT artifact_hash FROM evidence_manifests UNION SELECT content_hash FROM experience_projection",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut hashes = Vec::new();
        for row in rows {
            hashes.push(row?);
        }
        Ok(hashes)
    }

    /// Persist a new rollout approval and revoke any previous active approval
    /// in one immediate transaction.
    pub fn save_rollout_approval(
        &self,
        approval: &RolloutApproval,
    ) -> Result<(), EvolutionError> {
        approval.verify()?;
        let readiness_json = serde_json::to_string(&approval.readiness).map_err(|error| {
            EvolutionError::Internal(format!("serialize rollout readiness: {error}"))
        })?;
        let evidence_json = serde_json::to_string(&approval.evidence).map_err(|error| {
            EvolutionError::Internal(format!("serialize rollout evidence: {error}"))
        })?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|error| EvolutionError::Internal(format!("lock poisoned: {error}")))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE rollout_approvals SET revoked_at = ?1, revocation_reason = 'superseded by a newer approval' WHERE revoked_at IS NULL",
            params![approval.approved_at],
        )?;
        tx.execute(
            "INSERT INTO rollout_approvals (approval_id, readiness_json, evidence_json, evidence_hash, approved_by, approved_at, revoked_at, revocation_reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
            params![
                approval.approval_id,
                readiness_json,
                evidence_json,
                approval.evidence_hash,
                approval.approved_by,
                approval.approved_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Load and integrity-check the active rollout approval, if one exists.
    pub fn current_rollout_approval(&self) -> Result<Option<RolloutApproval>, EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|error| EvolutionError::Internal(format!("lock poisoned: {error}")))?;
        let row: Option<(String, String, String, String, String, i64)> = conn
            .query_row(
                "SELECT approval_id, readiness_json, evidence_json, evidence_hash, approved_by, approved_at FROM rollout_approvals WHERE revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((approval_id, readiness_json, evidence_json, evidence_hash, approved_by, approved_at)) = row else {
            return Ok(None);
        };
        let approval = RolloutApproval {
            approval_id,
            readiness: serde_json::from_str::<RolloutReadiness>(&readiness_json).map_err(
                |error| {
                    EvolutionError::Internal(format!(
                        "deserialize persisted rollout readiness: {error}"
                    ))
                },
            )?,
            evidence: serde_json::from_str::<RolloutEvidence>(&evidence_json).map_err(|error| {
                EvolutionError::Internal(format!(
                    "deserialize persisted rollout evidence: {error}"
                ))
            })?,
            evidence_hash,
            approved_by,
            approved_at,
            revoked_at: None,
            revocation_reason: None,
        };
        approval.verify()?;
        Ok(Some(approval))
    }

    /// Revoke the active rollout approval. Returns false when none is active.
    pub fn revoke_rollout_approval(
        &self,
        reason: &str,
        revoked_at: i64,
    ) -> Result<bool, EvolutionError> {
        let reason = reason.trim();
        if reason.is_empty() || reason.len() > 512 || reason.chars().any(char::is_control) {
            return Err(EvolutionError::PreflightFailed(
                "revocation reason must be non-empty and at most 512 characters".to_string(),
            ));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|error| EvolutionError::Internal(format!("lock poisoned: {error}")))?;
        Ok(conn.execute(
            "UPDATE rollout_approvals SET revoked_at = ?1, revocation_reason = ?2 WHERE revoked_at IS NULL",
            params![revoked_at, reason],
        )? > 0)
    }

    /// Record a reuse observation and any resulting promotion/quarantine in a
    /// single transaction so the next selector read sees the new state.
    pub fn record_reuse_with_policy(
        &self,
        observation: &ReuseObservation,
        promote_after_successes: u32,
        quarantine_after_failures: u32,
    ) -> Result<ExperienceState, EvolutionError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|error| EvolutionError::Internal(format!("lock poisoned: {error}")))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let observation_key = format!("reuse:{}", observation.observation_id);
        let exists: bool = tx.query_row(
            "SELECT COUNT(*) > 0 FROM events WHERE idempotency_key = ?1",
            params![observation_key],
            |row| row.get(0),
        )?;
        if !exists {
            let event = EvolutionEvent::ReuseObserved {
                run_id: observation.run_id.clone(),
                observation: observation.clone(),
            };
            insert_event_in_tx(
                &tx,
                &observation.run_id,
                &event,
                None,
                Some(&observation_key),
                observation.observed_at,
            )?;
            Self::apply_event_to_projection(&tx, &event, observation.observed_at)?;
        }

        let (state_raw, successes, failures): (String, u32, u32) = tx
            .query_row(
                "SELECT state, success_count, failure_count FROM experience_projection WHERE experience_id = ?1",
                params![observation.experience_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let mut state: ExperienceState =
            serde_json::from_str(&format!("\"{state_raw}\"")).unwrap_or(ExperienceState::Candidate);
        let recent_outcomes = {
            let mut stmt = tx.prepare(
                "SELECT outcome FROM reuse_observations WHERE experience_id = ?1 ORDER BY rowid DESC LIMIT ?2",
            )?;
            stmt.query_map(
                params![observation.experience_id, quarantine_after_failures],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?
        };
        let consecutive_failures = recent_outcomes.len() >= quarantine_after_failures as usize
            && recent_outcomes.iter().all(|outcome| outcome == "hindered");
        let transition = if state == ExperienceState::Candidate
            && successes >= promote_after_successes
            && failures == 0
        {
            Some(EvolutionEvent::ConfidenceTransitioned {
                run_id: observation.run_id.clone(),
                experience_id: observation.experience_id.clone(),
                from: ConfidenceState::Candidate {
                    successes: successes.saturating_sub(1),
                    failures,
                },
                to: ConfidenceState::Active {
                    confidence: crate::state::confidence::initial_confidence(successes),
                },
            })
        } else if state == ExperienceState::Active && consecutive_failures {
            Some(EvolutionEvent::Quarantined {
                run_id: observation.run_id.clone(),
                experience_id: observation.experience_id.clone(),
                reason: crate::events::QuarantineReason {
                    reason_type: crate::events::QuarantineReasonType::ConsecutiveFailures,
                    description: format!(
                        "{failures} reuse failures (threshold {quarantine_after_failures})"
                    ),
                    triggering_run_id: Some(observation.run_id.clone()),
                    quarantined_at: observation.observed_at,
                },
            })
        } else {
            None
        };
        if let Some(event) = transition {
            let transition_key = format!("reuse-transition:{}", observation.observation_id);
            insert_event_in_tx(
                &tx,
                &observation.run_id,
                &event,
                None,
                Some(&transition_key),
                observation.observed_at,
            )?;
            Self::apply_event_to_projection(&tx, &event, observation.observed_at)?;
            state = match event {
                EvolutionEvent::ConfidenceTransitioned { .. } => ExperienceState::Active,
                EvolutionEvent::Quarantined { .. } => ExperienceState::Quarantined,
                _ => state,
            };
        }
        tx.commit()?;
        Ok(state)
    }

    /// Verify every stored event against its persisted blake3 hash.
    pub fn verify_event_hashes(&self) -> Result<(), EvolutionError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
        let mut stmt = conn.prepare("SELECT event_id, payload, content_hash FROM events")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (event_id, payload, expected) = row?;
            let actual = blake3::hash(payload.as_bytes()).to_hex().to_string();
            if actual != expected {
                tracing::error!(event_id, "evolution event hash mismatch");
                return Err(EvolutionError::ArtifactIntegrity { expected, actual });
            }
        }
        Ok(())
    }

    /// Mark stale running runs as abandoned using append-only terminal facts.
    /// Active trials are protected by `max_age_secs`; this should exceed the
    /// configured maximum trial duration.
    pub fn recover_stale_runs(&self, max_age_secs: u64) -> Result<u32, EvolutionError> {
        let cutoff = now_epoch().saturating_sub(max_age_secs as i64);
        let stale_ids = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| EvolutionError::Internal(format!("lock poisoned: {}", e)))?;
            let mut stmt = conn
                .prepare("SELECT run_id FROM runs WHERE state = 'running' AND started_at <= ?1")?;
            stmt.query_map(params![cutoff], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut recovered = 0;
        for run_id in stale_ids {
            let inserted = self.append_and_project(
                &run_id,
                &EvolutionEvent::RunFinished {
                    run_id: run_id.clone(),
                    state: RunState::Abandoned,
                    error: Some("recovered stale running run after process restart".to_string()),
                },
                None,
                Some(&format!("recover-abandoned:{run_id}")),
            )?;
            if inserted {
                recovered += 1;
            }
        }
        Ok(recovered)
    }
}

/// A raw event as stored in SQLite.
#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub event_id: String,
    pub run_id: String,
    pub causation_id: Option<String>,
    pub event_type: String,
    pub schema_version: u32,
    pub timestamp: i64,
    pub payload_json: String,
    pub content_hash: String,
    pub idempotency_key: Option<String>,
}

impl StoredEvent {
    pub fn decode(&self) -> Result<EvolutionEvent, EvolutionError> {
        serde_json::from_str(&self.payload_json)
            .map_err(|error| EvolutionError::Internal(format!("deserialize event: {error}")))
    }
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn insert_event_in_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    event: &EvolutionEvent,
    causation_id: Option<&str>,
    idempotency_key: Option<&str>,
    timestamp: i64,
) -> Result<(), EvolutionError> {
    let payload = serde_json::to_string(event)
        .map_err(|error| EvolutionError::Internal(format!("serialize event: {error}")))?;
    let content_hash = blake3::hash(payload.as_bytes()).to_hex().to_string();
    tx.execute(
        "INSERT INTO events (event_id, run_id, causation_id, event_type, schema_version, timestamp, payload, content_hash, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            run_id,
            causation_id,
            event_type_name(event),
            SCHEMA_VERSION,
            timestamp,
            payload,
            content_hash,
            idempotency_key,
        ],
    )?;
    Ok(())
}

fn enum_string<T: serde::Serialize>(value: &T, fallback: &str) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| fallback.to_string())
}

fn decode_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<EvolutionRun> {
    let state: String = row.get(1)?;
    let trigger_type: String = row.get(2)?;
    let trigger_json: String = row.get(3)?;
    let config_json: String = row.get(4)?;
    let trigger = serde_json::from_str(&trigger_json).unwrap_or_else(|_| TriggerInfo {
        trigger_type: serde_json::from_str(&format!("\"{trigger_type}\""))
            .unwrap_or(TriggerType::Manual),
        source_event_id: None,
        description: String::new(),
    });
    let config_snapshot = serde_json::from_str(&config_json).unwrap_or(ConfigSnapshot {
        mode: "unknown".to_string(),
        budget_max_duration_secs: 0,
        budget_max_variant_rounds: 0,
    });
    Ok(EvolutionRun {
        run_id: row.get(0)?,
        schema_version: SCHEMA_VERSION,
        state: serde_json::from_str(&format!("\"{state}\"")).unwrap_or(RunState::Failed),
        trigger,
        config_snapshot,
        started_at: row.get(5)?,
        completed_at: row.get(6)?,
        error: row.get(7)?,
    })
}

fn decode_experience(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExperienceRevision> {
    let scope_json: String = row.get(9)?;
    let state: String = row.get(3)?;
    Ok(ExperienceRevision {
        experience_id: row.get(0)?,
        revision: row.get(1)?,
        schema_version: SCHEMA_VERSION,
        parent_id: row.get(2)?,
        state: serde_json::from_str(&format!("\"{state}\"")).unwrap_or(ExperienceState::Candidate),
        confidence: row.get(4)?,
        success_count: row.get(5)?,
        failure_count: row.get(6)?,
        scope: serde_json::from_str(&scope_json).unwrap_or(ScopeFingerprint {
            repo: None,
            task_type: None,
            signal_types: vec![],
            env_fingerprint: None,
        }),
        content_hash: row.get(10)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// Derive the event type name from the enum variant.
fn event_type_name(event: &EvolutionEvent) -> &'static str {
    match event {
        EvolutionEvent::RunStarted { .. } => "RunStarted",
        EvolutionEvent::SignalsDetected { .. } => "SignalsDetected",
        EvolutionEvent::CandidatesRanked { .. } => "CandidatesRanked",
        EvolutionEvent::VariantProposed { .. } => "VariantProposed",
        EvolutionEvent::TrialStarted { .. } => "TrialStarted",
        EvolutionEvent::TrialCompleted { .. } => "TrialCompleted",
        EvolutionEvent::ValidationCompleted { .. } => "ValidationCompleted",
        EvolutionEvent::EvaluationCompleted { .. } => "EvaluationCompleted",
        EvolutionEvent::AdoptionDecided { .. } => "AdoptionDecided",
        EvolutionEvent::RevisionPublished { .. } => "RevisionPublished",
        EvolutionEvent::Quarantined { .. } => "Quarantined",
        EvolutionEvent::ReuseObserved { .. } => "ReuseObserved",
        EvolutionEvent::ConfidenceTransitioned { .. } => "ConfidenceTransitioned",
        EvolutionEvent::StageStarted { .. } => "StageStarted",
        EvolutionEvent::StageCompleted { .. } => "StageCompleted",
        EvolutionEvent::StageFailed { .. } => "StageFailed",
        EvolutionEvent::RunFinished { .. } => "RunFinished",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> EvolutionStore {
        EvolutionStore::open_memory().unwrap()
    }

    fn sample_run_event() -> EvolutionEvent {
        EvolutionEvent::RunStarted {
            run_id: "run-test-001".to_string(),
            trigger: TriggerInfo {
                trigger_type: TriggerType::TestFailure,
                source_event_id: None,
                description: "test failed".to_string(),
            },
            config_snapshot: ConfigSnapshot {
                mode: "shadow".to_string(),
                budget_max_duration_secs: 1200,
                budget_max_variant_rounds: 3,
            },
        }
    }

    fn sample_experience() -> ExperienceRevision {
        ExperienceRevision {
            experience_id: "exp-live".to_string(),
            revision: 1,
            schema_version: SCHEMA_VERSION,
            parent_id: None,
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: 0,
            failure_count: 0,
            scope: ScopeFingerprint {
                repo: Some("test/repo".to_string()),
                task_type: Some("coding".to_string()),
                signal_types: vec![SignalType::ToolFailure],
                env_fingerprint: None,
            },
            content_hash: "abc123".to_string(),
            created_at: 1000,
            updated_at: 1000,
        }
    }

    #[test]
    fn open_and_append() {
        let store = test_store();
        let event = sample_run_event();
        let inserted = store
            .append_event("run-test-001", &event, None, None)
            .unwrap();
        assert!(inserted);
        let projected = store.get_run("run-test-001").unwrap().unwrap();
        assert_eq!(projected.trigger.description, "test failed");
        assert_eq!(projected.config_snapshot.mode, "shadow");
    }

    #[test]
    fn idempotent_append() {
        let store = test_store();
        let event = sample_run_event();
        let k1 = store
            .append_event("run-test-001", &event, None, Some("key-001"))
            .unwrap();
        assert!(k1);
        let k2 = store
            .append_event("run-test-001", &event, None, Some("key-001"))
            .unwrap();
        assert!(!k2); // deduplicated
    }

    #[test]
    fn events_for_run_ordered() {
        let store = test_store();
        store
            .append_event("run-1", &sample_run_event(), None, Some("k1"))
            .unwrap();
        store
            .append_event(
                "run-1",
                &EvolutionEvent::SignalsDetected {
                    run_id: "run-1".to_string(),
                    signals: vec![],
                },
                None,
                Some("k2"),
            )
            .unwrap();
        store
            .append_event("run-2", &sample_run_event(), None, Some("k3"))
            .unwrap();

        let events = store.events_for_run("run-1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "RunStarted");
        assert_eq!(events[1].event_type, "SignalsDetected");
    }

    #[test]
    fn upsert_and_query_run() {
        let store = test_store();
        let run = EvolutionRun {
            run_id: "run-1".to_string(),
            schema_version: 1,
            state: RunState::Running,
            trigger: TriggerInfo {
                trigger_type: TriggerType::Manual,
                source_event_id: None,
                description: "manual".to_string(),
            },
            config_snapshot: ConfigSnapshot {
                mode: "shadow".to_string(),
                budget_max_duration_secs: 1200,
                budget_max_variant_rounds: 3,
            },
            started_at: 1000,
            completed_at: None,
            error: None,
        };
        store.upsert_run(&run).unwrap();
    }

    #[test]
    fn upsert_and_query_experience() {
        let store = test_store();
        let exp = ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: 0,
            failure_count: 0,
            scope: ScopeFingerprint {
                repo: Some("test/repo".to_string()),
                task_type: None,
                signal_types: vec![],
                env_fingerprint: None,
            },
            content_hash: "abc123".to_string(),
            created_at: 1000,
            updated_at: 1000,
        };
        store.upsert_experience(&exp).unwrap();

        let candidates = store
            .experiences_by_state(ExperienceState::Candidate)
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].experience_id, "exp-1");
    }

    #[test]
    fn rebuild_projection_from_events() {
        let store = test_store();

        // Append RunStarted
        store
            .append_event("run-1", &sample_run_event(), None, Some("k1"))
            .unwrap();

        // Append RevisionPublished
        store
            .append_event(
                "run-1",
                &EvolutionEvent::RevisionPublished {
                    run_id: "run-1".to_string(),
                    revision: ExperienceRevision {
                        experience_id: "exp-1".to_string(),
                        revision: 1,
                        schema_version: 1,
                        parent_id: None,
                        state: ExperienceState::Candidate,
                        confidence: 0.0,
                        success_count: 0,
                        failure_count: 0,
                        scope: ScopeFingerprint {
                            repo: None,
                            task_type: None,
                            signal_types: vec![],
                            env_fingerprint: None,
                        },
                        content_hash: "abc".to_string(),
                        created_at: 1000,
                        updated_at: 1000,
                    },
                },
                None,
                Some("k2"),
            )
            .unwrap();

        // Rebuild
        store.rebuild_projection().unwrap();

        let candidates = store
            .experiences_by_state(ExperienceState::Candidate)
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].experience_id, "exp-1");
    }

    #[test]
    fn live_projection_matches_rebuild() {
        let store = test_store();
        store
            .append_and_project("run-test-001", &sample_run_event(), None, Some("run"))
            .unwrap();
        store
            .append_and_project(
                "run-test-001",
                &EvolutionEvent::RevisionPublished {
                    run_id: "run-test-001".to_string(),
                    revision: sample_experience(),
                },
                None,
                Some("revision"),
            )
            .unwrap();
        let live_run = store.get_run("run-test-001").unwrap().unwrap();
        let live_exp = store.get_experience("exp-live").unwrap().unwrap();
        store.rebuild_projection().unwrap();
        let rebuilt_run = store.get_run("run-test-001").unwrap().unwrap();
        let rebuilt_exp = store.get_experience("exp-live").unwrap().unwrap();
        assert_eq!(
            live_run.trigger.description,
            rebuilt_run.trigger.description
        );
        assert_eq!(live_exp.state, rebuilt_exp.state);
        assert_eq!(live_exp.scope.repo, rebuilt_exp.scope.repo);
    }

    #[test]
    fn reuse_lifecycle_is_immediately_visible_and_idempotent() {
        let store = test_store();
        store.upsert_experience(&sample_experience()).unwrap();
        for index in 0..3 {
            let observation = ReuseObservation {
                observation_id: format!("help-{index}"),
                schema_version: SCHEMA_VERSION,
                experience_id: "exp-live".to_string(),
                run_id: format!("reuse-{index}"),
                outcome: ReuseOutcome::Helped,
                context_hash: format!("ctx-{index}"),
                observed_at: 2000 + index,
            };
            let state = store.record_reuse_with_policy(&observation, 3, 2).unwrap();
            if index == 2 {
                assert_eq!(state, ExperienceState::Active);
            }
        }
        let duplicate = ReuseObservation {
            observation_id: "help-2".to_string(),
            schema_version: SCHEMA_VERSION,
            experience_id: "exp-live".to_string(),
            run_id: "reuse-2".to_string(),
            outcome: ReuseOutcome::Helped,
            context_hash: "ctx-2".to_string(),
            observed_at: 2002,
        };
        assert_eq!(
            store.record_reuse_with_policy(&duplicate, 3, 2).unwrap(),
            ExperienceState::Active
        );
        assert_eq!(
            store
                .get_experience("exp-live")
                .unwrap()
                .unwrap()
                .success_count,
            3
        );
        for index in 0..2 {
            let observation = ReuseObservation {
                observation_id: format!("fail-{index}"),
                schema_version: SCHEMA_VERSION,
                experience_id: "exp-live".to_string(),
                run_id: format!("failure-{index}"),
                outcome: ReuseOutcome::Hindered,
                context_hash: format!("bad-{index}"),
                observed_at: 3000 + index,
            };
            let state = store.record_reuse_with_policy(&observation, 3, 2).unwrap();
            if index == 1 {
                assert_eq!(state, ExperienceState::Quarantined);
            }
        }
        assert!(
            store
                .experiences_by_state(ExperienceState::Active)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn event_hash_tampering_is_detected() {
        let store = test_store();
        store
            .append_event("run-test-001", &sample_run_event(), None, Some("hash"))
            .unwrap();
        store
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE events SET payload = '{}'", [])
            .unwrap();
        assert!(matches!(
            store.verify_event_hashes(),
            Err(EvolutionError::ArtifactIntegrity { .. })
        ));
    }
}
