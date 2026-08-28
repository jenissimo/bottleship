/**
 * Input + dialog harness verbs: click, key, type, move, drag, wheel,
 * and dialog enumeration. These wrap the InputManager injection helpers (which
 * write the SAB and run the faithful poll() routing) and the exported dlg helpers
 * from dbg-commands. Unlike dbg.dlgClick (which only emits a dbg_event), these
 * RETURN {ok,...} through the RPC contract.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";
import {
    windows,
    buttonCheckStates,
    listControlStates,
    trackbarStates,
} from "../../modules/user32/shared-state";
import { getScrollBarState, SB_CTL, SB_HORZ, SB_VERT } from "../../modules/user32/scroll-state";
import { getListViewState } from "../../modules/user32/list-view-control";
import { getComboDropdownRect } from "../../modules/user32/controls";
import { hitTestSystemControlAtScreenPoint } from "../../modules/user32/control-interaction";
import { describeEditLayout } from "../../modules/user32/edit-control";
import { getDeviceNotifications } from "../../modules/user32/device-notify";
import { describeDlgControl, findDlgControl } from "../dlg";
import { recorder } from "../recorder";

/** Common key name -> Win32 VK. Single characters fall through to char-code mapping. */
const VK_NAMES: Record<string, number> = {
    enter: 0x0d, return: 0x0d, escape: 0x1b, esc: 0x1b, space: 0x20, tab: 0x09,
    backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
    pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
    f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};

/** char -> {vk, shift} of the US-layout key that PRODUCES it. The producing
 *  key's VK is NOT the char code for shifted symbols ('!' is Shift+'1', VK 0x31 —
 *  not 33=VK_PRIOR). Returns null for unmappable code points (skipped by type()). */
const SHIFT_CHARS: Record<string, { vk: number; shift: boolean }> = {
    "!": { vk: 0x31, shift: true }, "@": { vk: 0x32, shift: true }, "#": { vk: 0x33, shift: true },
    "$": { vk: 0x34, shift: true }, "%": { vk: 0x35, shift: true }, "^": { vk: 0x36, shift: true },
    "&": { vk: 0x37, shift: true }, "*": { vk: 0x38, shift: true }, "(": { vk: 0x39, shift: true }, ")": { vk: 0x30, shift: true },
    ";": { vk: 0xba, shift: false }, ":": { vk: 0xba, shift: true },
    "=": { vk: 0xbb, shift: false }, "+": { vk: 0xbb, shift: true },
    ",": { vk: 0xbc, shift: false }, "<": { vk: 0xbc, shift: true },
    "-": { vk: 0xbd, shift: false }, "_": { vk: 0xbd, shift: true },
    ".": { vk: 0xbe, shift: false }, ">": { vk: 0xbe, shift: true },
    "/": { vk: 0xbf, shift: false }, "?": { vk: 0xbf, shift: true },
    "`": { vk: 0xc0, shift: false }, "~": { vk: 0xc0, shift: true },
    "[": { vk: 0xdb, shift: false }, "{": { vk: 0xdb, shift: true },
    "\\": { vk: 0xdc, shift: false }, "|": { vk: 0xdc, shift: true },
    "]": { vk: 0xdd, shift: false }, "}": { vk: 0xdd, shift: true },
    "'": { vk: 0xde, shift: false }, '"': { vk: 0xde, shift: true },
};

function charToKey(ch: string): { vk: number; shift: boolean } | null {
    if (ch.length !== 1) return null; // astral / surrogate pair → skip, don't throw
    if (ch >= "A" && ch <= "Z") return { vk: ch.charCodeAt(0), shift: true };
    if (ch >= "a" && ch <= "z") return { vk: ch.toUpperCase().charCodeAt(0), shift: false };
    if (ch >= "0" && ch <= "9") return { vk: ch.charCodeAt(0), shift: false };
    if (ch === " ") return { vk: 0x20, shift: false };
    if (ch === "\t") return { vk: 0x09, shift: false };
    if (ch === "\n" || ch === "\r") return { vk: 0x0d, shift: false };
    return SHIFT_CHARS[ch] ?? null;
}

function toVk(key: number | string): number {
    if (typeof key === "number") return key & 0xff;
    const k = String(key);
    const named = VK_NAMES[k.toLowerCase()];
    if (named !== undefined) return named;
    if (k.length === 1) {
        const c = k.toUpperCase().charCodeAt(0);
        return c & 0xff; // letters/digits map VK==ASCII-uppercase
    }
    throw new HarnessError(`unknown key '${k}'`, HarnessErrorCode.BAD_ARGS);
}

function input() {
    const im = sys().inputManager;
    if (!im) throw new HarnessError("no input manager", HarnessErrorCode.NO_PROCESS);
    return im as any;
}

/** Input commands that mutate guest state — recorded by the present-serial
 *  recorder and replayable. (dialogs/findControl are read-only queries, excluded.) */
export const RECORDABLE_INPUT = new Set([
    "click", "clickAt", "move", "moveRelative", "drag", "wheel", "key", "type", "padPlug",
]);

/**
 * Apply one input command — the single implementation shared by the registered
 * RPC verbs AND the record/replay engine (so a replayed input takes the exact
 * same faithful path). Returns the command's result POJO.
 */
/** Shortest press a human hand produces; long enough to span a guest frame at 30-60 fps. */
const CLICK_HOLD_MS = 80;

/** Pending releases per button, so back-to-back clicks cannot leave a button stuck down. */
const pendingRelease = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * The relative-mouse posture stamped onto every pointer verb's result. A title that
 * steers by MOTION owns the cursor it hit-tests against, and no absolute screen
 * coordinate we publish describes where that cursor sits — so `clickAt` there is a
 * plausible-looking no-op. This stamp is what makes that visible; `moveRelative` is
 * the verb that actually addresses such a cursor.
 *
 * There is deliberately no "aim at (x,y)" verb: aiming a cursor whose position only
 * the guest knows would have to assume it clamps to the viewport, and Alice (Q3
 * lineage) does NOT — it keeps stepping an off-screen position and draws it clamped,
 * so a "pin to the corner then step" aim silently lands nowhere. Step relatively and
 * read the cursor back off a `shot` instead.
 */
function pointerPosture(im: any): Record<string, unknown> | undefined {
    const p = im.relativeMousePosture?.();
    return p?.relative ? { relativeMouse: p } : undefined;
}

/**
 * A coordinate must be a real number. `Number(undefined) | 0` is 0, so a missing or NaN argument
 * used to click the top-left corner and report `{ok:true, x:0, y:0}` - a gesture that went
 * nowhere, indistinguishable from one that landed, which is how a scenario "clicks" a menu for
 * three runs while measuring only the idle animation.
 */
function coord(v: unknown, what: string): number {
    const n = Number(v);
    if (!Number.isFinite(n)) {
        throw new HarnessError(`${what} must be a finite number, got ${JSON.stringify(v)}`, HarnessErrorCode.BAD_ARGS);
    }
    return n | 0;
}

function pressAndRelease(im: any, x: number, y: number, button: number, holdMs: number): void {
    const armed = pendingRelease.get(button);
    if (armed !== undefined) { clearTimeout(armed); pendingRelease.delete(button); }
    im.injectMoveAtScreen(x, y);
    im.injectButtonAtScreen(x, y, button, true);
    pendingRelease.set(button, setTimeout(() => {
        pendingRelease.delete(button);
        try { im.injectButtonAtScreen(x, y, button, false); } catch { /* torn down */ }
    }, Math.max(1, holdMs)));
}

export function applyInput(cmd: string, args: unknown[]): any {
    const im = input();
    switch (cmd) {
        case "click": {
            const found = findDlgControl(args[0] as string | number);
            if (!found) throw new HarnessError(`no control matching ${JSON.stringify(args[0])}`, HarnessErrorCode.NOT_FOUND);
            const c = describeDlgControl(found.hwnd, found.win);
            // Press with DURATION, for the reason spelled out on clickAt below — a click by
            // label is the same gesture as a click by coordinate and must not differ in timing.
            pressAndRelease(im, c.cx, c.cy, 0, CLICK_HOLD_MS);
            return { ok: true, ...c, ...pointerPosture(im) };
        }
        case "clickAt": {
            // A click has DURATION. Pressing and releasing inside one JS turn gives the guest
            // a press that occupies no guest time at all: the input layer's latch guarantees a
            // level-polling API still observes it (input-manager consumeMouseButtonLatch), but
            // a UI state machine that samples the button on its own slower tick can still be
            // between samples for the whole press — exactly as a 0 ms click would be on real
            // hardware. So release on a timer, like clickHold, just with a short human default.
            const x = coord(args[0], "clickAt x"), y = coord(args[1], "clickAt y");
            pressAndRelease(im, x, y, 0, CLICK_HOLD_MS);
            return { ok: true, x, y, holdMs: CLICK_HOLD_MS, ...pointerPosture(im) };
        }
        case "clickHold": {
            // Press and HOLD the button for `holdMs` of wall-clock, then release on a
            // timer. injectClickAtScreen fires down→up in one synchronous tick, so a
            // guest that polls BUTTON STATE (DInput / GetAsyncKeyState) at a low frame
            // rate never observes the held-down frame and drops the click. Holding
            // across real frames lets the guest's poll loop see the button down.
            const x = coord(args[0], "clickHold x"), y = coord(args[1], "clickHold y");
            const holdMs = Number(args[2] ?? 200) | 0;
            const button = Number(args[3] ?? 0) | 0;
            pressAndRelease(im, x, y, button, holdMs);
            return { ok: true, x, y, holdMs, button, ...pointerPosture(im) };
        }
        case "move": {
            const x = coord(args[0], "move x"), y = coord(args[1], "move y");
            return { ok: im.injectMoveAtScreen(x, y), x, y, ...pointerPosture(im) };
        }
        case "moveRelative": {
            // Raw relative motion — mouse-look, and the primitive aimCursor is built from.
            const dx = coord(args[0], "moveRelative dx"), dy = coord(args[1], "moveRelative dy");
            return { ok: im.injectPointerDelta(dx, dy), dx, dy, ...pointerPosture(im) };
        }
        case "drag": {
            const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => coord(args[i], `drag coord ${i}`));
            const button = Number(args[4] ?? 0) | 0;
            return { ok: im.injectDragAtScreen(x0, y0, x1, y1, button ?? 0), from: [x0, y0], to: [x1, y1] };
        }
        case "wheel": {
            const x = coord(args[0], "wheel x"), y = coord(args[1], "wheel y"), delta = coord(args[2], "wheel delta");
            return { ok: im.injectWheelAtScreen(x, y, delta), x, y, delta };
        }
        case "key": {
            const vk = toVk(args[0] as number | string);
            const opts = (args[1] ?? {}) as { down?: boolean; up?: boolean };
            let ok = true;
            if (opts.down && !opts.up) ok = im.injectKey(vk, true);
            else if (opts.up && !opts.down) ok = im.injectKey(vk, false);
            else ok = im.injectKeyTap(vk);
            return { ok, vk };
        }
        case "padPlug": {
            // Drives the SAB pad-present slot through poll(), so the arrival/removal
            // edge, WM_DEVICECHANGE and the DirectInput lost-state take the real path.
            // announced=false means this was the first observation of the slot (seeded,
            // not an edge) — plug the opposite level first to get an event.
            const connected = args[0] === undefined ? true : Boolean(args[0]);
            const r = im.injectGamepadPresence(connected);
            if (!r.ok) throw new HarnessError("no input buffer connected (SAB not wired)", HarnessErrorCode.UNSUPPORTED);
            // `listeners` answers which mechanism this title uses: empty means it can
            // only ever see the DBT_DEVNODES_CHANGED broadcast.
            return { ...r, listeners: getDeviceNotifications() };
        }
        case "type": {
            const text = String(args[0] ?? "");
            let count = 0, skipped = 0;
            for (const ch of text) {
                const k = charToKey(ch);
                if (!k) { skipped++; continue; }
                if (k.shift) im.injectKey(0x10, true);
                im.injectKeyTap(k.vk);
                if (k.shift) im.injectKey(0x10, false);
                count++;
            }
            return { ok: true, typed: count, skipped };
        }
        default:
            throw new HarnessError(`not an input command: ${cmd}`, HarnessErrorCode.BAD_ARGS);
    }
}

export function registerInputCommands(svc: HarnessService): void {
    // Recordable input verbs: apply + (if recording) capture with a present-frame stamp.
    for (const cmd of RECORDABLE_INPUT) {
        svc.register(cmd, (args) => {
            const r = applyInput(cmd, args);
            recorder.note(cmd, args);
            return r;
        });
    }

    // clickHold(x, y, holdMs?, button?) — press, hold across wall-clock, release.
    // Not recordable (timer-based release); for driving low-fps state-polling menus.
    svc.register("clickHold", (args) => applyInput("clickHold", args));

    // clickHere(holdMs?, button?) — press WITHOUT moving, at the pointer's own published
    // position. The click half of driving a relative cursor: once moveRelative has put the
    // guest's cursor on the item, any coordinate we could pass to clickAt/clickHold injects
    // one more delta and drags it back off before the press lands.
    svc.register("clickHere", (args) => {
        const im = input();
        const holdMs = Number(args[0] ?? 200) | 0;
        const button = Number(args[1] ?? 0) | 0;
        const at = im.getPublishedPointer();
        pressAndRelease(im, at.x, at.y, button, holdMs);
        return { ok: true, at, holdMs, button, ...pointerPosture(im) };
    });

    // keyHold(vk, holdMs?) — keyboard twin of clickHold: press, hold across real
    // frames, release on a timer. A synchronous key tap (down+up in one tick) is
    // INVISIBLE to guests that poll key state at low frame rates (DirectInput /
    // GetAsyncKeyState) — NFSU menus never see it. Not recordable (timer release).
    svc.register("keyHold", (args) => {
        const im = input();
        const vk = toVk(args[0] as number | string);
        const holdMs = Number(args[1] ?? 350) | 0;
        const ok = im.injectKey(vk, true);
        setTimeout(() => { try { im.injectKey(vk, false); } catch { /* torn down */ } }, Math.max(1, holdMs));
        return { ok, vk, holdMs };
    });

    // inputTrace(action) — sniff what the GUEST actually reads from the input layer:
    // buffered DInput drains (mouse/keyboard), immediate wheel consumption (lZ),
    // mouse-button transitions and pressed-VK set changes. Wraps the InputManager
    // methods on demand (zero cost when off); entries accumulate in a capped ring.
    // Born from the MP wheel-scale bug (DIMOFS_Z=12000): the drain trace showed the
    // bogus value in one look where code review of clean-looking paths did not.
    // Actions: "start" | "stop" | "read" (returns + keeps) | "clear".
    svc.register("inputTrace", (args) => {
        const action = String(args[0] ?? "read");
        const im = input();
        const MAX = 2000;
        type Probe = {
            entries: any[];
            originals: Record<string, (...a: unknown[]) => unknown>;
            lastButtons: number;
            lastVkSig: string;
        };
        let probe: Probe | undefined = im.__inputTraceProbe;

        if (action === "start") {
            if (probe) return { ok: true, already: true, entries: probe.entries.length };
            probe = { entries: [], originals: {}, lastButtons: -1, lastVkSig: "" };
            im.__inputTraceProbe = probe;
            const push = (e: Record<string, unknown>): void => {
                if (probe!.entries.length >= MAX) probe!.entries.shift();
                probe!.entries.push({ t: performance.now() | 0, ...e });
            };
            const wrapDrain = (name: string, kind: string): void => {
                probe!.originals[name] = im[name].bind(im);
                im[name] = (n: number) => {
                    const evs = probe!.originals[name](n) as Array<{ dwOfs: number; dwData: number }>;
                    if (evs.length) push({ k: kind, evs: evs.map((e) => ({ ofs: e.dwOfs, d: e.dwData })) });
                    return evs;
                };
            };
            wrapDrain("drainDInputMouseEvents", "drainMouse");
            wrapDrain("drainDInputKeyboardEvents", "drainKeyboard");
            wrapDrain("drainDInputGamepadEvents", "drainGamepad");
            probe.originals.consumeDInputWheel = im.consumeDInputWheel.bind(im);
            im.consumeDInputWheel = () => {
                const v = probe!.originals.consumeDInputWheel() as number;
                if (v) push({ k: "wheelConsume", v });
                return v;
            };
            probe.originals.getMouseState = im.getMouseState.bind(im);
            im.getMouseState = () => {
                const s = probe!.originals.getMouseState() as { buttons: number };
                if (s.buttons !== probe!.lastButtons) {
                    probe!.lastButtons = s.buttons;
                    push({ k: "buttons", buttons: s.buttons });
                }
                return s;
            };
            // The latched read is what a level-polling guest actually observes; without it
            // a trace shows getMouseState()'s level and misses every sub-poll press.
            probe.originals.consumeMouseButtonLatch = im.consumeMouseButtonLatch.bind(im);
            im.consumeMouseButtonLatch = () => {
                const v = probe!.originals.consumeMouseButtonLatch() as number;
                if (v) push({ k: "latchRead", buttons: v }); // 0 is every quiet frame — noise
                return v;
            };
            probe.originals.getKeyboardStateVk = im.getKeyboardStateVk.bind(im);
            im.getKeyboardStateVk = (target?: Uint8Array) => {
                const ks = probe!.originals.getKeyboardStateVk(target) as Uint8Array;
                const pressed: number[] = [];
                for (let vk = 0; vk < 256; vk++) if (ks[vk]) pressed.push(vk);
                const sig = pressed.join(",");
                if (sig !== probe!.lastVkSig) {
                    probe!.lastVkSig = sig;
                    push({ k: "keys", vks: pressed });
                }
                return ks;
            };
            return { ok: true, started: true };
        }
        if (action === "stop") {
            if (!probe) return { ok: true, already: true };
            for (const [name, fn] of Object.entries(probe.originals)) im[name] = fn;
            const entries = probe.entries;
            delete im.__inputTraceProbe;
            return { ok: true, stopped: true, entries };
        }
        if (action === "clear") {
            if (probe) probe.entries.length = 0;
            return { ok: true };
        }
        return { ok: true, active: !!probe, entries: probe ? probe.entries : [] };
    });

    /** dinputDiag() — buffered queues, the immediate-mouse handoff counters, and the
     *  produced-event trail. Read this instead of snapshotting the guest's own
     *  DIMOUSESTATE: the guest polls at frame rate and takes the motion on its first
     *  read, so a later look at that struct sees only the zeros after it. */
    svc.register("dinputDiag", () => input().getDInputDiagnostics());

    /** dialogs() — enumerate all windows/controls with GLOBAL coords (read-only). */
    svc.register("dialogs", () => {
        const out = [];
        for (const [hwnd, w] of windows) out.push(describeDlgControl(hwnd, w));
        return out;
    });

    /**
     * controlState(target) — what a JS-managed system control currently HOLDS:
     * check state, selection, scroll position, thumb position, focus.
     *
     * The click half of a UI bug is visible in a screenshot; the state half is not,
     * and reading pixels to decide whether a listbox moved its selection or a
     * scrollbar its pos is exactly the kind of inference that mis-models. This is the
     * readout `.click(x).expect(...)` needs to judge a control generically.
     */
    svc.register("controlState", (args) => {
        const found = findDlgControl(args[0] as string | number);
        if (!found) throw new HarnessError(`no control matching ${JSON.stringify(args[0])}`, HarnessErrorCode.NOT_FOUND);
        const { hwnd, win } = found;
        const cls = (win.systemControlClass ?? "").trim().toLowerCase();
        const WS_DISABLED = 0x08000000;
        const out: Record<string, unknown> = {
            ...describeDlgControl(hwnd, win),
            enabled: (win.style & WS_DISABLED) === 0,
            focused: sys().windowManager?.getFocusHwnd?.() === hwnd,
        };
        if (buttonCheckStates.has(hwnd)) out.check = buttonCheckStates.get(hwnd);
        const list = listControlStates.get(hwnd);
        if (list) {
            out.sel = list.selectedIndex;
            out.caret = list.caretIndex;
            out.topIndex = list.topIndex;
            out.count = list.items.length;
            out.selText = list.items[list.selectedIndex]?.text ?? null;
            if (cls === "combobox") {
                out.dropdownOpen = !!list.dropdownOpen;
                // The drop-down is not a window, so `dialogs` cannot show where it is —
                // and a click aimed at its list or its scroll bar has nothing else to aim by.
                out.dropRect = getComboDropdownRect(win);
            }
        }
        const lv = getListViewState(hwnd);
        if (lv) {
            const LVIS_SELECTED = 2;
            out.topIndex = lv.topIndex;
            out.count = lv.items.length;
            out.focusedItem = lv.focusedItem;
            out.selected = lv.items
                .map((it, i) => ((it.state & LVIS_SELECTED) ? i : -1))
                .filter((i) => i >= 0);
        }
        const tb = trackbarStates.get(hwnd);
        if (tb) out.trackbar = { pos: tb.pos, min: tb.min, max: tb.max };
        // An edit's laid-out lines and scroll position: the half of "is the text
        // right?" that pixels cannot answer (a wrapped line count, a scrolled view).
        if (cls === "edit" || cls === "richedit") out.edit = describeEditLayout(win);
        if (cls === "scrollbar") out.scroll = getScrollBarState(hwnd, SB_CTL);
        else {
            const h = getScrollBarState(hwnd, SB_HORZ), v = getScrollBarState(hwnd, SB_VERT);
            if (h.max !== h.min || v.max !== v.min) out.scroll = { horz: h, vert: v };
        }
        return out;
    });

    /**
     * hitTest(x, y) — the two answers a click depends on, side by side.
     *
     * `windowFromPoint` is the window a mouse message is ADDRESSED to; `control` is what
     * the container hit-test then finds under the same point and runs the class behaviour
     * for. They are normally the same window, and when they are not the click still
     * "works" for every control WE drive — while a control the guest SUBCLASSED never
     * receives a message at all, because the guest's proc is only reached through the
     * address. That asymmetry is invisible in pixels and in `dialogs`.
     */
    svc.register("hitTest", (args) => {
        const x = Number(args[0]) | 0, y = Number(args[1]) | 0;
        const wm = sys().windowManager as any;
        const at = wm?.windowFromPoint?.(x, y) >>> 0;
        const addressed = at ? windows.get(at) : undefined;
        // The class behaviour is hit-tested over a CONTAINER's subtree (message.ts
        // resolves a leaf control up to its parent), so mirror that resolution here.
        const host = (addressed && addressed.children.length === 0 && addressed.isSystemControl
            && addressed.parent) ? addressed.parent : at;
        const control = host ? hitTestSystemControlAtScreenPoint(host, x, y) : undefined;
        return {
            at: [x, y],
            windowFromPoint: at,
            addressed: addressed ? describeDlgControl(at, addressed) : null,
            host,
            control: control ? describeDlgControl(control.handle, control) : null,
            /** A subclassed control only ever sees the mouse through the address. */
            subclassed: !!control?.wndProcSubclassed,
            agrees: !!control && control.handle === at,
            capture: sys().windowManager?.getCaptureHwnd?.() ?? 0,
        };
    });

    /** findControl(target) — resolve a control selector to its described row, or null. */
    svc.register("findControl", (args) => {
        const found = findDlgControl(args[0] as string | number);
        return found ? describeDlgControl(found.hwnd, found.win) : null;
    });

    /**
     * waitForControl(target, {timeoutMs, pollMs, visible}) — block until a control
     * exists (and is visible unless told otherwise), then describe it.
     *
     * The gate a front-end bring-up actually wants. `tickFrames` cannot serve: a Win32
     * front-end runs its dialogs BEFORE the render device presents anything, so waiting
     * on presents there waits forever and reads exactly like a hang. Throws NOT_FOUND on
     * timeout so a chain aborts at the real cause instead of clicking into empty space.
     */
    svc.register("waitForControl", async (args, ctx) => {
        const target = args[0] as string | number;
        const opts = (args[1] ?? {}) as { timeoutMs?: number; pollMs?: number; visible?: boolean };
        const needVisible = opts.visible !== false;
        const pollMs = Math.max(1, opts.pollMs ?? 100);
        const t0 = performance.now();
        const deadline = t0 + (opts.timeoutMs ?? 120_000);
        for (;;) {
            const found = findDlgControl(target);
            if (found && (!needVisible || found.win.visible)) {
                return { ...describeDlgControl(found.hwnd, found.win), waitedMs: performance.now() - t0 };
            }
            if (performance.now() > deadline) {
                throw new HarnessError(
                    `waitForControl: '${String(target)}' not ${needVisible ? "visible" : "present"} ` +
                    `after ${Math.round(performance.now() - t0)}ms`,
                    HarnessErrorCode.NOT_FOUND);
            }
            if (ctx.signal.aborted) throw ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED);
            await new Promise((r) => setTimeout(r, pollMs));
        }
    });
}
