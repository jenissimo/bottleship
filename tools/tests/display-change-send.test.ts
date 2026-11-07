/**
 * WM_DISPLAYCHANGE is SENT (Wine: ChangeDisplaySettingsExW → SendMessageTimeout(HWND_BROADCAST)):
 * the mode-setting thread's own top-level windows handle it before the call returns, so a
 * handler that arms a "reinitialise" flag sees the caller clear it afterwards. Windows of
 * other threads, and windows no guest procedure serves, get it posted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { sendDisplayChange } from '../../src/worker/modules/user32/message';

const WM_DISPLAYCHANGE = 0x007e;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const ESP = 0x2000;
const RETADDR = 0x00402000;
const WNDPROC = 0x00401000;
const DD_OK = 0;
const STUB_BASE = 0xf0000000;
const OUTER_FRAME = 7;

interface Invoked { args: number[]; frameId: number; complete?: (ret: number) => number | null }
let invoked: Invoked[] = [];
let abandoned: number[] = [];
let failInvoke = false;
let posted: Array<{ hwnd: number; msg: number; wParam: number; lParam: number }> = [];
let created: number[] = [];
let mem: Uint8Array;
let savedProcess: unknown;
let savedPost: unknown;
let savedForEachTopLevel: unknown;

const wm = () => System.getInstance().windowManager;

function mkWindow(opts: { otherThread?: boolean; wndProc?: number; child?: number } = {}): number {
    const style = opts.child ? WS_CHILD : WS_POPUP;
    const hwnd = wm().createWindow('T', 't', style, 0, 0, 0, 640, 480, opts.child ?? 0, 0, 0, 0);
    created.push(hwnd);
    if (opts.otherThread) wm().getWindow(hwnd)!.creatorThreadId += 1;
    windows.set(hwnd, {
        handle: hwnd, title: 't', style, x: 0, y: 0, width: 640, height: 480,
        children: [], visible: true, wndProc: opts.wndProc ?? WNDPROC,
    } as WindowInfo);
    return hwnd;
}

const send = () => sendDisplayChange({ esp: ESP } as never, mem, { width: 640, height: 480, bpp: 8 }, 24, 'test', DD_OK);

/** Return from each guest WndProc in turn, as the CPU would; the last return is the thunk's. */
function returnFromAll(): number | null {
    let last: number | null = null;
    for (let i = 0; i < invoked.length; i++) last = invoked[i].complete!(0);
    return last;
}

beforeEach(() => {
    invoked = [];
    abandoned = [];
    failInvoke = false;
    posted = [];
    created = [];
    mem = new Uint8Array(0x10000);
    new DataView(mem.buffer).setUint32(ESP, RETADDR, true);

    const system = System.getInstance();
    const w = system.windowManager as unknown as Record<string, unknown>;
    savedPost = w.postMessage;
    w.postMessage = (hwnd: number, msg: number, wParam: number, lParam: number) => { posted.push({ hwnd, msg, wParam, lParam }); };
    // The WindowManager is a process-wide singleton: in a full `bun test` run it still holds
    // top-level windows other files created. Only this file's windows take part here.
    savedForEachTopLevel = w.forEachTopLevel;
    const forEachTopLevel = savedForEachTopLevel as (visit: (win: { hwnd: number }) => void) => number;
    w.forEachTopLevel = (visit: (win: { hwnd: number }) => void) =>
        forEachTopLevel.call(system.windowManager, (win) => { if (created.includes(win.hwnd)) visit(win); });
    savedProcess = system.process;
    system.process = {
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 1,
                getActiveSuspendedFrameId: () => OUTER_FRAME,
                abandonSuspendedFrame: (id: number) => { abandoned.push(id); return true; },
                getStubPoolRange: () => ({ base: STUB_BASE, end: STUB_BASE + 0x1000 }),
                invokeCallback: (_p: number, args: number[], _a: number,
                    complete?: (r: number) => number | null, _s?: boolean, _t?: string, frameId = 0) => {
                    if (failInvoke) return { callbackId: 0 };
                    invoked.push({ args, frameId, complete });
                    return { callbackId: invoked.length };
                },
            },
        },
    } as never;
});

afterEach(() => {
    const system = System.getInstance();
    (system.windowManager as unknown as Record<string, unknown>).postMessage = savedPost;
    (system.windowManager as unknown as Record<string, unknown>).forEachTopLevel = savedForEachTopLevel;
    system.process = savedProcess as never;
    for (const hwnd of created) { wm().destroyWindow(hwnd); windows.delete(hwnd); }
});

test("the caller's own window runs it inside the call; another thread's window gets it posted", () => {
    const own = mkWindow();
    const other = mkWindow({ otherThread: true });

    const result = send() as { suspendedForCallback?: boolean; stackCleanup?: number };

    expect(result.suspendedForCallback).toBe(true);
    expect(result.stackCleanup).toBe(24);
    expect(invoked.map((c) => c.args)).toEqual([[own, WM_DISPLAYCHANGE, 8, ((480 << 16) | 640) >>> 0]]);
    expect(posted.map((m) => [m.hwnd, m.msg])).toEqual([[other, WM_DISPLAYCHANGE]]);
    expect(returnFromAll()).toBe(DD_OK);
});

test('every own top-level window is sent to in turn; children are not', () => {
    const a = mkWindow();
    const b = mkWindow();
    mkWindow({ child: a });

    send();
    // The second send starts only once the first WndProc returns.
    expect(invoked.length).toBe(1);
    expect(invoked[0].complete!(0)).toBeNull();
    expect(invoked.map((c) => c.args[0]).sort()).toEqual([a, b].sort());
    expect(invoked[1].complete!(0)).toBe(DD_OK);
    expect(posted).toEqual([]);
});

test('a window no guest procedure serves is posted, not dropped', () => {
    const plain = mkWindow({ wndProc: 0 });
    expect(send()).toBe(DD_OK);
    expect(invoked).toEqual([]);
    expect(posted.map((m) => m.hwnd)).toEqual([plain]);
});

test('a window an earlier handler destroyed is skipped when its turn comes', () => {
    mkWindow();
    mkWindow();
    send();
    const second = created.find((h) => h !== invoked[0].args[0])!;
    windows.delete(second);
    expect(invoked[0].complete!(0)).toBe(DD_OK);
    expect(invoked.length).toBe(1);
});

test('ChangeDisplaySettings sends it from inside the call, and a CDS_TEST probe sends nothing', async () => {
    const { createSystemExports } = await import('../../src/worker/modules/user32/system');
    const user32 = createSystemExports();
    const system = System.getInstance() as unknown as Record<string, unknown>;
    const savedResize = system.requestHostResize;
    system.requestHostResize = () => {};
    try {
        const own = mkWindow();
        const CDS_TEST = 2;
        expect(user32['ChangeDisplaySettingsA']({ esp: ESP } as never, mem, [0, CDS_TEST] as never)).toBe(0);
        expect(invoked).toEqual([]);

        // lpDevMode == NULL restores the desktop mode: a mode set like any other.
        const result = user32['ChangeDisplaySettingsA']({ esp: ESP } as never, mem, [0, 0] as never) as
            { suspendedForCallback?: boolean; stackCleanup?: number };
        expect(result.suspendedForCallback).toBe(true);
        expect(result.stackCleanup).toBe(8);
        expect(invoked.map((c) => c.args.slice(0, 2))).toEqual([[own, WM_DISPLAYCHANGE]]);
        expect(returnFromAll()).toBe(0); // DISP_CHANGE_SUCCESSFUL
    } finally {
        system.requestHostResize = savedResize;
    }
});

test('a frame saved for the call is released when no send gets dispatched', () => {
    mkWindow();
    failInvoke = true;
    expect(send()).toEqual({ value: DD_OK, stackCleanup: 24 });
    expect(abandoned).toEqual([1]);
});

test("a send from inside a callback runs on the outer frame and leaves it in place", () => {
    mkWindow();
    new DataView(mem.buffer).setUint32(ESP, STUB_BASE + 0x10, true);
    const result = send() as { preserveCallbackReturnAddress?: boolean };
    expect(result.preserveCallbackReturnAddress).toBe(true);
    expect(invoked[0].frameId).toBe(OUTER_FRAME);

    invoked = [];
    failInvoke = true;
    send();
    expect(abandoned).toEqual([]);
});

describe('DirectDraw mode sets', () => {
    let dd: Record<string, (ctx: never, mem: Uint8Array, args: number[]) => unknown>;
    let ddCtx: { display: { width: number; height: number; bpp: number; refresh: number }; cooperative: { exclusive: boolean } };
    let restore: () => void;

    beforeEach(async () => {
        const { createDirectDrawExports } = await import('../../src/worker/modules/ddraw/directdraw');
        const system = System.getInstance() as unknown as Record<string, unknown>;
        const saved = { requestHostResize: system.requestHostResize, gdiContext: system.gdiContext };
        system.requestHostResize = () => {};
        system.gdiContext = { clearOverlay: () => {} };
        restore = () => Object.assign(system, saved);
        ddCtx = {
            display: { width: 640, height: 480, bpp: 16, refresh: 60 },
            cooperative: { exclusive: false },
            desktopMode: { width: 640, height: 480, bpp: 16, refresh: 60 },
            surfaces: {},
            process: { memory: {}, dispatcher: {} },
            resourceProvider: { getComObjectByAddress: () => null, getAllComObjects: () => [] },
        } as never;
        dd = createDirectDrawExports(ddCtx as never) as never;
    });
    afterEach(() => restore());

    const thunk = (name: string, args: number[]) =>
        dd[name]({ esp: ESP } as never, mem, args) as { suspendedForCallback?: boolean; stackCleanup?: number } | number;

    for (const [name, args, cleanup] of [
        ['IDirectDraw_SetDisplayMode', [0x100, 800, 600, 8], 16],
        ['IDirectDraw2_SetDisplayMode', [0x100, 800, 600, 8, 0, 0], 24],
        ['IDirectDraw4_SetDisplayMode', [0x100, 800, 600, 8, 0, 0], 24],
        ['IDirectDraw7_SetDisplayMode', [0x100, 800, 600, 8, 0, 0], 24],
    ] as const) {
        test(`${name} sends with a ${cleanup}-byte cleanup, and repeating the mode sends nothing`, () => {
            const own = mkWindow();
            const result = thunk(name, [...args]) as { suspendedForCallback?: boolean; stackCleanup?: number };
            expect(result.suspendedForCallback).toBe(true);
            expect(result.stackCleanup).toBe(cleanup);
            expect(invoked.map((c) => c.args)).toEqual([[own, WM_DISPLAYCHANGE, 8, ((600 << 16) | 800) >>> 0]]);
            expect(returnFromAll()).toBe(DD_OK);

            invoked = [];
            expect(thunk(name, [...args])).toBe(DD_OK);
            expect(invoked).toEqual([]);
        });
    }

    for (const name of ['IDirectDraw_RestoreDisplayMode', 'IDirectDraw7_RestoreDisplayMode']) {
        test(`${name} sends with a 4-byte cleanup only when the mode changes`, () => {
            const own = mkWindow();
            expect(thunk(name, [0x100])).toBe(DD_OK);
            expect(invoked).toEqual([]);

            thunk('IDirectDraw7_SetDisplayMode', [0x100, 800, 600, 8, 0, 0]);
            returnFromAll();
            invoked = [];
            const result = thunk(name, [0x100]) as { stackCleanup?: number };
            expect(result.stackCleanup).toBe(4);
            expect(invoked.map((c) => c.args)).toEqual([[own, WM_DISPLAYCHANGE, 16, ((480 << 16) | 640) >>> 0]]);
            expect(returnFromAll()).toBe(DD_OK);
        });
    }
});
