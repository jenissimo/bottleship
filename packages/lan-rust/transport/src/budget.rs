//! Atomic record+byte reservation. A lease follows actual ownership, never a remote ACK.
use std::sync::{Arc, Mutex};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub records: usize,
    pub bytes: usize,
}
#[derive(Debug)]
pub struct Budget {
    limit: Usage,
    used: Mutex<Usage>,
}
impl Budget {
    pub fn new(records: usize, bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            limit: Usage { records, bytes },
            used: Mutex::new(Usage::default()),
        })
    }
    pub fn try_acquire(self: &Arc<Self>, records: usize, bytes: usize) -> Option<Lease> {
        let mut used = self.used.lock().unwrap();
        let next = Usage {
            records: used.records.checked_add(records)?,
            bytes: used.bytes.checked_add(bytes)?,
        };
        if next.records > self.limit.records || next.bytes > self.limit.bytes {
            return None;
        }
        *used = next;
        Some(Lease {
            budget: self.clone(),
            amount: Usage { records, bytes },
        })
    }
    pub fn used(&self) -> Usage {
        *self.used.lock().unwrap()
    }
}
#[derive(Debug)]
pub struct Lease {
    budget: Arc<Budget>,
    amount: Usage,
}
impl Lease {
    pub fn amount(&self) -> Usage {
        self.amount
    }
    fn release_bytes(&mut self, bytes: usize) {
        assert!(bytes <= self.amount.bytes);
        let mut used = self.budget.used.lock().unwrap();
        self.amount.bytes -= bytes;
        used.bytes -= bytes;
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut used = self.budget.used.lock().unwrap();
        used.records -= self.amount.records;
        used.bytes -= self.amount.bytes;
    }
}
#[derive(Debug)]
pub struct Leases(pub Vec<Lease>);
impl Leases {
    pub fn acquire(
        local: &Arc<Budget>,
        global: &Arc<Budget>,
        records: usize,
        bytes: usize,
    ) -> Option<Self> {
        let a = local.try_acquire(records, bytes)?;
        let b = global.try_acquire(records, bytes)?;
        Some(Self(vec![a, b]))
    }
    /// Reduce a conservative reservation after allocation has an exact extent.
    /// Every adjacent pair accounts for the same bytes in local/global pools.
    pub fn release_bytes(&mut self, bytes: usize) {
        let mut remaining = bytes;
        for pair in self.0.chunks_exact_mut(2).rev() {
            let amount = remaining.min(pair[0].amount.bytes);
            debug_assert_eq!(pair[0].amount.bytes, pair[1].amount.bytes);
            pair[0].release_bytes(amount);
            pair[1].release_bytes(amount);
            remaining -= amount;
        }
        assert_eq!(remaining, 0);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rollback_is_atomic_across_dimensions_and_pools() {
        let a = Budget::new(2, 10);
        let b = Budget::new(1, 8);
        let first = Leases::acquire(&a, &b, 1, 8).unwrap();
        assert!(Leases::acquire(&a, &b, 1, 1).is_none());
        assert_eq!(
            a.used(),
            Usage {
                records: 1,
                bytes: 8
            }
        );
        assert!(a.try_acquire(0, usize::MAX).is_none());
        drop(first);
        assert_eq!(a.used(), Usage::default());
        assert_eq!(b.used(), Usage::default());
    }
    #[test]
    fn released_conservative_bytes_are_reusable_without_releasing_records() {
        let local = Budget::new(2, 100);
        let global = Budget::new(2, 100);
        let mut first = Leases::acquire(&local, &global, 1, 80).unwrap();
        first.release_bytes(60);
        assert_eq!(
            local.used(),
            Usage {
                records: 1,
                bytes: 20
            }
        );
        assert_eq!(global.used(), local.used());
        let second = Leases::acquire(&local, &global, 1, 80).unwrap();
        drop(first);
        assert_eq!(
            global.used(),
            Usage {
                records: 1,
                bytes: 80
            }
        );
        drop(second);
        assert_eq!(local.used(), Usage::default());
        assert_eq!(global.used(), Usage::default());
    }
    #[test]
    fn ownership_clones_do_not_release_early() {
        let a = Budget::new(1, 10);
        let owner = Arc::new(a.try_acquire(1, 10).unwrap());
        let copy = owner.clone();
        drop(owner);
        assert!(a.try_acquire(1, 1).is_none());
        drop(copy);
        assert!(a.try_acquire(1, 10).is_some());
    }
}
