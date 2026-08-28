# D3D8 ↔ D3D9 unification map

Source: the uncommitted working-tree D3D9 parity/correctness pass (`git diff --stat` against
`src/worker/backends/webgpu/{d3d9,shared,ddraw}/**`, ~8.5k insertions across 39 tracked files
plus ~25 new untracked D3D9-only files). This document maps what D3D8 (`d3d8/**` +
`modules/d3d8/**`) should inherit from it, and where the two backends duplicate logic that
should live once in `shared/`.

## 0. The dispatch fact that shapes everything below

`D3D8DeviceAdapter` (`src/worker/backends/webgpu/d3d8/d3d8-device-adapter.ts`) routes every draw
through `isProgrammable()`:

- **Vertex/pixel-shader draws** → `D3D8ProgrammableRenderer`
  (`d3d8/d3d8-programmable-draw.ts`), which is a thin shim over the **D3D9** stack:
  `D3D9BackendExecutor`, `D3D9CommandRecorder`, `buildColorTargetState`/`computeBlendKey` from
  `d3d9/d3d9-blend.ts`, `AlphaTest` from `d3d9/shader/sm-wgsl`, `DxSamplerCache` from
  `shared/dx-sampler.ts`. This path **already gets every D3D9 fix in this pass for free** —
  blend/stencil/MRT, sampler sRGB/border/LOD-bias plumbing, format-support checks, etc.
- **Fixed-function (FVF-only, no shaders) draws** — the majority of real D3D8 titles — →
  `this.renderer`, which is `DDrawWebGPUExecutor`
  (`ddraw/ddraw-backend-executor.ts` + `ddraw/pipeline-factory.ts` + `ddraw/shader-generator.ts`
  + `ddraw/ffp-stages.ts`). This is the **old**, D3D7-era FFP stack, and it is what did **not**
  move in this pass.

So "D3D8 vs D3D9 parity" is really two independent questions with two different answers:
program­mable D3D8 draws are already unified; **FFP D3D8 draws are the entire gap**, because they
share almost nothing with the new `d3d9/ffp-*.ts` modules.

## 1. What the D3D9 pass fixed/implemented, and where D3D8 stands

| Behaviour | D3D9 (native + D3D8-programmable) | D3D8 FFP (`ddraw/*`) |
|---|---|---|
| **FFP fog modes** (table/vertex EXP/EXP2/LINEAR, RHW passthrough) | `d3d9/ffp-fog.ts`, unchanged core formula | **Shared already** — `ddraw/shader-generator.ts` imports `FFP_FOG_WGSL` from `d3d9/ffp-fog.ts` directly. |
| **Range fog** (`D3DRS_RANGEFOGENABLE`, eye-distance fog) | New: `ffpFogFactor` mode 9..11, `resolveFfpFogMode(..., rangeFog)` | **N/A by design** — Range fog is a D3D9-only render state; DDraw/D3D7/D3D8 have no equivalent RS. `ddraw/shader-generator.ts:538` already comments this. **(c) leave separate — genuine version gap, not a bug.** |
| **Programmable-pixel-shader fog resolution** | New: `resolveProgrammablePixelFogMode()` | Not applicable — D3D8 programmable draws already call into the same `d3d9/ffp-fog.ts`/backend-executor fog path via `D3D8ProgrammableRenderer`. |
| **FFP combiner MODULATE clamping** | Changed: plain `MODULATE` no longer clamps mid-cascade (only scale/composite ops clamp) | `ddraw/shader-generator.ts` **already matches** — `arg1 * arg2` unclamped (line ~223), so this one already tracks D3D9. |
| **D3DTA_CONSTANT (D3DTSS_CONSTANT, base selector 6)** | New: `ffpStageArg` base `6u`, `stageConstants` uniform block, `ffpStageConstantOffset()` | **MISSING.** `ddraw/ffp-stages.ts` / `ddraw/shader-generator.ts` arg resolution only handles `D3DTA_TEXTURE`/`D3DTA_DIFFUSE`/`D3DTA_TFACTOR`/`D3DTA_CURRENT` — no `D3DTA_SPECULAR` (base 4), no `D3DTA_TEMP`/`D3DTSS_RESULTARG` (base 5), no `D3DTA_CONSTANT` (base 6). D3DTSS_CONSTANT and D3DTSS_RESULTARG are D3D8+ states, so this is squarely in D3D8's scope — a real correctness gap, not a D3D9-only feature. |
| **8 independent texcoord/UV sets + all 8 sampled stages + 8 texture matrices** | New: `ffpTexCoordSrc` takes `uv0..uv7`; `FFP_MAX_TEX_MATRICES = FFP_MAX_STAGES` (8) | **Capped low.** `ddraw/ffp-stages.ts`: `MAX_FFP_SAMPLED_STAGES = 4`, `MAX_FFP_UV_SETS = 3`, `MAX_FFP_TEX_MATRICES = 3`. D3D8 advertises 8 stages via caps; a game using stage ≥4 or UV set ≥3 or tex-matrix ≥3 silently degrades on D3D8 today. |
| **D3DTTFF_PROJECTED texcoord transform** | Changed: divide now happens **per pixel** after interpolation (`ffpTexTransform` returns full `vec4`, divide moved to fragment stage) — was a per-vertex approximation | `ddraw/shader-generator.ts` still uses the **old per-vertex-divide approximation** (the D3D9 file's own comment used to say "the same approximation the DDraw backend documents" — that comment is now stale on the D3D9 side after this fix, and DDraw never got the pixel-stage divide). Real (if narrow) visual-correctness divergence for projected texgen (spot-light cookies, shadow projections). |
| **Vertex blend / skinning** (`D3DRS_VERTEXBLEND`, `D3DRS_INDEXEDVERTEXBLENDENABLE`, tweening) | New module `d3d9/ffp-vertex-blend.ts` (pure decode: weight/matrix-count/indexed resolution) + uniform palette (`ffpBlendMatrixOffset`, `blendCtrl`) wired into `ffp-lighting.ts`/`d3d9-device.ts` | D3D8 **already has its own, independent implementation**: `D3D8DeviceAdapter.resolve*VertexBlend*` (`d3d8-device-adapter.ts:1230-1254`) decodes `D3DFVF_XYZB1..B5`/`D3DFVF_LASTBETA_UBYTE4` by hand, feeding `DDrawWebGPUExecutor`/`ddraw/compute/vertex-converter.ts`. Same D3D semantics (D3DVBF_* enums, N+1 matrices, implicit final weight), two hand-written decoders. **Duplication, not a gap** — but a drift risk (see §4). |
| **Blend state: separate-alpha blend, `D3DRS_BLENDFACTOR` (blend constant), two-sided stencil, per-MRT-target `D3DRS_COLORWRITEENABLE{1,2,3}`, dual-source-factor + enum validation** | New in `d3d9/d3d9-blend.ts`: `isD3D9BlendStateRepresentable`, `isD3D9DepthStencilStateRepresentable`, `colorWriteMask(targetIndex)`, stencil op tables | **MISSING wholesale.** `ddraw/pipeline-factory.ts` (~line 700-760) has its **own** `mapBlendFactor`/`mapBlendOperation`, always uses the color-blend src/dst for alpha too (no `D3DRS_SEPARATEALPHABLENDENABLE`), one `D3DRS_COLORWRITEENABLE` (no MRT), no `D3DRS_BLENDFACTOR`/`setBlendConstant`, no two-sided stencil, and **no enum validation** (an invalid blend factor/op silently falls through rather than being refused before `createRenderPipeline`). D3D8 supports MRT (`SetRenderTarget` on multiple targets since 8.1-ish via caps), separate alpha blend, and two-sided stencil — this is squarely applicable, not a version difference. |
| **Samplers**: sRGB texture view, `D3DSAMP_BORDERCOLOR`, `D3DSAMP_MIPMAPLODBIAS` (now actually tracked + fed to shader emitter), mirror-once addressing, capability-refusal for unrepresentable modes | `shared/dx-sampler.ts` gained `dxSrgbViewFormat`, `dxSamplerShaderKey`/`dxSamplerShaderStatesKey`, `borderColor`/`mipLodBias`/`srgbTexture` fields on `SamplerSpec`, `DxSamplerCache.build()` now **throws** on an unsupported feature | **Descriptor plumbing is shared** (`DxSamplerCache` is already imported by `ddraw/bind-group-manager.ts`) — the base filter/address/aniso/MAXMIPLEVEL logic is unified today. But `D3DSAMP_BORDERCOLOR`, `D3DSAMP_SRGBTEXTURE`, `D3DSAMP_MIPMAPLODBIAS` are **never decoded anywhere in `ddraw/` or `d3d8/`** (`grep` for those names in those directories returns nothing) — the FFP shader generator never emits the WGSL-side border/bias lowering the new `dx-sampler.ts` comment describes. So D3D8 FFP textures using border-color addressing, LOD bias, or sRGB texture reads get whatever the old defaults were, silently. |
| **Format support / `CheckDeviceFormat` family** | `shared/dx-format-support.ts` heavily reworked (+532/−~70), already `DxVersion`-parameterized (`checkDxDeviceFormat(version, ...)`) | **Already shared** — `d3d8-device-adapter.ts` imports `dx-format-support.ts` directly. `ddraw-backend-executor.ts` itself has no format-cap checks (DirectDraw proper doesn't expose `CheckDeviceFormat`; that's a Direct3D7+ device call D3D8 makes through its own module layer, which already goes through the shared file). **No action needed.** |
| **Texture formats / decode (`texture-formats.ts`, +290)** | Used by `d3d9-device.ts`, `copy-cpu.ts`, `copy-policy.ts`, `d3d9-resources.ts` | **Already shared** — `d3d8-device-adapter.ts` and `ddraw-backend-executor.ts` both import `shared/texture-formats.ts`. |
| **Mip levels — compressed-texture upload plan, cube-mip completeness** | New `shared/mip-utils.ts`: `d3dTextureMipUploadPlan()`, `effectiveCubeMipLevels()` | **DDraw is the good implementation here** (per prior bring-up: "D3D9 compressed textures get NO mips at all… DDraw is the good implementation" — `ffp-mipmap-lod-audit.md`). `ddraw/mip-generator.ts` already imports `shared/mip-utils.ts`; D3D8 rides on it via `DDrawWebGPUExecutor`. This is a case where **D3D9 should pull from DDraw's existing behaviour**, not the reverse — worth flagging so nobody "unifies" it backwards. |
| **Vertex streams — stride alignment guard, `SetStreamSourceFreq` instancing (`D3DSTREAMSOURCE_INSTANCEDATA`/`INDEXEDDATA`), instance-rate expansion** | New in `shared/vertex-streams.ts`: `isWebGpuArrayStrideAligned`, `stepModeFromFreq`, `expandInstanceRateData`, `InstancingPlan` | Stream declarations/FVF plumbing already shared (`d3d8-device-adapter.ts` imports `vertex-streams.ts` for `collectExtraStreamBindings`). **Instancing itself is D3D9-only** (`SetStreamSourceFreq` does not exist in the D3D8 vtable) — **(c) leave separate, genuine API-surface gap**, nothing for D3D8 to inherit. The stride-alignment guard (`isWebGpuArrayStrideAligned`) *is* generically useful and should be checked wherever D3D8's FFP path builds `arrayStride` for a converted vertex layout (`ddraw/compute/vertex-converter.ts`) — worth a quick audit, not a big item. |

## 2. Remedy classification for each divergence

**(a) MOVE to `shared/`, both call it:**
1. **FFP combiner argument resolution** (`ffpStageArg` base-selector switch, including
   `D3DTA_CONSTANT`/`D3DTA_SPECULAR`/`D3DTA_TEMP`) — currently duplicated as two separate WGSL
   emitters (`d3d9/ffp-combiner.ts` + inline arg-resolution in `ddraw/shader-generator.ts`).
   Extract one canonical `emitFfpArgResolverWgsl()`/`emitFfpCombinerWgsl()` pair into
   `shared/` (or keep it in `d3d9/ffp-combiner.ts` but have `ddraw/shader-generator.ts` call it,
   the way it already does for `FFP_FOG_WGSL`) and pass a `stageConstant` uniform through DDraw's
   FFP uniform block.
2. **Blend/depth-stencil pipeline-state builder** — `d3d9/d3d9-blend.ts`'s
   `buildColorTargetState`/`computeBlendKey`/`isD3D9BlendStateRepresentable`/
   `isD3D9DepthStencilStateRepresentable` are already version-agnostic (`GetRenderState`
   callback + D3DRS_* constants that exist identically in D3D7/8/9). `ddraw/pipeline-factory.ts`
   should call these instead of its own `mapBlendFactor`/`mapBlendOperation`, the same way
   `d3d8-programmable-draw.ts` already does. This one file gets DDraw separate-alpha blend,
   MRT write masks, `D3DRS_BLENDFACTOR`, two-sided stencil, and enum validation in one move.
3. **Sampler border-color / sRGB / LOD-bias WGSL lowering** — the *decode* (`SamplerSpec`
   fields, `dxSamplerShaderKey`) is already shared; the missing half is the *emission*. Factor
   the WGSL snippet that applies border/mirror-once/LOD-bias out of the D3D9 shader emitter
   (`d3d9/shader/emit/tex.ts` or `ps-codegen.ts`) into something `ddraw/shader-generator.ts` can
   also call, and thread `D3DSAMP_BORDERCOLOR`/`SRGBTEXTURE`/`MIPMAPLODBIAS` from
   `ddraw/ffp-stages.ts`'s state read into the DDraw uniform block.
4. **Vertex-blend/skinning decode** (`D3DVBF_*` weight/matrix-count/indexed resolution) — the
   new `d3d9/ffp-vertex-blend.ts` is a small, pure, already-tested module with no D3D9-specific
   dependency. Point `D3D8DeviceAdapter`'s hand-rolled resolver at it instead of maintaining a
   second copy of the same D3D3-era rule (N explicit weights → N+1 matrices, implicit final
   weight). Low risk, kills future drift.

**(b) PORT the fix into the D3D8/ddraw path (logic stays separate, but gets the same behaviour):**
5. **8 texcoord sets / 8 sampled stages / 8 texture matrices** — `ddraw/ffp-stages.ts`'s
   `MAX_FFP_SAMPLED_STAGES = 4`, `MAX_FFP_UV_SETS = 3`, `MAX_FFP_TEX_MATRICES = 3` are DDraw's
   own historical caps (documented as deliberate — "Stage 3 samples with untransformed
   coordinates, detector logs if a game transforms it"). Raising them means widening the
   converted-vertex layout (more UV varyings) and the FFP uniform block — a DDraw-shaped change,
   not a shared-function call, because DDraw's vertex conversion (`compute/vertex-converter.ts`)
   and D3D9's stream-based FVF layout are structurally different pipelines.
6. **Per-pixel D3DTTFF_PROJECTED divide** — port the "keep `vec4`, divide in the fragment
   stage" shape from `d3d9/ffp-lighting.ts`'s `ffpTexTransform`/`FFP_TEXGEN_WGSL` into
   `ddraw/shader-generator.ts`'s equivalent function. Mechanical, self-contained.

**(c) Leave separate — genuine semantic difference, not a gap:**
- Range fog (`D3DRS_RANGEFOGENABLE`) — D3D9-only render state.
- `SetStreamSourceFreq` instancing — D3D9-only API surface (no D3D8 vtable slot).
- Mip-plan/cube-mip-completeness direction — DDraw is already the reference implementation;
  D3D9 pulled *from* it, nothing to port the other way.
- (Anticipated, not directly evidenced in this diff, but worth stating per the CLAUDE.md list
  since they recur in this exact D3D8/D3D9 boundary): sampler state living inside
  `D3DTSS_*`/per-stage on D3D8-and-earlier vs. per-sampler-unit `D3DSAMP_*` on D3D9;
  `SetIndices`'s `BaseVertexIndex` parameter (D3D8) vs. the draw-call `BaseVertexIndex`
  argument (D3D9); `SetRenderTarget` setting colour+depth together (D3D8) vs. independent
  `SetRenderTarget`/`SetDepthStencilSurface` (D3D9); `D3DBLEND_BOTHSRCALPHA`/`BOTHINVSRCALPHA`
  (already normalized once, in `fixupBoth()` — confirm it's the *shared* `d3d9-blend.ts` copy
  once §2.a-2 lands, not a second copy in ddraw); integer `D3DRS_ZBIAS` (D3D8, 0-15 integer
  units) vs. float `D3DRS_DEPTHBIAS`/`D3DRS_SLOPESCALEDEPTHBIAS` (D3D9) — these must keep their
  own conversion at the D3D8 API-shim layer (`modules/d3d8/`), not be forced through the D3D9
  constant.

## 3. Existing `shared/` modules — who bypasses them today

| Module | Consumed by D3D9 | Consumed by D3D8 (programmable) | Consumed by D3D8 FFP / ddraw |
|---|---|---|---|
| `dx-sampler.ts` | yes | yes (`d3d8-sampler.ts`, `d3d8-programmable-draw.ts`) | yes, descriptor-level only (`ddraw/bind-group-manager.ts`) — **border/sRGB/LOD-bias fields never populated from `D3DTSS_*`, and never lowered in WGSL** |
| `dx-format-support.ts` | yes | yes (`d3d8-device-adapter.ts`) | n/a (DirectDraw proper has no `CheckDeviceFormat`) — no gap |
| `texture-formats.ts` | yes | yes | yes (`ddraw-backend-executor.ts`) — no gap |
| `mip-utils.ts` | yes | — (rides on DDraw's surface/texture path) | yes (`ddraw/mip-generator.ts`) — DDraw is *ahead* here, not behind |
| `vertex-streams.ts` | yes | yes (`d3d8-device-adapter.ts`, decl-based streams) | **bypassed** — DDraw's FVF-only vertex conversion (`ddraw/compute/vertex-converter.ts`) doesn't use `StreamBindingTable`/`isWebGpuArrayStrideAligned`; it predates the declaration-stream model and is a different (FVF, not decl) shape, so this is largely **(c)** except the stride-alignment guard, worth a one-line audit |
| `pixel-center.ts` | yes | yes (`d3d8-programmable-draw.ts`) | need to confirm — not directly evidenced in this pass; low priority to check, `pixel-center.ts` itself changed in the diff |
| `d3d9-blend.ts` (not in `shared/`, but is the de facto shared blend module) | yes | yes | **no** — `ddraw/pipeline-factory.ts` has its own copy (§1, §2.a-2) |

## 4. Regression-risk flags for games already working on ddraw/D3D7/D3D8

Every item in §2(a)/(b) touches `ddraw/pipeline-factory.ts` or `ddraw/shader-generator.ts`,
which is the **shared execution path for DirectDraw/D3D3-7 AND D3D8 FFP** — i.e. every game
currently playable through that stack (GTA III, System Shock 2, Painkiller, Gothic, Hitman,
KKND2, Mafia, Half-Life Uplink, House of 1000 Doors, Quake II via D3D7, etc., per
`MEMORY.md`) is downstream of any change here. This is the highest blast-radius surface in the
whole codebase.

- **Blend unification (§2.a-2) is the biggest risk.** `ddraw/pipeline-factory.ts` currently
  applies the SAME src/dst blend factor to both colour and alpha unconditionally (no
  `D3DRS_SEPARATEALPHABLENDENABLE` read at all). Switching to `d3d9-blend.ts`'s
  `buildColorTargetState` changes behaviour for **any game that has ever left
  `D3DRS_SEPARATEALPHABLENDENABLE` non-zero from a stale/default state** even if it never meant
  to use it — because the old code silently ignored the render state and the new code honours
  it. Gate behind a runtime flag (`forceDisableSeparateAlpha` alongside the existing
  `debugFlags.forceDisableAlphaBlend`) and verify with the harness's `expectSurfaceNonBlack` +
  a visual diff on 3-4 known-good FFP titles (GTA III opaque geometry, a title that layers
  translucent decals — Gothic or Painkiller particles are good candidates per the memory notes)
  before flipping the default.
- **FFP combiner arg-resolution unification (§2.a-1)** adds `D3DTA_SPECULAR`/`D3DTA_TEMP`/
  `D3DTA_CONSTANT` branches that were previously absent; a stage that happens to already carry
  garbage/uninitialized arg bits equal to one of these codes (some titles never explicitly set
  every `D3DTSS_*`) would silently change from "falls through to default" to "reads a real but
  wrong register." Verify with `ffp-combiner`-style unit tests (mirroring
  `tools/tests/d3d9-ffp-fog.test.ts`) enumerating every base selector against known-good D3D9
  reference output before wiring it into DDraw, plus one visual regression pass on a title that
  exercises deep (4+) stage cascades (Painkiller per `painkiller-profile.md`: "SetFVF vs
  SetVertexDeclaration fighting over one state slot" already showed this stack is fragile to
  state-tracking changes).
- **Raising `MAX_FFP_SAMPLED_STAGES`/`MAX_FFP_UV_SETS`/`MAX_FFP_TEX_MATRICES` (§2.b-5)** changes
  the converted-vertex byte layout DDraw uploads (`ddraw/compute/vertex-converter.ts`) and the
  FFP uniform block size — any hardcoded stride/offset elsewhere in `ddraw/` (bind-group layouts,
  MegaBatch storage-buffer packing per `ddraw/ffp-stages.ts`'s own doc comment) must be audited
  for a stale constant. This is the kind of change `tools/validate-struct-offsets.ts` and the
  d3d9 arena/ABI validators exist to catch on the D3D9 side, but there is **no equivalent
  offset-pinning test today for the DDraw MegaBatch layout** — write one (mirroring
  `ffp-lighting.test.ts`'s "pins them against the WGSL struct's own layout" pattern) *before*
  widening the stage count, not after.
- **Sampler border/sRGB/LOD-bias wiring (§2.a-3)** is comparatively low risk *if* it is additive
  (new fields default to today's behaviour when unset), but `DxSamplerCache.build()` now
  **throws** on an unsupported feature combination (`d3d9-anisotropy-limit`, dual-source, etc.)
  — confirm no DDraw code path can ever produce a `SamplerSpec` that trips that throw, since a
  thrown exception where DDraw previously degraded silently could turn a rendering glitch into
  a hard crash / draw-skip. Wrap the first DDraw call site in a try/catch that falls back to the
  pre-change descriptor and logs, the same defensive shape the D3D9 side already uses elsewhere
  in this pass (`isD3D9BlendStateRepresentable`/`isD3D9DepthStencilStateRepresentable` are
  advisory checks callers can choose to enforce, not unconditional throws — mirror that, don't
  introduce a new unconditional throw into the higher-blast-radius DDraw path).
- **Vertex-blend decoder consolidation (§2.a-4)** is low risk (pure function swap, same D3D
  semantics, well-covered by `tools/tests/d3d9-ffp-vertex-blend.test.ts` already) — good first
  PR to build confidence in the unification direction before tackling blend/combiner.

General verification discipline for all of the above (per CLAUDE.md's `bringup` workflow, not
run in this investigation): `harness().openWgb(...).tickFrames(N).expectSurfaceNonBlack(...)`
plus `shot()` visual diff against a pre-change baseline screenshot, on at least: one opaque-only
FFP title, one alpha-blended/particle-heavy FFP title, one multi-stage-texture FFP title, and
one D3D8-programmable title (to confirm the shared-module changes didn't regress the path that's
already unified). None of that was run as part of this mapping task — it is READ-ONLY.

## 5. Ordered work-package list

1. **Vertex-blend decoder consolidation** (§2.a-4).
   Files: `d3d8/d3d8-device-adapter.ts` (replace hand-rolled resolver), possibly export a bit
   more from `d3d9/ffp-vertex-blend.ts`. Blast radius: small — one call site, pure function,
   same output by construction. Verify: existing `d3d9-ffp-vertex-blend.test.ts` plus a new
   D3D8-side unit test asserting the adapter's resolver output matches the shared decoder for
   every `D3DFVF_XYZB1..B5` × `D3DVBF_*` combination. Size: **S** (半-day).

2. **Sampler state completeness for DDraw FFP** (§2.a-3, PORT half of §1's sampler row): decode
   `D3DSAMP_BORDERCOLOR`/`SRGBTEXTURE`/`MIPMAPLODBIAS` in `ddraw/ffp-stages.ts`'s TSS→spec
   mapping, thread through to `DxSamplerCache`, and add the WGSL border/bias lowering to
   `ddraw/shader-generator.ts` (factor out of the D3D9 shader emitter first if it's not already
   a standalone snippet). Files: `ddraw/ffp-stages.ts`, `ddraw/bind-group-manager.ts`,
   `ddraw/shader-generator.ts`, `d3d9/shader/emit/tex.ts` (extraction only). Blast radius:
   medium — new uniform fields, new WGSL branches, but purely additive (unset = today's
   behaviour). Verify: unit test enumerating TSS states → `SamplerSpec`, then one harness pass on
   a title using border-color addressing if one is known, else a synthetic fixture. Size: **M**
   (1-2 days).

3. **FFP combiner argument resolution unification** (§2.a-1). Files: `d3d9/ffp-combiner.ts`
   (generalize `emitFfpCombinerWgsl`/`ffpStageArg` to take a shared-callable form),
   `ddraw/shader-generator.ts` (call it instead of the inline switch), `ddraw/ffp-stages.ts`
   (thread `D3DTSS_CONSTANT`/resolve `D3DTA_SPECULAR`/`D3DTA_TEMP` into the packed stage state).
   Blast radius: **high** — touches the FFP arg-resolution path every DDraw/D3D7/D3D8 FFP draw
   goes through. Verify: per-base-selector unit tests (new), then the multi-stage-cascade visual
   regression pass from §4. Size: **L** (3-4 days, plus a regression-test day).

4. **Blend/depth-stencil pipeline-state unification** (§2.a-2). Files:
   `ddraw/pipeline-factory.ts` (replace `mapBlendFactor`/`mapBlendOperation` + blend-state
   construction with `d3d9-blend.ts`'s builders), `ddraw/ffp-stages.ts` or wherever DDraw reads
   render states today (confirm `D3DRS_SEPARATEALPHABLENDENABLE`/`BLENDFACTOR`/stencil states are
   already tracked in DDraw's render-state array — if not, that's part of this package too).
   Blast radius: **highest** in this list (§4's biggest risk item). Verify: gate behind a debug
   flag first, A/B on the 4-title matrix from §4, only then flip default. Size: **L** (3-5 days
   including the gating/rollback plumbing and offset/regression tests).

5. **8-stage / 8-UV-set / 8-tex-matrix FFP widening** (§2.b-5). Files: `ddraw/ffp-stages.ts`
   (raise the three `MAX_FFP_*` constants), `ddraw/compute/vertex-converter.ts` (wider converted
   vertex), `ddraw/pipeline-factory.ts`/`ddraw/shader-generator.ts` (uniform block size, MegaBatch
   packing). Prerequisite: write the offset-pinning test called out in §4 *before* this lands.
   Blast radius: **high** (layout change touching every FFP draw's vertex conversion and uniform
   packing). Verify: new offset-pinning test + the visual regression matrix, specifically a title
   known to use stage ≥4 or UV set ≥3 if one exists in the current fixture set (none confirmed in
   this investigation — flag as a fixture gap). Size: **L** (3-5 days).

6. **Per-pixel `D3DTTFF_PROJECTED` divide port** (§2.b-6). Files: `ddraw/shader-generator.ts`'s
   texgen/transform function only. Blast radius: small — self-contained function, only affects
   draws that actually use `D3DTTFF_PROJECTED` (a minority of FFP usage: projective texturing,
   spotlight cookies). Verify: targeted visual check on any title using projective texgen if one
   is in the fixture set, else defer until one surfaces (low priority relative to 1-5). Size: **S**
   (半-day).

Recommended order matches the list: **1 → 2 → 6 → 3 → 4 → 5**, i.e. do the cheap, low-risk,
already-well-tested moves first (vertex blend, sampler completeness, projected-texgen), build
confidence and the missing offset/regression-test infrastructure, and only then take on the two
highest-blast-radius items (combiner arg resolution, blend-state unification) with the widening
(item 5) last since it depends on infrastructure item 4 doesn't strictly require but shares risk
profile with.
