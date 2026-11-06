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

describe("GetWindowLong(GWL_HWNDPARENT)", () => {
    test("a child reports its parent, so GetWindowRect on it succeeds", () => {
        expect(getLong(CTRL, GWL_HWNDPARENT)).toBe(DLG);
    });

    test("negative control: a window without parent or owner reports 0", () => {
        expect(getLong(DLG, GWL_HWNDPARENT)).toBe(0);
    });
});
