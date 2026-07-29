//! Experience lineage graph: parent-child relationships.
//!
//! Maintains the DAG of experience revisions, supporting queries like:
//! - "What is the ancestry of this experience?"
//! - "What experiences supersede this one?"

use crate::events::store::EvolutionStore;
use crate::error::EvolutionError;
use crate::types::*;

/// Edge in the experience lineage graph.
#[derive(Debug, Clone)]
pub struct LineageEdge {
    pub parent_id: ExperienceId,
    pub child_id: ExperienceId,
    pub edge_type: LineageEdgeType,
}

/// Record a lineage edge between two experience revisions.
pub fn record_lineage(
    store: &EvolutionStore,
    parent_id: &str,
    child_id: &str,
    edge_type: LineageEdgeType,
) -> Result<(), EvolutionError> {
    let edge_type_str = serde_json::to_value(&edge_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "derives_from".to_string());
    store.insert_lineage_edge(parent_id, child_id, &edge_type_str)
}

/// Query all edges where the given experience is a parent.
pub fn children_of(
    store: &EvolutionStore,
    parent_id: &str,
) -> Result<Vec<LineageEdge>, EvolutionError> {
    let raw = store.lineage_children(parent_id)?;
    Ok(raw
        .into_iter()
        .map(|(p, c, t)| LineageEdge {
            parent_id: p,
            child_id: c,
            edge_type: serde_json::from_str(&format!("\"{}\"", t))
                .unwrap_or(LineageEdgeType::DerivesFrom),
        })
        .collect())
}

/// Query all edges where the given experience is a child.
pub fn parents_of(
    store: &EvolutionStore,
    child_id: &str,
) -> Result<Vec<LineageEdge>, EvolutionError> {
    let raw = store.lineage_parents(child_id)?;
    Ok(raw
        .into_iter()
        .map(|(p, c, t)| LineageEdge {
            parent_id: p,
            child_id: c,
            edge_type: serde_json::from_str(&format!("\"{}\"", t))
                .unwrap_or(LineageEdgeType::DerivesFrom),
        })
        .collect())
}

/// Build the full ancestry chain for an experience (walk parent links).
pub fn ancestry(
    store: &EvolutionStore,
    experience_id: &str,
) -> Result<Vec<ExperienceId>, EvolutionError> {
    let mut chain = Vec::new();
    let mut current = experience_id.to_string();

    loop {
        let parents = parents_of(store, &current)?;
        if parents.is_empty() {
            break;
        }
        let parent = parents
            .iter()
            .find(|e| e.edge_type == LineageEdgeType::DerivesFrom)
            .or_else(|| parents.first());

        if let Some(parent) = parent {
            chain.push(parent.parent_id.clone());
            current = parent.parent_id.clone();
        } else {
            break;
        }

        if chain.len() > 100 {
            break;
        }
    }

    Ok(chain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_query_children() {
        let store = EvolutionStore::open_memory().unwrap();
        record_lineage(&store, "parent-1", "child-1", LineageEdgeType::DerivesFrom).unwrap();

        let children = children_of(&store, "parent-1").unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].child_id, "child-1");
        assert_eq!(children[0].edge_type, LineageEdgeType::DerivesFrom);
    }

    #[test]
    fn query_parents() {
        let store = EvolutionStore::open_memory().unwrap();
        record_lineage(&store, "parent-1", "child-1", LineageEdgeType::DerivesFrom).unwrap();

        let parents = parents_of(&store, "child-1").unwrap();
        assert_eq!(parents.len(), 1);
        assert_eq!(parents[0].parent_id, "parent-1");
    }

    #[test]
    fn ancestry_chain() {
        let store = EvolutionStore::open_memory().unwrap();
        record_lineage(&store, "root", "mid", LineageEdgeType::DerivesFrom).unwrap();
        record_lineage(&store, "mid", "leaf", LineageEdgeType::DerivesFrom).unwrap();

        let chain = ancestry(&store, "leaf").unwrap();
        assert_eq!(chain, vec!["mid", "root"]);
    }

    #[test]
    fn ancestry_empty_for_root() {
        let store = EvolutionStore::open_memory().unwrap();
        let chain = ancestry(&store, "root").unwrap();
        assert!(chain.is_empty());
    }

    #[test]
    fn duplicate_edge_ignored() {
        let store = EvolutionStore::open_memory().unwrap();
        record_lineage(&store, "p", "c", LineageEdgeType::DerivesFrom).unwrap();
        record_lineage(&store, "p", "c", LineageEdgeType::DerivesFrom).unwrap(); // duplicate

        let children = children_of(&store, "p").unwrap();
        assert_eq!(children.len(), 1); // dedup by primary key
    }

    #[test]
    fn supersede_edge() {
        let store = EvolutionStore::open_memory().unwrap();
        record_lineage(&store, "old", "new", LineageEdgeType::Supersedes).unwrap();

        let children = children_of(&store, "old").unwrap();
        assert_eq!(children[0].edge_type, LineageEdgeType::Supersedes);
    }
}
