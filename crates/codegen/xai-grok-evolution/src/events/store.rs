//! SQLite-backed event store.
//!
//! Provides append-only event storage with idempotent deduplication,
//! run projection queries, and projection rebuild capabilities.
//! Uses `xai-sqlite-journal` for safe journal mode selection.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

use crate::error::EvolutionError;
use crate::events::schema::{SCHEMA_SQL, SCHEMA_VERSION};
use crate::events::EvolutionEvent;
use crate::types::*;

/// Append-only event store backed by SQLite.
///
/// All writes go through a `Mutex<Connection>` to ensure serial access
/// within a single process. Readers can open separate connections for
/// read-only queries (WAL mode supports concurrent reads).
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
    #[cfg(feature = "test-support")]
    pub fn open_memory() -> Result<Self, EvolutionError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA_SQL)?;
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
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;

        // Check idempotency
        if let Some(key) = idempotency_key {
            let exists: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM events WHERE idempotency_key = ?1",
                params![key],
                |row| row.get(0),
            )?;
            if exists {
                return Ok(false);
            }
        }

        let event_type = event_type_name(event);
        let payload = serde_json::to_string(event).map_err(|e| {
            EvolutionError::Internal(format!("serialize event: {}", e))
        })?;
        let content_hash = blake3::hash(payload.as_bytes()).to_hex().to_string();

        let event_id = uuid::Uuid::new_v4().to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        conn.execute(
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

        Ok(true)
    }

    /// Query all events for a given run, ordered by timestamp.
    pub fn events_for_run(&self, run_id: &str) -> Result<Vec<StoredEvent>, EvolutionError> {
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;

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

    /// Update the run projection.
    pub fn upsert_run(&self, run: &EvolutionRun) -> Result<(), EvolutionError> {
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;

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

        conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, state, trigger_type, started_at, completed_at, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                run.run_id,
                state_str,
                trigger_str,
                run.started_at,
                run.completed_at,
                run.error,
            ],
        )?;

        Ok(())
    }

    /// Upsert an experience projection record.
    pub fn upsert_experience(&self, exp: &ExperienceRevision) -> Result<(), EvolutionError> {
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;

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
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;

        let state_str = serde_json::to_value(state)
            .map_err(|e| EvolutionError::Internal(format!("serialize state: {}", e)))?
            .as_str()
            .unwrap_or("candidate")
            .to_string();

        let mut stmt = conn.prepare(
            "SELECT experience_id, revision, parent_id, state, confidence, success_count, failure_count, created_at, updated_at, scope_json, content_hash FROM experience_projection WHERE state = ?1",
        )?;

        let rows = stmt.query_map(params![state_str], |row| {
            let scope_json: String = row.get(9)?;
            let state_val: String = row.get(3)?;
            Ok(ExperienceRevision {
                experience_id: row.get(0)?,
                revision: row.get(1)?,
                schema_version: SCHEMA_VERSION,
                parent_id: row.get(2)?,
                state: serde_json::from_str(&format!("\"{}\"", state_val)).unwrap_or(ExperienceState::Candidate),
                confidence: row.get(4)?,
                success_count: row.get::<_, u32>(5)?,
                failure_count: row.get::<_, u32>(6)?,
                scope: serde_json::from_str(&scope_json).unwrap_or_else(|_| crate::types::ScopeFingerprint {
                    repo: None,
                    task_type: None,
                    signal_types: vec![],
                    env_fingerprint: None,
                }),
                content_hash: row.get(10)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

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
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;
        conn.execute(
            "INSERT OR IGNORE INTO lineage_edges (parent_id, child_id, edge_type) VALUES (?1, ?2, ?3)",
            params![parent_id, child_id, edge_type],
        )?;
        Ok(())
    }

    /// Query lineage edges where the given experience is a parent.
    pub fn lineage_children(&self, parent_id: &str) -> Result<Vec<(String, String, String)>, EvolutionError> {
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;
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
    pub fn lineage_parents(&self, child_id: &str) -> Result<Vec<(String, String, String)>, EvolutionError> {
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;
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
        let conn = self.conn.lock().map_err(|e| {
            EvolutionError::Internal(format!("lock poisoned: {}", e))
        })?;

        // Clear projections
        conn.execute("DELETE FROM experience_projection", [])?;
        conn.execute("DELETE FROM runs", [])?;
        conn.execute("DELETE FROM lineage_edges", [])?;

        // Replay all events in order
        let mut stmt = conn.prepare(
            "SELECT payload FROM events ORDER BY run_id, timestamp",
        )?;

        let payloads: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        for payload_json in payloads {
            let event: EvolutionEvent = serde_json::from_str(&payload_json)
                .map_err(|e| EvolutionError::Internal(format!("deserialize event: {}", e)))?;
            self.apply_event_to_projection(&conn, &event)?;
        }

        Ok(())
    }

    /// Apply a single event to the projection tables.
    fn apply_event_to_projection(
        &self,
        conn: &Connection,
        event: &EvolutionEvent,
    ) -> Result<(), EvolutionError> {
        match event {
            EvolutionEvent::RunStarted { run_id, trigger, .. } => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                let trigger_str = serde_json::to_value(trigger.trigger_type)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "manual".to_string());
                conn.execute(
                    "INSERT OR IGNORE INTO runs (run_id, state, trigger_type, started_at) VALUES (?1, 'running', ?2, ?3)",
                    params![run_id, trigger_str, now],
                )?;
            }
            EvolutionEvent::RevisionPublished { run_id: _, revision } => {
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
            EvolutionEvent::ConfidenceTransitioned { run_id: _, experience_id, to, .. } => {
                // Update experience state based on confidence transition
                let (state_str, confidence) = match to {
                    ConfidenceState::Candidate { .. } => ("candidate", 0.0),
                    ConfidenceState::Active { confidence } => ("active", *confidence),
                    ConfidenceState::Decaying { confidence, .. } => ("decaying", *confidence),
                    ConfidenceState::Revalidating { .. } => ("revalidating", 0.0),
                    ConfidenceState::Quarantined { .. } => ("quarantined", 0.0),
                    ConfidenceState::Revoked { .. } => ("revoked", 0.0),
                };
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                conn.execute(
                    "UPDATE experience_projection SET state = ?1, confidence = ?2, updated_at = ?3 WHERE experience_id = ?4",
                    params![state_str, confidence, now, experience_id],
                )?;
            }
            EvolutionEvent::ReuseObserved { run_id: _, observation } => {
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

    #[test]
    fn open_and_append() {
        let store = test_store();
        let event = sample_run_event();
        let inserted = store.append_event("run-test-001", &event, None, None).unwrap();
        assert!(inserted);
    }

    #[test]
    fn idempotent_append() {
        let store = test_store();
        let event = sample_run_event();
        let k1 = store.append_event("run-test-001", &event, None, Some("key-001")).unwrap();
        assert!(k1);
        let k2 = store.append_event("run-test-001", &event, None, Some("key-001")).unwrap();
        assert!(!k2); // deduplicated
    }

    #[test]
    fn events_for_run_ordered() {
        let store = test_store();
        store.append_event("run-1", &sample_run_event(), None, Some("k1")).unwrap();
        store.append_event("run-1", &EvolutionEvent::SignalsDetected {
            run_id: "run-1".to_string(),
            signals: vec![],
        }, None, Some("k2")).unwrap();
        store.append_event("run-2", &sample_run_event(), None, Some("k3")).unwrap();

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

        let candidates = store.experiences_by_state(ExperienceState::Candidate).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].experience_id, "exp-1");
    }

    #[test]
    fn rebuild_projection_from_events() {
        let store = test_store();

        // Append RunStarted
        store.append_event("run-1", &sample_run_event(), None, Some("k1")).unwrap();

        // Append RevisionPublished
        store.append_event("run-1", &EvolutionEvent::RevisionPublished {
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
        }, None, Some("k2")).unwrap();

        // Rebuild
        store.rebuild_projection().unwrap();

        let candidates = store.experiences_by_state(ExperienceState::Candidate).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].experience_id, "exp-1");
    }
}
