//! Token count caching to avoid redundant re-estimation.

use std::collections::HashMap;

use parking_lot::RwLock;

use crate::types::MessageId;

/// Cached entry for a single message's token count.
#[derive(Debug, Clone)]
struct CacheEntry {
    /// The estimated token count.
    tokens: usize,
    /// Rough byte size of the message content for memory_usage tracking.
    content_bytes: usize,
}

/// Thread-safe cache mapping message IDs to their token estimates.
///
/// The cache is invalidated incrementally: when a message is updated or
/// removed, only the affected entries are cleared.
#[derive(Debug)]
pub struct TokenCache {
    inner: RwLock<HashMap<MessageId, CacheEntry>>,
}

impl TokenCache {
    /// Create an empty cache.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    /// Look up a cached token count for the given message ID.
    pub fn get(&self, id: &MessageId) -> Option<usize> {
        self.inner.read().get(id).map(|e| e.tokens)
    }

    /// Insert or overwrite the token count for a message.
    pub fn insert(&self, id: MessageId, tokens: usize, content_bytes: usize) {
        self.inner.write().insert(
            id,
            CacheEntry {
                tokens,
                content_bytes,
            },
        );
    }

    /// Invalidate cache entries for message IDs that fall within the given
    /// index range. The caller provides a slice of `(index, id)` pairs
    /// corresponding to the current history so we can translate indices to IDs.
    pub fn invalidate_range(&self, start: usize, end: usize, indexed_ids: &[(usize, &MessageId)]) {
        let mut guard = self.inner.write();
        for (idx, id) in indexed_ids {
            if *idx >= start && *idx < end {
                guard.remove(*id);
            }
        }
    }

    /// Remove all entries from the cache.
    pub fn clear(&self) {
        self.inner.write().clear();
    }

    /// Approximate memory usage of the cache in bytes (entries only, not
    /// counting HashMap overhead).
    pub fn memory_usage(&self) -> usize {
        let guard = self.inner.read();
        // Rough estimate: MessageId(16 bytes) + CacheEntry(8 + 8 bytes) per entry
        guard.len() * (16 + 16)
    }
}

impl Default for TokenCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_get() {
        let cache = TokenCache::new();
        let id = MessageId::new();
        assert_eq!(cache.get(&id), None);
        cache.insert(id.clone(), 42, 100);
        assert_eq!(cache.get(&id), Some(42));
    }

    #[test]
    fn test_invalidate_range() {
        let cache = TokenCache::new();
        let ids: Vec<MessageId> = (0..5).map(|_| MessageId::new()).collect();
        for (i, id) in ids.iter().enumerate() {
            cache.insert(id.clone(), (i + 1) * 10, 100);
        }

        // Invalidate range 1..3
        let indexed: Vec<(usize, &MessageId)> = ids.iter().enumerate().collect();
        cache.invalidate_range(1, 3, &indexed);

        assert_eq!(cache.get(&ids[0]), Some(10));
        assert_eq!(cache.get(&ids[1]), None);
        assert_eq!(cache.get(&ids[2]), None);
        assert_eq!(cache.get(&ids[3]), Some(40));
        assert_eq!(cache.get(&ids[4]), Some(50));
    }

    #[test]
    fn test_clear() {
        let cache = TokenCache::new();
        let id = MessageId::new();
        cache.insert(id.clone(), 10, 100);
        cache.clear();
        assert_eq!(cache.get(&id), None);
    }

    #[test]
    fn test_memory_usage() {
        let cache = TokenCache::new();
        let baseline = cache.memory_usage();
        cache.insert(MessageId::new(), 10, 100);
        cache.insert(MessageId::new(), 20, 200);
        assert!(cache.memory_usage() > baseline);
        assert_eq!(cache.memory_usage(), baseline + 2 * (16 + 16));
    }
}
