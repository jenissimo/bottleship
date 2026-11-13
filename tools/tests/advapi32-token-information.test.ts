/**
 * GetTokenInformation and the SID accessors. Callers size the buffer with a first call
 * (NULL, 0), allocate, call again and then walk the PSID inside the result, e.g.
 * TokenIntegrityLevel -> GetSidSubAuthority(label.Sid, *GetSidSubAuthorityCount - 1).
 * The old stub answered every class with one zero DWORD and TRUE, so the size query
 * reported 0 bytes and the PSID read back as NULL.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Advapi32 } from "../../src/worker/modules/advapi32";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const ERROR_INSUFFICIENT_BUFFER = 122;
const BUF = 0x2000, LEN = 0x1f00;

let mem: Uint8Array;
let view: DataView;
let exports: Record<string, any>;
let lastError = 0;
let spy: { mockRestore(): void } | undefined;
afterEach(() => spy?.mockRestore());

const call = (name: string, ...args: number[]): number => {
    const r = exports[name]!({ esp: 0 } as any, mem, args as any);
    return (typeof r === "number" ? r : r.value) >>> 0;
};

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem);
    const system: any = System.getInstance();
    spy = spyOn(system.scheduler, "setLastError").mockImplementation((e: number) => { lastError = e; });
    const mod = new Advapi32();
    mod.initialize({ resourceProvider: { getKernelObject: () => null } } as any);
    exports = mod.exports;
    lastError = 0;
});

/** The two-call pattern: size query, then the real call into a buffer of that size. */
function query(cls: number): number {
    view.setUint32(LEN, 0xdeadbeef, true);
    expect(call("GetTokenInformation", 0x1acc, cls, 0, 0, LEN)).toBe(0);
    expect(lastError).toBe(ERROR_INSUFFICIENT_BUFFER);
    const size = view.getUint32(LEN, true);
    expect(size).toBeGreaterThan(0);
    expect(call("GetTokenInformation", 0x1acc, cls, BUF, size - 1, LEN)).toBe(0);
    expect(call("GetTokenInformation", 0x1acc, cls, BUF, size, LEN)).toBe(1);
    expect(view.getUint32(LEN, true)).toBe(size);
    return size;
}

const sidString = (p: number) => {
    const n = mem[p + 1]!;
    const subs = Array.from({ length: n }, (_, i) => view.getUint32(p + 8 + i * 4, true));
    return `S-${mem[p]}-${mem[p + 7]}${subs.map(s => `-${s}`).join("")}`;
};

describe("GetTokenInformation", () => {
    test("TokenIntegrityLevel: medium label, PSID inside the buffer, walked with the SID accessors", () => {
        const size = query(25);
        const sid = view.getUint32(BUF, true);
        expect(sid).toBe(BUF + 8);
        expect(view.getUint32(BUF + 4, true)).toBe(0x20);                 // SE_GROUP_INTEGRITY
        expect(sid + call("GetLengthSid", sid)).toBe(BUF + size);
        expect(sidString(sid)).toBe("S-1-16-8192");
        const count = mem[call("GetSidSubAuthorityCount", sid)]!;
        expect(view.getUint32(call("GetSidSubAuthority", sid, count - 1), true)).toBe(0x2000);
    });

    test("TokenUser, TokenOwner and TokenPrimaryGroup carry a user-account SID", () => {
        query(1);
        expect(sidString(view.getUint32(BUF, true))).toMatch(/^S-1-5-21-\d+-\d+-\d+-1000$/);
        query(4);
        const owner = view.getUint32(BUF, true);
        expect(owner).toBe(BUF + 4);
        expect(sidString(owner)).toMatch(/^S-1-5-21-\d+-\d+-\d+-1000$/);
        query(5);
        expect(sidString(view.getUint32(BUF, true))).toMatch(/-513$/);
    });

    test("DWORD classes: primary token, not elevated, session 1", () => {
        for (const [cls, value] of [[8, 1], [12, 1], [18, 1], [20, 0], [29, 0], [2, 0], [3, 0]] as const) {
            expect(query(cls)).toBe(4);
            expect(view.getUint32(BUF, true)).toBe(value);
        }
    });

    test("a class that is not modelled keeps the previous answer", () => {
        view.setUint32(BUF, 0x11111111, true);
        expect(call("GetTokenInformation", 0x1acc, 10, BUF, 64, LEN)).toBe(1);
        expect(view.getUint32(BUF, true)).toBe(0);
        expect(view.getUint32(LEN, true)).toBe(4);
    });
});

describe("SID helpers", () => {
    test("CopySid needs room for the whole SID; EqualSid compares all of it", () => {
        query(1);
        const sid = view.getUint32(BUF, true), len = call("GetLengthSid", sid);
        expect(len).toBe(28);
        expect(call("CopySid", len - 1, 0x4000, sid)).toBe(0);
        expect(lastError).toBe(ERROR_INSUFFICIENT_BUFFER);
        expect(call("CopySid", len, 0x4000, sid)).toBe(1);
        expect(call("EqualSid", sid, 0x4000)).toBe(1);
        mem[0x4000 + len - 1]! ^= 1;
        expect(call("EqualSid", sid, 0x4000)).toBe(0);
    });
});
