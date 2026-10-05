/**
 * combase: HSTRING semantics (Wine combase/string.c) and the RoInitialize apartment
 * transitions it shares with CoInitializeEx (combase enter_apartment / leave_apartment).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    HStrings, S_OK, E_INVALIDARG, E_POINTER, HSTRING_REFERENCE_FLAG,
} from "../../src/worker/modules/combase-hstring";
import {
    ComApartments, comApartments, RPC_E_CHANGED_MODE, S_FALSE,
} from "../../src/worker/core/com/apartment";
import { activationApartmentError } from "../../src/worker/modules/combase";
import { resolveThunkedDllAlias } from "../../src/worker/core/dll-aliases";

let mem: Uint8Array;

function makeHeap() {
    let next = 0x8000;
    const live = new Set<number>();
    return {
        live,
        heap: {
            alloc: (bytes: number) => {
                const p = next;
                next += (bytes + 15) & ~15;
                live.add(p);
                return p;
            },
            free: (p: number) => { live.delete(p); },
        },
    };
}

function writeWide(addr: number, s: string): void {
    for (let i = 0; i < s.length; i++) Mem.writeUint16(addr + i * 2, s.charCodeAt(i));
    Mem.writeUint16(addr + s.length * 2, 0);
}

function readWide(addr: number, len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(Mem.readUint16(addr + i * 2)!);
    return s;
}

const SRC = 0x1000;
const OUT = 0x2000;
const OUT2 = 0x2004;
const HEADER = 0x3000;
const LEN_OUT = 0x2008;

describe("HSTRING", () => {
    let strings: HStrings;
    let live: Set<number>;

    beforeEach(() => {
        mem = new Uint8Array(0x20000);
        Mem.bind(() => mem);
        const h = makeHeap();
        live = h.live;
        strings = new HStrings(h.heap);
        writeWide(SRC, "Windows.Foo");
    });

    test("WindowsCreateString copies, terminates and owns one reference", () => {
        expect(strings.create(SRC, 7, OUT)).toBe(S_OK);
        const h = Mem.readUint32(OUT)!;
        expect(h).not.toBe(0);
        expect(strings.length(h)).toBe(7);
        const raw = strings.rawBuffer(h, LEN_OUT);
        expect(raw).not.toBe(SRC);
        expect(readWide(raw, 7)).toBe("Windows");
        expect(Mem.readUint16(raw + 14)).toBe(0);
        expect(Mem.readUint32(LEN_OUT)).toBe(7);
        expect(strings.delete(h)).toBe(S_OK);
        expect(live.has(h)).toBe(false);
    });

    test("argument rules: NULL out, empty, NULL source", () => {
        expect(strings.create(SRC, 3, 0)).toBe(E_INVALIDARG);
        Mem.writeUint32(OUT, 0xdeadbeef);
        expect(strings.create(0, 0, OUT)).toBe(S_OK);
        expect(Mem.readUint32(OUT)).toBe(0);
        expect(strings.create(0, 3, OUT)).toBe(E_POINTER);
    });

    test("a fast-pass reference lives in the caller's header and is never freed", () => {
        expect(strings.createReference(SRC, 11, HEADER, OUT)).toBe(S_OK);
        const h = Mem.readUint32(OUT)!;
        expect(h).toBe(HEADER);
        expect(Mem.readUint32(HEADER)).toBe(HSTRING_REFERENCE_FLAG);
        expect(Mem.readUint32(HEADER + 4)).toBe(11);
        expect(Mem.readUint32(HEADER + 16)).toBe(SRC);
        expect(strings.rawBuffer(h, 0)).toBe(SRC);
        expect(live.size).toBe(0);
        expect(strings.delete(h)).toBe(S_OK);
    });

    test("a reference requires the terminator at [length]", () => {
        expect(strings.createReference(SRC, 7, HEADER, OUT)).toBe(E_INVALIDARG);
        expect(strings.createReference(SRC, 11, 0, OUT)).toBe(E_INVALIDARG);
        expect(strings.createReference(SRC, 11, HEADER, 0)).toBe(E_INVALIDARG);
        expect(strings.createReference(0, 5, HEADER, OUT)).toBe(E_POINTER);
    });

    test("duplicate shares an owned string and promotes a reference to a copy", () => {
        strings.create(SRC, 11, OUT);
        const owned = Mem.readUint32(OUT)!;
        expect(strings.duplicate(owned, OUT2)).toBe(S_OK);
        expect(Mem.readUint32(OUT2)).toBe(owned);
        strings.delete(owned);
        expect(live.has(owned)).toBe(true);    // one reference remains
        strings.delete(owned);
        expect(live.has(owned)).toBe(false);

        strings.createReference(SRC, 11, HEADER, OUT);
        expect(strings.duplicate(HEADER, OUT2)).toBe(S_OK);
        const copy = Mem.readUint32(OUT2)!;
        expect(copy).not.toBe(HEADER);
        expect(readWide(strings.rawBuffer(copy, 0), 11)).toBe("Windows.Foo");
    });

    test("NULL is the empty string everywhere", () => {
        expect(strings.length(0)).toBe(0);
        expect(strings.isEmpty(0)).toBe(true);
        Mem.writeUint32(LEN_OUT, 99);
        const raw = strings.rawBuffer(0, LEN_OUT);
        expect(raw).not.toBe(0);
        expect(Mem.readUint16(raw)).toBe(0);
        expect(Mem.readUint32(LEN_OUT)).toBe(0);
        expect(strings.delete(0)).toBe(S_OK);
        expect(strings.duplicate(0, OUT)).toBe(S_OK);
        expect(Mem.readUint32(OUT)).toBe(0);
    });
});

describe("apartments (RoInitialize / CoInitializeEx)", () => {
    test("first init fixes the model; same model is S_FALSE and counted; other model is refused", () => {
        const apts = new ComApartments();
        expect(apts.enter(1, "mta")).toBe(S_OK);            // RoInitialize(RO_INIT_MULTITHREADED)
        expect(apts.enter(1, "mta")).toBe(S_FALSE);
        expect(apts.enter(1, "sta") >>> 0).toBe(RPC_E_CHANGED_MODE);
        apts.leave(1);
        expect(apts.model(1)).toBe("mta");                    // one init still outstanding
        apts.leave(1);
        expect(apts.model(1)).toBeUndefined();                // the refused call was not counted
        expect(apts.enter(1, "sta")).toBe(S_OK);
    });

    test("COINIT flags pick the model", () => {
        expect(ComApartments.modelFromCoInit(0x2)).toBe("sta");
        expect(ComApartments.modelFromCoInit(0x2 | 0x4)).toBe("sta");
        expect(ComApartments.modelFromCoInit(0x0)).toBe("mta");
    });

    test("OleInitialize reports repeated OLE init, and OleUninitialize without it is a no-op", () => {
        const apts = new ComApartments();
        expect(apts.enter(1, "sta")).toBe(S_OK);
        expect(apts.enterOle(1)).toBe(S_OK);
        expect(apts.enterOle(1)).toBe(S_FALSE);
        expect(apts.isOleInitialized(1)).toBe(true);
        apts.leaveOle(1);
        apts.leaveOle(1);
        expect(apts.isOleInitialized(1)).toBe(false);
        expect(apts.model(1)).toBe("sta");
        apts.leaveOle(1);
        expect(apts.model(1)).toBe("sta");
        expect(apts.enter(2, "mta")).toBe(S_OK);
        expect(apts.enterOle(2) >>> 0).toBe(RPC_E_CHANGED_MODE);
    });

    test("activation needs an apartment, or an MTA to join implicitly", () => {
        comApartments.reset();
        expect(activationApartmentError(7)).toBe(0x800401f0);    // CO_E_NOTINITIALIZED
        comApartments.enter(3, "sta");
        expect(activationApartmentError(3)).toBe(0);
        expect(activationApartmentError(7)).toBe(0x800401f0);
        comApartments.enter(4, "mta");
        expect(activationApartmentError(7)).toBe(0);
        comApartments.reset();
    });
});

describe("module identity", () => {
    test("the WinRT API sets resolve to combase", () => {
        expect(resolveThunkedDllAlias("api-ms-win-core-winrt-l1-1-0.dll")).toBe("combase");
        expect(resolveThunkedDllAlias("API-MS-WIN-CORE-WINRT-STRING-L1-1-0")).toBe("combase");
    });
});
