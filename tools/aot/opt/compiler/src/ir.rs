//! Guest IR: the values, addresses, effects and regions a lifted slice is made of.
//!
//! Everything here is data. It carries no host state and performs no execution, so a region can
//! be built offline, printed, verified and interpreted by different callers without any of them
//! sharing a runtime.

use crate::contract::*;

pub const IR_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Gpr {
    Eax,
    Ecx,
    Edx,
    Ebx,
    Esp,
    Ebp,
    Esi,
    Edi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Width {
    Byte,
    Word,
    Dword,
}

impl Width {
    pub const fn bytes(self) -> u8 {
        match self {
            Self::Byte => 1,
            Self::Word => 2,
            Self::Dword => 4,
        }
    }
}

/// IA-32 addressing before translation.  Segment semantics remain explicit even though the
/// first k3 slice only admits the default flat data segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Address {
    pub base: Option<Gpr>,
    pub index: Option<Gpr>,
    pub scale: u8,
    pub displacement: i32,
    pub segment: Segment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Segment {
    DefaultData,
    Explicit {
        selector: u16,
        base: u32,
        limit: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Condition {
    NotEqual,
    /// Signed `>=`, i.e. SF == OF. Distinct from the unsigned form: a lifter that confuses them
    /// produces a region that agrees with the guest on every input it was tested with.
    GreaterOrEqualSigned,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitReason {
    Fallthrough,
    BranchTaken,
    GuardMiss,
    Fault,
    Budget,
    UnsupportedInstruction,
}

/// How much engine instruction counter an exit owes.
///
/// A straight-line region retires a fixed count, and saying so lets a lowering fold it into a
/// constant. A region containing a back edge does not: the count depends on how many iterations
/// actually completed, and a constant there would be the accounting-from-intent that CLAUDE.md
/// §3.4 forbids. `verify` refuses `Fixed` in a region that has an in-region back edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountingDelta {
    Fixed(u32),
    /// Whatever this activation actually retired before reaching the exit.
    Retired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Statepoint {
    pub continuation_eip: u32,
    pub accounting_delta: AccountingDelta,
    pub reason: ExitReason,
    pub reconstruction: Reconstruction,
}

/// Values needed to resume execution in the baseline engine at a canonical exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reconstruction {
    pub gprs: [ValueRef; 8],
    pub flags: FlagRecipe,
    pub effect_token: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueRef {
    InputGpr(Gpr),
    InstructionResult { instruction: u32 },
    Constant(u32),
    /// "Whatever the canonical register file currently holds."
    ///
    /// This is not a reconstruction — it is the admission that none is needed, because the
    /// region kept that register canonical throughout. Only a region with
    /// `keeps_state_canonical` may use it, and `verify` enforces that: the whole value of a
    /// reconstruction is lost if an optimized region, which by definition stops keeping state
    /// canonical, can still name this and be believed.
    ///
    /// It exists because a loop makes index-ordered SSA dominance insufficient: at k8's exit the
    /// last definitions of ECX and EDX live at a HIGHER instruction index than the branch that
    /// leaves, so no index-dominating SSA reference to them exists. A conservative region
    /// answers that honestly; an optimizing one will have to prove it.
    LiveGpr(Gpr),
}

/// The six architectural flags this slice models, as booleans rather than as a packed word:
/// a recipe has to be able to say which bits it defines, and a packed word cannot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    pub cf: bool,
    pub pf: bool,
    pub af: bool,
    pub zf: bool,
    pub sf: bool,
    pub of: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagRecipe {
    /// Re-materialize the precise flags produced by an arithmetic instruction.  `defined` and
    /// `preserved` describe the architectural status of every flag at the exit.
    Arithmetic {
        instruction: u32,
        operation: FlagOperation,
        /// SSA values used to reproduce the arithmetic flags, rather than an opaque producer
        /// index.  For k3's DEC these are input EAX, constant one, and DEC's result.
        lhs: ValueRef,
        rhs: ValueRef,
        result: ValueRef,
        defined: u8,
        preserved: u8,
        /// Source of the bits declared in `preserved`; required when that mask is non-empty.
        preserved_from: Option<PreservedFlags>,
    },
    /// A deliberately concrete alternative for a boundary that has already materialized flags.
    Materialized(Flags),
    /// The flags are already canonical, for the same reason and under the same restriction as
    /// `ValueRef::LiveGpr`: only a region that never stopped maintaining them may say this.
    Live,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreservedFlags {
    pub instruction: u32,
    pub mask: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagOperation {
    Xor32,
    Compare32,
    Add32,
    Decrement32,
    Shl32,
}

pub const FLAG_CF: u8 = 1 << 0;
pub const FLAG_PF: u8 = 1 << 1;
pub const FLAG_AF: u8 = 1 << 2;
pub const FLAG_ZF: u8 = 1 << 3;
pub const FLAG_SF: u8 = 1 << 4;
pub const FLAG_OF: u8 = 1 << 5;
pub const FLAG_ALL: u8 = FLAG_CF | FLAG_PF | FLAG_AF | FLAG_ZF | FLAG_SF | FLAG_OF;

pub(crate) const FLAGS_XOR_DEFINED: u8 = FLAG_CF | FLAG_PF | FLAG_ZF | FLAG_SF | FLAG_OF;
pub(crate) const FLAGS_ARITHMETIC_DEFINED: u8 = FLAG_ALL;
/// SHL leaves AF architecturally undefined, and OF is defined only for a shift count of one.
/// This slice only shifts by 0x10, so neither is claimed.
/// What a shift CLAIMS in `flags_changed` (`arith.rs::shl32`): CF and OF are written into `flags`
/// instead, so they are not claimed; AF is claimed and recomputed from a `last_op1` the shift does
/// not update.
pub(crate) const FLAGS_SHIFT_DEFINED: u8 = FLAG_PF | FLAG_AF | FLAG_ZF | FLAG_SF;
pub(crate) const FLAGS_DEC_DEFINED: u8 = FLAG_PF | FLAG_AF | FLAG_ZF | FLAG_SF | FLAG_OF;

pub(crate) fn k3_dec_flag_recipe() -> FlagRecipe {
    FlagRecipe::Arithmetic {
        instruction: 5,
        operation: FlagOperation::Decrement32,
        lhs: ValueRef::InputGpr(Gpr::Eax),
        rhs: ValueRef::Constant(1),
        result: ValueRef::InstructionResult { instruction: 5 },
        defined: FLAGS_DEC_DEFINED,
        preserved: FLAG_CF,
        preserved_from: Some(PreservedFlags {
            instruction: 4,
            mask: FLAG_CF,
        }),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegisterPart {
    Low8,
    High8,
    Low16,
    Full32,
}

/// Where an edge goes.
///
/// A region whose every branch leaves it is correct and useless: k3's single self-loop could be
/// expressed with exits alone, a real loop cannot. `InRegion` names the instruction index the
/// edge continues at, so control flow the region owns stays inside it and only the edges it does
/// NOT own become statepoints.
///
/// Blocks are deliberately absent. The region is a flat instruction list with an entry, which is
/// enough to express a reducible CFG over indices; a pass that needs real basic blocks should
/// introduce them then, rather than the IR carrying a structure nothing consumes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Continuation {
    InRegion { instruction: u32 },
    Exit(Statepoint),
}

impl Continuation {
    pub const fn statepoint(&self) -> Option<&Statepoint> {
        match self {
            Self::Exit(sp) => Some(sp),
            Self::InRegion { .. } => None,
        }
    }
}

/// The deliberately narrow P1 instruction slice.  Loads and stores both carry an effect token:
/// a load can fault and therefore cannot be reordered past a preceding memory operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opcode {
    Xor32 {
        dst: Gpr,
        src: Gpr,
    },
    CompareMem32Reg {
        address: Address,
        rhs: Gpr,
    },
    SetCondition8 {
        dst: Gpr,
        part: RegisterPart,
        condition: Condition,
    },
    Store32 {
        address: Address,
        src: Gpr,
    },
    Add32Immediate {
        dst: Gpr,
        value: i32,
    },
    /// `mov r32, imm32`.
    Move32Immediate {
        dst: Gpr,
        value: u32,
    },
    /// `mov r32, r32`.
    Move32 {
        dst: Gpr,
        src: Gpr,
    },
    /// `mov r32, [mem]`. Faulting, so it carries an effect token like any other memory operation:
    /// a load is not pure just because its result looks like a value.
    Load32 {
        dst: Gpr,
        address: Address,
    },
    /// `movzx r32, byte [mem]`.
    LoadZeroExtendByte {
        dst: Gpr,
        address: Address,
    },
    /// `add r32, [mem]`.
    Add32Mem {
        dst: Gpr,
        address: Address,
    },
    /// `shl r32, imm8`.
    Shl32Immediate {
        dst: Gpr,
        amount: u8,
    },
    /// `mov dword [mem], imm32`.
    StoreImm32 {
        address: Address,
        value: u32,
    },
    /// `cmp dword [mem], imm32`.
    CompareMem32Imm {
        address: Address,
        value: i32,
    },
    /// `push r32` — decrements ESP and stores. Both halves are architectural: a region that
    /// models the store but not the ESP update produces a frame the guest cannot return through.
    Push32 {
        src: Gpr,
    },
    /// `pop r32`.
    Pop32 {
        dst: Gpr,
    },
    /// `lea r32, [mem]` — the ADDRESS the operand names, never its contents. No memory access,
    /// no flags: a wrapper's stack cleanup is this and nothing else.
    Lea32 {
        dst: Gpr,
        address: Address,
    },
    /// `push imm32`.
    Push32Immediate {
        value: u32,
    },
    /// `call rel32` whose target is INSIDE the region.
    ///
    /// The pushed return address is what makes this different from a jump, and modelling it is
    /// what lets a region cover a wrapper AND the function it calls — which is the difference
    /// between owning a guest page and handing it back at the first `call`. A call whose target
    /// leaves the region is refused rather than approximated: the pushed frame would then be this
    /// region's, and the code that returns through it would not be.
    CallRelative {
        target: Continuation,
        /// The address pushed, i.e. the instruction after the call.
        return_to: u32,
    },
    Decrement32 {
        dst: Gpr,
    },
    BranchIf {
        condition: Condition,
        taken: Continuation,
        fallthrough: Continuation,
    },
    /// Unconditional transfer. A real loop has one, and expressing it as a branch with a constant
    /// condition would hide from every pass that this edge is not a choice.
    Jump {
        target: Continuation,
    },
    /// `ret` / `ret imm16`. The successor is a RUN-TIME value, so this is a terminator that
    /// writes an absolute EIP rather than one that names a continuation.
    ///
    /// Modelling it as an unsupported-instruction boundary instead is not a conservative
    /// simplification, it is a defect: the boundary would set EIP to the `ret`'s own address and
    /// leave, and the engine — which may dispatch to any block head on a page the unit owns —
    /// would re-enter there, leave again, and spin without retiring anything (N28/N30).
    Return {
        pop: u16,
    },
    Exit(Statepoint),
}

impl Opcode {
    /// Every operation that touches guest memory, in either direction. A load belongs here for
    /// the same reason a store does: it can fault, so it cannot be moved across another memory
    /// operation, and it must appear on the effect chain a statepoint reconstructs.
    pub(crate) const fn has_memory_effect(&self) -> bool {
        matches!(
            self,
            Self::CompareMem32Reg { .. }
                | Self::CompareMem32Imm { .. }
                | Self::Store32 { .. }
                | Self::StoreImm32 { .. }
                | Self::Load32 { .. }
                | Self::LoadZeroExtendByte { .. }
                | Self::Add32Mem { .. }
                | Self::Push32 { .. }
                | Self::Push32Immediate { .. }
                | Self::Pop32 { .. }
                // Pushing a return address is a store, and it can fault like any other.
                | Self::CallRelative { .. }
                // The return address is a load, and it can fault like any other.
                | Self::Return { .. }
        )
    }

    pub(crate) const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::BranchIf { .. }
                | Self::Jump { .. }
                | Self::Exit(_)
                | Self::Return { .. }
                | Self::CallRelative { .. }
        )
    }

    pub(crate) const fn writes_flags(&self) -> bool {
        matches!(
            self,
            Self::Xor32 { .. }
                | Self::CompareMem32Reg { .. }
                | Self::CompareMem32Imm { .. }
                | Self::Add32Immediate { .. }
                | Self::Add32Mem { .. }
                | Self::Shl32Immediate { .. }
                | Self::Decrement32 { .. }
        )
    }

    pub(crate) const fn produces_value(&self) -> bool {
        matches!(
            self,
            Self::Xor32 { .. }
                | Self::SetCondition8 { .. }
                | Self::Add32Immediate { .. }
                | Self::Add32Mem { .. }
                | Self::Shl32Immediate { .. }
                | Self::Decrement32 { .. }
                | Self::Move32 { .. }
                | Self::Move32Immediate { .. }
                | Self::Load32 { .. }
                | Self::LoadZeroExtendByte { .. }
                | Self::Pop32 { .. }
                | Self::Lea32 { .. }
        )
    }

    pub(crate) const fn flag_operation(&self) -> Option<(FlagOperation, u8, u8)> {
        match self {
            Self::Xor32 { .. } => Some((FlagOperation::Xor32, FLAGS_XOR_DEFINED, 0)),
            Self::CompareMem32Reg { .. } => {
                Some((FlagOperation::Compare32, FLAGS_ARITHMETIC_DEFINED, 0))
            }
            Self::Add32Immediate { .. } | Self::Add32Mem { .. } => {
                Some((FlagOperation::Add32, FLAGS_ARITHMETIC_DEFINED, 0))
            }
            Self::CompareMem32Imm { .. } => {
                Some((FlagOperation::Compare32, FLAGS_ARITHMETIC_DEFINED, 0))
            }
            // SHL's OF is defined only for a shift count of 1, and its AF is undefined for every
            // count. `Shl32` names that policy rather than reusing an arithmetic recipe whose
            // masks would claim bits the hardware does not define.
            Self::Shl32Immediate { .. } => Some((FlagOperation::Shl32, FLAGS_SHIFT_DEFINED, 0)),
            Self::Decrement32 { .. } => {
                Some((FlagOperation::Decrement32, FLAGS_DEC_DEFINED, FLAG_CF))
            }
            _ => None,
        }
    }
}

/// A local transition.  Tokens are not optimizer hints: verifier acceptance proves a complete
/// state/effect chain, so a future pass must preserve fault and materialization order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction {
    pub guest_eip: u32,
    pub state_in: u32,
    pub state_out: u32,
    pub effect_in: u32,
    pub effect_out: u32,
    pub opcode: Opcode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeDependency {
    pub guest_page: u32,
    pub body_sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Region {
    pub ir_version: u32,
    /// Whether the region maintains the architectural register file at every point, so an exit
    /// needs no reconstruction for GPRs. Conservative lowering (Arm B) does; an optimizing one
    /// (Arm C) does not, and clearing this is what forces every exit to name real SSA values.
    pub keeps_state_canonical: bool,
    /// What the region assumed. Carried, not inferred: a region whose preconditions live only in
    /// the head of whoever built it is a region nothing can revalidate at entry.
    pub envelope: Envelope,
    pub entry_eip: u32,
    pub code_dependencies: Vec<CodeDependency>,
    pub instructions: Vec<Instruction>,
}

impl Region {
    /// Every address an exit can hand control back at.
    ///
    /// A unit OWNS the guest page it is published for, and the engine dispatches at whatever
    /// address it is handed. An exit continuation ON that page which the unit does not serve as
    /// an entry therefore makes the engine compile the page itself, which frees the unit — so
    /// this list is what a publisher checks its entries against.
    pub fn exit_continuations(&self) -> Vec<u32> {
        fn note(out: &mut Vec<u32>, edge: &Continuation) {
            if let Continuation::Exit(point) = edge {
                out.push(point.continuation_eip);
            }
        }
        let mut out = Vec::new();
        for instruction in &self.instructions {
            match &instruction.opcode {
                Opcode::Exit(point) => out.push(point.continuation_eip),
                Opcode::Jump { target } => note(&mut out, target),
                Opcode::CallRelative { target, .. } => note(&mut out, target),
                Opcode::BranchIf { taken, fallthrough, .. } => {
                    note(&mut out, taken);
                    note(&mut out, fallthrough);
                }
                _ => {}
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    pub fn touches_memory(&self) -> bool {
        self.instructions.iter().any(|i| i.opcode.has_memory_effect())
    }

    pub fn stores_to_memory(&self) -> bool {
        self.instructions.iter().any(|i| {
            matches!(
                i.opcode,
                Opcode::Store32 { .. } | Opcode::StoreImm32 { .. } | Opcode::Push32 { .. }
            )
        })
    }
}
