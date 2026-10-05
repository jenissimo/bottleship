//! Scoped memory proof: discharge every access obligation once, for a whole bounded loop.
//!
//! The conservative lowering asks the same questions of the TLB at every access — is the entry
//! valid, does it permit this access kind, does the operand cross the page. A bounded loop over a
//! stride-advanced pointer asks them about the same handful of pages, over and over.
//!
//! A scope answers them once. Before the loop runs, the guard walks the pages of every range the
//! loop can touch and checks each entry; inside, the accesses translate without asking again.
//! What makes that sound is not optimism, it is what the engine can and cannot do while the unit
//! runs:
//!
//!   * the scope contains no helper call, no callback and no scheduler-visible operation, so
//!     nothing outside it runs between the guard and the last access;
//!   * a guest store cannot change what the TLB serves without an INVLPG — a mapping edited
//!     without one keeps being served from the stale entry, which the MMU matrix demonstrates
//!     (`mapping-change-src-no-invlpg`: taken=0) — and INVLPG is not in this slice, so it ends
//!     the region;
//!   * a store into a page carrying code would make the engine drop compiled code and the entry
//!     with it, so a write range whose page says HAS_CODE is refused.
//!
//! The guard cannot itself be the thing that fails: when it declines, control continues into a
//! GUARDED copy of the same loop, not out of the unit. Exiting instead would hand the engine the
//! loop head address it just came from, with nothing retired — the host loop N28/N30 name.

use crate::ir::{Address, Continuation, Gpr, Opcode, Region, Segment};

/// One contiguous span of guest memory a scope may touch, described the way the loop reaches it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvenRange {
    /// The instruction this range belongs to. A scope proves what it can and leaves the rest
    /// guarded, so the proof is per ACCESS, not per loop: a frame slot read at a fixed address is
    /// provable next to a pointer walked with a stride nobody knows.
    pub at: usize,
    /// The operand as written, evaluated with the register values at scope entry.
    pub address: Address,
    /// The register the loop advances, and by how much per iteration. A range the loop reaches
    /// through invariant registers alone has no induction and a stride of zero — it is one
    /// address, which is the easiest thing a guard can prove and the easiest to leave unproven by
    /// treating "no induction" as "not analysable".
    pub induction: Option<Gpr>,
    pub stride: i32,
    /// Bytes touched by one access.
    pub access_bytes: u32,
    /// How many times the induction register has ALREADY been advanced when this access happens.
    ///
    /// The guard runs at the loop head, so it sees the register as the first iteration starts. An
    /// access placed AFTER the advance therefore touches `first + stride` on that iteration, not
    /// `first` — and a range sized from the head walks off the pages it proved. `stride` here is
    /// the ADDRESS stride, so a scaled index is already accounted for.
    ///
    /// Counted along the path, never by position: see `advances_reaching`.
    pub advances_before: i32,
    /// Whether the scope writes here, which decides the permission the guard demands.
    pub writes: bool,
}

/// A bounded loop whose memory obligations can be discharged once, at entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    /// Instruction index of the loop head: where the guard hands control, and where the baseline
    /// resumes if the unit leaves.
    pub head: u32,
    /// Instruction index of the back edge, inclusive of the loop body.
    pub latch: u32,
    /// The register counted down to zero, whose entry value bounds the trip count.
    /// The register counted down to zero, when the loop has one. A scope that proves only
    /// INVARIANT addresses does not need it: one address is one address however many times the
    /// loop runs.
    pub trip_counter: Option<Gpr>,
    pub ranges: Vec<ProvenRange>,
}

/// Why a region did or did not get a scope.
///
/// A pass that silently does nothing is indistinguishable from a pass that is off, and every
/// measurement of it then compares a unit with itself. This is what makes the difference visible.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScopeOutcome {
    NoBackEdge,
    /// More than one back edge: the loop nest is not one this MVP models.
    ManyBackEdges,
    /// An edge inside the loop lands outside it, so control could re-enter unguarded.
    EdgeLeavesTheLoop { at: usize },
    /// An opcode the scope refuses to reason about at all.
    UnsupportedInBody { at: usize },
    /// A loop was found but nothing in it could be sized.
    NothingProvable { head: usize, latch: usize },
    Formed { head: usize, latch: usize, ranges: usize, invariant: usize },
}

impl Scope {
    /// The single natural loop this region contains, if it is one this MVP can prove about.
    ///
    /// Everything here is a refusal rather than an assumption: an unrecognised shape produces no
    /// scope, and the region lowers exactly as it did before.
    pub fn of(region: &Region) -> Option<Self> {
        match Self::analyse(region) {
            (scope, _) => scope,
        }
    }

    /// The same, with the reason attached.
    pub fn explain(region: &Region) -> ScopeOutcome {
        Self::analyse(region).1
    }

    fn analyse(region: &Region) -> (Option<Self>, ScopeOutcome) {
        let Some((latch, head)) = single_back_edge(region) else {
            return (None, back_edge_outcome(region));
        };
        let body = head..=latch;

        // A branch inside the body is allowed, including one that LEAVES the loop — that is what
        // a loop test is, and it only means fewer accesses than the guard proved. Proving more
        // than the loop walks is safe.
        //
        // Re-entry is safe for a different reason, and it is the one that matters: an edge to the
        // loop head from anywhere outside the proven copy is routed to the GUARD, and an edge to
        // any other instruction of the loop from outside lands in the GUARDED copy. There is no
        // path into the proven copy that skips the proof.
        //
        // What is still refused is a non-branch terminator: a return, a boundary exit or a call
        // in the middle of a loop is a shape whose interaction with the proof has not been
        // reasoned through, and refusing costs nothing but the scope.
        for index in head..latch {
            match &region.instructions[index].opcode {
                Opcode::Return { .. } | Opcode::Exit(_) | Opcode::CallRelative { .. } => {
                    return (None, ScopeOutcome::UnsupportedInBody { at: index });
                }
                _ => {}
            }
        }

        // A trip count is needed only to size a range that MOVES. It is proven the strict way when
        // it is there, and its absence simply means no moving range can be proven.
        let trip_counter = proven_trip_counter(region, head, latch);

        let mut ranges: Vec<ProvenRange> = Vec::new();
        for index in body.clone() {
            let instruction = &region.instructions[index];
            let (address, bytes, writes) = match &instruction.opcode {
                Opcode::Load32 { address, .. } => (address, 4, false),
                Opcode::Add32Mem { address, .. } => (address, 4, false),
                Opcode::CompareMem32Reg { address, .. } => (address, 4, false),
                Opcode::CompareMem32Imm { address, .. } => (address, 4, false),
                Opcode::LoadZeroExtendByte { address, .. } => (address, 1, false),
                Opcode::Store32 { address, .. } => (address, 4, true),
                Opcode::StoreImm32 { address, .. } => (address, 4, true),
                // A stack access is a range too, but ESP is not advanced by this loop shape and a
                // scope that silently left one unproven would be the whole point missed.
                Opcode::Push32 { .. }
                | Opcode::Push32Immediate { .. }
                | Opcode::Pop32 { .. }
                | Opcode::CallRelative { .. }
                | Opcode::Return { .. } => {
                    return (None, ScopeOutcome::UnsupportedInBody { at: index })
                }
                // Everything else must be named, not skipped. The proof rests on nothing else
                // running between the guard and the last access — no helper, no callback, no
                // scheduler-visible operation — and a wildcard would extend that claim to every
                // opcode added later, silently. This list is what makes adding one a decision.
                Opcode::Xor32 { .. }
                | Opcode::SetCondition8 { .. }
                | Opcode::Add32Immediate { .. }
                | Opcode::Move32Immediate { .. }
                | Opcode::Move32 { .. }
                | Opcode::Shl32Immediate { .. }
                | Opcode::Decrement32 { .. }
                | Opcode::Lea32 { .. }
                | Opcode::BranchIf { .. }
                | Opcode::Jump { .. } => continue,
                Opcode::Exit(_) => {
                    return (None, ScopeOutcome::UnsupportedInBody { at: index })
                }
            };
            if address.segment != Segment::DefaultData {
                continue;
            }
            // An access this analysis cannot size is LEFT GUARDED, not refused: the scope proves
            // what it can prove. That is what lets a loop whose pointers move by a runtime stride
            // still have its frame slots proven.
            let Some((induction, stride)) = induction_of(region, head, latch, address) else {
                continue;
            };
            // A pointer walked BACKWARDS is a range that starts below its first access; this MVP
            // sizes ranges forwards only.
            if stride < 0 {
                continue;
            }
            // A moving range needs a trip count to have an extent at all.
            if stride != 0 && trip_counter.is_none() {
                continue;
            }
            // A stride that is not a whole number of accesses means the operand alignment drifts,
            // and with it whether an access crosses a page. The guard proves alignment ONCE at
            // entry, which is only sound while every later access keeps it.
            if stride != 0 && stride % bytes as i32 != 0 {
                continue;
            }
            let advances_before = match induction {
                None => 0,
                // Counted along the PATH, and refused when two paths disagree. An advance that
                // merely SITS before the access is not one the access has executed.
                Some(register) => match advances_reaching(region, head, latch, register, index) {
                    Some(n) => n,
                    None => continue,
                },
            };
            ranges.push(ProvenRange {
                at: index,
                address: *address,
                induction,
                stride,
                access_bytes: bytes,
                advances_before,
                writes,
            });
        }
        if ranges.is_empty() {
            return (None, ScopeOutcome::NothingProvable { head, latch });
        }
        let invariant = ranges.iter().filter(|r| r.stride == 0).count();
        let outcome = ScopeOutcome::Formed { head, latch, ranges: ranges.len(), invariant };
        (
            Some(Self { head: head as u32, latch: latch as u32, trip_counter, ranges }),
            outcome,
        )
    }

    /// Whether this instruction is inside the scope's extent.
    pub fn covers(&self, index: usize) -> bool {
        index >= self.head as usize && index <= self.latch as usize
    }

    /// Whether THIS access was proven, and so may translate without checking. An access the scope
    /// could not size keeps the per-access guard even inside the proven copy.
    pub fn proves(&self, index: usize) -> bool {
        self.ranges.iter().any(|r| r.at == index)
    }
}

/// How many times the body has advanced `register` when control reaches `index`, or `None` when
/// two paths reaching it disagree.
///
/// This decides where a moving range STARTS, and counting the advance instructions that lie
/// between the head and the access is not the same question. A branch that jumps over `add ecx,4`
/// reaches the access with the pointer unadvanced, while a positional count says otherwise: the
/// guard then proves a page one stride too high and the access below it translates without anyone
/// having checked it. Disagreement is refused rather than approximated — a range whose start is
/// only sometimes right is not a proof.
///
/// The region has exactly one back edge (`single_back_edge`), so every other edge goes forward and
/// one iteration is a DAG. That is what makes a single increasing sweep a fixpoint, and it is why
/// the back edge itself is skipped: it belongs to the NEXT iteration, whose extra advances the
/// range covers through the trip count rather than through this count.
fn advances_reaching(
    region: &Region,
    head: usize,
    latch: usize,
    register: Gpr,
    index: usize,
) -> Option<i32> {
    #[derive(Clone, Copy, PartialEq)]
    enum Reach {
        Unreached,
        Exactly(i32),
        Disagree,
    }
    let mut at = vec![Reach::Unreached; latch + 1];
    at[head] = Reach::Exactly(0);
    for i in head..=latch {
        let arriving = match at[i] {
            Reach::Unreached => continue,
            Reach::Disagree => Reach::Disagree,
            Reach::Exactly(n) => Reach::Exactly(
                n + match region.instructions[i].opcode {
                    Opcode::Add32Immediate { dst, .. } if dst == register => 1,
                    _ => 0,
                },
            ),
        };
        for target in forward_targets(region, i, head, latch) {
            at[target] = match (at[target], arriving) {
                (Reach::Unreached, x) => x,
                (Reach::Exactly(a), Reach::Exactly(b)) if a == b => Reach::Exactly(a),
                _ => Reach::Disagree,
            };
        }
    }
    match at[index] {
        Reach::Exactly(n) => Some(n),
        // Unreached is refused for the same reason as disagreement: an access this sweep never
        // arrives at is one whose start address it has not established.
        _ => None,
    }
}

/// The in-body successors of `index` that go FORWARD. An edge leaving the loop reaches no further
/// access in the proven copy, and the one back edge is the next iteration.
fn forward_targets(region: &Region, index: usize, head: usize, latch: usize) -> Vec<usize> {
    let in_body = |t: u32| {
        let t = t as usize;
        (t > index && t <= latch && t >= head).then_some(t)
    };
    let mut out = Vec::new();
    match &region.instructions[index].opcode {
        Opcode::Jump { target: Continuation::InRegion { instruction } } => {
            out.extend(in_body(*instruction));
        }
        Opcode::Jump { .. } => {}
        Opcode::BranchIf { taken, fallthrough, .. } => {
            for edge in [taken, fallthrough] {
                if let Continuation::InRegion { instruction } = edge {
                    out.extend(in_body(*instruction));
                }
            }
        }
        // Everything else falls through; a terminator that is not a branch was refused when the
        // body was walked.
        _ => out.extend(in_body(index as u32 + 1)),
    }
    out
}

/// Which of the two back-edge failures happened, for the report.
fn back_edge_outcome(region: &Region) -> ScopeOutcome {
    let mut count = 0;
    for (index, instruction) in region.instructions.iter().enumerate() {
        let mut edges: Vec<u32> = Vec::new();
        match &instruction.opcode {
            Opcode::Jump { target: Continuation::InRegion { instruction: t } } => edges.push(*t),
            Opcode::BranchIf { taken, fallthrough, .. } => {
                for edge in [taken, fallthrough] {
                    if let Continuation::InRegion { instruction: t } = edge {
                        edges.push(*t);
                    }
                }
            }
            _ => {}
        }
        count += edges.iter().filter(|t| (**t as usize) <= index).count();
    }
    if count == 0 { ScopeOutcome::NoBackEdge } else { ScopeOutcome::ManyBackEdges }
}

/// The one back edge, as `(from, to)`. More than one, or none, and there is no scope.
fn single_back_edge(region: &Region) -> Option<(usize, usize)> {
    let mut found = None;
    for (index, instruction) in region.instructions.iter().enumerate() {
        let mut edges: Vec<u32> = Vec::new();
        match &instruction.opcode {
            Opcode::Jump { target: Continuation::InRegion { instruction: t } } => edges.push(*t),
            Opcode::BranchIf { taken, fallthrough, .. } => {
                for edge in [taken, fallthrough] {
                    if let Continuation::InRegion { instruction: t } = edge {
                        edges.push(*t);
                    }
                }
            }
            _ => {}
        }
        for target in edges {
            if (target as usize) <= index {
                if found.is_some() {
                    return None;
                }
                found = Some((index, target as usize));
            }
        }
    }
    found
}

/// The register whose entry value bounds the trip count, when the loop proves one.
///
/// Everything here is a refusal: one decrement, nothing else writing that register, and a latch
/// branch that reads THAT decrement's flags. `dec eax; add eax,1; jnz` satisfies none of it, and a
/// range sized from a counter the loop does not actually count down is sized from nothing.
fn proven_trip_counter(region: &Region, head: usize, latch: usize) -> Option<Gpr> {
    let (counter, decrement_at) = single_decrement(region, head, latch)?;
    match &region.instructions[latch].opcode {
        Opcode::BranchIf { condition: crate::ir::Condition::NotEqual, .. } => {}
        _ => return None,
    }
    let last_flag_writer = (head..latch)
        .rev()
        .find(|i| region.instructions[*i].opcode.writes_flags());
    if last_flag_writer != Some(decrement_at) {
        return None;
    }
    for index in head..=latch {
        if index != decrement_at && writes_register(&region.instructions[index].opcode) == Some(counter) {
            return None;
        }
    }
    Some(counter)
}

/// The single register the body decrements, and where, which is what bounds the trip count.
fn single_decrement(region: &Region, head: usize, latch: usize) -> Option<(Gpr, usize)> {
    let mut found = None;
    for index in head..=latch {
        if let Opcode::Decrement32 { dst } = region.instructions[index].opcode {
            if found.is_some() {
                return None;
            }
            found = Some((dst, index));
        }
    }
    found
}

/// The register an instruction writes, if it writes exactly one.
pub(crate) fn writes_register(opcode: &Opcode) -> Option<Gpr> {
    match opcode {
        Opcode::Xor32 { dst, .. }
        | Opcode::SetCondition8 { dst, .. }
        | Opcode::Add32Immediate { dst, .. }
        | Opcode::Move32Immediate { dst, .. }
        | Opcode::Move32 { dst, .. }
        | Opcode::Load32 { dst, .. }
        | Opcode::LoadZeroExtendByte { dst, .. }
        | Opcode::Add32Mem { dst, .. }
        | Opcode::Shl32Immediate { dst, .. }
        | Opcode::Pop32 { dst }
        | Opcode::Lea32 { dst, .. }
        | Opcode::Decrement32 { dst } => Some(*dst),
        _ => None,
    }
}

/// The register of `address` the loop advances, with its stride.
///
/// Every register the operand reads must be either that one or unchanged by the body: a base the
/// loop rewrites in some other way is a range whose extent the guard cannot know.
/// The register of `address` the loop advances, and how far the ADDRESS moves when it does.
///
/// Those are not the same number. `[ecx + edi*4]` with `add edi,4` moves the address by SIXTEEN
/// bytes per iteration, and a range sized by the register's own stride covers a quarter of what
/// the loop reads — which is a proof about pages the loop does not stay on.
fn induction_of(
    region: &Region,
    head: usize,
    latch: usize,
    address: &Address,
) -> Option<(Option<Gpr>, i32)> {
    let mut induction: Option<(Gpr, i32)> = None;
    // The scale applies to the INDEX only; a base register moves the address one for one.
    let scaled = |register: Gpr, stride: i32| -> Option<i32> {
        if address.index == Some(register) {
            // The same register in both roles moves the address by `stride * (1 + scale)`, which
            // this MVP does not model — and it must not silently model it as one of the two.
            if address.base == Some(register) {
                return None;
            }
            stride.checked_mul(address.scale as i32)
        } else {
            Some(stride)
        }
    };
    for register in [address.base, address.index].into_iter().flatten() {
        match register_behaviour(region, head, latch, register)? {
            Behaviour::Invariant => {}
            Behaviour::Advanced(stride) => {
                if induction.is_some() {
                    // Two advancing registers in one operand: the span is then a function of two
                    // strides, which this MVP does not model.
                    return None;
                }
                induction = Some((register, scaled(register, stride)?));
            }
        }
    }
    Some(match induction {
        Some((register, stride)) => (Some(register), stride),
        None => (None, 0),
    })
}

enum Behaviour {
    Invariant,
    Advanced(i32),
}

/// What the body does to one register: nothing, or exactly one constant addition.
fn register_behaviour(
    region: &Region,
    head: usize,
    latch: usize,
    register: Gpr,
) -> Option<Behaviour> {
    let mut stride = None;
    for index in head..=latch {
        let opcode = &region.instructions[index].opcode;
        if let Opcode::Add32Immediate { dst, value } = opcode {
            if *dst == register {
                if stride.is_some() {
                    return None;
                }
                stride = Some(*value);
                continue;
            }
        }
        if writes_register(opcode) == Some(register) {
            return None;
        }
    }
    Some(match stride {
        Some(value) => Behaviour::Advanced(value),
        None => Behaviour::Invariant,
    })
}
