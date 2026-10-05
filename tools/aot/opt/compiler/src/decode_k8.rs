//! Decoder and lifter for k8, the kernel selected by measured CPU-time share.
//!
//! Unlike the k3 lifter, this is a real (if narrow) decoder rather than a pinned enumeration:
//! k8 is 68 instructions with a loop, and hand-listing them would encode the same information
//! twice. It admits exactly the addressing forms k8 uses and refuses every other, because a
//! decoder that treats an unrecognised form as a plausible one produces a region that is wrong
//! for precisely the inputs nobody tested.

use crate::contract::Envelope;
use crate::ir::*;
use crate::verify::verify;
use crate::decode::LiftError;

/// The byte-exact retail k8 body, so a lifter cannot be handed different instructions under
/// the same name. `verify-corpus.mjs` re-extracts the same bytes from the retail binary.
pub const K8_BYTES: [u8; 209] = [
    0x55, 0x8b, 0xec, 0x51, 0xc7, 0x45, 0xfc, 0x00, 0x00, 0x00, 0x00, 0xeb,
    0x09, 0x8b, 0x45, 0xfc, 0x83, 0xc0, 0x01, 0x89, 0x45, 0xfc, 0x83, 0x7d,
    0xfc, 0x08, 0x0f, 0x8d, 0xad, 0x00, 0x00, 0x00, 0x8b, 0x4d, 0x08, 0x0f,
    0xb6, 0x11, 0x03, 0x55, 0x14, 0xc1, 0xe2, 0x10, 0x8b, 0x45, 0x10, 0x89,
    0x10, 0x8b, 0x4d, 0x08, 0x0f, 0xb6, 0x51, 0x01, 0x03, 0x55, 0x14, 0xc1,
    0xe2, 0x10, 0x8b, 0x45, 0x10, 0x89, 0x50, 0x04, 0x8b, 0x4d, 0x08, 0x0f,
    0xb6, 0x51, 0x02, 0x03, 0x55, 0x14, 0xc1, 0xe2, 0x10, 0x8b, 0x45, 0x10,
    0x89, 0x50, 0x08, 0x8b, 0x4d, 0x08, 0x0f, 0xb6, 0x51, 0x03, 0x03, 0x55,
    0x14, 0xc1, 0xe2, 0x10, 0x8b, 0x45, 0x10, 0x89, 0x50, 0x0c, 0x8b, 0x4d,
    0x08, 0x0f, 0xb6, 0x51, 0x04, 0x03, 0x55, 0x14, 0xc1, 0xe2, 0x10, 0x8b,
    0x45, 0x10, 0x89, 0x50, 0x10, 0x8b, 0x4d, 0x08, 0x0f, 0xb6, 0x51, 0x05,
    0x03, 0x55, 0x14, 0xc1, 0xe2, 0x10, 0x8b, 0x45, 0x10, 0x89, 0x50, 0x14,
    0x8b, 0x4d, 0x08, 0x0f, 0xb6, 0x51, 0x06, 0x03, 0x55, 0x14, 0xc1, 0xe2,
    0x10, 0x8b, 0x45, 0x10, 0x89, 0x50, 0x18, 0x8b, 0x4d, 0x08, 0x0f, 0xb6,
    0x51, 0x07, 0x03, 0x55, 0x14, 0xc1, 0xe2, 0x10, 0x8b, 0x45, 0x10, 0x89,
    0x50, 0x1c, 0x8b, 0x4d, 0x08, 0x03, 0x4d, 0x0c, 0x89, 0x4d, 0x08, 0x8b,
    0x55, 0x10, 0x83, 0xc2, 0x40, 0x89, 0x55, 0x10, 0xe9, 0x40, 0xff, 0xff,
    0xff, 0x8b, 0xe5, 0x5d, 0xc3,
];

/// The byte-exact retail k8 body from `aot-oracle/corpus/kernels.mjs` (VA 0x0064a71f, 209 bytes).
pub const K8_SHA256: [u8; 32] = [
    0x99, 0xc6, 0x82, 0xf0, 0x6c, 0x6f, 0x5f, 0xa6, 0xba, 0x9f, 0xe2, 0x65, 0x38, 0x23, 0x59, 0x05,
    0x42, 0x6d, 0xde, 0xd0, 0x23, 0x18, 0xe9, 0xfe, 0xe8, 0x5b, 0x9b, 0xeb, 0x96, 0xc2, 0x3f, 0xd6,
];

const REGS: [Gpr; 8] = [
    Gpr::Eax, Gpr::Ecx, Gpr::Edx, Gpr::Ebx, Gpr::Esp, Gpr::Ebp, Gpr::Esi, Gpr::Edi,
];

/// A decoded ModRM operand.
enum Rm {
    Reg(Gpr),
    Mem(Address),
}

/// ModRM for the forms this slice admits: `mod=11`, and `mod=00/01` with either a plain base or
/// a SIB byte. disp32-only and a SIB with no base are refused — a decoder that treats an
/// unrecognised form as a plausible one produces a region wrong exactly where nobody tested.
fn decode_modrm(bytes: &[u8], at: usize) -> Result<(Gpr, Rm, usize), LiftError> {
    let modrm = *bytes.get(at).ok_or(LiftError::Truncated { at })?;
    let reg = REGS[((modrm >> 3) & 7) as usize];
    let rm = (modrm & 7) as usize;
    let mode = modrm >> 6;
    if mode == 3 {
        return Ok((reg, Rm::Reg(REGS[rm]), 1));
    }
    if mode > 1 {
        return Err(LiftError::Unsupported { at, byte: modrm });
    }
    if mode == 0 && rm == 5 {
        return Err(LiftError::Unsupported { at, byte: modrm });   // disp32-only
    }

    let mut len = 1usize;
    let (base, index, scale) = if rm == 4 {
        let sib = *bytes.get(at + 1).ok_or(LiftError::Truncated { at: at + 1 })?;
        len += 1;
        let base_field = (sib & 7) as usize;
        let index_field = ((sib >> 3) & 7) as usize;
        if mode == 0 && base_field == 5 {
            return Err(LiftError::Unsupported { at, byte: sib });   // no base, disp32
        }
        // index == 4 encodes "no index"; ESP can never be an index register.
        let index = if index_field == 4 { None } else { Some(REGS[index_field]) };
        (Some(REGS[base_field]), index, 1u8 << (sib >> 6))
    } else {
        (Some(REGS[rm]), None, 1)
    };

    let displacement = if mode == 1 {
        let d = *bytes.get(at + len).ok_or(LiftError::Truncated { at: at + len })?;
        len += 1;
        d as i8 as i32
    } else {
        0
    };
    Ok((
        reg,
        Rm::Mem(Address { base, index, scale, displacement, segment: Segment::DefaultData }),
        len,
    ))
}

fn mem_only(rm: Rm, at: usize, byte: u8) -> Result<Address, LiftError> {
    match rm {
        Rm::Mem(address) => Ok(address),
        Rm::Reg(_) => Err(LiftError::Unsupported { at, byte }),
    }
}

/// A control transfer's target is a byte offset until every instruction's offset is known, so it
/// is decoded half-resolved and finished in a second pass.
enum Partial {
    Settled(Opcode),
    Branch { condition: Condition, target: usize },
    Jump { target: usize },
    Call { target: usize, return_offset: usize },
    /// An instruction the slice does not model. The region ends immediately before it — which is
    /// only possible because its LENGTH is known, as the plan requires of every such boundary.
    Boundary,
}

struct Decoded {
    opcode: Partial,
    len: usize,
}

fn i32_le(bytes: &[u8], at: usize) -> Result<i32, LiftError> {
    let s = bytes.get(at..at + 4).ok_or(LiftError::Truncated { at })?;
    Ok(i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn decode_one(bytes: &[u8], at: usize) -> Result<Decoded, LiftError> {
    let op = *bytes.get(at).ok_or(LiftError::Truncated { at })?;
    let settled = |opcode, len| Ok(Decoded { opcode: Partial::Settled(opcode), len });
    match op {
        0x48..=0x4f => settled(Opcode::Decrement32 { dst: REGS[(op - 0x48) as usize] }, 1),
        0x50..=0x57 => settled(Opcode::Push32 { src: REGS[(op - 0x50) as usize] }, 1),
        // B8+r imm32 — mov r32, imm32
        0xb8..=0xbf => settled(
            Opcode::Move32Immediate { dst: REGS[(op - 0xb8) as usize], value: i32_le(bytes, at + 1)? as u32 },
            5,
        ),
        // 33 /r — xor r32, r/m32
        0x33 => {
            let (reg, rm, n) = decode_modrm(bytes, at + 1)?;
            match rm {
                Rm::Reg(src) => settled(Opcode::Xor32 { dst: reg, src }, 1 + n),
                Rm::Mem(_) => Err(LiftError::Unsupported { at, byte: op }),
            }
        }
        // 39 /r — cmp r/m32, r32
        0x39 => {
            let (reg, rm, n) = decode_modrm(bytes, at + 1)?;
            let address = mem_only(rm, at, op)?;
            settled(Opcode::CompareMem32Reg { address, rhs: reg }, 1 + n)
        }
        // 75 rel8 — jne
        0x75 => {
            let rel = *bytes.get(at + 1).ok_or(LiftError::Truncated { at: at + 1 })?;
            let target = (at as i64 + 2 + rel as i8 as i64) as usize;
            Ok(Decoded {
                opcode: Partial::Branch { condition: Condition::NotEqual, target },
                len: 2,
            })
        }
        0x58..=0x5f => settled(Opcode::Pop32 { dst: REGS[(op - 0x58) as usize] }, 1),
        // 89 /r — mov r/m32, r32
        0x89 => {
            let (reg, rm, n) = decode_modrm(bytes, at + 1)?;
            match rm {
                Rm::Mem(address) => settled(Opcode::Store32 { address, src: reg }, 1 + n),
                Rm::Reg(dst) => settled(Opcode::Move32 { dst, src: reg }, 1 + n),
            }
        }
        // 8B /r — mov r32, r/m32
        0x8b => {
            let (reg, rm, n) = decode_modrm(bytes, at + 1)?;
            match rm {
                Rm::Mem(address) => settled(Opcode::Load32 { dst: reg, address }, 1 + n),
                Rm::Reg(src) => settled(Opcode::Move32 { dst: reg, src }, 1 + n),
            }
        }
        // 8D /r — lea r32, [mem]
        0x8d => {
            let (reg, rm, n) = decode_modrm(bytes, at + 1)?;
            let address = mem_only(rm, at, op)?;
            settled(Opcode::Lea32 { dst: reg, address }, 1 + n)
        }
        // 03 /r — add r32, r/m32
        0x03 => {
            let (reg, rm, n) = decode_modrm(bytes, at + 1)?;
            let address = mem_only(rm, at, op)?;
            settled(Opcode::Add32Mem { dst: reg, address }, 1 + n)
        }
        // C7 /0 imm32 — mov r/m32, imm32
        0xc7 => {
            let (ext, rm, n) = decode_modrm(bytes, at + 1)?;
            if ext != Gpr::Eax {
                return Err(LiftError::Unsupported { at, byte: op });
            }
            let address = mem_only(rm, at, op)?;
            let value = i32_le(bytes, at + 1 + n)? as u32;
            settled(Opcode::StoreImm32 { address, value }, 1 + n + 4)
        }
        // 83 /digit imm8 — group 1, sign-extended byte. The ModRM's reg field is the opcode
        // extension, so it is matched as a digit, never used as a register.
        0x83 => {
            let (ext, rm, n) = decode_modrm(bytes, at + 1)?;
            let imm = *bytes.get(at + 1 + n).ok_or(LiftError::Truncated { at: at + 1 + n })?;
            let value = imm as i8 as i32;
            let len = 1 + n + 1;
            match (ext, rm) {
                (Gpr::Eax, Rm::Reg(dst)) => settled(Opcode::Add32Immediate { dst, value }, len),
                (Gpr::Edi, Rm::Mem(address)) => settled(Opcode::CompareMem32Imm { address, value }, len),
                _ => Err(LiftError::Unsupported { at, byte: op }),
            }
        }
        // C1 /4 imm8 — shl r/m32, imm8
        0xc1 => {
            let (ext, rm, n) = decode_modrm(bytes, at + 1)?;
            let amount = *bytes.get(at + 1 + n).ok_or(LiftError::Truncated { at: at + 1 + n })?;
            match (ext, rm) {
                (Gpr::Esp, Rm::Reg(dst)) => settled(Opcode::Shl32Immediate { dst, amount }, 1 + n + 1),
                _ => Err(LiftError::Unsupported { at, byte: op }),
            }
        }
        0x0f => {
            let op2 = *bytes.get(at + 1).ok_or(LiftError::Truncated { at: at + 1 })?;
            match op2 {
                // 0F B6 /r — movzx r32, r/m8
                0xb6 => {
                    let (reg, rm, n) = decode_modrm(bytes, at + 2)?;
                    let address = mem_only(rm, at, op2)?;
                    settled(Opcode::LoadZeroExtendByte { dst: reg, address }, 2 + n)
                }
                // 0F 95 /r — setne r/m8
                0x95 => {
                    let (_, rm, n) = decode_modrm(bytes, at + 2)?;
                    match rm {
                        Rm::Reg(dst) => settled(
                            Opcode::SetCondition8 {
                                dst,
                                part: RegisterPart::Low8,
                                condition: Condition::NotEqual,
                            },
                            2 + n,
                        ),
                        Rm::Mem(_) => Err(LiftError::Unsupported { at, byte: op2 }),
                    }
                }
                // 0F 8D rel32 — jge (signed)
                0x8d => {
                    let rel = i32_le(bytes, at + 2)?;
                    let target = (at as i64 + 6 + rel as i64) as usize;
                    Ok(Decoded {
                        opcode: Partial::Branch {
                            condition: Condition::GreaterOrEqualSigned,
                            target,
                        },
                        len: 6,
                    })
                }
                _ => Err(LiftError::Unsupported { at, byte: op2 }),
            }
        }
        // 68 imm32 — push imm32.
        0x68 => {
            let value = i32_le(bytes, at + 1)? as u32;
            Ok(Decoded { opcode: Partial::Settled(Opcode::Push32Immediate { value }), len: 5 })
        }
        // E8 rel32 — call. Only an IN-REGION target is modelled: a call that leaves pushes a
        // frame this region owns for code it does not, and approximating that is how a region
        // comes to disagree with the baseline about who returns where.
        0xe8 => {
            let rel = i32_le(bytes, at + 1)?;
            let target = (at as i64 + 5 + rel as i64) as usize;
            Ok(Decoded { opcode: Partial::Call { target, return_offset: at + 5 }, len: 5 })
        }
        0xeb => {
            let rel = *bytes.get(at + 1).ok_or(LiftError::Truncated { at: at + 1 })?;
            let target = (at as i64 + 2 + rel as i8 as i64) as usize;
            Ok(Decoded { opcode: Partial::Jump { target }, len: 2 })
        }
        0xe9 => {
            let rel = i32_le(bytes, at + 1)?;
            let target = (at as i64 + 5 + rel as i64) as usize;
            Ok(Decoded { opcode: Partial::Jump { target }, len: 5 })
        }
        // C3 / C2 imm16 — ret. The target is [ESP]: a real terminator with a run-time successor,
        // not a boundary. See `Opcode::Return`.
        0xc3 => Ok(Decoded { opcode: Partial::Settled(Opcode::Return { pop: 0 }), len: 1 }),
        0xc2 => {
            let lo = *bytes.get(at + 1).ok_or(LiftError::Truncated { at: at + 1 })?;
            let hi = *bytes.get(at + 2).ok_or(LiftError::Truncated { at: at + 2 })?;
            let pop = u16::from(lo) | (u16::from(hi) << 8);
            Ok(Decoded { opcode: Partial::Settled(Opcode::Return { pop }), len: 3 })
        }
        _ => Err(LiftError::Unsupported { at, byte: op }),
    }
}

/// The reconstruction a conservative region hands to every exit: nothing is rebuilt, because
/// nothing was ever allowed to drift. `verify` refuses this shape unless the region says so.
fn canonical_reconstruction(effect_token: u32) -> Reconstruction {
    Reconstruction {
        gprs: [
            ValueRef::LiveGpr(Gpr::Eax), ValueRef::LiveGpr(Gpr::Ecx),
            ValueRef::LiveGpr(Gpr::Edx), ValueRef::LiveGpr(Gpr::Ebx),
            ValueRef::LiveGpr(Gpr::Esp), ValueRef::LiveGpr(Gpr::Ebp),
            ValueRef::LiveGpr(Gpr::Esi), ValueRef::LiveGpr(Gpr::Edi),
        ],
        flags: FlagRecipe::Live,
        effect_token,
    }
}

/// Lift an arbitrary run of supported instructions starting at a guest address.
///
/// This is what a page entry needs: the code there is whatever the guest put there — for the
/// oracle image, a wrapper prologue followed by a kernel body — and a unit that implements a
/// different instruction stream than the one at its entry runs the guest's registers into
/// whatever the region assumed.
pub fn lift_slice(entry_eip: u32, bytes: &[u8]) -> Result<Region, LiftError> {
    lift_bytes(entry_eip, bytes)
}

/// Lift the whole k8 body into one region with internal control flow.
///
/// The loop's back edge and the exit test both stay INSIDE the region: expressing them as
/// statepoints would be correct and useless, since the region would then leave on every
/// iteration and measure nothing but its own entry cost.
pub fn lift_k8(entry_eip: u32, bytes: &[u8]) -> Result<Region, LiftError> {
    // The RETAIL body, or nothing. `lift_slice` is the general entry point; this one is named
    // after a corpus kernel, so it may only produce a region whose identity is that kernel.
    if bytes != K8_BYTES.as_slice() {
        return Err(LiftError::BodyMismatch);
    }
    lift_bytes(entry_eip, bytes)
}

/// Lift `bytes`, recording the identity of what was ACTUALLY lifted.
///
/// The hash is computed, never supplied: stamping a caller's constant would let a modified
/// program be published under the original's identity, and every content-binding check
/// downstream would then answer "unchanged" about different code.
fn lift_bytes(entry_eip: u32, bytes: &[u8]) -> Result<Region, LiftError> {
    // Decode linearly. k8 has no data interleaved with code and no instruction reachable at two
    // different alignments, so a linear sweep sees exactly the instruction stream the guest does.
    let mut decoded: Vec<(usize, Decoded)> = Vec::new();
    let mut offset_to_index = std::collections::HashMap::new();
    let mut pushed_returns: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    let mut at = 0usize;
    while at < bytes.len() {
        // An instruction this slice does not model ENDS the region with a boundary the baseline
        // continues at — that is what `ExitReason::UnsupportedInstruction` is for, and it is how
        // a region stops at the edge of what it understands instead of refusing whole programs
        // over one byte. The FIRST instruction is the exception: a region that models nothing
        // would be an entry that retires nothing, so it stays a lift failure.
        let one = match decode_one(bytes, at) {
            Ok(one) => one,
            Err(LiftError::Unsupported { at: where_, byte }) if at > 0 => {
                let _ = (where_, byte);
                Decoded { opcode: Partial::Boundary, len: 0 }
            }
            Err(other) => return Err(other),
        };
        offset_to_index.insert(at, decoded.len() as u32);
        let len = one.len;
        // An address pushed as a constant is a RETURN POINT: the caller-less wrapper idiom pushes
        // one and falls through, and the callee's `ret` lands on it. Recording them is what lets
        // the sweep continue past that `ret` and cover the cleanup that follows — without it the
        // region stops mid-page and hands control back at an address it does not serve.
        if let Partial::Settled(Opcode::Push32Immediate { value }) = &one.opcode {
            let offset = value.wrapping_sub(entry_eip) as usize;
            if offset < bytes.len() {
                pushed_returns.insert(offset);
            }
        }
        let ends_here = matches!(one.opcode, Partial::Boundary);
        let returns = matches!(one.opcode, Partial::Settled(Opcode::Return { .. }));
        decoded.push((at, one));
        at += len;
        if ends_here || (returns && !pushed_returns.iter().any(|o| *o >= at)) {
            break;
        }
    }
    // Exactly the bytes the lifter consumed, which is what the region's identity describes.
    let consumed = at;

    let mut instructions: Vec<Instruction> = Vec::with_capacity(decoded.len());
    let mut effect = 0u32;
    for (index, (offset, one)) in decoded.iter().enumerate() {
        let guest_eip = entry_eip.wrapping_add(*offset as u32);
        // Every edge that leaves the region continues at the guest EIP of the instruction that
        // would have run next, with the effect frontier as it stands at that point.
        let exit_to = |eip: u32, reason: ExitReason, effect_token: u32| {
            Continuation::Exit(Statepoint {
                continuation_eip: eip,
                accounting_delta: AccountingDelta::Retired,
                reason,
                reconstruction: canonical_reconstruction(effect_token),
            })
        };
        let resolve = |target: usize, effect_token: u32| match offset_to_index.get(&target) {
            Some(i) => Continuation::InRegion { instruction: *i },
            // A target inside the body but not at an instruction boundary would mean the guest
            // decodes these bytes differently than we did; a target outside it is simply not ours.
            None => exit_to(
                entry_eip.wrapping_add(target as u32),
                ExitReason::BranchTaken,
                effect_token,
            ),
        };

        let opcode = match &one.opcode {
            Partial::Settled(op) => op.clone(),
            Partial::Branch { condition, target } => {
                let next = entry_eip.wrapping_add((*offset + one.len) as u32);
                let taken = resolve(*target, effect);
                let fallthrough = match offset_to_index.get(&(*offset + one.len)) {
                    Some(i) => Continuation::InRegion { instruction: *i },
                    None => exit_to(next, ExitReason::Fallthrough, effect),
                };
                Opcode::BranchIf { condition: *condition, taken, fallthrough }
            }
            Partial::Jump { target } => Opcode::Jump { target: resolve(*target, effect) },
            Partial::Call { target, return_offset } => Opcode::CallRelative {
                target: resolve(*target, effect + 1),
                return_to: entry_eip.wrapping_add(*return_offset as u32),
            },
            Partial::Boundary => Opcode::Exit(Statepoint {
                continuation_eip: guest_eip,
                accounting_delta: AccountingDelta::Retired,
                reason: ExitReason::UnsupportedInstruction,
                reconstruction: canonical_reconstruction(effect),
            }),
        };
        let next_effect = effect + u32::from(opcode.has_memory_effect());
        instructions.push(Instruction {
            guest_eip,
            state_in: index as u32,
            state_out: index as u32 + 1,
            effect_in: effect,
            effect_out: next_effect,
            opcode,
        });
        effect = next_effect;
    }

    let touches_memory = instructions.iter().any(|i| i.opcode.has_memory_effect());
    let stores_to_memory = instructions.iter().any(|i| {
        matches!(i.opcode, Opcode::Store32 { .. } | Opcode::StoreImm32 { .. } | Opcode::Push32 { .. })
    });
    let region = Region {
        ir_version: IR_VERSION,
        keeps_state_canonical: true,
        envelope: Envelope::integer_slice_v1(touches_memory, stores_to_memory),
        entry_eip,
        code_dependencies: vec![CodeDependency {
            guest_page: entry_eip >> 12,
            // Only the bytes the lifter consumed: a region depends on the code it decoded, not
            // on whatever else the caller handed it.
            body_sha256: crate::sha256::sha256(&bytes[..consumed]),
        }],
        instructions,
    };
    verify(&region).map_err(LiftError::InvalidRegion)?;
    Ok(region)
}
