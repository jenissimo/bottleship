/**
 * Listbox caret state, pinned to the NT5/Wine class-proc contract and the UE1
 * WListBox call pattern used by Harry Potter COS.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleSystemControlMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import {
    getOrCreateListState,
    listControlStates,
    type WindowInfo,
} from "../../src/worker/modules/user32/shared-state";

const LB_SETCURSEL = 0x0186;
const LB_SETCARETINDEX = 0x019e;
const LB_GETCARETINDEX = 0x019f;
const LB_ERR = 0xffffffff;

const mem = new Uint8Array(64);
const listbox: WindowInfo = {
    handle: 0x10017,
    title: "",
    style: 0,
    x: 0,
    y: 0,
    width: 160,
    height: 100,
    children: [],
    visible: true,
    wndProc: 0,
    isSystemControl: true,
    systemControlClass: "ListBox",
};

const send = (msg: number, wParam = 0, lParam = 0): number =>
    handleSystemControlMessage(listbox, msg, wParam, lParam, mem);

beforeEach(() => {
    listControlStates.clear();
    const state = getOrCreateListState(listbox.handle);
    state.items.push(
        { text: "640x480", data: 0 },
        { text: "800x600", data: 0 },
        { text: "1024x768", data: 0 },
    );
});

describe("ListBox LB_*CARETINDEX", () => {
    test("LB_SETCURSEL moves the caret read by UE1 WListBox::GetCurrent", () => {
        expect(send(LB_SETCURSEL, 1)).toBe(1);
        expect(send(LB_GETCARETINDEX)).toBe(1);
    });

    test("mouse-class state is exposed through LB_GETCARETINDEX", () => {
        const state = getOrCreateListState(listbox.handle);
        state.selectedIndex = 2;
        state.caretIndex = 2;
        expect(send(LB_GETCARETINDEX)).toBe(2);
    });

    test("single-select LB_SETCARETINDEX follows NT5 rejection rules", () => {
        expect(send(LB_SETCARETINDEX, 2)).toBe(0);
        expect(send(LB_GETCARETINDEX)).toBe(2);

        expect(send(LB_SETCURSEL, 1)).toBe(1);
        expect(send(LB_SETCARETINDEX, 2)).toBe(LB_ERR);
        expect(send(LB_GETCARETINDEX)).toBe(1);
    });
});
