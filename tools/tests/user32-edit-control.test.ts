/**
 * EDIT control contracts, pinned to Wine edit.c / NT5 editsl.c: the buffer/selection
 * protocol (EM_GETLINE, EM_GETSEL/EM_SETSEL), the single-level undo, WM_SETTEXT's
 * relationship to the text limit, and which messages count as a content change for
 * the parent's repaint (that decision runs on the message-pump hot path).
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { handleEditMessage } from "../../src/worker/modules/user32/edit-control";
import { isContentChangingMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import type { WindowInfo } from "../../src/worker/modules/user32/shared-state";

const EM_GETSEL = 0x00b0;
const EM_SETSEL = 0x00b1;
const EM_GETMODIFY = 0x00b8;
const EM_REPLACESEL = 0x00c2;
const EM_GETLINE = 0x00c4;
const EM_LIMITTEXT = 0x00c5;
const EM_CANUNDO = 0x00c6;
const EM_EMPTYUNDOBUFFER = 0x00cd;
const WM_SETTEXT = 0x000c;
const WM_SETFOCUS = 0x0007;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_CUT = 0x0300;
const WM_COPY = 0x0301;
const WM_PASTE = 0x0302;
const WM_CLEAR = 0x0303;
const WM_UNDO = 0x0304;

const ES_MULTILINE = 0x0004;
const ES_PASSWORD = 0x0020;
const ES_READONLY = 0x0800;

let nextHandle = 0;
function edit(title: string, style = 0): WindowInfo {
    return {
        handle: 0x100 + nextHandle++,
        title,
        style,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        children: [],
        visible: true,
        wndProc: 0,
        isSystemControl: true,
        systemControlClass: "Edit",
    };
}

const mem = new Uint8Array(0x4000);
const send = (win: WindowInfo, msg: number, wParam = 0, lParam = 0): number | null => {
    Mem.bind(() => mem);
    return handleEditMessage(win, msg, wParam, lParam, mem);
};
const type = (win: WindowInfo, text: string): void => {
    for (const ch of text) send(win, WM_CHAR, ch.charCodeAt(0));
};
const putAnsi = (at: number, s: string): number => {
    Mem.bind(() => mem);
    for (let i = 0; i < s.length; i++) mem[at + i] = s.charCodeAt(i);
    mem[at + s.length] = 0;
    return at;
};

describe("EDIT EM_GETLINE", () => {
    test("an unsigned out-of-range line index returns zero without touching the buffer", () => {
        Mem.bind(() => mem);
        const view = new DataView(mem.buffer);
        const buffer = 0x200;
        view.setUint16(buffer, 8, true);
        view.setUint32(buffer + 4, 0xdeadbeef, true);

        expect(send(edit("first\r\nsecond", ES_MULTILINE), EM_GETLINE, 0xffffffff, buffer)).toBe(0);
        expect(view.getUint16(buffer, true)).toBe(8);
        expect(view.getUint32(buffer + 4, true)).toBe(0xdeadbeef);
    });
});

describe("EDIT selection", () => {
    // NT5 EditSL_ChangeSelection swaps out-of-order endpoints and clamps both to cch.
    test("EM_SETSEL swaps reversed endpoints and clamps past the end", () => {
        const win = edit("abcdef");
        send(win, EM_SETSEL, 5, 2);
        expect(send(win, EM_GETSEL)).toBe((5 << 16) | 2);

        send(win, EM_SETSEL, 3, 99);
        expect(send(win, EM_GETSEL)).toBe((6 << 16) | 3);
    });

    test("EM_SETSEL(-1) deselects at the caret; EM_SETSEL(x,-1) selects to the end", () => {
        const win = edit("abcdef");
        send(win, EM_SETSEL, 2, 4);
        send(win, EM_SETSEL, 0xffffffff, 0);
        expect(send(win, EM_GETSEL)).toBe((4 << 16) | 4);

        send(win, EM_SETSEL, 1, 0xffffffff);
        expect(send(win, EM_GETSEL)).toBe((6 << 16) | 1);
    });

    test("EM_GETSEL clamps to text that shrank under the selection", () => {
        const win = edit("abcdef");
        send(win, EM_SETSEL, 2, 6);
        win.title = "ab";
        expect(send(win, EM_GETSEL)).toBe((2 << 16) | 2);
    });

    test("EM_GETSEL writes both out-params", () => {
        Mem.bind(() => mem);
        const view = new DataView(mem.buffer);
        const win = edit("abcdef");
        send(win, EM_SETSEL, 1, 4);
        send(win, EM_GETSEL, 0x300, 0x304);
        expect(view.getUint32(0x300, true)).toBe(1);
        expect(view.getUint32(0x304, true)).toBe(4);
    });
});

describe("EDIT undo", () => {
    test("typing is undoable, and undo is its own redo", () => {
        const win = edit("");
        expect(send(win, EM_CANUNDO)).toBe(0);

        type(win, "abc");
        expect(win.title).toBe("abc");
        expect(send(win, EM_CANUNDO)).toBe(1);

        expect(send(win, WM_UNDO)).toBe(1);
        expect(win.title).toBe("");

        expect(send(win, WM_UNDO)).toBe(1);
        expect(win.title).toBe("abc");
    });

    test("a deletion is undoable", () => {
        const win = edit("hello");
        send(win, EM_SETSEL, 0, 5);
        send(win, WM_CLEAR);
        expect(win.title).toBe("");
        expect(send(win, EM_CANUNDO)).toBe(1);
        send(win, WM_UNDO);
        expect(win.title).toBe("hello");
    });

    test("EM_EMPTYUNDOBUFFER clears it, and EM_REPLACESEL(fCanUndo=0) never fills it", () => {
        const win = edit("");
        type(win, "abc");
        send(win, EM_EMPTYUNDOBUFFER);
        expect(send(win, EM_CANUNDO)).toBe(0);

        send(win, EM_REPLACESEL, 0, putAnsi(0x400, "xy"));
        expect(win.title).toBe("abcxy");
        expect(send(win, EM_CANUNDO)).toBe(0);
    });
});

describe("EDIT WM_SETTEXT", () => {
    test("resets the modify flag and the undo buffer", () => {
        const win = edit("");
        type(win, "abc");
        expect(send(win, EM_GETMODIFY)).toBe(1);

        send(win, WM_SETTEXT, 0, putAnsi(0x420, "q"));
        expect(win.title).toBe("q");
        expect(send(win, EM_GETMODIFY)).toBe(0);
        expect(send(win, EM_CANUNDO)).toBe(0);
    });

    // EM_SETLIMITTEXT bounds what the USER may type; it does not truncate WM_SETTEXT.
    test("ignores the text limit that WM_CHAR honours", () => {
        const win = edit("");
        send(win, EM_LIMITTEXT, 2);
        type(win, "abcd");
        expect(win.title).toBe("ab");

        send(win, WM_SETTEXT, 0, putAnsi(0x440, "wxyz"));
        expect(win.title).toBe("wxyz");
    });
});

describe("EDIT clipboard", () => {
    // WM_COPY/WM_PASTE go through the real clipboard store, which holds guest HGLOBALs —
    // so the round trip needs an allocator. A bump allocator over the test buffer is
    // enough for GlobalAlloc(GMEM_MOVEABLE)'s mem_entry + payload.
    const withGuestHeap = (body: () => void): void => {
        const system = System.getInstance() as any;
        const previous = system.process;
        let next = 0x1000;
        const sizes = new Map<number, number>();
        system.process = {
            getCurrentMemory: () => mem,
            memory: {
                alloc: (bytes: number) => {
                    const ptr = next;
                    next = (next + bytes + 15) & ~7;
                    sizes.set(ptr, bytes);
                    return ptr;
                },
                getSize: (ptr: number) => sizes.get(ptr),
                free: (ptr: number) => sizes.delete(ptr),
            },
        };
        try {
            Mem.bind(() => mem);
            body();
        } finally {
            system.process = previous;
        }
    };

    test("copy publishes the selection; paste inserts it into another edit", () => {
        withGuestHeap(() => {
            const source = edit("hello world");
            send(source, EM_SETSEL, 6, 11);
            send(source, WM_COPY);

            const target = edit("");
            send(target, WM_PASTE);
            expect(target.title).toBe("world");
        });
    });

    test("cut removes the selection and is undoable", () => {
        withGuestHeap(() => {
            const win = edit("abcdef");
            send(win, EM_SETSEL, 0, 3);
            send(win, WM_CUT);
            expect(win.title).toBe("def");

            send(win, WM_UNDO);
            expect(win.title).toBe("abcdef");

            const target = edit("");
            send(target, WM_PASTE);
            expect(target.title).toBe("abc");
        });
    });

    test("a read-only edit refuses paste; a password edit refuses copy", () => {
        withGuestHeap(() => {
            const seed = edit("seed");
            send(seed, EM_SETSEL, 0, 4);
            send(seed, WM_COPY);

            const readOnly = edit("", ES_READONLY);
            send(readOnly, WM_PASTE);
            expect(readOnly.title).toBe("");

            const password = edit("secret", ES_PASSWORD);
            send(password, EM_SETSEL, 0, 6);
            send(password, WM_CHAR, 0x03); // ^C
            const target = edit("");
            send(target, WM_PASTE);
            expect(target.title).toBe("seed");
        });
    });
});

describe("EDIT control characters", () => {
    // TranslateMessage folds Ctrl+key into a control character; WM_CHAR must turn those
    // back into the clipboard/undo messages instead of dropping everything under 0x20.
    test("^Z undoes", () => {
        const win = edit("");
        type(win, "abc");
        send(win, WM_CHAR, 0x1a);
        expect(win.title).toBe("");
    });

    test("a plain control character is still ignored", () => {
        const win = edit("ab");
        send(win, EM_SETSEL, 2, 2);
        send(win, WM_CHAR, 0x07); // BEL
        expect(win.title).toBe("ab");
    });
});

describe("control repaint gating", () => {
    const button = (): WindowInfo => {
        const win = edit("OK");
        win.systemControlClass = "Button";
        return win;
    };

    test("focus and key messages on a non-EDIT control are not content changes", () => {
        for (const msg of [WM_SETFOCUS, WM_KEYDOWN, WM_CHAR]) {
            expect(isContentChangingMessage(button(), msg)).toBe(false);
        }
    });

    test("an EDIT still repaints on the editing messages, but not on focus", () => {
        expect(isContentChangingMessage(edit(""), WM_CHAR)).toBe(true);
        expect(isContentChangingMessage(edit(""), WM_KEYDOWN)).toBe(true);
        expect(isContentChangingMessage(edit(""), WM_SETFOCUS)).toBe(false);
    });

    test("WM_SETTEXT is a content change for any control class", () => {
        expect(isContentChangingMessage(button(), WM_SETTEXT)).toBe(true);
        expect(isContentChangingMessage(edit(""), WM_SETTEXT)).toBe(true);
    });
});
