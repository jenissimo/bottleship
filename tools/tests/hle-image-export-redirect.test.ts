/**
 * An HLE export has ONE guest address, and a trap-free inline fast path is reached
 * THROUGH it.
 *
 * Binding the IAT straight to an inline stub gives the export a second address: the
 * export directory and GetProcAddress name the body inside the module's image, so an
 * ASI/mod loader that finds its slot by scanning the IAT for that value finds nothing
 * and installs nothing — silently. The fix patches the image body with a JMP, so the
 * address stays the image's and the fast path still runs.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
    materializeHleModuleImages, redirectHleImageExport, hleImageRedirectTarget, hleImageBase,
    resetHleModuleImages,
} from "../../src/worker/core/hle-module-images";
import { hleExportBindingAddress, resolveHleExportAddress } from "../../src/worker/core/thunking/export-resolver";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { resetGuestCodeInvalidationState } from "../../src/worker/core/memory/guest-code";
import { MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../../src/worker/core/cpu/emulator-config";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { kernel32Module } from "../../src/worker/api/kernel32.api";

/** Stands in for an inline stub the PE loader emitted into the THUNK_CODE arena. */
const INLINE_STUB = 0x21050000;

let mem: Uint8Array;
let dv: DataView;
let gen: ThunkGenerator;
let dirtied: Array<[number, number]>;
let savedExports: unknown;

function inImage(address: number): boolean {
    return address >= MEM_HLE_IMAGE_BASE && address < MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE;
}

/** Decode the 5-byte JMP rel32 at `address`, or null when the bytes are not one. */
function jmpTarget(address: number): number | null {
    if (mem[address] !== 0xe9) return null;
    return (address + 5 + dv.getInt32(address + 1, true)) >>> 0;
}

beforeAll(() => {
    // APIRegistry discovers descriptors through Vite's import.meta.glob, which does not
    // exist outside the bundler — register the real kernel32 table explicitly, or the
    // image built below has none of the exports under test.
    APIRegistry.getInstance().registerModule(kernel32Module);
    // Guest RAM must reach the HLE image arena; the pages are only touched as written.
    mem = new Uint8Array(MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE);
    dv = new DataView(mem.buffer);
    Mem.bind(() => mem);
    savedExports = (preemptionManager as unknown as { wasmExports: unknown }).wasmExports;
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = {
        jit_dirty_cache: (start: number, end: number) => { dirtied.push([start >>> 0, end >>> 0]); },
        jit_clear_cache_js: () => { },
    };
});

afterAll(() => {
    (preemptionManager as unknown as { wasmExports: unknown }).wasmExports = savedExports;
    resetGuestCodeInvalidationState();
    // The image maps are module-scoped: leaving 40 images behind makes every later suite's
    // export resolution answer with an image body instead of the arena stub.
    resetHleModuleImages();
});

beforeEach(() => {
    dirtied = [];
    gen = new ThunkGenerator();
    gen.setBaseAddress(0x21046000);
    // A fresh process object re-materializes: each test starts from unpatched images.
    materializeHleModuleImages({ thunkGenerator: gen, resetGeneration: 0 });
    dirtied = [];
});

describe("in-image export redirect", () => {
    test("the export keeps ONE address, inside its image, and its body jumps to the inline stub", () => {
        const before = hleExportBindingAddress(gen, "kernel32", "HeapAlloc");
        expect(before).toBeDefined();
        expect(inImage(before!)).toBe(true);
        expect(before! >= hleImageBase("kernel32")!).toBe(true);

        // What the PE loader writes into the IAT for a name it serves inline.
        const bound = redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB, before);

        expect(bound).toBe(before!);
        expect(hleExportBindingAddress(gen, "kernel32", "HeapAlloc")).toBe(bound!);
        expect(jmpTarget(bound!)).toBe(INLINE_STUB);
        // The write went through the guest-code chokepoint, so the JIT dropped the page.
        expect(dirtied.some(([lo, hi]) => lo <= bound! && hi >= bound! + 5)).toBe(true);
    });

    test("GetProcAddress by name answers that same address, not the arena stub", () => {
        // The IAT half is worthless on its own: a wrapper takes the pointer from
        // GetProcAddress and scans the import table for THAT value. If the two resolvers
        // disagree the scan finds nothing, which is exactly the silence this fixes.
        const bound = hleExportBindingAddress(gen, "kernel32", "HeapAlloc")!;
        const dispatcher = { thunkGenerator: gen };
        expect(resolveHleExportAddress(dispatcher, "kernel32", "HeapAlloc")).toBe(bound);

        redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB, bound);
        expect(resolveHleExportAddress(dispatcher, "kernel32", "HeapAlloc")).toBe(bound);
        expect(jmpTarget(bound)).toBe(INLINE_STUB);
    });

    test("the stub registered at that address admits its body was redirected", () => {
        const address = hleExportBindingAddress(gen, "kernel32", "HeapAlloc")!;
        redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB, address);

        const stub = gen.getStubByAddress(address)!;
        expect(stub.functionName.toLowerCase()).toBe("heapalloc");
        expect(stub.redirectedTo).toBe(INLINE_STUB);
        expect(hleImageRedirectTarget(address)).toBe(INLINE_STUB);
    });

    test("an export with no inline stub still holds its OUT-trap body", () => {
        redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB,
            hleExportBindingAddress(gen, "kernel32", "HeapAlloc"));

        const sleep = hleExportBindingAddress(gen, "kernel32", "Sleep")!;
        expect(inImage(sleep)).toBe(true);
        expect(mem[sleep]).toBe(0xb8);                       // MOV EAX, functionId
        expect(dv.getUint32(sleep + 1, true)).toBe(gen.getStubByAddress(sleep)!.functionId);
        expect(jmpTarget(sleep)).toBeNull();
        expect(hleImageRedirectTarget(sleep)).toBeUndefined();
        expect(gen.getStubByAddress(sleep)!.redirectedTo).toBeUndefined();
    });

    test("a module with no image redirects nothing, so the caller binds the inline stub", () => {
        const bound = hleExportBindingAddress(gen, "nosuchdll", "NoSuchExport");
        expect(bound).toBeUndefined();

        const viaImage = redirectHleImageExport(gen, "nosuchdll", "nosuchexport", INLINE_STUB, bound);

        expect(viaImage).toBeUndefined();
        expect(viaImage ?? INLINE_STUB).toBe(INLINE_STUB);   // the PE loader's fallback
    });

    test("re-resolving the same export does not re-publish the jump", () => {
        const address = hleExportBindingAddress(gen, "kernel32", "HeapAlloc")!;
        redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB, address);
        const afterFirst = dirtied.length;
        expect(afterFirst).toBeGreaterThan(0);

        // Every importer that links HeapAlloc resolves it again.
        for (let i = 0; i < 5; i++) {
            expect(redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB, address)).toBe(address);
        }
        expect(dirtied.length).toBe(afterFirst);

        // A DIFFERENT target is a real change and must land.
        expect(redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB + 0x40, address)).toBe(address);
        expect(jmpTarget(address)).toBe(INLINE_STUB + 0x40);
        expect(dirtied.length).toBeGreaterThan(afterFirst);
    });

    test("a data export outranks the image body, so nothing is patched", () => {
        const address = hleExportBindingAddress(gen, "kernel32", "HeapAlloc")!;
        // The single owner answered something other than the image body — a variable's
        // address, not code. Patching it would rewrite the variable.
        expect(redirectHleImageExport(gen, "kernel32", "heapalloc", INLINE_STUB, 0x30000)).toBeUndefined();
        expect(jmpTarget(address)).toBeNull();
    });
});
