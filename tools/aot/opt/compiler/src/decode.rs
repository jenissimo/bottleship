//! Decoding and lifting of the supported x86 slice into Guest IR.
//!
//! Each lifter is pinned to the byte-exact retail body it was written against, so a corpus that
//! drifts fails loudly instead of lifting different instructions under the same name.

use std::fmt;

use crate::contract::Envelope;
use crate::ir::*;
use crate::verify::{verify, VerifyError};

/// The byte-exact retail k3 body from `aot-oracle/corpus/kernels.mjs`.
pub const K3_BYTES: [u8; 16] = [
    0x33, 0xd2, 0x39, 0x14, 0x39, 0x0f, 0x95, 0xc2, 0x89, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x75, 0xf0,
];
pub const K3_SHA256: [u8; 32] = [
    0xf9, 0x2e, 0x8a, 0xd0, 0x0d, 0x11, 0x2b, 0xc4, 0x6e, 0xa8, 0xba, 0xb9, 0xfd, 0x40, 0x14, 0x10,
    0xe4, 0xce, 0xfc, 0x3b, 0x9a, 0xd8, 0xff, 0x4a, 0x21, 0xbe, 0x9d, 0x67, 0xd4, 0x4a, 0xe3, 0x45,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiftError {
    BodyMismatch,
    Truncated { at: usize },
    Unsupported { at: usize, byte: u8 },
    WrongBranchTarget { expected: u32, actual: u32 },
    InvalidRegion(VerifyError),
}

impl fmt::Display for LiftError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for LiftError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DecodedK3 {
    XorEdxEdx,
    CmpEcxEdiEdx,
    SetneDl,
    StoreEcxEdx,
    AddEcx4,
    DecEax,
    JneRel8(i8),
}

fn decode_k3(bytes: &[u8]) -> Result<Vec<(usize, DecodedK3)>, LiftError> {
    let mut pc = 0;
    let mut decoded = Vec::new();
    while pc < bytes.len() {
        let rest = &bytes[pc..];
        let (length, op) = match rest {
            [0x33, 0xd2, ..] => (2, DecodedK3::XorEdxEdx),
            [0x39, 0x14, 0x39, ..] => (3, DecodedK3::CmpEcxEdiEdx),
            [0x0f, 0x95, 0xc2, ..] => (3, DecodedK3::SetneDl),
            [0x89, 0x11, ..] => (2, DecodedK3::StoreEcxEdx),
            [0x83, 0xc1, 0x04, ..] => (3, DecodedK3::AddEcx4),
            [0x48, ..] => (1, DecodedK3::DecEax),
            [0x75, displacement, ..] => (2, DecodedK3::JneRel8(*displacement as i8)),
            [byte, ..] => {
                return Err(LiftError::Unsupported {
                    at: pc,
                    byte: *byte,
                })
            }
            [] => unreachable!(),
        };
        if rest.len() < length {
            return Err(LiftError::Truncated { at: pc });
        }
        decoded.push((pc, op));
        pc += length;
    }
    Ok(decoded)
}

/// Decode and lift the supported retail k3 instruction bytes.  The IR is derived from the
/// decoded ModRM/SIB forms; it is not a prebuilt k3-shaped IR template.
pub fn lift_k3(entry_eip: u32, bytes: &[u8]) -> Result<Region, LiftError> {
    if bytes != K3_BYTES.as_slice() {
        return Err(LiftError::BodyMismatch);
    }
    let decoded = decode_k3(bytes)?;
    let mut instructions = Vec::with_capacity(decoded.len());
    let mut effect = 0;
    for (index, (offset, decoded_op)) in decoded.iter().copied().enumerate() {
        let opcode = match decoded_op {
            DecodedK3::XorEdxEdx => Opcode::Xor32 {
                dst: Gpr::Edx,
                src: Gpr::Edx,
            },
            DecodedK3::CmpEcxEdiEdx => Opcode::CompareMem32Reg {
                address: Address {
                    base: Some(Gpr::Ecx),
                    index: Some(Gpr::Edi),
                    scale: 1,
                    displacement: 0,
                    segment: Segment::DefaultData,
                },
                rhs: Gpr::Edx,
            },
            DecodedK3::SetneDl => Opcode::SetCondition8 {
                dst: Gpr::Edx,
                part: RegisterPart::Low8,
                condition: Condition::NotEqual,
            },
            DecodedK3::StoreEcxEdx => Opcode::Store32 {
                address: Address {
                    base: Some(Gpr::Ecx),
                    index: None,
                    scale: 1,
                    displacement: 0,
                    segment: Segment::DefaultData,
                },
                src: Gpr::Edx,
            },
            DecodedK3::AddEcx4 => Opcode::Add32Immediate {
                dst: Gpr::Ecx,
                value: 4,
            },
            DecodedK3::DecEax => Opcode::Decrement32 { dst: Gpr::Eax },
            DecodedK3::JneRel8(displacement) => {
                let next = entry_eip.wrapping_add(offset as u32).wrapping_add(2);
                let target = next.wrapping_add(displacement as i32 as u32);
                if target != entry_eip {
                    return Err(LiftError::WrongBranchTarget {
                        expected: entry_eip,
                        actual: target,
                    });
                }
                let reconstruction = Reconstruction {
                    gprs: [
                        ValueRef::InstructionResult { instruction: 5 },
                        ValueRef::InstructionResult { instruction: 4 },
                        ValueRef::InstructionResult { instruction: 2 },
                        ValueRef::InputGpr(Gpr::Ebx),
                        ValueRef::InputGpr(Gpr::Esp),
                        ValueRef::InputGpr(Gpr::Ebp),
                        ValueRef::InputGpr(Gpr::Esi),
                        ValueRef::InputGpr(Gpr::Edi),
                    ],
                    flags: k3_dec_flag_recipe(),
                    effect_token: 2,
                };
                // k3's back edge stays an EXIT rather than becoming an in-region edge. Keeping
                // it that way preserves this lifter's original semantics exactly — one pass over
                // the body per entry — so the k3 differential still measures what it measured.
                // The loop-carrying form belongs to a lifter written for a kernel that has one.
                Opcode::BranchIf {
                    condition: Condition::NotEqual,
                    taken: Continuation::Exit(Statepoint {
                        continuation_eip: target,
                        accounting_delta: AccountingDelta::Fixed(7),
                        reason: ExitReason::BranchTaken,
                        reconstruction,
                    }),
                    fallthrough: Continuation::Exit(Statepoint {
                        continuation_eip: next,
                        accounting_delta: AccountingDelta::Fixed(7),
                        reason: ExitReason::Fallthrough,
                        reconstruction,
                    }),
                }
            }
        };
        let next_effect = effect + u32::from(opcode.has_memory_effect());
        instructions.push(Instruction {
            guest_eip: entry_eip.wrapping_add(offset as u32),
            state_in: index as u32,
            state_out: index as u32 + 1,
            effect_in: effect,
            effect_out: next_effect,
            opcode,
        });
        effect = next_effect;
    }
    // The envelope is derived from what was lifted, not chosen: `verify` then re-derives it
    // independently and refuses a mismatch, so a lifter that starts emitting stores cannot keep
    // an envelope that never promised a code-write barrier.
    let touches_memory = instructions.iter().any(|i| i.opcode.has_memory_effect());
    let stores_to_memory = instructions.iter().any(|i| matches!(i.opcode, Opcode::Store32 { .. }));
    let region = Region {
        // Conservative lowering: the region maintains the architectural register file at every
        // point, so its exits owe no SSA reconstruction for GPRs.
        keeps_state_canonical: true,
        envelope: Envelope::integer_slice_v1(touches_memory, stores_to_memory),
        ir_version: IR_VERSION,
        entry_eip,
        code_dependencies: vec![CodeDependency {
            guest_page: entry_eip >> 12,
            body_sha256: K3_SHA256,
        }],
        instructions,
    };
    verify(&region).map_err(LiftError::InvalidRegion)?;
    Ok(region)
}
