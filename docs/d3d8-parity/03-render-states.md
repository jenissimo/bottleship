# D3D8 Parity Audit — D3DRENDERSTATETYPE (blend / alpha test / depth-stencil / fog / cull)

Scope: `src/worker/modules/d3d8/state.ts` + `fast-path.ts` (SetRenderState entry points),
`src/worker/backends/webgpu/d3d8/d3d8-device-adapter.ts` (state storage + defaults),
consumed by the **shared DDraw/D3D3-7 FFP backend** — `src/worker/backends/webgpu/ddraw/{pipeline-factory,shader-generator,ddraw-backend-executor,types,ring-buffer-manager}.ts`.
D3D8 does **not** have its own render-state → GPU-state translation; it reuses the legacy
`D3DRENDERSTATE_*` enum and pipeline factory that also serves the DirectDraw/D3D3-7 path.
The D3D9 backend (`src/worker/backends/webgpu/d3d9/`) has an independent, more complete
implementation (`d3d9-blend.ts`, `d3d9-state-tracker.ts`) that recently got a parity pass —
several of the gaps below are things D3D9 already fixed and D3D8 never inherited.

Ground truth: `G:/sources/dxvk/src/d3d9/d3d9_util.cpp` (`DecodeBlendFactor`/`DecodeBlendOp`),
`d3d9_util.h` (`FixupBlendState`), `d3d9_device.cpp` (state defaults), Wine
`include/d3d8types.h` / `include/d3dtypes.h` (canonical D3DRENDERSTATETYPE enum values for
D3D8 and D3D3-7 respectively).

## 1. Verdict table

Key: state number is the shared `D3DRENDERSTATE_*` value used by both the DDraw/D3D7 legacy
enum and D3D8 (they are numerically identical for every state below 174).

| # | Name | Verdict | Notes |
|---|------|---------|-------|
| 7 | ZENABLE | IMPLEMENTED | `D3DZB_TRUE`/`D3DZB_USEW` both normalized to "test enabled" (pipeline-factory.ts:316-317); USEW is treated as regular Z, matching the D3D9 device policy comment. |
| 8 | FILLMODE | MISSING | Default seeded (D3DFILL_SOLID) but **never read** anywhere in pipeline/shader/executor. WIREFRAME/POINT fill silently renders SOLID. (WebGPU has no polygon-mode rasterizer state, so WIREFRAME needs a geometry-expansion fallback, not a 1:1 map — but today there isn't even a warning.) |
| 9 | SHADEMODE | PARTIAL | Only FLAT vs non-FLAT distinguished (pipeline-factory.ts:405,588; shader-generator.ts:64). TOON/PHONG collapse to GOURAUD — matches real HW (neither is HW-supported), so this is fine. |
| 14 | ZWRITEENABLE | IMPLEMENTED | ANDed with zEnable per D3D9's documented WebGPU workaround. |
| 15 | ALPHATESTENABLE | IMPLEMENTED | |
| 16 | LASTPIXEL | N/A (unimplemented, correctly) | Legacy DX5 rasterizer hint; dxvk itself just seeds `TRUE` and never consumes it. No action needed. |
| 19 | SRCBLEND | **SILENTLY-WRONG** | See §2.1 — `D3DBLEND_BOTHSRCALPHA`(12)/`BOTHINVSRCALPHA`(13) fall through `mapBlendFactor`'s `default: return "src-alpha"` instead of expanding into the (src,dst) pair the spec mandates. |
| 20 | DESTBLEND | **SILENTLY-WRONG** | Same root cause — the implied-destination legacy modes never override the DESTBLEND register. |
| 22 | CULLMODE | IMPLEMENTED | |
| 23 | ZFUNC | IMPLEMENTED | Deliberate EQUAL→LESSEQUAL divergence for coplanar/decal passes (writes-off only) — documented, intentional, out of scope here. |
| 24 | ALPHAREF | IMPLEMENTED | Correctly treated as integer 0..255 (not normalized float) — `ring-buffer-manager.ts:550,956` clamp+round+mask. |
| 25 | ALPHAFUNC | IMPLEMENTED | Full 8-way switch in both the WGSL alpha-discard codegen and the MegaBatch dynamic-uniform path (shader-generator.ts:96-119, 881-890). |
| 26 | DITHERENABLE | MISSING (no-op) | Not read anywhere; WebGPU has no dithering control. Matches most modern backends (dxvk ignores it on non-Vulkan-dithering HW too) — low priority. |
| 27 | ALPHABLENDENABLE | IMPLEMENTED | |
| 28 | FOGENABLE | IMPLEMENTED | Feeds `resolveFfpFogMode`. |
| 29 | SPECULARENABLE | IMPLEMENTED | |
| 30 | ZVISIBLE | N/A | Removed from D3D9, never implemented in DX-era drivers either (`D3DERR_UNSUPPORTED` historically). No action. |
| 34 | FOGCOLOR | IMPLEMENTED | RGB extracted correctly (`ddraw-backend-executor.ts:4560-4562`); alpha channel of fog color is architecturally unused in D3D FFP, so dropping it is correct. |
| 35 | FOGTABLEMODE | IMPLEMENTED | |
| 36 | FOGSTART | IMPLEMENTED | Correctly bit-cast via `dwordToFloat` (float-as-DWORD convention), not treated as an integer. |
| 37 | FOGEND | IMPLEMENTED | Same. |
| 38 | FOGDENSITY | IMPLEMENTED | Same. |
| 40 | EDGEANTIALIAS | N/A | D3D8-only, dropped by D3D9; legacy line/edge-AA hint no modern HW honors. Not implemented — correct to leave as a no-op. |
| 41 | COLORKEYENABLE | IMPLEMENTED | Gated on the texture actually carrying a `srcColorKey` (matches real semantics: the state is inert without a keyed texture). |
| 47 | ZBIAS | PARTIAL | D3D8's integer 0..16 ZBIAS *is* implemented (unlike D3D9's float DEPTHBIAS, this is the correct D3D8 convention) but via a crude linear heuristic (`-zBias * 4`, pipeline-factory.ts:820,1028) rather than a value calibrated against the 24-bit depth attachment the way D3D9's `DEPTH_BIAS_UNITS_PER_UNORM24` scale is. Functionally present, numerically arbitrary. |
| 48 | RANGEFOGENABLE | **MISSING** | See §2.2 — exists in D3D8 (and D3D3-7!) identically to D3D9, but the shared DDraw/D3D8 fog path has a comment claiming it's D3D9-only and never threads it through; D3D9's own separate implementation (`d3d9-device.ts:4877,7386-7410`) has real range-fog. |
| 52-59 | STENCILENABLE/FAIL/ZFAIL/PASS/FUNC/REF/MASK/WRITEMASK | IMPLEMENTED | Full stencil pipeline; masks seeded to `0xff` default (not the trap-prone unseeded-0). No two-sided stencil in the pipeline (`stencilFront`==`stencilBack` always) — **this is correct**, D3D8 has no `D3DRS_TWOSIDEDSTENCILMODE`/`CCW_STENCIL*` (D3D9-only, values 185-189). |
| 60 | TEXTUREFACTOR | IMPLEMENTED | Feeds both the TSS `D3DTA_TFACTOR` arg and the uniform block. |
| 128-135 | WRAP0-7 | MISSING | Not defined/consumed at all. Legacy cubic-environment-mapping wrap flags; low real-world usage (mostly superseded by TSS ADDRESSU/V + cube textures in D3D8-era titles). Low priority. |
| 136 | CLIPPING | N/A (correctly unimplemented) | dxvk itself tracks-but-never-consumes this (hardware always clips); matches real driver behavior. |
| 137 | LIGHTING | **SILENTLY-WRONG (self-documented)** | Default seeded FALSE at `d3d8-device-adapter.ts:582`, with an explicit in-code "KNOWN DEVIATION" comment: real D3D8 default is TRUE. A title that never calls `SetRenderState(LIGHTING,...)` and relies on the documented default renders unlit. |
| 139 | AMBIENT | IMPLEMENTED | |
| 140 | FOGVERTEXMODE | IMPLEMENTED | |
| 141 | COLORVERTEX | IMPLEMENTED | Default TRUE correctly seeded (with a comment explaining why an unseeded 0 would be catastrophic — collapses every material source to MATERIAL). |
| 142 | LOCALVIEWER | IMPLEMENTED | Default TRUE seeded; feeds specular half-vector selection. |
| 143 | NORMALIZENORMALS | **MISSING** | Comment at shader-generator.ts:530 explicitly states "the ddraw uniform block carries no D3DRENDERSTATE_NORMALIZENORMALS". Non-unit-length normals (common after non-uniform scale in world matrix) will over/under-light. |
| 145-148 | DIFFUSE/SPECULAR/AMBIENT/EMISSIVEMATERIALSOURCE | IMPLEMENTED | Full 4-source resolution, matches D3D9 tracker defaults. |
| 151 | VERTEXBLEND | IMPLEMENTED | (imported, used for skinning weight count) |
| 152 | CLIPPLANEENABLE | IMPLEMENTED | Per-draw bitmask threaded into world-space clip-plane evaluation, matching DXVK's `emitVsClipping` approach. |
| 153 | SOFTWAREVERTEXPROCESSING | MISSING (no functional gap) | Neither the render state nor `SetSoftwareVertexProcessing`/`GetSoftwareVertexProcessing` methods exist. Harmless: we always do FFP T&L in WGSL regardless of HW/SW/MIXED, so there is no behavior to diverge — but `GetSoftwareVertexProcessing` will not round-trip a prior `Set`. Low priority. |
| 154 | POINTSIZE | IMPLEMENTED | Correct float-as-DWORD bit-cast (`rsFloat`), defaults seeded to 1.0f distinguishably from "unset". |
| 155 | POINTSIZE_MIN | IMPLEMENTED | |
| 156 | POINTSPRITEENABLE | IMPLEMENTED | |
| 157 | POINTSCALEENABLE | IMPLEMENTED | |
| 158-160 | POINTSCALE_A/B/C | IMPLEMENTED | Full distance-attenuation formula (`ddraw-backend-executor.ts:3984-3990`). |
| 161-162 | MULTISAMPLEANTIALIAS/MASK | MISSING | Not defined/consumed. Per-draw MSAA toggle/mask; rare in practice (titles set device-level MSAA once). Low priority. |
| 163-164 | PATCHEDGESTYLE/PATCHSEGMENTS | MISSING | N-patch tessellation; essentially unused by D3D8-era titles outside a handful of tech demos. Low priority, matches "no N-patch support" being an acceptable gap. |
| 166 | POINTSIZE_MAX | IMPLEMENTED | Defaults seeded to 8192.0f (matches advertised cap). |
| 167 | INDEXEDVERTEXBLENDENABLE | IMPLEMENTED | (imported in device-adapter for skinning) |
| 168 | COLORWRITEENABLE | IMPLEMENTED | Locally re-declared as `168` in pipeline-factory.ts (not imported from the shared constants module — see §3) but numerically correct and default-seeded to `0xF` (all channels), avoiding the same unseeded-0 trap called out for D3D9. |
| 170 | TWEENFACTOR | MISSING | Keyframe vertex-tween interpolation factor for `D3DFVF_XYZB*` + tweening; not read. Very rare usage even in period titles. Low priority. |
| 171 | BLENDOP | IMPLEMENTED | Locally re-declared as `171` (same pattern as COLORWRITEENABLE); full 5-op switch, default ADD. |
| 172-173 | POSITIONORDER/NORMALORDER | MISSING | D3DX-tessellation-only legacy states (RTPatches), practically dead even in period titles. Low priority. |

## 2. Prioritised findings

### 2.1 SILENTLY-WRONG — `D3DBLEND_BOTHSRCALPHA`/`BOTHINVSRCALPHA` never expanded (the "saturates to white" class)

**Ground truth** (`G:/sources/dxvk/src/d3d9/d3d9_util.h:33-44`, `FixupBlendState`):

```cpp
if (State.Src == D3DBLEND_BOTHSRCALPHA) {
  State.Src = D3DBLEND_SRCALPHA;
  State.Dst = D3DBLEND_INVSRCALPHA;      // DESTBLEND register is IGNORED
}
else if (State.Src == D3DBLEND_BOTHINVSRCALPHA) {
  State.Src = D3DBLEND_INVSRCALPHA;
  State.Dst = D3DBLEND_SRCALPHA;         // DESTBLEND register is IGNORED
}
```

`D3DBLEND_BOTHSRCALPHA`(12) and `D3DBLEND_BOTHINVSRCALPHA`(13) are legacy DX6-era values that
only ever appear in `D3DRS_SRCBLEND` — when present, they **imply** the destination factor and
the app's `D3DRS_DESTBLEND` value is meaningless. This is confirmed for D3D8 specifically: Wine
`include/d3d8types.h:522-524` defines both values identically, and D3D8's max `D3DBLEND_` value
is 13 (`D3DBLEND_BLENDFACTOR`(14)/`INVBLENDFACTOR`(15) are D3D9-only additions, so D3D8 titles
using 12/13 are hitting a real, spec-legal, still-current-in-2000-era-engines code path, not a
theoretical corner).

**Our code** never performs this expansion, in **four separate call sites**, all in the shared
DDraw/D3D8 pipeline factory:

- `src/worker/backends/webgpu/ddraw/pipeline-factory.ts:73-90` — `mapBlendFactor()`: cases 1-11
  are mapped, everything else (including 12/13) falls to `default: return "src-alpha"`.
- `pipeline-factory.ts:344-346` (`getOrCreatePipeline`) and `:527-529`
  (`getOrCreateMegaBatchPipeline`): `effectiveSrcBlend`/`effectiveDstBlend` are computed as
  `srcBlend || 2` / `dstBlend || 1` — a "default when zero" fallback only, no BOTH* handling.
- `pipeline-factory.ts:744-745` and `:940-941` (`createPipeline`/MegaBatch `createPipeline`,
  the actual `GPUBlendState` construction sites) — same pattern, feeding straight into
  `mapBlendFactor()`.
- `src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts:4588-4595` — the premultiplied-alpha
  heuristic (`premultiplyOutput`) reads the same un-fixed `effectiveSrcBlend`/`effectiveDstBlend`
  pair, so it also mis-evaluates draws using BOTH*SRCALPHA (though its consequence there is
  milder — it just fails to detect premultiply for a state that happens not to need it).

**Concrete failure**: a title sets `SRCBLEND = D3DBLEND_BOTHSRCALPHA` (12) and leaves
`DESTBLEND` at whatever it was previously (commonly its own device-default `D3DBLEND_ZERO`(1),
or a still-set `D3DBLEND_ONE`(2) from an earlier state). Real D3D8 renders this as
`src*SRCALPHA + dst*INVSRCALPHA` (a standard alpha-blend). Our code renders
`mapBlendFactor(12)` → falls to `default` → `"src-alpha"` for the **source** factor (which
happens to coincidentally match!) but the **destination** factor is `mapBlendFactor(dstBlend)`
— e.g. `mapBlendFactor(1)` = `"zero"` if DESTBLEND was never touched, giving
`src*SRCALPHA + dst*ZERO` (alpha-only masking, no blend-through) — or worse,
`mapBlendFactor(2)` = `"one"` if DESTBLEND carries a stale `ONE`, giving
`src*SRCALPHA + dst*ONE`, which is exactly the "accumulate toward white" saturation bug this
audit was asked to hunt for. `BOTHINVSRCALPHA`(13) is strictly worse: the *source* factor is
also wrong (`default` → `"src-alpha"` instead of the spec's `"one-minus-src-alpha"`).

**Fix sketch**: port `fixupBoth()` verbatim from
`src/worker/backends/webgpu/d3d9/d3d9-blend.ts:119-123` into a shared helper (or straight into
`pipeline-factory.ts`, since D3D8 and DDraw/D3D7 share this file and D3D3-7 predate 12/13 anyway
— they're harmlessly unreachable there) and call it once, at the top of each of the four
`effectiveSrcBlend`/`effectiveDstBlend` computations, before the `|| 2`/`|| 1` default-fallback:

```ts
const [fixedSrc, fixedDst] = fixupBothSrcAlpha(srcBlend, dstBlend);
const effectiveSrcBlend = effectiveAlphaBlend ? (fixedSrc || 2) : 0;
const effectiveDstBlend = effectiveAlphaBlend ? (fixedDst || 1) : 0;
```

Also extend `mapBlendFactor()`'s `default` case to `Logger.warn` on a genuinely unknown value
(current silent `"src-alpha"` fallback for *any* out-of-range input, not just 12/13, hides other
future mistakes the same way).

### 2.2 MISSING — `D3DRS_RANGEFOGENABLE` never reaches the D3D8/DDraw fog path

`shader-generator.ts:552-555` carries a comment stating range fog "is a D3D9 render state" and
that the range branch is "unreachable here" because `ddraw-backend-executor.ts` calls
`resolveFfpFogMode` with no range-fog argument. This premise is incorrect: Wine
`include/d3dtypes.h:878` / `include/d3d8types.h` (transitively, via the shared D3D3-9
`D3DRENDERSTATETYPE=48` numbering) confirms `D3DRENDERSTATE_RANGEFOGENABLE` existed from D3D3
onward, unchanged at value 48 through D3D9. D3D9's own separate implementation
(`src/worker/backends/webgpu/d3d9/d3d9-device.ts:4877,7386-7410`) *does* implement it (true
Euclidean eye-distance fog vs. the depth-only approximation), confirming the feature is real and
already solved once — just not inherited by the shared DDraw/D3D8 path. Symptom: any D3D8 (or
D3D3-7) title that explicitly requests range fog for correct wide-FOV fog falloff gets the
depth-only approximation instead — most visible as fog being too thin at the edges of the screen
relative to the center, worse with wider FOV.

**Fix sketch**: add `D3DRENDERSTATE_RANGEFOGENABLE = 48` to `modules/ddraw/constants.ts`, thread
it into `resolveFfpFogMode`'s existing (already-supports-range, per the D3D9 caller) signature,
and pass eye-space Euclidean distance instead of `out.position.z` when set — the WGSL formula
already exists in the shared `ffp-fog.ts`/`ffpFogFactor`, this is purely a wiring gap.

### 2.3 SILENTLY-WRONG (self-flagged) — `D3DRENDERSTATE_LIGHTING` default is FALSE, spec says TRUE

`d3d8-device-adapter.ts:576-582` seeds `LIGHTING = 0` with an explicit comment acknowledging the
D3D8/D3D9 documented default is `TRUE`, done deliberately to keep parity with the D3D7 backend's
existing (also-wrong) behavior rather than fix both. Any D3D8 title that relies on the documented
default and never calls `SetRenderState(D3DRS_LIGHTING, TRUE)` — legal, spec-compliant, and a
real pattern in period titles that only ever *disable* lighting for particular draws — renders
completely unlit (black, or whatever `AMBIENT` provides) instead of lit. Because it's an
already-acknowledged deviation, the fix is a one-line default flip plus verification that no
currently-working D3D7 title regresses (the comment names this as the blocking condition).

### 2.4 MISSING — `D3DRENDERSTATE_NORMALIZENORMALS` (143) is not carried at all

`shader-generator.ts:530` states plainly the uniform block has no slot for it. Per-vertex normal
length is not renormalized after the world-matrix transform, so any object with non-uniform
scale in its world matrix gets incorrect (too bright/too dark) FFP lighting — silent, and easy to
misdiagnose as a lighting-formula bug rather than a missing normalization stage. Not urgent unless
a concrete title's lighting artifact traces back to this, but worth a one-line note the next time
someone chases an FFP-lighting-intensity bug on D3D8.

### 2.5 MISSING — `D3DRENDERSTATE_FILLMODE` (8) is stored but never consumed

Wireframe (`D3DFILL_WIREFRAME`) and point (`D3DFILL_POINT`) fill modes are legal D3D8 states with
no consumer anywhere in the pipeline/shader/executor stack — only the SOLID default is ever
produced. WebGPU's `GPUPrimitiveState` has no polygon-mode equivalent to Vulkan's
`VK_POLYGON_MODE_LINE`, so a 1:1 translation isn't available; a faithful implementation needs
either a geometry-shader-less line-strip expansion of each triangle's edges, or accepting the gap
explicitly with a one-time warning log the first time a title requests it (titles that use
wireframe are almost always debug/dev builds, so low real-world priority — but currently there is
no signal at all that the state was ignored).

## 3. What to inherit from the done D3D9 work

`src/worker/backends/webgpu/d3d9/d3d9-blend.ts` is a complete, already-fixed reference for
everything D3D8 shares structurally with D3D9's fixed-function blend/depth/stencil model:

- **`fixupBoth()`** (lines 119-123) — the exact function needed for §2.1. D3D8 doesn't have
  `D3DBLEND_BLENDFACTOR`/`INVBLENDFACTOR`/`SRCCOLOR2`/`INVSRCCOLOR2` (14-17, D3D9-only
  additions), so D3D8's port only needs the `BOTHSRCALPHA`/`BOTHINVSRCALPHA` branches — simpler
  than the full D3D9 version, not more.
- **`isD3D9BlendStateRepresentable`/`isD3D9DepthStencilStateRepresentable`** (lines 141-155,
  303-323) — a validate-before-build pattern that turns an invalid/unrepresentable enum value
  into an explicit refusal instead of a silent wrong-default. `pipeline-factory.ts`'s
  `mapBlendFactor`/`mapDepthCompareFunction`/`mapStencilOperation` currently just `Logger.warn`
  and pick a default (or, for blend factors, don't even warn) — D3D8 should adopt the same
  "reject before it reaches `createRenderPipeline`" discipline, since a silently-defaulted wrong
  blend factor is exactly the class of bug in §2.1.
- **`rsAsFloat()`'s `Number.isFinite` guard** (lines 259-266) — D3D8's `dwordToFloat` call sites
  for FOGSTART/END/DENSITY and the point-size states should be checked for the same NaN/Inf
  defense; a garbage float DWORD reaching `createRenderPipeline` deletes the whole draw the same
  way it would on D3D9.
- **The `D3DRS_LIGHTING` default of `TRUE`** in the D3D9 state tracker is the correct one; §2.3
  is D3D8 (and D3D7) diverging from D3D9's already-fixed value, not the other way around.
- **Two-sided stencil is correctly absent** from D3D8 — nothing to inherit there; D3D9's
  `D3DRS_TWOSIDEDSTENCILMODE`/`CCW_STENCIL*` genuinely don't exist in the D3D8 enum.
- **Range fog** (§2.2) — D3D9's `d3d9-device.ts` implementation is the existing, working
  reference; the gap is purely that the shared DDraw/D3D8 path never got the same treatment.

## 4. Defaults at device creation / Reset

`initDefaultStates()` (`d3d8-device-adapter.ts:551-641`) is called both from device construction
and from `reset()` (`:886`), so Reset correctly restores D3D8 defaults rather than leaking
pre-Reset state — this matches real D3D8 semantics (Reset resets the render-state block).
Verified present and correct: ZENABLE/ZWRITEENABLE/ZFUNC, FILLMODE, SHADEMODE, ALPHATEST*,
ALPHABLENDENABLE/SRCBLEND/DESTBLEND, CULLMODE, DITHERENABLE, FOG* (mode + float params),
COLORKEYENABLE, TEXTUREFACTOR, all four MATERIALSOURCE states, COLORVERTEX/LOCALVIEWER (seeded
TRUE — with the explicit trap-avoidance comment about Int32Array's unseeded-0 == FALSE hazard),
POINTSIZE/_MIN/_MAX, COLORWRITEENABLE (0xF), BLENDOP (ADD), STENCILMASK/WRITEMASK (0xff), and the
per-stage TSS defaults (stage 0 modulate-with-diffuse, stages 1-7 DISABLE, WRAP addressing,
POINT filtering). The one confirmed-wrong default is LIGHTING (§2.3).
