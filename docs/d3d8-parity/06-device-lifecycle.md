# D3D8 Parity Audit — Device & Frame Lifecycle

Scope: device creation/Reset, viewport, render targets, scenes, presentation, state blocks,
cooperative level. Ground truth: `G:/sources/wine/dlls/d3d8/device.c` (+ `dlls/wined3d/device.c`
for the underlying semantics) and `G:/sources/dxvk/src/d3d8/d3d8_state_block.{h,cpp}`.

Files audited:
- `src/worker/modules/d3d8/state.ts`, `device.ts`, `device-lifecycle.ts`, `resources.ts`,
  `fast-path.ts`, `shared-state.ts`, `factory.ts`, `caps.ts`
- `src/worker/backends/webgpu/d3d8/d3d8-device-adapter.ts`, `d3d8-state-block.ts`
- `src/worker/core/gpu/gpu-device-loss-contract.ts`

## 1. Verdict table

| Area | Verdict | Note |
|---|---|---|
| SetViewport bounds check | **SILENTLY-WRONG** | Always clamps + returns `D3D_OK`; real D3D8 returns `D3DERR_INVALIDCALL` when the viewport doesn't fit the current RT |
| GetViewport | IMPLEMENTED | matches |
| SetRenderTarget: color+DS together, NULL semantics | IMPLEMENTED | correct NULL-RT-leaves-color-unchanged, NULL-DS-detaches |
| SetRenderTarget: viewport reset on RT change | IMPLEMENTED | `setRenderTargetOverride` resets viewport to full new target; matches Wine's `if (render_target) device_reset_viewport_state()` (not reset when only DS changes — matches) |
| SetRenderTarget: cross-device / DS-smaller-than-RT / multisample-match validation | MISSING | no checks at all; Wine returns `D3DERR_INVALIDCALL` for both |
| BeginScene/EndScene pairing | MISSING | no `inScene` flag anywhere; double-Begin and End-without-Begin both silently succeed instead of `D3DERR_INVALIDCALL` |
| Reset: back-buffer/DS recreation, default state restore | IMPLEMENTED | `device.reset()` + `bindAutoDepthStencil` |
| Reset: discard in-flight BeginStateBlock recording | MISSING | `wined3d_stateblock_reset` clears `device->recording`; ours leaves `stateBlockRecorder` state untouched across Reset |
| Reset: D3DERR_DEVICELOST / D3DERR_DEVICENOTRESET / TestCooperativeLevel state machine | IMPLEMENTED | `gpu-device-loss-contract.ts` is a clean generation-counter model |
| Cooperative-level enforcement on OTHER calls (BeginScene/Draw*/Present while lost) | MISSING | only `TestCooperativeLevel` and `Reset` consult `deviceCooperativeLevel`; every other call proceeds regardless |
| Present: source/dest rect, dest-window override, dirty region | MISSING | `IDirect3DDevice8_Present` thunk drops args 1–4 entirely, always full-target/full-window present |
| CreateStateBlock(D3DSBT_PIXELSTATE) render-state membership | **SILENTLY-WRONG** | captures ALL 256 render states + all TSS + all textures + PS constants (should be a specific pixel-only subset; also over-captures vertex-only state) |
| CreateStateBlock(D3DSBT_VERTEXSTATE) render-state membership | **SILENTLY-WRONG** | captures **zero** render states and **zero** texture-stage state (incl. `D3DTSS_TEXCOORDINDEX`/`TEXTURETRANSFORMFLAGS`, which real D3D8 puts in the vertex group) |
| State block capture of "unset"/NULL members (textures, streams) | SILENTLY-WRONG | only non-null textures/streams get an entry, so an Apply cannot restore a stage back to NULL if it was NULL at Capture time |
| BeginStateBlock/EndStateBlock error codes | IMPLEMENTED | correct `D3DERR_INBEGINSTATEBLOCK`/`D3DERR_NOTINBEGINSTATEBLOCK` |
| ApplyStateBlock/CaptureStateBlock/DeleteStateBlock | IMPLEMENTED | token-keyed, matches contract |
| SetClipPlane/GetClipPlane | PARTIAL | stored faithfully, not evaluated by the FFP rasterizer (documented, shared with D3D9) |
| SetMaterial/SetLight/LightEnable | IMPLEMENTED | struct layouts match D3DMATERIAL8/D3DLIGHT8; `GetLight` on unset index correctly fails instead of returning stack garbage |
| SetTransform for D3DTS_* incl. WORLD1..3 / TEXTURE0..7 | PARTIAL | storage is a generic `Map<number,Float32Array>` (any type works), but the FFP draw path only *applies* `D3DTS_TEXTURE0..2` (`texMatricesScratch` is sized 3) even though caps advertise `MaxTextureBlendStages=8`; stages 3–7 texture matrices are silently ignored |
| ValidateDevice | STUB | always reports pass, no caps cross-check (acceptable stub, matches typical d3d9 stub pattern) |
| ShowCursor/SetCursorProperties | IMPLEMENTED | validates format/power-of-two/display-mode bound, matches wined3d |
| Multithreading flags (D3DCREATE_MULTITHREADED) | N/A | recorded in creation params, not otherwise meaningful under our single-worker-thread model |
| GetInfo | SILENTLY-WRONG (minor) | always `E_NOTIMPL`; real D3D8 returns `E_FAIL` for `info_id<4` and `S_FALSE` (a *success* code) otherwise — a `SUCCEEDED()` caller sees a different answer |

## 2. Prioritised findings

### F1 — SetViewport never returns D3DERR_INVALIDCALL (SILENTLY-WRONG, high priority)

`src/worker/modules/d3d8/state.ts:363-386` (`IDirect3DDevice8_SetViewport`) always calls
`sanitizeViewport(...)` (`src/worker/backends/webgpu/ddraw/types.ts:250-321`) and returns
`D3D_OK`. `sanitizeViewportInto` clamps out-of-range viewports back onto the render target
instead of rejecting them (lines 294-307: `implausible` only fires for truly degenerate input —
zero/negative/huge — not for "fits inside the RT" per se, and even then it falls back to the
full-RT viewport rather than failing the call).

Ground truth — `G:/sources/wine/dlls/d3d8/device.c:1782-1807`:
```c
if (viewport->X > rt_desc.width || viewport->Width > rt_desc.width - viewport->X
        || viewport->Y > rt_desc.height || viewport->Height > rt_desc.height - viewport->Y)
    return D3DERR_INVALIDCALL;
```
This is D3D8-specific (D3D9's DXVK wrapper in `d3d9_device.cpp:2092-2117` does NOT validate
bounds at all — it just stores the viewport, because the underlying Vulkan viewport isn't tied
to render-target extents the same way). D3D8 (wined3d-backed) DOES validate.

Symptom: any title whose viewport computation legitimately races ahead of (or falls behind) the
active render target's size gets silently "fixed" by us instead of the `D3DERR_INVALIDCALL` the
app's own bookkeeping expects — which hides real application-level RT/viewport desync bugs
instead of surfacing them the way real hardware would.

Fix sketch: add a real bounds check in the `SetViewport` handler (or a variant of
`sanitizeViewport` that returns `null`/a validity flag) before falling back to the always-clamp
path used by internal callers (`BeginScene`, `Reset`, `SetRenderTargetOverride`) — those internal
call sites still want clamping (they are not modeling the guest's own `SetViewport` call), so the
new validation should live specifically in the `IDirect3DDevice8_SetViewport` thunk, not in
`sanitizeViewport` itself.

### F2 — D3DSBT_PIXELSTATE/VERTEXSTATE capture membership is not modeled at all (SILENTLY-WRONG, high priority)

`src/worker/backends/webgpu/d3d8/d3d8-state-block.ts:196-247` (`captureD3D8StateToEntries`)
gates render states and texture-stage-states on a single `includePixel` boolean covering the
*entire* 0..255 render-state range and the *entire* TSS grid — there is no per-state membership
table. Two concrete consequences:

- `CreateStateBlock(D3DSBT_VERTEXSTATE)` captures **zero** render states and **zero**
  texture-stage states (the loops populating them are entirely inside `if (includePixel)`).
  Real D3D8 (per DirectX8 docs / dxvk `d3d8_state_block.cpp:24-30`) puts vertex-related
  render states (LIGHTING, CLIPPING, FOGVERTEXMODE, COLORVERTEX, material-source states,
  point-scale states, `SOFTWAREVERTEXPROCESSING`, …) and `D3DTSS_TEXCOORDINDEX` /
  `D3DTSS_TEXTURETRANSFORMFLAGS` per stage into the VERTEXSTATE group. A game that
  `BeginStateBlock`/`CreateStateBlock(VERTEXSTATE)`s to snapshot lighting/clip state around a
  UI overlay or special-effect pass gets an `Apply` that restores **nothing** of that.
- `CreateStateBlock(D3DSBT_PIXELSTATE)` conversely captures *every* render state including the
  vertex-only ones, so `ApplyStateBlock` on a pixel-state block can clobber lighting/clipping
  toggles the caller never intended to touch — a real over-broad-restore bug, not just an
  under-capture.

Fix sketch: build the two membership sets from the documented D3DSTATEBLOCKTYPE tables (Wine's
`dlls/wined3d/stateblock.c` `SavedPixelStates_R`/`SavedVertexStates_R`/
`SavedPixelStates_T`/`SavedVertexStates_T` arrays are the authoritative list, ported through
D3D9→D3D8's identical render-state numbering) and gate each render-state/TSS-type index against
the right set instead of the current single `includePixel`/`includeVertex` boolean over the
whole range.

### F3 — State-block capture skips NULL/unset members (SILENTLY-WRONG, medium priority)

Same file: `captureD3D8StateToEntries` only pushes a `texture` entry when
`texPtr !== 0` (line 212-213) and only pushes a `streamSource` entry when `src.vb !== 0`
(line 238). Per dxvk's `D3D8StateBlock::Capture`, `D3DSBT_ALL` captures *all* 8 texture stages
and *all* `MAX_STREAMS` streams unconditionally (`m_captures.streams.setAll()` /
`m_captures.textures.setAll()`), including stages that are currently unbound. If a game sets
texture stage 0, `BeginStateBlock`s at that point while stage 1 is NULL, later binds a texture to
stage 1, then `ApplyStateBlock`s — real D3D8 restores stage 1 back to NULL; ours leaves whatever
is currently bound because no entry was ever recorded for it.

Fix sketch: for `D3DSBT_ALL`/`CreateStateBlock`, always push all 8 texture-stage entries and all
16 stream-source entries (NULL/zero included) rather than filtering on truthiness. The
`BeginStateBlock`/journal path (`recordStateBlock`) is a different, correct model (it only
journals what the app actually called `Set*` for, matching real behavior for the *recording*
form) — this fix is specific to `CreateStateBlock`'s eager-capture form.

### F4 — SetRenderTarget skips two real-D3D8 validations (MISSING, medium priority)

`src/worker/modules/d3d8/state.ts:762-800`. Wine's `d3d8_device_SetRenderTarget`
(`G:/sources/wine/dlls/d3d8/device.c:1531-1609`) additionally:
- rejects a render target that belongs to a *different* device (`D3DERR_INVALIDCALL`) — low
  priority for us (single-device-per-process titles are the norm), and
- when a non-NULL depth-stencil is supplied, rejects it if it is smaller than the (new or, if
  RT is NULL, current) render target, or if its multisample settings don't match the render
  target's — both `D3DERR_INVALIDCALL`.

Our handler does neither; an app that (incorrectly) pairs a too-small or mismatched-MSAA DS
surface with a render target gets silent acceptance instead of the error it would use to detect
its own bug.

### F5 — BeginScene/EndScene pairing unenforced (MISSING, low-medium priority)

Neither `src/worker/modules/d3d8/device.ts:56-71` nor `D3D8DeviceAdapter` track an `inScene`
flag. Real wined3d (`G:/sources/wine/dlls/wined3d/device.c:3718-3743`) returns
`D3DERR_INVALIDCALL` for a second `BeginScene` without an intervening `EndScene`, and for
`EndScene` without an open scene. We always return `D3D_OK`. Low real-world impact (most titles
pair these correctly), but it means a title that *does* rely on the error to detect its own
double-BeginScene bug (some engines have exactly this kind of defensive assert, mirroring the
`SetViewport` case in §3) will not see it fail the way it does on real hardware.

Fix sketch: add `private inScene = false` to `D3D8DeviceAdapter`; `BeginScene`/`EndScene`
handlers check/flip it and return `D3DERR_INVALIDCALL` on the wrong-state case, matching Wine
exactly.

### F6 — Present ignores pSourceRect/pDestRect/hDestWindowOverride/pDirtyRegion (MISSING, low priority)

`src/worker/modules/d3d8/device.ts:94-98` reads only `args[0]` (the device pointer) and calls
`device.present()` with no parameters. The vast majority of D3D8 titles pass all four as NULL
(full-target present to the device window), which this happens to satisfy, but any title that
uses `hDestWindowOverride` (present into a different HWND — used by some multi-viewport
editors/tools) or a partial-rect present gets silently coerced to a full present into the
original device window instead.

### F7 — Reset does not discard an in-flight BeginStateBlock recording (MISSING, low priority)

`device.reset()` (`d3d8-device-adapter.ts:861-891`) never touches `stateBlockRecorder` or
`stateBlocks`. Wine's `d3d8_device_Reset` explicitly drops the pending recording stateblock
(`device->recording = NULL`, `dlls/d3d8/device.c:970-974`) as part of Reset. A title that leaves
a `BeginStateBlock` open across a Reset (device-lost/resize path) keeps journaling into a stale
recorder instead of having it discarded.

### F8 — GetInfo returns the wrong HRESULT family (SILENTLY-WRONG, cosmetic)

`src/worker/modules/d3d8/state.ts:877`: `() => 0x80004001 /* E_NOTIMPL */`. Wine
(`G:/sources/wine/dlls/d3d8/device.c:2444-2451`): `E_FAIL` for `info_id < 4`, `S_FALSE`
(a *success* code, `SUCCEEDED()==true`) otherwise. A caller that branches on `SUCCEEDED()`
disagrees with us for every `info_id >= 4`. `GetInfo` is undocumented/rarely called by real
titles, so this is cosmetic, but trivial to fix to the same two constants.

## 3. The SetViewport assert — ranked hypotheses

The reported crash: `Direct3DDevice8->SetViewport(&ViewportInfo) == D3D_OK` asserts inside
`UD3DRenderDevice::Lock <- UViewport::Lock <- UWindowsViewport::Lock <- UGameEngine::Draw <-
UWindowsViewport::Repaint` (Unreal Engine 2, `D3DRenderDevice.cpp:1215`).

Given F1 above, our `SetViewport` **never** returns non-`D3D_OK` for a viewport/RT-size mismatch
— it always sanitizes and succeeds. So the classic "viewport doesn't fit the render target"
failure mode that this exact assert exists to catch on *real* D3D8 (per Wine's bounds check) is
**not reachable through the code path the assert is guarding** in our current implementation.
That means the assert we actually hit must be failing through one of the only two other paths
that can make our `SetViewport` handler return non-zero:

1. **`devices.get(args[0])` misses (`D3DERR_INVALIDCALL`) — highest-ranked.**
   `src/worker/modules/d3d8/state.ts:364-365`. `Repaint` is a re-entrant call: `UGameEngine::Draw`
   here is being invoked *from inside a WM_PAINT/window-message dispatch* (real UE2 issues
   `Repaint` off `UWindowsViewport`'s WNDPROC handling), i.e. JS is calling back into the guest
   CPU (CLAUDE.md §3.2's "WNDPROC re-entry" case) rather than this being a normal
   frame-loop-driven `SetViewport`. If that re-entrant call happens while another D3D8 thunk for
   the *same* device is still mid-flight (an async thunk parked, or the stdcall arg-count/ABI
   class of bug the repo's recent history shows being actively hunted — see
   `e13816f fix(thunking): a stdcall decoration is the argument list, not a spelling` and
   `f678bfc feat(harness): abiAudit`), `args[0]` for this specific re-entrant `SetViewport` call
   can be misread, so it fails to match a live `devicePtr` in the `devices` map even though the
   device is otherwise fine. This is the path most consistent with (a) the very specific
   re-entrant call chain reported, and (b) the fact that this exact class of thunking/ABI bug is
   what the repo's own recent commit history was actively fixing.

2. **`isValidAddress(mem, pVP, 24)` spuriously fails — second-ranked.**
   `state.ts:368`. `ViewportInfo` is a stack local inside `UD3DRenderDevice::Lock`. A `Repaint`
   nested inside `UGameEngine::Draw` inside the normal frame loop means the guest ESP is deeper
   than usual (window-message-pump-inside-frame-loop reentrancy), so the stack address computed
   for `ViewportInfo` is legitimately further from the stack base than a top-level call would
   produce. If the guest thread's registered stack REGION (AddressSpace) is sized tightly, or if
   a stack-guard/committed-page boundary interacts badly with the deeper-than-usual frame, the
   region-map validation could reject an address that is nonetheless a real, in-bounds stack
   slot. Ranked below (1) because nothing in the described call chain points at a *stack depth*
   problem specifically, and address-guard failures tend to be loud (`Logger.warn` on every
   rejection) rather than a plausible silent one-off.

3. **A genuine viewport/RT-size mismatch, coincidentally masked by F1 — ruled out as the direct
   cause, but likely the UPSTREAM condition that triggers the re-entrant Repaint in the first
   place.** UE2 recomputes `ViewportInfo` from the *window's current client rect* on every
   `Repaint`; if `Repaint` fires (e.g. during a resize drag, or a modal dialog's message pump)
   between the window's client rect changing and the device's `Reset`/back-buffer catching up,
   the `ViewportInfo` UE2 computes legitimately does not fit `device.activeRenderTarget` yet.
   On real hardware this is exactly the scenario Wine's bounds check exists for, and UE2's assert
   would (in principle) also fire on real Windows in the same race — except real Windows'
   `SetViewport` failing there is the SIGNAL UE2's higher-level code is supposed to use to skip
   the frame, and the assert is a last-ditch sanity check that real games apparently do trip
   over in this exact race (this is a known-fragile spot in UE2's `D3DRenderDevice.cpp`). Fixing
   F1 to match real bounds-checking behavior would NOT insulate us from this race — if anything
   it makes our behavior match native more closely, including native's own fragility here. If
   after fixing F1 this specific title starts hitting the assert via the *bounds* path instead
   of the *lookup* path, that would confirm hypothesis 3 as the real upstream trigger and point
   at a `Reset`/resize-ordering race (guest client-rect notification arriving before our
   render-target resize completes) as the generic bug to fix — not a `SetViewport` bug per se.

**Recommended next step (diagnostic, not a fix):** instrument the `devices.get(args[0])` miss
and `isValidAddress` failure branches in `IDirect3DDevice8_SetViewport` with a one-time
`Logger.warn` including `args[0]` and the live device-pointer set, then reproduce the Repaint
path under the harness (`breakOnApi('d3d8:IDirect3DDevice8_SetViewport')` with `re` to confirm
which branch actually fires) before changing any thunking code — the ranking above is inference
from the code paths, not a confirmed root cause.
