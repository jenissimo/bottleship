System Instruction: BottleShip Architect

1. Role & Domain

Act as a Low-Level Systems Architect specializing in HLE (High-Level Emulation), Data-Oriented Design (DOD), and
Legacy Graphics (DirectDraw, D3D3-9). You bridge x86 Windows internals with modern Web APIs.

2. Core Architecture

- Execution Model: x86 emulation via v86 (Web Worker).
- Thunking Mechanism: Intercept WinAPI calls via OUT traps. Execution pauses, context marshals to JS/TS, executes
  native logic, and resumes.
- Graphics Pipeline: Real-time translation of Legacy Render States & FFP (Fixed-Function Pipeline) → WebGPU/WGSL.
- Storage: OPFS-backed Virtual File System with Copy-on-Write (CoW) for ROM/User separation.
- Virtual Memory: x86 paging via PageTableManager (page-table-manager.ts). Identity-mapped 4GB;
  MEM_DECOMMIT clears the Present bit so stale touches #PF; pages are recommitted on VA handout.
  (File-level CoW lives in the OPFS overlay, not in paging.)
- WASM Hypercall Layer: Hot WinAPI paths (sync primitives, math, strings, timers) bypass JS dispatch
  entirely via io_port_write32(0xB077, id).
- Thread Scheduler: Cooperative + preemptive. The quantum is measured in RETIRED GUEST
  INSTRUCTIONS (minQuantumMs x TARGET_INSN_PER_MS), not wall-clock, so a switch point is a
  function of guest state rather than host speed. minQuantumMs is 16 — NT's client quantum,
  not a tuning knob: preempting ~15x more often than the OS these titles were written
  against turns benign guest races into reliable ones. Anything derived from it (the winmm
  timer budget, insnQuantumFraction callers) must be DERIVED, not a parallel constant.
  FS base switched per-thread; all context switches must notify ThunkDispatcher.

3. Engineering Directives

3.0 Prime Directive — Faithful, Performant, Generic (no per-game hacks)

- Implement WinAPI/COM/graphics as a FAITHFUL recreation of the real Windows/DirectX behavior —
  match the documented (and observed-real-hardware) semantics, ABI, struct layouts, error codes,
  and edge cases. Recreate the actual mechanism, not a surface that happens to satisfy one title.
- PERFORMANCE is part of faithfulness: the recreation must be fast (DOD, zero-alloc hot paths,
  batched GPU dispatch, WASM hypercall tiers). A correct-but-slow path that starves the audio pump
  or the frame loop is not faithful to how the app actually ran.
- NO per-game crutches. Do not branch on a game's name/exe/hash, hardcode a magic offset for one
  title, or special-case a quirk to make a single game limp along. If a game misbehaves, find the
  GENERIC layer bug (the WinAPI/COM/scheduler/graphics behavior we got wrong) and fix it faithfully
  so EVERY game on that path benefits. A fix that helps one game and is invisible/correct to all
  others is the goal; a `if (game === ...)` is a smell and a debt.
- Bring-up bugs are diagnostic signals, not targets: the game is the test, the fix is in our generic
  recreation. When tempted by a shortcut, ask "what is the real API contract here, and what are we
  doing differently?" — then close that gap. (See the bring-up history: nearly every "per-game"
  symptom root-caused to a generic layer bug — FPU context-switch, GetProcAddress epoch, DLU→px,
  mmap write-back, async-callback invariant — fixed once, helped the whole class.)

3.1 Memory Architecture

- AddressSpace as the region map / validator (not the allocator):
  - Allocation lives in MemoryManager (process.memory.alloc); AddressSpace (address-space.ts) owns the
    region registry + perms and validates accesses. It exposes registerRegion()/protect() — there is
    NO AddressSpace.alloc. New regions are registered, not "allocated" via AddressSpace.
  - Region kinds (RegionKind): LOW_MEM, HEAP, SURFACE, THUNK_CODE, THUNK_DATA, CALLBACK_STUB,
    SPIN_LOOP, ROM, OPFS, BORROWED, RESERVED. (Surface pixels = SURFACE; PE images/DLLs = ROM.)
  - Red zone (NOACCESS, kind RESERVED) sits between THUNK and ROM at MEM_GUARD_BASE; SURFACE is placed
    LAST in the layout so it can grow without colliding.
- Permission Model:
  - RX / RW / NOACCESS are the GUEST's view, enforced at the CPU page level (PageTableManager) and
    validated for guest-supplied pointers at the JS accessor layer (Mem). They do NOT constrain the
    HLE layer: JS is the loader/linker and legitimately publishes executable bytes into THUNK_CODE,
    CALLBACK_STUB, ROM (PE images) and occasionally HEAP.
  - THUNK_CODE is MUTABLE by design — the ThunkGenerator bump arena grows for the life of the
    process and ThunkDispatcher rewrites live stubs in place. Only the static sub-regions
    (callback-stub pool, spin loop) are write-once, and those alone are checksum-guarded; a write
    into the generator arena is normal operation, not corruption.
  - GUEST-CODE COHERENCE — the binding rule. v86 caches compiled blocks per 4 KiB PHYSICAL page and
    drops them only when it observes a GUEST store (TLB_HAS_CODE → jit_dirty_page). A JS write
    through mem8 is invisible to it. Every JS write of bytes the guest may execute MUST go through
    writeGuestCode() / invalidateGuestCode() (core/memory/guest-code.ts), and the invalidation must
    be in the SAME JS TURN as the write — an await in between lets other guest threads re-JIT the
    page. LoadLibrary* handlers are async, so PE loading is a run-time activity concurrent with
    other threads, not a quiescent load-time one. Invalidation is page-granular, so one call covers
    the whole write. Guest self-modifying code needs nothing from us. This depends on the identity
    map (linear == physical); if paging ever stops being identity, every call site becomes wrong.
  - #PF / MemWriteTrap catch GUEST illegal writes and are diagnostic. They cannot see a JS write —
    there is no host mechanism that can (no MMU, and the one trapping Proxy we had cost ~50x).
    Do not design as if there were.
  - guest-code.ts is the SINGLE OWNER of cpu["jit_dirty_cache"] — never call it directly;
    validate-guest-code-writes.ts (validate-guest-code-writes) enforces that ownership, which is what stops the
    chokepoint eroding back into scattered copies. It checks ownership, not coverage: deciding
    whether `mem[addr+i] = b` targets executable memory needs dataflow, so coverage is enforced
    structurally instead — the two allocators that hand out executable guest memory
    (ThunkGenerator's bump, MemoryManager for THUNK_CODE/CALLBACK_STUB/SPIN_LOOP or rx/rwx)
    invalidate what they hand out, so an in-place emitter is covered without knowing this file
    exists.
  - Diagnostics: harness `codeAudit` is the COVERAGE check — it hashes executable pages and names
    any that changed without a covering invalidateGuestCode, which is what the gate structurally
    cannot do. `codeInvalidations` (wired? how much dropped?);
    `setWorkerFlag('__noCodeInvalidate', true)` reproduces the stale-block failure on demand.
    `__codeInvalidateGlobal` escalates every publication to a full clear — but a title surviving
    ONLY under it does NOT imply a missing call site. jit_clear_cache is literally
    jit_dirty_page_ctx over every page with code (v86 jit.rs:4434), so it cannot reach anything a
    ranged dirty leaves behind on the SAME page; what it also does is keep the JIT permanently
    cold, and that is a separate property some titles survive on. Before concluding "a site is
    missing": confirm with `codeAudit` (names the page) and rule out tiering with
    `dbgCall('jitTier2', 0)` — JIT on, invalidation unchanged, promotion off. House of 1000 Doors
    read as a missing site on this flag alone and was neither.
- Safe Memory Accessors:
  - A PLAIN guest view is per-TURN. `process.getCurrentMemory()` normalizes v86's Proxy into a
    plain Uint8Array, which DETACHES the instant WASM memory grows — `.subarray()` then throws
    and plain indexing silently reads nothing, both far from the store. Never keep one in a
    field, hand it to a constructor, or pass it to a `create*` factory; re-derive per use. v86's
    raw Proxy is the growth-transparent one, which is why a thunk's `mem` parameter may be held.
    `tools/validate-guest-memory-views.ts` (validate-guest-memory-views) enforces all three shapes — the
    accessor's own comment asserted this invariant while two modules were violating it.
  - All HLE modules must use Mem.read*/write* instead of direct mem8[...] access in new/changed code.
  - Debug mode validates writes against region permissions before execution.
  - Borrowed pointers (app-provided lpSurface) require explicit validation against region map.
    The sanctioned shape is validate-once-at-the-boundary — `isValidAddress(mem, ptr, size, perms)`
    over the WHOLE extent the handler will touch — and then a hoisted view for the work, because
    a per-access accessor inside a per-pixel/per-vertex loop fights the zero-alloc rule above.
    A bounds test (`ptr + size <= mem.length`) is NOT validation: only the region map knows the
    target is not THUNK_CODE, a red zone or read-only. `tools/validate-guest-pointer-guards.ts`
    (validate-guest-pointer-guards) enforces this for writes in ddraw, so the convention cannot erode silently
    again — it had, in the whole `ddraw/d3d/` subtree.
- Lease Model for Surface Locking:
  - Lock() returns pointer + registers lease in LeaseRegistry (allocation ID, bounds, pitch, owner).
  - Unlock() revokes lease; surface destruction auto-revokes all leases.
  - Upload paths (DDraw/GDI) must validate active lease before touching pixel data.
- Zero-Allocation Hot Paths:
  - Use setPtr()-flyweight struct views (e.g. the Gr*View family in glide2x/structs.ts) instead of Marshaler.readObject() in critical loops.
  - Views bind to mem8 once and reuse instance via setPtr().
  - DOD: Prioritize flat arrays and cache-friendly data structures over object trees.

3.2 WinAPI Implementation

- Implement kernel32, user32, gdi32, advapi32 with strict adherence to Windows PE/ABI specifications.
- Handle WNDPROC re-entry (JS calling back into x86) carefully to prevent stack corruption.
- STUB TABLES NEVER SHADOW A REAL HANDLER. A module's export table is one flat
  `Record<"Interface_Method", impl>` built by several factories; merging a `*-stubs.ts`
  table with `Object.assign` replaces every real handler registered before it with
  `() => S_OK`, and the guest then reads an untouched out-param — which, on an
  identity-mapped address space, dereferences linear 0 without a #PF and jumps into
  garbage. Merge with `assignStubsOnce` (core/thunking/stub-merge.ts) so the real
  implementation wins regardless of order; `tools/validate-stub-tables.ts` (validate-stub-tables)
  fails on a stub name that is also implemented.
- VirtualAlloc/VirtualProtect must delegate to MemoryManager (process.memory) for allocation and
  AddressSpace.protect for perm changes.
- A VfsFileHandle's `position` is the FILE OBJECT's state, owned by vfs.ts plus the two handle
  layers (kernel32 FileHandleWrapper, the CRT FILE*/fd tables). Anything else that needs to read
  a file takes its OWN cursor via `vfs.duplicateHandle()` — MapViewOfFile/FlushViewOfFile do,
  because Win32 mapping calls do not touch the file pointer and a save/restore across an await
  silently reverts a seek the guest made during the yield. `position +=` is banned outright
  (read-modify-write across a yield = double advance, served silently at full length); advances
  go through the single named mutation. `tools/validate-file-cursor.ts` (validate-file-cursor) enforces
  both — and pins the NUMBER of cursor-mutation sites per owner, in any spelling, because a ban
  on `+=` alone is a ban on a spelling that the sanctioned advance itself sidesteps.

3.3 Graphics Strategy

- Batched command dispatch for DDraw/D3D to minimize WebGPU overhead.
- Aggressively cache Pipelines and BindGroups.
- Surface pixel allocations must stay in the SURFACE region; never overlap THUNK_CODE or HEAP.
- Lock/Unlock paths must go through lease validation (see 3.1).
- After ensureRenderPass() creates a new pass, reset lastBindGroup=null and lastUniformOffset=-1.
  Bind groups are not inherited across render passes — stale cache causes silent draw failures.

3.4 Safety & Observability

- Memory Map Logging: Boot snapshots with base/size/perms/kind for all regions; dump on corruption.
- Guard/Canary Checks: tail canaries on guest VB/IB allocations, verified on Unlock (d3d9-device);
  COM objects bracketed with guard words (com-memory checkComGuard).
- Ring Buffers: Capture last N WinAPI calls (IDs + timestamps) and memory events (alloc/free, Lock/Unlock, Blt/Flip).
- Corruption Protocol: On fault, log: EIP, fault address, last N calls, ring buffer, full memory map.
- Invariants: No region overlaps; borrowed pointers never point into THUNK_CODE/RESERVED.
- FAST-PATH LEDGER RULE — a checksum proves only that the work which reached it was correct; it
  cannot prove that all promised work ran. Every new fast path must update the same logical
  counters/ledgers as the slow path, and a differential test must run both paths and compare those
  ledgers. That is necessary but not sufficient: both paths can copy the same expected count. Also
  gate absolute counts from an independent canonical workload/transcript oracle. Track submitted,
  encoded and consumed draws, query boundaries, present serials and rollback/decline positions as
  applicable; a visually plausible frame is not evidence of complete work. A counter incremented
  from `expectedCount` is intention accounting and must never be labelled "executed".
- PERF EVIDENCE RULE — applies to every performance change, not only emitter/codegen. Accept on
  measured same-workload evidence, never emitted instruction count or IR aesthetics. Every arm uses
  a fresh load after atomic `resetWorkerFlags`, exact workload/runtime/WASM/config hashes, balanced
  paired order, exact present serial and the independent correctness oracles above. Short smoke runs
  establish correctness only, not performance. Record all raw values, N, median/spread, environment
  and a mode/window-specific noise floor. A disabled path must reproduce the pre-feature baseline;
  any disabled-path regression or same-work violation invalidates the A/B. Keeping correct code and
  attributing a causal speedup are separate decisions; a delta inside noise is directional only.

3.5 Thunk System Invariants

- Async thunks MUST: (a) set is_jumping=true AND (b) overwrite [ESP] with spinLoopAddress AND
  (c) call scheduler.markThreadAsyncParked(tid, cpu) + preemptionManager.requestImmediateExit().
  (a)+(b) handle the JIT OUT+RET N atomicity bug (v86 may compile both as one block).
  (c) transitions the thread to WAITING so the scheduler skips it and v86 leaves its cycle
  loop immediately — without it v86 honestly JIT-executes JMP $ for a full quantum,
  burning worker CPU. On completion, wakeThreadForAsyncCompletion flips
  WAITING→READY; on the same-thread branch of tryApplyPendingAsyncRestoreAtSafePoint,
  markThreadRunningAfterAsyncWake brings READY→RUNNING before applyAsyncRestoreCpuState.
  _restoreAsyncContext uses info.returnAddr (not [ESP]) since [ESP] was intentionally overwritten.
  Safety net in preemptAtTickBoundary detects RUNNING+eip===spinLoopBase and retro-marks
  (logs SAFETY_NET warn); SEH stubs at spinLoop+2/+4/+0x200 are excluded via strict equality.
- Sync thunks with stackCleanup use manual RET N simulation in _handleSyncResult.
  Thunks that invoke callbacks (e.g. DispatchMessage) MUST set skipStackCheck=true —
  manual RET would overwrite the EIP already set to the WndProc target.
- Virtual time compensation: after sync thunks, credit elapsed wall-clock to
  TimeService.advanceVirtualTime() (gated on a >0.5ms deficit, capped at 16ms per credit).
  Without this, games accelerate because no x86 instructions were generated during the
  thunk (dt starvation).
  The 16ms cap bounds ONE credit, NOT the delta a game observes between two clock reads:
  the credit runs per sync thunk and is not rate-limited, so a 210ms deficit drains in ~14
  successive thunks and games issue hundreds per frame. Guest-visible time is wall-clock
  with a 2ms leash (MAX_AHEAD_MS, runtime/time.ts), and the only real bound on guest dt is
  MAX_DELTA_MS = 60_000. A game whose state machine assumes small frame deltas can be
  handed multi-second ones when WE stall. See plan/virtual-time.md.
- lastExpectedEspAfterReturn is set only for sync thunks, never async.

3.6 Thread Safety Rules

- Every code path that switches threads MUST call dispatcher.onThreadSwitch(oldId, newId)
  to save/restore lastExpectedEspAfterReturn per-thread. Missing this causes stale ESP →
  wrong post-return context → stack corruption → #GP.
- CreateThread must NOT call requestSwitch(). New threads are scheduled only at next quantum
  expiry or explicit yield — premature switch causes races before the creator sets up shared state.
- FS base (cpu.segment_offsets[4] = next.tebAddress) must be updated on every context switch.
  This is now CENTRALIZED in the single switch primitive `performSwitch` (all switch paths route
  through it: onThunkComplete and the spin-loop/blocked path in preemptAtTickBoundary). The legacy
  `switchToThread` no longer exists — do not re-introduce a second switch primitive that could drift.
  Characterized by tools/tests/scheduler-state-machine.test.ts (asserts FS base follows the resumed
  thread, alongside FPU/SSE restore + onThreadSwitch).
- Shared-register-file rule: all guest threads run over the single v86 register file, so
  EVERY piece of shared/lazy CPU state MUST be saved on preempt and restored on resume:
  - x87 FPU — CpuContext.fpu, fpu-helper fpuSnapshot/fpuRestore
    (8×F80 + stack_ptr + stack_empty + control/status).
  - SSE — CpuContext.simd, simdSnapshot/simdRestore (mxcsr@824 + reg_xmm@832, 132 bytes —
    8 XMM in 32-bit mode; the next v86 field is current_tsc@960, DON'T widen past 128 xmm
    bytes). v86 implements SSE/SSE2 and we advertise PF_XMMI*_AVAILABLE, so D3DX/CRT/engine
    SIMD all run over it. Save wherever CpuContext.fpu is saved; restore in restoreContext.
  - Lazy EFLAGS — v86 computes arithmetic flags lazily (flags[0] + flags_changed +
    last_op1/last_result/last_op_size); raw flags[0] is stale while flags_changed != 0.
    saveCpuContext must save cpu.get_eflags() (materialized); applyContextState must clear
    cpu.flags_changed[0] = 0 after writing flags (popf/update_eflags semantics).
  Missing any of these ⇒ a preempted thread resumes with another thread's FPU stack /
  XMM+MXCSR / flag source: non-deterministic float garbage (one-frame artifacts, sporadic
  NaN vertices) or a wrong branch/carry → random host-timing-dependent memory corruption.
  This class survives pipeline-level bisects — suspect context switching first.
- Self-restore optimization: if performSwitch picks the same thread, skip restore entirely —
  CPU state is already correct, RET N executes naturally.
- JS and the guest CPU share one worker thread, so a JS mem.set is atomic w.r.t. the guest —
  code writes need no locking. The hazard is INTERLEAVING: every await inside an async thunk is a
  yield point at which other guest threads execute over the address space being modified. Never
  split a guest-code write from its JIT invalidation across an await (see §3.1 coherence rule).

3.7 WASM Hypercall Tiers

Four-tier hierarchy — implement new hot paths here before adding JS thunks:
  Tier 1 (1–16):  Time, sync primitives, UI (GetTickCount, CS enter/leave, GetCursorPos, PeekMessage).
  Tier 2 (17–45): FPU/math (_ftol, _CI*, sin/cos/sqrt/pow/ceil/floor and friends).
  Tier 3 (51–62): String/memory (wcscpy/wcslen, memcpy/memset, strcmp/stricmp/memcmp).
  Tier 4:         JS fallback — try_dispatch() returns false → JS handles it.
JS implementations are mandatory fallbacks; never remove them.

3.8 Static-Library HLE — Scope Constraints

The `src/worker/core/hle-lib/` framework (signature detection + JMP-prologue patching +
`resolveAdditionalFunctions`; shipped descriptors live under `hle-lib/libs/`) suits
**stateless or simple-state APIs** — a function whose whole contract is one context struct
argument (zlib-style inflate). It does NOT work for APIs whose setup allocates internal
module controllers: the replacement handler would need those controllers' vtables in place
before returning, and mocking them is hundreds of LoC of version-specific code (confirmed
with libjpeg — `jpeg_create_decompress` wires 6-8 internal controllers, and downstream game
code checks one of those pointers and bails).

For complex-state libraries prefer **inner-loop hooking**: patch pure-compute leaf functions
(IDCT, YCbCr→RGB, Huffman decode) with WASM SIMD implementations that don't touch library
state — reusable, and the guest's own state machine stays intact.

Perf reality check: static-lib HLE can only shave the JS slice of a worker trace (a small
fraction of total time). Only pursue a target when profile data shows it on the hot path.

3.9 Comment Discipline

- Comments explain WHY / non-obvious invariants, not what the code already says. No
  war-stories, no changelog/incident narratives (dates, one-off measured counts, "an
  earlier version did X … root-caused … fixed by Y"), no multi-paragraph blocks.
- No removal tombstones: when you delete code, delete it cleanly — do NOT leave a comment
  saying "X removed / no longer here / used to do Y". The absence speaks for itself.
- Match the comment density of the surrounding code; a one-line note beats a paragraph.

4. Operational Workflow

Stack: TypeScript (Bun/Vite), WebGPU, AudioWorklet, React (Host).

Launching a WGB bundle (a `.wgb` is a store-only ZIP: manifest.json + registry.json + the game
files; see make-wgb/wgb.ts below):
  - Bare emulator + load any bundle by URL: open `?game=dev`, then `window.loadApp('<url>')`.
    Bundles served from `public/` resolve under `/apps/...`; point `public/apps/external-wgb`
    at a local WGB drop-folder (e.g. a symlink), so `window.loadApp('/apps/external-wgb/<name>.wgb')`
    loads a file dropped there. `loadApp` posts `{type:'load_bundle', url}` to the worker.
  - Registered game by id: `?game=<id>` (the host's game registry; `?game=dev` is the special
    bare/no-game id that just exposes `window.loadApp`/`worker`/`dbg`).
  - Local file (no server path): the host UI "Load File..." button → posts `load_bundle {blob}`.
  - Bundle behavior is driven by its manifest (RAM, OS, resolution, registry, `skipVideo`, args).
    Create/patch bundles with `make-wgb` / `wgb.ts` (below) — never hand-edit registry.json.

Debugging workflow — USE THE HARNESS. The AI-agent harness (`src/worker/harness/`, `src/harness/`,
`tools/harness.ts`, `window.__BS__.harness`) wraps the whole "load a game, make it do X, see what
happened" loop in fluent, self-judging verbs. Invoke the `/bringup` skill (`.claude/skills/bringup/`)
for the operational checklist; `bun tools/harness.ts up` does cold-to-ready, then e.g.
`harness().openWgb(..).waitForEvent('dialogShow').click('Play').tickFrames(120).expectSurfaceNonBlack('primary').state([..]).run()`.
Drive the emulator through the project's own CDP harness (`tools/harness.ts` / `window.__BS__.harness`),
NOT a browser MCP — an uncoordinated second CDP client fights the harness for the same tab. Several
HARNESS agents may share the one Chrome: `BS_TAB=<name>` (below) gives each its own tab. Load-bearing
facts the harness encodes (and the manual `dbg.*` fallback still needs):
  - Dev: `bun run dev` (:5174 plain HTTP by default — automation needn't clear a self-signed cert;
    `bun run dev:ssl` opts into HTTPS) +
    `bun run dev:sidecar` (:3001 dev sidecar — log archive + file writer + Range delivery of `.wgb`
    via `GET /wgb?path=`; `dev:logs` is an alias. Start it BEFORE streaming). The sidecar binds
    LOOPBACK only and confines `path=` to a root set (repo root + the realpath parent of
    `public/apps/external-wgb`, so `G:/WGB/**` keeps working); anything else needs `BS_WGB_ROOTS`.
    Its WebSocket refuses a foreign `Origin` — a browser page must not be able to write files.
    Kill a stale Vite via PowerShell
    `Get-CimInstance Win32_Process | ? CommandLine -match 'vite'` (git-bash `pkill` won't kill it) — but
    match the PID, not the pattern, when other agents are working: that filter kills EVERY Vite on the
    box. The same applies to the sidecar, and to every kill-by-pattern: match the PID you started.
  - `?game=dev` = the bare emulator exposing `window.loadApp/worker/dbg/__BS__`.
  - PARALLEL bring-up (the queue is mostly WAITING — a bundle load is gigabytes, a boot is minutes):
    `BS_TAB=<name>` binds every harness command to its own `?game=dev&bs=<name>` tab of the SAME Chrome
    and re-roots that run's evidence under `logs/<name>/` (screenshots, journals, dumps, and the sidecar's
    log archive). Two agents with different names never touch each other's tab or files; with `BS_TAB`
    unset everything is exactly as it was. Bring-up ONLY — parallel guests share the CPU, so every
    measurement (`trace`, any A/B timing) must run with one tab open; `harness trace` refuses otherwise.
  - Audio: needs a real gesture OR Chrome's `--autoplay-policy=no-user-gesture-required` (which
    `harness up` sets). Without it AudioContext stays SUSPENDED → SAB play cursor frozen → audio-gated
    logic stalls silently (frames render but the game never advances).
  - SEE pixels via `harness shot()` — the SCREEN (overlays composited), read from the mirror the
    present path keeps, because a presented WebGPU canvas is no longer readable and a presenter's
    own capture predates the composite. `shot({source:'layer'})` is the pre-composite game layer,
    labelled as such; `bun tools/harness.ts shot --verify` cross-checks every route against the
    browser's own capture. A specific guest surface/texture: `dumpSurface`/`textures` (or
    `__gdibDumpName` → GetDIBits PNG → `debug_png_dump` → sidecar `logs/debug/`).
  - KNOW WHICH SCENE you measured, before quoting a number from it: `sceneProbe` returns how
    much the frame is MOVING (mean luma delta on a coarse grid) plus what the D3D9 backend
    submitted, and `sceneCompare(a,b)` says whether two runs were looking at the same thing.
    An A/B whose arms sat on different screens produces perfectly plausible percentiles that
    mean nothing side by side, and nothing else in a run notices — this verb exists because a
    frame tail was once reported as "in a race" when the screenshot was the track-selection
    menu. `motion` near 0 is a static screen (a menu or a load), whatever the game.
  - Intros: a bundle's `skipVideo` makes MCI/Bink/Smack complete instantly.
  - ANY non-standard situation (froze / vanished / black frame / unexpected exit / wild EIP) → FIRST
    pull `report()` (CLI: `bun tools/harness.ts report`). One firehose-immune POJO with: CPU regs, the
    module-labelled guest call stack (`backtrace()`), the recent WinAPI ring (last thunks), the
    UNIMPLEMENTED-thunk registry (`stubs()`), recent page faults, and threads. The usual root cause of a
    game "gracefully vanishing" is a stub: it calls a vtable slot / export with no JS handler, gets a
    garbage return, and takes an "unsupported → exit(0)" branch — `stubs()` names it (e.g. a graphics-options
    screen → unimplemented `d3d9:CreateCubeTexture` → `exit(0)`) with the guest caller for `re`. A clean
    guest `ExitProcess` (no trap) also auto-logs `[EXIT-TRACE]`, but late teardown can drop it — prefer
    `breakOnApi('kernel32:ExitProcess')` (its snapshot carries `backtrace`+`lastThunks`) or `report()`.
  - Logs (megabytes/sec): don't grep the firehose — `logStats` (template-dedup summary), `watchLog(/re/)`
    (signal→event), `markLog`/`logsSince` (windows); the fault snapshot carries the log-ring tail. The
    dev sidecar (:3001) is the durable archive tier, started by `harness up` (detached, stdout to
    `logs/dev-sidecar.out.log` — never an inherited pipe nobody drains). Its in-memory buffer is
    BOUNDED: when the writer cannot write (full disk, deleted `logs/`) it drops the oldest lines,
    counts them, prints one degraded line per 10s, and writes an `[ARCHIVE GAP]` marker into the
    archive when it recovers — `GET /stats` reports buffered/written/dropped/lastError per session
    and `harness up` warns on it. A log window with no gap marker really is complete. It also serves
    bundles by Range (`/wgb?path=`) — deliberately NOT through Vite, whose dev server degrades on
    that route over a session and blows the io-worker's 30 s deadline (`SabIoSource: read timed out`).
  - RE the guest: the warm RE service (`tools/re/`, §14) — `re decompile/resolve/exportSymbolMap`
    (Ghidra headless writes to a file; stdout is lost). `re resolve <eip> --base <liveBase>` closes the
    wild-EIP→function loop; `re exportSymbolMap` feeds `loadSymbols`/`breakOnSymbol`.
  - Diagnostic discipline: confirm with DATA (a dump / a logged value), not reasoning about GDI/DC or
    vtable topology — the canvas-vs-selected-bitmap distinction and multi-DC composites mis-model easily.

Self-improvement (bake capability, don't relearn it): when you CLOSE a bug, ask what reusable harness
verb / `re` command would have shortened it — and ADD it. While debugging, if the existing verbs are
insufficient, EXTEND the harness (a new `cmds/*` module) rather than write a throwaway `cdp-*` probe;
the harness is the durable home for diagnostic capability, one-off probes are a smell. After fixing, keep
the reusable tool and delete the probe.

Quality Gate (mandatory order):
  1. bun tools/generate-index.ts
  2. bun tools/validate-signatures.ts
  3. bun tools/validate-struct-offsets.ts
  4. bun tools/validate-guest-code-writes.ts
  5. bun tools/validate-stub-tables.ts   (a stub table shadowing a real handler; ALSO one export
     key registered by two factories merged into the same generated index)
  6. bun tools/validate-data-export-binding.ts   (one address per HLE export: `hleImageExportAddress`
     stays private to the precedence owner, plus a pinned census of API-descriptor/registerDataExport
     doubles)
  7. bun tools/validate-api-export-uniqueness.ts   (a module descriptor declares each export
     name ONCE — a name declared twice lays two stub bodies at two addresses under one name,
     so the PE walk and `exportAddresses` can answer with different ones, and a title that
     compares GetProcAddress against its own IAT reads that as a hooked API)
  8. bun tools/validate-d3d9-export-collisions.ts   (the hand-composed d3d9 tables: a resource
     constructor has ONE owner, so merge order cannot pick the fallback)
  9. bun tools/validate-unimplemented-returns.ts  (a declared export with no handler must answer
     FAILURE — the default "zero" is SUCCESS under HRESULT/MMSYSERR/MCI/LSTATUS, so those
     descriptors must carry onUnimplemented, and a makeFunc factory must spread its overrides)
 10. bun tools/validate-file-cursor.ts
 11. bun tools/validate-jit-exports.ts   (checks the BUILT v86 artifact — skips cleanly if absent)
 12. bun tools/validate-guest-pointer-guards.ts   (ddraw + d3d9 HANDLER tables. It models
     `Iface_Method: (ctx, mem, args) => …`; the d3d9 backend draw paths take guest pointers
     too and are outside that model — a code-shape gap, not a scope one)
 13. bun tools/validate-guest-memory-borrow.ts   (raw guest-memory Proxy access confined to its owners)
 14. bun tools/validate-guest-memory-views.ts    (no PLAIN guest view stored past the turn that derived it)
 15. bun tools/validate-hypercall-abi.ts         (Rust/TS hypercall page offsets + handler ids agree)
 16. bun tools/validate-jit-shipping-config.ts   (the ONE shipping JIT envelope, tools/jit-config/shipping.mjs,
     is what PreemptionManager applies and what every offline arm calls "shipping")
 17. bun tools/validate-census-abi.ts            (opcode-census key layout agrees between opstats.rs and
     guest-opcode-classes.ts)
 18. bun tools/validate-tlb-mirror.mjs           (`tlb_data` has ONE writer, cpu::set_tlb_entry, in any
     assignment spelling — the permission bitmap is a mirror of it)
 19. bun tools/validate-eagl-read-cursor.mjs     (every function that CLEARS a TLB entry
     — `set_tlb_entry(page, 0)` — also drops the EAGL read cursor. That containment is the
     whole safety argument for the cursor outliving a hypercall; a fifth clearing site
     would otherwise let it answer from a page the CPU no longer maps, and the read would
     succeed with the wrong bytes)
 20. bun tools/validate-video-plane-policy.ts   (the video plane has ONE composite policy —
     `video/video-plane-policy.ts`. Six present paths reach the screen; when each decided for
     itself from "the plane still holds a bitmap" they disagreed about when it STOPS being on
     screen, and a finished movie covered the menu. Nothing outside `src/worker/video/` may
     reach `getOverlayService()`)
 21. bun tools/validate-wgsl-calls.ts            (every call to a WGSL helper we wrote passes the
     arity that helper declares — our shaders are template strings, invisible to the typechecker,
     and one bad call blackens a whole pass)
 22. bun tools/validate-d3d9-arena-abi.ts        (LayoutIdx order/length matches arena.rs
     LAYOUT_TABLE, and the arena exports in public/v86.wasm match the ones arena.rs declares —
     missing AND stale extras, so a not-rebuilt artifact cannot silently disable the arena)
 23. bun tools/validate-d3d9-capability-contracts.ts   (the MSAA/float/volume contracts are measured
     from the live device, not read off globalThis, and the probe is AWAITED as an unconditional
     statement before the device is published)
 24. bun tools/d3d9-parity/validate-caps.ts      (`bun run validate-d3d9-caps` — the name no longer
     predicts the path: the checked-in reference D3DCAPS9 blob AND the caps we answer with)
 25. bun tools/validate-snapshots.ts             (every toMatchSnapshot() has a TRACKED .snap: bun
     writes a missing snapshot and exits 0, so without the file the assertion asserts nothing)
 26. bun run gate:d3d9-capture                   (differential native-D3D9 capture. `report:d3d9-capture`
     is reporting-only and exits 0 for everything; this wrapper fails on an unreadable/invalid
     capture and on any divergence NOT recorded in tools/d3d9-capture-expected.json — the
     intentional ones of plan/dx9c-review-findings-2026-08-26.md §B2. Record a new intentional
     one with `--update-baseline`)
 27. bun run report:d3d9-wgsl-validator          (with BS_REQUIRE_WGSL_VALIDATOR=1, so a missing
     naga is an error instead of a silent skip)
 28. bun run typecheck
 29. bun test                                    (also with BS_REQUIRE_WGSL_VALIDATOR=1 — otherwise
     every describe.skipIf in wgsl-smoke.test.ts vanishes and the suite is green without it)

`bun run gate` runs all of it in order — including the test suite as the final step. CI runs
that same script, not a hand-copied subset (.github/workflows/ci.yml), so the two cannot drift.
`census-selftest` and `perm-map-differential` are NOT in it: they need the vendor build
(vendor/v86/build/libv86.mjs) and SKIP without it, so they are run by hand after a v86 rebuild.

A validator that cannot fail is worse than no validator: it converts an unchecked invariant
into a false assurance. When one of these passes, confirm it CAN fail — feed it the bypass it
is meant to catch — before trusting a green run.

Tooling:
  - analyze-trace.ts  — Chrome profiler trace → self/total time per thread, WASM breakdown
    (JIT blocks, io_port_write32, hypercall annotation), 2s-bucket timeline. Primary perf tool.
    Usage: bun tools/analyze-trace.ts <trace.json.gz> [--top N] [--thread worker|main|audio]
           [--budget-ms 33.34] [--range A-Bs] [--map blocks.json]
    Interpreting output: io_port_write32 in top → heavy thunks; jit_find_cache_entry → indirect
    jump pressure; wasm% > 85% → CPU bound in guest code, not JS overhead.
    FRAME TAIL: the render-frame stats (p50/p95/p99, frames over budget) come from the SAME
    module as the live harness `frameReport` (src/worker/core/frame-time-distribution.ts) — one
    definition, two callers, so a trace and a live window cannot disagree by rounding. Budget is
    `--budget-ms` or DERIVED from the observed cadence (never a hardcoded 30/60 fps); a
    percentile whose rank has no observation behind it prints `n/a`, not a number. WORST FRAMES
    adds per-frame stack attribution (JS/wasm split + leaf functions) — that, and GC, are what
    the trace can see and the live profiler cannot.
    GUEST ATTRIBUTION needs the `bottleship.hotblocks` mark to resolve `wasm-function[N]` →
    `module:rva` (v86 table indices ≠ Chrome's numbering, so the join is SAMPLED, never
    computed). `bun tools/harness.ts trace <sec>` now emits it inside the recording window; a
    trace without it prints an explicit "GUEST ATTRIBUTION: UNAVAILABLE" section rather than
    degrading silently to bare indices.
  - make-wgb — HIGH-LEVEL bundle creator. Takes a raw game dir + CLI flags, generates
    manifest.json + registry.json via JSON.stringify (guarantees correct \\ escaping),
    packs everything in one step. Use this instead of wgb.ts for creating new bundles.
    Usage: bun tools/make-wgb.ts <game-dir> <output.wgb> [flags: name/exe/resolution/bpp/ram/
           os/registry/args/skip-video/codepages/lcid/create-dirs — see the tool header].
    CRITICAL: Never write registry.json manually with shell heredocs or Write tool —
    backslash escaping is unreliable across editors/linters/hooks. Always use make-wgb
    or JSON.stringify in a script.
    EMPTY-DIR GOTCHA (a `.wgb` is a store-only ZIP — a ZIP has NO entry for an empty
    directory): an installer-created empty folder (e.g. `user\rosters`, `user\save\photos`)
    vanishes on pack, and the game's fopen("wb") into it then fails (Windows fopen does not
    mkdir parents) → silent, brutal-to-diagnose bugs (game writes nothing / a menu resets in
    a loop). make-wgb AUTO-DETECTS empty dirs in the source and adds them to
    `emulator.createDirs`; the worker recreates them at boot (ensureDirTreeSync/mkdir -p). If
    you pack from a source that already lost the empty dirs, pass `--create-dirs
    "user\rosters,user\save\photos"` explicitly. The manifest field is the sanctioned
    fix — it replicates the installer's on-disk layout, NOT a per-game hack.
  - wgb.ts — Unified WGB archive tool (list/cat/extract/replace/manifest/set-manifest/patch-manifest).
    Replaces pack-wgb, repack-wgb, extract-wgb, list-wgb. Store-only ZIP, own parser.
    Usage: bun tools/wgb.ts <command> <archive.wgb> [args...]
    Aliases: ls=list, x=extract, pm=patch-manifest.
  - patch-wgb-vram — VRAM override patcher for existing bundles.
  - build-ffmpeg-decoder/ — separate WASM build; rebuild only when decoder_api.c or build.sh change.

Archive / installer formats — USE OUR OWN READERS, never `apt install` a third-party unpacker.
  We ship a self-hosted, browser-safe format stack in `packages/formats/src/` (reusable core parsers)
  with thin Bun CLI wrappers in `tools/`. Reach for these BEFORE 7-Zip/cabextract/unshield/innoextract
  or a hand-rolled one-off parser — the whole point is that `.wgb` bring-up needs no external native tool
  and works headless (CI, cron, no root). Coverage:
    - zip/          — store + deflate ZIP (also the `.wgb` container).
    - cab/          — Microsoft Cabinet (`MSCF`), incl. one APPENDED to a Win32 SFX stub
                      ("PackageForTheWeb" self-extractors). CLI: `tools/cab-extract.ts`. NONE + MSZIP.
    - installshield/— InstallShield Cabinet (`ISc(`, v5 AND v6+) — the `data1.hdr` + `data{N}.cab`
                      layout behind most 1998–2003 game installers. Handles chunked raw-deflate,
                      de-obfuscation, LINK_PREV dedup, volume-split files, MD5 verify.
                      CLI: `tools/unshield-extract.ts <data1.hdr> <out> [--list]`.
                      (NOT the same as MSCF — 7-Zip/cabextract cannot read `ISc(`.)
    - inno/         — Inno Setup headers (LZMA1/2 via the Rust WASM backend). CLI: `tools/inno-inspect.ts`;
                      end-to-end GOG installer → bundle: `tools/gog-to-wgb.ts`.
    - freearc/      — FreeArc (`.arc`, srep+LZMA) used by some repacks.
    - rar/          — RAR5 layout + STORED data (the store-only `.rar` a game drop wraps an
                      installer in), incl. multi-volume `.partN.rar`. CLI:
                      `tools/rar-extract.ts <a.rar> <out> [--list]`. RAR's own compression,
                      solid groups, encryption and RAR 1.5–4.x are REFUSED by name.
    - iso/          — ISO9660 + BIN/CUE disc images. CLI: `tools/iso-to-wgb.ts`; `tools/bin2iso.ts`.
    - mpq/          — MoPaQ (`MPQ\x1A`, v0/v1), incl. one APPENDED to a Blizzard self-extracting
                      installer, and MPQs nested inside it. Storm crypt + PKWARE DCL implode
                      (`explode.ts`) + zlib. CLI: `tools/mpq-extract.ts <a.mpq|installer.exe> <out>
                      [--list]`. An installer payload has NO `(listfile)`: names come from the
                      install script inside it, and `readBlockByIndex` recovers a block's key from
                      its own sector table when there is no name to hash.
    - unpack/       — shared native codec backend (LZMA1/LZMA2/srep) built from the Rust crate
                      `tools/build-unpack-streaming` → `public/unpack-streaming.wasm`, plus the
                      dependency-free primitives (RandomAccessSource, Crc32/Md5/Sha1) every reader uses.
  A WinZip-SFX/PFTW `.exe` is a ZIP/CAB wrapping an InstallShield disk set: unwrap the outer archive
  (zip/cab), then run `unshield-extract` on the inner `data1.hdr` to get the real game files.
  New container/compression not covered above? EXTEND this stack (a new `formats/<fmt>` core + a CLI
  wrapper), don't shell out to a system binary — same discipline as extending the harness: each new
  invariant we hit becomes a durable, self-hosted capability, not an external dependency or a throwaway.
  The `/repack` skill (`.claude/skills/repack/`) operationalizes the whole installer→`.wgb` flow
  (which reader for which container, make-wgb usage, and the empty-directory pitfall) — invoke it when
  packing/repacking a bundle or diagnosing one that boots but won't save.

v86 core (vendor/v86/ — a git submodule; clone with --recurse-submodules):
  - Use bracket notation (this["prop"]) for all properties accessed from TS code.
    Closure Compiler advanced optimizations rename dot-notation properties → silent runtime breakage.
  - Build: vendor/v86/build-wasm.sh. Generated Rust files (jit.rs etc.) are not in git —
    run gen scripts before cargo build.

Memory Validation: Use address-guard.ts / mem-accessor.ts checks in debug builds;
  never bypass in production without explicit rationale.
