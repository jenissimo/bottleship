# D3D8 Parity Audit — Sampler State (filters / address / mip / LOD / anisotropy / border)

Scope: `src/worker/backends/webgpu/d3d8/d3d8-sampler.ts`, `shared/dx-sampler.ts`,
`shared/mip-utils.ts`, D3D8's two draw paths through `ddraw/ddraw-backend-executor.ts`
(fixed-function, shared with DDraw/D3D7) and `d3d8/d3d8-programmable-draw.ts`
(vertex/pixel shader), against DXVK `src/d3d8/d3d8_device.cpp` +
`src/d3d9/d3d9_device.cpp`/`d3d9_sampler.h`.

**Audit only — no files modified, emulator not driven.**

## Headline

D3D8 sampler decode does not have *one* implementation, it has **two**, and they disagree
with each other on enum numbering:

- `d3d8-sampler.ts` (used only by `d3d8-programmable-draw.ts`, i.e. vertex/pixel-shader
  draws) correctly uses D3D8/D3D9 `D3DTEXF_*` numbering (NONE=0/POINT=1/LINEAR=2/ANISO=3),
  per its own header comment.
- **All of D3D8's fixed-function draws** (`drawPrimitive`/`drawIndexedPrimitive` calling
  into the shared `DDrawWebGPUExecutor`) go through `ffp-stages.ts` +
  `ddraw/bind-group-manager.ts`, which decode with the **D3D7** `D3DTFN_*/D3DTFG_*/D3DTFP_*`
  numbering (`sampler-constants.ts`: POINT=1/LINEAR=2/ANISOTROPIC=3 for min/mag,
  **NONE=1/POINT=2/LINEAR=3 for mip**). This is the exact numbering mismatch
  `d3d8-sampler.ts`'s own header comment warns about ("D3D7 is NONE=1/POINT=2/LINEAR=3") —
  the warning just wasn't checked against the *other* D3D8 draw path.

Because min/mag `D3DTEXF_*`/`D3DTFN_*` values happen to numerically coincide
(POINT=1, LINEAR=2, ANISOTROPIC=3 in both schemes), min/mag filtering is accidentally
correct on the FFP path. **Mip filtering is not** — the schemes diverge there and it is
silently wrong (see F1).

The measured XIII frame (`min:2,mag:2,mip:2,addressU:1,addressV:1`) went through the
*programmable* path (`decodeD3d8TssSampler`, correct numbering), which is why it read as
plausible — it is genuinely fine. Any D3D8 title (or UE2 draw call) that falls back to the
fixed-function path is exposed to F1 below without anyone having looked at it yet.

## Verdict table

| State | Programmable path (`d3d8-sampler.ts`) | Fixed-function path (`ffp-stages.ts` + `bind-group-manager.ts`) |
|---|---|---|
| ADDRESSU/V (WRAP/MIRROR/CLAMP) | IMPLEMENTED | IMPLEMENTED |
| ADDRESSU/V BORDER | SILENTLY-WRONG (collapsed to clamp-to-edge, no color) | SILENTLY-WRONG (collapsed to clamp-to-edge, no color) |
| ADDRESSU/V MIRRORONCE | PARTIAL (collapsed to mirror-repeat, wrong beyond [-1,1]) | MISSING (not in the switch; falls to default clamp-to-edge) |
| ADDRESSW | MISSING (hardcoded WRAP, TSS has no `D3DTSS_ADDRESSW` — see note) | MISSING (no W axis modeled at all; only relevant for volume textures) |
| D3DTSS_BORDERCOLOR | MISSING (not read) | MISSING (not read) |
| MAGFILTER/MINFILTER decode (D3DTEXF_* numbering) | IMPLEMENTED (correct numbering) | **SILENTLY-WRONG numbering, accidentally correct values** (min/mag POINT/LINEAR/ANISOTROPIC happen to share bit patterns with D3D7's) |
| MIPFILTER decode | IMPLEMENTED | **SILENTLY-WRONG** — D3D7 vs D3D8/9 mip enum numbering genuinely diverges (see F1) |
| D3DTEXF_NONE vs "never set" for mip | IMPLEMENTED (`mipV === D3DTEXF_NONE`, and 0 default coincides) | PARTIAL — coincides only because `|| D3DTFP_NONE` masks the same 0 case; a real `D3DTEXF_POINT`/`D3DTEXF_LINEAR` value is misdecoded (F1) |
| D3DTSS_MIPMAPLODBIAS | MISSING (not imported/read) | MISSING (not read) |
| D3DTSS_MAXMIPLEVEL | MISSING (`maxMipLevel: 0` hardcoded) | MISSING (not read) |
| D3DTSS_MAXANISOTROPY | SILENTLY-WRONG (real value never read; `gameAnisotropy` hardcoded to 16 whenever ANISOTROPIC is requested) | SILENTLY-WRONG (same shape: `maxAnisotropy` field exists in `StageSamplerState` and *is* read/propagated correctly here, actually — see F5 nuance) |
| Per-stage independence | **MISSING** — all 8 stages share stage 0's sampler (`decodeD3d8TssSampler(adapter.textureStates, 0)`) | IMPLEMENTED for stages 0–3 (`MAX_FFP_SAMPLED_STAGES`); stages 4–7 are arithmetic-only by design (pre-existing, non-sampler-specific scope limit) |
| Defaults at device creation | IMPLEMENTED (`initDefaultStates()`: MIN/MAG=POINT, MIP=NONE, ADDRESS=WRAP per stage, matches D3D8 spec) | same underlying state array — IMPLEMENTED |
| Defaults after Reset | IMPLEMENTED (`initDefaultStates()` re-run in `reset()`) | same |
| Defaults after state block Apply | IMPLEMENTED (TSS writes journal through `recordStateBlock`/`applyD3D8StateBlockEntries`, generic keyed recorder) | same |

## Prioritised findings

### F1 — SILENTLY-WRONG: fixed-function MIPFILTER uses D3D7 numbering on D3D8's D3D9-numbered TSS values

- **Where:** `src/worker/backends/webgpu/ddraw/ffp-stages.ts:272`
  (`this.mipFilter[s] = textureStates[base + D3DTSS_MIPFILTER] || D3DTFP_NONE;`) feeding
  `src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts:4873`
  (`sp.mipFilter = stages.mipFilter[s] || D3DTFP_NONE;`) feeding
  `src/worker/backends/webgpu/ddraw/bind-group-manager.ts:120,61-68`
  (`toWebGPUMipmapFilter`: `D3DTFP_POINT(2)→"nearest"`, `D3DTFP_LINEAR(3)→"linear"`,
  everything else → `"nearest"` + `mipNone` computed from the same D3D7 constants at
  `bind-group-manager.ts:123`).
- **D3D8/D3D9 numbering actually on the wire** (per DXVK, `D3DTEXTUREFILTERTYPE` is shared
  across D3D8 and D3D9): `D3DTEXF_NONE=0, POINT=1, LINEAR=2, ANISOTROPIC=3`
  (`d3d8-sampler.ts:21-24`, `d3d9-sampler.ts:29-32` — both correct).
- **D3D7 numbering the FFP consumer assumes** (`sampler-constants.ts:41-43`):
  `D3DTFP_NONE=1, POINT=2, LINEAR=3`.
- **Symptom:** a D3D8 title's fixed-function draw that calls
  `SetTextureStageState(stage, D3DTSS_MIPFILTER, D3DTEXF_POINT /* = 1 */)` gets decoded as
  `D3DTFP_NONE` (also 1) by the FFP path → the sampler is pinned to the base mip level
  (`lodMaxClamp=0`), i.e. **the game's requested mip filtering silently disappears**.
  `D3DTEXF_LINEAR (=2)` similarly misreads as `D3DTFP_POINT (=2)` → mips are selected but
  with nearest, not linear, mip transition. Only `D3DTEXF_NONE (=0)` accidentally survives,
  because `0` is falsy and both consumers default the falsy case to "no mip filtering" —
  the one case that happens to want exactly that.
- **Why it wasn't caught by the measured XIII frame:** XIII's misrendering draws go through
  `d3d8-programmable-draw.ts` (shader-based, UE2 uses VS/PS), which uses the correct
  `d3d8-sampler.ts` decode and never touches this path. Any D3D8 draw that stays
  fixed-function (a simpler title, or a UE2 draw call that falls back to FFP for some
  reason) is exposed.
- **Fix sketch:** `ffp-stages.ts`/`bind-group-manager.ts` are the *shared* D3D7/DDraw
  decode — correct for genuine D3D7/DDraw callers, wrong for D3D8. The D3D8 fixed-function
  entry point (wherever `d3d8-device-adapter.ts` hands `textureStates` to
  `renderer.drawPrimitive`) needs its own decode step using `D3DTEXF_*` numbering (reuse
  `decodeD3d8TssSampler`'s filter/mip mapping, or translate D3D8's raw `D3DTEXF_*` values
  into the D3D7 `D3DTFN_*/D3DTFG_*/D3DTFP_*` vocabulary before writing into the same
  `textureStates` array/before calling `ffpStages.resolve`) — do **not** patch
  `ffp-stages.ts` itself, that would break real D3D7/DDraw titles which legitimately use
  the D3D7 numbering.

### F2 — MISSING: D3DTSS_BORDERCOLOR never read on either D3D8 path

- **Where:** `d3d8-sampler.ts` never imports/reads `D3DTSS_BORDERCOLOR` (index 15,
  `sampler-constants.ts:20`); `ffp-stages.ts`/`bind-group-manager.ts` likewise never read it.
  Both paths collapse `D3DTADDRESS_BORDER` straight to `"clamp-to-edge"`
  (`d3d8-sampler.ts:46`, `bind-group-manager.ts:56`) with **no** border colour applied.
- **Ground truth:** DXVK forwards `SetTextureStageState` 1:1 to D3D9's
  `SetSamplerState`/`D3DSAMP_BORDERCOLOR`; DXVK's D3D9 layer implements border colour via
  `SamplerUsesBorderColor` (`d3d9_device.cpp:7307`) and a dedicated shader/sampler path —
  it is a real, load-bearing part of D3D9 (and by inheritance D3D8) semantics, not cosmetic.
  **WebGPU has no `clamp-to-border` address mode at all** — DXVK's approach (a real border
  colour) is not natively representable; the faithful workaround is the one this codebase
  already built for D3D9 (see "Inherit from D3D9" below): keep a native `clamp-to-edge`
  sampler but detect out-of-`[0,1]` UVs in the shader and substitute the decoded border
  colour before the sample (or after, selecting between sample and border constant).
  Collapsing straight to clamp-to-edge is silently wrong whenever the border colour differs
  from the texture's edge texel (e.g. a transparent-black border used for a decal/light
  cookie's falloff) — the edge texel bleeds outward instead of fading to the border colour.
- **Fix sketch:** thread `D3DTSS_BORDERCOLOR` (and D3DTADDRESS_BORDER as a distinct mode,
  not pre-collapsed) through both D3D8 decode paths into `SamplerSpec`, exactly as
  `d3d9-sampler.ts:64-67,108` already does (`addressMode` returns `"d3d9-border"`;
  `borderColor: get(D3DSAMP_BORDERCOLOR) >>> 0`). The shared `dx-sampler.ts` type already
  supports this (`borderColor?: number`, `DxSamplerAddressMode` already includes
  `"d3d9-border"`) — D3D8 just isn't populating it.

### F3 — SILENTLY-WRONG: D3DTSS_MAXANISOTROPY value discarded, aniso forced to a fixed 16 (programmable path)

- **Where:** `d3d8-sampler.ts:63-74` — `anisoRequested = minV === D3DTEXF_ANISOTROPIC || magV === D3DTEXF_ANISOTROPIC`,
  then `gameAnisotropy: anisoRequested ? 16 : 1`. The actual `D3DTSS_MAXANISOTROPY` DWORD
  (index 21) is never read.
- **Symptom:** a title that sets `MINFILTER=ANISOTROPIC` with `MAXANISOTROPY=2` (a common
  "light" anisotropic setting to save bandwidth) gets 16x applied instead — not a crash,
  but not faithful, and it silently changes GPU cost/behavior versus what the game asked
  for. Compare `d3d9-sampler.ts:83,105`, which reads and clamps the real value
  (`Math.max(1, get(D3DSAMP_MAXANISOTROPY) >>> 0)`, `unsupportedFeatures` when >16).
- **Fix sketch:** decode `D3DTSS_MAXANISOTROPY` in `decodeD3d8TssSampler` the same way
  `decodeD3d9Sampler` does, including the `d3d9-anisotropy-limit` unsupported-feature flag
  for values above WebGPU's 16x cap.
- **Note:** the fixed-function path (`bind-group-manager.ts:116-126`,
  `ffp-stages.ts:273`) *does* read `D3DTSS_MAXANISOTROPY` and passes the real value through
  — so this specific defect is isolated to the programmable path; it just means the two
  D3D8 draw paths disagree with each other on anisotropy fidelity too.

### F4 — MISSING: per-stage sampler independence on the programmable (shader) path

- **Where:** `d3d8-programmable-draw.ts:296-299`:
  ```ts
  // Programmable layout has one shared sampler binding — same parity debt as D3D9 (stage 0 TSS).
  state.sampler = this.samplerCache?.tryAcquire(
      decodeD3d8TssSampler(adapter.textureStates, 0),
  ) ?? null;
  ```
  Every texture stage bound to a programmable draw samples through **stage 0's** filter/
  address/mip state, regardless of what stages 1–7 actually requested.
- **Comment already flags this as a known debt**, but mischaracterizes current D3D9 status:
  D3D9's executor (`d3d9-device.ts:8940`, inside a per-stage loop calling
  `decodeD3d9Sampler((type) => this.getSamplerState(stage, type))`) and
  `d3d9-backend-executor.ts` (`progCacheStageSamplers`, a per-stage-slot cache keyed
  alongside per-stage texture views) **already have real per-stage samplers** — the D3D9
  parity work referenced in the task closed this gap for D3D9 but the comment in D3D8 was
  not updated / D3D8 was not brought along.
- **Symptom:** any D3D8 shader-based draw that legitimately uses different filter/address
  state on different stages (e.g. a lightmap sampled with CLAMP while the base texture
  wraps, or a detail texture with different min/mag) gets the wrong sampler on every stage
  but 0. Correct-looking on titles where all stages happen to share stage-0 settings
  (plausibly including the audited XIII frame, which only reported one set of values) —
  exactly the kind of gap that survives a spot check.
- **Fix sketch:** mirror the D3D9 shape — loop stages 0..`PROG_BIND.MAX_TEX-1`, call
  `decodeD3d8TssSampler(adapter.textureStates, stage)` per stage, acquire/cache one
  `GPUSampler` per stage, and extend `state.sampler` (singular) to a per-stage array the
  bind-group builder consumes — same as `d3d9-backend-executor.ts`'s
  `samplers`/`progCacheStageSamplers` plumbing.

### F5 — MISSING: D3DTSS_MIPMAPLODBIAS and D3DTSS_MAXMIPLEVEL never read on D3D8 (either path)

- **Where:** `d3d8-sampler.ts` doesn't import `D3DTSS_MIPMAPLODBIAS`/`D3DTSS_MAXMIPLEVEL`
  at all; `maxMipLevel: 0` is hardcoded (`d3d8-sampler.ts:75`). `ffp-stages.ts`/
  `bind-group-manager.ts` don't read either state either — `getOrCreateSampler` has no
  LOD-bias or lodMinClamp parameter.
- **Ground truth:** both are ordinary, commonly-used D3D8/D3D9 TSS/SAMP states — LOD bias
  in particular is used by mundane things like decal/detail-texture layering and any
  "sharpen distant mips" tuning; DXVK forwards both 1:1 to D3D9 (`d3d9_state.h:282` reads
  `maxAnisotropy`/etc. straight from sampler state — the header comment in
  `sampler-constants.ts:13-15` even names the MIPMAPLODBIAS index and calls out its own
  historical off-by-one bug reading index 19 as anisotropy, showing this index has already
  bitten this codebase once).
- **Note:** `shared/dx-sampler.ts` already carries `mipLodBias`/`mipLodBiasBits` and
  `maxMipLevel` fields end-to-end (`resolveDescriptor` at `dx-sampler.ts:203-207` applies
  `lodMinClamp` from `maxMipLevel`, and the D3D9 shader emitter applies `mipLodBias`
  explicitly since WebGPU samplers have no LOD-bias field) — the shared plumbing is
  already there; D3D8 simply never populates the `SamplerSpec` fields.
- **Fix sketch:** read `D3DTSS_MIPMAPLODBIAS` as an IEEE-754 float bit-cast (same
  `Uint32Array`/`Float32Array` reinterpret `d3d9-sampler.ts:87-89` uses) and
  `D3DTSS_MAXMIPLEVEL` as a plain DWORD in `decodeD3d8TssSampler`; for the fixed-function
  path, either extend `getOrCreateSampler`'s parameter list or route it through the shared
  `DxSamplerCache`/`SamplerSpec` path instead of its own hand-built `GPUSamplerDescriptor`
  fields (see "Inherit from D3D9" below — this is really the same root cause as F1/F2).

### F6 — PARTIAL: MIRRORONCE degraded differently on the two D3D8 paths, and worse than D3D9's

- **Where:** `d3d8-sampler.ts:42-44` maps `D3DTADDRESS_MIRRORONCE` to `"mirror-repeat"`
  (wrong outside `[-1,1]` — real MIRRORONCE clamps after one mirror, `mirror-repeat`
  mirrors forever). `bind-group-manager.ts:51-58`'s `toWebGPUAddressMode` switch has
  **no MIRRORONCE case at all** — it silently falls to the `default: "clamp-to-edge"`
  branch, which is a different (also wrong) approximation on the same enum value depending
  on which D3D8 draw path executes it.
- **Ground truth / better path already built:** `d3d9-sampler.ts:58-61` preserves
  MIRRORONCE as the explicit `"d3d9-mirror-once"` tag for WGSL-side emulation
  (`clamp(abs(coord), 0, 1)` around a native clamp sampler) rather than picking either
  crude approximation.
- **Fix sketch:** same remediation as F2 — thread the `"d3d9-mirror-once"` tag (already
  typed in `shared/dx-sampler.ts`) through both D3D8 decode paths instead of two different
  ad hoc collapses.

## What the D3D8 path should inherit from the already-landed D3D9 sampler work

The D3D9 sampler stack (`d3d9-sampler.ts` + `shared/dx-sampler.ts` + the D3D9 shader
emitter) is materially more complete than either D3D8 path, and every gap found above has
a D3D9 analog that already works:

1. **Border colour and mirror-once as first-class, shader-emulated address modes**
   (`"d3d9-border"`/`"d3d9-mirror-once"` in `DxSamplerAddressMode`), instead of collapsing
   both to `clamp-to-edge`/`mirror-repeat` at decode time. `shared/dx-sampler.ts` already
   has the types and the `unsupportedFeatures`/`tryAcquire` plumbing to detect and refuse
   gracefully; only the WGSL lowering (`d3d9/shader/emit/tex.ts`) needs an equivalent on
   the D3D8/DDraw shader emitters, or — cheaper — the D3D8 decode should hand its
   `SamplerSpec` through the *same* code path D3D9 uses for FFP-equivalent draws instead of
   through `bind-group-manager.ts`'s parallel, simpler `toWebGPUAddressMode`.
2. **MIPMAPLODBIAS and MAXMIPLEVEL decode.** `decodeD3d9Sampler` reads both and populates
   `mipLodBias`/`mipLodBiasBits`/`maxMipLevel` on `SamplerSpec`; `decodeD3d8TssSampler`
   should do the same (same TSS indices, same IEEE-754 bit-cast trick).
3. **Real MAXANISOTROPY value + `d3d9-anisotropy-limit` capability refusal**, instead of
   D3D8's programmable path hardcoding 16.
4. **Per-stage sampler binding**, not one shared sampler for the whole draw
   (`progCacheStageSamplers` in `d3d9-backend-executor.ts`) — D3D8's programmable path
   (`d3d8-programmable-draw.ts`) is the one place that visibly says "same parity debt as
   D3D9" in a comment that is now stale; D3D9 already closed it.
5. **A single decode discipline.** D3D9 has exactly one TSS/SAMP-to-`SamplerSpec` decoder
   (`decodeD3d9Sampler`) used everywhere sampler state is needed. D3D8 has two decoders
   with two different (and for mip filtering, actually incompatible) enum assumptions. The
   long-term fix for F1 specifically, and for keeping F2/F3/F5/F6 from re-diverging between
   the two D3D8 draw paths, is consolidating D3D8 fixed-function sampler decode onto
   `decodeD3d8TssSampler` (or a shared helper it and the FFP path both call) instead of
   letting `ffp-stages.ts`/`bind-group-manager.ts` keep guessing which DX version's TSS
   numbering they were handed.

## Not covered / needs live confirmation (out of scope for this static audit)

- Whether any real D3D8 title actually exercises the fixed-function path for textured
  draws (vs. always compiling a trivial pass-through shader) — this determines how often
  F1 fires in practice. `harness stubs()`/`breakOnApi` on a title suspected of FFP D3D8
  rendering would confirm.
- Whether `D3DTSS_MAXMIPLEVEL`/`MIPMAPLODBIAS` are actually set by any bundled D3D8 title,
  since F5 is invisible unless a game calls `SetTextureStageState` with those types.
