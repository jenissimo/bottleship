//! Structural and semantic invariants a region must satisfy before anything may execute it.
//!
//! The verifier is the reason a lifter bug surfaces as a refusal rather than as a wrong answer
//! several layers later: a missing guest PC, a broken effect chain or a statepoint whose
//! reconstruction names a value that does not dominate it are all rejected here.

use std::fmt;

use crate::contract::EnvelopeError;
use crate::ir::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyError {
    UnsupportedVersion(u32),
    /// The region's declared preconditions do not cover what it actually does.
    Envelope(EnvelopeError),
    /// An exit claims state is already canonical in a region that does not keep it so.
    LiveStateWithoutCanonicalClaim { at: usize },
    /// An exit declares a constant instruction count in a region whose paths differ in length.
    FixedAccountingInALoop { at: usize },
    /// An exit names a continuation its reason does not permit.
    ExitContinuationMismatch { at: usize, target: u32 },
    /// The IR carries a segment the envelope's segment model does not admit.
    UnsupportedSegment { at: usize },
    /// A `LiveGpr` naming a register other than the slot it fills. That is a permutation, i.e. a
    /// real reconstruction, and must be written as one.
    LiveGprIsNotIdentity { at: usize, slot: usize },
    EmptyRegion,
    NoCodeDependency,
    DuplicateCodePage(u32),
    EntryDoesNotMatchFirstInstruction {
        entry: u32,
        first: u32,
    },
    NonIncreasingGuestEip {
        previous: u32,
        current: u32,
    },
    BrokenStateChain {
        at: usize,
        expected_in: u32,
        actual_in: u32,
        actual_out: u32,
    },
    BrokenEffectChain {
        at: usize,
        expected_in: u32,
        expected_out: u32,
        actual_in: u32,
        actual_out: u32,
    },
    /// An instruction no path from the entry can reach.
    UnreachableInstruction {
        at: usize,
    },
    MissingTerminator,
    BranchTargetOutsideRegion {
        at: usize,
        target: u32,
    },
    BranchConditionNotMaterialized {
        at: usize,
    },
    InvalidReconstructionValue {
        at: usize,
        value_instruction: u32,
    },
    NonValueInstructionResult {
        at: usize,
        value_instruction: u32,
    },
    InvalidFlagRecipe {
        at: usize,
        flag_instruction: u32,
    },
    ReconstructionEffectMismatch {
        at: usize,
        expected: u32,
        actual: u32,
    },
    AccountingZero {
        at: usize,
    },
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for VerifyError {}

fn written_gpr(opcode: &Opcode) -> Option<Gpr> {
    match *opcode {
        Opcode::Xor32 { dst, .. }
        | Opcode::SetCondition8 { dst, .. }
        | Opcode::Add32Immediate { dst, .. }
        | Opcode::Decrement32 { dst } => Some(dst),
        _ => None,
    }
}

fn gpr_value_before(instructions: &[Instruction], instruction: u32, register: Gpr) -> ValueRef {
    (0..instruction as usize)
        .rev()
        .find(|index| written_gpr(&instructions[*index].opcode) == Some(register))
        .map(|index| ValueRef::InstructionResult {
            instruction: index as u32,
        })
        .unwrap_or(ValueRef::InputGpr(register))
}

fn verify_statepoint(
    statepoint: &Statepoint,
    at: usize,
    effect_token: u32,
    last_flag_writer: Option<u32>,
    instructions: &[Instruction],
) -> Result<(), VerifyError> {
    // A fixed delta of zero would mean an exit that retired nothing, which no path through a
    // region does. `Retired` is dynamic and carries no such claim.
    if statepoint.accounting_delta == AccountingDelta::Fixed(0) {
        return Err(VerifyError::AccountingZero { at });
    }
    if statepoint.reconstruction.effect_token != effect_token {
        return Err(VerifyError::ReconstructionEffectMismatch {
            at,
            expected: effect_token,
            actual: statepoint.reconstruction.effect_token,
        });
    }
    for value in statepoint.reconstruction.gprs {
        if let ValueRef::InstructionResult { instruction } = value {
            if instruction as usize >= at {
                return Err(VerifyError::InvalidReconstructionValue {
                    at,
                    value_instruction: instruction,
                });
            }
            if !instructions[instruction as usize].opcode.produces_value() {
                return Err(VerifyError::NonValueInstructionResult {
                    at,
                    value_instruction: instruction,
                });
            }
        }
    }
    if let FlagRecipe::Arithmetic {
        instruction,
        operation,
        lhs,
        rhs,
        result,
        defined,
        preserved,
        preserved_from,
    } = statepoint.reconstruction.flags
    {
        let producer_matches = last_flag_writer
            .and_then(|writer| {
                instructions[writer as usize].opcode.flag_operation().map(
                    |(actual_operation, actual_defined, actual_preserved)| {
                        writer == instruction
                            && actual_operation == operation
                            && actual_defined == defined
                            && actual_preserved == preserved
                    },
                )
            })
            .unwrap_or(false);
        let operands_match = match instructions.get(instruction as usize).map(|i| &i.opcode) {
            Some(Opcode::Decrement32 { dst }) => {
                lhs == gpr_value_before(instructions, instruction, *dst)
                    && rhs == ValueRef::Constant(1)
                    && result == ValueRef::InstructionResult { instruction }
            }
            // No current k3 statepoint uses these producers, but reject recipes which claim an
            // operation without a representable SSA contract instead of silently accepting it.
            _ => false,
        };
        let preserved_matches = if preserved == 0 {
            preserved_from.is_none()
        } else {
            preserved_from.is_some_and(|source| {
                source.mask == preserved
                    && source.instruction < instruction
                    && (0..instruction as usize)
                        .rev()
                        .find(|candidate| instructions[*candidate].opcode.writes_flags())
                        == Some(source.instruction as usize)
                    && instructions[source.instruction as usize]
                        .opcode
                        .flag_operation()
                        .is_some_and(|(_, source_defined, _)| source.mask & !source_defined == 0)
            })
        };
        // Bits outside `defined | preserved` are architecturally undefined (for example AF
        // after XOR). The concrete interpreter may carry a value for them, but a continuation
        // is forbidden from claiming that it has reconstructed one.
        if !producer_matches || !operands_match || !preserved_matches || defined & preserved != 0 {
            return Err(VerifyError::InvalidFlagRecipe {
                at,
                flag_instruction: instruction,
            });
        }
    }
    Ok(())
}

/// Check one control-flow edge.
///
/// An `InRegion` edge is only sound if it lands on an instruction this region actually owns; an
/// out-of-range index would be a jump into whatever happens to be next in memory. An `Exit` edge
/// additionally owes a reconstructable statepoint, and — because the runtime re-enters at its
/// guest EIP — that EIP must name an instruction the region contains.
/// The statepoints an opcode owns. Three rules walk them; one accessor keeps them from drifting.
fn statepoints_of(opcode: &Opcode) -> Vec<&Statepoint> {
    match opcode {
        Opcode::Exit(point) => vec![point],
        Opcode::BranchIf { taken, fallthrough, .. } => {
            [taken, fallthrough].iter().filter_map(|e| e.statepoint()).collect()
        }
        Opcode::Jump { target } => target.statepoint().into_iter().collect(),
        Opcode::CallRelative { target, .. } => target.statepoint().into_iter().collect(),
        _ => Vec::new(),
    }
}

/// A conservative region may say "the state is already right"; an optimizing one may not.
///
/// Without this the `keeps_state_canonical` flag would be decorative: an optimized region, whose
/// entire point is that it stops maintaining canonical state, could keep naming `LiveGpr` and
/// every exit would silently reconstruct nothing.
fn verify_canonical_claims(region: &Region) -> Result<(), VerifyError> {
    // `LiveGpr` means "slot i still holds register i". Naming any other register is a permutation
    // — a real reconstruction — and the interpreter would have to be told so; this rule is what
    // keeps the form's meaning as narrow as its name. It applies to every region, because a
    // canonical one is exactly the one for which the identity is the whole claim.
    for (at, instruction) in region.instructions.iter().enumerate() {
        for point in statepoints_of(&instruction.opcode) {
            for (slot, value) in point.reconstruction.gprs.iter().enumerate() {
                if let ValueRef::LiveGpr(register) = value {
                    if *register as usize != slot {
                        return Err(VerifyError::LiveGprIsNotIdentity { at, slot });
                    }
                }
            }
        }
    }
    if region.keeps_state_canonical {
        return Ok(());
    }
    for (at, instruction) in region.instructions.iter().enumerate() {
        let points = statepoints_of(&instruction.opcode);
        for point in points {
            if point.reconstruction.gprs.iter().any(|v| matches!(v, ValueRef::LiveGpr(_)))
                || matches!(point.reconstruction.flags, FlagRecipe::Live)
            {
                return Err(VerifyError::LiveStateWithoutCanonicalClaim { at });
            }
        }
    }
    Ok(())
}

/// Where an exit is allowed to say execution continues.
///
/// A BranchTaken edge goes to a computed target and may legitimately leave the region — refusing
/// that would make any kernel with a branch out of its extracted body unliftable. What is NOT
/// legitimate is a continuation inside the region's byte extent that is not an instruction
/// boundary: that would mean the guest decodes these bytes differently than the lifter did.
///
/// The other two reasons are pinned exactly, because for them the right answer is known:
/// a Fallthrough continues at the next instruction, and an UnsupportedInstruction boundary
/// continues AT the instruction the region declined to model, so the baseline executes it.
fn verify_exit_continuation(
    point: &Statepoint,
    index: usize,
    region: &Region,
) -> Result<(), VerifyError> {
    let target = point.continuation_eip;
    let at_boundary = region.instructions.iter().any(|i| i.guest_eip == target);
    match point.reason {
        ExitReason::Fallthrough => {
            let next = region.instructions.get(index + 1).map(|i| i.guest_eip);
            if next.is_some_and(|eip| eip != target) {
                return Err(VerifyError::ExitContinuationMismatch { at: index, target });
            }
            Ok(())
        }
        ExitReason::UnsupportedInstruction => {
            if region.instructions[index].guest_eip != target {
                return Err(VerifyError::ExitContinuationMismatch { at: index, target });
            }
            Ok(())
        }
        _ => {
            let first = region.instructions.first().map(|i| i.guest_eip).unwrap_or(0);
            let last = region.instructions.last().map(|i| i.guest_eip).unwrap_or(0);
            let inside = target > first && target < last;
            if inside && !at_boundary {
                return Err(VerifyError::ExitContinuationMismatch { at: index, target });
            }
            Ok(())
        }
    }
}

fn verify_continuation(
    edge: &Continuation,
    index: usize,
    expected_out: u32,
    last_flag_writer: Option<u32>,
    region: &Region,
) -> Result<(), VerifyError> {
    match edge {
        Continuation::InRegion { instruction } => {
            if *instruction as usize >= region.instructions.len() {
                return Err(VerifyError::BranchTargetOutsideRegion {
                    at: index,
                    target: *instruction,
                });
            }
            Ok(())
        }
        Continuation::Exit(point) => {
            verify_exit_continuation(point, index, region)?;
            verify_statepoint(point, index, expected_out, last_flag_writer, &region.instructions)
        }
    }
}

/// A region with a back edge may not declare a constant instruction count at any exit.
///
/// How many instructions such a region retires depends on how many iterations ran, so a constant
/// there is a number derived from intent rather than from what executed — exactly what CLAUDE.md
/// §3.4 refuses to let a ledger be labelled with.
fn verify_accounting_shape(region: &Region) -> Result<(), VerifyError> {
    let has_back_edge = region.instructions.iter().enumerate().any(|(index, instruction)| {
        let goes_back = |edge: &Continuation| {
            matches!(edge, Continuation::InRegion { instruction: target } if (*target as usize) <= index)
        };
        match &instruction.opcode {
            Opcode::Jump { target } => goes_back(target),
            Opcode::BranchIf { taken, fallthrough, .. } => goes_back(taken) || goes_back(fallthrough),
            _ => false,
        }
    });
    if !has_back_edge {
        return Ok(());
    }
    for (at, instruction) in region.instructions.iter().enumerate() {
        let points = statepoints_of(&instruction.opcode);
        if points.iter().any(|p| matches!(p.accounting_delta, AccountingDelta::Fixed(_))) {
            return Err(VerifyError::FixedAccountingInALoop { at });
        }
    }
    Ok(())
}

/// Refuse an address the interpreter would resolve differently than the IR describes.
///
/// `address()` adds base + index*scale + displacement and never consults the segment, which is
/// right only for the flat model the envelope admits. A field the IR carries and the semantic
/// core drops is worse than one it never modelled: a lifter emitting `Explicit` would get
/// silently wrong addresses instead of a refusal.
fn verify_segments(region: &Region) -> Result<(), VerifyError> {
    for (at, instruction) in region.instructions.iter().enumerate() {
        let address = match &instruction.opcode {
            Opcode::CompareMem32Reg { address, .. }
            | Opcode::CompareMem32Imm { address, .. }
            | Opcode::Store32 { address, .. }
            | Opcode::StoreImm32 { address, .. }
            | Opcode::Load32 { address, .. }
            | Opcode::LoadZeroExtendByte { address, .. }
            | Opcode::Add32Mem { address, .. } => address,
            _ => continue,
        };
        if !matches!(address.segment, Segment::DefaultData) {
            return Err(VerifyError::UnsupportedSegment { at });
        }
    }
    Ok(())
}

/// Every instruction must be reachable from the entry.
///
/// This replaces the simpler rule that a terminator may only appear last. That rule is right for
/// a straight-line region and wrong for one that owns a loop: an internal branch or back edge is
/// a terminator in the middle by construction. What actually has to hold is that nothing is
/// stranded — an instruction no path reaches is either dead weight or a lifter mistake, and both
/// are worth refusing.
fn verify_reachability(region: &Region) -> Result<(), VerifyError> {
    // Addresses the region pushes as constants are where its returns can land. A `ret` has a
    // run-time target, so without this the code after one reads as unreachable and a region that
    // covers a wrapper and the function it falls into is refused for a shape it really has.
    let return_points: Vec<u32> = region
        .instructions
        .iter()
        .filter_map(|i| match i.opcode {
            Opcode::Push32Immediate { value } => Some(value),
            _ => None,
        })
        .collect();
    let mut reachable = vec![false; region.instructions.len()];
    let mut worklist = vec![0usize];
    while let Some(index) = worklist.pop() {
        if index >= region.instructions.len() || reachable[index] {
            continue;
        }
        reachable[index] = true;
        let follow = |edge: &Continuation, worklist: &mut Vec<usize>| {
            if let Continuation::InRegion { instruction } = edge {
                worklist.push(*instruction as usize);
            }
        };
        match &region.instructions[index].opcode {
            Opcode::Exit(_) => {}
            Opcode::Return { .. } => {
                for (i, instruction) in region.instructions.iter().enumerate() {
                    if return_points.contains(&instruction.guest_eip) {
                        worklist.push(i);
                    }
                }
            }
            // A call reaches its target AND, through the callee's `ret`, the instruction after
            // itself. Treating it as a plain transfer would make the whole return path read as
            // unreachable code and the region be refused for a shape it actually has.
            Opcode::CallRelative { target, .. } => {
                follow(target, &mut worklist);
                worklist.push(index + 1);
            }
            Opcode::Jump { target } => follow(target, &mut worklist),
            Opcode::BranchIf { taken, fallthrough, .. } => {
                follow(taken, &mut worklist);
                follow(fallthrough, &mut worklist);
            }
            _ => worklist.push(index + 1),
        }
    }
    match reachable.iter().position(|seen| !seen) {
        Some(at) => Err(VerifyError::UnreachableInstruction { at }),
        None => Ok(()),
    }
}

/// Verify structural invariants before an optimizer or lowerer can consume a region.
pub fn verify(region: &Region) -> Result<(), VerifyError> {
    if region.ir_version != IR_VERSION {
        return Err(VerifyError::UnsupportedVersion(region.ir_version));
    }
    // Before any structural check: a region that under-declares its preconditions is wrong in a
    // way no amount of well-formedness makes safe.
    region
        .envelope
        .validate(region.touches_memory(), region.stores_to_memory())
        .map_err(VerifyError::Envelope)?;
    verify_canonical_claims(region)?;
    verify_accounting_shape(region)?;
    verify_segments(region)?;
    if region.instructions.is_empty() {
        return Err(VerifyError::EmptyRegion);
    }
    if region.code_dependencies.is_empty() {
        return Err(VerifyError::NoCodeDependency);
    }
    for (i, dependency) in region.code_dependencies.iter().enumerate() {
        if region.code_dependencies[..i]
            .iter()
            .any(|seen| seen.guest_page == dependency.guest_page)
        {
            return Err(VerifyError::DuplicateCodePage(dependency.guest_page));
        }
    }

    let first = region.instructions[0].guest_eip;
    if region.entry_eip != first {
        return Err(VerifyError::EntryDoesNotMatchFirstInstruction {
            entry: region.entry_eip,
            first,
        });
    }

    let mut expected_effect = 0;
    let mut last_flag_writer = None;
    for (index, instruction) in region.instructions.iter().enumerate() {
        let expected_state = index as u32;
        if index > 0 && instruction.guest_eip <= region.instructions[index - 1].guest_eip {
            return Err(VerifyError::NonIncreasingGuestEip {
                previous: region.instructions[index - 1].guest_eip,
                current: instruction.guest_eip,
            });
        }
        if instruction.state_in != expected_state || instruction.state_out != expected_state + 1 {
            return Err(VerifyError::BrokenStateChain {
                at: index,
                expected_in: expected_state,
                actual_in: instruction.state_in,
                actual_out: instruction.state_out,
            });
        }
        let expected_out = expected_effect + u32::from(instruction.opcode.has_memory_effect());
        if instruction.effect_in != expected_effect || instruction.effect_out != expected_out {
            return Err(VerifyError::BrokenEffectChain {
                at: index,
                expected_in: expected_effect,
                expected_out,
                actual_in: instruction.effect_in,
                actual_out: instruction.effect_out,
            });
        }
        match instruction.opcode {
            Opcode::BranchIf {
                taken, fallthrough, ..
            } => {
                if last_flag_writer.is_none() {
                    return Err(VerifyError::BranchConditionNotMaterialized { at: index });
                }
                for edge in [taken, fallthrough] {
                    verify_continuation(
                        &edge,
                        index,
                        expected_out,
                        last_flag_writer,
                        region,
                    )?;
                }
            }
            Opcode::Jump { target } => {
                verify_continuation(&target, index, expected_out, last_flag_writer, region)?;
            }
            Opcode::Exit(statepoint) => {
                // The same continuation rule as an Exit edge: a bare terminator was the case the
                // edge-only check never reached.
                verify_exit_continuation(&statepoint, index, region)?;
                verify_statepoint(
                    &statepoint,
                    index,
                    expected_out,
                    last_flag_writer,
                    &region.instructions,
                )?;
            }
            _ => {}
        }
        if instruction.opcode.writes_flags() {
            last_flag_writer = Some(index as u32);
        }
        expected_effect = expected_out;
    }
    if !region
        .instructions
        .last()
        .is_some_and(|instruction| instruction.opcode.is_terminal())
    {
        return Err(VerifyError::MissingTerminator);
    }
    verify_reachability(region)

}
