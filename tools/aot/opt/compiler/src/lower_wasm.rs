//! Conservative lowering of a region to a unit module — Arm B.
//!
//! "Conservative" is the whole point: every guest memory access pays a full safe-memory
//! preparation, exactly the shape `codegen.rs::gen_safe_read`/`gen_safe_write` emits, and the
//! architectural register file is maintained at every observable point. Nothing here is supposed
//! to be fast. It exists so the infrastructure cost of the new path can be MEASURED before any
//! pass claims to remove work, and so an optimizing arm has something correct to differ from.
//!
//! The module shape and every exit obligation come from `plan/aot-module-contract.md`; its rule
//! numbers are cited where a choice is not free.

use crate::flag_liveness::FlagFacts;
use crate::scoped_memory::Scope;
use crate::ir::*;
use crate::wasm::{op, EmitError, ModuleBuilder, Unit, T_I32};

/// Fixed linear-memory offsets of guest state (`vendor/v86/src/rust/cpu/global_pointers.rs`,
/// transcribed the same way `tools/aot/lib/abi.mjs` transcribes them).
pub mod g {
    pub const REG32: u32 = 64;
    pub const LAST_OP_SIZE: u32 = 96;
    pub const FLAGS_CHANGED: u32 = 100;
    pub const LAST_OP1: u32 = 104;
    pub const LAST_RESULT: u32 = 112;
    pub const FLAGS: u32 = 120;
    pub const INSTRUCTION_POINTER: u32 = 556;
    pub const PREVIOUS_IP: u32 = 560;
    pub const INSTRUCTION_COUNTER: u32 = 664;
}

/// `cpu/cpu.rs` TLB entry bits.
mod tlb {
    pub const VALID: i32 = 1;
    pub const READONLY: i32 = 2;
    pub const NO_USER: i32 = 4;
    pub const GLOBAL: i32 = 16;
    pub const HAS_CODE: i32 = 32;
}

/// Contract N45: the read mask clears READONLY, GLOBAL and HAS_CODE.
const fn tlb_read_mask(cpl3: bool) -> i32 {
    0xfff & !tlb::READONLY & !tlb::GLOBAL & !tlb::HAS_CODE & !(if cpl3 { 0 } else { tlb::NO_USER })
}

/// Contract N46: the write mask keeps READONLY and HAS_CODE live, so a read-only or code-bearing
/// page always takes the slow path — which is what performs `jit_dirty_page`. The per-store guard
/// IS the SMC net, and widening this mask to match the read one would remove it.
const fn tlb_write_mask(cpl3: bool) -> i32 {
    0xfff & !tlb::GLOBAL & !(if cpl3 { 0 } else { tlb::NO_USER })
}

/// EFLAGS bit values (`cpu/cpu.rs`).
pub mod flag {
    pub const CARRY: i32 = 1;
    pub const PARITY: i32 = 4;
    pub const ADJUST: i32 = 16;
    pub const ZERO: i32 = 64;
    pub const SIGN: i32 = 128;
    pub const OVERFLOW: i32 = 2048;
    pub const ALL: i32 = CARRY | PARITY | ADJUST | ZERO | SIGN | OVERFLOW;
    /// Bit 31 of `flags_changed`. SEMANTIC, not a flag position (contract N33): it tells v86 the
    /// lazy operation was a SUBTRACTION. Without it, AF and CF are recomputed with the addition
    /// formulas and silently disagree — the guest sees wrong flags from a correct result.
    pub const SUB: i32 = -0x8000_0000;
}

const L_EXIT: &str = "exit";
const L_FAULT: &str = "exit_with_fault";
const L_MAIN: &str = "main_loop";
const L_DEFAULT: &str = "brtable_default";

/// `cpu.rs` LOOP_COUNTER: the engine's own slice bound, which a unit may not exceed.
const LOOP_COUNTER: i32 = 100_003;

/// Local numbering. Local 0 is the entry index and the dispatcher variable (contract N5).
struct Locals {
    gpr: [u32; 8],
    counter: u32,
    addr: u32,
    value: u32,
    tlb: u32,
    lhs: u32,
    rhs: u32,
    result: u32,
    parity: u32,
    /// Scope guard scratch: whether every range proved, and the page cursor it walks.
    scope_ok: u32,
    scope_page: u32,
    scope_last: u32,
    /// v86's lazy flag state, held in locals between the points that can observe it.
    ///
    /// These mirror the engine's own `flag_locals` (wasm_builder.rs) one for one, in its slot
    /// order, and carry the same values — this is not a different representation, it is the same
    /// five words living somewhere cheaper until something can read them.
    tuple: [u32; 5],
    /// A PRIVATE materialized copy of the six flags.
    ///
    /// Guest-visible flags stay in v86's lazy representation, because the differential compares
    /// the raw tuple and not only what `get_eflags()` would return. Reading a condition back out
    /// of that representation means re-deriving OF and AF from `last_op1`/`last_result` at every
    /// branch; keeping a shadow computed from the same values costs a local and cannot disagree
    /// with what was stored, since both come from the same operands.
    flags: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LowerError {
    Emit(EmitError),
    /// The lowering does not model this opcode yet. Named rather than skipped: a lowering that
    /// silently omits an instruction produces a unit that is wrong exactly where it is quiet.
    UnsupportedOpcode(String),
    /// A region shape this lowering does not handle — a loop, for now.
    UnsupportedShape(&'static str),
    /// One guest instruction's lowering did not consume everything it pushed.
    LeftOperandsBehind { guest_eip: u32, depth: i32 },
}

impl From<EmitError> for LowerError {
    fn from(e: EmitError) -> Self {
        Self::Emit(e)
    }
}

impl std::fmt::Display for LowerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Emit(e) => write!(f, "{e}"),
            Self::UnsupportedOpcode(o) => write!(f, "lowering does not model {o}"),
            Self::UnsupportedShape(s) => write!(f, "lowering does not handle {s}"),
            Self::LeftOperandsBehind { guest_eip, depth } => write!(
                f, "the instruction at 0x{guest_eip:x} left {depth} operand(s) on the stack"),
        }
    }
}

impl std::error::Error for LowerError {}

pub struct Lowered {
    pub unit: Unit,
    /// The counter delta each exit declares. There is no single "per entry" number — a region
    /// with several exits credits a different amount on each — so they are listed rather than
    /// collapsed into one that would be right for only some paths.
    pub exit_deltas: Vec<u32>,
    /// Every address the engine may dispatch to, paired with the dispatcher index that serves it.
    ///
    /// A unit OWNS the guest page it covers. If the engine dispatches to an address on that page
    /// the unit does not claim, it compiles the page itself and the owning module is freed — the
    /// unit then stops running mid-workload while still looking published. So every block head is
    /// declared, not only the entry: the block heads are exactly the addresses in-region control
    /// flow can resume at.
    pub entries: Vec<(u32, u32)>,
    /// Block heads deliberately NOT offered as entries, because entering there retires nothing:
    /// the block begins with a boundary `Exit`, so the unit would set EIP to the address it was
    /// entered at and leave. The engine would dispatch there again, enter again, and leave again
    /// — the host loop N28/N30 name, which burns a core without advancing the guest and is
    /// indistinguishable from a merely slow unit.
    pub unclaimable_entries: Vec<u32>,
}

/// Optimizing passes, each behind its own switch.
///
/// They are ABLATION ARMS, not the conservative lowering's behaviour: an arm exists so the cost
/// of one bucket can be measured on its own, and a build that reports a speedup must say which
/// of them produced it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Passes {
    /// Materialize into the private shadow only the flag bits an in-region condition can read.
    pub flag_liveness: bool,
    /// Prove a bounded loop memory obligations once, at its entry, and translate without asking
    /// again inside it. The mechanism, not an ablation: it removes work by discharging the same
    /// obligations earlier, and it keeps a guarded copy of the loop for when it cannot.
    pub scoped_memory: bool,
    /// Drop a lazy-flag publication that nothing can observe before it is overwritten.
    ///
    /// The tuple is guest-visible at exactly two places: an exit, and a fault inside the region.
    /// A store the next flag writer overwrites before either can happen is dead. What makes this
    /// worth having is the scope: inside a PROVEN range an access CANNOT fault, so it is not an
    /// observation point — the memory proof is what turns these stores dead.
    pub dead_flag_stores: bool,
    /// Keep v86's lazy flag words in Wasm locals, publishing them only where they can be read.
    ///
    /// Distinct from `dead_flag_stores`, which removes publications whose VALUE nobody needs.
    /// This one keeps every value and moves only the STORE: the tuple is guest-visible at an exit,
    /// at a fault, and inside any helper that reads guest state — and the memory helpers this
    /// slice calls are none of those. The engine says so itself: its own JIT keeps these five in
    /// locals and spills them around every call except `safe_read*`/`safe_write*`/`report_*`
    /// (`wasm_builder.rs::flag_spill_whitelisted`), because the slow path "doesn't trigger the
    /// interrupt, as registers are still stored in the wasm module" (`cpu.rs`).
    pub flags_in_locals: bool,
    /// DIAGNOSTIC, never a gain: emit no lazy flag state at all.
    ///
    /// Every flag-writing instruction owes v86 four stores (`last_op1`, `last_result`,
    /// `last_op_size`, `flags_changed`) plus whatever `flags` it must materialize. This arm drops
    /// all of it, which is WRONG for any guest that reads a flag afterwards — its only job is to
    /// say how much of a unit's time is the flag representation rather than the work.
    pub unguarded_flags_diagnostic: bool,
    /// DIAGNOSTIC, never a gain: translate each access through the TLB but perform NO validity,
    /// permission or page-crossing check, and provide no fault path.
    ///
    /// This is arm D of the plan — the compute-cost reference that says how much of a unit time
    /// is memory preparation rather than work. A unit built with it is WRONG for any access that
    /// would fault, so it is stamped as a diagnostic and refused as an ordinary artifact.
    pub unguarded_memory_diagnostic: bool,
}

impl Passes {
    /// Whether any enabled pass makes the unit a diagnostic rather than a candidate.
    pub fn is_diagnostic(&self) -> bool {
        self.unguarded_memory_diagnostic || self.unguarded_flags_diagnostic
    }

    pub fn parse(list: &str) -> Result<Self, String> {
        let mut passes = Self::default();
        for name in list.split(',').map(str::trim).filter(|n| !n.is_empty()) {
            match name {
                "flag-liveness" => passes.flag_liveness = true,
                "scoped-memory" => passes.scoped_memory = true,
                "unguarded-memory-diagnostic" => passes.unguarded_memory_diagnostic = true,
                "unguarded-flags-diagnostic" => passes.unguarded_flags_diagnostic = true,
                "dead-flag-stores" => passes.dead_flag_stores = true,
                "flags-in-locals" => passes.flags_in_locals = true,
                other => return Err(format!("unknown pass '{other}'")),
            }
        }
        Ok(passes)
    }

    pub fn names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.flag_liveness {
            names.push("flag-liveness");
        }
        if self.scoped_memory {
            names.push("scoped-memory");
        }
        if self.unguarded_memory_diagnostic {
            names.push("unguarded-memory-diagnostic");
        }
        if self.unguarded_flags_diagnostic {
            names.push("unguarded-flags-diagnostic");
        }
        if self.dead_flag_stores {
            names.push("dead-flag-stores");
        }
        if self.flags_in_locals {
            names.push("flags-in-locals");
        }
        names
    }
}

/// How one memory access asks the TLB for its page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccessForm {
    /// The engine own inline shape: validity, permission and page-crossing checked per access,
    /// with the slow helper as the miss and fault path.
    Guarded,
    /// Inside a proven scope: the entry was checked once, for every page the loop can reach, so
    /// the access only translates.
    Proven,
    /// Arm D: fill on a miss, then use the entry without checking what it says.
    UncheckedDiagnostic,
}

/// One block of the emitted dispatcher.
enum Emit {
    /// Guest instructions `first..last_exclusive`, with the given access form.
    Guest { first: usize, last_exclusive: usize, form: AccessForm },
    /// The scope guard: no guest instruction, no counter credit. It checks every page the loop
    /// can reach and hands control to the proven copy, or to the guarded one when it cannot.
    ScopeGuard { head: usize },
}

impl Emit {
    fn covers(&self, index: usize) -> bool {
        matches!(self, Self::Guest { first, last_exclusive, .. }
            if index >= *first && index < *last_exclusive)
    }

    fn form(&self) -> AccessForm {
        match self {
            Self::Guest { form, .. } => *form,
            Self::ScopeGuard { .. } => AccessForm::Guarded,
        }
    }
}

/// Lower a straight-line region: one entry, no in-region back edge.
///
/// A looping region needs the dispatcher shape (N15) so a back edge becomes `set_local 0;
/// br main_loop`; that is the next slice, and it is refused here rather than mis-emitted.
pub fn lower_region(region: &Region, cpl3: bool) -> Result<Lowered, LowerError> {
    lower_region_with_bound(region, cpl3, LOOP_COUNTER)
}

/// As `lower_region`, with an explicit loop bound.
///
/// Production is `LOOP_COUNTER`. A test that wants the bound to actually FIRE inside a short
/// kernel lowers it — and must DECLARE the same value in the manifest, so a lowered bound is a
/// visible property of the artifact rather than a silent one.
pub fn lower_region_with_bound(
    region: &Region,
    cpl3: bool,
    loop_bound: i32,
) -> Result<Lowered, LowerError> {
    lower_region_with(region, cpl3, loop_bound, Passes::default())
}

/// As `lower_region_with_bound`, with named optimizing passes enabled.
pub fn lower_region_with(
    region: &Region,
    cpl3: bool,
    loop_bound: i32,
    passes: Passes,
) -> Result<Lowered, LowerError> {
    NO_FLAGS.with(|f| f.set(passes.unguarded_flags_diagnostic));
    IN_LOCALS.with(|f| f.set(passes.flags_in_locals));
    DEAD_TUPLE.with(|d| d.replace(Vec::new()));
    let blocks = form_blocks(region);
    if region.instructions.iter().all(|i| matches!(i.opcode, Opcode::Exit(_))) {
        // Every path would return crediting nothing, and a zero delta is not a slow path (N30).
        return Err(LowerError::UnsupportedShape("a region that executes no instruction"));
    }
    if blocks.len() > MAX_BLOCKS {
        return Err(LowerError::UnsupportedShape("a region with more blocks than the dispatcher nests"));
    }

    // The shadow flag word starts at zero on every activation, so a bit READ before it is
    // written in that activation would answer from state this entry never established. That is a
    // property of the shape, not of the pass, so it is refused whether or not liveness is on.
    let facts = FlagFacts::of(region);
    for block in &blocks {
        // Only CONDITION reads are refused here. A materialization read takes a bit the tuple does
        // not claim, and the prologue seeded exactly those correctly from `flags`.
        let live = facts.condition_live_before[block.first];
        if live != 0 {
            return Err(LowerError::UnsupportedShape(
                "an entry whose condition reads flags no instruction in the region sets",
            ));
        }
    }

    // The scope, when the pass is on and the loop is one this MVP can prove about. A region with
    // no scope emits exactly what it emitted before.
    let scope = if passes.scoped_memory { Scope::of(region) } else { None };
    let scope = scope.filter(|scope| {
        // The loop must start at a block head — the guard takes that block's dispatcher index —
        // and every block it spans must lie wholly inside it. A partly copied loop would be a
        // loop with two different sets of obligations.
        blocks.iter().any(|b| b.first == scope.head as usize)
            && blocks.iter().all(|b| {
                let overlaps = b.first <= scope.latch as usize && b.last_exclusive > scope.head as usize;
                !overlaps
                    || (b.first >= scope.head as usize && b.last_exclusive <= scope.latch as usize + 1)
            })
    });

    let base_form = if passes.unguarded_memory_diagnostic {
        AccessForm::UncheckedDiagnostic
    } else {
        AccessForm::Guarded
    };
    // The GUARD takes the loop head own dispatcher index, and the two copies of the loop go after
    // every base block. That is not cosmetic: the engine published entry value must be smaller
    // than the number of entries (contract B6), so an entry cannot name an index appended past
    // them — but it can name one whose block is now the guard.
    let mut emits: Vec<Emit> = blocks
        .iter()
        .map(|b| match &scope {
            Some(scope) if b.first == scope.head as usize =>
                Emit::ScopeGuard { head: scope.head as usize },
            _ => Emit::Guest { first: b.first, last_exclusive: b.last_exclusive, form: base_form },
        })
        .collect();
    let guard_index = emits
        .iter()
        .position(|e| matches!(e, Emit::ScopeGuard { .. }))
        .unwrap_or(0);
    let mut proven_index = 0;
    if let Some(scope) = &scope {
        // The head block became the guard, so a GUARDED copy of it is appended for the decline
        // path; the loop's other blocks are still in the base list and are already guarded.
        let head_block = blocks
            .iter()
            .find(|b| b.first == scope.head as usize)
            .expect("the filter above required one");
        emits.push(Emit::Guest {
            first: head_block.first,
            last_exclusive: head_block.last_exclusive,
            form: base_form,
        });
        // Then a PROVEN copy of every block the loop spans, in order, so an edge inside the loop
        // can stay inside the proven copies.
        proven_index = emits.len();
        for block in blocks.iter().filter(|b| {
            b.first >= scope.head as usize && b.last_exclusive <= scope.latch as usize + 1
        }) {
            emits.push(Emit::Guest {
                first: block.first,
                last_exclusive: block.last_exclusive,
                form: AccessForm::Proven,
            });
        }
    }
    if emits.len() > MAX_BLOCKS {
        return Err(LowerError::UnsupportedShape("a region with more blocks than the dispatcher nests"));
    }

    // Deadness is a property of the COPY, not of the instruction. Inside the proven copy an access
    // cannot fault and therefore observes nothing; inside the guarded copy the same access can
    // fault and does observe. One answer for both publishes the wrong tuple exactly where a fault
    // reads it — which is what the fault rows of the continuation gate reported.
    let dead_proven = if passes.dead_flag_stores {
        dead_tuple_stores(region, scope.as_ref())
    } else {
        Vec::new()
    };
    let dead_guarded = if passes.dead_flag_stores {
        dead_tuple_stores(region, None)
    } else {
        Vec::new()
    };

    let mut b = ModuleBuilder::new();

    let locals = Locals {
        gpr: std::array::from_fn(|_| b.local(T_I32)),
        counter: b.local(T_I32),
        addr: b.local(T_I32),
        value: b.local(T_I32),
        tlb: b.local(T_I32),
        lhs: b.local(T_I32),
        rhs: b.local(T_I32),
        result: b.local(T_I32),
        parity: b.local(T_I32),
        scope_ok: b.local(T_I32),
        scope_page: b.local(T_I32),
        scope_last: b.local(T_I32),
        tuple: std::array::from_fn(|_| b.local(T_I32)),
        flags: b.local(T_I32),
    };

    // ── prologue (N12/N24): the ONLY place locals are seeded, unconditional, before any label ──
    for i in 0..8 {
        b.load_fixed(g::REG32 + (i as u32) * 4);
        b.local_set(locals.gpr[i]);
    }
    b.const_i32(0).local_set(locals.counter);
    // Seed the shadow from the guest's `flags`.
    //
    // The shadow is this activation's materialized view. For a bit the lazy tuple does not claim,
    // `flags` already holds the right value — that is where the guest reads it from — so starting
    // at zero would make the first operation that PRESERVES such a bit write a zero over it.
    // Bits the tuple does claim are stale here and are refused as live-in instead (a condition
    // that reads one before anything recomputes it is a branch on a stale flag).
    seed_flag_state(&mut b, &locals);
    tuple_get(&mut b, &locals, FlagWord::Flags);
    b.local_set(locals.flags);

    // ── label nesting (N13/B2): block(exit) / block(exit_with_fault) / loop(main) /
    //    block(brtable_default) ──────────────────────────────────────────────────────────────
    b.block(L_EXIT);
    b.block(L_FAULT);
    b.loop_(L_MAIN);

    // N18/B7: a loop head is bounded by the retired counter, so a unit can never spin past the
    // engine's own slice bound. The guard cannot itself produce a zero-delta exit: the counter is
    // zero at every entry and the test is `>=`, so it only fires on a path that already retired
    // that many instructions.
    b.local_get(locals.counter);
    b.const_i32(loop_bound);
    b.u8(op::I32_GE_U);
    b.br_if_to(L_EXIT)?;

    // ── dispatcher (N15/N16) ──────────────────────────────────────────────────────────────
    // Local 0 selects a block; every in-region edge sets it and re-enters the loop (N14). One
    // `block` per basic block, nested so `br_table` can name each, with `brtable_default` as the
    // outermost of them: an index nothing covers ends there and leaves, which is what makes an
    // unexpected entry index safe rather than a jump into another block's code.
    b.block(L_DEFAULT);
    for label in BLOCK_LABELS.iter().take(emits.len()) {
        b.block(label);
    }
    b.local_get(0);
    // Case `i` is relative depth `i`. The blocks are opened outermost-first, so the innermost
    // label is the one whose `end` is emitted first — and a `br` lands AFTER that `end`, which is
    // where block 0's code begins. Reversing this mapping produces a unit that dispatches every
    // index to the wrong block: valid Wasm, contract-conforming, and wrong in a way only a
    // differential can see.
    let cases: Vec<u32> = (0..emits.len() as u32).collect();
    b.br_table(&cases, emits.len() as u32);

    for bi in 0..emits.len() {
        b.end()?;   // closes this block's label; its code follows
        let (first, last_exclusive, form) = match &emits[bi] {
            Emit::Guest { first, last_exclusive, form } => (*first, *last_exclusive, *form),
            Emit::ScopeGuard { .. } => {
                let scope = scope.as_ref().expect("a guard block exists only with a scope");
                emit_scope_guard(&mut b, &locals, region, scope, cpl3, &emits,
                    proven_index, guard_index)?;
                continue;
            }
        };
        let block = Block { first, last_exclusive };
        // Credit instructions that have ALREADY retired, not a whole block up front.
        //
        // v86's JIT credits a whole basic block before its body, but its blocks are not ours, and
        // at a fault the counter must be the engine's exact value (plan §4.2). Measured: crediting
        // this block up front reported 5 instructions too many on a fault at the second body
        // instruction. So the credit is deferred to just before each FAULTABLE instruction — a
        // fault there sees only what ran — and the remainder is credited when the block ends.
        let mut pending = 0i32;
        let credit = |b: &mut ModuleBuilder, pending: &mut i32| {
            if *pending > 0 {
                b.local_get(locals.counter);
                b.const_i32(*pending);
                b.u8(op::I32_ADD);
                b.local_set(locals.counter);
                *pending = 0;
            }
        };
        for index in block.first..block.last_exclusive {
            let instruction = &region.instructions[index];
            // A boundary `Exit` stands in for an instruction the baseline executes, so it never
            // counts; everything else does.
            let retires = !matches!(instruction.opcode, Opcode::Exit(_));
            if instruction.opcode.is_terminal() {
                // A terminator LEAVES, so everything owed — including the terminator itself when
                // it retires — must be credited before it. Crediting after would emit into code
                // no path reaches, and the instructions would simply never be counted.
                if retires {
                    pending += 1;
                }
                credit(&mut b, &mut pending);
            } else if instruction.opcode.has_memory_effect() {
                // It may fault, and v86 counts the FAULTING instruction: the interpreter
                // increments before executing and commits at the loop exit (`cpu.rs`), so the
                // engine counter at a #PF includes the access that took it. Measured: excluding
                // it left the unit exactly one short of the baseline at every fault scenario.
                //
                // This is the ENGINE counter's convention, not the logical-work ledger's — the
                // plan keeps those apart precisely because they disagree here.
                pending += 1;
                credit(&mut b, &mut pending);
            }
            // Bits nothing can read need not be computed. With the pass off the mask is the
            // full word, which is the conservative behaviour bit for bit.
            let demanded = if passes.flag_liveness { facts.demanded_after[index] } else { !0 };
            // Inside the proven copy, only the accesses the scope actually PROVED lose their
            // guard. A loop can have a frame slot at a fixed address next to a pointer walked by
            // a stride nobody knows; proving the first says nothing about the second, and giving
            // them one answer would be the whole point of a proof thrown away.
            AT.with(|a| a.set(index));
            let access = match form {
                AccessForm::Proven if !scope.as_ref().is_some_and(|s| s.proves(index)) => {
                    AccessForm::Guarded
                }
                other => other,
            };
            DEAD_TUPLE.with(|d| {
                let from = if access == AccessForm::Proven { &dead_proven } else { &dead_guarded };
                d.replace(from.clone())
            });
            lower_instruction(&mut b, &locals, instruction, cpl3, region, demanded,
                facts.materialize[index], access, &emits, bi, guard_index)?;
            if !instruction.opcode.is_terminal() && retires && !instruction.opcode.has_memory_effect() {
                pending += 1;
            }
            // Each guest instruction lowers to a self-contained sequence, so the operand stack
            // must be empty between them. Checking here names the instruction that left something
            // behind instead of surfacing as a depth mismatch at the enclosing label.
            if b.stack_depth() != 0 {
                return Err(LowerError::LeftOperandsBehind {
                    guest_eip: instruction.guest_eip,
                    depth: b.stack_depth(),
                });
            }
        }
        // A block whose last instruction is not a terminator falls into the next one. Expressing
        // that as an explicit re-dispatch keeps every edge one shape, so a pass that rewires
        // control flow has nothing implicit to preserve.
        credit(&mut b, &mut pending);
        if !region.instructions[block.last_exclusive - 1].opcode.is_terminal() {
            redispatch(&mut b, &locals, region, block.last_exclusive, &emits, bi, guard_index)?;
        }
    }
    b.end()?;   // block(brtable_default)
    // N16: an index no case covers leaves rather than running block 0 under another name.
    b.br_to(L_EXIT)?;

    b.end()?;   // loop
    b.end()?;   // block(exit_with_fault)

    // ── fault epilogue ────────────────────────────────────────────────────────────────────────
    // Reached only by `br $exit_with_fault` out of a slow helper that reported a fault. The
    // register file is flushed BEFORE `trigger_fault_end_jit` (N19/B4b) because that helper reads
    // guest state, and EIP is already correct — no epilogue writes it (N25).
    publish_flag_state(&mut b, &locals);
    flush_registers(&mut b, &locals);
    let fault_end = b.import("trigger_fault_end_jit", "v_v")?;
    b.call(fault_end);
    fold_counter(&mut b, &locals);
    account_retired(&mut b, &locals)?;
    b.u8(op::RETURN);

    b.end()?;   // block(exit)

    // ── normal epilogue ───────────────────────────────────────────────────────────────────────
    // Falling off the end returns, so no explicit `return` is emitted; the accounting call is
    // still last, which is what keeps the two epilogues the same shape.
    flush_registers(&mut b, &locals);
    publish_flag_state(&mut b, &locals);
    fold_counter(&mut b, &locals);
    account_retired(&mut b, &locals)?;

    let exit_deltas = region
        .instructions
        .iter()
        .flat_map(|i| match &i.opcode {
            Opcode::Exit(p) => vec![p.accounting_delta],
            Opcode::BranchIf { taken, fallthrough, .. } => [taken, fallthrough]
                .iter()
                .filter_map(|e| e.statepoint().map(|p| p.accounting_delta))
                .collect(),
            Opcode::Jump { target } => target.statepoint().map(|p| p.accounting_delta).into_iter().collect(),
            _ => Vec::new(),
        })
        .filter_map(|d| match d {
            AccountingDelta::Fixed(n) => Some(n),
            AccountingDelta::Retired => None,
        })
        .collect();
    let mut entries = Vec::new();
    let mut unclaimable_entries = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let head = &region.instructions[block.first];
        if matches!(head.opcode, Opcode::Exit(_)) {
            unclaimable_entries.push(head.guest_eip);
            continue;
        }
        // A dispatch to the loop head lands on the GUARD, which occupies that index: the proof is
        // what makes the proven copy legal, and an entry that skipped it would run unchecked
        // accesses on pages nobody looked at.
        entries.push((head.guest_eip, index as u32));
    }
    // Block 0 is the region's own entry. If it retires nothing the engine enters, leaves with EIP
    // unchanged, and enters again — forever.
    if !entries.first().is_some_and(|(eip, _)| *eip == region.entry_eip) {
        return Err(LowerError::UnsupportedShape(
            "a region whose entry retires nothing before leaving",
        ));
    }
    Ok(Lowered { unit: b.finish()?, exit_deltas, entries, unclaimable_entries })
}

/// How many basic blocks the dispatcher can nest. Wasm allows far more; this bound exists so a
/// region that would produce an unreadable amount of nesting is refused rather than emitted.
const MAX_BLOCKS: usize = 32;

/// Static labels for the nested dispatch blocks. `&static str` is what the builder tracks, so
/// they are a table rather than formatted names.
const BLOCK_LABELS: [&str; MAX_BLOCKS] = [
    "b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10", "b11", "b12", "b13", "b14",
    "b15", "b16", "b17", "b18", "b19", "b20", "b21", "b22", "b23", "b24", "b25", "b26", "b27",
    "b28", "b29", "b30", "b31",
];

/// One basic block: a half-open range of instruction indices.
struct Block {
    first: usize,
    last_exclusive: usize,
}

/// Split the region at every branch target and after every terminator.
///
/// An instruction is a block head if it is the entry, or if some edge names it. Anything else
/// would let a `br_table` case land mid-block, which is a jump into the middle of a sequence that
/// assumed its own prefix ran.
fn form_blocks(region: &Region) -> Vec<Block> {
    let mut heads = vec![false; region.instructions.len()];
    heads[0] = true;
    for (index, instruction) in region.instructions.iter().enumerate() {
        let mut note = |edge: &Continuation| {
            if let Continuation::InRegion { instruction: target } = edge {
                if (*target as usize) < heads.len() {
                    heads[*target as usize] = true;
                }
            }
        };
        match &instruction.opcode {
            Opcode::Jump { target } => note(target),
            Opcode::CallRelative { target, .. } => note(target),
            Opcode::BranchIf { taken, fallthrough, .. } => {
                note(taken);
                note(fallthrough);
            }
            _ => {}
        }
        // The instruction after a terminator starts a block: nothing falls into it.
        if instruction.opcode.is_terminal() && index + 1 < heads.len() {
            heads[index + 1] = true;
        }
    }
    let mut blocks = Vec::new();
    let mut first = 0usize;
    for index in 1..=region.instructions.len() {
        if index == region.instructions.len() || heads[index] {
            blocks.push(Block { first, last_exclusive: index });
            first = index;
        }
    }
    blocks
}

/// Which block serves an edge to `target`, given where the edge comes from.
///
/// An edge inside the proven copy stays there — that is the whole point of the copy — while an
/// edge that ENTERS the scope from outside goes through the guard, because nothing has proven
/// anything yet on that path.
fn target_block(emits: &[Emit], target: usize, from: usize, guard_index: usize) -> Option<u32> {
    let scope_head = emits.iter().find_map(|e| match e {
        Emit::ScopeGuard { head } => Some(*head),
        Emit::Guest { .. } => None,
    });
    // An edge from inside the proven copies that lands in one of them stays proven — that is what
    // the copies are for. A loop of several blocks needs the whole set searched, not just the
    // block the edge came from.
    if emits.get(from).is_some_and(|e| e.form() == AccessForm::Proven) {
        if let Some(i) = emits
            .iter()
            .position(|e| e.form() == AccessForm::Proven && e.covers(target))
        {
            return Some(i as u32);
        }
    }
    // Entering the scope from anywhere else goes through the guard, because nothing has been
    // proven on that path yet. The one exception is the guard own decline edge, which names the
    // guarded copy directly.
    if scope_head == Some(target) && !matches!(emits.get(from), Some(Emit::Guest { form, .. })
        if *form == AccessForm::Guarded && emits[from].covers(target))
    {
        return Some(guard_index as u32);
    }
    emits
        .iter()
        .position(|e| e.covers(target) && e.form() != AccessForm::Proven)
        .map(|i| i as u32)
}


/// In-module re-dispatch (N14): materialize EIP, select the block, re-enter the loop.
///
/// EIP first is not decoration — the loop's bound (B7) and the default arm can both leave from
/// here, and no epilogue writes EIP (N25), so a re-dispatch with a stale one resumes the guest at
/// the wrong address.
fn redispatch(
    b: &mut ModuleBuilder,
    _locals: &Locals,
    region: &Region,
    target_index: usize,
    emits: &[Emit],
    from: usize,
    guard_index: usize,
) -> Result<(), LowerError> {
    let block = target_block(emits, target_index, from, guard_index)
        .ok_or(LowerError::UnsupportedShape("an edge to an index outside every block"))?;
    // LOW BITS ONLY (`codegen.rs::gen_set_eip_low_bits`). An absolute write would replace the
    // page too, and the slow memory helpers reconstruct an address by OR-ing a compile-time low
    // 12 bits onto whatever page `instruction_pointer` names — so a re-dispatch that rewrote the
    // page would send the next fault to the wrong one.
    let low = (region.instructions[target_index].guest_eip & 0xfff) as i32;
    b.store_fixed(g::INSTRUCTION_POINTER, |b| {
        b.load_fixed(g::INSTRUCTION_POINTER);
        b.const_i32(!0xfff);
        b.u8(op::I32_AND);
        b.const_i32(low);
        b.u8(op::I32_OR);
    });
    b.const_i32(block as i32);
    b.local_set(0);
    b.br_to(L_MAIN)?;
    Ok(())
}

/// Contract N21: eight aligned stores of the register locals back to `reg32`.
fn flush_registers(b: &mut ModuleBuilder, locals: &Locals) {
    for i in 0..8 {
        let local = locals.gpr[i];
        b.store_fixed(g::REG32 + (i as u32) * 4, |b| {
            b.local_get(local);
        });
    }
}

/// Contract N28/N30: every exit folds the module's counter local into `instruction_counter`.
/// A unit that returns without bumping it is an infinite host loop in release, not a slow path.
fn fold_counter(b: &mut ModuleBuilder, locals: &Locals) {
    let counter = locals.counter;
    b.store_fixed(g::INSTRUCTION_COUNTER, |b| {
        b.load_fixed(g::INSTRUCTION_COUNTER);
        b.local_get(counter);
        b.u8(op::I32_ADD);
    });
}

/// Tell the engine how much this activation retired, so tier-2 accounting sees AOT work.
/// Exactly two of these exist — one per epilogue — and each is fed by the counter local.
fn account_retired(b: &mut ModuleBuilder, locals: &Locals) -> Result<(), LowerError> {
    let helper = b.import("jit_tier2_note_aot_retired", "i_v")?;
    b.local_get(locals.counter);
    b.call(helper);
    Ok(())
}

/// Push the six flag bits for a SUBTRACTION of `rhs` from `lhs` giving `result`, OR-ed together.
///
/// The deadness vector, for reporting. Same computation the lowering uses.
pub fn dead_flag_publications(region: &Region, with_scope: bool) -> Vec<bool> {
    let scope = if with_scope { Scope::of(region) } else { None };
    dead_tuple_stores(region, scope.as_ref())
}

/// Which flag-tuple publications nothing can observe before they are overwritten.
///
/// Backward over the region's own edges. An instruction OBSERVES the tuple if it can leave — a
/// terminator — or if it can fault, because a fault is an exit that publishes guest state. An
/// access inside a PROVEN range cannot fault, so it observes nothing; that is the whole reason
/// this pass has anything to remove.
///
/// An instruction that both faults and writes flags (`cmp [mem], reg`) observes the PREVIOUS
/// tuple before writing its own, so it counts as an observation for whoever came before it.
fn dead_tuple_stores(region: &Region, scope: Option<&Scope>) -> Vec<bool> {
    let n = region.instructions.len();
    // `safe[i]`: every path from i overwrites the tuple before anything observes it.
    let mut safe = vec![false; n];
    let mut changed = true;
    while changed {
        changed = false;
        for index in (0..n).rev() {
            let opcode = &region.instructions[index].opcode;
            let observes = opcode.is_terminal()
                || (opcode.has_memory_effect() && !scope.is_some_and(|s| s.proves(index)));
            let value = if observes {
                false
            } else if overwrites_whole_tuple(opcode) {
                true
            } else {
                successors(region, index).map_or(false, |ss| {
                    !ss.is_empty() && ss.into_iter().all(|s| safe[s])
                })
            };
            if value != safe[index] {
                safe[index] = value;
                changed = true;
            }
        }
    }
    (0..n)
        .map(|index| {
            region.instructions[index].opcode.flag_operation().is_some()
                && successors(region, index)
                    .map_or(false, |ss| !ss.is_empty() && ss.into_iter().all(|s| safe[s]))
        })
        .collect()
}

/// Whether this operation republishes EVERY field of the lazy tuple.
///
/// A shift does not: `arith.rs::shl32` writes `last_result`, `last_op_size` and `flags_changed`
/// and deliberately leaves `last_op1` alone, so the guest recomputes AF from the PREVIOUS
/// operation's operand. A publication "overwritten" by a shift is therefore only PARTLY
/// overwritten, and dropping it leaves `last_op1` a whole operation behind — one bit of AF, which
/// is exactly what the fault rows reported.
fn overwrites_whole_tuple(opcode: &Opcode) -> bool {
    opcode.flag_operation().is_some() && !matches!(opcode, Opcode::Shl32Immediate { .. })
}

/// In-region successors, or `None` when an edge leaves (which is an observation).
fn successors(region: &Region, index: usize) -> Option<Vec<usize>> {
    let mut out = Vec::new();
    let mut edge = |c: &Continuation| match c {
        Continuation::InRegion { instruction } => {
            out.push(*instruction as usize);
            true
        }
        Continuation::Exit(_) => false,
    };
    let ok = match &region.instructions[index].opcode {
        Opcode::Exit(_) | Opcode::Return { .. } => false,
        Opcode::Jump { target } => edge(target),
        Opcode::CallRelative { target, .. } => edge(target),
        Opcode::BranchIf { taken, fallthrough, .. } => {
            let a = edge(taken);
            let b = edge(fallthrough);
            a && b
        }
        _ if index + 1 < region.instructions.len() => {
            out.push(index + 1);
            true
        }
        _ => false,
    };
    if ok { Some(out) } else { None }
}

/// Whether the publication for the instruction being lowered is dead.
fn tuple_is_dead() -> bool {
    let at = AT.with(|a| a.get());
    DEAD_TUPLE.with(|d| d.borrow().get(at).copied().unwrap_or(false))
}

thread_local! {
    /// Set for the duration of one lowering when the flags-diagnostic arm is on. A parameter would
    /// have to reach a dozen emitters that have nothing else to do with it; this is a diagnostic
    /// switch, and it is read in exactly two places.
    static NO_FLAGS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Whether the lazy tuple lives in locals for this lowering.
    static IN_LOCALS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Per-instruction deadness for the current lowering, empty when the pass is off.
    static DEAD_TUPLE: std::cell::RefCell<Vec<bool>> = const { std::cell::RefCell::new(Vec::new()) };
    /// The instruction being lowered, so the tuple emitter can consult the vector above.
    static AT: std::cell::Cell<usize> = const { std::cell::Cell::new(usize::MAX) };
}

/// How a flag word is built: one term per LIVE bit, OR-ed together.
///
/// Terms rather than one fixed expression, because a bit nothing can read costs the same to
/// compute as one that matters — and PF alone is a seven-instruction fold. Which bits are live
/// comes from `FlagFacts`; with the pass off, every bit is.
struct Terms {
    started: bool,
}

impl Terms {
    fn new() -> Self {
        Self { started: false }
    }

    fn add(&mut self, b: &mut ModuleBuilder, emit: impl FnOnce(&mut ModuleBuilder)) {
        emit(b);
        if self.started {
            b.u8(op::I32_OR);
        }
        self.started = true;
    }

    /// Leave exactly one value on the stack, even when no term was live.
    fn finish(self, b: &mut ModuleBuilder) {
        if !self.started {
            b.const_i32(0);
        }
    }
}

/// A single bit value, scaled to its position in the flag word.
fn scaled(b: &mut ModuleBuilder, bit: i32) {
    b.const_i32(bit);
    b.u8(op::I32_MUL);
}

/// ZF, SF and PF from `result`.
fn add_common_terms(b: &mut ModuleBuilder, locals: &Locals, live: i32, terms: &mut Terms) {
    if live & flag::ZERO != 0 {
        terms.add(b, |b| {
            b.local_get(locals.result);
            b.u8(op::I32_EQZ);
            scaled(b, flag::ZERO);
        });
    }
    if live & flag::SIGN != 0 {
        terms.add(b, |b| {
            b.local_get(locals.result);
            b.const_i32(31);
            b.u8(op::I32_SHR_U);
            scaled(b, flag::SIGN);
        });
    }
    if live & flag::PARITY != 0 {
        // PF is the parity of the LOW BYTE only — of the whole word it would be a different flag.
        // Folded with shifts and XOR rather than `i32.popcnt`: the unit verifier abstract
        // interpreter does not model popcnt, and an instruction it cannot model leaves it unable
        // to reason about the flags write around it, which it reports rather than passing.
        terms.add(b, |b| {
            b.local_get(locals.result);
            b.const_i32(0xff);
            b.u8(op::I32_AND);
            b.local_set(locals.parity);
            for shift in [4, 2, 1] {
                b.local_get(locals.parity);
                b.local_get(locals.parity);
                b.const_i32(shift);
                b.u8(op::I32_SHR_U);
                b.u8(op::I32_XOR);
                b.local_set(locals.parity);
            }
            b.local_get(locals.parity);
            b.const_i32(1);
            b.u8(op::I32_AND);
            b.u8(op::I32_EQZ);
            scaled(b, flag::PARITY);
        });
    }
}

/// AF: a carry or borrow across bit 3, which in both directions is one XOR of the operands
/// against the result.
fn add_adjust_term(b: &mut ModuleBuilder, locals: &Locals, live: i32, terms: &mut Terms) {
    if live & flag::ADJUST != 0 {
        terms.add(b, |b| {
            b.local_get(locals.lhs);
            b.local_get(locals.rhs);
            b.u8(op::I32_XOR);
            b.local_get(locals.result);
            b.u8(op::I32_XOR);
            b.const_i32(0x10);
            b.u8(op::I32_AND);
        });
    }
}

/// The flags of a SUBTRACTION (`cmp`, `sub`, `dec`).
///
/// Guest-visible flags still leave in v86 lazy representation; this word is the PRIVATE shadow
/// the region own conditions read, so only what they can read is built.
fn emit_sub_flags(b: &mut ModuleBuilder, locals: &Locals, live: i32) {
    let mut terms = Terms::new();
    if live & flag::CARRY != 0 {
        terms.add(b, |b| {
            b.local_get(locals.lhs);
            b.local_get(locals.rhs);
            b.u8(op::I32_LT_U);
            scaled(b, flag::CARRY);
        });
    }
    if live & flag::OVERFLOW != 0 {
        // The operands differ in sign and the result takes the subtrahend sign.
        terms.add(b, |b| {
            b.local_get(locals.lhs);
            b.local_get(locals.rhs);
            b.u8(op::I32_XOR);
            b.local_get(locals.lhs);
            b.local_get(locals.result);
            b.u8(op::I32_XOR);
            b.u8(op::I32_AND);
            b.const_i32(31);
            b.u8(op::I32_SHR_U);
            scaled(b, flag::OVERFLOW);
        });
    }
    add_common_terms(b, locals, live, &mut terms);
    add_adjust_term(b, locals, live, &mut terms);
    terms.finish(b);
}

/// The same for an ADDITION.
fn emit_add_flags(b: &mut ModuleBuilder, locals: &Locals, live: i32) {
    let mut terms = Terms::new();
    if live & flag::CARRY != 0 {
        // The sum wrapped below either operand.
        terms.add(b, |b| {
            b.local_get(locals.result);
            b.local_get(locals.lhs);
            b.u8(op::I32_LT_U);
            scaled(b, flag::CARRY);
        });
    }
    if live & flag::OVERFLOW != 0 {
        // Both operands share a sign the result does not.
        terms.add(b, |b| {
            b.local_get(locals.lhs);
            b.local_get(locals.result);
            b.u8(op::I32_XOR);
            b.local_get(locals.rhs);
            b.local_get(locals.result);
            b.u8(op::I32_XOR);
            b.u8(op::I32_AND);
            b.const_i32(31);
            b.u8(op::I32_SHR_U);
            scaled(b, flag::OVERFLOW);
        });
    }
    add_common_terms(b, locals, live, &mut terms);
    add_adjust_term(b, locals, live, &mut terms);
    terms.finish(b);
}

/// A logical operation: CF and OF are CLEARED rather than computed, so they contribute no term —
/// the caller mask clears them and nothing sets them back.
fn emit_logic_flags(b: &mut ModuleBuilder, locals: &Locals, live: i32) {
    let mut terms = Terms::new();
    add_common_terms(b, locals, live, &mut terms);
    terms.finish(b);
}

/// `shl r32, imm8`: CF is the last bit shifted out; OF and AF are not claimed.
fn emit_shl_flags(b: &mut ModuleBuilder, locals: &Locals, live: i32, count: i32) {
    let mut terms = Terms::new();
    if live & flag::CARRY != 0 {
        terms.add(b, |b| {
            b.local_get(locals.lhs);
            b.const_i32(32 - count);
            b.u8(op::I32_SHR_U);
            b.const_i32(1);
            b.u8(op::I32_AND);
            scaled(b, flag::CARRY);
        });
    }
    add_common_terms(b, locals, live, &mut terms);
    terms.finish(b);
}

/// Write the bits this operation does NOT define into the guest's `flags`, from the shadow.
///
/// The lazy tuple below will stop claiming them, so from that point the guest reads them out of
/// `flags`. Nobody put them there: the previous operation left them to be recomputed from ITS
/// operands, and those operands are about to be replaced. This is the authoritative write a region
/// owes (contract C14), and it is read-modify-write because `flags` also holds DF (N106).
///
/// It must run BEFORE the shadow is updated, or it copies this operation's own result into bits
/// this operation did not compute.
fn emit_preserved_flags(b: &mut ModuleBuilder, locals: &Locals, preserved: i32) {
    if NO_FLAGS.with(|f| f.get()) {
        return;
    }
    // The materialization and the tuple are ONE publication. Dropping half of it leaves `flags`
    // holding this operation's preserved bits while `flags_changed` still claims the previous
    // operation's — two operations mixed, which is exactly what a fault would read.
    if tuple_is_dead() {
        return;
    }
    if preserved == 0 {
        return;
    }
    tuple_set(b, locals, FlagWord::Flags, |b| {
        tuple_get(b, locals, FlagWord::Flags);
        b.const_i32(!preserved);
        b.u8(op::I32_AND);
        b.local_get(locals.flags);
        b.const_i32(preserved);
        b.u8(op::I32_AND);
        b.u8(op::I32_OR);
    });
}

/// Update the private shadow with the bits `compute` defines AND some later condition can read.
///
/// A bit that is defined but dead keeps its previous value; nothing observes it, because the
/// shadow is private to the activation and the guest-visible flags leave as the lazy tuple.
fn shadow_flags(
    b: &mut ModuleBuilder,
    locals: &Locals,
    defined: i32,
    demanded: i32,
    compute: impl FnOnce(&mut ModuleBuilder, i32),
) {
    let live = defined & demanded;
    if live == 0 {
        return;
    }
    b.local_get(locals.flags);
    b.const_i32(!live);
    b.u8(op::I32_AND);
    compute(b, live);
    b.u8(op::I32_OR);
    b.local_set(locals.flags);
}

/// Leave v86's lazy flag state describing the operation that just ran.
///
/// This is the GUEST-VISIBLE representation, and it is the reference's: `flags` keeps whatever it
/// held, `flags_changed` names the bits that must be recomputed, and the operands to recompute
/// them from sit in `last_op1`/`last_result`/`last_op_size`. Materializing instead would be
/// architecturally equivalent and representationally different, which the differential compares
/// and the plan's first ABI does not permit.
fn emit_lazy_tuple(b: &mut ModuleBuilder, locals: &Locals, changed: i32) {
    if NO_FLAGS.with(|f| f.get()) {
        return;
    }
    if tuple_is_dead() {
        return;
    }
    tuple_set(b, locals, FlagWord::LastOp1, |b| {
        b.local_get(locals.lhs);
    });
    tuple_set(b, locals, FlagWord::LastResult, |b| {
        b.local_get(locals.result);
    });
    tuple_set(b, locals, FlagWord::LastOpSize, |b| {
        b.const_i32(OPSIZE_32);
    });
    tuple_set(b, locals, FlagWord::FlagsChanged, |b| {
        b.const_i32(changed);
    });
}

/// v86's `last_op_size` for a 32-bit operation (`abi.mjs` OPSIZE_32).
const OPSIZE_32: i32 = 31;

/// The five words of v86's lazy flag state, in the engine's own `flag_locals` slot order.
#[derive(Clone, Copy)]
enum FlagWord {
    LastOp1 = 0,
    LastResult = 1,
    LastOpSize = 2,
    FlagsChanged = 3,
    Flags = 4,
}

impl FlagWord {
    const ALL: [FlagWord; 5] = [
        Self::LastOp1,
        Self::LastResult,
        Self::LastOpSize,
        Self::FlagsChanged,
        Self::Flags,
    ];
    fn address(self) -> u32 {
        match self {
            Self::LastOp1 => g::LAST_OP1,
            Self::LastResult => g::LAST_RESULT,
            Self::LastOpSize => g::LAST_OP_SIZE,
            Self::FlagsChanged => g::FLAGS_CHANGED,
            Self::Flags => g::FLAGS,
        }
    }
}

/// Write one word of the lazy tuple — to its local when the pass is on, to memory otherwise.
fn tuple_set(
    b: &mut ModuleBuilder,
    locals: &Locals,
    word: FlagWord,
    value: impl FnOnce(&mut ModuleBuilder),
) {
    if IN_LOCALS.with(|f| f.get()) {
        value(b);
        b.local_set(locals.tuple[word as usize]);
    } else {
        b.store_fixed(word.address(), value);
    }
}

/// Read one word of the lazy tuple, from wherever it currently lives.
fn tuple_get(b: &mut ModuleBuilder, locals: &Locals, word: FlagWord) {
    if IN_LOCALS.with(|f| f.get()) {
        b.local_get(locals.tuple[word as usize]);
    } else {
        b.load_fixed(word.address());
    }
}

/// Guest memory → locals, once, in the prologue.
fn seed_flag_state(b: &mut ModuleBuilder, locals: &Locals) {
    if !IN_LOCALS.with(|f| f.get()) {
        return;
    }
    for word in FlagWord::ALL {
        b.load_fixed(word.address());
        b.local_set(locals.tuple[word as usize]);
    }
}

/// Locals → guest memory, at every point that can read the tuple.
///
/// Those points are the two epilogues, and only they: an exit hands control back to the engine,
/// and the fault epilogue is followed by `trigger_fault_end_jit`, which delivers the interrupt and
/// pushes EFLAGS built from these five words. The memory helpers in between cannot read them —
/// that is the engine's own rule, not an assumption of ours (`flag_spill_whitelisted`).
fn publish_flag_state(b: &mut ModuleBuilder, locals: &Locals) {
    if !IN_LOCALS.with(|f| f.get()) {
        return;
    }
    for word in FlagWord::ALL {
        let local = locals.tuple[word as usize];
        match word {
            // `flags` is published read-modify-write, like every other authoritative write to it
            // (N106/C14): the word also holds DF and the reserved bits, and the six arithmetic
            // flags are the only ones this unit can change. Carrying the whole seeded word in the
            // local would give the same bits, but a store the verifier cannot see as an RMW is a
            // rule discharged by argument instead of by structure.
            FlagWord::Flags => b.store_fixed(g::FLAGS, |b| {
                b.load_fixed(g::FLAGS);
                b.const_i32(!flag::ALL);
                b.u8(op::I32_AND);
                b.local_get(local);
                b.const_i32(flag::ALL);
                b.u8(op::I32_AND);
                b.u8(op::I32_OR);
            }),
            _ => b.store_fixed(word.address(), |b| {
                b.local_get(local);
            }),
        };
    }
}

fn gpr_index(r: Gpr) -> usize {
    r as usize
}

/// Push the linear address of a memory operand onto the stack.
fn emit_address(b: &mut ModuleBuilder, locals: &Locals, address: &Address) {
    match address.base {
        Some(r) => b.local_get(locals.gpr[gpr_index(r)]),
        None => b.const_i32(0),
    };
    if let Some(index) = address.index {
        b.local_get(locals.gpr[gpr_index(index)]);
        if address.scale > 1 {
            b.const_i32(i32::from(address.scale.trailing_zeros() as u8));
            b.u8(op::I32_SHL);
        }
        b.u8(op::I32_ADD);
    }
    if address.displacement != 0 {
        b.const_i32(address.displacement);
        b.u8(op::I32_ADD);
    }
}

/// Load this address TLB entry and leave it in `locals.tlb` and on the stack.
fn emit_tlb_entry(b: &mut ModuleBuilder, locals: &Locals) {
    b.local_get(locals.addr);
    b.const_i32(12);
    b.u8(op::I32_SHR_U);
    b.const_i32(2);
    b.u8(op::I32_SHL);
    b.load_reloc_offset("tlb_data");
    b.local_tee(locals.tlb);
}

/// The physical address the entry names, from `locals.tlb`.
fn emit_physical_address(b: &mut ModuleBuilder, locals: &Locals) {
    b.local_get(locals.tlb);
    b.const_i32(!0xfff);
    b.u8(op::I32_AND);
    b.local_get(locals.addr);
    b.u8(op::I32_XOR);
}

/// Fill the entry on a miss, then use it WITHOUT checking what it says.
///
/// This is arm D: it keeps the one obligation without which the answer is simply wrong — an
/// unfilled entry names no page, so the first touch must still go through the helper — and drops
/// the ones a proof would discharge: validity, the permission for this access kind, and the
/// in-page bound a multi-byte access can cross. It is therefore WRONG for a read-only page or a
/// page-crossing operand, which is why it prices a bucket and never accepts a gain.
fn emit_unchecked_translation(
    b: &mut ModuleBuilder,
    locals: &Locals,
    helper: u32,
    page_offset: u32,
) -> Result<(), LowerError> {
    const L_CONT: &str = "entry_filled";
    b.block(L_CONT);
    emit_tlb_entry(b, locals);
    b.const_i32(0);
    b.u8(op::I32_NE);
    b.br_if_to(L_CONT)?;
    b.local_get(locals.addr);
    b.const_i32(page_offset as i32);
    b.call(helper);
    b.local_tee(locals.tlb);
    b.const_i32(1);
    b.u8(op::I32_AND);
    b.br_if_to(L_FAULT)?;
    b.end()?;
    emit_physical_address(b, locals);
    Ok(())
}

/// The safe-read shape of `codegen.rs::gen_safe_read`: probe the TLB, fall back to the slow
/// helper, and run the SAME inline access on both paths (contract N49).
fn emit_safe_read(
    b: &mut ModuleBuilder,
    locals: &Locals,
    bits: u8,
    page_offset: u32,
    cpl3: bool,
    form: AccessForm,
) -> Result<(), LowerError> {
    if form != AccessForm::Guarded {
        if form == AccessForm::Proven {
            // The entry was checked at the scope guard, for every page this loop can reach.
            emit_tlb_entry(b, locals);
            b.local_set(locals.tlb);
            emit_physical_address(b, locals);
        } else {
            let helper = b.import(
                if bits == 8 { "safe_read8_slow_jit" } else { "safe_read32s_slow_jit" },
                "ii_i",
            )?;
            emit_unchecked_translation(b, locals, helper, page_offset)?;
        }
        if bits == 8 {
            b.body_load_u8();
        } else {
            b.body_load_u32();
        }
        return Ok(());
    }
    let helper = b.import(
        if bits == 8 { "safe_read8_slow_jit" } else { "safe_read32s_slow_jit" },
        "ii_i",
    )?;
    const L_CONT: &str = "access_ok";
    b.block(L_CONT);
    b.local_get(locals.addr);
    b.const_i32(12);
    b.u8(op::I32_SHR_U);
    b.const_i32(2);
    b.u8(op::I32_SHL);
    b.load_reloc_offset("tlb_data");
    b.local_tee(locals.tlb);
    b.const_i32(tlb_read_mask(cpl3));
    b.u8(op::I32_AND);
    b.const_i32(tlb::VALID);
    b.u8(op::I32_EQ);
    if bits != 8 {
        // The in-page bound test on a multi-byte access is never elided: a dword two bytes from
        // the page end is legal for the TLB entry and still crosses into the next page.
        b.local_get(locals.addr);
        b.const_i32(0xfff);
        b.u8(op::I32_AND);
        b.const_i32(0x1000 - i32::from(bits / 8));
        b.u8(op::I32_LE_S);
        b.u8(op::I32_AND);
    }
    b.br_if_to(L_CONT)?;
    b.local_get(locals.addr);
    b.const_i32(page_offset as i32);
    b.call(helper);
    b.local_tee(locals.tlb);
    b.const_i32(1);
    b.u8(op::I32_AND);
    b.br_if_to(L_FAULT)?;
    b.end()?;
    b.local_get(locals.tlb);
    b.const_i32(!0xfff);
    b.u8(op::I32_AND);
    b.local_get(locals.addr);
    b.u8(op::I32_XOR);
    if bits == 8 {
        b.body_load_u8();
    } else {
        b.body_load_u32();
    }
    Ok(())
}

/// The safe-write shape of `codegen.rs::gen_safe_write`.
///
/// The slow helper RESOLVES the address and returns the TLB entry; it does not perform the store.
/// The trailing inline access therefore runs on both paths (N49) — skipping it after the slow
/// path drops the write entirely, and the guest sees a store that never happened.
fn emit_safe_write(
    b: &mut ModuleBuilder,
    locals: &Locals,
    page_offset: u32,
    cpl3: bool,
    form: AccessForm,
) -> Result<(), LowerError> {
    if form == AccessForm::Proven {
        emit_tlb_entry(b, locals);
        b.local_set(locals.tlb);
        emit_physical_address(b, locals);
        b.local_get(locals.value);
        b.body_store_u32();
        return Ok(());
    }
    if form == AccessForm::UncheckedDiagnostic {
        // The store helper takes the value too, so the miss path is written out here rather than
        // shared with the read: same shape, different signature.
        let helper = b.import("safe_write32_slow_jit", "iii_i")?;
        const L_CONT: &str = "store_filled";
        b.block(L_CONT);
        emit_tlb_entry(b, locals);
        b.const_i32(0);
        b.u8(op::I32_NE);
        b.br_if_to(L_CONT)?;
        b.local_get(locals.addr);
        b.local_get(locals.value);
        b.const_i32(page_offset as i32);
        b.call(helper);
        b.local_tee(locals.tlb);
        b.const_i32(1);
        b.u8(op::I32_AND);
        b.br_if_to(L_FAULT)?;
        b.end()?;
        emit_physical_address(b, locals);
        b.local_get(locals.value);
        b.body_store_u32();
        return Ok(());
    }
    let helper = b.import("safe_write32_slow_jit", "iii_i")?;
    const L_CONT: &str = "store_ok";
    b.block(L_CONT);
    b.local_get(locals.addr);
    b.const_i32(12);
    b.u8(op::I32_SHR_U);
    b.const_i32(2);
    b.u8(op::I32_SHL);
    b.load_reloc_offset("tlb_data");
    b.local_tee(locals.tlb);
    b.const_i32(tlb_write_mask(cpl3));
    b.u8(op::I32_AND);
    b.const_i32(tlb::VALID);
    b.u8(op::I32_EQ);
    b.local_get(locals.addr);
    b.const_i32(0xfff);
    b.u8(op::I32_AND);
    b.const_i32(0x1000 - 4);
    b.u8(op::I32_LE_S);
    b.u8(op::I32_AND);
    b.br_if_to(L_CONT)?;
    b.local_get(locals.addr);
    b.local_get(locals.value);
    b.const_i32(page_offset as i32);
    b.call(helper);
    // The result is tee'd IMMEDIATELY (D5) and then tested for the page-fault bit; testing it
    // without capturing it first is the shape the verifier cannot distinguish from ignoring it.
    b.local_tee(locals.tlb);
    b.const_i32(1);
    b.u8(op::I32_AND);
    b.br_if_to(L_FAULT)?;
    b.end()?;
    b.local_get(locals.tlb);
    b.const_i32(!0xfff);
    b.u8(op::I32_AND);
    b.local_get(locals.addr);
    b.u8(op::I32_XOR);
    b.local_get(locals.value);
    b.body_store_u32();
    Ok(())
}

fn lower_instruction(
    b: &mut ModuleBuilder,
    locals: &Locals,
    instruction: &Instruction,
    cpl3: bool,
    region: &Region,
    demanded: i32,
    materialize: i32,
    form: AccessForm,
    emits: &[Emit],
    from: usize,
    guard_index: usize,
) -> Result<(), LowerError> {
    let page_offset = instruction.guest_eip & 0xfff;
    match &instruction.opcode {
        Opcode::Move32Immediate { dst, value } => {
            b.const_i32(*value as i32);
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::Move32 { dst, src } => {
            b.local_get(locals.gpr[gpr_index(*src)]);
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::Xor32 { dst, src } => {
            b.local_get(locals.gpr[gpr_index(*dst)]);
            b.local_get(locals.gpr[gpr_index(*src)]);
            b.u8(op::I32_XOR);
            b.local_tee(locals.result);
            b.local_set(locals.gpr[gpr_index(*dst)]);
            // A logical operation CLEARS CF and OF, and v86 represents that by writing them
            // into `flags` and excluding them from `flags_changed`. That write is authoritative
            // and read-modify-write — `flags` also holds DF and the reserved bits (N106), so
            // rebuilding the word would clear the guest's direction flag as a side effect.
            emit_preserved_flags(b, locals, materialize);
            tuple_set(b, locals, FlagWord::Flags, |b| {
                tuple_get(b, locals, FlagWord::Flags);
                b.const_i32(!(flag::CARRY | flag::OVERFLOW));
                b.u8(op::I32_AND);
            });
            shadow_flags(b, locals, flag::ALL & !flag::ADJUST, demanded, |b, live| emit_logic_flags(b, locals, live));
            emit_lazy_tuple(b, locals, (flag::ALL & !flag::ADJUST) & !flag::CARRY & !flag::OVERFLOW);
            Ok(())
        }
        Opcode::Add32Immediate { dst, value } => {
            let reg = locals.gpr[gpr_index(*dst)];
            b.local_get(reg);
            b.local_set(locals.lhs);
            b.const_i32(*value);
            b.local_set(locals.rhs);
            b.local_get(locals.lhs);
            b.local_get(locals.rhs);
            b.u8(op::I32_ADD);
            b.local_tee(locals.result);
            b.local_set(reg);
            shadow_flags(b, locals, flag::ALL, demanded, |b, live| emit_add_flags(b, locals, live));
            emit_lazy_tuple(b, locals, flag::ALL);
            Ok(())
        }
        Opcode::Add32Mem { dst, address } => {
            let reg = locals.gpr[gpr_index(*dst)];
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 32, page_offset, cpl3, form)?;
            b.local_set(locals.rhs);
            b.local_get(reg);
            b.local_set(locals.lhs);
            b.local_get(locals.lhs);
            b.local_get(locals.rhs);
            b.u8(op::I32_ADD);
            b.local_tee(locals.result);
            b.local_set(reg);
            shadow_flags(b, locals, flag::ALL, demanded, |b, live| emit_add_flags(b, locals, live));
            emit_lazy_tuple(b, locals, flag::ALL);
            Ok(())
        }
        Opcode::Decrement32 { dst } => {
            let reg = locals.gpr[gpr_index(*dst)];
            b.local_get(reg);
            b.local_set(locals.lhs);
            b.const_i32(1);
            b.local_set(locals.rhs);
            b.local_get(locals.lhs);
            b.const_i32(1);
            b.u8(op::I32_SUB);
            b.local_tee(locals.result);
            b.local_set(reg);
            // DEC preserves CF — the whole reason it is not an ADD of -1 — so neither the
            // shadow nor `flags_changed` claims it.
            emit_preserved_flags(b, locals, materialize);
            shadow_flags(b, locals, flag::ALL & !flag::CARRY, demanded, |b, live| emit_sub_flags(b, locals, live));
            emit_lazy_tuple(b, locals, (flag::ALL & !flag::CARRY) | flag::SUB);
            Ok(())
        }
        Opcode::Shl32Immediate { dst, amount } => {
            let reg = locals.gpr[gpr_index(*dst)];
            let count = i32::from(*amount) & 0x1f;
            if count == 0 {
                return Ok(());   // a masked count of zero touches nothing, flags included
            }
            b.local_get(reg);
            b.local_set(locals.lhs);
            b.local_get(reg);
            b.const_i32(count);
            b.u8(op::I32_SHL);
            b.local_tee(locals.result);
            b.local_set(reg);
            // `arith.rs::shl32`, exactly: CF and OF are WRITTEN into `flags`, PF/AF/ZF/SF are
            // claimed lazily, and `last_op1` is deliberately NOT updated — so v86 recomputes AF
            // for a shift from the PREVIOUS operation's operand. Modelling AF as "preserved"
            // instead produced a different AF at a fault: same address, same error code, one bit
            // apart in the register snapshot.
            emit_preserved_flags(b, locals, materialize);
            tuple_set(b, locals, FlagWord::Flags, |b| {
                tuple_get(b, locals, FlagWord::Flags);
                b.const_i32(!(flag::CARRY | flag::OVERFLOW));
                b.u8(op::I32_AND);
                // CF: the last bit shifted out.
                b.local_get(locals.lhs);
                b.const_i32(32 - count);
                b.u8(op::I32_SHR_U);
                b.const_i32(1);
                b.u8(op::I32_AND);
                b.local_tee(locals.parity);
                b.u8(op::I32_OR);
                // OF: that bit XOR the result's sign, at bit 11. v86 computes it for EVERY count,
                // not only for one — "undefined" in the manual is a concrete value here.
                b.local_get(locals.parity);
                b.local_get(locals.result);
                b.const_i32(31);
                b.u8(op::I32_SHR_U);
                b.u8(op::I32_XOR);
                b.const_i32(11);
                b.u8(op::I32_SHL);
                b.const_i32(flag::OVERFLOW);
                b.u8(op::I32_AND);
                b.u8(op::I32_OR);
            });
            shadow_flags(b, locals, flag::PARITY | flag::ADJUST | flag::ZERO | flag::SIGN,
                demanded, |b, live| emit_shl_flags(b, locals, live, count));
            // No `last_op1`: v86 leaves it alone here, and writing it would change the AF the
            // guest recomputes.
            tuple_set(b, locals, FlagWord::LastResult, |b| {
                b.local_get(locals.result);
            });
            tuple_set(b, locals, FlagWord::LastOpSize, |b| {
                b.const_i32(OPSIZE_32);
            });
            tuple_set(b, locals, FlagWord::FlagsChanged, |b| {
                b.const_i32(flag::ALL & !flag::CARRY & !flag::OVERFLOW);
            });
            Ok(())
        }
        Opcode::CompareMem32Reg { address, rhs } => {
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 32, page_offset, cpl3, form)?;
            b.local_set(locals.lhs);
            b.local_get(locals.gpr[gpr_index(*rhs)]);
            b.local_set(locals.rhs);
            emit_compare(b, locals, demanded);
            Ok(())
        }
        Opcode::CompareMem32Imm { address, value } => {
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 32, page_offset, cpl3, form)?;
            b.local_set(locals.lhs);
            b.const_i32(*value);
            b.local_set(locals.rhs);
            emit_compare(b, locals, demanded);
            Ok(())
        }
        Opcode::Load32 { dst, address } => {
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 32, page_offset, cpl3, form)?;
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::LoadZeroExtendByte { dst, address } => {
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 8, page_offset, cpl3, form)?;
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::Store32 { address, src } => {
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            b.local_get(locals.gpr[gpr_index(*src)]);
            b.local_set(locals.value);
            emit_safe_write(b, locals, page_offset, cpl3, form)?;
            Ok(())
        }
        Opcode::StoreImm32 { address, value } => {
            emit_address(b, locals, address);
            b.local_set(locals.addr);
            b.const_i32(*value as i32);
            b.local_set(locals.value);
            emit_safe_write(b, locals, page_offset, cpl3, form)?;
            Ok(())
        }
        Opcode::Push32 { src } => {
            // ESP moves first and the store lands at the NEW top; the other order writes one slot
            // too high and leaves a frame the guest cannot return through.
            b.local_get(locals.gpr[gpr_index(Gpr::Esp)]);
            b.const_i32(4);
            b.u8(op::I32_SUB);
            b.local_tee(locals.addr);
            b.local_set(locals.gpr[gpr_index(Gpr::Esp)]);
            b.local_get(locals.gpr[gpr_index(*src)]);
            b.local_set(locals.value);
            emit_safe_write(b, locals, page_offset, cpl3, form)?;
            Ok(())
        }
        Opcode::Lea32 { dst, address } => {
            emit_address(b, locals, address);
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::Push32Immediate { value } => {
            b.local_get(locals.gpr[gpr_index(Gpr::Esp)]);
            b.const_i32(4);
            b.u8(op::I32_SUB);
            b.local_tee(locals.addr);
            b.local_set(locals.gpr[gpr_index(Gpr::Esp)]);
            b.const_i32(*value as i32);
            b.local_set(locals.value);
            emit_safe_write(b, locals, page_offset, cpl3, form)?;
            Ok(())
        }
        Opcode::CallRelative { target, return_to } => {
            // Push the return address, THEN transfer. The other order would leave a frame the
            // callee could already have written over before anything returned through it.
            b.local_get(locals.gpr[gpr_index(Gpr::Esp)]);
            b.const_i32(4);
            b.u8(op::I32_SUB);
            b.local_tee(locals.addr);
            b.local_set(locals.gpr[gpr_index(Gpr::Esp)]);
            b.const_i32(*return_to as i32);
            b.local_set(locals.value);
            emit_safe_write(b, locals, page_offset, cpl3, form)?;
            emit_edge(b, locals, target, region, emits, from, guard_index)
        }
        Opcode::Pop32 { dst } => {
            b.local_get(locals.gpr[gpr_index(Gpr::Esp)]);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 32, page_offset, cpl3, form)?;
            b.local_set(locals.value);
            // ESP is adjusted first and the destination written last, so `pop esp` keeps the
            // LOADED value: x86 discards the increment in that case.
            b.local_get(locals.addr);
            b.const_i32(4);
            b.u8(op::I32_ADD);
            b.local_set(locals.gpr[gpr_index(Gpr::Esp)]);
            b.local_get(locals.value);
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::Return { pop } => {
            // The reference JIT's shape (`instr32_C3_jit`): load the return address, store it as
            // an absolute EIP, then adjust ESP. Leaving through `$exit` is what makes the
            // successor a run-time value without any ret-chaining or a baked table index.
            b.local_get(locals.gpr[gpr_index(Gpr::Esp)]);
            b.local_set(locals.addr);
            emit_safe_read(b, locals, 32, page_offset, cpl3, form)?;
            b.local_set(locals.value);
            b.local_get(locals.addr);
            b.const_i32(4 + i32::from(*pop));
            b.u8(op::I32_ADD);
            b.local_set(locals.gpr[gpr_index(Gpr::Esp)]);
            b.store_fixed(g::INSTRUCTION_POINTER, |b| {
                b.local_get(locals.value);
            });
            b.br_to(L_EXIT)?;
            Ok(())
        }
        Opcode::SetCondition8 { dst, part, condition } => {
            if *part != RegisterPart::Low8 {
                return Err(LowerError::UnsupportedOpcode(format!("SetCondition8 on {part:?}")));
            }
            b.local_get(locals.gpr[gpr_index(*dst)]);
            b.const_i32(!0xff);
            b.u8(op::I32_AND);
            emit_condition(b, locals, *condition);
            b.u8(op::I32_OR);
            b.local_set(locals.gpr[gpr_index(*dst)]);
            Ok(())
        }
        Opcode::Exit(point) => emit_exit(b, locals, point, region),
        Opcode::Jump { target } => emit_edge(b, locals, target, region, emits, from, guard_index),
        Opcode::BranchIf { condition, taken, fallthrough } => {
            emit_condition(b, locals, *condition);
            b.u8(op::IF);
            b.u8(0x40);
            emit_edge(b, locals, taken, region, emits, from, guard_index)?;
            b.u8(op::ELSE);
            emit_edge(b, locals, fallthrough, region, emits, from, guard_index)?;
            b.u8(op::END);
            Ok(())
        }
    }
}

/// A comparison writes flags and nothing else; the difference is never stored.
fn emit_compare(b: &mut ModuleBuilder, locals: &Locals, demanded: i32) {
    b.local_get(locals.lhs);
    b.local_get(locals.rhs);
    b.u8(op::I32_SUB);
    b.local_set(locals.result);
    shadow_flags(b, locals, flag::ALL, demanded, |b, live| emit_sub_flags(b, locals, live));
    emit_lazy_tuple(b, locals, flag::ALL | flag::SUB);
}


/// How many pages one range may span before the guard declines.
///
/// The walk is UNROLLED to this many checks, for two reasons. A `loop` here would have to be
/// bounded by the retired instruction counter (contract B7) and the guard retires nothing, so it
/// has nothing to bound itself with; and an unbounded walk would pay at the entry what the loop
/// saves inside it. Declining is always safe — the guarded copy runs — so this is a budget, not
/// a correctness device.
const MAX_PROVEN_PAGES: i32 = 4;

/// The scope guard: prove every range once, then hand control to the copy that earned it.
///
/// The guard retires nothing and credits nothing, so it must never be an EXIT: leaving here would
/// hand the engine back the loop head address it just dispatched from, with the counter
/// unchanged, and the engine would dispatch there again forever (N28/N30). It always continues
/// into one of the two copies instead.
fn emit_scope_guard(
    b: &mut ModuleBuilder,
    locals: &Locals,
    region: &Region,
    scope: &Scope,
    cpl3: bool,
    emits: &[Emit],
    proven_index: usize,
    guard_index: usize,
) -> Result<(), LowerError> {
    const L_PROVEN: &str = "scope_proven";
    const L_RANGE: &str = "scope_range";
    const L_BAD: &str = "scope_range_bad";

    b.const_i32(1);
    b.local_set(locals.scope_ok);

    for range in &scope.ranges {
        b.block(L_RANGE);
        b.block(L_BAD);

        // The trip count bounds everything below, so it is bounded FIRST.
        //
        // `(trip - 1) * stride` is 32-bit arithmetic: a large enough count wraps the product to a
        // small number, the range collapses to one page, and every check after it is asking about
        // a range the loop does not walk. Comparing the ends afterwards cannot see that — the
        // wrapped `last` is a perfectly ordinary address. So the count is refused before it is
        // multiplied, against a limit that cannot overflow and that the page budget implies
        // anyway.
        if range.stride > 0 {
            let counter = scope
                .trip_counter
                .ok_or(LowerError::UnsupportedShape("a moving range without a trip count"))?;
            let limit = (MAX_PROVEN_PAGES * 0x1000) / range.stride + 1;
            b.local_get(locals.gpr[gpr_index(counter)]);
            b.const_i32(limit);
            b.u8(op::I32_GE_U);
            b.br_if_to(L_BAD)?;
        }

        // The first address THIS access touches. The guard runs at the loop head, so a pointer
        // already advanced by the time the access happens starts that many strides further on.
        emit_address(b, locals, &range.address);
        if range.advances_before != 0 {
            b.const_i32(range.stride * range.advances_before);
            b.u8(op::I32_ADD);
        }
        b.local_tee(locals.scope_page);

        // An operand that crosses a page reads two frames, and two adjacent VIRTUAL pages are not
        // two adjacent physical ones — the engine's slow helper exists to assemble such an access
        // from both. A translated-once proven access cannot, so the scope proves instead that no
        // access can cross: the first one is aligned to its own width, and the stride is a whole
        // number of them (checked when the scope was formed).
        if range.access_bytes > 1 {
            b.local_get(locals.scope_page);
            b.const_i32(range.access_bytes as i32 - 1);
            b.u8(op::I32_AND);
            b.br_if_to(L_BAD)?;
        }

        // The last byte it can touch: stride per iteration, one iteration fewer than the trip
        // count, plus the width of one access.
        b.local_get(locals.scope_page);
        if range.stride > 0 {
            // Only a moving range grows with the trip count; an invariant one is one address.
            let counter = scope
                .trip_counter
                .ok_or(LowerError::UnsupportedShape("a moving range without a trip count"))?;
            b.local_get(locals.gpr[gpr_index(counter)]);
            b.const_i32(1);
            b.u8(op::I32_SUB);
            b.const_i32(range.stride);
            b.u8(op::I32_MUL);
            b.u8(op::I32_ADD);
        }
        b.const_i32(range.access_bytes as i32 - 1);
        b.u8(op::I32_ADD);
        b.local_set(locals.scope_last);

        // 32-bit wrap of the SUM: the product is bounded above, but a base near the top of the
        // address space still wraps when the span is added to it.
        b.local_get(locals.scope_last);
        b.local_get(locals.scope_page);
        b.u8(op::I32_LT_U);
        b.br_if_to(L_BAD)?;

        // Page-aligned cursor and end.
        b.local_get(locals.scope_page);
        b.const_i32(!0xfff);
        b.u8(op::I32_AND);
        b.local_set(locals.scope_page);
        b.local_get(locals.scope_last);
        b.const_i32(!0xfff);
        b.u8(op::I32_AND);
        b.local_set(locals.scope_last);

        // Budget: decline rather than emit more checks than the unrolled walk has.
        b.local_get(locals.scope_last);
        b.local_get(locals.scope_page);
        b.u8(op::I32_SUB);
        b.const_i32(12);
        b.u8(op::I32_SHR_U);
        b.const_i32(MAX_PROVEN_PAGES);
        b.u8(op::I32_GE_U);
        b.br_if_to(L_BAD)?;

        // The mask is the SAME one the per-access guard uses, so the scope demands exactly what
        // each access would have demanded: validity, permission for this access kind, and — for a
        // write — that the page carries no code, since a store there would make the engine drop
        // compiled code and the entry with it.
        let mask = if range.writes { tlb_write_mask(cpl3) } else { tlb_read_mask(cpl3) };

        // One entry per page, and one page is the ordinary case.
        //
        // The guard runs on EVERY activation, so its cost is paid per call while the checks it
        // removes are saved per access. A 256-byte walk sits on one page, and probing four of them
        // to find that out spends most of the saving before the loop starts — which is what the
        // browser measurement showed: the unit lost to the baseline compiler exactly where its
        // fixed cost is highest. So the single-page case is settled with ONE probe and the
        // unrolled walk is left for ranges that really span.
        const L_SPAN: &str = "scope_range_spans";
        b.block(L_SPAN);
        b.local_get(locals.scope_page);
        b.local_get(locals.scope_last);
        b.u8(op::I32_XOR);
        b.const_i32(!0xfff);
        b.u8(op::I32_AND);
        b.br_if_to(L_SPAN)?;
        b.local_get(locals.scope_page);
        b.const_i32(12);
        b.u8(op::I32_SHR_U);
        b.const_i32(2);
        b.u8(op::I32_SHL);
        b.load_reloc_offset("tlb_data");
        b.const_i32(mask);
        b.u8(op::I32_AND);
        b.const_i32(tlb::VALID);
        b.u8(op::I32_NE);
        b.br_if_to(L_BAD)?;
        b.br_to(L_RANGE)?;
        b.end()?;   // block(scope_range_spans)

        for page in 0..MAX_PROVEN_PAGES {
            // Past the end of the range, re-check the last page: checking a page twice is free of
            // consequence, and it keeps the walk straight-line instead of nesting a skip per page.
            b.local_get(locals.scope_page);
            b.const_i32(page * 0x1000);
            b.u8(op::I32_ADD);
            b.local_get(locals.scope_last);
            b.local_get(locals.scope_page);
            b.const_i32(page * 0x1000);
            b.u8(op::I32_ADD);
            b.local_get(locals.scope_last);
            b.u8(op::I32_LE_U);
            b.u8(op::SELECT);
            b.const_i32(12);
            b.u8(op::I32_SHR_U);
            b.const_i32(2);
            b.u8(op::I32_SHL);
            b.load_reloc_offset("tlb_data");
            b.const_i32(mask);
            b.u8(op::I32_AND);
            b.const_i32(tlb::VALID);
            b.u8(op::I32_NE);
            b.br_if_to(L_BAD)?;
        }

        b.br_to(L_RANGE)?;
        b.end()?;   // block(scope_range_bad)
        b.const_i32(0);
        b.local_set(locals.scope_ok);
        b.end()?;   // block(scope_range)
    }

    b.block(L_PROVEN);
    b.local_get(locals.scope_ok);
    b.u8(op::I32_EQZ);
    b.br_if_to(L_PROVEN)?;
    redispatch(b, locals, region, scope.head as usize, emits, proven_index, guard_index)?;
    b.end()?;   // block(scope_proven)
    // Declined: the guarded copy runs the same loop, asking per access what the guard could not
    // answer once.
    let guarded = emits
        .iter()
        .position(|e| e.covers(scope.head as usize) && e.form() == AccessForm::Guarded)
        .ok_or(LowerError::UnsupportedShape("a scope with no guarded copy to fall back to"))?;
    redispatch(b, locals, region, scope.head as usize, emits, guarded, guard_index)?;
    Ok(())
}

/// One control-flow edge: either a re-dispatch inside the module, or a statepoint that leaves.
fn emit_edge(
    b: &mut ModuleBuilder,
    locals: &Locals,
    edge: &Continuation,
    region: &Region,
    emits: &[Emit],
    from: usize,
    guard_index: usize,
) -> Result<(), LowerError> {
    match edge {
        Continuation::InRegion { instruction } => {
            redispatch(b, locals, region, *instruction as usize, emits, from, guard_index)
        }
        Continuation::Exit(point) => emit_exit(b, locals, point, region),
    }
}

/// One exit: EIP, then the counter, then leave through `$exit` so the shared epilogue performs
/// the register flush (N19: every exit is preceded by one).
fn emit_exit(
    b: &mut ModuleBuilder,
    _locals: &Locals,
    point: &Statepoint,
    _region: &Region,
) -> Result<(), LowerError> {
    // N25: no epilogue writes EIP, so it is written HERE, before leaving.
    let eip = point.continuation_eip as i32;
    b.store_fixed(g::INSTRUCTION_POINTER, |b| {
        b.const_i32(eip);
    });
    // No credit here: the counter was advanced at the head of every block that ran, so adding
    // the statepoint's declared delta on top would count the same instructions twice. The
    // declaration remains the interpreter's cross-check, not a second source of truth.
    if let AccountingDelta::Fixed(0) = point.accounting_delta {
        // A zero delta is not a slow path: the engine loops forever on it (N30).
        return Err(LowerError::UnsupportedShape("an exit declaring a zero instruction delta"));
    }
    b.br_to(L_EXIT)?;
    Ok(())
}

/// Push 1 or 0 for a condition, read from the lazily-maintained flag words the way v86 does.
///
/// This lowering materializes flags eagerly at every flag-writing instruction, so the condition
/// can read `flags` directly rather than recomputing from the lazy tuple.
fn emit_condition(b: &mut ModuleBuilder, locals: &Locals, condition: Condition) {
    // Read from the SHADOW, never from guest `flags`: the guest word is deliberately left in
    // v86's lazy representation, so its arithmetic bits are stale by design.
    match condition {
        Condition::NotEqual => {
            b.local_get(locals.flags);
            b.const_i32(flag::ZERO);
            b.u8(op::I32_AND);
            b.u8(op::I32_EQZ);
        }
        Condition::GreaterOrEqualSigned => {
            // SF == OF. Comparing the two zero-tests rather than the masked bits is what makes
            // this the SIGNED test: the bits sit at different positions, so `SF == OF` on the
            // masked values would never be true.
            b.local_get(locals.flags);
            b.const_i32(flag::SIGN);
            b.u8(op::I32_AND);
            b.u8(op::I32_EQZ);
            b.local_get(locals.flags);
            b.const_i32(flag::OVERFLOW);
            b.u8(op::I32_AND);
            b.u8(op::I32_EQZ);
            b.u8(op::I32_EQ);
        }
    }
}
