/**
 * PathCombine's contract, which is NOT PathAppend's — the difference decides whether a
 * launcher can build the path to the module it is about to run. Cases follow the documented
 * behaviour (and Wine's kernelbase implementation of it): a rooted `file` replaces `dir`,
 * a backslash-leading `file` keeps only `dir`'s root, and failure means an EMPTY destination
 * plus NULL, not a stale buffer the caller would happily use.
 */
import { describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { Shlwapi } from "../../src/worker/modules/shlwapi";
import { shlwapiModule } from "../../src/worker/api/shlwapi.api";

const mem = new Uint8Array(0x10000);
const shlwapi = new Shlwapi();
shlwapi.initialize({} as never);

const DEST = 0x1000;
const DIR = 0x2000;
const FILE = 0x3000;

function writeWide(ptr: number, value: string): void {
    for (let i = 0; i < value.length; i++) {
        mem[ptr + i * 2] = value.charCodeAt(i) & 0xff;
        mem[ptr + i * 2 + 1] = value.charCodeAt(i) >>> 8;
    }
    mem[ptr + value.length * 2] = 0;
    mem[ptr + value.length * 2 + 1] = 0;
}

function readWide(ptr: number): string {
    let out = "";
    for (let i = 0; ; i++) {
        const ch = mem[ptr + i * 2]! | (mem[ptr + i * 2 + 1]! << 8);
        if (ch === 0) return out;
        out += String.fromCharCode(ch);
    }
}

/** Returns [returned pointer, destination contents]. A null `dir`/`file` passes NULL. */
function combineW(dir: string | null, file: string | null): [number, string] {
    mem.fill(0, DEST, DEST + 0x600);
    if (dir !== null) writeWide(DIR, dir);
    if (file !== null) writeWide(FILE, file);
    Mem.bind(() => mem);
    const out = shlwapi.exports["PathCombineW"]!({} as never, mem, [
        DEST,
        dir === null ? 0 : DIR,
        file === null ? 0 : FILE,
    ]) as { value: number };
    return [out.value, readWide(DEST)];
}

describe("shlwapi PathCombine", () => {
    test("is declared with its native arity", () => {
        const arity = (name: string) => shlwapiModule.functions.find((fn) => fn.name === name)?.params.length;
        expect(arity("PathCombineW")).toBe(3);
        expect(arity("PathCombineA")).toBe(3);
    });

    test("joins a directory and a relative file", () => {
        expect(combineW("C:\\game\\RA3", "Data\\ra3_1.10.game")).toEqual([
            DEST,
            "C:\\game\\RA3\\Data\\ra3_1.10.game",
        ]);
    });

    test("does not double a separator the directory already ends with", () => {
        expect(combineW("C:\\", "RA3.exe")[1]).toBe("C:\\RA3.exe");
        expect(combineW("C:\\game\\", "RA3.exe")[1]).toBe("C:\\game\\RA3.exe");
    });

    test("keeps a trailing separator, which the caller may be about to append to", () => {
        expect(combineW("C:\\", "Launcher\\")[1]).toBe("C:\\Launcher\\");
        expect(combineW("C:\\game\\RA3\\", null)[1]).toBe("C:\\game\\RA3\\");
    });

    test("canonicalizes the result", () => {
        expect(combineW("C:\\game\\RA3", "..\\Uprising\\RA3EP1.exe")[1]).toBe("C:\\game\\Uprising\\RA3EP1.exe");
    });

    test("a rooted file replaces the directory entirely", () => {
        expect(combineW("C:\\game\\RA3", "D:\\other\\x.exe")[1]).toBe("D:\\other\\x.exe");
    });

    test("a backslash-leading file keeps only the directory's ROOT", () => {
        expect(combineW("C:\\game\\RA3", "\\Windows\\x.exe")[1]).toBe("C:\\Windows\\x.exe");
    });

    test("a UNC file replaces the directory rather than being re-rooted", () => {
        expect(combineW("C:\\game\\RA3", "\\\\server\\share\\x.exe")[1]).toBe("\\\\server\\share\\x.exe");
    });

    test("either side alone is used when the other is NULL or empty", () => {
        expect(combineW("C:\\game\\RA3", null)[1]).toBe("C:\\game\\RA3");
        expect(combineW("C:\\game\\RA3", "")[1]).toBe("C:\\game\\RA3");
        expect(combineW(null, "RA3.exe")[1]).toBe("RA3.exe");
        expect(combineW("", "RA3.exe")[1]).toBe("RA3.exe");
    });

    test("two NULLs fail with an EMPTY destination — the caller must not read a stale buffer", () => {
        writeWide(DEST, "stale");
        Mem.bind(() => mem);
        const out = shlwapi.exports["PathCombineW"]!({} as never, mem, [DEST, 0, 0]) as { value: number };
        expect(out.value).toBe(0);
        expect(readWide(DEST)).toBe("");
    });

    test("a result past MAX_PATH fails instead of truncating", () => {
        const [ptr, dest] = combineW("C:\\game", "x".repeat(300));
        expect(ptr).toBe(0);
        expect(dest).toBe("");
    });
});
