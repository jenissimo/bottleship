/**
 * DestroyWindow's message order: WM_DESTROY parent first, while every child still
 * exists, then WM_NCDESTROY children first.
 *
 * An MFC dialog that reads a subclassed combo's selection in OnDestroy depends on it:
 * the combo's WM_NCDESTROY detaches its CWnd, so delivering it before the parent's
 * WM_DESTROY hands the handler a NULL HWND.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { beginSyncDestroyDelivery } from "../../src/worker/modules/user32/destroy-sync";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";

const WM_DESTROY = 0x0002;
const WM_NCDESTROY = 0x0082;
const DIALOG = 0x7001, COMBO = 0x7002, LIST = 0x7003, BUTTON = 0x7004;
const GUEST_PROC = 0x401000;

let delivered: Array<{ hwnd: number; msg: number; alive: number[] }>;
let finalized: number[];
let pending: Array<() => unknown>;
let savedProcess: unknown;

function addWindow(handle: number, parent: number | undefined, children: number[], extra: Partial<WindowInfo> = {}): void {
    windows.set(handle, {
        handle, title: "", style: 0, x: 0, y: 0, width: 10, height: 10, parent, children, visible: true,
        wndProc: GUEST_PROC, ...extra,
    });
}

beforeEach(() => {
    delivered = [];
    finalized = [];
    pending = [];
    const system = System.getInstance();
    savedProcess = system.process;
    system.process = {
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 1,
                invokeCallback: (_proc: number, args: number[], _f: number, complete: (r: number) => unknown) => {
                    delivered.push({ hwnd: args[0]!, msg: args[1]!, alive: [...windows.keys()] });
                    pending.push(() => complete(0));
                    return { callbackId: delivered.length };
                },
            },
        },
    } as never;
    // A combo that MFC subclassed (guest proc) holding a JS-owned list, and a plain JS button.
    addWindow(DIALOG, undefined, [COMBO, BUTTON]);
    addWindow(COMBO, DIALOG, [LIST], { isSystemControl: true, wndProcSubclassed: true });
    addWindow(LIST, COMBO, [], { isSystemControl: true });
    addWindow(BUTTON, DIALOG, [], { isSystemControl: true });
});

afterEach(() => {
    System.getInstance().process = savedProcess as never;
    for (const h of [DIALOG, COMBO, LIST, BUTTON]) windows.delete(h);
});

function destroy(): void {
    const finalize = (h: number) => {
        finalized.push(h);
        windows.delete(h);
    };
    const mem = new Uint8Array(0x100);
    beginSyncDestroyDelivery({ esp: 0x10 }, mem, DIALOG, finalize, 4);
    while (pending.length) pending.shift()!();
}

describe("DestroyWindow message order", () => {
    test("WM_DESTROY goes parent first, WM_NCDESTROY children first", () => {
        destroy();
        expect(delivered.map(d => [d.hwnd, d.msg])).toEqual([
            [DIALOG, WM_DESTROY],
            [COMBO, WM_DESTROY],
            [COMBO, WM_NCDESTROY],
            [DIALOG, WM_NCDESTROY],
        ]);
    });

    test("every child still exists while the parent handles WM_DESTROY", () => {
        destroy();
        const parentDestroy = delivered.find(d => d.hwnd === DIALOG && d.msg === WM_DESTROY)!;
        expect(parentDestroy.alive).toEqual(expect.arrayContaining([COMBO, LIST, BUTTON]));
        expect(finalized).toEqual([LIST, COMBO, BUTTON, DIALOG]);
    });

    test("a window with no guest procedure is only finalized, in its place", () => {
        destroy();
        const comboNc = delivered.find(d => d.hwnd === COMBO && d.msg === WM_NCDESTROY)!;
        expect(comboNc.alive).not.toContain(LIST);
        expect(comboNc.alive).toContain(BUTTON);
    });
});
