/**
 * Streaming instantiation for the v86 core module.
 *
 * WHY: V8 keeps an implicit cache of *compiled* wasm code, keyed by the response URL and
 * stored alongside the HTTP cache entry. It engages only for the streaming entry points
 * (`WebAssembly.compileStreaming` / `instantiateStreaming`) and only above a size threshold
 * (~128 KB). v86's built-in loader downloads the bytes first and calls the buffer form
 * `WebAssembly.instantiate(bytes)`, so our 2.4 MB core module misses the cache on every single
 * cold start and is recompiled from scratch each time. v86 exposes an `options.wasm_fn` hook
 * precisely so an embedder can replace that; this is that replacement.
 *
 * Falls back to the buffer form whenever streaming cannot be used — most importantly when the
 * server does not serve `application/wasm` (streaming rejects with a TypeError), which is why
 * the fallback is unconditional rather than feature-flagged: correctness never depends on it.
 *
 * Note the cache only pays off across loads when the URL is stable. In DEV the worker
 * deliberately cache-busts `/v86.wasm?t=…` (see emulator.worker.ts), so DEV always recompiles —
 * that is intended, and the win here is a production one.
 */

import { Logger, LogCategory } from "./logger";

export interface StreamingWasmLoader {
    /** Passed to v86 as `options.wasm_fn`. */
    wasmFn: (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports>;
    /**
     * Raw module bytes, resolved once the module is fetched — v86 stores these as
     * `wasm_source` and transfers them to a helper worker when decompressing `.zst` images.
     * Resolves `null` if the bytes could not be captured; that only disables the zstd-worker
     * path, which BottleShip does not use (it mounts its own filesystem).
     */
    sourceBytes: Promise<ArrayBuffer | null>;
}

export function createStreamingWasmLoader(url: string): StreamingWasmLoader {
    let resolveBytes: (b: ArrayBuffer | null) => void;
    const sourceBytes = new Promise<ArrayBuffer | null>(r => { resolveBytes = r; });

    const wasmFn = async (imports: WebAssembly.Imports): Promise<WebAssembly.Exports> => {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            // Clone before instantiating: both branches stream from the same network
            // response, so capturing the bytes for `wasm_source` costs no extra request.
            const bytesPromise = response.clone().arrayBuffer()
                .then(b => b as ArrayBuffer)
                .catch(() => null);

            const { instance } = await WebAssembly.instantiateStreaming(response, imports);
            bytesPromise.then(resolveBytes);
            return instance.exports;
        } catch (err) {
            // Wrong MIME type, no streaming support, or a transport hiccup — take the
            // historical path. Never fatal: this is a startup-latency optimization only.
            Logger.warn(
                LogCategory.SYSTEM,
                `[wasm] streaming instantiate failed (${err instanceof Error ? err.message : String(err)}); ` +
                `falling back to buffered compile — V8's wasm code cache will not engage`,
            );
            const bytes = await (await fetch(url)).arrayBuffer();
            const { instance } = await WebAssembly.instantiate(bytes, imports);
            resolveBytes(bytes);
            return instance.exports;
        }
    };

    return { wasmFn, sourceBytes };
}
