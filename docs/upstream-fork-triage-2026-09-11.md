# Fork harvest: amirrezaask/bottleship (triaged 2026-09-11)

Durable record of a one-pass review of the downstream fork. Nothing here is committed; the four
applied items sit uncommitted in the working tree (see §2).

## 1. What the fork is

`https://github.com/amirrezaask/bottleship`, by Amirreza Askarpour, fetched here as git remote `amir`.
46 commits, all authored 2026-09-10, largely agent-written. Two lines of work:

- **`amir/main`** — six stacked performance PRs: `bulk-memory`, `string-memory`, `unaligned-memory`,
  `rep-memory` (four v86 Rust patches, applied as a stack), plus TS-side pixel/DXT kernels and a
  handful of small Win32/TS fixes. Evidence throughout is synthetic microbenchmarks run on shared
  GitHub runners; their own docs disclaim any FPS claim.
- **`amir/codex/gamebox-runtime`** and **`amir/codex/igi-aot`** — a separate line: Max Payne 2
  bring-up, an embeddable "GameBox" player, and DDraw/D3D7 perf work.

Merge base with us is `a7c8543` (our `main` at the time). Our `develop` has moved a long way since,
so always diff a fork change against the **current** file (`git show develop:<path>`), never against
the merge base — otherwise you rediscover things we already fixed.

Useful commands:

```
git diff a7c8543 amir/main -- <path>
git diff amir/main amir/codex/igi-aot -- <path>
git show amir/main:<path>
gh pr view <N> -R amirrezaask/bottleship --json body -q .body
```

## 2. The structural fact that governs every Rust pick

**Their v86 patches target v86 pin `9770402`. Our `vendor/v86` submodule is 56 commits ahead at
`c44906f`** (EAGL read cursor, d3d9 arena, branch hints, relaxed-FPU work, `tlb_data` single-writer,
dispatch ids past 4096). Verified by hand:

| patch | applies to our tree |
|---|---|
| `bulk-memory.patch` | no |
| `string-memory.patch` | no |
| `unaligned-memory.patch` | no |
| `rep-memory.patch` | yes (but depends on the three above — they are a stack) |

So every Rust pick is a **manual rebase and re-review**, not a `git apply`. Two further build facts
that bit this review and are worth not re-deriving:

- `vendor/v86/build-wasm.sh` **unconditionally mirrors** `build/v86.wasm` into `public/v86.wasm`
  **and** `dist/v86.wasm` (the script says the mirror is deliberate: a stale `public/v86.wasm`
  surfaces as "Missing import" at worker startup). "Build but don't run `build:v86`" is therefore
  **not** a way to protect the shipped artifact. Anything that needs a custom engine must go through
  the source-pair lab route (`__v86LabWasmPath`, `emulator.worker.ts:2487`), and even that does not
  remove the mirror side effect of the build itself.
- `vendor/v86/build/v86.wasm` already exists and is byte-identical to `public/v86.wasm`
  (2600550 bytes). Tooling that wants "the current engine" should point at the vendor path, not the
  shipped one.
- clang 21 and Java 21 are installed, so a local build is possible when it is actually wanted.

## 3. What we took

All four are **uncommitted in the working tree**.

### 3.1 `unaligned-surface-conversion-crash` — DDraw surface conversion threw on an unaligned source

Files: `src/worker/modules/ddraw/gpu-texture-utils.ts`,
`tools/tests/ddraw-surface-conversion-alignment.test.ts`.

Fixed in place; their wrapper and file split were **not** ported. New
`srcFastPathOk(mem, offset, pitch, bytesPerPixel)` sits with the read-leg converters, mirroring the
existing `alignedDstView` predicate on the write leg. `convertSurfaceToRGBA` passes it as
`skipBoundsCheck` to the RGB565 / ARGB8888 / XRGB8888 converters only — the 555/1555/4444/RGB888/
PALETTE8/LUMINANCE8 and generic paths index bytes in both branches and stay on `inBounds`.
`canWriteInPlace` now also requires `(outBuffer.byteOffset & 3) === 0`, and on failure **both**
`rgbaBuffer` and the derived `rgba32` are retargeted at the scratch (the original port plan only
retargeted `rgba32`, which would have split RGB888/generic writes into a different buffer). Two
unconditional slow-path `Logger.warn`s demoted to `Logger.verbose` (a misaligned surface converts
every frame).

Falsification: with the fix neutralized in place, all 9 test cases fail with
`RangeError: Byte offset is not aligned` out of the typed-array construction; restored, 9/9 pass.
The test compares each unaligned layout against the same pixels converted from a packed aligned
copy, so it also catches a wrong-output demotion, not just the absence of a throw. The predicate
demotes nothing that works today: for 2/4 bpp the ULTRA path already requires `isPacked`.

### 3.2 `guest-memory-subview-cache-key` — plain-view cache keyed on buffer identity alone

File: `src/worker/core/memory/guest-memory.ts` (+ `tools/tests/guest-memory-plain-view.test.ts`).

`toPlainGuestMemory`'s cache hit now also requires `raw.byteOffset === _lastPlain.byteOffset &&
raw.length === _lastPlain.length`. Pre-fix, a request for the 20..32 subview got the cached 4..12
one back — a silent wrong-bytes read. Confirmed by running the new test body against
`git show HEAD:...guest-memory.ts` in the scratchpad: `expect(second.byteOffset).toBe(20)` receives 4.

### 3.3 `stale-guard-reflect-receiver` — the stale-view Proxy broke live views

Same two files. `makeStaleGuard`'s get trap uses `Reflect.get(target, prop, target)`, not the Proxy
as receiver. With the Proxy as receiver, `length`, `byteLength` and `buffer` all throw
"Receiver should be a typed array view" (the Proxy has no `[[TypedArrayName]]` slot); `subarray()`
and integer indices survive. So the pre-fix guard TypeError'd on the first `mem.length` of a **live**
view. Restoring the old trap shape gives 9 pass / 1 fail at exactly the new case.

### 3.4 `font-resource-w-variants` — `AddFontResourceW` / `RemoveFontResourceW` were undeclared

Files: `src/worker/api/gdi32.api.ts`, `src/worker/modules/gdi32/painting-misc.ts`.

Two `makeFunc(..., 1)` declarations next to the A twins; the four exports are now thin
decode-and-delegate arrows over shared `addFontResourceByPath` / `removeFontResourceByPath` helpers
(A decodes with `Marshaler.readString`, W with `readWideString`). Async-thunk shape unchanged;
additive into the same `registerPaintingMiscExports` table, so §3.2's stub-shadowing rule is not
engaged. **No test** — the only cheap assertion would restate the diff, and the behavioural part
needs a live VFS/FontFace the gdi32 unit harness does not stand up.

Honest scope caveat: the Sea Dogs motivation the fork cites is **not** supported — that defect is
TTFs missing from the bundle, not a W-variant gap, and no catalog title has been observed calling
`AddFontResourceW`. This is spec completeness under §3.0, not a known-game fix.

## 4. Backlog — tier 2 (needs a v86 rebase and/or a wasm rebuild)

### 4.1 `resident_span()` guard soundness — VERDICT: sound on our tree

The non-faulting per-page residency/permission probe that every `bulk-memory` fast path rests on.
Checked against our `cpu.rs`: the accept mask is strictly more conservative than our own
`translate_address` (same `TLB_VALID`/`NO_USER`/`READONLY` shape plus rejects `TLB_IN_MAPPED_RANGE`
and, for writes, `TLB_HAS_CODE`); the A/D-bit question resolves by construction (dirty is set only
when `for_writing`, and `TLB_READONLY` is stamped on every non-write translation, so a stored entry
lacking `READONLY` proves a dirtying write walk already ran); `tlb_set_has_code` keeps `HAS_CODE`
live across all linear aliases, so the write-side reject really does preserve §3.1 coherence;
`validate-tlb-mirror.mjs` bans **assignments** only and this is a read; `validate-eagl-read-cursor.mjs`
keys on `set_tlb_entry(page, 0)` and `bulk_memory` neither installs nor clears entries.

**Blocker.** The verdict covers the `tlb_data`-bodied version only. The port plan swapped the body
to a `perm_map` derivation, and `perm_byte_of` carries no `DBG_WRITE_WATCH` bit — a perm_map-bodied
write guard silently blinds an armed write watch. Either keep the `tlb_data` body verbatim or
re-carry the write-watch reject and re-verify. Separately, nothing is measurable until call sites
land: the fork's only evidence is a microbenchmark, which does not satisfy §3.4, and taking it needs
a vendor rebuild plus a `public/v86.wasm` swap (see §2).

**Next action.** Only if a `bulk-memory`-class fast path is ever actually wanted. Then: port
`bulk_memory.rs` as a new file, body verbatim, `pub mod bulk_memory;` after `pub mod perm_map;` in
`cpu/mod.rs` (their `mod.rs` hunk will not apply).

### 4.2 Compiled-CPU differential test rig (`tools/runtime-test/`)

The one artifact in the fork whose value does not depend on a perf claim, and it fills a gap we have
on record: our own v86 expect suite is non-functional (fails at test 1, snapshots stale from fork
drift), so today a v86 CPU change is validated by running a game.

**Verified by hand, not assumed.** The three files (`bulk-machine.mjs`, `rep-machine.mjs`,
`rep-native-oracle.c`) were ported verbatim and run on `develop` with **zero modification**: every
hard-coded v86 state offset is still correct on our 56-ahead fork (`reg32`=64, `flags_changed`=100,
`flags`=120, `instruction_pointer`=556), `run_guest_until` still has the 5-arg signature,
`hp+8` == `OFF_HC_ENABLED`, `hp+0x100` == `OFF_HC_DISPATCH_TABLE`, and the PR-specific stats getters
are all `?`-guarded so they return null. `rep-native-oracle.c` compiled with the installed clang 21
and a real differential ran clean: 144 cases ({cmps,scas,stos} x {1,2,4} x {repe,repne} x residues
0-3 x {full-run, early-stop}) comparing ECX, ESI/EDI deltas, `EFLAGS & 0xcd5` and an FNV hash of
destination bytes — **0 mismatches against a real x86-64 CPU**. Backwards `movsd` (DF=1), a
page-crossing `stosd`, residue-1 `repe cmpsd` and a `jit:true` arm all agree. It fails loudly: a
comparator bug printed `MISMATCH cmps 1 eq 1 off 2 stop -1`, naming op/size/residue.

**Blockers and plan corrections** (these are why it is tier 2, not applied):

- Do **not** run `build-wasm.sh` as the fork's plan says — see §2. No build is needed; point
  `V86_TEST_BINARY` at the existing `vendor/v86/build/v86.wasm`, and make it mandatory rather than
  defaulting to `public/v86.wasm` (a default on the shipped copy means "run after a v86 rebuild"
  silently validates the previous artifact — the exact hazard `validate-d3d9-arena-abi` exists for).
- Their `IDS` 82/83 are wrong for us (ours are `handle_get_capture` / `handle_resume_thread`); 51-62
  match. This only affects `bulk-machine.call()`, never the REP path.
- `validate-hypercall-abi.ts` only *parses* constants and exports none — import from
  `src/worker/core/cpu/hypercall-data.ts` instead.
- The native oracle rejects `op > 2`, so `movs` — the most common REP in real guests — has no
  hardware oracle and must be model-asserted.
- Default is `disable_jit:1`; tests must run both arms or they assure half of what they appear to.
- Expected yield today is near zero by construction: `git log 9770402..HEAD -- src/rust/cpu/string.rs`
  is empty, so the rig asserts untouched upstream code. Its value is as a companion to a REP change,
  or as the seed of a native-silicon oracle (§5.1), not as a standalone win.

**Next action.** Land as `tools/runtime-test/` + a `cpu-runtime-test` package script, documented
next to `census-selftest` / `perm-map-differential` as a **post-v86-rebuild manual step**, and kept
out of `bun run gate` (it needs the vendor build). Prove it can fail first by flipping one expected
flag bit.

## 5. Backlog — tier 3 (needs real-game evidence or a design decision first)

### 5.1 Native x86 silicon oracle (`rep-native-oracle.c` generalized)

We have **no** native-silicon oracle for CPU semantics. `tools/aot-oracle` proves AOT == our JIT,
`decoder-oracle.mjs` checks decode against capstone, `d3dx-oracle.ts` calls the real `d3dx9`,
`win32-arity-oracle.ts` reads real headers — every one validates a layer above or beside the CPU,
and the AOT oracle is self-referential: if v86's REP or flag semantics are wrong, both arms are
wrong together. That is the failure our own record already names
(`v86-relaxed-fpu-two-implementations.md`: "fpu-relaxed-diff is blind to shared bugs"). A native
oracle is the only instrument in either repo that can catch a bug shared by every v86 arm.

Verified compatible with our fork at `c44906f` (same offsets and exports as §4.2). Best attack —
"it runs with `disable_jit=1`, so it validates the interpreter, not the arm that runs games" — dies
for REP specifically: `gen_string_ins` falls through to `call_fn1/2("cmpsb_repz", ...)`, so the JIT
arm calls the same `string.rs` body.

**Blocker / caveats.** Repoint the default binary off `public/v86.wasm` (same reason as §4.2), or
the instrument reads the previous artifact and reports "passed" for code it never executed. And the
"extends to x87 / shifts / SSE" generalization does **not** hold with the rig as written — those are
inline-emitted by the JIT (the relaxed-FPU two-implementations class), so it needs a `jit:true` arm
the plan never mentions.

**Next action.** Build it only alongside a real CPU change worth validating. Suggested shape:
`tools/x86-oracle/{rep-oracle.c, lib/machine.mjs, lib/rep-machine.mjs, verify-rep.mjs}`, the fork
files stripped of their bulk/string hypercall paths but keeping `createMachine`, `image`, `paging`,
`map`, `warm`, `guest`, `reg`, `state`, `execute`, the `0xb077` io hook (it asserts no host dispatch
leaked) and `test_hook_did_finalize_wasm`. Binary into the scratchpad, not the repo. Prove it can
fail by narrowing the flag mask to `0xc55`. One line in CLAUDE.md §4 next to `census-selftest`;
**not** in `bun run gate`.

## 6. Rejected — do not re-propose

### v86 Rust (`bulk-memory` / `string-memory` / `rep-memory` / `unaligned-memory`)

- **Guard should read `perm_map`, not raw `tlb_data`.** Inverts the source it cites:
  `docs/performance/sota-roadmap/03-RESULT-perm-map.md` is our own measurement of this exact
  mechanism, and perm_map wins only on the latency-bound `heap_walk` (0.91) and **loses** on dense
  throughput (`stack_mix --mix 80`, 1.03); the live stand recorded 0.9626, a net loss, against a
  ±3% A/A floor. A 256-page `resident_span` loop is the dense regime. Also `PERM_MAP_READS = false`
  and `codegen.rs` returns early unless enabled, so the shipping JIT read path loads `tlb_data`
  directly — reading `tlb_data` is the configuration-independent choice.
- **`TLB_HAS_CODE` bail-out instead of invalidating.** Logic is fine; the proposal is not. Its cited
  proof (`check_tlb_invariants`) is `if !CHECK_TLB_INVARIANTS { return; }` with
  `CHECK_TLB_INVARIANTS = false`, and the body is `dbg_assert!` (compiled out in release). The
  invariant is upheld only by convention in `tlb_set_has_code`. The landing site (`PERM_HAS_CODE`) is
  a mirror we already know drifts (`jit.rs:5964`), whose differential is not in the gate.
- **Handler ids 82/83 collide** with our `handle_get_capture` / `handle_resume_thread` — true, and
  84-127 is free. What refutes the pick is its safety claim: gate step 15 would **not** have caught
  it. `validate-hypercall-abi.ts` harvests TS ids only from `const HANDLER_X = N;` (the fork uses
  bare literals in `HANDLER_MAP`), and its dispatch rule is existence-only — it never compares names,
  so a head-on collision passes green. Taking the plan with that sentence attached installs a false
  assurance over the very invariant it concerns.
- **`resident_span` as a new primitive.** We already have `translate_address_no_fault(address,
  for_writing) -> Option<u32>` — speculative, non-faulting, no A/D, no TLB fill — and it is *better*
  (falls back to `do_page_walk` on a cold page where `resident_span` just returns false). It lacks
  identity/HAS_CODE checks: that is a 5-line extension of a reviewed primitive, not a new file that
  independently re-decodes `tlb_data` outside every validator we have.
- **SIMD string scan/compare kernels.** Hard blocker: `resident_span` does not exist in our tree, so
  every stage is a dependent of an unlanded sibling. The PR's own stated cause of the win ("removal
  of repeated emulated memory accesses") is the **EAGL read cursor** we already ship — with a policy
  switch, a verify/mismatch oracle, an invalidation counter and a dedicated gate whose whole safety
  argument is cursor-lifetime containment. A second long-lived host read pointer in a new file has
  none of that. And the proposed ledger check cannot fail: `OFF_HC_HANDLER_CALLS` bumps once per
  `try_dispatch` when `handled`, blind to whether the SIMD kernel or the scalar loop answered —
  intention accounting labelled "executed" (§3.4).
- **`copy_string()` bulk strcpy.** Our `safe_write8`/`safe_read8` begin with `ga_note_write()` /
  `ga_note_read()` and `try_dispatch` runs inside `ga_enter(GA_HYPERCALL)`, so today every byte is
  censused. A raw `copy_nonoverlapping` increments nothing, and none of this exists at their pin —
  after it lands, a guest-access census over a string-heavy window returns a plausible number that
  no longer measures hypercall traffic. Also the named rollback (`setWasmStringWritersEnabled`)
  reverts to the **JS** handler, not the Rust scalar loop, so the §3.4 disabled-path arm is
  unrunnable as planned. Landable only with `ga_note_*` bulk accounting and
  `set_string_memory_enabled` wired as the real A/B switch.
- **New ids 84/85 for `strchr`/`strrchr`.** Not a port — the plan writes new Rust from scratch and
  deliberately drops their SIMD kernel, so we inherit new unreviewed core code and none of the
  (already absent) evidence. No profile shows these on a hot path. Unpinned semantic divergence:
  JS `findChar` caps at `0x100000` and still returns a hit found before the cap, while a scalar Rust
  loop modelled on `handle_wcschr` breaks and writes EAX=0. Works correctly today via Tier 4.
- **SIMD REP CMPS/SCAS.** Correctness could **not** be refuted — `compare()` never leaves the caller
  resuming the scalar loop with un-advanced physical pointers, lane math, operand order, `Rep::Z/NZ`
  polarity and flags ownership all hold. Refuted on execution: the plan's safety step ("don't
  overwrite `public/v86.wasm`") is unachievable (§2); the step-2 gate cannot be executed because
  `guest-opcode-classes.ts` puts `0xa4-0xa7` and `0xaa-0xaf` in **one** "string" class dominated by
  the ops this does not touch, and opstats counts instructions, so one `rep scasb` is one count
  regardless of ECX; the only element-level instrument lives inside the code being ported (circular).
  Priors cut against it (`ffmpeg-simd-build-no-gain`: bit-identical vectorization, 15.3 vs 14.9 ms).
  Also `if count < lanes { return None }` means short `repne scasb` — where most CRT string traffic
  lives — never takes the fast path, and this would be the first hand-written SIMD intrinsic anywhere
  in the v86 CPU core.
- **REP STOSW/STOSD bulk fill.** Mechanism sound; the plan's "mandatory edit (1)" is based on a
  misread — a `span()` rejection already falls into the scalar loop whose `write*_no_mmap_...` calls
  `check_in_guest`, so bumping OOB from `span()` would **double-count** every rejection and corrupt
  the census it claims to protect. Unmeasured, ships `ENABLED = true`, and STATS count page chunks
  rather than bytes stored (§3.4 ledger).
- **`#[inline(never)]` on compare/fill.** The entire justification is "they measured it". The commit
  that adds the attributes **deletes** the A/B workflow 3m25s after that workflow was added — two
  full Rust→wasm builds plus node and headless-Chromium benches cannot complete in 3.5 minutes, and
  no result artifact exists anywhere in `amir/main`. Carry the attributes as a starting configuration
  if the parent ever lands; do **not** carry the "measured" prose.
- **Native REP oracle as a new capability (`already_have: no`).** Wrong: `vendor/v86/tests/qemu/test-i386.c`
  already is a native-x86 differential over rep/repz/repnz cmps/scas/stos/movs at b/w/l, both DF,
  counts 0..4097, unaligned offsets, printing the same register tuple, and the Makefile already diffs
  it; `tests/nasm/gen_fixtures.js` generates fixtures by running on the real host CPU under gdb.
  Worse, their oracle hashes only the destination span — never the padding, never `left` — so a
  vectorized REP writing past the tail **passes**, which is exactly what the qemu test catches. It is
  also a 64-bit-mode oracle sold as ground truth for a 32-bit guest.
  (This does not contradict §5.1: what is worth building there is the *rig plus a corrected oracle*,
  not this file as shipped.)
- **Page-bounding the unaligned scalar REP loop.** Prescribed implementation hangs the guest:
  `count_until_end_of_page` assumes an **aligned** operand, which is precisely what is false on this
  branch. Forward with `addr & 0xFFF == 0xFFD`, size 4 gives `3/4 == 0` — zero budget, `*instruction_pointer
  = *previous_ip`, zero progress, infinite spin. The aligned path can use that formula only because
  alignment guarantees no element straddles a page (which is why MOVS needs the extra straddle guard).
  Also self-admittedly unmeasured, and it would propagate the aligned path's EFLAGS divergence into
  the one path that is currently correct.

### TS pixel / DXT kernels

- **DXT boundary span validation.** Premise false: our decoder does not write NaN garbage on a short
  source — every OOB read passes through a bitwise op, so `undefined` → 0 and you get opaque black
  (DXT1) or all-zero (DXT5), the same pixels their zero-fill decline produces. Their own acceptance
  test already passes on `develop`. The `srcPitch < rowBytes` decline is a live regression: three
  call sites feed a guest/file-supplied pitch, and a legacy `width*2` DXT1 pitch would blank a whole
  texture that today decodes its present block row.
- **Tolerate an unaligned `dst` in `decodeDxtToRgba`.** Unreachable — the only entrypoint always
  builds `out` as a fresh allocation or a `subarray(0, n)` at offset 0; all ~20 call sites confirmed.
  It trades a loud `RangeError` naming the exact line for a silent per-upload `width*height*4`
  scratch allocation inside the texture path. Meanwhile `texture-formats.ts:1001` drops `byteOffset`
  entirely (silently wrong, not throwing) and the real hazard on the same line — the `Uint32Array`
  is sized by element count, not `dst.byteLength`, so a short `dst` writes past the caller's view —
  is the half the proposal walks past.
- **Colour key dropped for block-compressed Blt sources.** Observation correct, fix not takeable:
  step 1 regresses unkeyed Blts from a surface with a stale `srcColorKey`; step 2 has no oracle (a
  FOURCC surface has no RGB masks, so the comparator would key off invented ones); step 3 misreads a
  documented safety stamp, and `rgbaScratch` is a shared cache read by seven sites that validate
  version only. Real DirectDraw does not convert DXT→RGB in a Blt at all, so there is no faithful
  reference. Only takeable residue: make the compressed branch **warn** when handed a colour key it
  cannot honour.
- **Aliased src/out corruption guard.** Unreachable by construction (`mem` views the WASM buffer;
  every real `out` provider allocates a private one, and two call sites discard the return value and
  upload the scratch in place). The proposed "fall back to scratch, copy back" would turn a function
  that structurally never writes guest memory into one that blind-writes into a guest-backed
  destination with no `isValidAddress` check.
- **"Staging overhead beats SIMD" as a negative-results entry.** Violates that file's own append rule
  (workload SHA, arms, raw values, N, spread, ledgers, environment; "if a field was not recorded,
  write `not recorded`") — the proposal explicitly says not to copy their numbers, leaving a belief
  filed in the registry of measured things. And the generalization is backwards for us: their staging
  cost comes from a standalone module with its **own** linear memory; our sanctioned mechanism
  (§3.7) lives inside v86's memory and addresses guest RAM directly, paying zero staging. Filing it
  as a caution would attribute a cost to the hypercall layer that it structurally does not have. The
  adjacent lesson is already ours (`ffmpeg-simd-build-no-gain`).

### TS small fixes

- **`Number.isInteger` guards on hypercall register/unregister.** The stated failure model is wrong
  for our tree: `dispatchEntryOffset()` returns NaN for NaN, and the DataView spans the whole guest
  buffer, so `setUint8(NaN, ...)` does `ToIndex(NaN) = 0` and stomps guest linear byte 0 — a LOW_MEM
  write, not "silently unregisters a hypercall". The guard proposed is on `functionId`, while the
  only id that could matter is `handlerId`. The claimed `dbg.hcon/hcoff` reachability is also false
  (they replay already-validated pairs). And the remedy widens a silent early-return — the fix for
  "silent wrong" is more silence. Their `4096` literal would regress our ext-id range.
- **`clampAniso` NaN guard.** All three producers are integral by construction, and the config path
  is already validated at the boundary (`snapTo` rejects non-finite and snaps to `[1,2,4,8,16]`).
  Worse, `qualityToken()` deliberately reads the **raw** value, so a NaN config would make the
  memoisation token `NaN !== NaN` and rebuild the sampler every draw, silently, forever — the guard
  suppresses only the loud half (the WebGPU validation error, which we already census) and leaves
  the silent half.

### codex branches (DDraw perf, Win32)

- **MegaBatch bind-group cache.** Key is sound (view identity stable, samplers deduped by spec), but
  our `megaBatchEnabled` gate turns the path **off** for any draw with FFP lighting, a texture
  transform, camera-space texgen, or `CLIPPLANEENABLE != 0`, so a lit D3D7 title never enters it —
  "hundreds per frame" is unmeasured. We already have the right shape 300 lines up in the same file
  (`WeakMap<pipeline, Map<buffer, Map<view, LruCache<sampler, bindgroup>>>>`, allocation-free); the
  port drops a second string-keyed LRU with a hand-rolled id allocator on a path it calls hot.
  And the lifetime story is fiction: `clearCache()` has **zero callers**.
- **D3D7 `DrawPrimitiveVB` / `DrawIndexedPrimitiveVB` fast paths.** Our own comment already records
  the measurement: one Lock/Unlock pair per draw on the D3D7 dynamic-VB idiom, ~91 per frame — two
  orders below the plan's own "thousands per frame" bar and three below the 393K calls that justified
  the existing `DrawPrimitive` fast path. The economics also invert: a VB draw's body is vertex
  fetch + FVF decode + batching + upload, not a pointer write. Their code also reads `esp+4..+28`
  unguarded where every neighbouring fast path guards, and it duplicates `dataPtr + startVertex *
  vertexSize` arithmetic that four thunks compute (Device3 and Device7 deliberately differ).
- **Drop the `await` on `DeferredUploadManager.flushAll`.** The body really has no awaits, and the
  fork misses a second caller. But §3.6's hazard is a guest-code write split from its invalidation,
  and this path writes only GPU textures — so §3.6 argues nothing here. The entire benefit is one
  Promise plus one microtask per frame, orders below our recorded 3.6% floor. Meanwhile it pulls
  `executor.flush()`, `prefetchRotatedForReadback` and the frame pacer a turn earlier in the Flip
  tail — the one path already on record as order-fragile (`ddraw-readback-prefetch-never-hits`).
- **Sparse-indexed-draw census counters.** "Insert verbatim" measures the wrong population: on
  `develop` the GPU-conversion decision is `gpuVertexThreshold` (MAX_SAFE_INTEGER when
  `forceCpuVertexPath || blendActive || preTransformed`), not the bare constant, and their gather
  refuses blended draws — so `sparseDraws` counts draws the optimization could never take, inflating
  the opportunity. The kill criterion pins no scene (a menu returns ~0 for unrelated reasons — what
  `sceneProbe`/`sceneCompare` exist for), and `profiler.increment()` no-ops when disabled, so a
  forgotten enable reads identically to "no sparse draws".
- **Thunk arena capacity guard.** The plan does not fix the bug it describes: the collision boundary
  is the 1MB reserve end, and the plan throws only at `MEM_THUNK_CODE_BASE + 16MB` — 15MB past the
  point where the arena is already stomping — and merely warns at the reserve. The premise is also
  inaccurate: `allocAt` already drags the THUNK_CODE frontier past the cursor, and
  `install-com-vtable.ts` registers each batch with the right kind. **The real defect is narrower
  and worth fixing separately:** the two PE-loader stub-batch registrations
  (`pe-loader.ts:1781`, `:2022`) call `allocAt(...)` with **no kind** → defaults to HEAP → the
  0x21xxxxxx address is out of the HEAP bucket → throws, and the throw is swallowed by a bare
  `catch {}`. Pass `"THUNK_CODE"`. Also worth doing: log the arena high-water mark in the boot
  memory-map snapshot. Consumption is ~16 bytes per distinct imported export; a 5,000-import title
  uses ~8% of the reserve.
- **1bpp DIBSection reads.** The gap is real but the evidence is misattributed (the cited line is in
  `CreateBitmap`, which already decodes 1bpp MSB-first) and `null` is a **fallthrough**, not a dead
  end — `resolveBitmapRgba` continues to `compatibleBitmap`, `obj.pixels` and the rendered canvas.
  The patch runs first and would **preempt** that, returning the raw guest bits — which are
  `mem.fill(0)` at creation and never written back (`writeBackDibSectionRect` is 32bpp-only). A
  1bpp DIBSection that today renders what was drawn would render opaque black. It also introduces a
  second, contradictory mono colour model alongside the decided nt5src-derived one in `gdi-blit.ts`.
- **Canvas → 1bpp DIB write-back.** Write-only asymmetry is data loss: there is no 1bpp reader, so
  the canvas is never materialized from the bits, and one TextOut quantizes a blank canvas over the
  **whole** bitmap (their writer does `width*height`, not a rect), zeroing mask bits the guest wrote
  via SetDIBits. The real generic bug is different: `gdi-text.ts` imports no write-back **at all**,
  so text never writes back at *any* depth — the cheap one-owner fix is a `writeBackDibSectionRect`
  call with the text bounding rect in `textOut`/`drawText`. Their colour→mono rule (nearest-RGB
  against the palette) is also not GDI's (DC background → index 0).
- **`bulk-machine.mjs` / `rep-machine.mjs` as a general CPU test machine.** Distinct from §4.2, which
  takes the rig *for REP with the ids corrected*: as a general-purpose machine it lies quietly. Its
  `IDS` table addresses `GetCapture` and `ResumeThread` and nothing errors; `warm()` passes
  `ENTRY = 0x100040` as `eip_offset_in_page`, which must be `< 0x1000`, and discards the return, so
  a failed pre-translation ORs 0x100040 into EIP invisibly; and `installFaultGate` points vector 14
  at a DPL-3 selector with cpl=3, which v86 takes as the **same-privilege** branch — a v86-behaviour
  fixture, not a ring-transition test. The genuinely ours-to-gain part is ~12 lines (`map()` and the
  GDT/IDT setup) to sharpen `perm-map-differential`'s triple-fault assertion.
- **Three "negative tests" + a §3.4 amendment.** Factual premise wrong:
  `tools/tests/guest-code-jit-invalidation.test.ts` is a bun test, runs as gate step 30, and is
  already written in the proposed non-effect shape. The revocation/neighbour shape is already the
  stated purpose of `perm-map-differential.mjs`. And the proposed amendment would broaden §3.4's
  ledger rule with memory/paging-specific assertions ("the next page's PTE", "CPL3 refusal") that
  are undefined for the dominant fast-path population here (d3d9 WBUF/FastPath setters, the four
  hypercall tiers) — a universal rule that is inapplicable to most of its subjects gets ritually
  satisfied, which weakens §3.4. Keep one idea for later: a canary immediately **outside** the
  declared extent, which a checksum over the declared extent structurally cannot express.
- **Build-provenance manifest next to the wasm.** Premise false: `tools/bench-v86/source-pair/serve.ts`
  already emits `runtime-provenance.json` (repo HEAD, vendor HEAD, wasm sha256, dirty-diff hash, git
  status), refuses artifacts that drift from the pinned sha, and `codegen-bench.ts` verifies the
  sha256 of the engine the browser **actually instantiated** — measurement-time identity, strictly
  stronger than a build-time sidecar. Placing a manifest in `public/` manufactures our dominant bug
  class, since `build-wasm.sh` and the bench kit both hand-swap that file. The rustc pin cannot be
  set honestly (nothing records what built the current shipped wasm, and a guessed pin changes
  codegen under every baseline in `negative-results.md`).

## 7. Working-tree hygiene during this review

Another agent was live in the same tree throughout. Nothing was committed, staged, reverted or
stashed; `public/v86.wasm` was not touched and no v86 build was run. Scratchpad probes used for the
falsification steps were deleted afterwards. Files changed by this harvest are exactly the six named
in §3.
