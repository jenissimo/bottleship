/**
 * Globals a test file needs, scoped to that file.
 *
 * `bun test` runs every file in ONE process, one after another, in an order that differs per
 * OS (directory order). A global a file sets and leaves behind — or a `??=` that silently keeps
 * a partial table another file left — makes later files pass or fail by run order: a
 * `GPUTextureUsage` holding only `{ RENDER_ATTACHMENT, COPY_SRC }` turns every
 * `usage & GPUTextureUsage.COPY_DST` in a later file into 0.
 */
import { afterAll } from "bun:test";

/** The WebGPU flag namespaces with their spec values. Bun has no WebGPU; the browser and the
 *  workers always have these, so a test installs the real numbers, never a subset. */
export const WEBGPU_FLAGS = {
    GPUBufferUsage: {
        MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20,
        UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
    },
    GPUTextureUsage: { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10 },
    GPUShaderStage: { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 },
    GPUMapMode: { READ: 0x1, WRITE: 0x2 },
    GPUColorWrite: { RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xf },
} as const;

export type WebGpuFlagGlobal = keyof typeof WEBGPU_FLAGS;

/**
 * Set `values` on globalThis now and put back exactly what was there before (or delete the
 * key) when the enclosing scope ends. Call it at the top level of a test file — or inside a
 * `describe` to scope it to that block — and before any `await import` that reads the globals.
 */
export function scopedGlobals(values: Record<string, unknown>): void {
    preserveGlobals(...Object.keys(values));
    Object.assign(globalThis, values);
}

/** Snapshot the named globals now and put them back exactly (or delete them) when the
 *  enclosing scope ends — for a file whose tests assign them themselves (a per-test stub). */
export function preserveGlobals(...keys: string[]): void {
    const g = globalThis as Record<string, unknown>;
    const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(g, key)] as const);
    afterAll(() => {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(g, key, descriptor);
            else delete g[key];
        }
    });
}

/** Install the named WebGPU flag namespaces (all of them when none are named) with their
 *  spec values for this file, unconditionally — never `??=`, which would keep whatever an
 *  earlier file left. */
export function useWebGpuFlags(...names: WebGpuFlagGlobal[]): void {
    const pick = names.length > 0 ? names : (Object.keys(WEBGPU_FLAGS) as WebGpuFlagGlobal[]);
    scopedGlobals(Object.fromEntries(pick.map((name) => [name, { ...WEBGPU_FLAGS[name] }])));
}
