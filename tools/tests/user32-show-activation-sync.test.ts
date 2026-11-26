import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';

const A = 0x74440, B = A + 4, ESP = 0x2000;
const APP = 0x1c, NC = 0x86, ACT = 6, FOCUS = 7, KILL = 8;
const activation = [APP, NC, ACT, FOCUS, KILL];
type Call = { proc: number; args: number[]; complete?: (r: number) => unknown; options?: any };
let calls: Call[], posts: number[], active: number, mem: Uint8Array, saved: Record<string, unknown>;
let savedProcess: unknown, savedMem: unknown;
function win(h: number, visible = false): WindowInfo {
    return { handle: h, title: 'generic', style: 0x80000000 | (visible ? 0x10000000 : 0),
        x: 0, y: 0, width: 320, height: 200, children: [], wndProc: 0x401000 + h,
        userData: 0, visible, activationDelivered: false } as WindowInfo;
}
function drain() { for (let i = 0; i < calls.length; i++) calls[i]!.complete?.(0); }
function messages() { return calls.filter(c => activation.includes(c.args[1]!)).map(c => [c.args[0], c.args[1], c.args[2]]); }
beforeEach(() => {
    calls = []; posts = []; active = 0; mem = new Uint8Array(0x10000);
    new DataView(mem.buffer).setUint32(ESP, 0x402000, true);
    savedMem = (Mem as any).memoryGetter; Mem.bind(() => mem);
    const system = System.getInstance(), wm = system.windowManager as any;
    saved = {};
    for (const key of ['getWindow', 'postMessage', 'removePostedMessages', 'setWindowZOrder', 'getActiveHwnd',
        'setActiveWindow', 'getZOrder', 'getFocusHwnd', 'clearActiveWindow', 'getWindowOwnerThread', 'forEachTopLevel']) saved[key] = wm[key];
    wm.getWindow = (h: number) => { const w = windows.get(h); return w ? { ...w, hwnd: h, rect: {x:0,y:0,w:320,h:200} } : null; };
    wm.postMessage = (_h: number, msg: number) => { posts.push(msg); };
    wm.removePostedMessages = () => {};
    wm.setWindowZOrder = () => {};
    wm.getActiveHwnd = () => active;
    wm.setActiveWindow = (h: number) => { const prior = active; active = h; return prior; };
    wm.getZOrder = () => [B, A].filter(h => windows.has(h));
    wm.getFocusHwnd = () => active;
    wm.clearActiveWindow = (h: number) => { if (active === h) active = 0; };
    wm.getWindowOwnerThread = () => 1;
    wm.forEachTopLevel = (cb: (w: any) => void) => { for (const h of [A, B]) if (windows.has(h)) cb({ hwnd: h, creatorThreadId: 1 }); };
    savedProcess = system.process;
    system.process = { v86: { mem8: mem }, dispatcher: { callbackManager: {
        saveSuspendedThunkContext: () => 1,
        getStubPoolRange: () => ({ base: 0xf0000000, end: 0xf0001000 }),
        invokeCallback: (proc: number, args: number[], _f: number, complete?: Call['complete'], _a?: unknown, _l?: unknown, _id?: number, options?: any) => {
            calls.push({proc, args, complete: options?.directThunkReturn?.complete ?? complete, options});
            return { callbackId: calls.length };
        },
    } }, memory: { alloc: () => 0x800, free() {} }, getModule: () => undefined } as never;
});
afterEach(() => {
    const system = System.getInstance();
    Object.assign(system.windowManager, saved); system.process = savedProcess as never; Mem.bind(savedMem as () => Uint8Array);
    windows.delete(A); windows.delete(B);
});
const show = (h = A, cmd = 5) => createWindowExports().ShowWindow!({ esp: ESP } as never, mem, [h, cmd] as never);
const pos = (h = A, flags = 0x43) => createWindowExports().SetWindowPos!({ esp: ESP } as never, mem, [h, 0, 0, 0, 0, 0, flags] as never);

test('first show sends application activation before returning and queues no activation', () => {
    windows.set(A, win(A)); const result = show() as any;
    expect(result.suspendedForCallback).toBe(true); expect(result.skipStackCheck).toBe(true);
    expect(messages()).toEqual([]); drain();
    expect(messages()).toEqual([[A, APP, 1], [A, NC, 1], [A, ACT, 1], [A, FOCUS, 0]]);
    expect(posts.filter(m => activation.includes(m))).toEqual([]);
});
test('SetWindowPos show sends activation before WINDOWPOSCHANGED and API completion', () => {
    windows.set(A, win(A)); const result = pos() as any;
    expect(result.skipStackCheck).toBe(true); drain();
    expect(messages()).toEqual([[A, APP, 1], [A, NC, 1], [A, ACT, 1], [A, FOCUS, 0]]);
    expect(calls.findIndex(c => c.args[1] === ACT)).toBeLessThan(calls.findIndex(c => c.args[1] === 0x47));
    expect(posts.filter(m => activation.includes(m))).toEqual([]);
});
test('splash-to-main transition sends outgoing/incoming activation without an app boundary', () => {
    windows.set(A, win(A, true)); windows.get(A)!.activationDelivered = true; active = A;
    windows.set(B, win(B)); show(B); drain();
    expect(messages()).toEqual([[A, NC, 0], [A, ACT, 0], [B, NC, 1], [B, ACT, 1], [A, KILL, B], [B, FOCUS, A]]);
    expect(posts.filter(m => activation.includes(m))).toEqual([]);
});
test('last active hide sends FALSE before return rather than leaving it in the queue', () => {
    windows.set(A, win(A, true)); active = A; show(A, 0); drain();
    expect(messages()).toEqual([[A, NC, 0], [A, ACT, 0], [A, APP, 0], [A, KILL, 0]]);
    expect(active).toBe(0); expect(posts.filter(m => activation.includes(m))).toEqual([]);
});
test('noactivate and child shows do not activate', () => {
    windows.set(A, win(A)); show(A, 8); drain(); expect(messages()).toEqual([]);
    calls = []; windows.set(B, { ...win(B), style: 0x40000000, parent: A } as WindowInfo);
    show(B); drain(); expect(messages()).toEqual([]);
});
test('creation/init defers activation and reentrant same-window activation does not duplicate it', () => {
    windows.set(A, { ...win(A), createInProgress: true }); active = A; show(); drain();
    expect(messages()).toEqual([]);
    calls = []; windows.get(A)!.createInProgress = false; windows.get(A)!.visible = false; windows.get(A)!.style &= ~0x10000000;
    show(); calls[0]!.complete?.(0); calls[1]!.complete?.(0);
    expect(windows.get(A)!.activationDelivered).toBe(true);
    const before = posts.length; createWindowExports().SetActiveWindow!({ esp: ESP } as never, mem, [A] as never);
    expect(posts.length).toBe(before); for (let i = 2; i < calls.length; i++) calls[i]!.complete?.(0);
    expect(messages().filter(x => x[1] === APP)).toHaveLength(1);
});
test('callbacks re-resolve subclass and stop activation after window destruction', () => {
    windows.set(A, win(A)); show(); calls[0]!.complete?.(0); calls[1]!.complete?.(0);
    windows.get(A)!.wndProc = 0x405000; calls[2]!.complete?.(0);
    expect(calls[3]!.proc).toBe(0x405000);
    windows.delete(A); calls[3]!.complete?.(0);
    expect(messages().map(x => x[1])).toEqual([APP, NC]);
});
test('nested show preserves direct callback return context through the activation chain', () => {
    windows.set(A, win(A)); new DataView(mem.buffer).setUint32(ESP, 0xf0000010, true);
    const result = show() as any; expect(result.preserveCallbackReturnAddress).toBe(true); drain();
    expect(messages()).toHaveLength(4);
    expect(calls.every(c => c.options?.directThunkReturn?.returnAddr === 0xf0000010)).toBe(true);
});

test('outgoing handlers see the old active window, incoming handlers see the new one', () => {
    windows.set(A, win(A, true)); active = A; windows.set(B, win(B));
    show(B); calls[0]!.complete?.(0); calls[1]!.complete?.(0);
    expect(active).toBe(A); // outgoing NCACTIVATE
    calls[2]!.complete?.(0); expect(active).toBe(A); // outgoing ACTIVATE
    calls[3]!.complete?.(0); expect(active).toBe(B); // incoming NCACTIVATE
    for (let i = 4; i < calls.length; i++) calls[i]!.complete?.(0);
});
test('incoming handler activation of another window cancels remaining stale steps', () => {
    windows.set(A, win(A)); show(); calls[0]!.complete?.(0); calls[1]!.complete?.(0);
    active = B; calls[2]!.complete?.(0);
    expect(messages().map(x => x[1])).toEqual([APP]); expect(active).toBe(B);
});
test('incoming handler hiding its target cancels remaining stale steps', () => {
    windows.set(A, win(A)); show(); calls[0]!.complete?.(0); calls[1]!.complete?.(0);
    windows.get(A)!.visible = false; calls[2]!.complete?.(0);
    expect(messages().map(x => x[1])).toEqual([APP]);
    expect(calls.some(c => c.args[1] === 0x47)).toBe(false);
});
test('a KILLFOCUS handler moving focus elsewhere is not overwritten by a stale SETFOCUS', () => {
    const wm = System.getInstance().windowManager as any;
    let focus = A;
    wm.getFocusHwnd = () => focus;
    wm.setActiveWindow = (h: number) => { const old = active; active = h; focus = h; return old; };
    windows.set(A, win(A, true)); active = A; windows.set(B, win(B));
    show(B);
    for (let i = 0; i < calls.length; i++) {
        if (calls[i]!.args[1] === KILL) focus = 0x75550;
        calls[i]!.complete?.(0);
    }
    expect(messages().map(x => x[1])).toEqual([NC, ACT, NC, ACT, KILL]);
    expect(focus).toBe(0x75550);
});
test('hiding with a visible successor switches windows without an application boundary', () => {
    windows.set(A, win(A, true)); active = A; windows.set(B, win(B, true));
    show(A, 0); drain();
    expect(messages().map(x => x[1])).toEqual([NC, ACT, NC, ACT, KILL, FOCUS]);
    expect(active).toBe(B);
    const count = calls.length; show(B); expect(calls).toHaveLength(count);
});
test('other input queue activation keeps asynchronous delivery off the current guest stack', () => {
    windows.set(A, win(A));
    (System.getInstance().windowManager as any).getWindowOwnerThread = () => 0x777;
    show(); drain();
    expect(messages()).toEqual([]);
    expect(posts.filter(m => activation.includes(m))).toEqual([APP, NC, ACT, FOCUS]);
});
test('a destroyed WM_SHOWWINDOW target does not apply state to a reused handle', () => {
    windows.set(A, win(A)); show(); const replacement = win(A); windows.set(A, replacement);
    calls[0]!.complete?.(0);
    expect(replacement.visible).toBe(false); expect(messages()).toEqual([]);
});
test('nested SetWindowPos reuses its direct return through activation and changed callbacks', () => {
    windows.set(A, win(A)); new DataView(mem.buffer).setUint32(ESP, 0xf0000010, true);
    const result = pos() as any; expect(result.preserveCallbackReturnAddress).toBe(true); drain();
    expect(messages()).toHaveLength(4);
    expect(calls.every(c => c.options?.directThunkReturn?.returnAddr === 0xf0000010)).toBe(true);
});
