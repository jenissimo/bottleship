//! The execution envelope: the facts a region was compiled against.
//!
//! A region is only correct *given* something. Plan §4.1 lists what that something is, with an
//! owner and a lifetime for each entry, and the point of putting it in the IR is that a region
//! cannot exist without saying what it assumed. An envelope left implicit becomes an assumption
//! nobody checks, and the failure mode is not a crash — it is a region that keeps running after
//! its premise stopped holding.
//!
//! Nothing here checks anything at run time. These are declarations the runtime must validate at
//! entry and invalidate on; the crate deliberately owns no runtime state to validate them
//! against. What the crate does own is the refusal: an envelope that admits a fact this compiler
//! cannot reason about is rejected rather than silently narrowed.

use std::fmt;

/// Envelope schema version. Separate from `IR_VERSION`: the set of facts a region may rely on
/// can change without the shape of the IR changing, and a runtime that validates envelope v1
/// must refuse a v2 region rather than check the fields it happens to recognise.
pub const ENVELOPE_VERSION: u32 = 1;

/// Decoding mode. The lifted slice is 32-bit protected mode with a flat data segment; anything
/// else changes what the same bytes mean, so it is named rather than assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeMode {
    Protected32,
}

/// Privilege level the region was lifted for. It is part of the envelope because the same access
/// faults differently at CPL0 and CPL3, and because CR0.WP only matters at CPL0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cpl {
    Supervisor,
    User,
}

/// How the segment a memory operand resolves through is treated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentModel {
    /// DS/ES/SS have base 0 and a 4 GiB limit, so a guest offset is a linear address.
    ///
    /// FS is deliberately NOT covered: it is switched per thread, so no region may fold a FS base
    /// into an address. A region that needs FS must carry it as a live input and re-read it.
    FlatDataSegments,
}

/// Whether the linear address a region computes is also the physical one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressModel {
    /// Paging on, identity-mapped. This is what BottleShip runs and what the corpus images build.
    /// It is load-bearing far beyond addressing: the guest-code coherence rule in CLAUDE.md §3.1
    /// depends on linear == physical, so a region asserting it is asserting that too.
    IdentityMappedPaging,
}

/// How many guest CPUs may execute over the memory a region reasons about.
///
/// This is the field a scoped memory proof's lifetime rests on. With one executing CPU and no
/// yield inside a scope, no other agent can unmap a page mid-scope. Under SMP, or with a second
/// writer of shared RAM, an entry check does not prevent a concurrent unmap AFTER it, and the
/// proof needs a different serialization contract entirely.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionModel {
    SingleGuestCpu,
}

/// x87/SSE policy the region was lifted under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FpPolicy {
    /// The region neither reads nor writes FP/SIMD state, and contains no instruction that could.
    /// The runtime may therefore leave that state alone across it. This is the only policy the
    /// integer slice is entitled to declare; it is not a claim about the engine's FP mode.
    Untouched,
}

/// A precondition whose owner may invalidate it. Each variant names the thing the RUNTIME must be
/// able to detect a change in — not a value the compiler observed once.
///
/// `Process.resetGeneration`, `RET_CACHE_EPOCH` and `asyncParkGeneration` are NOT these. The P0
/// contract audit establishes that no runtime generation for code bytes, mapping or segments
/// exists yet, so these variants describe an obligation the runtime has still to meet, and a
/// region carrying them is not publishable until it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DependencyKind {
    /// The bytes at every page in `Region::code_dependencies` still hash to what was lifted.
    CodeBytes,
    /// The mapping and permissions of every page the region touches are unchanged.
    MappingAndPermissions,
    /// Those pages are ordinary RAM: not MMIO, not a watchpoint, not runtime-private storage.
    OrdinaryRam,
    /// No page the region stores to carries a code/SMC write barrier.
    NoCodeWriteBarrier,
    /// The segment bases the region folded in are still current, and the thread has not switched.
    SegmentState,
    /// The engine's helper/intrinsic ABI is the one the region was built against.
    HelperAbi,
}

impl DependencyKind {
    pub const fn owner(self) -> &'static str {
        match self {
            Self::CodeBytes => "guest stores via cpu::memory; JS writes via memory/guest-code.ts",
            Self::MappingAndPermissions => "PageTableManager (PTEs) and v86's TLB via set_tlb_entry",
            Self::OrdinaryRam => "the AddressSpace region map",
            Self::NoCodeWriteBarrier => "the JIT's code-page ownership (TLB_HAS_CODE)",
            Self::SegmentState => "cpu switch_seg and the thread scheduler's performSwitch",
            Self::HelperAbi => "the v86 build (global_pointers.rs offsets and helper signatures)",
        }
    }
}

/// Everything a region assumed, in one value it must carry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub envelope_version: u32,
    pub decode_mode: DecodeMode,
    pub cpl: Cpl,
    pub segments: SegmentModel,
    pub addressing: AddressModel,
    pub execution: ExecutionModel,
    pub fp_policy: FpPolicy,
    /// Sorted and de-duplicated, so two envelopes describing the same preconditions compare equal
    /// and hash the same. Order of declaration is not a fact about the region.
    pub dependencies: Vec<DependencyKind>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnvelopeError {
    UnsupportedVersion(u32),
    /// Every region that reads or writes guest memory owes these, and a region that omits one is
    /// claiming a freedom it has no way to have earned.
    MissingDependency(DependencyKind),
    DuplicateDependency(DependencyKind),
    UnsortedDependencies,
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(v) => write!(f, "envelope version {v} is not {ENVELOPE_VERSION}"),
            Self::MissingDependency(d) => write!(
                f, "envelope omits {d:?}, which is owned by {} and must be revalidated at entry", d.owner()),
            Self::DuplicateDependency(d) => write!(f, "envelope lists {d:?} more than once"),
            Self::UnsortedDependencies => write!(f, "envelope dependencies are not in canonical order"),
        }
    }
}

impl std::error::Error for EnvelopeError {}

impl Envelope {
    /// The envelope the integer slice is entitled to: 32-bit protected mode, CPL0, flat data
    /// segments, identity-mapped paging, one executing CPU, FP state untouched.
    ///
    /// `touches_memory` is not a convenience flag. A region with no memory operation genuinely
    /// owes fewer preconditions, and letting it declare them anyway would make the missing-
    /// dependency check unable to fail for the regions that matter.
    pub fn integer_slice_v1(touches_memory: bool, stores_to_memory: bool) -> Self {
        let mut dependencies = vec![DependencyKind::CodeBytes, DependencyKind::SegmentState];
        if touches_memory {
            dependencies.push(DependencyKind::MappingAndPermissions);
            dependencies.push(DependencyKind::OrdinaryRam);
        }
        if stores_to_memory {
            dependencies.push(DependencyKind::NoCodeWriteBarrier);
        }
        dependencies.sort();
        dependencies.dedup();
        Self {
            envelope_version: ENVELOPE_VERSION,
            decode_mode: DecodeMode::Protected32,
            cpl: Cpl::Supervisor,
            segments: SegmentModel::FlatDataSegments,
            addressing: AddressModel::IdentityMappedPaging,
            execution: ExecutionModel::SingleGuestCpu,
            fp_policy: FpPolicy::Untouched,
            dependencies,
        }
    }

    pub fn requires(&self, kind: DependencyKind) -> bool {
        self.dependencies.contains(&kind)
    }

    /// Check the envelope against what the region actually does. Called by `verify`, so a region
    /// whose envelope under-declares is refused at the same place a malformed one is.
    pub fn validate(&self, touches_memory: bool, stores_to_memory: bool) -> Result<(), EnvelopeError> {
        if self.envelope_version != ENVELOPE_VERSION {
            return Err(EnvelopeError::UnsupportedVersion(self.envelope_version));
        }
        for pair in self.dependencies.windows(2) {
            if pair[0] == pair[1] {
                return Err(EnvelopeError::DuplicateDependency(pair[0]));
            }
            if pair[0] > pair[1] {
                return Err(EnvelopeError::UnsortedDependencies);
            }
        }
        let mut required = vec![DependencyKind::CodeBytes, DependencyKind::SegmentState];
        if touches_memory {
            required.push(DependencyKind::MappingAndPermissions);
            required.push(DependencyKind::OrdinaryRam);
        }
        if stores_to_memory {
            required.push(DependencyKind::NoCodeWriteBarrier);
        }
        for kind in required {
            if !self.requires(kind) {
                return Err(EnvelopeError::MissingDependency(kind));
            }
        }
        Ok(())
    }
}
