# Mobile / Tablet Support — Final Buildable Plan

**Spine: Design 3 (VID/TCL)**, with its three fatals fixed and Design 2's player-facing kit + Design 1's shell/immersive/typematic work grafted on. Every worker-side generic fix lands as its own commit *before* any touch code.

---

# Architecture

## The spine

One **`VirtualInputDevice`** on the main thread owns every payload slot of the input SAB. Every producer — hardware mouse, hardware keyboard, hardware gamepad, touch gestures, on-screen widgets, replay — is a tagged *source* that calls exactly one seam:

```ts
device.applyBinding(binding, active, source)   // + setPointerAbsolute / addPointerRelative / addWheel
device.commit()                                 // ONE seqlock bracket + ONE input_tick
```

Levels are **OR-composed across sources**. That single change dissolves four independent recon defects at once: `syncKeyBitfield`'s full 8-word overwrite from the module-global `pressedKeys` Set (`App.tsx:174-183`) can no longer erase a virtual key; the gamepad rAF loop (`App.tsx:2108-2149`) can no longer stomp slots 6..11 back to the hardware view; `event.buttons` (always `1` for touch) can no longer clobber a contact-derived mask; and `pointercancel` becomes structurally safe (`releaseSource("touch")` recomputes the mask — nothing to forget).

Touch is a **host input device**, never a guest feature. No WM_TOUCH, no per-contact SAB slots, no second buffer. A pure, DOM-free recognizer (`step(state, ev, now)` / `tick(state, now) → TouchIntent[]`, time injected) turns contacts into the three primitives the guest already speaks: absolute position, relative delta, button mask. On-screen widgets are pure `Binding` data resolved through the same `applyBinding` seam, so remapping is a `Record<widgetId, Binding>` merge with zero new machinery.

## How touch mode selection reuses the existing relative-mouse intent

`updatePointerLockIntent()` (`App.tsx:511-528`) already computes the faithful signal:

```
wants = !cursorVisibleRef || cursorClippedRef || mouseCapturedRef || cursorWarpingRef
```

fed exclusively by four worker messages (`cursor_visibility`, `clip_cursor`, `mouse_capture`, `cursor_warp`, `App.tsx:1146-1194`), produced by `ShowCursor`/`SetCursor` visibility accounting, `ClipCursor(non-NULL)`, DirectInput exclusive-mouse `Acquire`, and the `SetCursorPos` warp-burst detector (`user32/shared-state.ts:436-468`). That boolean does not mean "the browser should Pointer Lock" — it means **"the guest wants relative mouse"**. Today the two are conflated in the name and in the body.

We rename it to what it is (`relativeIntent`, a tiny store with `subscribe()`) and give it a **second consumer** rather than a second signal:

| pointer source | transport for relative intent |
|---|---|
| `pointerType === "mouse"` | Pointer Lock (today's code, verbatim) |
| everything else (`touch`, `pen`, future) | finger-delta trackpad/look |

The gate is an **allow-list**, not a deny-list — Apple Pencil reports `pointerType: "pen"` on iPadOS with no Pointer Lock and no meaningful `movementX/Y`, so a `!== "touch"` check would leave it in the rejection storm.

Effective touch mode = `uiSettings.touchMode`:
- `"auto"` (default) → `relativeIntent ? trackpad : direct`, latched at gesture start so a mid-drag `ShowCursor(FALSE)` cannot change the meaning of the finger already on glass.
- `"direct"` / `"trackpad"` / `"off"` → explicit override.

There is **no** second detector, no `isTouchMode` message, no per-bundle `relativeMouse` flag. §3.6's no-duplicate-switch-primitive rule, applied to input.

## The one primitive that makes mouse-look work on a phone

`device.addPointerRelative(dx, dy)` does **both** halves of what the pointer-lock branch does today (`App.tsx:1358-1374`): it advances the clamped virtual cursor in guest space (→ `mouseX`/`mouseY`) **and** `Atomics.add`s the **raw** delta into `dinputDX`/`dinputDY`. `getDInputAccum` (`input-manager.ts:1000-1011`) needs zero changes — it just starts seeing non-zero numbers from a finger. One primitive serves a finger drag, a virtual look-stick, and a pointer-locked mouse identically.

## Where the touch listeners live (the corrected mount)

`.app__panel` (`App.tsx:2604`, `ref={panelRef}`, `position: relative` per `App.module.css:13-21`) is the **common ancestor** of `<canvas>` and every overlay. The touch driver binds `pointerdown/move/up/cancel` **on `panelRef`**, not on a `pointer-events: none` sibling layer root (which is not a hit-test target and therefore never sees a contact on bare canvas), and hit-tests contacts against a precomputed flat `Float32Array` of widget rects to route them to a widget or to the touch→mouse translator. iOS Safari's implicit touch-pointer capture to the `pointerdown` target is harmless here: the panel is an ancestor of both, so events bubble to it either way.

The five canvas handlers gain one line each: `if (event.pointerType !== "mouse") return;`

---

# Phases

## P0 — Shared SAB layout + close the key-bitfield tear

**Goal.** One definition of the wire format; the seqlock actually covers the record it claims to.

**User-visible after this.** Nothing. This is the structural prerequisite that makes every later slot addition impossible to desync.

**Changes.**

- **`src/input/sab-layout.ts` — NEW.** Plain TS leaf, no DOM, no worker deps (importable from `bun test`). Exports `INPUT_BUFFER_SIZE`, `INPUT_INDEX`, `KEY_BITFIELD_BASE`/`KEY_BITFIELD_COUNT`, `beginInputWrite`/`endInputWrite`. Moved verbatim from `App.tsx:79-103` + `App.tsx:196-201`. New worker→host slots declared here now, populated in P6:
  ```
  25..32  guestPolledKeys[8]   // VKs the guest observed as PRESSED
  33      guestInputSeq        // bumped on any guest input-API read
  34      guestInputFlags      // bit0 DI keyboard polled, bit1 bulk GetKeyboardState, bit2 wheel consumed
  ```
  Slot 24 `guestGamepadSeq` unchanged. Buffer stays 1024 B / 256 slots — no reallocation, no protocol bump.
- **`src/app/App.tsx`** — delete the local `INPUT_INDEX`/`KEY_BITFIELD_*` block (`:79-103`) and the seqlock helpers (`:196-201`); import from `src/input/sab-layout`.
- **`src/worker/runtime/input/input-manager.ts`** — delete the hand-copied mirror (`:56-85`, the `"must match App.tsx"` comment) and the private writer helpers (`:1102-1111`); import the same module. **Same commit** — the duplication must not survive the change.
- **`src/worker/runtime/input/input-manager.ts:395-407`** — copy the 8 key-bitfield words into a scratch `Int32Array(8)` **inside** the snapshot region, before the `Atomics.load(seq) !== seq` re-check at `:406`. Pass 1 (`:453-491`) and pass 2 (`:694-742`) diff from the scratch copy, not from `this.inputView[KEY_BITFIELD_BASE + word]`. Today both read the SAB *after* `lastSeq` is committed at `:407`, so a bracket that sets `VK_CONTROL` (word 0) and a letter (word 2) can be observed half-applied — a real desktop chord-tearing bug.

**Acceptance.**
```bash
bun tools/generate-index.ts && bun run typecheck
bun tools/harness.ts up
bun tools/harness.ts chain "openWgb('/apps/…/game.wgb').waitForEvent('dialogShow').key('VK_RETURN').tickFrames(60).state(['input'])"
```
Plus a new `tools/tests/sab-layout.test.ts`: `INPUT_INDEX` is frozen, all slot ids are distinct and < 256, `KEY_BITFIELD_BASE + KEY_BITFIELD_COUNT <= 24`.

---

## P1 — Generic worker faithfulness fixes (no touch code)

**Goal.** Fix the three HLE defects touch merely *exposes*. Each is a desktop win and each lands as its own commit, bisectable.

**User-visible after this.** A fast mouse click lands on the thing under the cursor instead of the previously hovered item. A held key repeats in name-entry / list UIs. Two wheel notches between polls no longer collapse into one. An on-screen "Shift" (once P5 exists) produces a valid scan code.

**Changes, in commit order.**

1. **Move ordering — `input-manager.ts:596-624`.** Delete the `!buttonChanged` gate at `:605`. When a snapshot carries both a position change and a button edge, emit `WM_SETCURSOR` + `WM_MOUSEMOVE` **first**, then the button messages. Windows always delivers move-then-down; the current heuristic drops the move **and** advances `lastMouseX/lastMouseY` unconditionally at `:622-623`, so the position is lost forever. Blast radius on desktop is small: a real mouse fires `pointermove` and `pointerdown` as separate DOM events → separate brackets → separate polls, and `injectClickAtScreen` (`:1113-1131`) already issues move/down/up as three separate seq bumps + `poll(true)`.
2. **Wheel accumulate — `App.tsx:1635-1649`.** `inputView[mouseWheel] = round(delta)` becomes `Atomics.add(inputView, INPUT_INDEX.mouseWheel, round(delta))`. The worker already consumes destructively with `Atomics.exchange` at `:415`; a plain overwrite loses every notch but the last between two polls.
3. **Typematic repeat — `input-manager.ts:694-742`.** Windows generates repeat in the input stack, not the device. Add a per-VK `repeatAt` map to `poll()`: the most recently pressed non-modifier, non-toggle key, still down, re-posts `WM_KEYDOWN` after 500 ms (`SPI_GETKEYBOARDDELAY` default) at ~33 ms cadence, with **lParam bit 30 set and no intervening `WM_KEYUP`**, gated on `getKeyboardTargetWindow()` returning a window. The level bit is never cleared, so `readKeyLevelFromSab` (`:800-820`) and `GetAsyncKeyState`/`GetKeyState` (`user32/input.ts:52-93`) keep reporting *pressed* throughout — this is exactly why it cannot be done host-side by toggling the bit.
4. **L/R modifier scan codes — `input-manager.ts:168-206`.** Add VK `0xA0..0xA5` (L/R SHIFT/CONTROL/MENU) to `VK_TO_SCAN` with their extended bits; today `vkToScanCode` falls through `VK_TO_SCAN[vk] ?? vk` at `:196` and hands lParam-consuming engines (Unreal WinDrv) a nonsense scan code.
5. **`src/worker/harness/cmds/wm-trace.ts` — NEW.** `wmTrace("start"|"stop"|"read")`: a capped ring of `WindowManager.postMessage` entries (`hwnd`, `msg`, `wParam`, `lParam`, screen x/y, seq) filtered to `WM_MOUSE*`/`WM_KEY*`/`WM_SETCURSOR`. Registered from `src/worker/harness/commands.ts:33-52`. This is the assertion primitive for the whole series.
6. **`src/worker/harness/cmds/assert.ts`** — `expectMessages(pattern[])`: assert an ordered subsequence over the `wmTrace` ring.

**Acceptance.**
```
.wmTrace('start').move(320,240).clickAt(400,300).wmTrace('stop')
.expectMessages(['WM_MOUSEMOVE@400,300','WM_LBUTTONDOWN@400,300','WM_LBUTTONUP@400,300'])
```
Plus a regression sweep of the existing bring-up corpus recorded in the memory files — Blackwell (AGS), Worms Armageddon, Sea Dogs, Airfix Dogfighter, NFSU — each `openWgb → waitForEvent → click through to gameplay → expectSurfaceNonBlack`, before/after commits 1–4.

> **Explicitly out of scope, and staying out:** changing `App.tsx:1411-1412` (`Math.round(event.movementX * scaleX)` in the *absolute* branch) to raw deltas. That line is the DirectInput relative feed for every non-pointer-locked title; with a 640×480 guest on a ~1280 px canvas, `scaleX ≈ 0.5`, so "fixing" it silently doubles DInput sensitivity for every freshly tuned bring-up. Touch never uses that path — `addPointerRelative` feeds raw, and the locked branch already does. Leave it alone.
>
> **Also out of scope:** re-enabling `checkDblClick` (`:750-762`). Its disabling comment names a *behavioural* first cause — "Heroes3 WndProc calls SetCapture on LBUTTONDOWN but NOT on DBLCLK" — not a missing class style. A `CS_DBLCLKS` gate is implementable (class style is tracked at `user32/class.ts:50,69,113,159,235,311`) but would re-break HoMM3 if its class *does* carry the bit, and for touch the payoff is illusory anyway (`SM_CXDOUBLECLK` is 4 px; a finger double-tap jitters far past 4 guest px). Separate investigation: dump `classInfo.style` for HoMM3's main class first.

---

## P2 — VirtualInputDevice + source composition

**Goal.** One main-thread SAB writer with per-source OR-composed levels.

**User-visible after this.** Nothing yet, but two latent bugs die: a physical keystroke can no longer wipe another producer's key state, and a phantom held key/button can no longer survive a game switch into the next title's first frame.

**Changes.**

- **`src/input/bindings.ts` — NEW.**
  ```ts
  export type Binding =
    | { t:"key";   vk:number }
    | { t:"mouse"; button:0|1|2 }
    | { t:"wheel"; delta:number }
    | { t:"pad";   button:number }
    | { t:"axis";  axis:0|1|2|3; value:number }
    | { t:"host";  action:"fullscreen"|"pause"|"releaseRelative"|"keyboard"|"toggleControls"|"editLayout" };
  export function parseBinding(x: unknown): Binding | null;
  export function describeBinding(b: Binding): string;
  ```
- **`src/input/virtual-device.ts` — NEW.** `SourceId = "hw-mouse" | "hw-key" | "hw-pad" | "touch" | "widget" | "osk" | "replay"`. Per-source `Int32Array(8)` key levels, per-source button mask, per-source pad state. API: `applyBinding(b, active, source)`, `setPointerAbsolute(x,y)`, `addPointerRelative(dx,dy)`, `addWheel(delta)`, `setMouseInside(v, source)`, `publishPad(state, source)`, `releaseSource(id)`, `releaseAllSources()`, `commit(opts?: {immediate?: boolean})`.
  - **Composition:** keys OR across sources; buttons OR; `gamepadConnected` OR; `gamepadButtons` OR; per-axis the larger-magnitude contribution wins (physical breaks ties).
  - **Commit policy:** button/key **edges** flush immediately (a level transport loses them otherwise); pure **moves** coalesce to one flush per rAF. On a 120 Hz phone with three contacts this removes ~90 % of the `postMessage({type:"input_tick"})` traffic into a worker sitting inside multi-ms JIT blocks.
  - **Dev-mode invariant** in `commit()`: no source may hold a key/button while reporting zero active inputs.
- **`src/app/App.tsx`** — route every existing writer through the device:
  - `writePointer` (`:1331-1432`) → `setPointerAbsolute` / `addPointerRelative` / `applyBinding({t:"mouse"…}, …, "hw-mouse")`.
  - `handleKey` (`:1485-1568`) → `applyBinding({t:"key",vk}, down, "hw-key")`. **Delete** `pressedKeys` (`:172`) and `syncKeyBitfield` (`:174-183`).
  - `handleWheel` (`:1612-1673`) → `addWheel`.
  - Gamepad rAF loop (`:2108-2149`) → `publishPad(state, "hw-pad")`. No longer an unconditional owner of slots 6..11.
  - `applyInputSample` (`:1813-1831`) → source `"replay"`.
  - `handleBlur` (`:1725-1744`) → `device.releaseAllSources()`, which **also clears `mouseInside` (slot 13)** — it does not today (verified: `:1730-1734` writes bitfield, buttons, keyCode, keyState only), so a latched inside flag would otherwise latch forever, across game switches.
- **`src/worker/runtime/input/input-manager.ts:822-868`** — `reset()` zeroes only the worker→host slots it owns (`guestPolledKeys[8]`, `guestInputSeq`, `guestInputFlags`, `guestGamepadSeq`) and posts `{type:"input_reset"}`. It must **not** zero host-owned payload slots — that races the host's seqlock writer.
- **`src/app/App.tsx`** — handle `input_reset`: `device.releaseAllSources(); device.commit({immediate:true})`. Closes the recon gap where keys still down at game exit are re-diffed against a zeroed `prevKeyBitfield` and re-emitted as fresh `WM_KEYDOWN`s in the next game.

**Acceptance.** `tools/tests/virtual-device.test.ts`: property test — any random sequence of `applyBinding(press)/applyBinding(release)/releaseSource/releaseAllSources` ends with every SAB level slot at 0 and `seq` even; a `"widget"` key held across an `"hw-key"` press/release stays set; pad merge with physical-connect mid-hold keeps the virtual button.

---

## P3 — Touch → mouse (the first shipped deliverable)

**Goal.** A finger is a mouse. Tap, drag, right-click, wheel, and mouse-look all work.

**User-visible after this.** On a phone or tablet a player can tap menus in a point-and-click adventure and have the click land where they aimed; right-click with two fingers or a long press; scroll with two fingers; and look around in a 1999 FPS by dragging — with no pointer-lock rejection storm, no frozen cursor, no stuck button after a cancelled touch.

**Changes.**

- **`src/input/relative-intent.ts` — NEW.** The four refs from `App.tsx:496-499`, the same OR from `:516-517`, plus `subscribe(fn)`. Consumers: (A) the existing Pointer Lock engage/release, now gated `pointerSource === "mouse"`; (B) `TouchDriver.setRelative(bool)`.
- **`src/app/App.tsx`**
  - `:489-528` — `wantsPointerLockRef` → `relativeIntent` store; `updatePointerLockIntent` → `updateRelativeIntent`. Producers untouched.
  - `pointerSourceRef` latch, set from `event.pointerType` on **every** panel pointer event, flipping in both directions (hybrid laptop, tablet + Bluetooth mouse). No UA sniff, no `maxTouchPoints` behavioural check.
  - `requestPointerLockSafe` (`:506-509`) gains `if (pointerSourceRef.current !== "mouse") return;` — an allow-list. Kills the per-`pointermove` rejection storm at `:1339-1347` and the `movementX === 0/undefined` freeze/NaN-pin.
  - The five canvas handlers (`:1331`, `:1434`, `:1446`, `:1570`, `:1593`) each gain `if (event.pointerType !== "mouse") return;` as their first line.
  - Bind `pointercancel` and `lostpointercapture` on `panelRef` alongside the driver's set.
  - **`set_cursor_pos` (`:1195-1206`)** — publish `mouseX/mouseY` when pointer-locked **or** when a touch relative transport is active. Today it is `if (pointerLockedRef.current)` only, so on a phone a guest that warps to screen centre every frame (AGS, UE, most 1999 FPS) never has the warp published and computes a huge bogus delta the frame after every warp — the classic runaway-mouse bug. `virtualCursorRef` is the single owner; warp and finger-delta cannot disagree.
  - `visualViewport` **`"scroll"`** added to the `canvasRectRef` refresh list at `:1322-1328` (only `"resize"` today) — a pinch-pan otherwise desyncs every mapped coordinate and every widget hit-test.
- **`src/input/touch/gestures.ts` — NEW.** All thresholds as named constants: `ARBITRATION_MS = 80`, `DRAG_SLOP_PX = 8`, `DRAG_COMMIT_MS = 180`, `FLICK_SPEED_PX_MS = 0.6`, `LONG_PRESS_MS = 500`, `TAP_HOLD_MS = 64`, `REFINE_GAIN = 0.35`, `AXIS_LATCH_PX = 24`, `WHEEL_NOTCH_PX = 40`, `FINGER_OFFSET_Y_PX = -28`.
- **`src/input/touch/recognizer.ts` — NEW.** Pure, DOM-free, timer-free:
  ```ts
  export function createRecognizer(cfg: RecognizerConfig): RecognizerState;
  export function step(s: RecognizerState, ev: TouchEvent2, now: number): TouchIntent[];
  export function tick(s: RecognizerState, now: number): TouchIntent[];
  ```
  `TouchIntent = {k:"cursor",x,y} | {k:"delta",dx,dy} | {k:"button",button,down} | {k:"wheel",delta}`. `tick()` is driven from the driver's rAF; that is how `LONG_PRESS_MS` and the tap timeout fire without the recognizer owning a clock — and why every gesture claim below is a unit test.
- **`src/input/touch/driver.ts` — NEW.** Binds the listener set on **`panelRef`**, converts CSS→guest px with `mapClientToGuest()` extracted from `writePointer:1393-1405` (shared, so the two paths cannot drift), owns the virtual cursor and the acceleration curve, selects the mode from `relativeIntent`, hit-tests contacts against the flat widget-rect array (P5), and forwards intents to `VirtualInputDevice`.
- **`src/input/touch/precision.ts` — NEW.** Finger offset vector, REFINE gain curve, reticle geometry.
- **`src/app/App.module.css`** — `-webkit-touch-callout: none; -webkit-user-select: none; user-select: none; touch-action: none; -webkit-tap-highlight-color: transparent` on `.app__panel`. Without this, an iOS long press over the canvas raises the selection callout and fires `pointercancel` — killing the RMB gesture. A `pointercancel` arriving while a long-press timer is armed must **abort** the gesture without emitting any button.
- **`src/ui-settings.ts`** — flat scalars only (`:19-30` type, `:34-43` defaults, `:47-89` validators):
  ```
  touchMode:            "auto"|"direct"|"trackpad"|"off"   default "auto"
  touchSensitivity:     number 0.25..4                     default 1
  touchLongPressRight:  boolean                            default true
  touchCursorAid:       boolean                            default true
  ```
- **`src/settings/SettingsInputSection.tsx`** — a `Touch` block with those rows. **No new `SettingsSectionId`** — that costs four coordinated edits (`settings/types.ts:21`, `SettingsDrawer.tsx:28-35`, `:37-44`, `:100-107`) to house four scalars that belong under Input, and the section already receives the full `SettingsDrawerProps`.
- **Harness.** `tools/harness.ts:95-136` — generalize the hardcoded `s.cmd !== "reload"` filter into a `CDP_STEPS` set with the same preflight + result-splicing shape. `tools/cdp-core.ts:50-59` — add `--touch-events=enabled` so `navigator.maxTouchPoints > 0` in automation. `tools/cdp-touch.ts` — NEW: `Emulation.setDeviceMetricsOverride` / `setTouchEmulationEnabled` + `Input.dispatchTouchEvent`, with guest-px↔CSS-px conversion extracted from `cmdGridShot` (`tools/harness.ts:250-263`) into `tools/cdp-geometry.ts`. New CDP verbs: `device(profile)`, `tap(x,y)`, `touchDrag(x0,y0,x1,y1,ms)`, `longPress(x,y,ms)`, `twoFingerTap(x,y)`, `pinch(x,y,scale)`. `src/harness/dsl.ts:78-92` fluent methods; `src/harness/journal.ts:12-21` — add all of them **plus the currently missing `clickAt`/`clickHold`/`keyHold`** to `NAMED_VERBS`.

**Acceptance.**
```
tools/tests/touch-recognizer.test.ts   // pure gesture timelines, no browser
```
```
.device('phone-landscape').openWgb(adventure).waitForEvent('dialogShow')
.wmTrace('start').tap(320,240).wmTrace('stop')
.expectMessages(['WM_MOUSEMOVE@320,240','WM_LBUTTONDOWN@320,240','WM_LBUTTONUP@320,240'])
.longPress(320,240,600).expectMessages(['WM_RBUTTONDOWN@320,240'])
.state(['input'])   // asserts pointerLockElement === null throughout
```

---

## P4 — Mobile shell

**Goal.** The game is actually visible and reachable on a phone, and the player can see where they are aiming.

**User-visible after this.** Landscape uses the whole screen instead of a 52 dvh sliver; a visible cursor sprite follows the finger with a thumb offset and a precision slow-zone; the screen does not sleep mid-game; the page does not rubber-band or pull-to-refresh; on iPhone, Add-to-Home-Screen gives a chrome-free window.

**Changes.**

- **`src/app/TouchCursorLayer.tsx` — NEW.** A DOM sprite at the virtual cursor, drawn from the ARGB pixels + hotspot the worker **already** sends via `cursor_image` (`App.tsx:1153-1174`). The existing CSS-cursor path (`updateCanvasCursor`, `:661-674`) is gated on `isCanvasHoveredRef` and is meaningless without a hovering pointer. When the guest hid its cursor, render a crosshair reticle. **Non-optional:** a fingertip covers ~34 guest px against 10–20 px Sierra/LucasArts hotspots, with zero feedback otherwise.
- **`src/app/App.module.css`**
  - `.app { height: 100dvh }` (`:9`), `overscroll-behavior: none` on the shell.
  - Replace the `@media (max-width:720px)` canvas-height hack (`:449-458`) with an orientation-aware block: landscape → canvas fills the panel; portrait → the current cap; `env(safe-area-inset-*)` on **all four** sides (the notch clips left/right in landscape today).
  - `.app--immersive` joined into the existing `:fullscreen`/`:-webkit-full-screen` selector lists (`:61-97`) so the aspect-lock / aspect-free / integer-scale rules and the CSS vars from `App.tsx:2515-2523` are shared, not forked.
  - `(pointer: coarse)` opt-out for `background-attachment: fixed` + the fixed SVG-noise overlay (`src/styles/tokens.css:93-119`) — continuous full-screen repaints stealing compositor budget from the frame loop.
- **`src/app/App.tsx:2251-2285`** — `toggleFullscreen()`: when neither `requestFullscreen` nor `webkitRequestFullscreen` exists, set `.app--immersive` on the root instead of silently resolving to `undefined`. Add `navigator.wakeLock.request("screen")` while a game runs, re-acquired on `visibilitychange`. Add a best-effort `screen.orientation.lock("landscape")` inside the activation gesture, **swallowing rejection** — it is unimplemented on iOS Safari and rejects on Android Chrome outside real fullscreen.
- **`public/manifest.webmanifest` — NEW** (`display: standalone`, `orientation: landscape`, icons, `start_url`), linked from `index.html:3-22` alongside the existing Apple metas (`:7-13`). Add-to-Home-Screen is the **only** chrome-free path on iPhone; immersive CSS restyles a viewport that iOS never enlarged, because `.app { overflow: hidden }` means the document never scrolls and Safari's URL bar therefore never collapses. Detect `navigator.standalone || matchMedia('(display-mode: standalone)').matches` and show an "Install for fullscreen" hint exactly when the Fullscreen API is absent and standalone is false.
- **Precision, in `driver.ts` + `precision.ts`** — finger offset `(0, -28 CSS px)` while a contact is down; REFINE (gain → 0.35×) once a contact has held past `DRAG_COMMIT_MS` and is moving slowly. Both gated on `uiSettings.touchCursorAid`.

> **Cut from scope:** Design 2's magnifier loupe. It needs a second transferred `OffscreenCanvas`, a `set_loupe` message and a per-frame sub-rect blit in the WebGPU presenter — real graphics-pipeline surface (§3.3) for a UI affordance, interacting with the pacing modes. The offset + reticle + REFINE kit solves sub-finger accuracy without touching the present path.

**Acceptance.**
```
.device('iphone-14-landscape').openWgb(adventure).waitForEvent('dialogShow')
.shot('mobile-landscape')       // visually: canvas fills the panel, no 52dvh sliver, no notch clipping
.tap(320,240).shot('cursor-sprite')
```

---

## P5 — On-screen controls (the second shipped deliverable)

**Goal.** A keyboard-less device can send keystrokes, joystick input and the host hotkeys.

**User-visible after this.** WASD/arrows, Esc/Enter, a d-pad or thumbstick, LMB/RMB buttons, a wheel strip, a VK-native on-screen keyboard, and touch-reachable Fullscreen / Pause / "release relative mouse" (today `F11` and `Right Ctrl`, keyboard-only, `App.tsx:1491-1514`).

**Changes.**

- **`src/input/controls/types.ts` — NEW.** `ControlWidget` kinds: `touchArea`, `button` (`hold`/`toggle`/`slide`), `dpad`, `stick` (`out: "keys"|"pad"|"mouse"`), `trackpad`, `wheelStrip`. `ControlLayout { id, name, version:1, orientation?, mode?, widgets }`. `validateLayout(unknown): ControlLayout | null` — **total, never throws**, drops unknown kinds and out-of-range placements (forward compat for bundles authored by newer tools). `migrateLayout(x)`. `resolveRects(layout, panelRect): Float32Array`.
- **Geometry is normalized to the PANEL, not the canvas.** For the 1998–2003 4:3 corpus this is decisive: on an 844×390 landscape phone a 4:3 guest occupies ~520×390, leaving two ~162 px letterbox bars — enough for a full thumb cluster that occludes **zero** gameplay. Translucent-over-canvas (with the opacity slider) is the fallback only when the guest aspect matches the device. `size` is normalized to `min(panelW, panelH)`, so one layout is correct on a 390×844 phone and a 2732×2048 tablet; minimum hit target 48 CSS px regardless of visual size; `env(safe-area-inset-*)` padding on the layer.
- **`src/app/TouchControlLayer.tsx` + `.module.css` — NEW.** Mounted as a sibling of `<canvas>` inside `.app__panel` (`App.tsx:2604-2614`) at **z-index 3** (canvas 1, InputStatusOverlay 4, loading 10, ExitOverlay 20, modals 100/110). Root is `pointer-events: none`; each widget is `pointer-events: auto` with `data-widget-id`. **The listeners are on `panelRef`, not on the layer root** — the layer is presentation, the driver's flat-rect hit-test does the routing. React renders widget *chrome* only; pressed state is `el.classList.toggle`, never `setState`. `contain: layout paint`, transform/opacity-only updates.
- **`src/input/controls/presets.ts` — NEW.** `pointer` (full-panel `touchArea` + utility cluster), `pointer-rmb` (+ sticky RMB toggle + `wheelStrip`), `wasd-look` (left `stick{out:"keys"}` → WASD, right `trackpad` → look, **a momentary LMB button under the right thumb** so an FPS has sustained fire, jump/use), `dpad-buttons`, `pad`. Landscape + portrait variants each.
- **`src/app/VirtualKeyboardSheet.tsx` — NEW.** Synthesizes VK numbers directly through `applyBinding({t:"key",vk}, down, "osk")`. **Never** the OS soft keyboard and never synthetic DOM `KeyboardEvent`s: `App.tsx:1532` is `const vk = event.keyCode & 0xff`, and Android/iOS IMEs report `keyCode 229` for most keys and frequently omit `keyup` — a junk VK jammed until a blur. Essentials strip (Esc/Enter/Space/Tab/arrows/F1-F12) + a full QWERTY sheet. Modifiers are **sticky latches** (one thumb cannot chord) and send L-variants, which is why P1's `0xA0..0xA5` scan-code entries are a prerequisite.
- **`src/app/TouchHud.tsx` — NEW.** A 44×44 corner handle (deliberately **not** an edge swipe — those collide with the OS back gesture and the notification shade) opening: Pause, Keyboard, Immersive, Direct↔Trackpad override, Edit controls. Backed by `{t:"host"}` bindings.
- **Harness.** `src/harness/facade.ts:31` — add `touchWidget` to `BROWSER_ONLY`; `:253-262` — a `runOneStep` branch dispatching a synthetic contact at `[data-widget-id]`. `src/harness/dsl.ts` + `journal.ts` accordingly.

**Acceptance.**
```
.device('phone-landscape').openWgb(fps).waitForEvent('dialogShow')
.wmTrace('start').touchWidget('key-w','down').sleep(300).touchWidget('key-w','up').wmTrace('stop')
.expectMessages(['WM_KEYDOWN vk=0x57','WM_KEYDOWN vk=0x57 repeat','WM_KEYUP vk=0x57'])
.touchWidget('osk-toggle').touchWidget('key-escape').expectDialog(/…/)
```

---

## P6 — Auto-detection + per-game layouts

**Goal.** The player configures nothing to start playing, and a title we have never seen gets a sane layout on its first boot.

**User-visible after this.** Opening a bundle on a phone lands on the right control scheme automatically; a per-game layout choice survives reloads and is keyed to the game, not the file name.

**Signals — all properties of what the *program does*, observed at our API boundary. Zero game identity anywhere.**

1. **Relative-mouse intent** — exists today, unchanged (`relativeIntent`). Means *this title steers with a relative mouse*.
2. **Guest joystick reads** — `guestGamepadSeq` (slot 24), bumped by `noteGuestGamepadRead` (`input-manager.ts:1233-1244`) on DI `Acquire`/`GetDeviceState` and winmm `joyGetPosEx`. Today it only colours a chip. Means *this title polls a pad*.
3. **Guest key polls** — new `noteGuestKeyRead(vk, wasPressed)` beside it. **Sets a bit only when the read RETURNED pressed** — a bulk `GetAsyncKeyState` scan over a wide VK range (common in 1998–2003 titles) would otherwise light every bit and degenerate `pickPreset` into a constant. `GetKeyboardState` and DI keyboard `GetDeviceState` set sentinel bits in `guestInputFlags` (slot 34) rather than forging VKs; DI8 `SetActionMap` entries' `dik`/`dikNeg`/`dikPos` are DIK→VK translated into the bitmap, which is the strongest signal available for DirectInput-only titles.

**Changes.**

- **`src/worker/modules/user32/input.ts:52-93`** — `GetAsyncKeyState`/`GetKeyState` call `noteGuestKeyRead(vKey, returnedPressed)`. Write is a **plain non-atomic `view[i] |= bit`** — the bitmap is monotonic set-only, so a lost OR merely delays detection by one poll — and collection is gated to a window after load / until a layout is pinned. Verify with `bun tools/analyze-trace.ts <trace>` that the JS slice of the worker trace is unchanged (§3.7's own bar). These are the hottest polled thunks and neither is served by a hypercall.
- **`src/worker/modules/dinput/dinput.ts:849-959`** — keyboard `GetDeviceState` sets the bulk sentinel; `SetActionMap` populates the bitmap.
- **`src/input/controls/auto-select.ts` — NEW.** Pure, total, table-driven:
  ```ts
  pickPreset({ relativeMouse, readsPad, polledVks, bulkKeyboard, orientation }): { presetId, mode }
  ```
  `readsPad` → `pad`, direct. `relativeMouse` → `wasd-look`, trackpad. WASD/arrows observed pressed → `dpad-buttons`/`wasd-look`, direct. `bulkKeyboard` only → `pointer` + keyboard sheet hinted once. Otherwise `pointer`. Evaluated on a 500 ms debounce, **sticky once fired** (presets are supersets — `wasd-look` still taps fine in a menu), and stopped permanently for a `gameId` once the user picks or edits a layout.
- **`src/input/controls/layout-store.ts` — NEW.** `localStorage["bottleship_touch_layout_v1:<gameId>"]` plus `":default"`, with its own parse guard. **localStorage, not OPFS** — the overlay must have a layout at first paint and OPFS reads are async. **Not** inside `UiSettings` — `loadUiSettings` is one `try/catch` (`ui-settings.ts:47-89`) where one malformed layout silently resets *all* settings to defaults.
- **Per-game key = the manifest `gameId`.** The worker already posts it (`emulator.worker.ts:1492`, `:1780-1783`); `App.tsx:961-964` currently reads only `name` and discards it — capture it into `gameIdRef` + state. **Not** the `.wgb` cache filename used by `_manifest-overrides.json` (`src/wgb-library.ts:96-116`), which the worker applies only under `if (payload.url)` (`emulator.worker.ts:1461-1476`) — a layout edited on a "Load File…" bundle would silently evaporate — and which changes on rename/re-download.
- **Manifest tier.** `emulator.touch?: { layout?: string | ControlLayout; mode?: "auto"|"direct"|"trackpad" }` declared on the `emulator?:` interface in `src/worker/runtime/filesystem/wgb-loader.ts:98-229`. It rides the **existing** `bundle_meta` post and deliberately does **not** go through `EmulatorConfig.applyFromManifest` — a field added there and forgotten in `reset()` (`emulator-config-manager.ts:615-640`) leaks into the next game in the same worker session, and the worker never reads this data anyway (the `cdPath` precedent, `emulator.worker.ts:1509-1511`).
  - **`emulator.worker.ts`** — extract `postBundleMeta(name, gameId, touch)` and call it from **both** `:1492` and `:1780-1783`. There are two sites; adding the field to one and forgetting the other silently substitutes auto-detect for an authored layout on one load path.
- **`tools/make-wgb.ts:282-299`** — `--touch-layout <presetId|file.json>` into the `manifest.emulator` literal via the existing conditional-spread + `JSON.stringify` pattern. **`src/wizard/ManifestEditorModal.tsx:29-114`** — one `FormState` key + load read + `buildPatch` write (a preset `<select>`).

**Acceptance.**
```
tools/tests/auto-select.test.ts    // preset scoring, one test per rule
tools/tests/touch-layout.test.ts   // validateLayout drops junk; resolveRects anchoring; precedence
```
```
.openWgb(fps).tickFrames(240).state(['touchLayout'])       // → wasd-look, trackpad
.openWgb(adventure).tickFrames(240).state(['touchLayout']) // → pointer, direct
// both load paths:
.openWgb(url).state(['bundleMeta'])  and  .loadFile(blob).state(['bundleMeta'])
```

---

## P7 — Layout editor

**Goal.** The minority of titles whose bindings are unguessable become configurable, and bundle authors get an export path.

**User-visible after this.** Drag/resize widgets, rebind any widget to a VK / mouse button / pad button, save per game, reset to the resolved default, export JSON for `emulator.touch`.

**Changes.** `src/app/TouchLayoutEditor.tsx` + `.module.css` — the same `TouchControlLayer` with `editing=true`; widgets become drag/resize handles snapped to a 2-vmin grid; `BindingPicker` captures either a physical keypress or a pick from a VK/button list. `device.releaseSource("widget")` and a mute flag while editing so editing never leaks input to the guest. Entry points: the HUD's `{t:"host",action:"editLayout"}` and a button in `SettingsInputSection`.

**Acceptance.** `.touchWidget('hud').touchWidget('hud-edit').…` drag → save → reload → `state(['touchLayout'])` shows the persisted position.

---

# Data model

```ts
// src/input/bindings.ts
type Binding =
  | { t:"key";   vk:number }
  | { t:"mouse"; button:0|1|2 }
  | { t:"wheel"; delta:number }
  | { t:"pad";   button:number }
  | { t:"axis";  axis:0|1|2|3; value:number }
  | { t:"host";  action:"fullscreen"|"pause"|"releaseRelative"|"keyboard"|"toggleControls"|"editLayout" };

// src/input/controls/types.ts
type Anchored = { anchor:"tl"|"tr"|"bl"|"br"|"c"; x:number; y:number; w:number; h:number }; // panel-normalized, vmin sizes
type ControlWidget =
  | { kind:"touchArea";  id:string; rect:Anchored }
  | { kind:"button";     id:string; rect:Anchored; label?:string; icon?:string; bind:Binding;
                         hold?:boolean; toggle?:boolean; slide?:boolean }
  | { kind:"dpad";       id:string; rect:Anchored; binds:{up:Binding;down:Binding;left:Binding;right:Binding}; diagonals?:boolean }
  | { kind:"stick";      id:string; rect:Anchored; out:"keys"|"pad"|"mouse";
                         binds?:{up:Binding;down:Binding;left:Binding;right:Binding};
                         axis?:0|2; deadzone?:number; sensitivity?:number; recenter?:boolean }
  | { kind:"trackpad";   id:string; rect:Anchored; taps?:boolean }
  | { kind:"wheelStrip"; id:string; rect:Anchored; step?:number };
type ControlLayout = { id:string; name:string; version:1;
                       orientation?:"any"|"landscape"|"portrait";
                       mode?:"auto"|"direct"|"trackpad";
                       widgets:ControlWidget[] };
```

`validateLayout(unknown)` is **total and never throws** — it drops unknown widget kinds and out-of-range placements rather than failing the layout, because bundles are authored by older and newer tools than the one reading them.

## Precedence (highest wins)

| # | Tier | Storage | Key |
|---|---|---|---|
| 1 | Session (editor in progress) | memory | — |
| 2 | **Per-game user override** | `localStorage["bottleship_touch_layout_v1:<gameId>"]` | manifest `gameId` from `bundle_meta` |
| 3 | **Global user default** | `localStorage["bottleship_touch_layout_v1:default"]` | — |
| 4 | **Bundle manifest** | `emulator.touch.{layout,mode}` → `bundle_meta` | authored |
| 5 | **Auto-detected preset** | `pickPreset(signals)` | runtime |
| 6 | **`pointer`** | built-in | fallback |

Resolved by one pure function, `resolveActiveLayout({ session, userOverride, globalDefault, manifest, autoPick })`, unit-tested per rule. Once tier 2 exists for a `gameId`, auto-detect stops for that game (`pinned`).

Global scalars stay in `UiSettings` (`touchMode`, `touchSensitivity`, `touchLongPressRight`, `touchCursorAid`, `touchControlsOpacity`) — flat only, three hand-written edits each, picked up automatically by `handleResetSettings` (`App.tsx:596-599`).

---

# Gesture vocabulary

Single-contact state machine (constants from `src/input/touch/gestures.ts`). **Classification is deferred to lift or to a timer — never committed on touchdown.** This is what simultaneously fixes the precision-slide-vs-drag collision, the LMB-held-before-RMB collision, and the lost-tap problem.

| Gesture | Absolute ("direct") mode | Relative ("trackpad"/"look") mode |
|---|---|---|
| contact down | publish cursor at contact + `(0,-28 px)` offset; **no button**; arm 80 ms arbitration | seed virtual cursor from SAB; **no button** |
| lift within slop, before `LONG_PRESS_MS` | **tap at the FINAL position**: LMB down, hold `TAP_HOLD_MS` (64 ms wall-clock), LMB up | tap at the current virtual cursor, same 64 ms hold |
| slop crossed **within 180 ms** or above flick speed | **drag**: publish cursor at origin, LMB down (one commit), then follow the finger | relative delta, no button (this is look/aim) |
| slop crossed **after 180 ms at low speed** | **REFINE**: cursor follows at 0.35× gain, still no button — this is the precision aim slide; still resolves to a tap at its final position on lift | relative delta at 0.35× gain |
| still within slop at `LONG_PRESS_MS` (500 ms) | `touchLongPressRight` ? **RMB down**, held until lift : **LMB down**, held until lift | same |
| 2nd contact within 80 ms | button selector → **RMB**; on lift of all contacts, RMB down/up with the 64 ms hold at the primary position | same, at the virtual cursor |
| 3rd contact within 80 ms | → **MMB**, same shape | same |
| 2-finger drag / pinch | **wheel**; axis latched **once** over the first 24 px (dominant of common-mode ΔY vs Δdistance), then held for the life of the gesture; one notch per 40 px | same |
| `pointercancel` / `lostpointercapture` | drop the contact, recompute the mask from the live contact set → the button releases; **abort any armed long-press without emitting a button** | same |
| `mouseInside` (slot 13) | **latched 1** on first contact, cleared only by `releaseAllSources()` (blur / hidden / `input_reset`) | same |

Why the deferred commit is the right trade: a still finger held in place is genuinely ambiguous, and 500 ms is the standard resolution point. Hold-to-move in a Diablo-like is expressed by *moving* the finger, which crosses slop and commits LMB immediately with no latency. Pure still-hold-LMB (a scrollbar arrow) either waits 500 ms or — better — uses a sticky `button` widget, which is explicit and zero-latency. Committing LMB on touchdown and releasing it 500 ms later to promote to RMB would put half a second of "walk toward that point" into every right-click in exactly the genre where RMB matters.

`TAP_HOLD_MS = 64` is not a heuristic: the SAB transport is level-based with no edge queue, so a synchronous down+up between two polls cancels out entirely. The repo already proved this — `src/worker/harness/cmds/input.ts:99-112` (`clickHold`) exists solely because a guest polling button *state* at a low frame rate never observes the held frame. 64 ms covers a 15 fps poller; the latency lands on the *up*, which is imperceptible.

---

# Risks and resolved critiques

## Fatals

| Finding | Resolution |
|---|---|
| **D1: no `pointerType` split** — `TouchArbiter` and the canvas handlers both consume the same touch event, double-writing contradictory semantics | P3 states it explicitly: `if (event.pointerType !== "mouse") return;` as the first line of `writePointer`, `handlePointerDown/Up/Enter/Leave` (`App.tsx:1331, 1434, 1446, 1570, 1593`). Touch is handled only by the driver on `panelRef`. |
| **D1: tap has no wall-clock dwell** → most taps are a no-op on a level-based transport | `TAP_HOLD_MS = 64` as a named constant in `gestures.ts`, applied to every synthesized tap in both modes. Same reasoning as the existing `clickHold`. |
| **D2: writer-side typematic (bit toggling)** is observable as a real `WM_KEYUP` and as "not pressed" to `GetAsyncKeyState` (`readKeyLevelFromSab` reads the SAB directly, `:800-820`); also nets to nothing under rAF coalescing | Rejected. Typematic lands in `poll()` (P1.3) with lParam bit 30 and **no** intervening `WM_KEYUP`; the level bit is never cleared. Fixes desktop too, needs no per-binding opt-out. |
| **D2: finger offset vs 12 px drag slop cancel each other** — the aiming slide is reclassified as a drag from the wrong pixel | Deferred classification. A slop crossing is a drag only within `DRAG_COMMIT_MS = 180` or above flick speed; a slow slide after that is REFINE and resolves to a **tap at its final position** on lift. |
| **D3: layer mount** — a `pointer-events:none` sibling root cannot receive a contact on bare canvas, and the canvas handlers early-return on touch → zero input | Listeners bind on **`panelRef`** (`App.tsx:2604`), the real common ancestor, with the flat-`Float32Array` hit-test routing contacts to widget vs translator. iOS implicit pointer capture is harmless because the panel is an ancestor of both. |
| **D3: slot-34 `writerLock`** does not protect the key bitfield / dinput accumulators / wheel (all read outside the validated region), and "abandon on contention" drops terminal edges → stuck buttons | **Dropped entirely.** Replaced by the one-line real fix: copy slots 16..23 into the snapshot **before** the `Atomics.load(seq) !== seq` re-check at `:406` (P0). The remaining host↔worker-injector race is a two-writer, level-based situation that self-heals on the next event; a spin lock on the main thread would be strictly worse. |

## Serious

| Finding | Resolution |
|---|---|
| Raw-vs-scaled `dinputDX/DY` in the absolute branch would silently double DInput sensitivity | **Not changed.** `App.tsx:1411-1412` stays `movementX * scaleX`. Touch never uses it; raw is fed only by the locked branch and `addPointerRelative`. Called out explicitly in P1's out-of-scope note. |
| D3: LMB held for 500 ms before every long-press RMB | Deferred commit — a still contact holds **no** button until `LONG_PRESS_MS`, then goes straight to RMB. No L+R chord, no spurious walk. |
| D2: long-press unconditionally steals LMB-hold | `touchLongPressRight: boolean` (default true); when false, a still contact commits LMB at 500 ms. 2-finger RMB is always available and deterministic. |
| `handleBlur` does not clear `mouseInside` (verified `:1730-1734`) → a latched flag latches forever | `releaseAllSources()` owns `mouseInside` as a source-owned level; `handleBlur` calls it. |
| `InputManager.reset()` leaves the SAB dirty across a game switch; zeroing it from the worker races the host writer | Split ownership: `reset()` zeroes only worker→host slots and posts `input_reset`; the host clears sources and republishes zeros through its single writer bracket. |
| Cross-word key chords can tear (bitfield read after `lastSeq` commit) | P0, snapshot fix. Desktop benefit, no touch involved. |
| Polled-VK telemetry on the hottest thunks | Plain non-atomic `|=` (monotonic set-only), gated to a post-load window, **and only set when the read returned pressed** — which also defeats the bulk-scan saturation that would otherwise make `pickPreset` a constant. Verified with `analyze-trace.ts`. |
| D2's loupe adds a second present path | Cut. Offset + reticle + REFINE cover precision without touching the presenter. |
| D3's two commits per pointerdown | One commit. The gate deletion (P1.1) is the actual fix; a second commit is not guaranteed to be observed anyway, and doubles postMessage traffic on the weakest device. |
| Pen (`pointerType: "pen"`) routed to the pointer-lock path → iPad Pencil hits the rejection storm | Allow-list: Pointer Lock only for `pointerType === "mouse"`. |
| `bundle_meta` posted from two sites (`:1492`, `:1780-1783`) | Extracted `postBundleMeta()` helper called from both, asserted in the harness for URL-load **and** blob/"Load File…" paths. |
| Immersive mode / `orientation.lock()` buy nothing on iPhone | Shipped anyway (they help Android and desktop) but **not** treated as the answer: `manifest.webmanifest` + an install hint gated on `Fullscreen API absent && !standalone` is the iOS path, and portrait layout variants are first-class. Orientation lock rejections are swallowed. |
| No touch-callout/user-select suppression → iOS long press raises the selection UI and fires `pointercancel` | Added to `.app__panel` and every widget; a cancel while a long-press is armed aborts without emitting a button. |
| Widgets floating over gameplay | Panel-normalized geometry preferring the letterbox bars; translucent-over-canvas only for aspect-matched guests. |
| D2's `look` preset has no sustained fire | A momentary LMB button under the right thumb in the `wasd-look` preset; the trackpad's tap emits a full down/up with the 64 ms floor. |
| No new `SettingsSectionId` cost debate | Rows go in `SettingsInputSection` (already receives full `SettingsDrawerProps`); the editor is a modal launched from there. |
| Harness cannot drive touch at all today | `--touch-events=enabled` in `cdp-core.ts:50-59`, `CDP_STEPS` generalization of `execViaCdp`'s hardcoded `"reload"` filter (`harness.ts:95-136`), `Emulation.*` device verbs, and `NAMED_VERBS` completed (including the currently missing `clickAt`/`clickHold`/`keyHold`). |
| `checkDblClick` restore | **Out of scope.** Its disabling comment's first cause is a HoMM3 `SetCapture`-on-DOWN-but-not-DBLCLK divergence, not a missing `CS_DBLCLKS` bit. Separate investigation; dump `classInfo.style` first. |

## Residual risks (accepted, tracked)

- Deleting the `!buttonChanged` gate changes ordering for every title. Mitigated by the `wmTrace`/`expectMessages` sweep over the bring-up corpus, but a regression would mean a real ordering bug elsewhere — not a reason to restore the heuristic.
- `VirtualInputDevice` centralizes every host SAB write; a composition bug breaks all input at once. Mitigated by the dev-mode `commit()` invariant and the property test.
- Trackpad mode has no browser-enforced capture; a drag can leave the panel. Contacts are tracked by `pointerId` on the panel and released on `pointercancel`; iOS pointer capture on touch is historically unreliable, so we deliberately do **not** call `setPointerCapture` (that is what collapses multitouch today).
- Auto-detect signals arrive after boot, so the overlay changes once a few seconds in. Sticky-once-fired limits it to one visible transition.
- The flat 1 GB guest allocation (`emulator-config.ts:1`) is untouched. Making phones first-class makes this pre-existing gap much more visible; a `navigator.deviceMemory`-aware clamp is a genuine blocker for iOS phone playability and is **not** in this plan.
- A real phone cannot reach the dev server today: plain HTTP on a LAN IP is not a secure context, so `SharedArrayBuffer` is undefined. Device-emulation harness runs cover regressions; human validation needs `bun run dev:ssl` with a trusted cert or a preview deploy.

---

# Open questions for the user

1. **iOS phone RAM.** Should a `navigator.deviceMemory`-aware guest-RAM clamp be added to this workstream (a new phase between P4 and P5), or tracked separately? Without it, phone bring-up will hit tab kills before any of this matters — but it touches `EmulatorConfig` and the manifest RAM path, which is a different blast radius.
2. **Human validation origin.** Do you want a trusted-cert dev origin (mkcert / a tunnel) set up as part of P3, or is a Cloudflare preview deploy the intended device-testing path? This gates every "does it actually feel right" judgement.
3. **Default for `touchLongPressRight`.** Plan defaults it **true** (long-press = RMB, still-hold-LMB costs 500 ms). If your target corpus skews toward hold-to-repeat UIs rather than RMB-centric ones, flipping the default is a one-line change but changes what "works out of the box" means.
4. **Which two bundles are the acceptance targets?** The plan assumes one 640×480 point-and-click (Blackwell) and one relative-mouse 3D title (NFSU or Airfix). Confirm, or name others — every phase's harness chain is written against them.
