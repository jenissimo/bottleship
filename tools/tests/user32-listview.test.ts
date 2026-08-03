/**
 * SysListView32 LVM_* contracts: A/W LVITEM, insert/get/set/delete, selection,
 * selected-count, hit-test, and posted WM_NOTIFY (NMLISTVIEW).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import {
    handleListViewMessage,
    isListViewContentMessage,
    resetListViewStatesForTests,
    getOrCreateListViewState,
    selectListViewAtIndex,
    hitTestListView,
    listViewSelectedCount,
    LVM_INSERTITEMA,
    LVM_INSERTITEMW,
    LVM_GETITEMA,
    LVM_GETITEMW,
    LVM_SETITEMA,
    LVM_GETITEMCOUNT,
    LVM_GETSELECTEDCOUNT,
    LVM_SETITEMSTATE,
    LVM_GETITEMSTATE,
    LVM_GETNEXTITEM,
    LVM_DELETEITEM,
    LVM_DELETEALLITEMS,
    LVM_INSERTCOLUMNA,
    LVM_SETIMAGELIST,
    LVM_SETEXTENDEDLISTVIEWSTYLE,
    LVM_GETEXTENDEDLISTVIEWSTYLE,
    LVM_SETSELECTIONMARK,
    LVM_GETSELECTIONMARK,
    LVM_HITTEST,
    LVIF_TEXT,
    LVIF_IMAGE,
    LVIF_PARAM,
    LVIF_STATE,
    LVIS_SELECTED,
    LVIS_FOCUSED,
    LVNI_SELECTED,
    LVCF_TEXT,
    LVCF_WIDTH,
    LVS_REPORT,
    LVS_SINGLESEL,
    MK_CONTROL,
    WM_NOTIFY,
    LVN_ITEMCHANGED,
    NM_CLICK,
    postListViewClickNotify,
} from "../../src/worker/modules/user32/list-view-control";
import { isContentChangingMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import type { WindowInfo } from "../../src/worker/modules/user32/shared-state";

const mem = new Uint8Array(0x8000);
const view = new DataView(mem.buffer);

let nextHandle = 0x20000;
function lv(style = LVS_REPORT | LVS_SINGLESEL): WindowInfo {
    return {
        handle: nextHandle++,
        title: "",
        style,
        x: 0,
        y: 0,
        width: 240,
        height: 120,
        children: [],
        visible: true,
        wndProc: 0,
        isSystemControl: true,
        systemControlClass: "SysListView32",
        controlId: 1002,
        parent: 0x10001,
    };
}

const send = (win: WindowInfo, msg: number, wParam = 0, lParam = 0): number | null => {
    Mem.bind(() => mem);
    return handleListViewMessage(win, msg, wParam, lParam, mem);
};

function putAnsi(at: number, s: string): number {
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
    return at;
}

function putWide(at: number, s: string): number {
    for (let i = 0; i < s.length; i++) {
        mem[at + i * 2] = s.charCodeAt(i) & 0xFF;
        mem[at + i * 2 + 1] = 0;
    }
    mem[at + s.length * 2] = 0;
    mem[at + s.length * 2 + 1] = 0;
    return at;
}

/** Write LVITEMA V1 at `ptr`; text lives at textPtr. */
function writeLvItemA(
    ptr: number,
    opts: {
        mask: number;
        iItem?: number;
        iSubItem?: number;
        state?: number;
        stateMask?: number;
        textPtr?: number;
        cchTextMax?: number;
        iImage?: number;
        lParam?: number;
    },
): number {
    view.setUint32(ptr, opts.mask, true);
    view.setInt32(ptr + 4, opts.iItem ?? 0, true);
    view.setInt32(ptr + 8, opts.iSubItem ?? 0, true);
    view.setUint32(ptr + 12, opts.state ?? 0, true);
    view.setUint32(ptr + 16, opts.stateMask ?? 0, true);
    view.setUint32(ptr + 20, opts.textPtr ?? 0, true);
    view.setInt32(ptr + 24, opts.cchTextMax ?? 0, true);
    view.setInt32(ptr + 28, opts.iImage ?? -1, true);
    view.setUint32(ptr + 32, opts.lParam ?? 0, true);
    return ptr;
}

function writeLvItemW(
    ptr: number,
    opts: {
        mask: number;
        iItem?: number;
        iSubItem?: number;
        state?: number;
        stateMask?: number;
        textPtr?: number;
        cchTextMax?: number;
        iImage?: number;
        lParam?: number;
    },
): number {
    return writeLvItemA(ptr, opts);
}

function writeLvColumnA(ptr: number, textPtr: number, cx: number, text: string): number {
    putAnsi(textPtr, text);
    view.setUint32(ptr, LVCF_TEXT | LVCF_WIDTH, true);
    view.setInt32(ptr + 4, 0, true);
    view.setInt32(ptr + 8, cx, true);
    view.setUint32(ptr + 12, textPtr, true);
    view.setInt32(ptr + 16, 64, true);
    view.setInt32(ptr + 20, 0, true);
    return ptr;
}

beforeEach(() => {
    mem.fill(0);
    resetListViewStatesForTests();
    Mem.bind(() => mem);
});

describe("ListView insert/get A/W", () => {
    test("LVM_INSERTITEMA stores text/image/param and LVM_GETITEMA reads them back", () => {
        const win = lv();
        const textPtr = putAnsi(0x1000, "Gothic");
        const itemPtr = writeLvItemA(0x1100, {
            mask: LVIF_TEXT | LVIF_IMAGE | LVIF_PARAM,
            iItem: 0,
            textPtr,
            iImage: 3,
            lParam: 0xABCDEF01,
        });
        expect(send(win, LVM_INSERTITEMA, 0, itemPtr)).toBe(0);
        expect(send(win, LVM_GETITEMCOUNT)).toBe(1);

        const outText = 0x1200;
        mem.fill(0xCC, outText, outText + 32);
        const outItem = writeLvItemA(0x1300, {
            mask: LVIF_TEXT | LVIF_IMAGE | LVIF_PARAM,
            iItem: 0,
            textPtr: outText,
            cchTextMax: 32,
        });
        expect(send(win, LVM_GETITEMA, 0, outItem)).toBe(1);
        expect(String.fromCharCode(...mem.slice(outText, outText + 6))).toBe("Gothic");
        expect(view.getInt32(outItem + 28, true)).toBe(3);
        expect(view.getUint32(outItem + 32, true)).toBe(0xABCDEF01);
    });

    test("LVM_INSERTITEMW / GETITEMW round-trip wide text", () => {
        const win = lv();
        const textPtr = putWide(0x1000, "Wide");
        const itemPtr = writeLvItemW(0x1100, {
            mask: LVIF_TEXT,
            iItem: 0,
            textPtr,
        });
        expect(send(win, LVM_INSERTITEMW, 0, itemPtr)).toBe(0);
        expect(getOrCreateListViewState(win.handle).items[0].text).toBe("Wide");

        const outText = 0x1400;
        const outItem = writeLvItemW(0x1500, {
            mask: LVIF_TEXT,
            iItem: 0,
            textPtr: outText,
            cchTextMax: 16,
        });
        expect(send(win, LVM_GETITEMW, 0, outItem)).toBe(1);
        expect(view.getUint16(outText, true)).toBe("W".charCodeAt(0));
        expect(view.getUint16(outText + 2, true)).toBe("i".charCodeAt(0));
        expect(view.getUint16(outText + 4, true)).toBe("d".charCodeAt(0));
        expect(view.getUint16(outText + 6, true)).toBe("e".charCodeAt(0));
        expect(view.getUint16(outText + 8, true)).toBe(0);
    });

    test("LVM_SETITEMA updates text; delete/reset clear the list", () => {
        const win = lv();
        const t1 = putAnsi(0x1000, "one");
        send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100, { mask: LVIF_TEXT, iItem: 0, textPtr: t1 }));
        const t2 = putAnsi(0x1020, "two");
        send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1120, { mask: LVIF_TEXT, iItem: 1, textPtr: t2 }));
        expect(send(win, LVM_GETITEMCOUNT)).toBe(2);

        const t3 = putAnsi(0x1040, "uno");
        send(win, LVM_SETITEMA, 0, writeLvItemA(0x1140, {
            mask: LVIF_TEXT, iItem: 0, textPtr: t3,
        }));
        const state = getOrCreateListViewState(win.handle);
        expect(state.items[0].text).toBe("uno");

        expect(send(win, LVM_DELETEITEM, 0)).toBe(1);
        expect(send(win, LVM_GETITEMCOUNT)).toBe(1);
        expect(send(win, LVM_DELETEALLITEMS)).toBe(1);
        expect(send(win, LVM_GETITEMCOUNT)).toBe(0);
    });
});

describe("ListView selection", () => {
    test("LVM_SETITEMSTATE + GETSELECTEDCOUNT / GETNEXTITEM", () => {
        const win = lv();
        for (let i = 0; i < 3; i++) {
            const t = putAnsi(0x1000 + i * 16, `item${i}`);
            send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100 + i * 40, {
                mask: LVIF_TEXT, iItem: i, textPtr: t,
            }));
        }

        const st = writeLvItemA(0x2000, {
            mask: LVIF_STATE,
            state: LVIS_SELECTED | LVIS_FOCUSED,
            stateMask: LVIS_SELECTED | LVIS_FOCUSED,
        });
        expect(send(win, LVM_SETITEMSTATE, 1, st)).toBe(1);
        expect(send(win, LVM_GETSELECTEDCOUNT)).toBe(1);
        expect(send(win, LVM_GETITEMSTATE, 1, LVIS_SELECTED | LVIS_FOCUSED))
            .toBe(LVIS_SELECTED | LVIS_FOCUSED);
        expect(send(win, LVM_GETNEXTITEM, -1, LVNI_SELECTED)).toBe(1);

        // LVS_SINGLESEL: selecting another clears the first
        send(win, LVM_SETITEMSTATE, 2, st);
        expect(send(win, LVM_GETSELECTEDCOUNT)).toBe(1);
        expect(send(win, LVM_GETNEXTITEM, -1, LVNI_SELECTED)).toBe(2);
    });

    test("mouse-class selectListViewAtIndex drives selectedCount for Gothic launch path", () => {
        const win = lv();
        for (let i = 0; i < 2; i++) {
            const t = putAnsi(0x1000 + i * 16, `mod${i}`);
            send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100 + i * 40, {
                mask: LVIF_TEXT, iItem: i, textPtr: t,
            }));
        }
        expect(send(win, LVM_GETSELECTEDCOUNT)).toBe(0);
        selectListViewAtIndex(win, 0);
        expect(send(win, LVM_GETSELECTEDCOUNT)).toBe(1);
        expect(send(win, LVM_GETSELECTIONMARK)).toBe(0);

        send(win, LVM_SETSELECTIONMARK, 0, 1);
        expect(send(win, LVM_GETSELECTIONMARK)).toBe(1);
    });

    test("multi-select Ctrl toggles without clearing others", () => {
        const win = lv(LVS_REPORT); // no LVS_SINGLESEL
        for (let i = 0; i < 3; i++) {
            const t = putAnsi(0x1000 + i * 16, `x${i}`);
            send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100 + i * 40, {
                mask: LVIF_TEXT, iItem: i, textPtr: t,
            }));
        }
        selectListViewAtIndex(win, 0);
        selectListViewAtIndex(win, 2, MK_CONTROL);
        expect(listViewSelectedCount(getOrCreateListViewState(win.handle))).toBe(2);
    });
});

describe("ListView columns / styles / hit-test", () => {
    test("column insert and extended style", () => {
        const win = lv();
        expect(send(win, LVM_INSERTCOLUMNA, 0, writeLvColumnA(0x2100, 0x2200, 180, "Mods"))).toBe(0);
        expect(getOrCreateListViewState(win.handle).columns[0].text).toBe("Mods");
        expect(getOrCreateListViewState(win.handle).columns[0].cx).toBe(180);

        expect(send(win, LVM_SETEXTENDEDLISTVIEWSTYLE, 0, 0x20)).toBe(0);
        expect(send(win, LVM_GETEXTENDEDLISTVIEWSTYLE)).toBe(0x20);
        expect(send(win, LVM_SETIMAGELIST, 1, 0x30001)).toBe(0);
        expect(getOrCreateListViewState(win.handle).himlSmall).toBe(0x30001);
    });

    test("LVM_HITTEST / hitTestListView resolve a report row", () => {
        const win = lv();
        send(win, LVM_INSERTCOLUMNA, 0, writeLvColumnA(0x2100, 0x2200, 200, "Title"));
        const t = putAnsi(0x1000, "row0");
        send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100, { mask: LVIF_TEXT, iItem: 0, textPtr: t }));

        // Client point below header into first row
        const ht = hitTestListView(win, 20, 18 + 8);
        expect(ht.iItem).toBe(0);

        view.setInt32(0x3000, 20, true);
        view.setInt32(0x3004, 18 + 8, true);
        expect(send(win, LVM_HITTEST, 0, 0x3000)).toBe(0);
        expect(view.getInt32(0x300C, true)).toBe(0);
    });
});

describe("ListView content-changing gate", () => {
    test("isContentChangingMessage covers mutating LVM_*", () => {
        const win = lv();
        expect(isListViewContentMessage(LVM_INSERTITEMA)).toBe(true);
        expect(isListViewContentMessage(LVM_GETSELECTEDCOUNT)).toBe(false);
        expect(isContentChangingMessage(win, LVM_INSERTITEMA)).toBe(true);
        expect(isContentChangingMessage(win, LVM_GETITEMCOUNT)).toBe(false);
    });
});

describe("ListView WM_NOTIFY", () => {
    let posted: Array<{ hwnd: number; msg: number; wParam: number; lParam: number }> = [];
    let saved: Record<string, unknown> = {};

    beforeEach(() => {
        posted = [];
        const system = System.getInstance() as any;
        saved = {
            windowManager: system.windowManager,
            scheduler: system.scheduler,
            process: system.process,
        };
        const guestMem = mem;
        system.process = {
            getCurrentMemory: () => guestMem,
            memory: {
                alloc: (size: number) => {
                    // Park notify scratch in the high end of the test buffer.
                    const base = 0x7000;
                    if (base + size > guestMem.length) throw new Error("notify scratch OOB");
                    return base;
                },
            },
        };
        system.windowManager = {
            postMessage: (hwnd: number, msg: number, wParam: number, lParam: number) => {
                posted.push({ hwnd, msg, wParam, lParam });
            },
            getFocusHwnd: () => 0,
            setFocus: () => {},
        };
        system.scheduler = { wakeMessageWaiters: () => {} };
    });

    afterEach(() => {
        const system = System.getInstance() as any;
        system.windowManager = saved.windowManager;
        system.scheduler = saved.scheduler;
        system.process = saved.process;
    });

    test("selection posts LVN_ITEMCHANGED with NMLISTVIEW fields", () => {
        const win = lv();
        const t = putAnsi(0x1000, "mod");
        send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100, {
            mask: LVIF_TEXT | LVIF_PARAM, iItem: 0, textPtr: t, lParam: 0x42,
        }));
        posted.length = 0;
        selectListViewAtIndex(win, 0);

        const changed = posted.filter((p) => p.msg === WM_NOTIFY);
        expect(changed.length).toBeGreaterThan(0);
        const lvChanged = changed.find((p) => {
            const code = view.getUint32(p.lParam + 8, true);
            return code === LVN_ITEMCHANGED;
        });
        expect(lvChanged).toBeTruthy();
        expect(lvChanged!.hwnd).toBe(0x10001);
        expect(view.getUint32(lvChanged!.lParam, true)).toBe(win.handle); // hwndFrom
        expect(view.getUint32(lvChanged!.lParam + 4, true)).toBe(1002); // idFrom
        expect(view.getInt32(lvChanged!.lParam + 12, true)).toBe(0); // iItem
        expect(view.getUint32(lvChanged!.lParam + 20, true) & LVIS_SELECTED).toBe(LVIS_SELECTED);
        expect(view.getUint32(lvChanged!.lParam + 40, true)).toBe(0x42); // lParam
    });

    test("NM_CLICK carries the activated item", () => {
        const win = lv();
        const t = putAnsi(0x1000, "mod");
        send(win, LVM_INSERTITEMA, 0, writeLvItemA(0x1100, { mask: LVIF_TEXT, iItem: 0, textPtr: t }));
        selectListViewAtIndex(win, 0);
        posted.length = 0;
        postListViewClickNotify(win, false, 0, 0, 10, 20, 0);
        const click = posted.find((p) => p.msg === WM_NOTIFY
            && view.getUint32(p.lParam + 8, true) === NM_CLICK);
        expect(click).toBeTruthy();
        expect(view.getInt32(click!.lParam + 12, true)).toBe(0);
        expect(view.getInt32(click!.lParam + 32, true)).toBe(10);
        expect(view.getInt32(click!.lParam + 36, true)).toBe(20);
    });
});
