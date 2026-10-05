# D3D8 Parity Audit — Texture Stage State / FFP Combiner / Texgen / UV Sets

Scope: `IDirect3DDevice8::Set/GetTextureStageState`, the fixed-function texture combiner,
texcoord generation, texture-coordinate transforms, and UV-set handling as they exist on the
code path D3D8 actually runs.

## 0. The architectural fact that explains almost every gap below

D3D8 draws do **not** go through the complete FFP combiner this codebase already has
(`src/worker/backends/webgpu/d3d9/ffp-combiner.ts`, used only by `d3d9-device.ts`). Instead
`d3d8-device-adapter.ts` submits through `DDrawWebGPUExecutor`
(`src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts`), which resolves stage state via
`ffp-stages.ts` and emits WGSL via `shader-generator.ts` — a second, older, materially weaker
combiner implementation that predates the D3D9 one and was never brought up to parity with it.

Ground truth (`G:/sources/dxvk/src/d3d8/`) shows this split should not exist: DXVK's D3D8 layer
is a thin translation that funnels every draw into the *same* D3D9 fixed-function pipeline
(`d3d9_fixed_function_frag.glsl`), so D3D8 titles get the full 8-stage/26-op/all-D3DTA combiner
for free. Real D3D8 hardware/drivers likewise share one FFP implementation with D3D9 (the
D3DTEXTURESTAGESTATETYPE/D3DTEXTUREOP/D3DTA_* enums are byte-identical between the two).

**This is the single fix that closes nearly every item below**: route D3D8 FFP draws through
the same combiner D3D9 uses (`ffp-combiner.ts` / `d3d9-device.ts`'s stage resolution,
`FFP_MAX_STAGES=8`, `FFP_MAX_TEX_MATRICES=8`), rather than through the D3D7-era `ffp-stages.ts`
+ `shader-generator.ts` pair. Everything itemized here is a symptom of that one architectural
fork, not 15 independent bugs to fix piecemeal — fixing them piecemeal (patching
`shader-generator.ts` op-by-op) would just grow a second, forever-trailing copy of
`ffp-combiner.ts`. The per-Prime-Directive-3.0 generic fix is unification, not local patches.

## 1. Item-by-item verdict table

| # | Item | Verdict | Where |
|---|------|---------|-------|
| 1 | D3DTOP 1 DISABLE | IMPLEMENTED | `ffp-stages.ts` cascade-termination logic |
| 2 | D3DTOP 2 SELECTARG1 | IMPLEMENTED | `shader-generator.ts:238,262` |
| 3 | D3DTOP 3 SELECTARG2 | IMPLEMENTED | `shader-generator.ts:239,263` |
| 4 | D3DTOP 4 MODULATE | IMPLEMENTED | `shader-generator.ts:240,264` |
| 5 | D3DTOP 5 MODULATE2X | IMPLEMENTED | `shader-generator.ts:241,265` |
| 6 | D3DTOP 6 MODULATE4X | IMPLEMENTED | `shader-generator.ts:242,266` |
| 7 | D3DTOP 7 ADD | IMPLEMENTED | `shader-generator.ts:243,267` |
| 8 | D3DTOP 8 ADDSIGNED | IMPLEMENTED | `shader-generator.ts:245,269` |
| 9 | D3DTOP 9 ADDSIGNED2X | IMPLEMENTED | `shader-generator.ts:246,270` |
| 10 | D3DTOP 10 SUBTRACT | IMPLEMENTED | `shader-generator.ts:244,268` |
| 11 | D3DTOP 11 ADDSMOOTH | **SILENTLY-WRONG** | falls through to `return arg1*arg2` default (`shader-generator.ts:256,281`) — advertised supported (see §3.6) |
| 12 | D3DTOP 12 BLENDDIFFUSEALPHA | IMPLEMENTED | `shader-generator.ts:247-249,271-273` |
| 13 | D3DTOP 13 BLENDTEXTUREALPHA | IMPLEMENTED | `shader-generator.ts:250-252,274-276` |
| 14 | D3DTOP 14 BLENDFACTORALPHA | IMPLEMENTED | `shader-generator.ts:253-255,277-279` |
| 15 | D3DTOP 15 BLENDTEXTUREALPHAPM | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 16 | D3DTOP 16 BLENDCURRENTALPHA | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 17 | D3DTOP 17 PREMODULATE | MISSING (honestly, not advertised) | not in cap bits either path |
| 18 | D3DTOP 18 MODULATEALPHA_ADDCOLOR | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 19 | D3DTOP 19 MODULATECOLOR_ADDALPHA | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 20 | D3DTOP 20 MODULATEINVALPHA_ADDCOLOR | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 21 | D3DTOP 21 MODULATEINVCOLOR_ADDALPHA | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 22 | D3DTOP 22 BUMPENVMAP | MISSING (honestly not advertised, but see §3.3 — BUMPENVMAT state is unreachable) | `caps.ts:154` correctly clears the bit |
| 23 | D3DTOP 23 BUMPENVMAPLUMINANCE | MISSING (honestly not advertised) | `caps.ts:154` correctly clears the bit |
| 24 | D3DTOP 24 DOTPRODUCT3 | **SILENTLY-WRONG** | same MODULATE fallback; advertised supported |
| 25 | D3DTOP 25 MULTIPLYADD | IMPLEMENTED | `shader-generator.ts:254,278` |
| 26 | D3DTOP 26 LERP | IMPLEMENTED | `shader-generator.ts:255,279` |
| — | D3DTA_DIFFUSE (0) | IMPLEMENTED | `shader-generator.ts:202-204,228-229` |
| — | D3DTA_CURRENT (1) | IMPLEMENTED | `shader-generator.ts:199-201,226-227` |
| — | D3DTA_TEXTURE (2) | IMPLEMENTED | `shader-generator.ts:193-195,222-223` |
| — | D3DTA_TFACTOR (3) | IMPLEMENTED | `shader-generator.ts:196-198,224-225` |
| — | D3DTA_SPECULAR (4) | **SILENTLY-WRONG** | not a case in `resolveColorArg`/`resolveAlphaArg` — falls into the `else` (DIFFUSE) branch |
| — | D3DTA_TEMP (5) | **SILENTLY-WRONG** | same — falls to DIFFUSE; also `D3DTSS_RESULTARG` is never read (see below) so nothing ever *writes* TEMP either |
| — | D3DTA_CONSTANT (6) | MISSING (undefined constant, unreachable state) | not modeled at all in ddraw constants/resolver |
| — | D3DTA_COMPLEMENT (0x10) modifier | IMPLEMENTED | `shader-generator.ts:211-213,231-233` |
| — | D3DTA_ALPHAREPLICATE (0x20) modifier | IMPLEMENTED | `shader-generator.ts:207-209` (color only — see note) |
| — | Stage 0 D3DTA_CURRENT==DIFFUSE rule | IMPLEMENTED | `ffp-stages.ts:167-175` `currentToDiffuse()` |
| — | Cascade-termination on DISABLE | IMPLEMENTED | `ffp-stages.ts:239-250` |
| — | D3DTSS_TEXCOORDINDEX low 16 (UV set) | **PARTIAL** — correct for sets 0-2, **SILENTLY-WRONG** for 3-7 | `selectTexCoord` in `shader-generator.ts:177-186` only branches on 1,2; vertex converter never even carries a 4th UV set (see §3.1) |
| — | D3DTSS_TEXCOORDINDEX high 16 (TCI_* texgen) | IMPLEMENTED for PASSTHRU/CAMERASPACENORMAL/POSITION/REFLECTIONVECTOR | `genTexCoordSrc`, `shader-generator.ts:373-379` |
| — | D3DTSS_TEXTURETRANSFORMFLAGS (COUNT1-4, PROJECTED) | **PARTIAL** — correct for stages 0-2, MISSING for stages 3-7 | `resolveTexXformFlags` capped at `MAX_FFP_TEX_MATRICES=3` (`ddraw-backend-executor.ts:2196-2216`) |
| — | D3DTS_TEXTURE0..7 matrices | **PARTIAL** — only 3 of 8 matrix slots exist | `ffp-stages.ts:58-60`, `shader-generator.ts:435-437,546-548` |
| — | D3DTSS_COLORARG0/ALPHAARG0 | IMPLEMENTED | `ffp-stages.ts:164-165`, `shader-generator.ts:325,332` |
| — | D3DTSS_RESULTARG | **MISSING** (never read) | not in `ddraw/constants.ts`; `ffp-stages.ts`/`shader-generator.ts` have no TEMP register at all |
| — | D3DTSS_BUMPENVMAT00-11 | MISSING (dead: stored generically, never read) | not in `ddraw/constants.ts`; no consumer |
| — | D3DTSS_BUMPENVLSCALE/LOFFSET | MISSING (dead: stored generically, never read) | same |
| — | Stage-count limit (advertised vs actual) | **SILENTLY-WRONG (false capability)** | `MaxTextureBlendStages=8`/`MaxSimultaneousTextures=8` advertised (`caps.ts:155-156`) but only `MAX_FFP_SAMPLED_STAGES=4` can bind+sample a texture (`ffp-stages.ts:53`) |
| — | TextureOpCaps advertised vs implemented | **SILENTLY-WRONG (false capability)** | `caps.ts:144,154` advertises ops 11,15,16,18-21,24 as supported; the D3D8 combiner silently falls back to MODULATE for all of them |

## 2. Priority queue — SILENTLY-WRONG and MISSING, worst first

### P0 — False capability: MaxSimultaneousTextures/MaxTextureBlendStages = 8, actual cap = 4

- **Our code**: `src/worker/modules/d3d8/caps.ts:155-156` advertise
  `MaxTextureBlendStages=8`, `MaxSimultaneousTextures=8`. The actual limit that can *sample* a
  texture is `MAX_FFP_SAMPLED_STAGES=4` (`src/worker/backends/webgpu/ddraw/ffp-stages.ts:53`),
  and `STAGE_BINDINGS` in `shader-generator.ts:49-54` (unchanged section) only has 4 entries.
- **Ground truth**: DXVK D3D8 → D3D9 FF has 8 real texture-binding slots
  (`D3DTA_TEXTURE` resolves per-stage in `d3d9_fixed_function_frag.glsl` for all 8 stages);
  D3DCAPS8 on real GeForce-class hardware genuinely reports 8/8.
- **Observable symptom**: a game issuing `SetTexture(4..7, tex)` plus a stage 4-7
  `SetTextureStageState(..., COLOROP, MODULATE)` referencing `D3DTA_TEXTURE` gets *worse* than
  "stage 4-7 does nothing" — because `ffp-stages.ts:239-250`'s cascade-termination rule sees
  `wantsTexture=true`, `sampleable=false` (stage ≥ 4), so `samples=false` AND `arith=false`
  (the stage isn't "pure arithmetic" since it does reference TEXTURE) → `enabled=false`. That
  **terminates the whole cascade at stage 4**, silently dropping stages 4-7 outright — not just
  degrading them. A 5+-layer multitexture pass (common for detail+lightmap+specular+decal
  combos in 2001-2003 D3D8 titles) renders as if stages 4-7 were never set, with zero warning
  even though the game correctly queried and got back "8 supported."
- **Fix sketch**: either (a) lower the advertised caps to 4 (dishonest relative to real
  hardware but at least internally consistent — a titles' capability probe still degrades
  gracefully), or (b) the real fix: extend `STAGE_BINDINGS`/`MAX_FFP_SAMPLED_STAGES` to 8 (this
  is exactly what unifying onto `ffp-combiner.ts`/`d3d9-device.ts`'s already-8-stage design
  gives for free — see §0).

### P0 — False capability: TextureOpCaps advertises 8 ops the D3D8 combiner silently mistreats

- **Our code**: `src/worker/modules/d3d8/caps.ts:144,154` sets
  `TextureOpCaps = 0x03FEFFFF & ~(BUMPENVMAP|BUMPENVMAPLUMINANCE)`, i.e. advertises
  ADDSMOOTH(11), BLENDTEXTUREALPHAPM(15), BLENDCURRENTALPHA(16), MODULATEALPHA_ADDCOLOR(18),
  MODULATECOLOR_ADDALPHA(19), MODULATEINVALPHA_ADDCOLOR(20), MODULATEINVCOLOR_ADDALPHA(21),
  DOTPRODUCT3(24) as *supported*. This value was evidently copied from
  `src/worker/modules/d3d9/caps.ts:128` where it is true (D3D9 draws use
  `ffp-combiner.ts`, which really implements all of these — see
  `src/worker/backends/webgpu/d3d9/ffp-combiner.ts:72,78-83,85`). For D3D8 it is false: none of
  these 8 ops appear in `shader-generator.ts`'s `applyColorOp`/`applyAlphaOp`
  (lines 235-282) — every one of them falls through to the final
  `return arg1 * arg2; // Default to MODULATE` (lines 256, 281).
- **Ground truth**: `d3d9_fixed_function_frag.glsl:376-420` implements every one of these ops
  explicitly; D3D8's own caps comment two lines above (`caps.ts:~112`,
  "TSSARGTEMP (no D3DTA_TEMP in the FFP combiner D3D8 uses)") shows the author *was* aware the
  D3D8 combiner is a reduced one for the RESULTARG/TEMP case, but the same audit was not applied
  to `TextureOpCaps`.
- **Observable symptom**: a game that probes `TextureOpCaps` and picks DOTPRODUCT3 for
  normal-mapping-lite or ADDSMOOTH for a soft-blend decal gets silent MODULATE — wrong lighting/
  blend math with no error, no log line, no fallback warning (unlike the D3D9 path, which has
  `FFP_IMPLEMENTED_OPS`-driven "unhandled" diagnostics — `ffp-combiner.ts:11-27`).
- **Fix sketch**: this is exactly what §0's unification fixes. If unification is deferred,
  the interim honest fix is to clear bits 11,15,16,18-21,24 from `TextureOpCaps` in
  `d3d8/caps.ts` so games fall back to their own documented-safe path instead of getting a
  wrong-but-plausible blend.

### P1 — D3DTA_SPECULAR / D3DTA_TEMP silently resolve to DIFFUSE

- **Our code**: `resolveColorArg`/`resolveAlphaArg` in `shader-generator.ts:188-233` only
  branch on `TEXTURE`(2), `TFACTOR`(3), `CURRENT`(1); everything else — including `SPECULAR`(4)
  and `TEMP`(5) — falls into the final `else { result = diffuse; }`. `D3DTA_SPECULAR` and
  `D3DTA_TEMP` are not even defined in `src/worker/modules/ddraw/constants.ts` (they exist only
  in `src/worker/backends/webgpu/d3d9/ffp-lighting.ts:63` for the D3D9 path).
- **Ground truth**: `d3d9_fixed_function_frag.glsl:274-304` — `case D3DTA_SPECULAR` reads the
  interpolated specular color; `case D3DTA_TEMP` reads the stage's `resultTemp` register.
- **Observable symptom**: a D3D8 title compositing specular highlights via a texture stage
  (`COLORARG1 = D3DTA_SPECULAR`, common for a cheap chrome/gloss combine without per-pixel
  lighting) gets the *diffuse* color blended in instead — highlight either double-brightens with
  diffuse or the specular pass looks like a diffuse re-blend. Silent, plausible-looking, no
  warning.
- **Fix sketch**: add `D3DTA_SPECULAR=4`, `D3DTA_TEMP=5`, `D3DTA_CONSTANT=6` to
  `ddraw/constants.ts`; thread the vertex specular varying and a per-stage TEMP accumulator
  through `resolveColorArg`/`resolveAlphaArg` (mirrors `ffpStageArg` in `ffp-combiner.ts:30-47`
  exactly — again, unification is the shorter path).

### P1 — D3DTSS_RESULTARG is never read (D3DTA_TEMP has no writer either)

- **Our code**: `D3DTSS_RESULTARG` (=28) is absent from `ddraw/constants.ts`'s TSS list and
  from every read site in `ffp-stages.ts`/`shader-generator.ts`. State IS captured faithfully
  (device-impl.ts's `setTextureStageState` stores generically by `stage*32+type`), it is simply
  never consumed on the D3D8 path.
- **Ground truth**: D3D9-path equivalent at `src/worker/backends/webgpu/d3d9/d3d9-device.ts:4750`
  (`st.resultArg = ts(s, D3DTSS_RESULTARG, 1)`) and `ffp-lighting.ts:231,386` for how RESULTARG
  routes into the TEMP register; DXVK reference in `d3d9_fixed_function_frag.glsl` (search
  `resultTemp`).
- **Observable symptom**: multi-pass techniques that stash an intermediate blend in TEMP via
  `SetTextureStageState(N, D3DTSS_RESULTARG, D3DTA_TEMP)` and read it back in a later stage
  (common D3D8-era detail/lightmap combine idiom) silently write to CURRENT instead — the
  later stage reads whatever CURRENT happens to hold, producing a plausible but wrong composite
  with no error.
- **Fix sketch**: same as above — carried for free by routing through the D3D9 stage resolver,
  which already threads `resultArg`/TEMP end-to-end.

### P1 — BUMPENVMAT00/01/10/11 + BUMPENVLSCALE/LOFFSET are captured but dead

- **Our code**: not present anywhere in `ddraw/constants.ts`; no reader in `ffp-stages.ts` or
  `shader-generator.ts`. `caps.ts:154` correctly clears `D3DTEXOPCAPS_BUMPENVMAP[LUMINANCE]`
  bits, so this one is *honestly* not advertised — it's MISSING, not silently wrong, and lowest
  priority of the P1 group since no game can be fooled into relying on it.
- **Ground truth**: `d3d9-device.ts:355-360,8729-8734` (D3D9 path) shows the real 2×2 matrix +
  scale/offset wiring into the pixel-shader constant slot for BUMPENVMAP; DXVK
  `d3d9_fixed_function_frag.glsl:224-225,258,409-410`.
- **Fix sketch**: out of scope until D3DTOP_BUMPENVMAP/LUMINANCE themselves are implemented on
  the D3D8 path (which happens automatically under §0's unification).

### P2 — TEXCOORDINDEX UV set >2 silently falls back to UV set 0 (confirmed live gap: XIII/UE2)

- **Our code**: two compounding gaps, not one:
  1. **Vertex conversion never captures a 4th UV set at all.** The converted 64-byte vertex
     format is `pos(4)+normal(3)+diffuse(1)+specular(1)+uv0(2)+uv1(2)+uv2(2)+pad(1)`
     (`src/worker/backends/webgpu/ddraw/compute/vertex-converter.ts:40`), and `uv2u`/`uv2v` are
     the last texcoord pair read from the guest FVF regardless of how many `D3DFVF_TEXn` sets it
     declares (lines 1070-1075). A guest vertex with a 4th texcoord set simply has that data
     dropped before the draw even reaches the stage cascade.
  2. **The shader-side selector also caps at index 2.** `selectTexCoord` in
     `shader-generator.ts:177-186` only checks `index==1`/`index==2`, defaulting everything else
     to `uv0`. `MAX_FFP_UV_SETS=3` (`ffp-stages.ts:56`).
  The detector that surfaces this live is `ddraw-backend-executor.ts:4446-4455`
  (`"FFP: stage N TEXCOORDINDEX=3 references UV set >2 — only 3 UV sets are converted, falling
  back to UV set 0"`).
- **Ground truth**: D3D8/D3D9 both support up to 8 texcoord sets per vertex
  (`D3DFVF_TEXCOORDSIZE*` × 8); DXVK's FF vertex shader carries all declared sets through.
- **Observable symptom (confirmed live, XIII/Unreal Engine 2)**: any stage whose
  `TEXCOORDINDEX` selects UV set 3+ (a second/third independent texcoord channel — typically a
  lightmap or detail-texture UV that is deliberately *not* aligned with the base UV, that's the
  whole point of a separate channel) instead samples with the base texture's UV. Cost: the
  lightmap/detail layer tiles or stretches identically to the base texture instead of at its own
  scale/offset — visible as blocky, misaligned, or over/under-tiled lighting on any surface using
  a second UV channel. Silently wrong: no error, no black, just wrong-looking (but plausible)
  shading — the hardest class to spot without a diff against real hardware.
- **Fix sketch**: this is NOT purely a shader fix — the vertex converter must first be widened
  to carry more UV sets (size the converted vertex from the FVF's actual texcoord count, up to
  the stage limit fixed above, rather than the fixed 3), and the WGSL `VertexOutput`/varyings
  need a matching `uv3`..`uvN` (the fragment shader's `emitStageBlock` already parameterizes
  `uv${s}` per stage in `emitStageBlock` (`shader-generator.ts:309`), so the sampled-stage side scales for free once
  the vertex side carries the data and `MAX_FFP_UV_SETS` is raised to match
  `MAX_FFP_SAMPLED_STAGES`).

### P2 — Texture-transform matrices only exist for stages 0-2 (D3DTS_TEXTURE0..7 has 8)

- **Our code**: `MAX_FFP_TEX_MATRICES=3` (`ffp-stages.ts:60`); `resolveTexXformFlags` in
  `ddraw-backend-executor.ts:2196-2216` loops `stage < MAX_FFP_TEX_MATRICES`. Stage 3's comment
  in `shader-generator.ts:548` states outright: *"Stage 3 has no texture-matrix slot ...
  untransformed source."* Stages 4-7 have no matrix or transform-flag plumbing at all (moot
  today since those stages can't sample anyway — see P0 above — but becomes live the moment
  `MAX_FFP_SAMPLED_STAGES` is raised).
- **Ground truth**: D3DTS_TEXTURE0..7 — 8 independent texture matrices, one per stage
  (`D3DTRANSFORMSTATE_TEXTURE0..7`, already defined in our own `ddraw/constants.ts:558-565` but
  only the first 3 are ever read for D3D8/DDraw draws).
- **Observable symptom**: `SetTextureStageState(3, D3DTSS_TEXTURETRANSFORMFLAGS, ...)` +
  `SetTransform(D3DTS_TEXTURE3, m)` is silently ignored — stage 3's texcoords are the raw
  passthrough/texgen source with no projection or scale/offset applied, even though the game set
  a texture-transform matrix explicitly.
- **Fix sketch**: raise `MAX_FFP_TEX_MATRICES` to match the widened stage count (again free
  under §0 — `FFP_MAX_TEX_MATRICES = FFP_MAX_STAGES = 8` already in `ffp-lighting.ts:88`).

## 3. Confirmed IMPLEMENTED — for completeness, not further action

- Per-stage defaulting rules (stage 0 → MODULATE/SELECTARG1 defaults, stages 1+ → DISABLE
  default), the "raw 0 = uninitialized" convention, and cascade termination on the first
  DISABLE stage: `ffp-stages.ts:139-278`, matches D3D7/D3D8 SDK documented behavior.
- D3DTA_COMPLEMENT / D3DTA_ALPHAREPLICATE modifier bits and their combination order:
  `shader-generator.ts:207-209,231-233` — numerically equivalent to DXVK's order
  (`d3d9_fixed_function_frag.glsl:304-309`) since complement-then-broadcast and
  broadcast-then-complement of a scalar give the same result.
- D3DTSS_COLORARG0/ALPHAARG0 for the two triadic ops (MULTIPLYADD, LERP), including the
  `readsArg0()` gate in `ffp-stages.ts:185` that correctly excludes stale ARG0 state from
  falsely marking an otherwise-pure-arithmetic stage as texture-wanting.
- D3DTSS_TCI_CAMERASPACENORMAL/POSITION/REFLECTIONVECTOR texgen, including the view-space
  vertex-shader inputs feeding them: `shader-generator.ts:373-379,482-489`.

## 4. Summary of what a real fix looks like

All P0/P1/P2 items above collapse to one project: make D3D8 draws use the same
stage-resolution/combiner code D3D9 already has (`ffp-combiner.ts`,
`d3d9-device.ts`'s `FFP_MAX_STAGES=8`/`resultArg`/BUMPENVMAT wiring), instead of the
D3D7-era `ffp-stages.ts` + `shader-generator.ts` pair that `DDrawWebGPUExecutor` still uses.
That pair was never wrong for what it was built for (D3D7's DirectDraw/D3D FFP, which really is
capped at fewer stages/ops) — the bug is that D3D8 was wired to reuse it instead of getting its
own faithful (=D3D9-equivalent) implementation, while `d3d8/caps.ts` was written (largely
copy-pasted from `d3d9/caps.ts`) as if that unification had already happened.
