//! Lazy forwarding of invariant frame reads; guest writes remain write-through.

use crate::ir::{Address, Gpr, Opcode, Region, Segment};
use crate::scoped_memory::Scope;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameReadSlot {
    pub address: Address,
    pub reads: Vec<usize>,
    /// These stores have different in-page byte offsets even under physical page aliasing.
    pub disjoint_stores: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StackForwardingOutcome {
    NoScope,
    NoReadOnlyFrameSlots,
    Formed { slots: usize, read_sites: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StackForwarding {
    pub slots: Vec<FrameReadSlot>,
}

impl StackForwarding {
    pub fn of(region: &Region) -> Option<Self> {
        let scope = Scope::of(region)?;
        let mut slots: Vec<FrameReadSlot> = Vec::new();
        for range in &scope.ranges {
            let address = range.address;
            if range.writes || range.stride != 0 || range.access_bytes != 4
                || !is_frame(address)
            {
                continue;
            }
            if (scope.head as usize..=scope.latch as usize).any(|at| {
                store_address(&region.instructions[at].opcode)
                    .is_some_and(|other| is_frame(other)
                        && other.base == address.base && !disjoint_offsets(address, other))
            }) {
                continue;
            }
            if let Some(slot) = slots.iter_mut().find(|s| s.address == address) {
                slot.reads.push(range.at);
            } else {
                let disjoint_stores = region.instructions.iter().enumerate()
                    .filter(|(at, _)| scope.covers(*at))
                    .filter_map(|(at, i)| {
                        store_address(&i.opcode).filter(|other| is_frame(*other)
                            && other.base == address.base && disjoint_offsets(address, *other))
                            .map(|_| at)
                    }).collect();
                slots.push(FrameReadSlot { address, reads: vec![range.at], disjoint_stores });
            }
        }
        (!slots.is_empty()).then_some(Self { slots })
    }

    pub fn explain(region: &Region) -> StackForwardingOutcome {
        if Scope::of(region).is_none() {
            return StackForwardingOutcome::NoScope;
        }
        match Self::of(region) {
            Some(plan) => StackForwardingOutcome::Formed {
                slots: plan.slots.len(),
                read_sites: plan.slots.iter().map(|s| s.reads.len()).sum(),
            },
            None => StackForwardingOutcome::NoReadOnlyFrameSlots,
        }
    }
}

fn is_frame(address: Address) -> bool {
    matches!(address.base, Some(Gpr::Ebp | Gpr::Esp))
        && address.index.is_none() && address.segment == Segment::DefaultData
}

fn store_address(opcode: &Opcode) -> Option<Address> {
    match opcode {
        Opcode::Store32 { address, .. } | Opcode::StoreImm32 { address, .. } => Some(*address),
        _ => None,
    }
}

fn disjoint_offsets(a: Address, b: Address) -> bool {
    let delta = b.displacement.wrapping_sub(a.displacement) as u32 & 0xfff;
    (4..=4092).contains(&delta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{lift_k8, lift_slice, lower_region_with, Passes, K8_BYTES};

    #[test]
    fn finds_repeated_read_only_cells_without_fixture_addresses() {
        for base in [0x1000, 0x64_a71f] {
            let region = lift_k8(base, &K8_BYTES).unwrap();
            let plan = StackForwarding::of(&region).unwrap();
            assert_eq!(StackForwarding::explain(&region),
                StackForwardingOutcome::Formed { slots: 2, read_sites: 9 });
            assert_eq!(plan.slots.iter().find(|s| s.address.displacement == 20).unwrap().reads.len(), 8);
            assert_eq!(plan.slots.iter().find(|s| s.address.displacement == 12).unwrap().reads.len(), 1);
            assert!(plan.slots.iter().all(|s| !s.disjoint_stores.is_empty()));
        }
    }

    #[test]
    fn refuses_cells_written_directly_and_accepts_changed_displacements() {
        let mut region = lift_k8(0x1000, &K8_BYTES).unwrap();
        for i in &mut region.instructions {
            if let Opcode::Add32Mem { address, .. } = &mut i.opcode {
                if address.displacement == 20 { address.displacement = 8; }
            }
        }
        let plan = StackForwarding::of(&region).unwrap();
        assert_eq!(plan.slots.len(), 1);
        assert_eq!(plan.slots[0].address.displacement, 12);
        for i in &mut region.instructions {
            if let Opcode::Add32Mem { address, .. } = &mut i.opcode {
                if address.displacement == 8 { address.displacement = 24; }
            }
        }
        assert_eq!(StackForwarding::of(&region).unwrap().slots.len(), 2);
    }

    #[test]
    fn moving_frame_base_and_non_loop_shapes_do_not_invent_slots() {
        let mut region = lift_k8(0x1000, &K8_BYTES).unwrap();
        region.instructions[7].opcode = Opcode::Add32Immediate { dst: Gpr::Ebp, value: 4 };
        assert!(StackForwarding::of(&region).is_none());
        let straight = lift_slice(0x1000, &[0x8b, 0x45, 0x14, 0xc3]).unwrap();
        assert_eq!(StackForwarding::explain(&straight), StackForwardingOutcome::NoScope);
    }

    #[test]
    fn page_aliases_and_partial_overlap_are_not_static_disjointness() {
        let address = Address { base: Some(Gpr::Ebp), index: None, scale: 1,
            displacement: 20, segment: Segment::DefaultData };
        for delta in [0, 1, 2, 3, -1, -2, -3, 4096] {
            assert!(!disjoint_offsets(address, Address { displacement: 20 + delta, ..address }));
        }
        for delta in [4, 8, -4, -8, 4092] {
            assert!(disjoint_offsets(address, Address { displacement: 20 + delta, ..address }));
        }
    }

    #[test]
    fn opt_in_changes_only_the_candidate_artifact_and_preserves_entries() {
        let region = lift_k8(0x1000, &K8_BYTES).unwrap();
        let base = lower_region_with(&region, false, 17, Passes::default()).unwrap();
        let candidate = lower_region_with(&region, false, 17,
            Passes::parse("stack-load-forwarding").unwrap()).unwrap();
        assert_ne!(base.unit.bytes, candidate.unit.bytes);
        assert_eq!(base.entries, candidate.entries);
        assert_eq!(base.exit_deltas, candidate.exit_deltas);
        assert_eq!(base.unit.imports, candidate.unit.imports);
        let no_scope = lift_slice(0x1000, &[0x33, 0xc1, 0xc3]).unwrap();
        assert_eq!(lower_region_with(&no_scope, false, 17, Passes::default()).unwrap().unit.bytes,
            lower_region_with(&no_scope, false, 17,
                Passes::parse("stack-load-forwarding").unwrap()).unwrap().unit.bytes);
        assert!(!Passes::default().stack_load_forwarding);
    }
}
