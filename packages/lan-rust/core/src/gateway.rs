//! Resource metadata only; native I/O is performed by the adapter after ordered admission.
use crate::ConnId;
use std::collections::HashMap;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BindingToken {
    pub proto: u8,
    pub local_port: u16,
    pub generation: Option<u32>,
}
#[derive(Debug, Clone, Copy)]
struct Binding {
    generation: u32,
    released: bool,
}
#[derive(Debug, Default)]
pub struct BindingRegistry {
    bindings: HashMap<(u8, u16), Binding>,
}
impl BindingRegistry {
    pub fn admit(&mut self, token: BindingToken) -> bool {
        if token.proto > 7 || token.local_port == 0 {
            return false;
        }
        let key = (token.proto, token.local_port);
        let old = self.bindings.get(&key);
        let Some(generation) = token.generation else {
            return old.is_none();
        };
        if generation == 0 {
            return false;
        }
        if old.is_some_and(|old| {
            generation < old.generation || (generation == old.generation && old.released)
        }) {
            return false;
        }
        if old.is_none_or(|old| generation > old.generation) {
            self.bindings.insert(
                key,
                Binding {
                    generation,
                    released: false,
                },
            );
        }
        true
    }
    pub fn is_live(&self, token: BindingToken) -> bool {
        match (
            self.bindings.get(&(token.proto, token.local_port)),
            token.generation,
        ) {
            (None, None) => true,
            (Some(b), Some(g)) => g != 0 && b.generation == g && !b.released,
            _ => false,
        }
    }
    pub fn release(&mut self, proto: u8, port: u16, generation: u32) -> bool {
        if proto > 7 || port == 0 || generation == 0 {
            return false;
        }
        if self
            .bindings
            .get(&(proto, port))
            .is_some_and(|b| b.generation > generation)
        {
            return false;
        }
        self.bindings.insert(
            (proto, port),
            Binding {
                generation,
                released: true,
            },
        );
        true
    }
    pub fn clear(&mut self) {
        self.bindings.clear()
    }
}
#[derive(Debug, Default, Clone, Copy)]
struct Counts {
    shared: u32,
    exclusive: u32,
}
/// Opaque, idempotently released native destination lease. Canonicalization belongs to Routes.
#[derive(Debug, Default)]
pub struct DestinationPolicy {
    owners: HashMap<String, HashMap<ConnId, Counts>>,
    leases: HashMap<u64, (String, ConnId, bool)>,
    next: u64,
    echo_ids: std::collections::HashSet<u16>,
    next_echo: u16,
    host_leases: HashMap<u64, (String, ConnId)>,
    host_counts: HashMap<String, usize>,
}
impl DestinationPolicy {
    pub fn acquire(&mut self, destination: &str, owner: ConnId, exclusive: bool) -> Option<u64> {
        if self.owners.get(destination).is_some_and(|owners| {
            owners
                .iter()
                .any(|(other, c)| *other != owner && (exclusive || c.exclusive != 0))
        }) {
            return None;
        }
        let id = self.next.checked_add(1)?;
        let c = self
            .owners
            .entry(destination.into())
            .or_default()
            .entry(owner)
            .or_default();
        let count = if exclusive {
            &mut c.exclusive
        } else {
            &mut c.shared
        };
        *count = count.checked_add(1)?;
        self.next = id;
        self.leases
            .insert(id, (destination.into(), owner, exclusive));
        Some(id)
    }
    pub fn acquire_host_listener(
        &mut self,
        listener: &str,
        owner: ConnId,
        max_owners: usize,
    ) -> Option<u64> {
        if max_owners == 0 || self.host_counts.get(listener).copied().unwrap_or(0) >= max_owners {
            return None;
        }
        let id = self.next.checked_add(1)?;
        self.next = id;
        *self.host_counts.entry(listener.into()).or_default() += 1;
        self.host_leases.insert(id, (listener.into(), owner));
        Some(id)
    }
    pub fn release(&mut self, id: u64) {
        if let Some((listener, _)) = self.host_leases.remove(&id) {
            if let Some(count) = self.host_counts.get_mut(&listener) {
                *count -= 1;
                if *count == 0 {
                    self.host_counts.remove(&listener);
                }
            }
            return;
        }
        let Some((destination, owner, exclusive)) = self.leases.remove(&id) else {
            return;
        };
        if let Some(owners) = self.owners.get_mut(&destination) {
            if let Some(c) = owners.get_mut(&owner) {
                if exclusive {
                    c.exclusive -= 1
                } else {
                    c.shared -= 1
                }
                if c.shared == 0 && c.exclusive == 0 {
                    owners.remove(&owner);
                }
            }
            if owners.is_empty() {
                self.owners.remove(&destination);
            }
        }
    }
    pub fn release_owner(&mut self, owner: ConnId) {
        let ids: Vec<_> = self
            .leases
            .iter()
            .filter(|(_, (_, o, _))| *o == owner)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.release(id)
        }
        let hosts: Vec<_> = self
            .host_leases
            .iter()
            .filter(|(_, (_, o))| *o == owner)
            .map(|(id, _)| *id)
            .collect();
        for id in hosts {
            self.release(id);
        }
    }
    /// Echo identifiers are unique across all participant actors sharing this policy.
    pub fn allocate_echo_id(&mut self) -> Option<u16> {
        for _ in 0..u16::MAX {
            self.next_echo = self.next_echo.wrapping_add(1).max(1);
            if self.echo_ids.insert(self.next_echo) {
                return Some(self.next_echo);
            }
        }
        None
    }
    pub fn release_echo_id(&mut self, id: u16) {
        self.echo_ids.remove(&id);
    }
    pub fn owns_echo_id(&self, id: u16) -> bool {
        self.echo_ids.contains(&id)
    }
    pub fn active_leases(&self) -> usize {
        self.leases.len() + self.host_leases.len()
    }
}
