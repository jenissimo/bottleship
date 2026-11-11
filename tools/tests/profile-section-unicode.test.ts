/**
 * GetPrivateProfileSection[A|W] and Unicode profiles. Sudden Strike 3 keeps all its UI text
 * in Locale.lng, a UTF-8 file with a byte-order mark, and reads it one section at a time
 * through GetPrivateProfileSectionW. The BOM must not glue itself onto the first section
 * header, entries keep the case they were written in, and the list is double-NUL closed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { exports as profile, resetIniCache } from "../../src/worker/modules/kernel32/profile";

const system = System.getInstance() as any;
const saved = { fileSystem: system.fileSystem };
let mem: Uint8Array;
const NAME = 0x1000, FILE = 0x1400, OUT = 0x2000;

function install(files: Record<string, Uint8Array>) {
    system.fileSystem = {
        resolvePath: (p: string) => p,
        openSync: (p: string) => (p in files ? { path: p } : null),
        getFileSize: (p: string) => files[p]?.length ?? 0,
        readSync: (h: { path: string }) => files[h.path],
    };
}

function wide(at: number, s: string) {
    for (let i = 0; i < s.length; i++) new DataView(mem.buffer).setUint16(at + i * 2, s.charCodeAt(i), true);
    new DataView(mem.buffer).setUint16(at + s.length * 2, 0, true);
}

function ansi(at: number, s: string) {
    mem.set(new TextEncoder().encode(s + "\0"), at);
}

function readWideList(at: number): string[] {
    const out: string[] = [];
    const dv = new DataView(mem.buffer);
    let cur = "";
    for (let i = 0; ; i++) {
        const c = dv.getUint16(at + i * 2, true);
        if (c === 0) { if (!cur) break; out.push(cur); cur = ""; } else cur += String.fromCharCode(c);
    }
    return out;
}

beforeEach(() => {
    mem = new Uint8Array(1 << 16);
    Mem.bind(() => mem);
    resetIniCache();
});
afterEach(() => { system.fileSystem = saved.fileSystem; resetIniCache(); });

const call = (name: string, ...args: number[]) => (profile[name] as any)({}, mem, args) as number;

test("a UTF-8 profile with BOM is read section by section through the W API", () => {
    const text = "\uFEFF[Base]\r\n1=Select units|Left double click\r\n2=Äpfel\r\n; note\r\n\r\n[Menu]\r\nPlay=Play\r\n";
    install({ "C:\\G\\Locale.lng": new TextEncoder().encode(text) });
    wide(NAME, "Base");
    wide(FILE, "C:\\G\\Locale.lng");
    const n = call("GetPrivateProfileSectionW", NAME, OUT, 512, FILE);
    expect(readWideList(OUT)).toEqual(["1=Select units|Left double click", "2=Äpfel"]);
    expect(n).toBe("1=Select units|Left double click".length + 1 + "2=Äpfel".length + 1);
});

test("the A API keeps the key's case and reports truncation as nSize-2", () => {
    install({ "C:\\G\\a.ini": new TextEncoder().encode("[Mounts]\r\nDecals=Media/Decals.pack\r\nDescs=Media/Descs.pack\r\n") });
    ansi(NAME, "mounts");
    ansi(FILE, "C:\\G\\a.ini");
    const n = call("GetPrivateProfileSectionA", NAME, OUT, 256, FILE);
    expect(new TextDecoder().decode(mem.subarray(OUT, OUT + n))).toBe("Decals=Media/Decals.pack\0Descs=Media/Descs.pack\0");
    expect(mem[OUT + n]).toBe(0);
    // A fresh, garbage-filled buffer: nothing from an earlier call may mask a stale unit.
    mem.fill(0x41, OUT, OUT + 64);
    expect(call("GetPrivateProfileSectionA", NAME, OUT, 30, FILE)).toBe(28);
    expect(new TextDecoder().decode(mem.subarray(OUT, OUT + 30))).toBe("Decals=Media/Decals.pack\0Des\0\0");
    expect(mem[OUT + 30]).toBe(0x41);
});

test("truncation: a W buffer is counted in characters and the cut entry ends at nSize-2", () => {
    install({ "C:\\G\\a.ini": new TextEncoder().encode("[S]\r\nab=1\r\ncd=2\r\n") });
    wide(NAME, "S");
    wide(FILE, "C:\\G\\a.ini");
    const dv = new DataView(mem.buffer);
    const fill = () => { for (let i = 0; i < 32; i++) dv.setUint16(OUT + i * 2, 0x41, true); };
    // "ab=1\0" is 5 units; nSize 8 leaves room for 1 unit of "cd=2".
    fill();
    expect(call("GetPrivateProfileSectionW", NAME, OUT, 8, FILE)).toBe(6);
    expect([...Array(8).keys()].map((i) => dv.getUint16(OUT + i * 2, true))).toEqual([97, 98, 61, 49, 0, 99, 0, 0]);
    expect(dv.getUint16(OUT + 16, true)).toBe(0x41);
    // Exact fit of the first entry: the terminator of the whole entry lands on nSize-2.
    fill();
    expect(call("GetPrivateProfileSectionW", NAME, OUT, 6, FILE)).toBe(4);
    expect([...Array(6).keys()].map((i) => dv.getUint16(OUT + i * 2, true))).toEqual([97, 98, 61, 49, 0, 0]);
});

test("nSize 0, 1 and 2 never write past the buffer", () => {
    install({ "C:\\G\\a.ini": new TextEncoder().encode("[S]\r\nab=1\r\n") });
    ansi(NAME, "S");
    ansi(FILE, "C:\\G\\a.ini");
    for (const [n, expectBytes] of [[0, [0x41, 0x41, 0x41]], [1, [0, 0x41, 0x41]], [2, [0, 0, 0x41]]] as const) {
        mem.fill(0x41, OUT, OUT + 8);
        expect(call("GetPrivateProfileSectionA", NAME, OUT, n, FILE)).toBe(0);
        expect([...mem.subarray(OUT, OUT + 3)]).toEqual(expectBytes as unknown as number[]);
    }
});

test("a UTF-16LE profile with BOM is read through both the A and the W API", () => {
    const text = "\uFEFF[Base]\r\nk=v\r\nname=\u00C4pfel\r\n";
    const u16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) new DataView(u16.buffer).setUint16(i * 2, text.charCodeAt(i), true);
    install({ "C:\\G\\u.ini": u16 });
    ansi(NAME, "Base");
    ansi(FILE, "C:\\G\\u.ini");
    const n = call("GetPrivateProfileSectionA", NAME, OUT, 256, FILE);
    expect(n).toBe("k=v".length + 1 + "name=\xC4pfel".length + 1);
    expect(new TextDecoder("latin1").decode(mem.subarray(OUT, OUT + n))).toBe("k=v\0name=\xC4pfel\0");
    wide(NAME, "Base");
    wide(FILE, "C:\\G\\u.ini");
    call("GetPrivateProfileSectionW", NAME, OUT, 256, FILE);
    expect(readWideList(OUT)).toEqual(["k=v", "name=\u00C4pfel"]);
});

test("a missing section is an empty, double-NUL list", () => {
    install({ "C:\\G\\a.ini": new TextEncoder().encode("[A]\r\nx=1\r\n") });
    wide(NAME, "B");
    wide(FILE, "C:\\G\\a.ini");
    mem.fill(0x55, OUT, OUT + 8);
    expect(call("GetPrivateProfileSectionW", NAME, OUT, 16, FILE)).toBe(0);
    expect(mem[OUT]).toBe(0);
    expect(mem[OUT + 2]).toBe(0);
});
