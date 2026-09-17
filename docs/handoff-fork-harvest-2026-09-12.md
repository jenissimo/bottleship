# Handoff: the amirrezaask fork harvest (2026-09-12)

Everything below is **committed on `develop` but not pushed**, and one obligation is
outstanding before it should be.

## 1. The message that has to go out first

**Write to Amirreza Askarpour (github.com/amirrezaask) before pushing.** His address is
public on that profile.

Why it matters: our licence is Apache 2.0, so reuse is permitted and this is not a
permission question. But he **never opened an upstream PR** — 39 commits on his fork's
`main` and 17 more on its `codex/*` branches, all self-merged over there. The work was
done in public and never offered to us, so taking it quietly is the part that stings even
though the licence allows it. Four commits here carry his `Co-Authored-By` trailer; that
is the fallback, not the good outcome. The good outcome is he opens the PRs himself and
the authorship is native.

Draft, ready to send as an issue on his fork (lower friction than email, and public, which
is itself a form of credit):

> Hi Amirreza,
>
> I maintain bottleship upstream. I went through your fork properly this week rather than
> skimming it, and I wanted to reach out before anything of yours ends up in our history.
>
> The guarded bulk-memory and REP kernels are good work, and the part I liked most was not
> the speedups: it was `tools/runtime-test/` and `rep-native-oracle.c`. Validating REP
> semantics against real silicon is something we did not have, and our own v86 expect suite
> has been broken for a while, so that filled a real hole. I extended it with backwards
> (DF=1) runs and page-edge placement and it has been running 32k cases per change.
>
> Two things from your side that I should pass back. Your `diff.test.mjs` builds its
> expected data with `const idx = i`, which ignores direction — it only stays correct
> because `backwards` is always 0 there. And your pixel kernel's colour key zeroes the
> whole pixel, while upstream deliberately clears alpha only, since the blit shaders still
> compare against the source colour.
>
> Separately, reading your changes led us to two real upstream bugs: a pair of `allocAt`
> calls that could only ever throw inside a bare `catch {}`, and an AIL master-volume
> getter that returned a constant, so every Miles title's volume slider was inert.
>
> Our v86 submodule is 56 commits ahead of the pin you patched against, so none of your
> patches applied and I rebased the kernels by hand. I would rather you got the credit
> natively than as a trailer on my commits: would you like to open the PRs upstream
> yourself? If you would rather not, I will land them with `Co-Authored-By: you` and the
> source commits named in the bodies. And if you would prefer we did not use the work at
> all, say so and we will not.
>
> Either way, thanks — this was worth the read.

If he declines, the commits can still be dropped: nothing is pushed.

One honest note to carry forward: the measured benefit is **nil so far** (§4). The message
above does not claim otherwise, and it should not be edited to.

## 2. What is committed, and who is credited

Main repo, `f7e9fcd..bc4e7df`. Four carry `Co-Authored-By: Amirreza Askarpour`:

| commit | | |
|---|---|---|
| `f7e9fcd` | bulk-memory leaves behind an engine ABI gate, and a native oracle | credited |
| `b540be3` | plain guest view identified by its extent, not its buffer | ours |
| `4e2c444` | stub-DLL code reserved as THUNK_CODE, not thrown into a bare catch | ours |
| `d911141` | text writes back to its DIB section; monochrome sections | credited |
| `a1370f5` | Rust/WASM DXT and surface-conversion kernels, plus an alignment fix | credited |
| `663f324` | one master volume behind both Miles ABIs; real VCM/AVI answers | ours |
| `99775b4` | the triage doc: what was and was not taken | ours |
| `3d9ac3b` | ship the engine carrying the kernels | credited |
| `bc4e7df` | census the kernels, and the A/B that found no gain | ours |

`vendor/v86`: `7ef1ec92` (the four kernels) and `95802bcd` (the rebuilt artifact), both
credited.

The three marked "ours" are our own bugs that his fork merely pointed at. Pointing at a bug
is not co-authorship of the fix; their bodies say where they were found and nothing more.

**`1df308a` in the same range is NOT from this work** — it is the other agent's
render-worker commit. Trailers cannot distinguish us; go by subject.

## 3. Do not disturb

A second agent has been working the same tree throughout and still has ~125 uncommitted
files, including `package.json` and `src/worker/core/cpu/hypercall-data.ts`, which also
carry changes of ours. Those two were committed by hand-building the index from `HEAD` plus
only our hunks, leaving their work untouched in the working tree. **Never `git add -A`
here.** Enumerate paths.

## 4. What is still owed

- **The message in §1.** Before any push.
- **No performance claim is supported.** The four kernels are live in `public/v86.wasm`,
  correct, and each has an ABI getter and a `set_*_enabled` kill switch. But the A/B found
  the difference inside the noise floor on the title where they fire hardest — see
  `docs/performance/guarded-kernels-ab-2026-09-12.md`. Leaving them on costs nothing;
  claiming a win is not defensible from this data.
- **`bulk_memory` has never executed on a real title.** It did not fire once on Morrowind.
  It needs a software-blit DDraw game or something decompressing through the CRT before
  anyone can say whether it earns its place.
- **Frame time is unmeasured.** Everything so far is load-time.

## 5. Verification anyone can repeat

```
bun run test:rep-differential      # 32400 cases against this machine's x86
bun run test:string-differential   # 792 cases against the scalar handlers
```

Both need `V86_TEST_BINARY` pointed at a build carrying the kernels; the first also needs
`REP_ORACLE`, built from `tools/runtime-test/rep-native-oracle.c` with
`-D_CRT_SECURE_NO_WARNINGS`. Neither is in `bun run gate` — both need a vendor build, like
`census-selftest` and `perm-map-differential`, which also pass.

`bun tools/harness.ts run tools/harness/kernel-census.harness.ts` with `WGB=<bundle>` prints
each kernel's hit and decline ledger for a title. Run it before proposing any work here: a
counter that does not move is the answer.

---

## 6. Round two (2026-09-17): the fork's 11.09–16.09 work

The fork branches from our **`main`**, which has not moved since 2026-07-15 while `develop`
is 449 commits ahead. That is the governing fact for everything below: most of what looks
like a new fix over there is a bug this tree already fixed, independently, months later.
Diff against `develop`, never against his base.

Eight commits landed after §2's harvest. Reviewed; two were taken.

**Taken** (`53a52d7`, `06c6bb0`):

- `commitPages` — preserve the walker's A/D bits, flush the TLB only on a real mapping
  change, and route the recommit zeroing through `invalidateGuestCode`. From his
  `840c586a`. His version does not port: it keeps a fastmem-generation bump we already
  removed, and calls `cpu.jit_dirty_cache` directly. `tools/tests/page-table-commit.test.ts`
  fails 3/4 when neutralized in place.
- `GetProcAddress` by ordinal now resolves the canonical export name. From his `1c549da6`.

**Already ours, do not re-take.** Each was a `main`-era bug we fixed on `develop`:
the SEH catching-frame relink (`1657bf8`, 21.08 — he re-derived it on the same game,
Serious Sam, and his version relinks unconditionally where ours only undoes its own
unlink); HMODULE-scoped export resolution (`export-resolver.ts` has no unqualified
fallback); `ModuleRegistry` keying on the basename, so his full-path reverse lookup
solves a problem we cannot have; VC6 `struct _stat` at 36 bytes; `VirtualAlloc`
reserve-without-commit decommitting (`markDecommitted`). `resetNativeQsort` at process
reset is deliberately NOT ours — see the reasoning at `crtdll.ts:232`.

**Refused.** `src/worker/core/game-fixes/gta-san-andreas-timing.ts` patches the guest's
`.text` at a hardcoded address behind a SHA-256 of the exe (and a second one for FX
quality); `max-payne-tree.patch` does the same inside v86. Flat §3.0, and both write
guest code outside the §3.1 chokepoint.

**Left on the table, in rough order of interest:** `PageTableManager` commit/mismatch
counters (ledger discipline on a path we now have opinions about); `io-worker`'s batched
range prefetch that keeps two transport slots free for synchronous guest faults (we have
`SabIoSource: read timed out` on record); `translation-cache.ts` for the §5 AOT track; the
d3d9 `geometry-upload-batch` / `guest-staging-pool` / `triangle-indices` / `surface-blitter`
set, which arrives with tests.

**GameBox**, for the record, is not a format of ours and not a rename of `.wgb`: it is a
host product that embeds bottleship as a pinned engine — directory bundles served by HTTP
Range, Ed25519-signed catalogs with a local trust store, and per-title sidecars
(filesystem priority, GPU pipelines, prepared AOT) produced offline. His `91dae3bb` is the
end state of that idea: rip out runtime hotness profiling entirely so the only optimized
path is what the compiler prepared ahead of time.

**§1 still stands.** Nothing is pushed, and the message has not gone out. It now covers
more of his work than when it was drafted.
