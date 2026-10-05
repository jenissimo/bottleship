# D3D8 Parity Audit — Vertex Pipeline (declarations / streams / index buffers / draw entry points / FVF)

Scope per assignment: `vsd-parser.ts`, `vsd-constants.ts`, `decl-to-ffp.ts`, `d3d8-shader-registry.ts`,
`d3d8-device-adapter.ts` (stream/index/draw paths), `modules/d3d8/state.ts` + `resources.ts`,
`shared/vertex-streams.ts`. Ground truth: `G:/sources/dxvk/src/d3d8/d3d8_shader.cpp`,
`d3d8_device.cpp`, `d3d8_batch.h`, cross-checked against `G:/sources/wine`.

Audit only — no source files modified, emulator not driven.

## 1. Verdict table

| Area | Verdict | Notes |
|---|---|---|
| D3DVSD token grammar (STREAM/STREAMDATA/SKIP/END) | IMPLEMENTED | `vsd-parser.ts` |
| D3DVSD_STREAM_TESS | PARTIAL | detected and skipped with a warning, not translated (matches dxvk's own TODO) |
| D3DVSD_CONSTMEM (inline VS constant defs) | MISSING | tokens dropped with a warning; dxvk emits `DEF` instructions for these |
| D3DVSD_TOKEN_EXT | MISSING | dropped with a warning; matches dxvk (also a no-op there) |
| D3DVSDT_* type sizes (FLOAT1..4, D3DCOLOR, UBYTE4, SHORT2/4) | IMPLEMENTED | `declTypeSize` matches dxvk's `D3D9_DECL_TYPE_SIZES` exactly for indices 0–7 |
| Register→usage table, v0–v14 | IMPLEMENTED | matches dxvk's `D3D8_VERTEX_INPUT_REGISTERS` |
| Register→usage table, v15/v16 (POSITION2/NORMAL2) | MISSING | not modeled at all — see Finding 4 |
| Decl-only (CreateVertexShader, pFunction=NULL) FFP path | PARTIAL | single-stream canonical case solid; multi-stream/remap has real gaps — Findings 1–2 |
| D3DCOLOR vs UBYTE4 disambiguation, programmable VS input | IMPLEMENTED | `declTypeInfo` in `shader/link/index.ts` swizzles D3DCOLOR (BGRA→RGBA), leaves UBYTE4 raw |
| D3DCOLOR vs UBYTE4 disambiguation, decl-only FFP interleave | SILENTLY-WRONG | Finding 1 |
| Texcoord sizes other than FLOAT2 (FLOAT1/3/4), decl-only FFP | SILENTLY-WRONG | Finding 2 |
| Multiple UV sets (TEXCOORD0..7), programmable VS | IMPLEMENTED | canonical usage/usageIndex path, arbitrary count |
| SetStreamSource (16 streams, no offset in D3D8) | IMPLEMENTED | `streamSources` sized 16, matches `D3D8_MAX_STREAMS` |
| SetIndices(pIB, BaseVertexIndex) | IMPLEMENTED | folds base vertex into IB binding, matches D3D8 (vs D3D9 where it moved to Draw call) |
| SetIndices interaction with state blocks | IMPLEMENTED | `recordStateBlock({op:'indices', ...})` path present |
| DrawPrimitive / DrawIndexedPrimitive, FFP (decl-only or FVF) path | IMPLEMENTED | delegates to the shared ddraw executor, which handles POINTLIST/TRIANGLEFAN/TRIANGLESTRIP/LINESTRIP expansion |
| DrawPrimitive / DrawIndexedPrimitive / *UP, **programmable VS** path | SILENTLY-WRONG | Finding 5 (top priority) |
| primCount→vertexCount math, all D3DPRIMITIVETYPEs | IMPLEMENTED | `primCountToVertexCount` correct for POINTLIST/LINELIST/LINESTRIP/TRIANGLELIST/STRIP/FAN |
| 16- vs 32-bit indices | IMPLEMENTED | `ib.format === 102` (D3DFMT_INDEX32) gate, consistent across all 4 draw entry points |
| Programmable vertex shaders (vs.1.1 bytecode) | IMPLEMENTED | `createVertexShader` compiles via the shared D3D9 `compileVertexShader`; `v#` register binds directly by `elem.reg` since vs_1_1 carries no `dcl` (see `buildVertexInputs`, `link/index.ts:808-836`) — a real and reasonably faithful recreation of dxvk's synthesize-dcl step |
| Programmable VS constants (SetVertexShaderConstant, 96 regs) | IMPLEMENTED | bank sized to `D3D8_MAX_VS_CONST`, bounds-checked |

## 2. Findings, prioritised

### Finding 1 — SILENTLY-WRONG: decl-only FFP interleave can't tell D3DCOLOR from UBYTE4

**File:** `src/worker/backends/webgpu/d3d8/decl-to-ffp.ts:86-92` (`canonicalFvfSlotSize`), used at
lines 150-163 (multi-stream) and 178-190 (single-stream remap).

`canonicalFvfSlotSize` accepts any DIFFUSE/SPECULAR-register element into the canonical COLOR slot
purely by **byte size** (`usage === D3DDECLUSAGE_COLOR ? 4 : ...`) — it never checks the D3DVSDT_*
type. `declTypeSize` reports 4 for both `D3DVSDT_D3DCOLOR` (type 4) and `D3DVSDT_UBYTE4` (type 5),
so a decl that declares its diffuse register as UBYTE4 (legal, and used by some engines that pack
diffuse as raw RGBA rather than D3D's BGRA-swizzled D3DCOLOR) passes the size check and gets copied
byte-for-byte into the synthetic FVF's D3DFVF_DIFFUSE slot.

The FFP fixed-function renderer (`decl-to-ffp` synthesizes a *standard* FVF; the shared FFP shader
generator that consumes `D3DFVF_DIFFUSE` unconditionally assumes D3DCOLOR packing — see
`ffp-combiner.ts` / the D3D9 FFP vertex path this synthetic FVF feeds) always applies the D3DCOLOR
(BGRA→RGBA) interpretation. A UBYTE4-typed diffuse register therefore renders with R/B swapped —
no warning fires (the size check passed), no draw is dropped: colors are just wrong on screen.

**Ground truth:** dxvk (`d3d8_shader.cpp:143`) copies `D3DDECLTYPE(type)` straight through into the
D3D9 vertex element and lets the *D3D9 runtime's own* declaration-typed fetch (unorm8x4 BGRA vs
uint8x4) do the disambiguation per-element — it never collapses to one packing assumption.

**Fix sketch:** `canonicalFvfSlotSize`/the copy-plan builder must additionally require
`e.type === D3DVSDT_D3DCOLOR` for a COLOR-usage element to be treated as faithful; a UBYTE4-typed
COLOR register should either (a) be interleaved with an explicit byte-swizzle (ABGR→canonical) at
copy time, or (b) fall through to `faithful:false` like any other unrepresentable element, which is
at least visible in the log rather than silently swapped.

### Finding 2 — SILENTLY-WRONG: non-FLOAT2 texcoords collapse the whole interleave, not just that element

**File:** `decl-to-ffp.ts:90` (`canonicalFvfSlotSize` returns a hardcoded `8` for any TEXCOORD usage)
and the multi-stream loop at `decl-to-ffp.ts:149-163`.

Canonical FVF only carries FLOAT2 texcoords, so a FLOAT1/FLOAT3/FLOAT4-typed texcoord register
(`declTypeSize` = 4/12/16) never matches the hardcoded slot size of 8. That's the *correct* detection
— but the failure mode is a `break` out of the **entire** copy-plan loop (`mappable = false; break;`
at line 159-160), which discards every element's copy plan, not just the offending texcoord. The
caller then falls back to `{fvf, stride: declStride, faithful:false}` with **no interleave at all**:
the draw proceeds reading the guest VB at the synthetic FVF's canonical offsets, which do not match
the guest's actual (non-canonical) multi-stream layout. Position/normal/color for an otherwise
perfectly representable decl gets corrupted too, not just the one non-FLOAT2 UV set.

**Fix sketch:** either (a) drop only the offending texcoord from the synthetic FVF (reduce `texCount`,
keep the rest of the interleave plan faithful), matching how real D3D9 FFP silently ignores a texture
stage it isn't sampling, or (b) widen the canonical layout to carry the texcoord at its native size
(non-standard FVF, still representable as an interleave target) instead of hardcoding 8. Either is
strictly better than discarding the whole plan for one element.

### Finding 3 — MISSING: D3DVSD_CONSTMEM inline constant definitions dropped

**File:** `vsd-parser.ts:156-163`. `D3DVSD_TOKEN_CONSTMEM` is logged and skipped; the DWORDs that
follow it in the token stream (the constant data itself, per dxvk `d3d8_shader.cpp:216-231`) are
never consumed either — the parser doesn't even advance `i` past them if a raw token array is fed in
oddly, though `readTokenStream`'s straight linear scan happens to still find `D3DVSD_END` downstream
since it doesn't try to interpret the skipped DWORDs as tokens. Low real-world impact (CONSTMEM is
rare — it existed mainly for driver/HAL-level shader constant pre-baking) but worth a one-line note:
if a title does emit it, VS constants it expects to be pre-set from the declaration are silently
zero/stale instead.

### Finding 4 — MISSING: D3DVSDE_POSITION2 / D3DVSDE_NORMAL2 (registers v15/v16) unmapped

**Files:** `vsd-constants.ts` (no `D3DVSDE_POSITION2`/`D3DVSDE_NORMAL2` constants) and
`vsd-parser.ts:53-60` (`mapVsdRegister`).

dxvk's table (`d3d8_shader.cpp:38-39`) maps v15→`{POSITION, index 1}` and v16→`{NORMAL, index 1}`
(used for N-Patch / two-position-stream continuous-tessellation content). Our `mapVsdRegister` has no
cases for these; they fall through to `{usage: reg, usageIndex: 0}`, i.e. `usage=15` or `usage=16` —
not a valid D3DDECLUSAGE. Effect differs by path:
- **Programmable VS:** benign in practice — `buildVertexInputs` (`shader/link/index.ts:808-836`)
  binds inputs by the element's raw `.reg` field directly (vs_1_1 has no `dcl`), so v15/v16 still
  reach the shader at the right WGSL `@location`. The wrong `usage` only matters if anything else
  keys off it (nothing currently does for this path).
- **Decl-only FFP:** `decl-to-ffp.ts`'s `usage` switch has no case for 15/16, so it hits the
  `else { faithful = false }` branch — same degraded/unfaithful fallback as any unsupported usage.
  Correct outcome given FFP has no second-position/second-normal concept anyway, just worth noting
  the table gap rather than relying on the accidental correct-by-omission behavior.

**Fix sketch:** add the two constants and the two `mapVsdRegister` cases for completeness/documentation
even though today's consumers happen to tolerate the gap; a future consumer that trusts `usage` for
these registers (e.g. a GetVertexShaderDeclaration round-trip that re-derives register from usage)
would silently break.

### Finding 5 — SILENTLY-WRONG (highest priority): programmable-VS draw paths only distinguish line vs triangle; POINTLIST, TRIANGLESTRIP, TRIANGLEFAN, and LINESTRIP are all mis-rendered

**File:** `d3d8-device-adapter.ts`, four identical occurrences:
`drawPrimitive` (line 1726), `drawPrimitiveUP` (line 1811), `drawIndexedPrimitive` (line 1914),
`drawIndexedPrimitiveUP` (line 2029):

```ts
const topology = primitiveType === 2 || primitiveType === 3 ? "line-list" : "triangle-list";
```

(`2` = D3DPT_LINELIST, `3` = D3DPT_LINESTRIP). This ternary is the *only* topology decision made
before calling `D3D8ProgrammableRenderer.resolveProgrammablePipeline`, whose signature
(`d3d8-programmable-draw.ts:152`) is hard-typed to `"triangle-list" | "line-list"` — there is
structurally no way to express strip/fan/point-list topology on this path at all:

- **D3DPT_POINTLIST (1)** → misrouted to `"triangle-list"`. `vertexCount` is computed correctly as
  `primCount` (not a multiple of 3), and the raw vertex/index data is submitted as-is: WebGPU either
  drops the trailing partial triangle or draws garbage triangles from unrelated point data. There is
  also no point-sprite expansion here (the FFP path has `tryDrawPointSprites`/point-sprite handling;
  this path has none).
- **D3DPT_LINESTRIP (3)** → misrouted to `"line-list"`. Strip-ordered vertex/index data
  (`primCount+1` vertices) is drawn as a list, which reads consecutive pairs as independent segments
  instead of a connected strip — wrong topology, roughly half the intended segments, with the wrong
  endpoints paired after the first.
- **D3DPT_TRIANGLESTRIP (5)** → misrouted to `"triangle-list"` (the default branch). This is the
  single most common primitive type for indexed mesh geometry. Strip-ordered vertex/index data
  (`primCount+2` vertices) submitted as a triangle list groups every 3 consecutive entries into an
  independent triangle instead of sharing edges — roughly 1/3 the intended triangle count, with wrong
  winding on every other triangle.
- **D3DPT_TRIANGLEFAN (6)** → misrouted to `"triangle-list"` (default branch). WebGPU has no native
  fan topology, so real conversion is required (as dxvk relies on the D3D9 runtime to do, and as
  BottleShip's *own* D3D9 device does — see below); none happens here.

**Ground truth / internal precedent:** `src/worker/backends/webgpu/d3d9/d3d9-device.ts` implements
this correctly for the equivalent D3D9 paths — `drawPrimitiveUP` (lines 6566-6627) CPU-expands
TRIANGLEFAN (6585-6596), TRIANGLESTRIP (6597-6611), and LINESTRIP (6612-6619) into explicit
list-ordered scratch buffers before choosing between `"line-list"`/`"triangle-list"`, and routes
POINTLIST through `tryDrawProgrammablePointList`/`tryDrawPointSprites` (line 6566-6576) instead of
falling into the generic path at all. The equivalent D3D8 buffer-bound (non-UP) FFP path
(`ddraw-backend-executor.ts`) also does this correctly (`D3DPT_TRIANGLEFAN` expansion at lines
2369/2446/2921/3109, native `D3DPT_TRIANGLESTRIP` topology handling at 2519/2553). **Only the D3D8
programmable-VS draw path skips this entirely** — it was evidently written against triangle-list/
line-list content only and never extended when programmable-VS titles using strips/fans/points showed
up.

**Symptom:** any D3D8 title using a programmable vertex shader (vs.1.1 bytecode, not decl-only FFP)
that also issues `D3DPT_TRIANGLESTRIP`, `D3DPT_TRIANGLEFAN`, `D3DPT_LINESTRIP`, or `D3DPT_POINTLIST`
draws will render badly-broken or missing geometry on those draws specifically, while triangle-list
draws through the same shader look correct — a confusing partial-corruption signature that reads like
a shader bug rather than a topology bug.

**Fix sketch:** widen `resolveProgrammablePipeline`'s topology parameter to the full
`GPUPrimitiveTopology` union (WebGPU natively supports `"triangle-strip"`/`"line-strip"`/`"point-list"`
— no CPU conversion needed for those two strip cases, unlike D3D9's chosen approach) and add explicit
TRIANGLEFAN CPU-side expansion (mirroring `d3d9-device.ts:6585-6596`) at all four D3D8 call sites,
plus point-sprite/point-list handling equivalent to what the FFP and D3D9-programmable paths already
have. This is a generic-layer fix (§3.0): every D3D8 programmable-VS title benefits, nothing
per-game.

## 3. Not investigated further (out of scope / adjacent)

- Pixel-shader (ps.1.4) side of the programmable path — only the vertex/topology feed into it was in
  scope here.
- `ffp-combiner.ts` FFP shader generation itself (confirmed only that it's the consumer that assumes
  D3DCOLOR packing for the DIFFUSE/SPECULAR slots — not re-audited line by line).
- State-block replay correctness for `SetStreamSource`/`SetIndices` beyond confirming the record/replay
  hooks exist.
