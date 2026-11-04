// On-screen movement → what the GUEST sees.
//
// The Hitman: Codename 47 report ("the stick and the on-screen arrows do nothing") was
// not a transport bug: the stick pressed W/A/S/D and the keyboard sheet the arrows, and
// that title walks on Numpad 8/2/4/6. These pin both halves of the fix — the movement
// control can be pointed at any of the three clusters, and each cluster reaches the
// guest as the physical key a real keyboard would report: VK, set-1 scan code, the
// extended bit (lParam bit 24: arrows yes, numpad no) and the DirectInput DIK code.

import { beforeEach, describe, expect, test } from "bun:test";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import { INPUT_BUFFER_SIZE } from "../../src/input/sab-layout";
import { inputDevice } from "../../src/input/virtual-device";
import { BindingPresser } from "../../src/input/controls/press";
import { TAP_HOLD_MS } from "../../src/input/touch/gestures";
import {
    MOVE_KEY_SETS, layoutMoveKeys, moveKeysOf, withMoveKeys,
} from "../../src/input/controls/move-keys";
import { PRESET_IDS, getPreset } from "../../src/input/controls/presets";
import { resolveRects, type ControlLayout } from "../../src/input/controls/types";

const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101;

interface Posted { msg: number; wParam: number; lParam: number }

/** Just enough window manager for poll() to route keystrokes to one focused window. */
function rig() {
    const posted: Posted[] = [];
    const win = { hwnd: 0x10001, rect: { x: 0, y: 0, width: 640, height: 480 }, visible: true };
    const wm = {
        getKeyboardTargetWindow: () => win,
        getMouseTargetWindow: () => win,
        getCaptureHwnd: () => 0,
        getWindow: () => win,
        getTopLevelAncestor: () => win.hwnd,
        getActiveHwnd: () => win.hwnd,
        setActiveWindow: () => { },
        postMessage: (_h: number, msg: number, wParam: number, lParam: number) => {
            posted.push({ msg, wParam, lParam: lParam >>> 0 });
        },
    };
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const im = new InputManager(wm as never);
    im.setInputBuffer(sab);
    inputDevice.releaseAllSources();
    inputDevice.attach(new Int32Array(sab), () => { });
    inputDevice.commit({ immediate: true });
    im.poll();
    posted.length = 0;
    const keys = () => posted.filter((p) => p.msg === WM_KEYDOWN || p.msg === WM_KEYUP);
    return { im, posted, keys };
}

const press = (vk: number, down: boolean, source: "widget" | "osk" = "widget") => {
    inputDevice.setKey(vk, down, source);
    inputDevice.commit({ immediate: true });
};

beforeEach(() => inputDevice.releaseAllSources());

describe("each movement cluster is the physical key a real keyboard reports", () => {
    // [vk, set-1 make code, extended, DIK]
    const CASES: Record<string, [number, number, boolean, number][]> = {
        arrows: [[0x26, 0x48, true, 0xc8], [0x28, 0x50, true, 0xd0], [0x25, 0x4b, true, 0xcb], [0x27, 0x4d, true, 0xcd]],
        numpad: [[0x68, 0x48, false, 0x48], [0x62, 0x50, false, 0x50], [0x64, 0x4b, false, 0x4b], [0x66, 0x4d, false, 0x4d]],
        wasd: [[0x57, 0x11, false, 0x11], [0x53, 0x1f, false, 0x1f], [0x41, 0x1e, false, 0x1e], [0x44, 0x20, false, 0x20]],
    };

    for (const [name, rows] of Object.entries(CASES)) {
        test(`${name}: WM_KEYDOWN/UP carry the VK, the scan code and the extended bit`, () => {
            const r = rig();
            for (const [vk, scan, ext] of rows) {
                press(vk, true);
                r.im.poll();
                press(vk, false);
                r.im.poll();
                const [dn, upEv] = r.keys().splice(-2);
                const extBit = ext ? 0x01000000 : 0;
                expect(dn).toEqual({ msg: WM_KEYDOWN, wParam: vk, lParam: (1 | (scan << 16) | extBit) >>> 0 });
                expect(upEv).toEqual({ msg: WM_KEYUP, wParam: vk, lParam: (1 | (scan << 16) | extBit | 0xc0000000) >>> 0 });
                expect(r.im.getKeyState(vk) & 0x8000).toBe(0);
            }
        });

        test(`${name}: DirectInput buffered keyboard reports the DIK code`, () => {
            const r = rig();
            r.im.setDInputKeyboardBufferSize(32);
            r.im.baselineDInputKeyboard();
            for (const [vk, , , dik] of rows) {
                press(vk, true);
                r.im.poll();
                expect(r.im.getKeyState(vk) & 0x8000).toBe(0x8000);
                press(vk, false);
                r.im.poll();
                const evs = r.im.drainDInputKeyboardEvents(8);
                expect(evs.map((e) => [e.dwOfs, e.dwData])).toEqual([[dik, 0x80], [dik, 0]]);
            }
        });
    }

    test("the on-screen numpad 8 and the arrow up are DIFFERENT keys to the guest", () => {
        const r = rig();
        press(0x68, true, "osk");
        r.im.poll();
        expect(r.im.getKeyState(0x68) & 0x8000).toBe(0x8000);
        expect(r.im.getKeyState(0x26) & 0x8000).toBe(0);
    });
});

describe("withMoveKeys retargets the movement control, and only that", () => {
    test("every preset's key cluster follows the choice in both orientations", () => {
        for (const id of PRESET_IDS) {
            for (const o of ["landscape", "portrait"] as const) {
                const base = getPreset(id, o);
                for (const k of ["wasd", "arrows", "numpad"] as const) {
                    const l = withMoveKeys(base, k);
                    for (const w of l.widgets) {
                        if (w.kind === "dpad" || (w.kind === "stick" && w.out === "keys")) {
                            expect(moveKeysOf(w.binds)).toBe(k);
                        }
                    }
                    if (layoutMoveKeys(base) !== null) expect(layoutMoveKeys(l)).toBe(k);
                }
            }
        }
    });

    test("the stick of the Move+Look layout presses Numpad 8 when Numpad is chosen", () => {
        const l = withMoveKeys(getPreset("wasd-look", "landscape"), "numpad");
        const stick = l.widgets.find((w) => w.id === "move");
        expect(stick?.kind === "stick" && stick.binds).toEqual(MOVE_KEY_SETS.numpad);
    });

    test("a custom direction set is the author's and is left alone", () => {
        const ijkl = {
            up: { t: "key", vk: 0x49 }, down: { t: "key", vk: 0x4b },
            left: { t: "key", vk: 0x4a }, right: { t: "key", vk: 0x4c },
        } as const;
        const l: ControlLayout = {
            id: "c", name: "c", version: 1,
            widgets: [{ kind: "dpad", id: "d", rect: { anchor: "bl", x: 0, y: 0, w: 0.3, h: 0.3 }, binds: ijkl }],
        };
        expect(withMoveKeys(l, "numpad")).toBe(l);
    });

    test("no change is identity (no re-render, no release of held keys)", () => {
        const base = getPreset("wasd-look", "landscape");
        expect(withMoveKeys(base, "wasd")).toBe(base);
        expect(withMoveKeys(base, null)).toBe(base);
    });
});

describe("levels from two thumbs are independent and nothing stays latched", () => {
    test("stick held + Fire tapped: releasing Fire keeps the stick's key down", async () => {
        const r = rig();
        const p = new BindingPresser("widget");
        p.set("move:u", { t: "key", vk: 0x68 }, true);
        p.set("fire", { t: "mouse", button: 0 }, true);
        p.commit();
        r.im.poll();
        expect(r.im.getKeyState(0x68) & 0x8000).toBe(0x8000);
        p.set("fire", { t: "mouse", button: 0 }, false);
        await Bun.sleep(TAP_HOLD_MS + 20);
        r.im.poll();
        expect(r.im.getMouseState().buttons & 1).toBe(0);
        expect(r.im.getKeyState(0x68) & 0x8000).toBe(0x8000);
        p.releaseAll();
        r.im.poll();
        expect(r.im.getKeyState(0x68) & 0x8000).toBe(0);
    });

    test("a direction swap releases the old key before pressing the new one", () => {
        const r = rig();
        const p = new BindingPresser("widget");
        p.set("move:u", { t: "key", vk: 0x57 }, true);
        p.commit();
        r.im.poll();
        // The same slot re-bound (the player switched WASD → Numpad mid-hold).
        p.set("move:u", { t: "key", vk: 0x68 }, true);
        p.commit();
        r.im.poll();
        expect(r.im.getKeyState(0x57) & 0x8000).toBe(0);
        expect(r.im.getKeyState(0x68) & 0x8000).toBe(0x8000);
        p.releaseAll();
    });
});

describe("floating stick zone", () => {
    const stickLayout = (anchor: "bl" | "br"): ControlLayout => ({
        id: "f", name: "f", version: 1,
        widgets: [{
            kind: "stick", id: "s", out: "keys", binds: MOVE_KEY_SETS.wasd, float: true, recenter: true,
            rect: { anchor, x: 0.03, y: 0.06, w: 0.36, h: 0.36, region: "letterbox" },
        }],
    });

    test("landscape: the whole left bar is the hit zone, the drawing stays authored", () => {
        const panel = { left: 0, top: 0, width: 734, height: 330 };
        const canvas = { left: 147, top: 0, width: 440, height: 330 };
        const hit = resolveRects(stickLayout("bl"), panel, { canvas, floatZones: true });
        expect([...hit]).toEqual([0, 0, 147, 330]);
        const vis = resolveRects(stickLayout("bl"), panel, { canvas, minHitPx: 0 });
        expect(vis[2]).toBeCloseTo(0.36 * 330, 3);
    });

    test("portrait: the stick takes its half of the deck below the picture", () => {
        const panel = { left: 0, top: 0, width: 393, height: 716 };
        const canvas = { left: 0, top: 0, width: 393, height: 295 };
        const hit = resolveRects(stickLayout("bl"), panel, { canvas, floatZones: true });
        expect([...hit]).toEqual([0, 295, 196.5, 421]);
        const right = resolveRects(stickLayout("br"), panel, { canvas, floatZones: true });
        expect([...right]).toEqual([196.5, 295, 196.5, 421]);
    });

    test("no bar, no zone: a stick over the picture never claims half the screen", () => {
        const panel = { left: 0, top: 0, width: 800, height: 450 };
        const canvas = { left: 0, top: 0, width: 800, height: 450 };
        const hit = resolveRects(stickLayout("bl"), panel, { canvas, floatZones: true });
        expect(hit[2]).toBeCloseTo(0.36 * 450, 3);
    });
});

describe("preset geometry on an iPhone 15 Pro", () => {
    // The layer root inside the shell: landscape 734x330 (59pt insets left/right, top bar,
    // home indicator), portrait 393x716 with the picture pinned to the top.
    const SCREENS = {
        landscape: { panel: { left: 0, top: 0, width: 734, height: 330 }, canvas: { left: 147, top: 0, width: 440, height: 330 } },
        portrait: { panel: { left: 0, top: 0, width: 393, height: 716 }, canvas: { left: 0, top: 0, width: 393, height: 295 } },
    } as const;
    // Half a pixel of slack: the gamepad's face diamond is authored corner-to-corner.
    const E = 0.5;
    const overlaps = (a: number[], b: number[]) =>
        a[0] + E < b[0] + b[2] && b[0] + E < a[0] + a[2] && a[1] + E < b[1] + b[3] && b[1] + E < a[1] + a[3];

    for (const o of ["landscape", "portrait"] as const) {
        test(`${o}: no two drawn controls overlap, none covers the picture, all >= 44pt`, () => {
            const { panel, canvas } = SCREENS[o];
            for (const id of PRESET_IDS) {
                const l = getPreset(id, o);
                const vis = resolveRects(l, panel, { canvas, minHitPx: 0 });
                const hit = resolveRects(l, panel, { canvas });
                const drawn: { id: string; r: number[] }[] = [];
                l.widgets.forEach((w, i) => {
                    if (w.kind === "touchArea" || w.kind === "trackpad") return;
                    const r = [...vis.slice(i * 4, i * 4 + 4)];
                    drawn.push({ id: w.id, r });
                    const c = [canvas.left, canvas.top, canvas.width, canvas.height];
                    expect(`${id}/${w.id} over picture: ${overlaps(r, c)}`).toBe(`${id}/${w.id} over picture: false`);
                    expect(Math.min(hit[i * 4 + 2], hit[i * 4 + 3])).toBeGreaterThanOrEqual(44);
                });
                for (let a = 0; a < drawn.length; a++) {
                    for (let b = a + 1; b < drawn.length; b++) {
                        const tag = `${o} ${id}: ${drawn[a].id} x ${drawn[b].id}`;
                        expect(`${tag} ${overlaps(drawn[a].r, drawn[b].r)}`).toBe(`${tag} false`);
                    }
                }
            }
        });
    }
});

describe("reserved shell affordances", () => {
    test("the HUD in the far-right corner does not push a left-anchored button across the bar", () => {
        const l: ControlLayout = {
            id: "r", name: "r", version: 1,
            widgets: [{ kind: "button", id: "esc", bind: { t: "key", vk: 0x1b }, rect: { anchor: "tl", x: 0.03, y: 0.03, w: 0.15, h: 0.15 } }],
        };
        const panel = { left: 0, top: 0, width: 393, height: 716 };
        const hud = { left: 393 - 52, top: 8, width: 44, height: 44 };
        const r = resolveRects(l, panel, { reserved: [hud] });
        expect(r[0]).toBeLessThan(40);
    });

    test("...but still clears a right-anchored one out from under it", () => {
        const l: ControlLayout = {
            id: "r", name: "r", version: 1,
            widgets: [{ kind: "button", id: "x", bind: { t: "key", vk: 0x1b }, rect: { anchor: "tr", x: 0.02, y: 0.02, w: 0.15, h: 0.15 } }],
        };
        const panel = { left: 0, top: 0, width: 393, height: 716 };
        const hud = { left: 393 - 52, top: 8, width: 44, height: 44 };
        const r = resolveRects(l, panel, { reserved: [hud] });
        expect(r[0] + r[2]).toBeLessThanOrEqual(hud.left + 0.5);
    });
});
