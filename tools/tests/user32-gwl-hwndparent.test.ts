import { beforeEach, describe, expect, test } from "bun:test";
import "../../src/worker/modules/user32/index";
import { registerWindowPropExports } from "../../src/worker/modules/user32/window-props";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";

const GWL_HWNDPARENT = -8;
const DLG = 0x4000;
const CTRL = 0x4001;

function win(over: Partial<WindowInfo> & { handle: number }): WindowInfo {
    return { title: "", style: 0, x: 0, y: 0, width: 10, height: 10, children: [], visible: true, wndProc: 0, ...over } as WindowInfo;
}

const exportsTable: Record<string, (ctx: unknown, mem: Uint8Array, args: number[]) => number> = {};
registerWindowPropExports(exportsTable as never);
const getLong = (hwnd: number, index: number): number =>
    exportsTable["GetWindowLongA"]({ esp: 0 }, new Uint8Array(16), [hwnd, index >>> 0]) >>> 0;

beforeEach(() => {
    windows.clear();
    windows.set(DLG, win({ handle: DLG, style: 0x50000040, children: [CTRL] }));
    windows.set(CTRL, win({ handle: CTRL, parent: DLG, style: 0x50000000, isSystemControl: true, systemControlClass: "Button" }));
});

const setLong = (hwnd: number, index: number, value: number): number =>
    exportsTable["SetWindowLongA"]({ esp: 0 }, new Uint8Array(16), [hwnd, index >>> 0, value >>> 0]) >>> 0;

describe("SetWindowLong(GWL_STYLE) and WS_VISIBLE", () => {
    test("setting WS_VISIBLE on a hidden control makes it visible", () => {
        const ctrl = windows.get(CTRL)!;
        ctrl.style = 0x4000000b;
        ctrl.visible = false;
        setLong(CTRL, -16, 0x5000000b);
        expect(ctrl.visible).toBe(true);
    });

    test("negative control: a style change that leaves WS_VISIBLE alone keeps visibility", () => {
        const ctrl = windows.get(CTRL)!;
        ctrl.style = 0x4000000b;
        ctrl.visible = false;
        setLong(CTRL, -16, 0x4000000c);
        expect(ctrl.visible).toBe(false);
    });
});

describe("GetWindowLong(GWL_HWNDPARENT)", () => {
    test("a child reports its parent, so GetWindowRect on it succeeds", () => {
        expect(getLong(CTRL, GWL_HWNDPARENT)).toBe(DLG);
    });

    test("negative control: a window without parent or owner reports 0", () => {
        expect(getLong(DLG, GWL_HWNDPARENT)).toBe(0);
    });
});
