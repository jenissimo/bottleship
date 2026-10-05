# D3D8 Parity Audit — Resources, Formats, Caps

Scope: `src/worker/modules/d3d8/resources.ts`, `shared-state.ts`, `device-lifecycle.ts`,
`caps.ts`, `format-support.ts`, `src/worker/backends/webgpu/shared/{texture-formats,
dx-format-support,dx-format-check-log,mip-utils}.ts`.

Ground truth: `G:/sources/dxvk/src/d3d8/d3d8_device.cpp`, `d3d8_texture.cpp`,
`d3d8_surface.cpp`, `d3d8_util.h`; `G:/sources/wine/dlls/d3d8/`.

Method: IMPLEMENTED / PARTIAL / MISSING / SILENTLY-WRONG per item, our file:line vs the
dxvk/wine reference.

---

## 1. Method verdict table

| Method | Verdict | Notes |
|---|---|---|
| `CreateTexture` | PARTIAL | Levels=0, Usage, Pool, RT-usage split all correct; `D3DFMT_UNKNOWN`/exclusive rejected. No `Width==0`/`Height==0` handling beyond `Math.max(1,…)` clamp (dxvk forwards 0 to D3D9, which also clamps — benign). |
| `CreateVertexBuffer` / `CreateIndexBuffer` | IMPLEMENTED | Length bounds, format/usage/pool stored, `markBufferAllDirty` on create (COM-ptr-reuse safe). |
| `CreateRenderTarget` | IMPLEMENTED | Format/MSAA validated; GPU_ONLY unless `Lockable`. |
| `CreateDepthStencilSurface` | IMPLEMENTED | Format/MSAA validated against the real DS format set. |
| `CreateImageSurface` | **SILENTLY-WRONG** | No `Format==D3DFMT_UNKNOWN` / exclusive-format rejection (dxvk `d3d8_device.cpp:525-534`); pool reported as `D3DPOOL_DEFAULT` instead of `D3DPOOL_SYSTEMMEM`. See §3.1/§3.2. |
| `CreateCubeTexture` / `CreateVolumeTexture` | MISSING (honest) | Return `D3DERR_INVALIDCALL` with null out-param, matched by cleared `CubeTextureFilterCaps`/`VolumeTextureFilterCaps`/`TextureCaps` bits. Correctly NOT a silent lie. |
| `CopyRects` | **SILENTLY-WRONG** | Validates bpp equality, not format equality; doesn't reject `pSrc==pDst`; doesn't reject depth-stencil formats. See §3.3. |
| `UpdateTexture` | **SILENTLY-WRONG** | Only copies mip level 0 (`texSurfaces.get`, the base surface) — levels 1..N are never touched. See §3.4. |
| `GetRenderTarget` / `GetDepthStencilSurface` | IMPLEMENTED | `GetDepthStencilSurface` faithfully returns `D3DERR_NOTFOUND` (not `D3D_OK`) with a null out-param when unbound — this exact class of bug (over-answering vs. the real HRESULT) is called out as a recurring failure mode in project memory, and here it's done right. |
| `GetFrontBuffer` | PARTIAL | Reads back the current render target via `readRenderTargetToBitmapSurface`, not a true desktop-sized front-buffer capture (real D3D8 needs a desktop-resolution dest surface and stretches the composited frame into it). Low priority — few titles call this outside screenshot tools. |
| `SetRenderTarget` | PARTIAL | RT-capability check present; correctly leaves color target unchanged when `pRenderTarget==NULL`. Missing: DS-vs-RT dimension check (dxvk `d3d8_device.cpp:1015-1030`: DS `Width/Height` must be ≥ RT's, else `D3DERR_INVALIDCALL`). Not applicable to the measured UE2 title (512×512/512×512 match) but a generic gap. |
| `LockRect` (`IDirect3DSurface8_LockRect`/`Texture8_LockRect`) | PARTIAL | Render-surface path is flag-aware (DISCARD zero-fill, scoped readback, READONLY tracked). Plain-texture/image-surface path (`lockRectOffsetBits`) ignores `Flags` entirely — no `DISCARD`, and no READONLY tracking, so every `UnlockRect` unconditionally re-decodes + re-uploads (`syncBitmapSurfaceFromGuest` bumps `contentVersion` unconditionally). See §3.5. |
| `VertexBuffer8_Lock` / `IndexBuffer8_Lock` | PARTIAL | Offset/size validated (`validateLockRange`); `Flags` argument is read into a local and **never used** (`resources.ts:663`, `:757`) — `D3DLOCK_READONLY` never suppresses `markBufferDirty`, so a read-only skinning/culling lock forces a redundant GPU re-upload every time. Not a visual bug, a perf-parity one. |
| `GetLevelCount` / `GetLevelDesc` / `GetSurfaceLevel` | IMPLEMENTED | Level bounds checked against `textureMeta.levels`; `AddRef` on `GetSurfaceLevel` correctly forwards to the parent texture (Wine semantics). |
| Mip chain math (`mip-utils.ts`) | IMPLEMENTED | `effectiveMipLevels`/`d3dTextureMipUploadPlan` correctly expose only *authored* contiguous levels rather than inventing black/garbage mips — matches the project's stated "faithful-but-conservative" policy documented in the file itself. |
| `AddRef`/`Release`, `GetContainer`, `GetDevice` | IMPLEMENTED | Texture sub-surfaces correctly proxy refcount to the parent texture (Wine model); `Release` to zero on a bound depth-stencil clears `depthStencilSurfacePtr`/`deviceBoundDepthStencil`, avoiding a dangling bind. |
| `Reset` / DEFAULT-pool resource lifetime | PARTIAL | Implicit back-buffer + auto-depth-stencil are destroyed/recreated correctly. App-created `D3DPOOL_DEFAULT` resources (textures, explicit RTs/DS, VB/IB) are **not** invalidated on `Reset` — real D3D8 requires the app to release them first and they become unusable across Reset. Our backend doesn't distinguish storage by pool, so a title that (incorrectly, per spec) keeps using a stale DEFAULT-pool pointer across Reset will keep working here where it would fail on real hardware — a leniency, not a game-visible break, but a fidelity gap worth flagging as it masks games that *should* be crashing/erroring and would hide our own Reset-related bugs. |

## 2. Format verdict table

Checked against `checkD3D8DeviceFormat` (`dx-format-support.ts`) and `getD3DTextureLayout`
(`texture-formats.ts`).

| D3DFORMAT | CheckDeviceFormat | Decode | Caps report | Verdict |
|---|---|---|---|---|
| X8R8G8B8 / A8R8G8B8 | accepted, RT-capable | correct | `TextureCaps.ALPHA` set | IMPLEMENTED |
| R5G6B5 / X1R5G5B5 / A1R5G5B5 / A4R4G4B4 | accepted, RT-capable | correct | IMPLEMENTED |
| A8 | accepted (bumpmap/texture only, not RT) | correct | IMPLEMENTED |
| P8 | accepted; `normalizePalettizedTexturePool` forces SCRATCH (matches dxvk's Nvidia/Intel `placeP8InScratch` workaround, applied unconditionally here rather than gated) | palette-dependent decode at draw/unlock time via `surface.palette` | IMPLEMENTED |
| L8 / A8L8 | accepted | correct | IMPLEMENTED |
| V8U8 / L6V5U5 / X8L8V8U8 / Q8W8V8U8 / W11V11U10 (D3D8-valid bump formats) | accepted | correct, in `BUMPMAP_FORMATS` | IMPLEMENTED |
| DXT1/2/3/4/5 | accepted; NPOT block-row pitch handled (`blockCompressedRowPitch`/`blocksHigh`) | correct 4×4 block decode, `CopyRects`/`UpdateTexture` special-cased for block copies | IMPLEMENTED |
| D16 / D16_LOCKABLE / D24S8 / D24X8 / D32 / D15S1 / D24X4S4 | accepted via `DEPTH_STENCIL_COMMON` | not sampled (correct — DS surfaces aren't texture-sampled pre-D3D9 `INTZ`) | IMPLEMENTED |
| A2R10G10B10, A8B8G8R8/X8B8G8R8, A16B16G16R16, L16, D32F/D24FS8/D32_LOCKABLE/S8_LOCKABLE, Q16W16V16U16, *16F/*32F, CxV8U8 | correctly refused on D3D8 (`D3D9_ONLY_FORMATS`/`isDxExclusiveFormat(fmt,8)`) | n/a | IMPLEMENTED (honest exclusion) |
| FourCC vendor hints (`ATI1/ATI2`, `NULL`, `RESZ`, `INTZ`) | not checked in this pass | — | not audited (out of the D3D8 2001-2004 title profile the task specifies; D3D8 titles predate `INTZ`/`RESZ` conventions) |

No over-advertised format was found — the D3D8 exclusive-format gating (`isD3D8ExclusiveFormat`)
is symmetric with `D3D9_ONLY_FORMATS`, and depth/bump/compressed sets all match what
`texture-formats.ts` can actually decode. This is the one area of the audit where the "false
capability answer" pattern from project memory does **not** reproduce.

## 3. Findings (priority order)

### 3.1 `CreateImageSurface` accepts `D3DFMT_UNKNOWN` and exclusive formats — SILENTLY-WRONG
**File:** `src/worker/modules/d3d8/resources.ts:1142-1166`
**Reference:** dxvk `d3d8_device.cpp:516-534` — real D3D8 clears `*ppSurface`, then rejects
`Format == D3DFMT_UNKNOWN` and any D3D9-exclusive format with `D3DERR_INVALIDCALL` *before*
creating anything.

Our handler does neither check — it goes straight to `createTextureSurface(Width, Height,
Format)` / `getD3DTextureLayout(Format, Width, Height)` for any `Format` value, including 0. A
title (or its own internal error path) that calls `CreateImageSurface(w,h,D3DFMT_UNKNOWN,&surf)`
expecting failure gets a "successful" 0-bpp surface instead — `d3dFormatToSurfaceFormat`'s
fallback behavior for an unknown format then determines what garbage results downstream
(depends on its default case, not audited here, but not the documented HRESULT contract either
way).

**Fix sketch:** add the same guard `CreateTexture` already has:
```ts
if (Format === D3DFMT_UNKNOWN || isD3D8ExclusiveFormat(Format)) return D3DERR_INVALIDCALL;
```
before `initReturnPtr`/surface creation, mirroring `resources.ts:466-469`.

### 3.2 `CreateImageSurface` surfaces report `D3DPOOL_DEFAULT` instead of `D3DPOOL_SYSTEMMEM` — SILENTLY-WRONG
**File:** `src/worker/modules/d3d8/resources.ts:1142-1174` (creation, no `pool` stored),
`resources.ts:862-884` (`IDirect3DSurface8_GetDesc`, line 883: `meta?.pool ?? D3DPOOL_DEFAULT`).
**Reference:** dxvk `d3d8_device.cpp:536-537` — `CreateImageSurface` always allocates
`D3DPOOL_SYSTEMMEM` (or `D3DPOOL_SCRATCH` for a format the driver can't support as a plain
surface).

`D3D8SurfaceInfo` for an image surface has `texturePtr: 0`, so `GetDesc`'s `meta =
info.texturePtr ? textureMeta.get(...) : null` is always `null`, and the pool defaults to
`D3DPOOL_DEFAULT`. This is exactly the class of bug CLAUDE.md flags as high-damage: pool
semantics gate what an engine believes survives `Reset` and whether a resource is
CPU-lockable-always vs. GPU-managed. An engine that branches on `D3DSURFACE_DESC.Pool` to decide
"do I need to re-populate this after device loss" will get the wrong answer for every
`CreateImageSurface` result (image surfaces are commonly used as scratch decode targets for
video/JPEG/screenshot code, i.e. exactly UE2-era-adjacent titles' asset pipelines).

**Fix sketch:** store `pool: D3DPOOL_SYSTEMMEM` (or SCRATCH, mirroring dxvk's
`IsSupportedSurfaceFormat` split) on the `D3D8SurfaceInfo`/a small side map at creation, and have
`GetDesc` read it instead of falling through to the texture-meta path when there's no owning
texture.

### 3.3 `CopyRects` doesn't enforce format identity, self-copy, or depth-stencil rejection — SILENTLY-WRONG
**File:** `src/worker/modules/d3d8/resources.ts:1177-1213`
**Reference:** dxvk `d3d8_device.cpp:663-687` — rejects `pSourceSurface == pDestinationSurface`,
rejects `srcDesc.Format != dstDesc.Format` (exact format, not just byte width), and rejects
depth-stencil surfaces outright.

Our check at `resources.ts:1212` is:
```ts
if (srcBytesPerPixel !== dstBytesPerPixel) return D3DERR_INVALIDCALL;
```
which accepts any two *same-bpp-but-different-format* pairs — e.g. `R5G6B5`→`X1R5G5B5` (both
16bpp) or `X8R8G8B8`→`A8R8G8B8` (both 32bpp, differ only in whether the top byte is meaningful
alpha) — and does a raw byte copy. For the 32bpp X8↔A8 case this happens to be harmless (same
bit layout), but for 16bpp RGB/ARGB pairs it reinterprets bits and produces wrong colors/alpha
with no error reported. There's also no `pSrc == pDst` guard, and no rejection of depth-stencil
formats (a `CopyRects` between two `D3DFMT_D24S8` surfaces would proceed as a raw block copy
instead of being refused).

**Fix sketch:**
```ts
if (pSrc === pDst) return D3DERR_INVALIDCALL;
if (srcInfo.d3dFormat !== dstInfo.d3dFormat) return D3DERR_INVALIDCALL;
if (isD3D8DepthStencilFormat(srcInfo.d3dFormat)) return D3DERR_INVALIDCALL;
```
(the existing bpp-equality check can then be dropped — format equality subsumes it — and the
DXT/BC block-copy path stays as-is, since it already requires equal `blockBytes`).

### 3.4 `UpdateTexture` copies only mip level 0 — SILENTLY-WRONG
**File:** `src/worker/modules/d3d8/resources.ts:1326-1329` (`srcDevice?.texSurfaces.get(pSrcTexture)`
resolves only the base-level surface) through `:1401`.
**Reference:** dxvk `d3d8_device.cpp:969-980` forwards straight to D3D9 `UpdateTexture`, whose
documented contract updates **every** mip level (the driver walks `GetLevelCount()` levels,
matching dimensions by the declared 2:1 ratio) — this is the standard SYSTEMMEM→DEFAULT texture
streaming path for engines that build a full mip chain in system memory once and push it to VRAM
with one call.

Our handler resolves `srcSurface`/`dstSurface` via `device.texSurfaces.get(pTexture)`, which is
always the **level-0** `DirectDrawSurfaceState` (see `ensureTextureLevelSurface`,
`resources.ts:397-402`: level 0 *is* `parent`, higher levels are separate CPU-side surfaces
tracked only in `textureLevelSurfaces`). The loop at `:1401` copies exactly one level's worth of
bytes; levels 1..N-1 of the destination texture are never written by `UpdateTexture`, no matter
how many mip levels the source texture has authored. Any title using the canonical
SYSTEMMEM-mipchain-then-`UpdateTexture` pattern gets mip level 0 correct and every coarser mip
whatever was last uploaded via `LockRect`/`CreateTexture`'s initial (probably zeroed) allocation
— a classic "looks right up close, degrades/flickers at a distance" bug that a screenshot-based
regression check would miss.

**Fix sketch:** iterate `level` from 0 to `min(srcMeta.levels, dstMeta.levels) - 1`, resolving
each level's surface via `ensureTextureLevelSurface` (already used elsewhere in this file) before
running the existing per-level byte-copy loop, same compressed/uncompressed split as today.

### 3.5 Plain-texture `LockRect`/`UnlockRect` ignores `Flags` — PARTIAL (perf-parity, not visual)
**File:** `src/worker/modules/d3d8/resources.ts:889-901` (`LockRect`, `Flags` read but unused for
the bitmap-texture branch), `:906-935` (`UnlockRect`, unconditional `syncBitmapSurfaceFromGuest`
for any bitmap texture regardless of how it was locked).
**Contrast:** the render-surface path (`lockRenderSurfaceRect`, `decideD3D8LockSync`/
`noteD3D8Lock`) *does* track `lastLockReadOnly` and skips marking CPU authority on a read-only
unlock (`resources.ts:930-937`) — the same discipline simply isn't applied to plain textures and
image surfaces.

Every `LockRect`+`UnlockRect` on a non-render-target texture — including a pure
`D3DLOCK_READONLY` lock used by CPU-side code that only *reads* pixel/palette data (common for
video-frame textures, screenshot post-processing, or engine asset introspection) — unconditionally
bumps `surface.contentVersion` and sets `gpuNeedsUpload = true`, forcing a full re-decode +
re-upload on the next draw even though nothing changed. Not incorrect rendering, but it's exactly
the kind of "faithful but not performant" gap CLAUDE.md's Prime Directive calls out (§3.0:
performance is part of faithfulness) — a title that locks a large streaming texture read-only
every frame pays a full re-upload every frame for no reason.

**Fix sketch:** thread `Flags` into `lockRectOffsetBits`/`syncBitmapSurfaceFromGuest` the same
way render surfaces already do — track a `lastLockReadOnly` bit on `BitmapTextureSurface` and
skip `contentVersion++`/`gpuNeedsUpload` when the outstanding lock was `D3DLOCK_READONLY`.

### 3.6 `VertexBuffer8_Lock`/`IndexBuffer8_Lock` never consult `Flags` — PARTIAL (perf-parity)
**File:** `resources.ts:663` (`// const Flags = args[4];`, VB) and `:757` (`const Flags =
args[4];`, IB — read but never referenced again).
**Reference:** real D3D8/DXVK forward `D3DLOCK_READONLY`/`NOOVERWRITE`/`DISCARD` to the D3D9
buffer lock, and a `READONLY` lock does not dirty the resource.

`device.markBufferDirty("vb"/"ib", …)` runs unconditionally on every `Lock`, so a
read-only vertex/index lock (e.g. CPU skinning output readback, or a physics query over static
geometry) forces the same GPU re-upload as a write lock would. Same class of gap as §3.5, same
fix shape: gate `markBufferDirty` on `(Flags & D3DLOCK_READONLY) === 0`.

### 3.7 `SetRenderTarget` doesn't check DS/RT dimension compatibility — PARTIAL
**File:** `src/worker/modules/d3d8/state.ts:762-798`.
**Reference:** dxvk `d3d8_device.cpp:1012-1031` — rejects `SetRenderTarget` with
`D3DERR_INVALIDCALL` when the depth-stencil surface's `Width`/`Height` are smaller than the
render target's.

No dimension check exists here at all; any DS/RT size pair is accepted silently. Benign for the
measured UE2 title (its 512×512 RT is always paired with a matching 512×512 DS), but a generic
gap — a title that (incorrectly) reuses a smaller cached DS against a larger RT would get
whatever the WebGPU attachment validation does instead of the documented D3D error, which is a
different failure mode than real hardware (possibly a WebGPU validation error instead of a
graceful `D3DERR_INVALIDCALL` the app already has a fallback for).

### 3.8 Caps — no over-advertisement found
`GetDeviceCaps` (`caps.ts`) was checked field-by-field against dxvk's D3D8 caps clamping
(`d3d8_util.h`) and the FFP combiner's actual op coverage (`ffp-combiner.ts`,
`FFP_IMPLEMENTED_OPS`). Every non-zero bit in `TextureOpCaps`/`ShadeCaps`/`TextureCaps` traces to
a real code path (documented inline in `caps.ts`), and `CubeTextureFilterCaps`/
`VolumeTextureFilterCaps`/`VolumeTextureAddressCaps`/`MaxVolumeExtent` are correctly zeroed to
match `CreateCubeTexture`/`CreateVolumeTexture` unconditionally failing. This is the one caps
audit in the project that did **not** reproduce the "false capability answer" pattern —
worth noting as a positive control, not just an absence of findings.

## 4. Summary of severity

- **SILENTLY-WRONG (fix first):** §3.1 `CreateImageSurface` format validation, §3.2
  `CreateImageSurface` pool misreport, §3.3 `CopyRects` format/self/depth-stencil validation,
  §3.4 `UpdateTexture` mip levels 1..N never copied.
- **PARTIAL / perf-parity:** §3.5 texture `LockRect` flag-blindness, §3.6 VB/IB `Lock`
  flag-blindness, §3.7 `SetRenderTarget` DS/RT dimension check, Reset not invalidating
  DEFAULT-pool resources, `GetFrontBuffer` reading the RT instead of a true front-buffer capture.
- **No findings:** format acceptance/decode/caps coverage for the full 2001-2004 title format
  set; `GetDepthStencilSurface`'s `D3DERR_NOTFOUND` contract; mip-chain math; resource
  AddRef/Release/GetContainer lifetime; `GetDeviceCaps` field-by-field honesty.
