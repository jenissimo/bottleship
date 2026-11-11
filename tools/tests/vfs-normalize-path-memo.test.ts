import { afterEach, expect, test } from "bun:test";
import { normalizePath } from "../../src/worker/runtime/filesystem/vfs";

const g = globalThis as { __vfsPathMemo?: boolean };
afterEach(() => { delete g.__vfsPathMemo; });

const CASES = ["C:\\save\\scr0", "c:/save/./x/../scr0", "save\\scr0", "D:\\a\\\\b\\", "C:", "\\\\x\\..\\..\\y"];

test("remembered normalization equals the uncached one", () => {
    const cached = CASES.map((p) => [normalizePath(p), normalizePath(p)]);
    g.__vfsPathMemo = false;
    const plain = CASES.map((p) => normalizePath(p));
    expect(cached.map((c) => c[0])).toEqual(plain);
    expect(cached.map((c) => c[1])).toEqual(plain);
    expect(plain[0]).toBe("C:\\save\\scr0");
    expect(plain[1]).toBe("C:\\save\\scr0");
});

test("a repeated path skips the split", () => {
    const orig = String.prototype.split;
    let splits = 0;
    String.prototype.split = function (this: string, ...a: unknown[]) { splits++; return (orig as any).apply(this, a); } as typeof orig;
    try {
        normalizePath("C:\\memo\\probe.bin");
        const first = splits;
        normalizePath("C:\\memo\\probe.bin");
        expect(splits).toBe(first);
        g.__vfsPathMemo = false;
        normalizePath("C:\\memo\\probe.bin");
        expect(splits).toBeGreaterThan(first);
    } finally {
        String.prototype.split = orig;
    }
});
