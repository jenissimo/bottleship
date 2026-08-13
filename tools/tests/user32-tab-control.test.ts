/**
 * SysTabControl32: the TCM_* contracts, the tab-row layout that painting and the
 * hit test share, TCM_ADJUSTRECT, and keyboard navigation.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    handleTabMessage,
    isTabContentMessage,
    resetTabStatesForTests,
    getOrCreateTabState,
    ensureTabLayout,
    tabItemRect,
    tabRowsHeight,
    adjustTabRect,
    hitTestTab,
    handleTabKey,
    stripMnemonic,
    TCM_FIRST,
    TCIF_TEXT,
    TCIF_PARAM,
    TCIF_IMAGE,
    TCIF_STATE,
    TCHT_ONITEMLABEL,
    TCHT_NOWHERE,
    TCS_MULTILINE,
    TCS_BOTTOM,
    DISPLAY_AREA_PADDING,
    CONTROL_BORDER_SIZE,
} from "../../src/worker/modules/user32/tab-control";
import { isContentChangingMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import type { WindowInfo } from "../../src/worker/modules/user32/shared-state";

const TCM_GETITEMCOUNT = TCM_FIRST + 4;
const TCM_GETITEMA = TCM_FIRST + 5;
const TCM_SETITEMA = TCM_FIRST + 6;
const TCM_INSERTITEMA = TCM_FIRST + 7;
const TCM_DELETEITEM = TCM_FIRST + 8;
const TCM_DELETEALLITEMS = TCM_FIRST + 9;
const TCM_GETITEMRECT = TCM_FIRST + 10;
const TCM_GETCURSEL = TCM_FIRST + 11;
const TCM_SETCURSEL = TCM_FIRST + 12;
const TCM_HITTEST = TCM_FIRST + 13;
const TCM_ADJUSTRECT = TCM_FIRST + 40;
const TCM_SETITEMSIZE = TCM_FIRST + 41;
const TCM_SETPADDING = TCM_FIRST + 43;
const TCM_GETROWCOUNT = TCM_FIRST + 44;
const TCM_SETMINTABWIDTH = TCM_FIRST + 49;
const TCM_SETEXTENDEDSTYLE = TCM_FIRST + 52;
const TCM_GETEXTENDEDSTYLE = TCM_FIRST + 53;
const TCM_INSERTITEMW = TCM_FIRST + 62;
const WM_GETDLGCODE = 0x0087;
const DLGC_WANTARROWS = 0x0001;

const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const VK_HOME = 0x24;
const VK_END = 0x23;

const mem = new Uint8Array(0x8000);
const view = new DataView(mem.buffer);

let nextHandle = 0x30000;
function tabWin(style = 0, width = 400, height = 300): WindowInfo {
    return {
        handle: nextHandle++,
        title: "",
        style,
        x: 0,
        y: 0,
        width,
        height,
        children: [],
        visible: true,
        wndProc: 0,
        isSystemControl: true,
        systemControlClass: "SysTabControl32",
        controlId: 12320,
    };
}

const send = (win: WindowInfo, msg: number, wParam = 0, lParam = 0): number | null => {
    Mem.bind(() => mem);
    return handleTabMessage(win, msg, wParam, lParam, mem);
};

function putAnsi(at: number, s: string): number {
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
    return at;
}

/** TCITEM: mask, dwState, dwStateMask, pszText, cchTextMax, iImage, lParam. */
function writeTcItem(
    ptr: number,
    o: { mask: number; state?: number; stateMask?: number; textPtr?: number; cch?: number; iImage?: number; lParam?: number },
): number {
    view.setUint32(ptr, o.mask, true);
    view.setUint32(ptr + 4, o.state ?? 0, true);
    view.setUint32(ptr + 8, o.stateMask ?? 0, true);
    view.setUint32(ptr + 12, o.textPtr ?? 0, true);
    view.setInt32(ptr + 16, o.cch ?? 0, true);
    view.setInt32(ptr + 20, o.iImage ?? -1, true);
    view.setUint32(ptr + 24, o.lParam ?? 0, true);
    return ptr;
}

const ITEM = 0x1000;
const TEXT = 0x1100;
const OUT = 0x1200;

function insert(win: WindowInfo, index: number, text: string, lParam = 0): number {
    putAnsi(TEXT, text);
    writeTcItem(ITEM, { mask: TCIF_TEXT | TCIF_PARAM, textPtr: TEXT, lParam });
    return send(win, TCM_INSERTITEMA, index, ITEM) as number;
}

beforeEach(() => {
    mem.fill(0);
    resetTabStatesForTests();
});

describe("SysTabControl32 items", () => {
    test("insert returns the index and the first tab selects itself", () => {
        const win = tabWin();
        expect(insert(win, 0, "Video")).toBe(0);
        expect(send(win, TCM_GETITEMCOUNT)).toBe(1);
        expect(send(win, TCM_GETCURSEL)).toBe(0);
        expect(insert(win, 1, "Audio")).toBe(1);
        expect(send(win, TCM_GETITEMCOUNT)).toBe(2);
        // Only the FIRST insert moves the selection.
        expect(send(win, TCM_GETCURSEL)).toBe(0);
    });

    test("an index past the end appends, and an insert before the selection shifts it", () => {
        const win = tabWin();
        insert(win, 0, "A");
        insert(win, 99, "B");
        expect(send(win, TCM_GETITEMCOUNT)).toBe(2);
        send(win, TCM_SETCURSEL, 1);
        insert(win, 0, "Z");
        expect(send(win, TCM_GETCURSEL)).toBe(2);
    });

    test("TCM_GETITEM copies text, image and lParam back per mask", () => {
        const win = tabWin();
        putAnsi(TEXT, "Network");
        writeTcItem(ITEM, { mask: TCIF_TEXT | TCIF_PARAM | TCIF_IMAGE, textPtr: TEXT, iImage: 4, lParam: 0xdeadbeef });
        send(win, TCM_INSERTITEMA, 0, ITEM);

        writeTcItem(OUT, { mask: TCIF_TEXT | TCIF_PARAM | TCIF_IMAGE, textPtr: TEXT + 0x80, cch: 32 });
        expect(send(win, TCM_GETITEMA, 0, OUT)).toBe(1);
        let text = "";
        for (let i = 0; mem[TEXT + 0x80 + i]; i++) text += String.fromCharCode(mem[TEXT + 0x80 + i]);
        expect(text).toBe("Network");
        expect(view.getInt32(OUT + 20, true)).toBe(4);
        expect(view.getUint32(OUT + 24, true)).toBe(0xdeadbeef);
    });

    test("TCM_SETITEM only touches the fields the mask names", () => {
        const win = tabWin();
        insert(win, 0, "Old", 0x11);
        putAnsi(TEXT, "New");
        writeTcItem(ITEM, { mask: TCIF_TEXT, textPtr: TEXT });
        expect(send(win, TCM_SETITEMA, 0, ITEM)).toBe(1);

        writeTcItem(OUT, { mask: TCIF_TEXT | TCIF_PARAM, textPtr: TEXT + 0x80, cch: 32 });
        send(win, TCM_GETITEMA, 0, OUT);
        let text = "";
        for (let i = 0; mem[TEXT + 0x80 + i]; i++) text += String.fromCharCode(mem[TEXT + 0x80 + i]);
        expect(text).toBe("New");
        expect(view.getUint32(OUT + 24, true)).toBe(0x11);
    });

    test("TCM_INSERTITEMW reads UTF-16 text", () => {
        const win = tabWin();
        const s = "Wide";
        for (let i = 0; i < s.length; i++) {
            mem[TEXT + i * 2] = s.charCodeAt(i);
            mem[TEXT + i * 2 + 1] = 0;
        }
        mem[TEXT + s.length * 2] = 0;
        mem[TEXT + s.length * 2 + 1] = 0;
        writeTcItem(ITEM, { mask: TCIF_TEXT, textPtr: TEXT });
        expect(send(win, TCM_INSERTITEMW, 0, ITEM)).toBe(0);
        expect(getOrCreateTabState(win.handle).items[0].text).toBe("Wide");
    });

    test("delete clears the selection and reindexes; delete-all empties it", () => {
        const win = tabWin();
        insert(win, 0, "A");
        insert(win, 1, "B");
        insert(win, 2, "C");
        send(win, TCM_SETCURSEL, 2);
        expect(send(win, TCM_DELETEITEM, 0)).toBe(1);
        expect(send(win, TCM_GETITEMCOUNT)).toBe(2);
        expect(send(win, TCM_GETCURSEL)).toBe(1);
        // Deleting the selected tab clears the selection (comctl32).
        expect(send(win, TCM_DELETEITEM, 1)).toBe(1);
        expect(send(win, TCM_GETCURSEL)).toBe(-1);
        send(win, TCM_DELETEALLITEMS);
        expect(send(win, TCM_GETITEMCOUNT)).toBe(0);
    });

    test("TCM_SETCURSEL returns the previous index and refuses out of range", () => {
        const win = tabWin();
        insert(win, 0, "A");
        insert(win, 1, "B");
        expect(send(win, TCM_SETCURSEL, 1)).toBe(0);
        expect(send(win, TCM_GETCURSEL)).toBe(1);
        expect(send(win, TCM_SETCURSEL, 9)).toBe(1);
        expect(send(win, TCM_GETCURSEL)).toBe(-1);
    });

    test("extended style is masked when wParam names a mask", () => {
        const win = tabWin();
        expect(send(win, TCM_SETEXTENDEDSTYLE, 0, 0x3)).toBe(0);
        expect(send(win, TCM_GETEXTENDEDSTYLE)).toBe(0x3);
        send(win, TCM_SETEXTENDEDSTYLE, 0x1, 0x0);
        expect(send(win, TCM_GETEXTENDEDSTYLE)).toBe(0x2);
    });

    test("an unknown in-range TCM_ answers 0, and anything else is not ours", () => {
        const win = tabWin();
        expect(send(win, TCM_FIRST + 0x55)).toBe(0);
        expect(send(win, 0x0201 /* WM_LBUTTONDOWN */)).toBeNull();
    });

    test("WM_GETDLGCODE claims the arrow keys", () => {
        const win = tabWin();
        expect((send(win, WM_GETDLGCODE) as number) & DLGC_WANTARROWS).toBe(DLGC_WANTARROWS);
    });
});

describe("SysTabControl32 layout", () => {
    test("tabs flow left to right on one row and their rects tile without gaps", () => {
        const win = tabWin();
        for (const t of ["Video", "Audio", "Speed"]) insert(win, 99, t);
        const st = ensureTabLayout(win);
        expect(st.rowCount).toBe(1);
        const r0 = tabItemRect(win, 0)!;
        const r1 = tabItemRect(win, 1)!;
        const r2 = tabItemRect(win, 2)!;
        expect(r0.left).toBe(0);
        expect(r1.left).toBe(r0.right);
        expect(r2.left).toBe(r1.right);
        expect(r0.right).toBeGreaterThan(r0.left);
        // One row: every tab shares the row band.
        expect(r1.top).toBe(r0.top);
        expect(r0.bottom - r0.top).toBe(st.tabHeight);
    });

    test("TCS_MULTILINE wraps to a second row when the tabs overflow", () => {
        const narrow = tabWin(TCS_MULTILINE, 60, 200);
        for (const t of ["Video", "Audio", "Speed", "Network"]) insert(narrow, 99, t);
        const st = ensureTabLayout(narrow);
        expect(st.rowCount).toBeGreaterThan(1);
        expect(tabRowsHeight(narrow, st)).toBe(st.tabHeight * st.rowCount);
        // A wrapped tab restarts at the left edge of its row.
        const wrapped = st.items.find((i) => i.row > 0);
        expect(wrapped?.left).toBe(0);
    });

    test("a single-line control does NOT wrap, however narrow", () => {
        const narrow = tabWin(0, 60, 200);
        for (const t of ["Video", "Audio", "Speed", "Network"]) insert(narrow, 99, t);
        expect(ensureTabLayout(narrow).rowCount).toBe(1);
    });

    test("TCM_ADJUSTRECT round-trips window rect <-> display area", () => {
        const win = tabWin();
        insert(win, 0, "Video");
        const st = ensureTabLayout(win);
        const inset = DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        const display = adjustTabRect(win, false, { left: 0, top: 0, right: win.width, bottom: win.height });
        expect(display.left).toBe(inset);
        expect(display.top).toBe(inset + st.tabHeight * st.rowCount);
        expect(display.right).toBe(win.width - inset);
        expect(display.bottom).toBe(win.height - inset);

        const back = adjustTabRect(win, true, display);
        expect(back.left).toBe(0);
        expect(back.top).toBe(0);
        expect(back.right).toBe(win.width);
        expect(back.bottom).toBe(win.height);
    });

    test("TCS_BOTTOM takes the rows off the bottom instead of the top", () => {
        const win = tabWin(TCS_BOTTOM);
        insert(win, 0, "Video");
        const st = ensureTabLayout(win);
        const inset = DISPLAY_AREA_PADDING + CONTROL_BORDER_SIZE;
        const display = adjustTabRect(win, false, { left: 0, top: 0, right: win.width, bottom: win.height });
        expect(display.top).toBe(inset);
        expect(display.bottom).toBe(win.height - inset - st.tabHeight * st.rowCount);
        expect(tabItemRect(win, 0)!.bottom).toBeGreaterThan(display.bottom);
    });

    test("TCM_GETITEMRECT hands back the same rect the hit test uses", () => {
        const win = tabWin();
        insert(win, 0, "Video");
        insert(win, 1, "Audio");
        expect(send(win, TCM_GETITEMRECT, 1, OUT)).toBe(1);
        const left = view.getInt32(OUT, true);
        const top = view.getInt32(OUT + 4, true);
        const right = view.getInt32(OUT + 8, true);
        const bottom = view.getInt32(OUT + 12, true);
        expect(hitTestTab(win, left + 1, top + 1)).toBe(1);
        expect(hitTestTab(win, right - 1, bottom - 1)).toBe(1);
        expect(hitTestTab(win, right + 5, top + 1)).toBe(-1);
    });

    test("TCM_HITTEST reports the index and the ONITEM/NOWHERE flag", () => {
        const win = tabWin();
        insert(win, 0, "Video");
        insert(win, 1, "Audio");
        const r = tabItemRect(win, 1)!;
        view.setInt32(OUT, r.left + 2, true);
        view.setInt32(OUT + 4, r.top + 2, true);
        expect(send(win, TCM_HITTEST, 0, OUT)).toBe(1);
        expect(view.getUint32(OUT + 8, true)).toBe(TCHT_ONITEMLABEL);

        view.setInt32(OUT, 5, true);
        view.setInt32(OUT + 4, win.height - 5, true); // below the tab row
        expect(send(win, TCM_HITTEST, 0, OUT)).toBe(-1);
        expect(view.getUint32(OUT + 8, true)).toBe(TCHT_NOWHERE);
    });

    test("padding and minimum width widen the tabs, and TCM_SETITEMSIZE pins them", () => {
        const base = tabWin();
        insert(base, 0, "A");
        const w0 = tabItemRect(base, 0)!.right;

        const padded = tabWin();
        insert(padded, 0, "A");
        send(padded, TCM_SETPADDING, 0, (3 << 16) | 40);
        expect(tabItemRect(padded, 0)!.right).toBeGreaterThan(w0);

        const wide = tabWin();
        insert(wide, 0, "A");
        send(wide, TCM_SETMINTABWIDTH, 0, 120);
        expect(tabItemRect(wide, 0)!.right).toBe(120);

        const fixed = tabWin(0x0400 /* TCS_FIXEDWIDTH */);
        insert(fixed, 0, "A");
        send(fixed, TCM_SETITEMSIZE, 0, (24 << 16) | 77);
        const r = tabItemRect(fixed, 0)!;
        expect(r.right - r.left).toBe(77);
        expect(r.bottom - r.top).toBe(24);
    });

    test("TCM_GETROWCOUNT reflects the wrap", () => {
        const win = tabWin(TCS_MULTILINE, 60, 200);
        for (const t of ["Video", "Audio", "Speed"]) insert(win, 99, t);
        expect(send(win, TCM_GETROWCOUNT)).toBe(ensureTabLayout(win).rowCount);
    });

    test("an ampersand is a mnemonic prefix, not a drawn glyph", () => {
        expect(stripMnemonic("&Apply")).toBe("Apply");
        expect(stripMnemonic("R&&D")).toBe("R&D");
    });
});

describe("SysTabControl32 keyboard + repaint gate", () => {
    test("arrows move the selection and clamp at both ends", () => {
        const win = tabWin();
        for (const t of ["A", "B", "C"]) insert(win, 99, t);
        expect(send(win, TCM_GETCURSEL)).toBe(0);
        expect(handleTabKey(win, VK_RIGHT)).toBe(true);
        expect(send(win, TCM_GETCURSEL)).toBe(1);
        expect(handleTabKey(win, VK_END)).toBe(true);
        expect(send(win, TCM_GETCURSEL)).toBe(2);
        // At the last tab, VK_RIGHT is consumed but must not run off the end.
        expect(handleTabKey(win, VK_RIGHT)).toBe(true);
        expect(send(win, TCM_GETCURSEL)).toBe(2);
        expect(handleTabKey(win, VK_HOME)).toBe(true);
        expect(send(win, TCM_GETCURSEL)).toBe(0);
        expect(handleTabKey(win, VK_LEFT)).toBe(true);
        expect(send(win, TCM_GETCURSEL)).toBe(0);
        // A key the control does not own is not consumed.
        expect(handleTabKey(win, 0x41 /* 'A' */)).toBe(false);
    });

    test("messages that change the tab row are flagged for repaint", () => {
        const win = tabWin();
        expect(isTabContentMessage(TCM_INSERTITEMA)).toBe(true);
        expect(isTabContentMessage(TCM_SETCURSEL)).toBe(true);
        expect(isTabContentMessage(TCM_DELETEALLITEMS)).toBe(true);
        expect(isTabContentMessage(TCM_GETCURSEL)).toBe(false);
        // ... and reach the shared predicate the message pump consults.
        expect(isContentChangingMessage(win, TCM_INSERTITEMA)).toBe(true);
        expect(isContentChangingMessage(win, TCM_GETCURSEL)).toBe(false);
    });

    test("state carries TCIF_STATE through the mask", () => {
        const win = tabWin();
        insert(win, 0, "A");
        writeTcItem(ITEM, { mask: TCIF_STATE, state: 0x2, stateMask: 0x2 });
        send(win, TCM_SETITEMA, 0, ITEM);
        writeTcItem(OUT, { mask: TCIF_STATE, stateMask: 0x2 });
        send(win, TCM_GETITEMA, 0, OUT);
        expect(view.getUint32(OUT + 4, true)).toBe(0x2);
    });
});
