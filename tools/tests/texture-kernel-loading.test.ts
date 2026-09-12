/**
 * The loader's decline paths. A kernel that fails to load must leave every
 * caller on its TypeScript path, never install a half-built instance.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTextureKernel, supportsTextureSimd, DXT_KERNEL_URL, DXT_KERNEL_SIMD_URL } from "../../src/worker/backends/webgpu/shared/dxt-kernel";

const asset = (name: string) => readFileSync(resolve(import.meta.dir, "../../public", name));
const scalar = asset("dxt-kernel.wasm");
const simd = asset("dxt-kernel-simd.wasm");

test("SIMD support is probed by validating a v128 module, not by executing one", () => {
    assert.equal(typeof supportsTextureSimd(), "boolean");
});

test("exactly one asset is fetched, chosen by SIMD support", async () => {
    for (const supported of [false, true]) {
        const urls: string[] = [];
        const request = (async (url: string) => {
            urls.push(url);
            return new Response(supported ? simd : scalar);
        }) as unknown as typeof fetch;
        const loaded = await loadTextureKernel(request, supported);
        assert.equal(loaded.variant, supported ? "simd" : "scalar");
        assert.equal(loaded.warning, null);
        assert.deepEqual(urls, [supported ? DXT_KERNEL_SIMD_URL : DXT_KERNEL_URL]);
    }
});

test("a SIMD fetch, compile or ABI failure retries the scalar module", async () => {
    for (const failure of ["http", "compile", "abi", "network"]) {
        let calls = 0;
        const request = (async () => {
            if (calls++ > 0) return new Response(scalar);
            if (failure === "http") return new Response("", { status: 404 });
            if (failure === "network") throw new TypeError("network down");
            // "abi" is a valid empty module: it instantiates, exports nothing.
            return new Response(failure === "compile"
                ? new Uint8Array([1, 2, 3])
                : new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        }) as typeof fetch;
        const loaded = await loadTextureKernel(request, true);
        assert.equal(loaded.variant, "scalar", failure);
        assert.equal(calls, 2, failure);
        assert.match(loaded.warning!, /SIMD unavailable/);
    }
});

test("both variants failing rejects rather than installing a broken kernel", async () => {
    const request = (async () => new Response("", { status: 404 })) as typeof fetch;
    await assert.rejects(loadTextureKernel(request, true), /HTTP 404/);
});
