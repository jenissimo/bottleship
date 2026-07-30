/**
 * Static Library HLE — shared types.
 *
 * A "library descriptor" bundles everything needed to detect a statically-linked
 * library (zlib, libpng, etc.) in a loaded PE image and replace its hot functions
 * with our HLE implementation.
 */

import type { LoadedPEModule, PESection } from '../module-registry';
import type { ThunkImplementation } from '../thunking/thunk-dispatcher';

// ─── Signatures ──────────────────────────────────────────────────────────────

export type Signature =
    | AsciiSignature
    | BytesSignature
    | U32TableSignature
    | PrologueSignature;

export interface AsciiSignature {
    kind: 'ascii';
    /** Literal string to find; NUL terminator is not required. */
    text: string;
    /** Section name to search in. Default: '.rdata'. */
    section?: string;
    /** Weight contributed to the confidence score when matched. */
    weight: number;
}

export interface BytesSignature {
    kind: 'bytes';
    /** Byte pattern; use `mask` to wildcard individual bytes. */
    pattern: Uint8Array;
    /** Same length as `pattern`; 'x' = must match, '?' = any. */
    mask: string;
    section?: string;
    weight: number;
}

export interface U32TableSignature {
    kind: 'u32table';
    /** Sequence of little-endian 32-bit values to find contiguous. */
    values: number[];
    section?: string;
    weight: number;
}

export interface PrologueSignature {
    kind: 'prologue';
    pattern: Uint8Array;
    mask: string;
    /** Section to search in. Default: '.text'. */
    section?: string;
    /** Must be reachable from one of these prior signature ids (cross-ref confirmation). */
    reachableFrom?: string[];
    weight: number;
}

// ─── Hooked function declaration ─────────────────────────────────────────────

/**
 * How to resolve a HookedFunction's entry address. Two strategies:
 *   - 'prologue' scans `.text` for a byte pattern (fragile; MSVC prologue
 *     bytes depend on locals size, preserved regs, /hotpatch flag, etc.).
 *   - 'xref' finds an instruction in `.text` that references an already-
 *     matched data signature (typically a string or a precomputed table),
 *     then walks backward to the nearest frame-setup prologue. Much more
 *     robust because it anchors on stable data-layout instead of unstable
 *     code encoding.
 */
export type EntryProbe =
    | { kind: 'prologue'; pattern: Uint8Array; mask: string; section?: string }
    | {
          kind: 'xref';
          /** Id of a signature (must be already hit during detection). */
          fromSignature: string;
          /**
           * Max bytes to backtrack from the xref instruction searching for
           * a prologue. 512 is generous enough for most inflate-size funcs
           * and cheap enough even if we scan in a tight loop.
           */
          maxBacktrack?: number;
          /** Optional .text section override (default '.text'). */
          section?: string;
      }
    | {
          kind: 'xrefCaller';
          /** Id of a signature hit inside a callee/helper function body. */
          fromSignature: string;
          /**
           * Max bytes to backtrack when recovering both the helper entry and
           * its caller wrapper entry.
           */
          maxBacktrack?: number;
          /** Optional .text section override (default '.text'). */
          section?: string;
      };

export interface HookedFunction {
    /** Exported name under which the handler is registered (e.g. 'inflate'). */
    name: string;
    /** How to resolve the function's entry address. */
    entryProbe: EntryProbe;
    /** cdecl = caller cleans up stack. stdcall = callee (RET N). */
    callingConvention: 'cdecl' | 'stdcall';
    /** Number of arguments. Stdcall uses this for RET N. Cdecl ignores. */
    argCount: number;
    /** If false, missing probe is tolerated (likely LTO-inlined); if true, descriptor detection fails. */
    required: boolean;
    /**
     * When true, `runDetector` skips `entryProbe` and relies entirely on
     * `descriptor.resolveAdditionalFunctions` to supply the address. Needed
     * for libraries whose error strings aren't reachable via direct code
     * xrefs — the declaration is still required so the patcher knows calling
     * convention / arg count.
     */
    externallyResolved?: boolean;
    /**
     * Instruction-boundary byte length of the function prologue (≥5, ≤15),
     * measured during RE (`re disasm`). When present, the patcher builds a
     * TRAMPOLINE (relocated prologue + JMP back) so the framework can invoke
     * the ORIGINAL function at any time — the shadow validator's fallback
     * path and the per-call guard-fail path both need it. The relocated
     * bytes must be position-independent (no relative branches) — the
     * patcher validates and refuses to hook otherwise.
     */
    prologueLen?: number;
    /**
     * Guarded Inner-Loop HLE: differential shadow validation. When present,
     * `descriptor.handlers[name]` is optional — the
     * production handler is derived from `shadow.kernel` run against live
     * guest memory. Requires `prologueLen` (the original is invoked via the
     * trampoline during validation).
     */
    shadow?: ShadowSpec;
    /**
     * Inner-loop HLE WASM tier: a handler-id in the 128..=255 band (see
     * cpu/hypercall.rs). When set, the patcher binds the JMP-stub's functionId
     * to this handler in the hypercall dispatch table, so the guest OUT is
     * served entirely in WASM (no JS round-trip). The JS `shadow` kernel stays
     * registered as the fall-through when the WASM handler returns false. This
     * is where the actual speedup lives — a JS handler at kilo-calls/frame is a
     * net regression (measured), the WASM kernel is not.
     */
    hypercallHandlerId?: number;
    /**
     * Guest-side entry filter (inner-loop HLE for PARTIAL hooks): a codegen
     * callback that emits a small x86 classifier into THUNK_CODE and returns
     * its entry address. The patch JMP then targets the FILTER instead of the
     * OUT stub; the filter routes supported calls to `stubAddress` (→ WASM/JS
     * handler) and everything else to `trampolineAddress` (→ the ORIGINAL
     * function at native speed — no OUT, no sync-call). Requires prologueLen
     * (the trampoline is the filter's decline path). Return null to refuse —
     * the whole patch is then aborted, loudly.
     */
    entryFilter?: (info: EntryFilterInfo) => number | null;
}

/** Context handed to a HookedFunction.entryFilter codegen callback. */
export interface EntryFilterInfo {
    /** Guest memory (write your filter bytes through this). */
    mem: Uint8Array;
    /** Absolute guest address of the hooked function entry (for reading
     *  embedded constants out of the original body — it is NOT patched yet). */
    targetAddress: number;
    /** OUT-stub entry (mov eax, funcId; out; ret N) — the "handled" route. */
    stubAddress: number;
    /** Relocated-prologue trampoline — the "run the original" route. */
    trampolineAddress: number;
    /** Allocate `size` bytes of RX THUNK_CODE for the filter body. */
    allocCode: (size: number) => number;
}

// ─── Guarded Inner-Loop HLE: shadow validation ──────────────────────────────

/**
 * Memory view handed to a shadow kernel. In PRODUCTION ('active' state) reads
 * and writes go straight to guest memory. In VALIDATION ('shadowing' state)
 * reads come from guest memory but writes land in scratch copies of the
 * declared output ranges — the kernel never perturbs the guest while the
 * original function is the authority.
 */
export interface ShadowView {
    readU8(addr: number): number;
    readU16(addr: number): number;
    readU32(addr: number): number;
    readF32(addr: number): number;
    readF64(addr: number): number;
    readBytes(addr: number, len: number): Uint8Array;
    writeU8(addr: number, v: number): void;
    writeU16(addr: number, v: number): void;
    writeU32(addr: number, v: number): void;
    writeF32(addr: number, v: number): void;
    writeF64(addr: number, v: number): void;
    writeBytes(addr: number, bytes: Uint8Array): void;
}

/** A guest byte range the kernel may write — the comparison surface. */
export interface ShadowRange {
    addr: number;
    len: number;
}

export interface ShadowSpec {
    /**
     * Output-relevant guest ranges for the given call (args already decoded).
     * Both the kernel's writes and the original's writes are compared over
     * EXACTLY these bytes. Return [] for pure register-return functions.
     * Ranges outside guest memory bounds fail the per-call guard (original
     * runs, call not counted).
     */
    ranges(args: number[], view: ShadowView): ShadowRange[];
    /**
     * The exact kernel — mirrors guest operation order/width. Returns the EAX
     * value. All guest-memory access MUST go
     * through `view` — that is what makes validation side-effect-free.
     */
    kernel(view: ShadowView, args: number[]): number;
    /**
     * Per-call cheap guard: args in plausible ranges etc. Returning
     * false routes THIS call to the original (not counted, not a mismatch).
     * Optional — default accepts every call.
     */
    guard?(args: number[], view: ShadowView): boolean;
    /** Clean validated calls required before going active. Default 128. */
    n?: number;
    /**
     * Byte-exact compare by default. For float output ranges a hook may allow
     * a tolerance measured in ULPs of f32 — compared elementwise over ranges
     * whose length is a multiple of 4. Use sparingly; exact kernels should
     * pass bit-exact (relaxed-FPU already runs the guest x87 as f64).
     */
    f32UlpTolerance?: number;
    /**
     * When true, the hook validates in-game by invoking the ORIGINAL guest
     * function through the trampoline and comparing.
     * DEFAULT false: the production path runs the kernel LIVE directly as a
     * plain sync thunk — correct for a pure leaf with byte-exact detection +
     * a unit test on RE-verified semantics, and free of the suspended-thunk
     * re-entrancy the trampoline round-trip needs (that path is still WIP for
     * synchronous hooked functions; the callback machinery it reuses was
     * built for guest-supplied callbacks, not re-entering a hooked callee).
     * A hook flips this on once the round-trip is proven for its shape.
     */
    validateInGame?: boolean;
    /**
     * Let the sync-original run re-enter our import thunks instead of aborting
     * on them. Required for a library entry point that ALLOCATES (zlib's
     * `uncompress` mallocs a 32 KiB window through the CRT, whose HeapAlloc IAT
     * slot is one of our stubs) — without it every validation call aborts with
     * 'thunk-entry' and the hook disables itself on call one. The cost is that
     * the guest may OUT-trap while we are already inside an OUT handler: only
     * safe when the imports involved are SYNCHRONOUS thunks, since an async one
     * would try to park a thread that the sync-call loop is driving.
     */
    allowGuestImports?: boolean;
}

export type ShadowHookState = 'shadowing' | 'active' | 'disabled';

export interface ShadowHookStatus {
    libId: string;
    functionName: string;
    state: ShadowHookState;
    cleanCalls: number;
    targetCalls: number;
    guardFails: number;
    mismatches: number;
    lastMismatch?: string;
}

// ─── Library descriptor ──────────────────────────────────────────────────────

export interface LibDescriptor {
    /** Short id like 'zlib' / 'libpng'. Used for logs and handler-module name. */
    id: string;
    /** Human-readable name. */
    displayName: string;
    /** Minimum score for detection to "lock in" on a match. */
    minConfidence: number;
    /** Signatures searched in the module's sections; each contributes weight on match. */
    signatures: Record<string, Signature>;
    /** Functions to hook; name → declaration. */
    functions: Record<string, HookedFunction>;
    /** Handlers registered with the dispatcher under `id + '-hle'` once detection succeeds. */
    handlers: Record<string, ThunkImplementation>;
    /**
     * Optional late-resolution hook. Runs AFTER signature detection clears the
     * confidence threshold and `functions[]` probes have been resolved, but
     * BEFORE patching. Returned matches are appended to `functionMatches` and
     * their names removed from `missingFunctions`. Useful when multiple
     * entries share an expensive discovery step (e.g. libjpeg's message-table
     * chase, which locates a pivot used for 5+ API entries).
     *
     * Each returned name MUST already exist in `descriptor.functions` (for
     * calling convention / arg count) and in `descriptor.handlers`.
     */
    resolveAdditionalFunctions?(view: ResolverModuleView): HookedFunctionMatch[];

    /**
     * Optional hook run once after successful detection + patching. Useful for
     * the library-specific backend to initialise shadow state maps etc.
     */
    onActivated?(match: LibMatch): void;
}

/** Context handed to `resolveAdditionalFunctions`. */
export interface ResolverModuleView {
    module: LoadedPEModule;
    signatureHits: SignatureHit[];
    /** Memoized section accessor. Returns undefined for unknown names. */
    getSection(name: string): PESection | undefined;
}

// ─── Match / detection results ───────────────────────────────────────────────

export interface SignatureHit {
    signatureId: string;
    /** Absolute address inside the module (base + RVA). */
    address: number;
    weight: number;
}

export interface HookedFunctionMatch {
    name: string;
    /** Absolute address of the function entry in guest memory. */
    address: number;
}

export interface LibMatch {
    descriptor: LibDescriptor;
    module: LoadedPEModule;
    confidence: number;
    signatureHits: SignatureHit[];
    functionMatches: HookedFunctionMatch[];
    /** Functions declared but not resolvable via probe — logged, not fatal unless `required`. */
    missingFunctions: string[];
}

// ─── Patch handles ───────────────────────────────────────────────────────────

export interface PatchHandle {
    libId: string;
    functionName: string;
    /** Absolute address of the patched guest function. */
    targetAddress: number;
    /** Absolute address of our callout stub. */
    stubAddress: number;
    /** The 16 bytes that were overwritten (first 5 bytes become `E9 rel32`). */
    originalBytes: Uint8Array;
    /** Dispatcher function id allocated for our stub. */
    functionId: number;
    /**
     * Address of the relocated-prologue trampoline (original first
     * `prologueLen` bytes + JMP back to target+prologueLen), when the hook
     * declared one. Calling this address executes the ORIGINAL function.
     */
    trampolineAddress?: number;
}

// ─── Manager report ──────────────────────────────────────────────────────────

export interface HleReportEntry {
    lib: string;
    confidence: number;
    module: string;
    patches: Array<{ name: string; addr: string; hits: number }>;
    missing: string[];
}
