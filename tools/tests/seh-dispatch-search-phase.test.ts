/**
 * C++ SEH dispatch — the SEARCH phase.
 *
 * Windows' RtlDispatchException runs a read-only search before any unwinding, and our
 * dispatch has to do the same for one specific reason: the decision to hand a throw to x86
 * SEH (because the chain holds a registration we cannot parse as MSVC C++ EH, typically
 * `_except_handler4`, whose filter may claim the exception) must be taken BEFORE the
 * catch-funclet exit loop writes a frame's try-level, restores PRN_STACK and pops the record
 * plus its active-exception entry. Deciding afterwards drops the exception object's
 * pmfnUnwind and every catch-body local destructor, and leaves a later bare `throw;` with
 * nothing to resolve.
 *
 * These tests pin the two halves that make that possible: the classifier both passes use, and
 * the "defer mutates nothing" property of dispatchCxxException itself.
 */

import { describe, expect, test } from "bun:test";
import {
    classifyCxxFrame,
    dispatchCxxException,
    frameCatchesThrow,
    resetSehDispatchState,
} from "../../src/worker/core/seh-dispatch";

const MEM = 0x40000;
const TEB = 0x100;
const MSVC_MAGIC = 0x19930520;

function mkMem(): { mem: Uint8Array; dv: DataView } {
    const mem = new Uint8Array(MEM);
    return { mem, dv: new DataView(mem.buffer) };
}

/** A registration record: [+0] next, [+4] handler, [+8] state/FuncInfo, [+12] trylevel. */
function writeFrame(dv: DataView, at: number, next: number, handler: number, f8: number, f12: number): void {
    dv.setUint32(at, next >>> 0, true);
    dv.setUint32(at + 4, handler >>> 0, true);
    dv.setUint32(at + 8, f8 >>> 0, true);
    dv.setInt32(at + 12, f12 | 0, true);
}

/** `mov eax, funcInfo; jmp rel32` — the VC7+ handler thunk shape. */
function writeVc7Thunk(mem: Uint8Array, dv: DataView, at: number, funcInfo: number): void {
    mem[at] = 0xB8;
    dv.setUint32(at + 1, funcInfo >>> 0, true);
    mem[at + 5] = 0xE9;
}

/** FuncInfo + one TryBlockMap entry + one HandlerType for `catch (...)`. */
function writeFuncInfo(
    dv: DataView,
    funcInfo: number,
    tryMap: number,
    handlerArray: number,
    catchAddr: number,
    tryLow = 0,
    tryHigh = 0,
): void {
    dv.setUint32(funcInfo + 0, MSVC_MAGIC, true);
    dv.setInt32(funcInfo + 4, 1, true);       // maxState
    dv.setUint32(funcInfo + 8, 0, true);      // pUnwindMap (none)
    dv.setUint32(funcInfo + 12, 1, true);     // nTryBlocks
    dv.setUint32(funcInfo + 16, tryMap, true);

    dv.setInt32(tryMap + 0, tryLow, true);
    dv.setInt32(tryMap + 4, tryHigh, true);
    dv.setInt32(tryMap + 8, tryHigh + 1, true); // catchHigh
    dv.setInt32(tryMap + 12, 1, true);          // nCatches
    dv.setUint32(tryMap + 16, handlerArray, true);

    dv.setUint32(handlerArray + 0, 0, true);          // adjectives
    dv.setUint32(handlerArray + 4, 0, true);          // pType = 0 → catch (...)
    dv.setInt32(handlerArray + 8, 0, true);           // dispCatchObj
    dv.setUint32(handlerArray + 12, catchAddr, true);
}

describe("classifyCxxFrame", () => {
    test("recognizes the VC5/6 layout (FuncInfo at +8, try-level at +12)", () => {
        const { mem, dv } = mkMem();
        const funcInfo = 0x11000;
        dv.setUint32(funcInfo, MSVC_MAGIC, true);
        writeFrame(dv, 0x1000, 0xFFFFFFFF, 0x2000, funcInfo, 3);

        const shape = classifyCxxFrame(dv, mem, 0x1000, 0x2000);
        expect(shape).not.toBeNull();
        expect(shape!.isVC7).toBe(false);
        expect(shape!.funcInfoPtr).toBe(funcInfo);
        expect(shape!.state).toBe(3);
        expect(shape!.stateOffset).toBe(12);
    });

    test("recognizes the VC7+ layout (try-level at +8, FuncInfo out of the handler thunk)", () => {
        const { mem, dv } = mkMem();
        const funcInfo = 0x12000;
        dv.setUint32(funcInfo, MSVC_MAGIC, true);
        writeVc7Thunk(mem, dv, 0x2000, funcInfo);
        writeFrame(dv, 0x1000, 0xFFFFFFFF, 0x2000, 2, 0);

        const shape = classifyCxxFrame(dv, mem, 0x1000, 0x2000);
        expect(shape).not.toBeNull();
        expect(shape!.isVC7).toBe(true);
        expect(shape!.funcInfoPtr).toBe(funcInfo);
        expect(shape!.state).toBe(2);
        expect(shape!.stateOffset).toBe(8);
    });

    test("rejects an __except_handler4-shaped registration", () => {
        const { mem, dv } = mkMem();
        // [+8] is a scope-table pointer, far outside the VC7 try-level range, and the struct
        // it points at carries no MSVC EH magic; the handler is not a `mov eax, imm32` thunk.
        writeFrame(dv, 0x1000, 0xFFFFFFFF, 0x3000, 0x20000, 0);
        mem[0x3000] = 0x8B; // mov ...
        expect(classifyCxxFrame(dv, mem, 0x1000, 0x3000)).toBeNull();
    });
});

describe("frameCatchesThrow", () => {
    test("finds a catch(...) in range and reports it WITHOUT touching memory", () => {
        const { mem, dv } = mkMem();
        writeFuncInfo(dv, 0x12000, 0x12100, 0x12200, 0x13000, 0, 0);
        const before = mem.slice();

        expect(frameCatchesThrow(dv, mem, 0x12000, 0, 0x14000)).toBe(true);
        expect(Array.from(mem)).toEqual(Array.from(before));
    });

    test("a try-level outside [tryLow, tryHigh] does not match", () => {
        const { mem, dv } = mkMem();
        writeFuncInfo(dv, 0x12000, 0x12100, 0x12200, 0x13000, 2, 4);
        expect(frameCatchesThrow(dv, mem, 0x12000, 1, 0x14000)).toBe(false);
        expect(frameCatchesThrow(dv, mem, 0x12000, 3, 0x14000)).toBe(true);
        expect(frameCatchesThrow(dv, mem, 0x12000, 5, 0x14000)).toBe(false);
    });

    test("the CatchGuard depth filter excludes trys not nested inside the running catch", () => {
        const { mem, dv } = mkMem();
        writeFuncInfo(dv, 0x12000, 0x12100, 0x12200, 0x13000, 2, 4);
        // tryLow(2) must be > tryHighAbove and tryHigh(4) <= catchHighMax.
        expect(frameCatchesThrow(dv, mem, 0x12000, 3, 0x14000, { tryHighAbove: 1, catchHighMax: 8 })).toBe(true);
        expect(frameCatchesThrow(dv, mem, 0x12000, 3, 0x14000, { tryHighAbove: 2, catchHighMax: 8 })).toBe(false);
        expect(frameCatchesThrow(dv, mem, 0x12000, 3, 0x14000, { tryHighAbove: 1, catchHighMax: 3 })).toBe(false);
    });
});

describe("dispatchCxxException — the defer verdict", () => {
    const mkCpu = () => ({
        segment_offsets: [0, 0, 0, 0, TEB],
        reg32: new Uint32Array([0, 0, 0, 0, 0x30000, 0x30040, 0, 0]),
        sreg: new Uint16Array(8),
        instruction_pointer: new Int32Array([0x400000]),
    });

    test("an unparseable frame defers to x86 and writes NOTHING", () => {
        resetSehDispatchState();
        const { mem, dv } = mkMem();
        dv.setUint32(TEB, 0x1000, true);
        writeFrame(dv, 0x1000, 0xFFFFFFFF, 0x3000, 0x20000, 0);
        mem[0x3000] = 0x8B;
        const before = mem.slice();

        const res = dispatchCxxException(mem, mkCpu(), 0x15000, 0x14000, 8);
        expect(res).not.toBeNull();
        expect(res && "deferToX86" in res).toBe(true);
        // The whole point: the decision is taken before any state is mutated, so the guest's
        // SEH chain, try-levels and PRN_STACK are exactly as the throw left them.
        expect(Array.from(mem)).toEqual(Array.from(before));
    });

    test("allowDeferToX86:false suppresses the verdict and keeps walking", () => {
        resetSehDispatchState();
        const { mem, dv } = mkMem();
        dv.setUint32(TEB, 0x1000, true);
        writeFrame(dv, 0x1000, 0xFFFFFFFF, 0x3000, 0x20000, 0);
        mem[0x3000] = 0x8B;

        // No catch anywhere, so the walk runs to the end and reports "unhandled" — the point
        // is that it does NOT bail out at the first unparseable frame.
        const res = dispatchCxxException(mem, mkCpu(), 0x15000, 0x14000, 8, { allowDeferToX86: false });
        expect(res).toBeNull();
    });

    test("a C++ frame that would catch is preferred over deferring", () => {
        resetSehDispatchState();
        const { mem, dv } = mkMem();
        const funcInfo = 0x12000;
        writeFuncInfo(dv, funcInfo, 0x12100, 0x12200, 0x13000, 0, 0);
        writeVc7Thunk(mem, dv, 0x2000, funcInfo);
        // Frame #1 is the C++ frame with a matching catch; the unparseable one is BEHIND it.
        writeFrame(dv, 0x1000, 0x1100, 0x2000, 0, 0);
        writeFrame(dv, 0x1100, 0xFFFFFFFF, 0x3000, 0x20000, 0);
        mem[0x3000] = 0x8B;
        dv.setUint32(TEB, 0x1000, true);

        const res = dispatchCxxException(mem, mkCpu(), 0x15000, 0x14000, 8);
        // Whatever the dispatch does next, it must NOT be the x86 hand-off: a catch we can
        // serve stands in front of the frame that would have triggered it.
        expect(res === null || !("deferToX86" in res)).toBe(true);
    });
});
