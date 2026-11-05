/**
 * Which bundle URLs may be copied into OPFS, and what "Clear bundle cache" removes.
 *
 * Dev disk routes (sidecar `/wgb?path=`, Vite `/__wgb/?path=`) used to get the full remote
 * treatment — sparse chunks, background fill, promotion to a whole `.wgb` — so a smoke run
 * across ~60 local bundles left a second multi-GB copy of each in the Chrome profile.
 */

import { describe, expect, test } from "bun:test";
import { diskBundleUrl } from "../../src/utils/bundle-url";
import {
    bundleCacheClearPlan, clearBundleCache, isLocalDiskBundleUrl, shouldPersistBundleUrl,
} from "../../src/worker/runtime/filesystem/wgb-cache-policy";
import { FakeDirHandle } from "./fixtures/fake-opfs";

describe("shouldPersistBundleUrl", () => {
    test("dev disk routes are streamed only, never cached", () => {
        const path = encodeURIComponent("G:\\WGB\\todo\\bod.wgb");
        for (const url of [
            `http://localhost:3001/wgb?path=${path}`,
            `http://127.0.0.1:3001/wgb?path=${path}`,
            `/__wgb/?path=${path}`,
            `http://localhost:5174/__wgb/?path=${path}`,
        ]) {
            expect(isLocalDiskBundleUrl(url)).toBe(true);
            expect(shouldPersistBundleUrl(url)).toBe(false);
        }
    });

    test("both URLs diskBundleUrl can produce are classified as local", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => { throw new TypeError("sidecar down"); }) as unknown as typeof fetch;
        try {
            const { url, via } = await diskBundleUrl("D:\\games\\x.wgb");
            expect(via).toBe("vite");
            expect(shouldPersistBundleUrl(url)).toBe(false);
        } finally { globalThis.fetch = originalFetch; }
        expect(shouldPersistBundleUrl(`http://localhost:3001/wgb?path=${encodeURIComponent("D:\\games\\x.wgb")}`)).toBe(false);
    });

    test("remote and catalog bundles keep the OPFS cache", () => {
        for (const url of [
            "/apps/morrowind.wgb",
            "https://bottleship.example/apps/morrowind.wgb?v=3",
            "/apps/byo/imported.wgb",
            "https://cdn.example/wgb/game.wgb",
            "http://localhost:3001/wgb",            // no path= → not the disk route
            "/__wgb/list",
            "not a url at all",
        ]) {
            expect(shouldPersistBundleUrl(url)).toBe(true);
        }
    });
});

describe("bundleCacheClearPlan", () => {
    test("removes URL copies and streaming sidecars, keeps imported bundles and the LRU file", () => {
        const plan = bundleCacheClearPlan([
            "wgb-1a2b3c4d.wgb", "wgb-1a2b3c4d.wgb.version.json",          // promoted disk-URL copy
            "wgb-99aa00bb.wgb.sparse", "wgb-99aa00bb.wgb.bitmap",         // half-streamed disk URL
            "morrowind.wgb", "morrowind.wgb.version.json",                // downloaded remote bundle
            "xiii.wgb.part",                                              // torn download
            "imported.wgb",                                               // BYO import: no version file
            "_cache-lru.json",
        ]);
        expect(plan).toEqual([
            "morrowind.wgb", "morrowind.wgb.version.json",
            "wgb-1a2b3c4d.wgb", "wgb-1a2b3c4d.wgb.version.json",
            "wgb-99aa00bb.wgb.bitmap", "wgb-99aa00bb.wgb.sparse",
            "xiii.wgb.part",
        ]);
    });

    test("clearBundleCache reports freed bytes and survives a locked file", async () => {
        const dir = new FakeDirHandle("wgb-cache");
        const put = async (name: string, bytes: number) =>
            ((await dir.getFileHandle(name, { create: true })).file.data = new Uint8Array(bytes));
        await put("game-0badf00d.wgb", 1000);
        await put("game-0badf00d.wgb.version.json", 10);
        await put("wgb-12345678.wgb.sparse", 500);
        await put("wgb-12345678.wgb.bitmap", 5);
        await put("imported.wgb", 777);
        const remove = dir.removeEntry.bind(dir);
        dir.removeEntry = async (name: string) => {
            if (name === "wgb-12345678.wgb.sparse") throw Object.assign(new Error("in use"), { name: "NoModificationAllowedError" });
            return remove(name);
        };
        const result = await clearBundleCache(dir as unknown as FileSystemDirectoryHandle);
        expect(result.failed).toEqual(["wgb-12345678.wgb.sparse"]);
        expect(result.freedBytes).toBe(1015);
        expect([...dir.children.keys()].sort()).toEqual(["imported.wgb", "wgb-12345678.wgb.sparse"]);
    });
});
