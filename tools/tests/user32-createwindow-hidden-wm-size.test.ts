import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { windows } from '../../src/worker/modules/user32/shared-state';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { createClassExports } from '../../src/worker/modules/user32/class';

const WM_NCCREATE = 0x0081;
const WM_CREATE = 0x0001;
const WM_SIZE = 0x0005;
const WM_SHOWWINDOW = 0x0018;
const WM_MOVE = 0x0003;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const WS_OVERLAPPEDWINDOW = 0x00CF0000;
const WS_VISIBLE = 0x10000000;
const WS_MAXIMIZE = 0x01000000;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const SW_SHOWMINIMIZED = 2;

const WNDPROC = 0x00401000;
const WNDCLASS = 0x11000;
const CLASS_NAME = 0x11100;
const SCRATCH = 0x3000;
const ESP = 0x2000;

interface Invoked { args: number[]; complete?: (ret: number) => unknown }
let invoked: Invoked[] = [];
let mem: Uint8Array;
let saved: Record<string, unknown> = {};
let savedProcess: unknown;
let savedMemGetter: unknown;
const created: number[] = [];

beforeEach(() => {
    invoked = [];
    mem = new Uint8Array(0x20000);
    savedMemGetter = (Mem as unknown as Record<string, unknown>).memoryGetter;
    Mem.bind(() => mem);
    const system = System.getInstance();
    const wm = system.windowManager as unknown as Record<string, unknown>;
    saved = { postMessage: wm.postMessage, setWindowZOrder: wm.setWindowZOrder };
    wm.postMessage = () => {};
    wm.setWindowZOrder = () => {};
    savedProcess = system.process;
    system.process = {
        v86: { mem8: mem },
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 1,
                getStubPoolRange: () => ({ base: 0xf0000000, end: 0xf0001000 }),
                invokeCallback: (_p: number, args: number[], _f: number, complete?: (r: number) => unknown) => {
                    invoked.push({ args, complete });
                    return { callbackId: invoked.length };
                },
            },
        },
        memory: { alloc: () => SCRATCH, free: () => {} },
        getModule: () => undefined,
        getCurrentMemory: () => mem,
    } as never;
    mem.set(new TextEncoder().encode('HiddenSizeTest\0'), CLASS_NAME);
    const dv = new DataView(mem.buffer);
    dv.setUint32(WNDCLASS + 4, WNDPROC, true);
    dv.setUint32(WNDCLASS + 16, 0x400000, true);
    dv.setUint32(WNDCLASS + 36, CLASS_NAME, true);
    createClassExports()['RegisterClassA']!({ esp: ESP } as never, mem, [WNDCLASS] as never);
});

afterEach(() => {
    const system = System.getInstance();
    Object.assign(system.windowManager as unknown as Record<string, unknown>, saved);
    system.process = savedProcess as never;
    Mem.bind(savedMemGetter as () => Uint8Array);
    for (const h of created.splice(0)) windows.delete(h);
});

function create(style: number, parent = 0): number {
    const r = createWindowExports()['CreateWindowExA']!({ esp: ESP } as never, mem,
        [0, CLASS_NAME, 0, style >>> 0, 10, 20, 400, 300, parent, 0, 0x400000, 0] as never) as { value: number } | number;
    const hwnd = typeof r === 'number' ? r : r.value;
    created.push(hwnd);
    drain();
    return hwnd;
}

function drain(): void {
    for (let i = 0; i < invoked.length && i < 64; i++) {
        const c = invoked[i];
        c.complete = c.complete ? (c.complete(0), undefined) : undefined;
    }
}

function show(hwnd: number, cmd: number): number[] {
    const before = invoked.length;
    createWindowExports()['ShowWindow']!({ esp: ESP } as never, mem, [hwnd, cmd] as never);
    drain();
    return invoked.slice(before).map((c) => c.args[1]);
}

const received = (): number[] => invoked.map((c) => c.args[1]);

test('a window created hidden is not told its size until it is first shown', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW);
    expect(received()).toEqual([WM_NCCREATE, WM_CREATE]);
    expect(show(hwnd, SW_SHOWNORMAL)).toEqual([WM_SHOWWINDOW, WM_SIZE, WM_MOVE]);
    const win = windows.get(hwnd)!;
    const size = invoked.find((c) => c.args[1] === WM_SIZE)!;
    expect(size.args[2]).toBe(0);
    expect(size.args[3]).toBe(((win.height << 16) | win.width) >>> 0);
    const move = invoked.find((c) => c.args[1] === WM_MOVE)!;
    expect(move.args[3]).toBe((((win.y & 0xffff) << 16) | (win.x & 0xffff)) >>> 0);
});

test('only the first show sends them', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW);
    show(hwnd, SW_SHOWNORMAL);
    show(hwnd, SW_HIDE);
    expect(show(hwnd, SW_SHOWNORMAL)).toEqual([WM_SHOWWINDOW]);
});

test('a window created visible got its WM_SIZE inside CreateWindowEx and none again on show', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    expect(received().slice(0, 4)).toEqual([WM_NCCREATE, WM_CREATE, WM_SHOWWINDOW, WM_SIZE]);
    show(hwnd, SW_HIDE);
    expect(show(hwnd, SW_SHOWNORMAL)).toEqual([WM_SHOWWINDOW]);
});

test('a hidden maximized window reports SIZE_MAXIMIZED when shown', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW | WS_MAXIMIZE);
    show(hwnd, SW_SHOWNORMAL + 2);
    const size = invoked.find((c) => c.args[1] === WM_SIZE)!;
    expect(size.args[2]).toBe(2);
});

test('resizing the hidden window first does not use up the first show\'s WM_SIZE', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW);
    createWindowExports()['SetWindowPos']!({ esp: ESP } as never, mem, [hwnd, 0, 0, 0, 500, 350, 0x0002 | 0x0004 | 0x0010] as never);
    drain();
    expect(show(hwnd, SW_SHOWNORMAL)).toEqual([WM_SHOWWINDOW, WM_SIZE, WM_MOVE]);
});

test('a hidden minimized show reports SIZE_MINIMIZED with lParam 0', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW);
    show(hwnd, SW_SHOWMINIMIZED);
    const size = invoked.find((c) => c.args[1] === WM_SIZE)!;
    expect(size.args[2]).toBe(1);
    expect(size.args[3]).toBe(0);
});

test('hidden popup and child windows do not defer their size to the first show', () => {
    const popup = create(WS_POPUP);
    expect(show(popup, SW_SHOWNORMAL)).toEqual([WM_SHOWWINDOW]);
    const parent = create(WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    const child = create(WS_CHILD, parent);
    expect(show(child, SW_SHOWNORMAL)).toEqual([WM_SHOWWINDOW]);
});

test('a window SetWindowPos already showed gets no late WM_SIZE from a later ShowWindow', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW);
    createWindowExports()['SetWindowPos']!({ esp: ESP } as never, mem, [hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0040] as never);
    drain();
    expect(show(hwnd, SW_SHOWNORMAL)).not.toContain(WM_SIZE);
});

test('WM_SIZE and WM_MOVE follow a WM_SHOWWINDOW that suspended into the guest, each on its completion', () => {
    const hwnd = create(WS_OVERLAPPEDWINDOW);
    const before = invoked.length;
    createWindowExports()['ShowWindow']!({ esp: ESP } as never, mem, [hwnd, SW_SHOWNORMAL] as never);
    expect(invoked.slice(before).map((c) => c.args[1])).toEqual([WM_SHOWWINDOW]);
    invoked[before]!.complete?.(0);
    expect(invoked.slice(before).map((c) => c.args[1])).toEqual([WM_SHOWWINDOW, WM_SIZE]);
    invoked[before + 1]!.complete?.(0);
    expect(invoked.slice(before).map((c) => c.args[1])).toEqual([WM_SHOWWINDOW, WM_SIZE, WM_MOVE]);
});

test('ShowWindow from inside WM_CREATE delivers the size once and CreateWindowEx adds none', () => {
    const r = createWindowExports()['CreateWindowExA']!({ esp: ESP } as never, mem,
        [0, CLASS_NAME, 0, WS_OVERLAPPEDWINDOW, 10, 20, 400, 300, 0, 0, 0x400000, 0] as never) as { value: number } | number;
    const hwnd = typeof r === 'number' ? r : r.value;
    created.push(hwnd);
    invoked[0]!.complete?.(0);
    expect(invoked.map((c) => c.args[1])).toEqual([WM_NCCREATE, WM_CREATE]);
    const fromCreate = show(hwnd, SW_SHOWNORMAL);
    expect(fromCreate).toEqual([WM_SHOWWINDOW, WM_SIZE, WM_MOVE]);
    drain();
    expect(invoked.filter((c) => c.args[1] === WM_SIZE).length).toBe(1);
});
