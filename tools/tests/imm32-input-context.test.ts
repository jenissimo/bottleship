/**
 * IMM32 input contexts: the INPUTCONTEXT block ImmLockIMC hands out, its lock count, the
 * IMCC components, and window association (ImmAssociateContext[Ex]).
 *
 * Ground truth: imm.h / immdev.h for the layout; NT5 imm32 context.c CreateInputContext
 * for the initial contents; ntimm.c AssociateInputContextEx for the association rules.
 * The local-memory fake follows kernel32's moveable-handle contract, since every IMM block
 * is an LHND local handle.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    ImmContextTable, INPUTCONTEXT, IACE_CHILDREN, IACE_DEFAULT, IACE_IGNORENOCONTEXT,
    type ImmLocalMemory, type ImmWindowHost,
} from "../../src/worker/modules/imm32-context";

let mem: Uint8Array;

/** Moveable local handles: handle != pointer, 8-bit lock count, LocalUnlock's TRUE-while-locked. */
function makeLocalMemory() {
    let nextPtr = 0x1000;
    let nextHandle = 0x800000;
    const blocks = new Map<number, { ptr: number; size: number; lock: number }>();
    const local: ImmLocalMemory = {
        alloc: (bytes) => {
            const h = nextHandle; nextHandle += 8;
            blocks.set(h, { ptr: nextPtr, size: bytes, lock: 0 });
            mem.fill(0, nextPtr, nextPtr + bytes);
            nextPtr += (bytes + 15) & ~15;
            return h;
        },
        lock: (h) => {
            const b = blocks.get(h);
            if (!b) return 0;
            b.lock++;
            return b.ptr;
        },
        unlock: (h) => {
            const b = blocks.get(h);
            if (!b || b.lock === 0) return 0;
            return --b.lock > 0 ? 1 : 0;
        },
        free: (h) => (blocks.delete(h) ? 0 : h),
        lockCount: (h) => blocks.get(h)?.lock ?? 0,
        size: (h) => blocks.get(h)?.size ?? 0,
        realloc: (h, bytes) => {
            const b = blocks.get(h);
            if (!b) return 0;
            b.size = bytes;
            return h;
        },
    };
    return { local, blocks };
}

function makeHost() {
    const state = {
        thread: 1,
        windows: new Map<number, number>(),      // hwnd -> creator thread
        children: new Map<number, number[]>(),
    };
    const host: ImmWindowHost = {
        currentThreadId: () => state.thread,
        windowThread: (hwnd) => state.windows.get(hwnd),
        descendants: (hwnd) => {
            const out: number[] = [];
            const walk = (h: number) => {
                for (const c of state.children.get(h) ?? []) { out.push(c); walk(c); }
            };
            walk(hwnd);
            return out;
        },
    };
    return { state, host };
}

const u32 = (addr: number) => Mem.readUint32(addr)!;

describe("INPUTCONTEXT layout", () => {
    test("offsets match immdev.h on x86 (LOGFONTW arm, 4 CANDIDATEFORMs)", () => {
        expect(INPUTCONTEXT.fdwConversion).toBe(24);
        expect(INPUTCONTEXT.lfFont).toBe(32);
        expect(INPUTCONTEXT.cfCompForm).toBe(32 + 92);          // sizeof(LOGFONTW)
        expect(INPUTCONTEXT.cfCandForm).toBe(124 + 28);         // sizeof(COMPOSITIONFORM)
        expect(INPUTCONTEXT.hCompStr).toBe(152 + 4 * 32);       // 4 x sizeof(CANDIDATEFORM)
        expect(INPUTCONTEXT.hMsgBuf).toBe(300);
        expect(INPUTCONTEXT.SIZE).toBe(0x140);
    });
});

describe("ImmLockIMC / ImmUnlockIMC", () => {
    let table: ImmContextTable;
    let local: ImmLocalMemory;

    beforeEach(() => {
        mem = new Uint8Array(0x40000);
        Mem.bind(() => mem);
        ({ local } = makeLocalMemory());
        table = new ImmContextTable(makeHost().host);
    });

    test("the first lock creates the context the way CreateInputContext does", () => {
        const himc = table.defaultContext(1);
        const ic = table.lock(himc, local);
        expect(ic).not.toBe(0);
        expect(u32(ic + INPUTCONTEXT.fOpen)).toBe(0);
        expect(u32(ic + INPUTCONTEXT.dwNumMsgBuf)).toBe(0);
        for (let i = 0; i < 4; i++) expect(u32(ic + INPUTCONTEXT.cfCandForm + i * 32)).toBe(0xffffffff);

        // Each component is a real IMCC whose struct carries its own dwSize.
        const expectSized = (off: number, size: number) => {
            const h = u32(ic + off);
            expect(h).not.toBe(0);
            const p = local.lock(h);
            expect(u32(p)).toBe(size);
            expect(local.size(h)).toBe(size);
            local.unlock(h);
        };
        expectSized(INPUTCONTEXT.hCompStr, 100);     // COMPOSITIONSTRING
        expectSized(INPUTCONTEXT.hCandInfo, 144);    // CANDIDATEINFO
        expectSized(INPUTCONTEXT.hGuideLine, 28);    // GUIDELINE
        expect(local.size(u32(ic + INPUTCONTEXT.hMsgBuf))).toBe(4);
        expect(local.size(u32(ic + INPUTCONTEXT.hPrivate))).toBe(4);
        // Components are left unlocked after creation.
        expect(local.lockCount(u32(ic + INPUTCONTEXT.hCompStr))).toBe(0);
    });

    test("lock count follows lock/unlock, and the pointer is stable", () => {
        const himc = table.defaultContext(1);
        const a = table.lock(himc, local);
        const b = table.lock(himc, local);
        expect(b).toBe(a);
        expect(table.lockCount(himc, local)).toBe(2);
        expect(table.unlock(himc, local)).toBe(true);
        expect(table.lockCount(himc, local)).toBe(1);
        expect(table.unlock(himc, local)).toBe(true);
        expect(table.lockCount(himc, local)).toBe(0);
        // ImmUnlockIMC answers TRUE for a valid HIMC even with nothing left to unlock.
        expect(table.unlock(himc, local)).toBe(true);
    });

    test("state written through the lock is what the next lock reads", () => {
        const himc = table.defaultContext(1);
        table.withInputContext(himc, local, (ic) => Mem.writeUint32(ic + INPUTCONTEXT.fOpen, 1));
        expect(table.withInputContext(himc, local, (ic) => u32(ic + INPUTCONTEXT.fOpen))).toBe(1);
        expect(table.lockCount(himc, local)).toBe(0);
    });

    test("an invalid HIMC is NULL / FALSE / 0", () => {
        expect(table.lock(0x1234, local)).toBe(0);
        expect(table.unlock(0x1234, local)).toBe(false);
        expect(table.lockCount(0x1234, local)).toBe(0);
    });
});

describe("contexts and association", () => {
    let table: ImmContextTable;
    let local: ImmLocalMemory;
    let blocks: Map<number, unknown>;
    let state: ReturnType<typeof makeHost>["state"];

    beforeEach(() => {
        mem = new Uint8Array(0x40000);
        Mem.bind(() => mem);
        ({ local, blocks } = makeLocalMemory());
        const h = makeHost();
        state = h.state;
        table = new ImmContextTable(h.host);
        state.windows.set(0x100, 1);
        state.windows.set(0x101, 1);
        state.windows.set(0x102, 1);
        state.children.set(0x100, [0x101]);
        state.children.set(0x101, [0x102]);
    });

    test("a window starts on its thread's default context; unknown windows have none", () => {
        const def = table.defaultContext(1);
        expect(table.windowContext(0x100)).toBe(def);
        expect(table.windowContext(0x999)).toBeUndefined();
    });

    test("ImmAssociateContext returns the previous context, and NULL disassociates", () => {
        const def = table.defaultContext(1);
        const mine = table.create();
        expect(table.associate(0x100, mine)).toBe(def);
        expect(table.windowContext(0x100)).toBe(mine);
        expect(table.associate(0x100, 0)).toBe(mine);
        expect(table.windowContext(0x100)).toBe(0);
        expect(table.associate(0x999, mine)).toBe(0);
    });

    test("another thread's context cannot be associated", () => {
        state.thread = 2;
        const foreign = table.create();
        state.thread = 1;
        expect(table.associate(0x100, foreign)).toBe(0);
        expect(table.associateEx(0x100, foreign, 0)).toBe(false);
    });

    test("IACE_CHILDREN reaches every descendant; IACE_IGNORENOCONTEXT skips NULL ones", () => {
        const mine = table.create();
        table.associate(0x102, 0);
        expect(table.associateEx(0x100, mine, IACE_CHILDREN | IACE_IGNORENOCONTEXT)).toBe(true);
        expect(table.windowContext(0x100)).toBe(mine);
        expect(table.windowContext(0x101)).toBe(mine);
        expect(table.windowContext(0x102)).toBe(0);

        expect(table.associateEx(0x100, mine, IACE_CHILDREN)).toBe(true);
        expect(table.windowContext(0x102)).toBe(mine);
    });

    test("IACE_DEFAULT restores the window thread's default whatever HIMC is passed", () => {
        const def = table.defaultContext(1);
        const mine = table.create();
        table.associate(0x100, mine);
        expect(table.associateEx(0x100, 0, IACE_DEFAULT)).toBe(true);
        expect(table.windowContext(0x100)).toBe(def);
        expect(table.associateEx(0, mine, 0)).toBe(false);
    });

    test("ImmDestroyContext refuses the default and foreign contexts, and frees every block", () => {
        const def = table.defaultContext(1);
        expect(table.destroy(def, local)).toBe(false);

        const mine = table.create();
        table.associate(0x100, mine);
        table.lock(mine, local);
        table.unlock(mine, local);
        const before = blocks.size;
        expect(before).toBe(6); // INPUTCONTEXT + five IMCCs

        state.thread = 2;
        expect(table.destroy(mine, local)).toBe(false);
        state.thread = 1;
        expect(table.destroy(mine, local)).toBe(true);
        expect(blocks.size).toBe(0);
        expect(table.isContext(mine)).toBe(false);
        // A window left pointing at the destroyed context falls back to the default.
        expect(table.windowContext(0x100)).toBe(def);
    });
});
