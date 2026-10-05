/**
 * WGB cache identity + poison rejection.
 *
 * Both failures this pins were live on disk at once: the dev sidecar serves every bundle
 * from `/wgb?path=...`, so a key built from the last path segment filed all of them under
 * "wgb"; and Vite answers a missing `.wgb` with HTTP 200 and 1676 bytes of its index page,
 * which streamed into the cache under the bundle's name and failed every later launch with
 * "EOCD not found". Neither is visible from the outside — the game just stops starting.
 */

import { describe, expect, test } from "bun:test";
import { WgbCache } from "../../src/worker/runtime/filesystem/wgb-cache";

const { urlToCacheKey, hasZipEocd } = WgbCache.__testing;

/** Minimal SyncAccessHandleLike over a byte array — only read/getSize are exercised. */
const handleOver = (bytes: Uint8Array) => ({
    read(buf: Uint8Array, opts?: { at?: number }): number {
        const at = opts?.at ?? 0;
        const n = Math.max(0, Math.min(buf.length, bytes.length - at));
        buf.set(bytes.subarray(at, at + n));
        return n;
    },
    write(): number { throw new Error("not used"); },
    truncate(): void { throw new Error("not used"); },
    flush(): void { /* not used */ },
    close(): void { /* not used */ },
    getSize(): number { return bytes.length; },
});

const zipWithEocd = (payload: number, comment = 0): Uint8Array => {
    const bytes = new Uint8Array(payload + 22 + comment);
    const view = new DataView(bytes.buffer);
    view.setUint32(payload, 0x06054b50, true);
    view.setUint16(payload + 20, comment, true);
    return bytes;
};

describe("urlToCacheKey", () => {
    test("a plain bundle URL keeps its filename, query or not", () => {
        expect(urlToCacheKey("/apps/re-volt.wgb")).toBe("re-volt.wgb");
        expect(urlToCacheKey("/apps/re-volt.wgb?v=2")).toBe("re-volt.wgb");
        expect(urlToCacheKey("http://host/apps/re-volt.wgb")).toBe("re-volt.wgb");
    });

    // The sidecar route: the bundle is named in the query and nowhere else.
    test("bundles that differ only in the query get different keys", () => {
        const a = urlToCacheKey("http://localhost:3001/wgb?path=g%3A%2FWGB%2Fkknd2.wgb");
        const b = urlToCacheKey("http://localhost:3001/wgb?path=g%3A%2FWGB%2Fquake2.wgb");
        expect(a).not.toBe(b);
        expect(a).not.toBe("wgb");
        expect(a.endsWith(".wgb")).toBe(true);
    });

    test("the same URL always maps to the same key", () => {
        const url = "http://localhost:3001/wgb?path=g%3A%2FWGB%2Fkknd2.wgb";
        expect(urlToCacheKey(url)).toBe(urlToCacheKey(url));
    });

    test("a URL with no usable segment still yields a key", () => {
        expect(urlToCacheKey("")).toBe("game.wgb");
    });
});

describe("hasZipEocd", () => {
    test("accepts a ZIP, with or without a trailing comment", () => {
        expect(hasZipEocd(handleOver(zipWithEocd(1024)), 1024 + 22)).toBe(true);
        const commented = zipWithEocd(1024, 300);
        expect(hasZipEocd(handleOver(commented), commented.length)).toBe(true);
    });

    // The exact poison found on disk: Vite's 1676-byte index.html, cached as a bundle.
    test("rejects an HTML error page served with HTTP 200", () => {
        const html = new TextEncoder().encode(
            "<!doctype html><html><head><title>Vite</title></head><body>" + "x".repeat(1600) + "</body></html>");
        expect(html.length).toBeGreaterThan(1000);
        expect(hasZipEocd(handleOver(html), html.length)).toBe(false);
    });

    test("rejects a truncated bundle — the tail, where the EOCD lives, is what is missing", () => {
        const full = zipWithEocd(4096);
        const truncated = full.subarray(0, full.length - 40);
        expect(hasZipEocd(handleOver(truncated), truncated.length)).toBe(false);
    });

    test("rejects empty and sub-EOCD files", () => {
        expect(hasZipEocd(handleOver(new Uint8Array(0)), 0)).toBe(false);
        expect(hasZipEocd(handleOver(new Uint8Array(21)), 21)).toBe(false);
    });
});
