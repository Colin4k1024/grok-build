//! Token budget allocation between parent and child contexts.
//!
//! The [`BudgetAllocator`] tracks how many tokens have been allocated to
//! child contexts and ensures the parent never over-commits its budget.

use crate::types::{ContextError, ContextResult, SubBudgetAllocation, TokenBudget};

/// Minimum token budget a child context may receive.
const MIN_CHILD_BUDGET: usize = 1_024;

/// Manages token budget allocation between a parent context and its children.
///
/// # Lifecycle
///
/// 1. Create from the parent's [`TokenBudget`].
/// 2. Call [`allocate`](BudgetAllocator::allocate) each time the agent opens
///    a child context window.
/// 3. Call [`reclaim`](BudgetAllocator::reclaim) when the child context
///    completes, freeing its budget for future children.
#[derive(Debug, Clone)]
pub struct BudgetAllocator {
    /// The parent's full token budget.
    parent_budget: TokenBudget,
    /// Cumulative tokens currently allocated to active children.
    allocated_to_children: usize,
}

impl BudgetAllocator {
    /// Create a new allocator from the parent's token budget.
    pub fn new(parent_budget: TokenBudget) -> Self {
        Self {
            parent_budget,
            allocated_to_children: 0,
        }
    }

    /// Allocate a token budget for a new child context.
    ///
    /// If `requested` is `None`, the child receives
    /// `child_max_ratio * available` tokens.
    ///
    /// Returns the child's [`TokenBudget`] or an error if insufficient
    /// tokens remain.
    pub fn allocate(&mut self, requested: Option<usize>) -> ContextResult<TokenBudget> {
        let available = self.available();

        let child_max = match requested {
            Some(r) => r.min(available),
            None => {
                let ratio = self.parent_budget.sub_budget.child_max_ratio;
                (available as f64 * ratio) as usize
            }
        };

        if child_max < MIN_CHILD_BUDGET {
            return Err(ContextError::TokenBudgetExceeded {
                used: child_max,
                max: available,
            });
        }

        self.allocated_to_children += child_max;

        Ok(TokenBudget {
            max_total: child_max,
            auto_compact_threshold: self.parent_budget.auto_compact_threshold,
            // Reserve a quarter of the child budget for its response.
            reserve_for_response: child_max / 4,
            sub_budget: SubBudgetAllocation {
                // Children of children get at most half the budget.
                child_max_ratio: 0.5,
                summary_injection_max: self.parent_budget.sub_budget.summary_injection_max,
            },
        })
    }

    /// Reclaim the full budget previously allocated to a completed child.
    ///
    /// When a child context window closes, its entire allocated budget is
    /// freed — not just the tokens it actually used — because the reserved
    /// capacity is no longer needed.
    pub fn reclaim(&mut self, child_budget: &TokenBudget, _child_actual_usage: usize) {
        self.allocated_to_children = self
            .allocated_to_children
            .saturating_sub(child_budget.max_total);
    }

    /// Tokens currently available for new children.
    pub fn available(&self) -> usize {
        let reserve = self.parent_budget.reserve_for_response;
        let usable = self.parent_budget.max_total.saturating_sub(reserve);
        usable.saturating_sub(self.allocated_to_children)
    }

    /// Tokens currently allocated to active children.
    pub fn allocated(&self) -> usize {
        self.allocated_to_children
    }

    /// The parent's full budget.
    pub fn parent_budget(&self) -> &TokenBudget {
        &self.parent_budget
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_budget() -> TokenBudget {
        TokenBudget {
            max_total: 100_000,
            auto_compact_threshold: 0.85,
            reserve_for_response: 4_096,
            sub_budget: SubBudgetAllocation {
                child_max_ratio: 0.5,
                summary_injection_max: 512,
            },
        }
    }

    #[test]
    fn allocate_default_ratio() {
        let mut alloc = BudgetAllocator::new(default_budget());
        let child = alloc.allocate(None).unwrap();
        // available = 100_000 - 4_096 = 95_904
        // child_max = 95_904 * 0.5 = 47_952
        assert_eq!(child.max_total, 47_952);
        assert_eq!(child.reserve_for_response, 47_952 / 4);
    }

    #[test]
    fn allocate_requested_capped() {
        let mut alloc = BudgetAllocator::new(default_budget());
        let child = alloc.allocate(Some(10_000)).unwrap();
        assert_eq!(child.max_total, 10_000);
    }

    #[test]
    fn allocate_requested_exceeds_available() {
        let mut alloc = BudgetAllocator::new(default_budget());
        let child = alloc.allocate(Some(200_000)).unwrap();
        // Capped to available.
        assert_eq!(child.max_total, 95_904);
    }

    #[test]
    fn allocate_multiple_children() {
        let mut alloc = BudgetAllocator::new(default_budget());
        let c1 = alloc.allocate(Some(30_000)).unwrap();
        assert_eq!(alloc.allocated(), 30_000);

        let c2 = alloc.allocate(Some(30_000)).unwrap();
        assert_eq!(alloc.allocated(), 60_000);

        let c3 = alloc.allocate(Some(30_000)).unwrap();
        assert_eq!(alloc.allocated(), 90_000);

        // Fourth child is capped to remaining available (5,904).
        let c4 = alloc.allocate(Some(10_000)).unwrap();
        assert_eq!(c4.max_total, 5_904);
        assert_eq!(alloc.allocated(), 95_904);

        // Fifth child: nothing left.
        assert!(alloc.allocate(Some(1)).is_err());
    }

    #[test]
    fn reclaim_frees_budget() {
        let mut alloc = BudgetAllocator::new(default_budget());
        let child = alloc.allocate(Some(50_000)).unwrap();
        assert_eq!(alloc.allocated(), 50_000);

        // Reclaim frees the full allocated budget, not just usage.
        alloc.reclaim(&child, 20_000);
        assert_eq!(alloc.allocated(), 0);

        // Now we can allocate the full available again.
        let child2 = alloc.allocate(Some(50_000)).unwrap();
        assert_eq!(child2.max_total, 50_000);
    }

    #[test]
    fn min_budget_enforced() {
        let tiny = TokenBudget {
            max_total: 2_000,
            reserve_for_response: 1_000,
            ..default_budget()
        };
        let mut alloc = BudgetAllocator::new(tiny);
        // available = 2_000 - 1_000 = 1_000 < MIN_CHILD_BUDGET (1_024)
        assert!(alloc.allocate(None).is_err());
    }
}
