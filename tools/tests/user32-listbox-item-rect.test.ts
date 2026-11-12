import { beforeEach, describe, expect, test } from "bun:test";
import "../../src/worker/modules/user32/index";
import { windows, getOrCreateListState, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { handleSystemControlMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import { LIST_ITEM_H } from "../../src/worker/modules/user32/controls";
import { System } from "../../src/worker/core/system";

const LB_ADDSTRING = 0x0180;
const LB_SETCURSEL = 0x0186;
const LB_GETSEL = 0x0187;
const LB_GETITEMRECT = 0x0198;
const LB_ERR = 0xffffffff;
const LIST = 0x3001;
const RECT_AT = 0x100;

function listbox(cls: string): WindowInfo {
    return {
        handle: LIST, title: "", style: 0x50000151, exStyle: 4, x: 33, y: 293, width: 336, height: 84,
        children: [], visible: true, wndProc: 0, parent: 0x3000,
        isSystemControl: true, systemControlClass: cls, nativeClassName: cls,
    } as WindowInfo;
}

const mem = new Uint8Array(0x400);
const strAt = (at: number, s: string): number => { mem.set(new TextEncoder().encode(s + "\0"), at); return at; };
const rect = (): number[] => {
    const v = new DataView(mem.buffer);
    return [0, 4, 8, 12].map((o) => v.getInt32(RECT_AT + o, true));
};

beforeEach(() => {
    windows.clear();
    mem.fill(0);
});

describe("a list box answers the item queries an owner-drawn list paints from", () => {
    test("LB_GETITEMRECT gives each row's client rect and LB_GETSEL the selected row", () => {
        windows.set(LIST, listbox("ListBox"));
        const lb = windows.get(LIST)!;
        handleSystemControlMessage(lb, LB_ADDSTRING, 0, strAt(0x200, "GDI"), mem);
        handleSystemControlMessage(lb, LB_ADDSTRING, 0, strAt(0x240, "Nod"), mem);
        handleSystemControlMessage(lb, LB_SETCURSEL, 1, 0, mem);
        expect(handleSystemControlMessage(lb, LB_GETITEMRECT, 1, RECT_AT, mem)).toBe(1);
        expect(rect()).toEqual([0, LIST_ITEM_H, 336, 2 * LIST_ITEM_H]);
        expect(handleSystemControlMessage(lb, LB_GETSEL, 1, 0, mem)).toBe(1);
        expect(handleSystemControlMessage(lb, LB_GETSEL, 0, 0, mem)).toBe(0);
        expect(handleSystemControlMessage(lb, LB_GETITEMRECT, 5, RECT_AT, mem)).toBe(LB_ERR);
    });

    test("negative control: a non-listbox control leaves the rect untouched", () => {
        windows.set(LIST, listbox("Static"));
        const st = windows.get(LIST)!;
        getOrCreateListState(LIST).items.push({ text: "x", data: 0 });
        expect(handleSystemControlMessage(st, LB_GETITEMRECT, 0, RECT_AT, mem)).toBe(0);
        expect(rect()).toEqual([0, 0, 0, 0]);
    });

    test("an LB_GETITEMRECT whose rect pointer is not mapped answers LB_ERR and writes nothing", () => {
        windows.set(LIST, listbox("ListBox"));
        const lb = windows.get(LIST)!;
        handleSystemControlMessage(lb, LB_ADDSTRING, 0, strAt(0x200, "GDI"), mem);
        const system = System.getInstance() as unknown as { process: unknown };
        const saved = system.process;
        system.process = { addressSpace: { validateRange: (a: number, n: number) => a + n <= mem.length } };
        try {
            expect(handleSystemControlMessage(lb, LB_GETITEMRECT, 0, mem.length - 8, mem)).toBe(LB_ERR);
            expect([...mem.subarray(mem.length - 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        } finally {
            system.process = saved;
        }
    });
});
