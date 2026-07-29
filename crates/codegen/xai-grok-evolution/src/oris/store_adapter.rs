//! Store adapter: Oris GeneStorePersistPort + EvolutionStore → grok-build SQLite.
//!
//! Bridges Oris's gene persistence model with grok-build's `EvolutionStore`.
//! Oris operates on Gene/Capsule strings; grok-build stores structured
//! ExperienceRevision records. The adapter translates between them.

use oris_evolution::port::GeneStorePersistPort;

use crate::events::store::EvolutionStore;
use crate::types::*;

/// Grok gene store adapter.
///
/// Translates Oris's gene persistence calls into grok-build's
/// experience revision upserts and event appends.
pub struct GrokGeneStoreAdapter {
    store: EvolutionStore,
}

impl GrokGeneStoreAdapter {
    pub fn new(store: EvolutionStore) -> Self {
        Self { store }
    }
}

impl GeneStorePersistPort for GrokGeneStoreAdapter {
    fn persist_gene(
        &self,
        gene_id: &str,
        _signals: &[String],
        strategy: &[String],
        validation: &[String],
    ) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let revision = ExperienceRevision {
            experience_id: gene_id.to_string(),
            revision: 1,
            schema_version: CURRENT_SCHEMA_VERSION,
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
            content_hash: blake3::hash(
                format!("{}:{:?}:{:?}", gene_id, strategy, validation).as_bytes(),
            )
            .to_hex()
            .to_string(),
            created_at: now,
            updated_at: now,
        };

        // Append and project atomically.
        let event = crate::events::EvolutionEvent::RevisionPublished {
            run_id: format!("oris-{}", gene_id),
            revision,
        };
        self.store
            .append_event(
                &format!("oris-{}", gene_id),
                &event,
                None,
                Some(&format!("persist-{}", gene_id)),
            )
            .is_ok()
    }

    fn mark_reused(&self, gene_id: &str, capsule_ids: &[String]) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        for capsule_id in capsule_ids {
            let event = crate::events::EvolutionEvent::ReuseObserved {
                run_id: format!("oris-reuse-{}", gene_id),
                observation: ReuseObservation {
                    observation_id: capsule_id.clone(),
                    schema_version: CURRENT_SCHEMA_VERSION,
                    experience_id: gene_id.to_string(),
                    run_id: format!("oris-reuse-{}", gene_id),
                    outcome: ReuseOutcome::Helped,
                    context_hash: blake3::hash(capsule_id.as_bytes()).to_hex().to_string(),
                    observed_at: now,
                },
            };
            if self
                .store
                .append_event(
                    &format!("oris-reuse-{}", gene_id),
                    &event,
                    None,
                    Some(&format!("reuse-{}-{}", gene_id, capsule_id)),
                )
                .is_err()
            {
                return false;
            }
        }

        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_gene_creates_experience() {
        let store = EvolutionStore::open_memory().unwrap();
        let adapter = GrokGeneStoreAdapter::new(store);

        let result = adapter.persist_gene(
            "gene-1",
            &["sig-1".to_string()],
            &["fix null handling".to_string()],
            &["cargo test passes".to_string()],
        );
        assert!(result);
    }

    #[test]
    fn mark_reused_records_observation() {
        let store = EvolutionStore::open_memory().unwrap();
        let adapter = GrokGeneStoreAdapter::new(store);

        let result = adapter.mark_reused(
            "gene-1",
            &["capsule-1".to_string(), "capsule-2".to_string()],
        );
        assert!(result);
    }
}
