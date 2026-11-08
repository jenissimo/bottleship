import { beforeEach, describe, expect, test } from "bun:test";
import "../../src/worker/modules/user32/index";
import { createInputExports } from "../../src/worker/modules/user32/input";
import { acceleratorTable, captureAccelerators, matchAccelerator, resetAcceleratorTables, restoreAccelerators } from "../../src/worker/modules/user32/accelerators";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { System } from "../../src/worker/core/system";

const BASE = 0x10000;

function imageWithAcceleratorTable(): Uint8Array {
    const mem = new Uint8Array(0x20000);
    const v = new DataView(mem.buffer);
    v.setUint16(BASE, 0x5a4d, true);
    v.setUint32(BASE + 0x3c, 0x40, true);
    const pe = BASE + 0x40;
    v.setUint32(pe, 0x4550, true);
    const opt = pe + 24;
    v.setUint16(opt, 0x10b, true);
    const rsrcRva = 0x1000;
    v.setUint32(opt + 112, rsrcRva, true);
    v.setUint32(opt + 116, 0x200, true);
    const root = BASE + rsrcRva;
    const dir = (at: number, id: number, child: number, sub: boolean) => {
        v.setUint16(at + 14, 1, true);
        v.setUint32(at + 16, id, true);
        v.setUint32(at + 20, (sub ? 0x80000000 : 0) | child, true);
    };
    dir(root, 9, 0x18, true);
    dir(root + 0x18, 1, 0x30, true);
    dir(root + 0x30, 0x409, 0x48, false);
    const dataRva = rsrcRva + 0x60;
    v.setUint32(root + 0x48, dataRva, true);
    v.setUint32(root + 0x48 + 4, 16, true);
    const tbl = BASE + dataRva;
    v.setUint16(tbl, 0x01, true);
    v.setUint16(tbl + 2, 0x70, true);
    v.setUint16(tbl + 4, 40001, true);
    v.setUint16(tbl + 8, 0x01 | 0x08 | 0x80, true);
    v.setUint16(tbl + 10, 0x50, true);
    v.setUint16(tbl + 12, 40002, true);
    return mem;
}

const call = (name: string, mem: Uint8Array, args: number[]) =>
    (createInputExports()[name] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);

beforeEach(() => resetAcceleratorTables());

describe("accelerator tables", () => {
    test("LoadAcceleratorsA finds the RT_ACCELERATOR resource and returns a usable table", () => {
        const mem = imageWithAcceleratorTable();
        const handle = call("LoadAcceleratorsA", mem, [BASE, 1]) >>> 0;
        expect(handle).not.toBe(0);
        expect(acceleratorTable(handle)).toEqual([
            { flags: 0x01, key: 0x70, cmd: 40001 },
            { flags: 0x09, key: 0x50, cmd: 40002 },
        ]);
    });

    test("negative control: a module without that table still answers NULL", () => {
        const mem = imageWithAcceleratorTable();
        expect(call("LoadAcceleratorsA", mem, [BASE, 2])).toBe(0);
    });

    test("a virtual-key entry matches only with its own modifiers", () => {
        const table = [{ flags: 0x09, key: 0x50, cmd: 7 }];
        expect(matchAccelerator(table, 0x100, 0x50, { shift: false, control: true, alt: false })?.cmd).toBe(7);
        expect(matchAccelerator(table, 0x100, 0x50, { shift: false, control: false, alt: false })).toBeNull();
        expect(matchAccelerator(table, 0x101, 0x50, { shift: false, control: true, alt: false })).toBeNull();
    });
});

describe("TranslateAccelerator", () => {
    const HWND = 0x10077, WNDPROC = 0x401000, MSG = 0x3000;
    function setup(style: number, capture = 0) {
        const mem = new Uint8Array(0x8000);
        const v = new DataView(mem.buffer);
        v.setUint32(MSG + 4, 0x100, true);
        v.setUint32(MSG + 8, 0x70, true);
        windows.set(HWND, { handle: HWND, title: "", style, x: 0, y: 0, width: 10, height: 10, children: [], visible: true, wndProc: WNDPROC } as unknown as WindowInfo);
        const sent: number[][] = [];
        const posted: number[][] = [];
        const system = System.getInstance() as unknown as Record<string, any>;
        const saved = { process: system.process, windowManager: system.windowManager, scheduler: system.scheduler };
        system.process = { addressSpace: { validateRange: (a: number, n: number) => a + n <= mem.length }, dispatcher: { callbackManager: {
            getStubPoolRange: () => ({ base: 0x21000000, end: 0x21040000 }),
            saveSuspendedThunkContext: () => 9,
            invokeCallback: (fn: number, args: number[]) => { sent.push([fn, ...args]); return { callbackId: 3 }; },
        } } };
        system.windowManager = { postMessage: (...a: number[]) => posted.push(a), getCaptureHwnd: () => capture };
        const input = system.inputManager;
        const savedKeyState = input.getKeyState;
        input.getKeyState = () => 0;
        const handle = registerTable();
        const restore = () => { Object.assign(system, saved); input.getKeyState = savedKeyState; windows.delete(HWND); };
        return { mem, sent, posted, handle, restore };
    }
    function registerTable(): number {
        restoreAccelerators({ tables: [[0x1acc0001, [[0x01, 0x70, 40001]]]], nextHandle: 0x1acc0002 });
        return 0x1acc0001;
    }
    const translate = (mem: Uint8Array, handle: number) =>
        (createInputExports()["TranslateAcceleratorA"] as (c: unknown, m: Uint8Array, a: number[]) => unknown)({ esp: 0x7000 }, mem, [HWND, handle, MSG]);

    test("sends WM_COMMAND synchronously to the window procedure and answers TRUE", () => {
        const { mem, sent, posted, handle, restore } = setup(0);
        try {
            const result = translate(mem, handle) as { suspendedForCallback?: boolean; stackCleanup?: number };
            expect(result.suspendedForCallback).toBe(true);
            expect(result.stackCleanup).toBe(12);
            expect(sent).toEqual([[WNDPROC, HWND, 0x111, (1 << 16) | 40001, 0]]);
            expect(posted).toEqual([]);
        } finally { restore(); }
    });

    test("a disabled or minimized window, or a mouse capture, takes the key without a WM_COMMAND", () => {
        for (const [style, capture] of [[0x08000000, 0], [0x20000000, 0], [0, 0x10099]]) {
            const { mem, sent, posted, handle, restore } = setup(style!, capture!);
            try {
                expect(translate(mem, handle)).toBe(1);
                expect(sent).toEqual([]);
                expect(posted).toEqual([]);
            } finally { restore(); }
        }
    });

    test("an unmatched key and an out-of-range message are not translated", () => {
        const { mem, sent, handle, restore } = setup(0);
        try {
            new DataView(mem.buffer).setUint32(MSG + 8, 0x71, true);
            expect(translate(mem, handle)).toBe(0);
            expect((createInputExports()["TranslateAcceleratorA"] as (c: unknown, m: Uint8Array, a: number[]) => unknown)({ esp: 0 }, mem, [HWND, handle, 0x7ffffff0])).toBe(0);
            expect(sent).toEqual([]);
        } finally { restore(); }
    });
});

describe("accelerator savestate", () => {
    test("tables and the handle counter survive capture and restore", () => {
        restoreAccelerators({ tables: [[0x1acc0005, [[0x09, 0x50, 7]]]], nextHandle: 0x1acc0006 });
        const saved = JSON.parse(JSON.stringify(captureAccelerators()));
        resetAcceleratorTables();
        restoreAccelerators(saved);
        expect(acceleratorTable(0x1acc0005)).toEqual([{ flags: 0x09, key: 0x50, cmd: 7 }]);
        expect(captureAccelerators().nextHandle).toBe(0x1acc0006);
    });

    test("CreateAcceleratorTable and CopyAcceleratorTable refuse guest ranges that are not mapped", () => {
        const mem = new Uint8Array(0x1000);
        const system = System.getInstance() as unknown as Record<string, any>;
        const saved = { process: system.process, scheduler: system.scheduler };
        system.process = { addressSpace: { validateRange: (a: number, n: number) => a + n <= mem.length } };
        const setLastError = system.scheduler.setLastError;
        system.scheduler.setLastError = () => undefined;
        try {
            expect(call("CreateAcceleratorTableA", mem, [0xff0, 0x7000])).toBe(0);
            restoreAccelerators({ tables: [[0x1acc0007, [[0x01, 0x70, 1], [0x01, 0x71, 2]]]], nextHandle: 0x1acc0008 });
            expect(call("CopyAcceleratorTableA", mem, [0x1acc0007, 0xffa, 2])).toBe(0);
            expect(call("CopyAcceleratorTableA", mem, [0x1acc0007, 0x800, 2])).toBe(2);
        } finally {
            system.scheduler.setLastError = setLastError;
            Object.assign(system, saved);
        }
    });
});
