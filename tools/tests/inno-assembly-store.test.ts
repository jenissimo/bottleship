import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInnoAssemblyStore } from "../internal/inno-assembly-store";

function fixture() {
    mkdirSync(resolve("logs"), { recursive: true });
    return mkdtempSync(resolve("logs/inno-assembly-store-"));
}

test("Galaxy assembly stores out-of-order segments on disk with zero-filled gaps and bounded reads", () => {
    const dir = fixture(), size = 16 * 1024 * 1024 + 37;
    const store = createInnoAssemblyStore(dir, size);
    try {
        expect(store.size).toBe(size);
        const files = readdirSync(dir); expect(files).toHaveLength(1);
        expect(statSync(join(dir, files[0]!)).size).toBe(size);
        store.writeAt(new Uint8Array([8, 9]), size - 2);
        store.writeAt(new Uint8Array([1, 2, 3]), 0);
        store.writeAt(new Uint8Array([4, 5, 6]), 3);
        // A subarray write must use its own offset, not the backing buffer's prefix.
        store.writeAt(new Uint8Array([99, 7, 88]).subarray(1, 2), size - 3);
        expect([...store.readRangeSync(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
        expect([...store.readRangeSync(size - 4, size)]).toEqual([0, 7, 8, 9]);
        expect(store.readRangeSync(size, size)).toHaveLength(0);
        store.writeAt(new Uint8Array(0), size);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("assembly size and range validation rejects unsafe values before creating or modifying files", () => {
    const dir = fixture();
    try {
        for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => createInnoAssemblyStore(dir, size)).toThrow(/size/);
        }
        expect(readdirSync(dir)).toHaveLength(0);
        const store = createInnoAssemblyStore(dir, 4);
        try {
            for (const [start, end] of [[-1, 1], [0, 5], [3, 2], [0.5, 2], [0, Infinity], [NaN, 1]]) {
                expect(() => store.readRangeSync(start!, end!)).toThrow(/range/);
            }
            for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 4]) {
                expect(() => store.writeAt(new Uint8Array([1]), offset)).toThrow(/range/);
            }
            expect([...store.readRangeSync(0, 4)]).toEqual([0, 0, 0, 0]);
        } finally { store.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assembly cleanup is idempotent and preserves unrelated files", () => {
    const dir = fixture(), keep = join(dir, "keep.txt");
    writeFileSync(keep, "keep");
    const store = createInnoAssemblyStore(dir, 0);
    store.close(); store.close();
    try {
        expect(readdirSync(dir)).toEqual(["keep.txt"]);
        expect(readFileSync(keep, "utf8")).toBe("keep");
        expect(() => store.readRangeSync(0, 0)).toThrow(/closed/);
        expect(() => store.writeAt(new Uint8Array(0), 0)).toThrow(/closed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assembly reads reject external truncation instead of returning a short or zero-filled result", () => {
    const dir = fixture(), store = createInnoAssemblyStore(dir, 16);
    try {
        const path = join(dir, readdirSync(dir)[0]!);
        truncateSync(path, 3);
        expect(() => store.readRangeSync(0, 16)).toThrow(/short read/);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("assembly close unlinks only its original scratch file if its path was replaced", () => {
    const dir = fixture(), store = createInnoAssemblyStore(dir, 4);
    const path = join(dir, readdirSync(dir)[0]!), moved = join(dir, "moved-original.tmp");
    try {
        renameSync(path, moved); writeFileSync(path, "foreign");
        store.close();
        expect(readFileSync(path, "utf8")).toBe("foreign");
        expect(existsSync(moved)).toBe(true);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
