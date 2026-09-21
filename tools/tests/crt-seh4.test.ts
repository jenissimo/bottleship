/**
 * `_except_handler4_common` is VC8's single SEH entry point, and it shares the scope-table
 * walk with `_except_handler3`. Two things separate them, and both are silent when wrong:
 * the frame's scope-table pointer is XORed with the module's security cookie, and the
 * records start 16 bytes into the table, after the cookie header. Read either as V3 and the
 * walk finds a filter of 0 at every level — every exception goes unhandled.
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { registerCrtSeh3Exports } from "../../src/worker/modules/crt-seh3";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const mem = new Uint8Array(0x20000);
const view = new DataView(mem.buffer);

const COOKIE_PTR = 0x1000;
const COOKIE = 0xbb40e64e;
const SCOPE = 0x2000;      // real scope table (records at SCOPE + 16)
const FRAME = 0x3000;
const EXC_REC = 0x4000;
const CONTEXT = 0x5000;

// A real register file: the handler bails out early without one, and every assertion below
// would then pass on the bail rather than on the walk it is meant to check.
const reg32 = new Int32Array(8);
const exports: Record<string, ThunkImplementation> = {};
registerCrtSeh3Exports(exports, {
    process: {
        v86: { cpu: { reg32 } },
        dispatcher: {
            notifySehDispatchAborted: () => {},
            prepareEh3ComplexFilterRedirect: () => true,
        },
    } as never,
    terminateProcess: () => ({ value: 0 }),
});

function resetMemory(): void {
    mem.fill(0);
    view.setUint32(COOKIE_PTR, COOKIE, true);
    // EXCEPTION_RECORD: code = STATUS_ACCESS_VIOLATION, flags = 0 (not unwinding)
    view.setUint32(EXC_REC, 0xc0000005, true);
    view.setUint32(EXC_REC + 4, 0, true);
    // Frame: prev, handler, ENCODED scope table, trylevel
    view.setUint32(FRAME, 0, true);
    view.setUint32(FRAME + 4, 0, true);
    view.setUint32(FRAME + 8, (SCOPE ^ COOKIE) >>> 0, true);
    view.setInt32(FRAME + 12, 0, true);
    // Cookie header — four dwords the walk must SKIP, given values that would look like a
    // perfectly plausible record if it did not.
    view.setInt32(SCOPE + 0, -2, true);
    view.setUint32(SCOPE + 4, 0xdeadbeef, true);
    view.setInt32(SCOPE + 8, -2, true);
    view.setUint32(SCOPE + 12, 0xfeedface, true);
}

/** Record[level] = (previousTryLevel, filter, handler). */
function writeRecord(level: number, prev: number, filter: number, handler: number): void {
    const at = SCOPE + 16 + level * 12;
    view.setInt32(at, prev, true);
    view.setUint32(at + 4, filter, true);
    view.setUint32(at + 8, handler, true);
}

function call(): number {
    Mem.bind(() => mem);
    // (cookie, check_cookie, rec, frame, context, dispatcher)
    const out = exports["_except_handler4_common"]!({} as never, mem, [
        COOKIE_PTR, 0, EXC_REC, FRAME, CONTEXT, 0,
    ]);
    return typeof out === "number" ? out : (out as { value: number }).value;
}

describe("_except_handler4_common", () => {
    test("is registered by the same module that owns _except_handler3", () => {
        expect(typeof exports["_except_handler4_common"]).toBe("function");
        expect(typeof exports["_except_handler3"]).toBe("function");
        expect(typeof exports["_local_unwind4"]).toBe("function");
    });

    test("decodes the scope table with the cookie and skips the cookie header", () => {
        resetMemory();
        // A filter of 0 is a __finally: the walk must reach the ENCLOSING level (-1) and
        // report ContinueSearch — which it can only do by landing on the real records.
        writeRecord(0, -1, 0, 0x8000);
        expect(call()).toBe(1); // ExceptionContinueSearch
    });

    test("a frame with no handler at any level continues the search", () => {
        resetMemory();
        view.setInt32(FRAME + 12, 1, true);
        writeRecord(0, -1, 0, 0);
        writeRecord(1, 0, 0, 0);
        expect(call()).toBe(1);
    });

    test("an unwinding exception runs the local unwind and continues the search", () => {
        resetMemory();
        view.setUint32(EXC_REC + 4, 0x02, true); // EXCEPTION_UNWINDING
        view.setInt32(FRAME + 12, 0, true);
        writeRecord(0, -1, 0, 0x8000);
        expect(call()).toBe(1);
        // The unwind walked to the enclosing level rather than staying put.
        expect(view.getInt32(FRAME + 12, true)).toBe(-1);
    });

    test("a wrong cookie cannot be mistaken for a valid table", () => {
        resetMemory();
        view.setUint32(COOKIE_PTR, (COOKIE ^ 0x1234) >>> 0, true);
        expect(call()).toBe(1);
    });
});
