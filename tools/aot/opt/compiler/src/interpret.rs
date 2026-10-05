//! Reference interpreter for the supported IR.
//!
//! It exists to be differentially compared against v86, so it models the things a fast path is
//! tempted to skip: byte-addressed memory with permissions, ordered effects, and faults that
//! stop exactly where the guest would have stopped.

use crate::ir::*;


#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Machine {
    pub gprs: [u32; 8],
    pub flags: Flags,
    pub eip: u32,
    pub accounting: u64,
    pub effects: u32,
}
impl Machine {
    pub fn new(entry_eip: u32) -> Self {
        Self {
            gprs: [0; 8],
            flags: Flags::default(),
            eip: entry_eip,
            accounting: 0,
            effects: 0,
        }
    }
    pub fn get(&self, register: Gpr) -> u32 {
        self.gprs[register as usize]
    }
    pub fn set(&mut self, register: Gpr, value: u32) {
        self.gprs[register as usize] = value;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Memory {
    bytes: Vec<u8>,
    readable: Vec<bool>,
    writable: Vec<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemoryFault {
    OutOfBounds { address: u32, width: u8 },
    Permission { address: u32, write: bool },
}
impl Memory {
    pub fn new(size: usize) -> Self {
        Self {
            bytes: vec![0; size],
            readable: vec![true; size],
            writable: vec![true; size],
        }
    }
    pub fn set_permissions(
        &mut self,
        address: u32,
        len: usize,
        readable: bool,
        writable: bool,
    ) -> Result<(), MemoryFault> {
        let end = (address as usize).checked_add(len).ok_or(MemoryFault::OutOfBounds { address, width: 4 })?;
        if end > self.bytes.len() {
            return Err(MemoryFault::OutOfBounds { address, width: 4 });
        }
        for i in address as usize..end {
            self.readable[i] = readable;
            self.writable[i] = writable;
        }
        Ok(())
    }
    pub fn read_u32(&self, address: u32) -> Result<u32, MemoryFault> {
        let end = address
            .checked_add(4)
            .ok_or(MemoryFault::OutOfBounds { address, width: 4 })? as usize;
        if end > self.bytes.len() {
            return Err(MemoryFault::OutOfBounds { address, width: 4 });
        }
        if !(address as usize..end).all(|i| self.readable[i]) {
            return Err(MemoryFault::Permission {
                address,
                write: false,
            });
        }
        Ok(u32::from_le_bytes(
            self.bytes[address as usize..end].try_into().unwrap(),
        ))
    }
    pub fn write_u8(&mut self, address: u32, value: u8) -> Result<(), MemoryFault> {
        let i = address as usize;
        if i >= self.bytes.len() {
            return Err(MemoryFault::OutOfBounds { address, width: 1 });
        }
        if !self.writable[i] {
            return Err(MemoryFault::Permission { address, write: true });
        }
        self.bytes[i] = value;
        Ok(())
    }
    /// Read bytes as the HOST sees them, ignoring guest permissions.
    ///
    /// This is what the oracle does when it dumps a compared region: it reads guest physical
    /// memory directly, so a page the guest may no longer touch is still readable to it. Using
    /// the guest accessor there would make a fault scenario unable to report what it produced.
    pub fn peek(&self, address: u32, len: usize) -> Option<&[u8]> {
        self.bytes.get(address as usize..address as usize + len)
    }

    pub fn read_u8(&self, address: u32) -> Result<u8, MemoryFault> {
        let i = address as usize;
        if i >= self.bytes.len() {
            return Err(MemoryFault::OutOfBounds { address, width: 1 });
        }
        if !self.readable[i] {
            return Err(MemoryFault::Permission {
                address,
                write: false,
            });
        }
        Ok(self.bytes[i])
    }
    pub fn write_u32(&mut self, address: u32, value: u32) -> Result<(), MemoryFault> {
        let end = address
            .checked_add(4)
            .ok_or(MemoryFault::OutOfBounds { address, width: 4 })? as usize;
        if end > self.bytes.len() {
            return Err(MemoryFault::OutOfBounds { address, width: 4 });
        }
        if !(address as usize..end).all(|i| self.writable[i]) {
            return Err(MemoryFault::Permission {
                address,
                write: true,
            });
        }
        self.bytes[address as usize..end].copy_from_slice(&value.to_le_bytes());
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecuteExit {
    /// A declared constant delta disagreed with what the path retired.
    AccountingMismatch {
        declared: u32,
        retired: u64,
        continuation_eip: u32,
    },
    /// The activation retired more instructions than it was allowed.
    BudgetExhausted {
        retired: u64,
        guest_eip: u32,
    },
    Statepoint {
        reason: ExitReason,
        continuation_eip: u32,
    },
    Fault {
        fault: MemoryFault,
        guest_eip: u32,
        retired_instructions: u32,
        effect_token: u32,
    },
}

fn address(machine: &Machine, address: Address) -> u32 {
    let base = address.base.map_or(0, |r| machine.get(r));
    let index = address
        .index
        .map_or(0, |r| machine.get(r).wrapping_mul(address.scale as u32));
    base.wrapping_add(index)
        .wrapping_add(address.displacement as u32)
}
fn condition(flags: Flags, condition: Condition) -> bool {
    match condition {
        Condition::NotEqual => !flags.zf,
        // SF == OF. Reading this as "not less than" via ZF would be the unsigned test, which
        // agrees with the signed one on every non-negative input and on nothing else.
        Condition::GreaterOrEqualSigned => flags.sf == flags.of,
    }
}

fn parity_even(value: u32) -> bool {
    (value as u8).count_ones() % 2 == 0
}

pub(crate) fn flags_for_logic(result: u32) -> Flags {
    // Intel documents AF as undefined for XOR. The interpreter gives it a deterministic false
    // value, while the recipe's defined mask accurately records that callers cannot rely on it.
    Flags {
        cf: false,
        pf: parity_even(result),
        af: false,
        zf: result == 0,
        sf: result >> 31 != 0,
        of: false,
    }
}

pub(crate) fn flags_for_add(lhs: u32, rhs: u32, result: u32) -> Flags {
    Flags {
        cf: result < lhs,
        pf: parity_even(result),
        af: (lhs ^ rhs ^ result) & 0x10 != 0,
        zf: result == 0,
        sf: result >> 31 != 0,
        of: (!(lhs ^ rhs) & (lhs ^ result) & 0x8000_0000) != 0,
    }
}

pub(crate) fn flags_for_sub(lhs: u32, rhs: u32, result: u32) -> Flags {
    Flags {
        cf: lhs < rhs,
        pf: parity_even(result),
        af: (lhs ^ rhs ^ result) & 0x10 != 0,
        zf: result == 0,
        sf: result >> 31 != 0,
        of: ((lhs ^ rhs) & (lhs ^ result) & 0x8000_0000) != 0,
    }
}

pub(crate) fn flags_for_dec(old: u32, old_flags: Flags) -> Flags {
    let result = old.wrapping_sub(1);
    let mut flags = flags_for_sub(old, 1, result);
    flags.cf = old_flags.cf;
    flags
}

fn flags_bits(flags: Flags) -> u8 {
    let mut bits = 0;
    if flags.cf {
        bits |= FLAG_CF;
    }
    if flags.pf {
        bits |= FLAG_PF;
    }
    if flags.af {
        bits |= FLAG_AF;
    }
    if flags.zf {
        bits |= FLAG_ZF;
    }
    if flags.sf {
        bits |= FLAG_SF;
    }
    if flags.of {
        bits |= FLAG_OF;
    }
    bits
}

fn flags_from_bits(bits: u8) -> Flags {
    Flags {
        cf: bits & FLAG_CF != 0,
        pf: bits & FLAG_PF != 0,
        af: bits & FLAG_AF != 0,
        zf: bits & FLAG_ZF != 0,
        sf: bits & FLAG_SF != 0,
        of: bits & FLAG_OF != 0,
    }
}

fn replace_flag_bits(base: Flags, source: Flags, mask: u8) -> Flags {
    flags_from_bits((flags_bits(base) & !mask) | (flags_bits(source) & mask))
}

/// Materialize an exit.
///
/// `retired` is the count INCLUDING the terminator when the terminator executed, and excluding it
/// when the exit stands in for an instruction the region does not model. Getting that wrong is
/// invisible while every exit carries a hand-written constant and becomes a per-exit drift the
/// moment one carries `Retired`.
fn statepoint_exit(
    machine: &mut Machine,
    input: &[u32; 8],
    values: &[Option<u32>],
    flag_values: &[Option<Flags>],
    point: Statepoint,
    retired: u64,
) -> ExecuteExit {
    reconstruct(machine, input, values, flag_values, point.reconstruction);
    machine.eip = point.continuation_eip;
    match point.accounting_delta {
        AccountingDelta::Retired => machine.accounting += retired,
        // A declared constant is checked against the path that actually reached the exit. An
        // unchecked constant is the accounting-by-intent this type exists to prevent, and it was
        // only ever right because someone happened to write the correct number.
        AccountingDelta::Fixed(n) => {
            if u64::from(n) != retired {
                return ExecuteExit::AccountingMismatch {
                    declared: n,
                    retired,
                    continuation_eip: point.continuation_eip,
                };
            }
            machine.accounting += u64::from(n);
        }
    }
    ExecuteExit::Statepoint { reason: point.reason, continuation_eip: point.continuation_eip }
}

/// The exact shape a faulting memory operation exits with: the effects that already landed stay
/// landed, and `retired` counts only instructions that completed.
fn fault_exit(
    machine: &mut Machine,
    instruction: &Instruction,
    retired: u64,
    fault: MemoryFault,
) -> ExecuteExit {
    // The two counters the plan keeps apart disagree exactly here. The ENGINE counter follows
    // v86, which increments before executing and commits at the loop exit, so a faulting access
    // is counted; the logical-work ledger reports only instructions that COMPLETED, so it is not.
    // Reporting one number for both is how an accounting drifts by one per fault.
    machine.accounting += retired + 1;
    ExecuteExit::Fault {
        fault,
        guest_eip: instruction.guest_eip,
        retired_instructions: retired as u32,
        effect_token: machine.effects,
    }
}

/// SHL's flags. CF is the last bit shifted out; AF is undefined and OF is defined only for a
/// count of one, so both are left at whatever they were rather than invented — the recipe's
/// defined mask is what records that a consumer may not rely on them.
pub(crate) fn flags_for_shl(old: u32, amount: u8, result: u32, previous: Flags) -> Flags {
    let count = u32::from(amount) & 0x1f;
    if count == 0 {
        return previous;
    }
    let cf = ((old >> (32 - count)) & 1) == 1;
    Flags {
        cf,
        pf: parity_even(result),
        // AF is architecturally undefined for every shift count.
        af: previous.af,
        zf: result == 0,
        sf: (result as i32) < 0,
        // OF is defined ONLY for a count of one, where it is MSB(result) XOR CF. For any other
        // count it is undefined and left as it was; `FLAGS_SHIFT_DEFINED` records that a consumer
        // may not rely on it.
        of: if count == 1 { ((result >> 31) & 1 == 1) != cf } else { previous.of },
    }
}

/// Interpret one activation of a region.
///
/// An access check happens before its own effect and before the next instruction, so a faulting
/// load cannot reach the store that would have consumed it.
///
/// `budget` bounds the number of instructions one activation may retire. A region with a back
/// edge can loop, and `verify` proves reachability, not termination: without a bound a lifter
/// bug is a hang in the test suite rather than a failure in it.
pub fn execute_with_budget(
    region: &Region,
    machine: &mut Machine,
    memory: &mut Memory,
    budget: u64,
) -> ExecuteExit {
    let input = machine.gprs;
    let mut values = vec![None; region.instructions.len()];
    let mut flag_values = vec![None; region.instructions.len()];
    // A program counter, not an iterator: an in-region edge may go backwards, and `retired` is a
    // running count rather than the instruction index. They coincide only for a straight-line
    // region, which is exactly why conflating them survived k3 and would not survive a loop.
    let mut index = 0usize;
    let mut retired = 0u64;
    while index < region.instructions.len() {
        if retired >= budget {
            // A budget exit is an exit, and owes what every other one does: EIP naming the
            // instruction that did NOT run, and the counter credited with what did. Returning
            // without them leaves a caller resuming from stale state, which re-executes work
            // already performed — the one mistake this exit class exists to avoid.
            let guest_eip = region.instructions[index].guest_eip;
            machine.eip = guest_eip;
            machine.accounting += retired;
            return ExecuteExit::BudgetExhausted { retired, guest_eip };
        }
        let instruction = &region.instructions[index];
        machine.eip = instruction.guest_eip;
        let mut next_index = index + 1;
        let result = match instruction.opcode {
            Opcode::Xor32 { dst, src } => {
                let value = machine.get(dst) ^ machine.get(src);
                machine.set(dst, value);
                machine.flags = flags_for_logic(value);
                Some(value)
            }
            Opcode::CompareMem32Reg { address: a, rhs } => {
                match memory.read_u32(address(machine, a)) {
                    Ok(lhs) => {
                        let rhs = machine.get(rhs);
                        machine.flags = flags_for_sub(lhs, rhs, lhs.wrapping_sub(rhs));
                        machine.effects += 1;
                        None
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::SetCondition8 {
                dst,
                part,
                condition: c,
            } => {
                let old = machine.get(dst);
                let bit = u32::from(condition(machine.flags, c));
                let value = match part {
                    RegisterPart::Low8 => (old & !0xff) | bit,
                    RegisterPart::High8 => (old & !0xff00) | (bit << 8),
                    RegisterPart::Low16 => (old & !0xffff) | bit,
                    RegisterPart::Full32 => bit,
                };
                machine.set(dst, value);
                Some(value)
            }
            Opcode::Store32 { address: a, src } => {
                match memory.write_u32(address(machine, a), machine.get(src)) {
                    Ok(()) => {
                        machine.effects += 1;
                        None
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::Add32Immediate { dst, value } => {
                let old = machine.get(dst);
                let next = old.wrapping_add(value as u32);
                machine.set(dst, next);
                machine.flags = flags_for_add(old, value as u32, next);
                Some(next)
            }
            Opcode::Decrement32 { dst } => {
                let old = machine.get(dst);
                let next = old.wrapping_sub(1);
                machine.set(dst, next);
                machine.flags = flags_for_dec(old, machine.flags);
                Some(next)
            }
            Opcode::Move32Immediate { dst, value } => {
                machine.set(dst, value);
                Some(value)
            }
            Opcode::Move32 { dst, src } => {
                let value = machine.get(src);
                machine.set(dst, value);
                Some(value)
            }
            Opcode::Load32 { dst, address: a } => match memory.read_u32(address(machine, a)) {
                Ok(value) => {
                    machine.set(dst, value);
                    machine.effects += 1;
                    Some(value)
                }
                Err(fault) => return fault_exit(machine, instruction, retired, fault),
            },
            Opcode::LoadZeroExtendByte { dst, address: a } => {
                match memory.read_u8(address(machine, a)) {
                    Ok(byte) => {
                        // Zero-extension, not sign: the guest wrote MOVZX, and MOVSX on the same
                        // bytes differs for every source byte with the high bit set.
                        let value = u32::from(byte);
                        machine.set(dst, value);
                        machine.effects += 1;
                        Some(value)
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::Add32Mem { dst, address: a } => match memory.read_u32(address(machine, a)) {
                Ok(rhs) => {
                    let lhs = machine.get(dst);
                    let value = lhs.wrapping_add(rhs);
                    machine.set(dst, value);
                    machine.flags = flags_for_add(lhs, rhs, value);
                    machine.effects += 1;
                    Some(value)
                }
                Err(fault) => return fault_exit(machine, instruction, retired, fault),
            },
            Opcode::Shl32Immediate { dst, amount } => {
                let old = machine.get(dst);
                let value = old.wrapping_shl(u32::from(amount));
                machine.set(dst, value);
                machine.flags = flags_for_shl(old, amount, value, machine.flags);
                Some(value)
            }
            Opcode::StoreImm32 { address: a, value } => {
                match memory.write_u32(address(machine, a), value) {
                    Ok(()) => {
                        machine.effects += 1;
                        None
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::CompareMem32Imm { address: a, value } => {
                match memory.read_u32(address(machine, a)) {
                    Ok(lhs) => {
                        let rhs = value as u32;
                        machine.flags = flags_for_sub(lhs, rhs, lhs.wrapping_sub(rhs));
                        machine.effects += 1;
                        None
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::Push32 { src } => {
                // ESP moves first, then the store lands at the new top. Doing it the other way
                // round writes one slot too high and leaves the guest's frame unusable.
                let value = machine.get(src);
                let sp = machine.get(Gpr::Esp).wrapping_sub(4);
                match memory.write_u32(sp, value) {
                    Ok(()) => {
                        machine.set(Gpr::Esp, sp);
                        machine.effects += 1;
                        None
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::Lea32 { dst, address: a } => {
                let value = address(machine, a);
                machine.set(dst, value);
                Some(value)
            }
            Opcode::Push32Immediate { value } => {
                let sp = machine.get(Gpr::Esp).wrapping_sub(4);
                match memory.write_u32(sp, value) {
                    Ok(()) => {
                        machine.set(Gpr::Esp, sp);
                        machine.effects += 1;
                        None
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::CallRelative { target, return_to } => {
                // The pushed frame is what a later `ret` returns through, so the store happens
                // before control moves — a call that transferred first and pushed after would
                // leave a return address the callee could already have overwritten.
                let sp = machine.get(Gpr::Esp).wrapping_sub(4);
                match memory.write_u32(sp, return_to) {
                    Ok(()) => {
                        machine.set(Gpr::Esp, sp);
                        machine.effects += 1;
                        retired += 1;
                        match target {
                            Continuation::InRegion { instruction: to } => {
                                index = to as usize;
                                continue;
                            }
                            Continuation::Exit(point) => {
                                let input = machine.gprs;
                                return statepoint_exit(
                                    machine, &input, &values, &flag_values, point, retired,
                                );
                            }
                        }
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::Return { pop } => {
                let sp = machine.get(Gpr::Esp);
                match memory.read_u32(sp) {
                    Ok(target) => {
                        machine.set(Gpr::Esp, sp.wrapping_add(4).wrapping_add(u32::from(pop)));
                        machine.effects += 1;
                        // The successor is the loaded value, so this leaves the region with an
                        // EIP nothing could have named at lift time. It RETIRED, so the
                        // terminator counts (`retired + 1`), exactly like a branch that ran.
                        machine.eip = target;
                        machine.accounting += retired + 1;
                        return ExecuteExit::Statepoint {
                            reason: ExitReason::BranchTaken,
                            continuation_eip: target,
                        };
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::Pop32 { dst } => {
                let sp = machine.get(Gpr::Esp);
                match memory.read_u32(sp) {
                    Ok(value) => {
                        // ESP is adjusted FIRST and the destination written last, so `pop esp`
                        // ends up holding the loaded value: x86 discards the increment in that
                        // case, and writing the destination first would discard the load instead.
                        machine.set(Gpr::Esp, sp.wrapping_add(4));
                        machine.set(dst, value);
                        machine.effects += 1;
                        Some(value)
                    }
                    Err(fault) => return fault_exit(machine, instruction, retired, fault),
                }
            }
            Opcode::BranchIf {
                condition: c,
                taken,
                fallthrough,
            } => {
                let edge = if condition(machine.flags, c) {
                    taken
                } else {
                    fallthrough
                };
                match edge {
                    Continuation::InRegion { instruction: target } => {
                        next_index = target as usize;
                        None
                    }
                    Continuation::Exit(point) => {
                        // The branch itself EXECUTED — its continuation is the target, not the
                        // branch — so it counts.
                        return statepoint_exit(machine, &input, &values, &flag_values, point, retired + 1);
                    }
                }
            }
            Opcode::Jump { target } => match target {
                Continuation::InRegion { instruction: t } => {
                    next_index = t as usize;
                    None
                }
                Continuation::Exit(point) => {
                    return statepoint_exit(machine, &input, &values, &flag_values, point, retired + 1);
                }
            },
            // A boundary standing in for an instruction the slice does not model. It did NOT
            // execute — the baseline will — so it does not count.
            Opcode::Exit(point) => {
                return statepoint_exit(machine, &input, &values, &flag_values, point, retired);
            }
        };
        values[index] = result;
        if instruction.opcode.writes_flags() {
            flag_values[index] = Some(machine.flags);
        }
        retired += 1;
        index = next_index;
    }
    unreachable!("a verified region ends in a terminator")
}

/// The budget a caller gets when it does not choose one. Far above any legitimate activation of
/// the supported slice, and far below a hang.
pub const DEFAULT_BUDGET: u64 = 1_000_000;

pub fn execute(region: &Region, machine: &mut Machine, memory: &mut Memory) -> ExecuteExit {
    execute_with_budget(region, machine, memory, DEFAULT_BUDGET)
}

fn reconstruct(
    machine: &mut Machine,
    input: &[u32; 8],
    values: &[Option<u32>],
    flag_values: &[Option<Flags>],
    reconstruction: Reconstruction,
) {
    // Snapshot first: reconstruction overwrites the register file while reading it, so a value
    // naming a register a previous slot already replaced would read the new value. `InputGpr`
    // reads the entry snapshot for the same reason.
    let live = machine.gprs;
    for (index, value) in reconstruction.gprs.into_iter().enumerate() {
        machine.gprs[index] = match value {
            ValueRef::InputGpr(register) => input[register as usize],
            ValueRef::InstructionResult { instruction } => {
                values[instruction as usize].expect("verified value")
            }
            ValueRef::Constant(value) => value,
            // No reconstruction needed: the region kept this register canonical, which `verify`
            // only permits when the region says so.
            ValueRef::LiveGpr(register) => live[register as usize],
        };
    }
    machine.flags = match reconstruction.flags {
        FlagRecipe::Arithmetic {
            instruction,
            preserved_from,
            ..
        } => {
            let produced = flag_values[instruction as usize].expect("verified flag producer");
            match preserved_from {
                Some(source) => replace_flag_bits(
                    produced,
                    flag_values[source.instruction as usize]
                        .expect("verified preserved flag producer"),
                    source.mask,
                ),
                None => produced,
            }
        }
        FlagRecipe::Materialized(flags) => flags,
        // Nothing to rebuild: the region never stopped maintaining them.
        FlagRecipe::Live => machine.flags,
    };
    // `effect_token` is the STATIC frontier `verify` pins the statepoint to; `machine.effects` is
    // how many memory operations actually ran. They are different quantities, and assigning one
    // to the other makes a dynamic ledger report a compile-time constant.
}
