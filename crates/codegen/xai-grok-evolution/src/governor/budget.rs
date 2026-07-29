//! Budget checking for evolution runs.

use crate::types::*;
use super::BudgetStatus;

/// Check if a run is within its budget constraints.
pub fn check(
    run: &EvolutionRun,
    elapsed_secs: u64,
    rounds: u32,
    _max_sla_secs: u64,
) -> BudgetStatus {
    if elapsed_secs > run.config_snapshot.budget_max_duration_secs {
        return BudgetStatus::Exceeded {
            reason: format!(
                "duration {}s exceeds limit {}s",
                elapsed_secs, run.config_snapshot.budget_max_duration_secs
            ),
        };
    }

    if rounds > run.config_snapshot.budget_max_variant_rounds {
        return BudgetStatus::Exceeded {
            reason: format!(
                "rounds {} exceeds limit {}",
                rounds, run.config_snapshot.budget_max_variant_rounds
            ),
        };
    }

    BudgetStatus::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_run(max_duration: u64, max_rounds: u32) -> EvolutionRun {
        EvolutionRun {
            run_id: "r1".to_string(),
            schema_version: 1,
            state: RunState::Running,
            trigger: TriggerInfo {
                trigger_type: TriggerType::Manual,
                source_event_id: None,
                description: "".to_string(),
            },
            config_snapshot: ConfigSnapshot {
                mode: "shadow".to_string(),
                budget_max_duration_secs: max_duration,
                budget_max_variant_rounds: max_rounds,
            },
            started_at: 1000,
            completed_at: None,
            error: None,
        }
    }

    #[test]
    fn within_budget() {
        let run = make_run(1200, 3);
        assert_eq!(check(&run, 600, 2, 5), BudgetStatus::Ok);
    }

    #[test]
    fn duration_exceeded() {
        let run = make_run(1200, 3);
        match check(&run, 1300, 2, 5) {
            BudgetStatus::Exceeded { reason } => assert!(reason.contains("duration")),
            _ => panic!("expected Exceeded"),
        }
    }

    #[test]
    fn rounds_exceeded() {
        let run = make_run(1200, 3);
        match check(&run, 600, 4, 5) {
            BudgetStatus::Exceeded { reason } => assert!(reason.contains("rounds")),
            _ => panic!("expected Exceeded"),
        }
    }
}
