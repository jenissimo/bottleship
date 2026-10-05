//! Which flag bits a region's own conditions can read.
//!
//! Guest-visible flags leave in v86's LAZY representation, so the materialized word the lowering
//! keeps is private to one activation: it exists only to answer `setcc`/`jcc` inside the region.
//! That makes two questions answerable by the same backward dataflow:
//!
//!   * at each flag-writing instruction, which of the bits it defines can still be read — the
//!     rest are dead and need not be computed;
//!   * at each address the engine may ENTER at, which bits are read before they are written —
//!     any such bit would be read out of a shadow this activation never set, so a region with
//!     one is refused rather than lowered into a branch on zero.
//!
//! The second is not an optimization. It is a hole the eager form has as well: the shadow starts
//! at zero on every entry, and only the kernels' shape kept a condition from reaching it.

use crate::ir::{
    Condition, Continuation, Opcode, Region, FLAG_AF, FLAG_CF, FLAG_OF, FLAG_PF, FLAG_SF, FLAG_ZF,
};
use crate::lower_wasm::flag;

/// The IR names flags by INDEX (`FLAG_ZF` is bit 3); the lowering names them by their EFLAGS
/// POSITION (`flag::ZERO` is 0x40). Mixing the two compares a mask against a different alphabet
/// and quietly answers "this instruction defines nothing".
fn architectural(compact: u8) -> i32 {
    let mut bits = 0;
    for (from, to) in [
        (FLAG_CF, flag::CARRY),
        (FLAG_PF, flag::PARITY),
        (FLAG_AF, flag::ADJUST),
        (FLAG_ZF, flag::ZERO),
        (FLAG_SF, flag::SIGN),
        (FLAG_OF, flag::OVERFLOW),
    ] {
        if compact & from != 0 {
            bits |= to;
        }
    }
    bits
}

/// Bits a condition reads.
fn used(condition: Condition) -> i32 {
    match condition {
        Condition::NotEqual => flag::ZERO,
        // SF == OF.
        Condition::GreaterOrEqualSigned => {
            flag::SIGN | flag::OVERFLOW
        }
    }
}

/// What one instruction reads from the shadow, and what it overwrites in it.
fn used_and_defined(opcode: &Opcode) -> (i32, i32) {
    let reads = match opcode {
        Opcode::SetCondition8 { condition, .. } => used(*condition),
        Opcode::BranchIf { condition, .. } => used(*condition),
        _ => 0,
    };
    // An operation that PRESERVES a flag READS it. v86's lazy word names the bits the last
    // operation defined; a bit the next one leaves alone stops being claimed, so from then on the
    // guest takes it from `flags` — where nobody put it. `dec` preserves CF, `shl` leaves AF and
    // OF undefined, a logical operation leaves AF undefined: each of those bits has to be
    // materialized before the tuple stops claiming it, and materializing means reading.

    let writes = opcode
        .flag_operation()
        .map_or(0, |(_, defined, _)| architectural(defined));
    (reads, writes)
}

pub struct FlagFacts {
    /// Per instruction: the bits still readable after it, i.e. the ones it must actually compute.
    pub demanded_after: Vec<i32>,
    /// Per instruction: the bits read before being written on some path starting there.
    pub live_before: Vec<i32>,
    /// The same, counting only CONDITION reads.
    ///
    /// The two differ where an operation materializes a preserved bit: that read is always safe,
    /// because the bit's value is the one the guest's `flags` word already holds. A condition read
    /// is not — it wants a bit some operation of THIS activation computed.
    pub condition_live_before: Vec<i32>,
    /// Per instruction: the bits it must write into the GUEST's `flags` before its own lazy tuple
    /// stops claiming them.
    ///
    /// Only bits an earlier operation OF THIS ACTIVATION claimed are in here. A bit nothing has
    /// claimed yet is still correct in `flags` from before the region was entered, and writing it
    /// from a shadow that has not been computed would replace a correct value with zero.
    pub materialize: Vec<i32>,
}

impl FlagFacts {
    /// Backward liveness over the region's own edges.
    ///
    /// An edge that LEAVES the region contributes nothing: the shadow is not guest state, and an
    /// exit hands over the lazy tuple instead.
    pub fn of(region: &Region) -> Self {
        let n = region.instructions.len();
        let mut live_before = vec![0i32; n];
        let mut demanded_after = vec![0i32; n];
        let mut changed = true;
        while changed {
            changed = false;
            for index in (0..n).rev() {
                let instruction = &region.instructions[index];
                let mut out = 0i32;
                let mut successor = |edge: &Continuation| {
                    if let Continuation::InRegion { instruction: target } = edge {
                        out |= live_before[*target as usize];
                    }
                };
                match &instruction.opcode {
                    Opcode::Exit(_) | Opcode::Return { .. } => {}
                    Opcode::Jump { target } => successor(target),
                    Opcode::BranchIf { taken, fallthrough, .. } => {
                        successor(taken);
                        successor(fallthrough);
                    }
                    _ if index + 1 < n => out |= live_before[index + 1],
                    _ => {}
                }
                let (reads, writes) = used_and_defined(&instruction.opcode);
                let before = (out & !writes) | reads;
                if out != demanded_after[index] || before != live_before[index] {
                    demanded_after[index] = out;
                    live_before[index] = before;
                    changed = true;
                }
            }
        }
        // Which bits the lazy tuple currently CLAIMS, forward from every entry. A flag writer
        // replaces the claim with its own defined set; everything else passes it along.
        let mut claimed_in = vec![0i32; n];
        let mut changed = true;
        while changed {
            changed = false;
            for index in 0..n {
                let instruction = &region.instructions[index];
                let (_, defined) = used_and_defined(&instruction.opcode);
                let out = if defined != 0 { defined } else { claimed_in[index] };
                let mut push = |target: usize, value: i32| {
                    if target < n && (claimed_in[target] | value) != claimed_in[target] {
                        claimed_in[target] |= value;
                        changed = true;
                    }
                };
                match &instruction.opcode {
                    Opcode::Exit(_) | Opcode::Return { .. } => {}
                    Opcode::Jump { target } => {
                        if let Continuation::InRegion { instruction: t } = target {
                            push(*t as usize, out);
                        }
                    }
                    Opcode::BranchIf { taken, fallthrough, .. } => {
                        for edge in [taken, fallthrough] {
                            if let Continuation::InRegion { instruction: t } = edge {
                                push(*t as usize, out);
                            }
                        }
                    }
                    _ => push(index + 1, out),
                }
            }
        }

        // What each flag writer owes: the bits it does NOT define, but which the current claim
        // covers — those stop being recomputed the moment this operation writes its own tuple.
        let materialize: Vec<i32> = region
            .instructions
            .iter()
            .enumerate()
            .map(|(index, instruction)| {
                let (_, defined) = used_and_defined(&instruction.opcode);
                if defined == 0 {
                    return 0;
                }
                (flag::ALL & !defined) & claimed_in[index]
            })
            .collect();

        // Materializing is reading, so it feeds the backward pass too — but it is kept apart from
        // the condition reads, because only those can be unsafe at an entry.
        let condition_live_before = live_before;
        let with = Self::with_materialization(region, &materialize);
        Self {
            demanded_after: with.demanded_after,
            live_before: with.live_before,
            condition_live_before,
            materialize,
        }
    }

    /// Re-run the backward pass with the materialization reads included.
    fn with_materialization(region: &Region, materialize: &[i32]) -> Self {
        let n = region.instructions.len();
        let mut live_before = vec![0i32; n];
        let mut demanded_after = vec![0i32; n];
        let mut changed = true;
        while changed {
            changed = false;
            for index in (0..n).rev() {
                let instruction = &region.instructions[index];
                let mut out = 0i32;
                let mut successor = |edge: &Continuation| {
                    if let Continuation::InRegion { instruction: target } = edge {
                        out |= live_before[*target as usize];
                    }
                };
                match &instruction.opcode {
                    Opcode::Exit(_) | Opcode::Return { .. } => {}
                    Opcode::Jump { target } => successor(target),
                    Opcode::BranchIf { taken, fallthrough, .. } => {
                        successor(taken);
                        successor(fallthrough);
                    }
                    _ if index + 1 < n => out |= live_before[index + 1],
                    _ => {}
                }
                let (reads, writes) = used_and_defined(&instruction.opcode);
                let reads = reads | materialize[index];
                let before = (out & !writes) | reads;
                if out != demanded_after[index] || before != live_before[index] {
                    demanded_after[index] = out;
                    live_before[index] = before;
                    changed = true;
                }
            }
        }
        Self {
            demanded_after,
            live_before: live_before.clone(),
            condition_live_before: live_before,
            materialize: materialize.to_vec(),
        }
    }
}
