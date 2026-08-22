/**
 * D3D9 lock/readback conformance — "read the frame I just rendered", driven against our own
 * thunk table with no game bundle.
 *
 * The failure this exists to catch is a LockRect that hands back memory nobody wrote. Our
 * textures have SPLIT storage — a guest HEAP allocation the app locks, and a JS-side shadow
 * the GPU readback lands in — so a read path that populates one and returns the other
 * answers with whatever was in guest memory. That is invisible to every visual check we
 * have: the screen keeps showing the right picture while the bytes handed to the guest
 * describe nothing at all.
 *
 * The statements:
 *   GetRenderTargetData    the documented "copy a render target into a SYSTEMMEM surface so
 *                          the CPU can read it" call; a following LockRect must observe the
 *                          pixels that were rendered.
 *   LockRect of a render target
 *                          DXVK reads a renderable image back UNCONDITIONALLY on Map
 *                          (d3d9_device.cpp `LockImage`), because the GPU is the only place
 *                          its current contents exist.
 *   D3DLOCK_DISCARD        a promise about the WHOLE resource, so it is honoured only for a
 *                          full-resource lock; a sub-rect lock that wiped everything would
 *                          destroy pixels the app never named.
 *   D3DLOCK_READONLY       the app is not writing, so UnlockRect must not push the CPU copy
 *                          back over the rendered pixels.
 *
 * Shape, not scaffolding: no window, no message loop, no guest thread. The scene calls the
 * d3d9 thunk table the way the dispatcher would — `(ctx, mem, args)` with guest addresses —
 * so it exercises the real COM entry points, the real render pass and the real readback.
 * Colours are pure single channels through an X8R8G8B8 surface, and every row prints the raw
 * DWORD next to the decoded value: a render target lives on the GPU in the swap chain's own
 * format, and a channel-order slip there is right bytes in wrong lanes, which a decoded-only
 * row would misreport as a wrong colour.
 *
 * MUTATIONS — `d3d9Conformance({mutate})`, roster in d3d9-conformance-eval. Whether a bug was
 * CAUGHT is decided by the caller against the clean run (mutationVerdict): a row that was
 * already red proves nothing.
 */

import type { HarnessService } from "../service";
import type { X86Context, ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { System } from "../../core/system";
import {
    MUTATIONS, decodeXrgb, swapRb,
    type Mutation, type ConformanceCheck,
} from "./d3d9-conformance-eval";

const D3D_OK = 0;
const D3D_SDK_VERSION = 32;
const D3DDEVTYPE_HAL = 1;
const D3DCREATE_SOFTWARE_VERTEXPROCESSING = 0x20;
const D3DFMT_X8R8G8B8 = 22;
const D3DPOOL_SYSTEMMEM = 2;
const D3DMULTISAMPLE_NONE = 0;
const D3DSWAPEFFECT_DISCARD = 1;
const D3DCLEAR_TARGET = 1;
const D3DLOCK_READONLY = 0x00000010;
const D3DLOCK_DISCARD = 0x00002000;

/** D3DPRESENT_PARAMETERS field offsets and size (32-bit). */
const PP_SIZE = 56;
const PP = {
    backBufferWidth: 0, backBufferHeight: 4, backBufferFormat: 8, backBufferCount: 12,
    multiSampleType: 16, multiSampleQuality: 20, swapEffect: 24, hDeviceWindow: 28,
    windowed: 32, enableAutoDepthStencil: 36, autoDepthStencilFormat: 40, flags: 44,
    fullScreenRefreshRateInHz: 48, presentationInterval: 52,
} as const;

/** D3DLOCKED_RECT { INT Pitch; void *pBits; }. */
const LOCKED_RECT_SIZE = 8;

const SURF_W = 64, SURF_H = 64;

/** Pure single channels — a channel-order slip is a different value, not a near miss. */
const GREEN = 0x00ff00, BLUE = 0x0000ff, WHITE = 0xffffff;
/** The colour an app scribbles through a lock. Deliberately NOT the red/blue mirror of any
 *  expected value, so the "right bytes, wrong lanes" note cannot fire on a coincidence. */
const SCRIBBLE = 0xffff00;

/** 0x00RRGGBB → the D3DCOLOR (A8R8G8B8) Clear/ColorFill take. */
const argb = (rgb: number): number => (0xff000000 | rgb) >>> 0;

const hex = (n: number, digits = 8): string => `0x${(n >>> 0).toString(16).padStart(digits, "0")}`;

export interface ConformanceResult {
    checks: ConformanceCheck[];
    passed: number;
    failed: number;
    mutation: Mutation | null;
    /** What the device and surfaces actually came back as — a wrong colour is often a wrong setup. */
    setup: Record<string, string | number>;
}

/** A thunk call failed its own contract — reported as a FAIL row, never thrown past the group. */
class CallFailure extends Error {
    constructor(readonly call: string, readonly hr: number) {
        super(`${call} returned ${hex(hr)}`);
    }
}

class Scene {
    private bump: number;
    private readonly ctx: X86Context;

    constructor(
        private readonly exports: Record<string, ThunkImplementation>,
        arena: number,
        private readonly arenaEnd: number,
        private readonly mutation: Mutation | null,
    ) {
        this.bump = arena;
        const esp = arenaEnd - 0x100;
        this.ctx = { eax: 0, ecx: 0, edx: 0, ebx: 0, esp, ebp: esp, esi: 0, edi: 0, eip: 0, eflags: 0 };
    }

    /** Guest memory is re-derived per use: a plain view detaches when WASM memory grows. */
    private mem(): Uint8Array {
        const process = System.getInstance().process;
        if (!process) throw new Error("d3d9Conformance: no process");
        return process.getCurrentMemory();
    }

    private view(): DataView {
        const m = this.mem();
        return new DataView(m.buffer, m.byteOffset, m.byteLength);
    }

    alloc(bytes: number): number {
        const at = (this.bump + 15) & ~15;
        if (at + bytes > this.arenaEnd) throw new Error("d3d9Conformance: scratch arena exhausted");
        this.bump = at + bytes;
        this.mem().fill(0, at, at + bytes);
        return at;
    }

    u32(addr: number): number { return this.view().getUint32(addr, true) >>> 0; }
    setU32(addr: number, value: number): void { this.view().setUint32(addr, value >>> 0, true); }

    /** Call a d3d9 thunk exactly as the dispatcher would, with the active mutation applied. */
    async call(name: string, args: number[]): Promise<number> {
        const m = this.mutation;
        if (m === "skip-clear" && name === "IDirect3DDevice9_Clear") return D3D_OK;
        if (m === "ignore-subrect" && name === "IDirect3DSurface9_LockRect") {
            args = [args[0]!, args[1]!, 0, ...args.slice(3)];
        }
        const impl = this.exports[name];
        if (!impl) throw new Error(`d3d9Conformance: d3d9 exports no ${name}`);
        const raw = await impl(this.ctx, this.mem(), args);
        return (typeof raw === "number" ? raw : (raw as ThunkResult).value) >>> 0;
    }

    async must(name: string, args: number[]): Promise<number> {
        const hr = await this.call(name, args);
        if (hr !== D3D_OK) throw new CallFailure(name, hr);
        return hr;
    }

    rect(left: number, top: number, right: number, bottom: number): number {
        const p = this.alloc(16);
        this.setU32(p, left); this.setU32(p + 4, top);
        this.setU32(p + 8, right); this.setU32(p + 12, bottom);
        return p;
    }

    // -- surfaces -----------------------------------------------------------

    async createRenderTarget(device: number, lockable = 1): Promise<number> {
        const out = this.alloc(4);
        await this.must("IDirect3DDevice9_CreateRenderTarget", [
            device, SURF_W, SURF_H, D3DFMT_X8R8G8B8, D3DMULTISAMPLE_NONE, 0, lockable, out, 0,
        ]);
        const addr = this.u32(out);
        if (!addr) throw new CallFailure("CreateRenderTarget (null out)", D3D_OK);
        return addr;
    }

    async createOffscreenPlain(device: number, pool: number): Promise<number> {
        const out = this.alloc(4);
        await this.must("IDirect3DDevice9_CreateOffscreenPlainSurface", [
            device, SURF_W, SURF_H, D3DFMT_X8R8G8B8, pool, out,
        ]);
        const addr = this.u32(out);
        if (!addr) throw new CallFailure("CreateOffscreenPlainSurface (null out)", D3D_OK);
        return addr;
    }

    // -- the render under test ----------------------------------------------

    /** Bind `surface` as render target 0 and clear it to `rgb`. */
    async clearTo(device: number, surface: number, rgb: number): Promise<void> {
        await this.must("IDirect3DDevice9_SetRenderTarget", [device, 0, surface]);
        await this.must("IDirect3DDevice9_Clear", [device, 0, 0, D3DCLEAR_TARGET, argb(rgb), 0x3f800000, 0]);
    }

    // -- the read under test ------------------------------------------------

    /**
     * LockRect(rectPtr, flags) and read the DWORD at pBits — the pixel at the rect's origin,
     * which is what a 1x1 sub-rect lock addresses. Leaves the surface UNLOCKED.
     */
    async lockedPixel(surface: number, rectPtr: number, flags: number)
        : Promise<{ rgb: number; raw: number; pitch: number; bits: number }> {
        const lr = this.alloc(LOCKED_RECT_SIZE);
        await this.must("IDirect3DSurface9_LockRect", [surface, lr, rectPtr, flags]);
        const pitch = this.u32(lr);
        const bits = this.u32(lr + 4);
        const raw = bits ? this.u32(bits) : 0;
        await this.must("IDirect3DSurface9_UnlockRect", [surface]);
        return { rgb: decodeXrgb(raw), raw, pitch, bits };
    }

    /** GetRenderTargetData(rt, dest) then read one pixel of `dest` through a 1x1 lock. */
    async readBackPixel(device: number, rt: number, dest: number, x: number, y: number)
        : Promise<{ rgb: number; raw: number; pitch: number; bits: number }> {
        await this.must("IDirect3DDevice9_GetRenderTargetData", [device, rt, dest]);
        return this.lockedPixel(dest, this.rect(x, y, x + 1, y + 1), D3DLOCK_READONLY);
    }

    /** Overwrite the whole locked extent with `rgb` — what a writing app does through pBits. */
    fillLocked(bits: number, pitch: number, rgb: number, rows: number, widthPx: number): void {
        const v = this.view();
        for (let yy = 0; yy < rows; yy++) {
            for (let xx = 0; xx < widthPx; xx++) v.setUint32(bits + yy * pitch + xx * 4, argb(rgb), true);
        }
    }

    /** Paint the whole surface one colour through an ordinary writable full lock. */
    async fillSurface(surface: number, rgb: number): Promise<void> {
        const lr = this.alloc(LOCKED_RECT_SIZE);
        await this.must("IDirect3DSurface9_LockRect", [surface, lr, 0, 0]);
        this.fillLocked(this.u32(lr + 4), this.u32(lr), rgb, SURF_H, SURF_W);
        await this.must("IDirect3DSurface9_UnlockRect", [surface]);
    }

    /** Paint a per-pixel gradient, so a lock that addresses the wrong pixel reads a
     *  different colour instead of the same flat one. */
    async paintGradient(surface: number): Promise<void> {
        const lr = this.alloc(LOCKED_RECT_SIZE);
        await this.must("IDirect3DSurface9_LockRect", [surface, lr, 0, 0]);
        const pitch = this.u32(lr), bits = this.u32(lr + 4);
        const v = this.view();
        for (let y = 0; y < SURF_H; y++) {
            for (let x = 0; x < SURF_W; x++) {
                v.setUint32(bits + y * pitch + x * 4, argb(gradientColour(x, y)), true);
            }
        }
        await this.must("IDirect3DSurface9_UnlockRect", [surface]);
    }
}

/** The gradient the sub-rect rows read back. Distinct per pixel across a 64x64 surface. */
function gradientColour(x: number, y: number): number {
    return (((x * 4) & 0xff) << 16) | (((y * 4) & 0xff) << 8) | 0x40;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const colourRow = (
    name: string, source: string, expect: number,
    got: { rgb: number; raw: number; pitch: number; bits: number },
): ConformanceCheck => ({
    name,
    source,
    expected: `${hex(expect, 6)}`,
    observed: `${hex(got.rgb, 6)} (raw ${hex(got.raw)}, pitch ${got.pitch}, pBits ${hex(got.bits)})`,
    pass: got.rgb === expect,
    note: got.rgb === swapRb(expect) && expect !== swapRb(expect)
        ? "right bytes, wrong lanes — the readback's channel order is swapped, not its source"
        : (got.raw === 0 ? "all-zero: the bytes handed back were never written by anyone" : undefined),
});

const setupFailure = (name: string, source: string, e: unknown): ConformanceCheck => ({
    name,
    source,
    expected: "the call succeeds",
    observed: e instanceof CallFailure ? `${e.call} -> ${hex(e.hr)}` : String(e),
    pass: false,
});

const GRTD = "d3d9 GetRenderTargetData; Wine dlls/d3d9/tests/visual.c:189-215 get_rt_readback";
const LOCKIMAGE = "DXVK d3d9_device.cpp:5036-5041 — a renderable image is read back on every Map";
const SUBLOCK = "Wine dlls/d3d9/tests/device.c:9819-9864 — a sub-rect lock addresses that rect";
const DISCARD_SRC = "DXVK d3d9_device.cpp:5026-5027 — DISCARD only for a full-resource POOL_DEFAULT lock";
const READONLY_SRC = "DXVK d3d9_device.cpp:5157-5173 — READONLY accumulates no dirty box, so nothing is written back";

/**
 * The headline: render, GetRenderTargetData into a SYSTEMMEM surface, LockRect, read.
 * Two different colours, because a path that answers with one stale constant passes a
 * single-colour probe by accident.
 */
async function assertRenderTargetData(
    s: Scene, device: number, rt: number, sys: number, out: ConformanceCheck[],
): Promise<void> {
    for (const [label, colour] of [["Green", GREEN], ["Blue", BLUE]] as const) {
        try {
            await s.clearTo(device, rt, colour);
            out.push(colourRow(`rtdata.clear${label}`, GRTD, colour,
                await s.readBackPixel(device, rt, sys, 0, 0)));
        } catch (e) {
            out.push(setupFailure(`rtdata.clear${label}`, GRTD, e));
        }
    }
}

/** LockRect of the render target ITSELF — no staging surface in the middle. */
async function assertRenderTargetLock(
    s: Scene, device: number, rt: number, out: ConformanceCheck[],
): Promise<void> {
    try {
        await s.clearTo(device, rt, WHITE);
        out.push(colourRow("rtlock.readsRenderedPixels", LOCKIMAGE, WHITE,
            await s.lockedPixel(rt, 0, D3DLOCK_READONLY)));
    } catch (e) {
        out.push(setupFailure("rtlock.readsRenderedPixels", LOCKIMAGE, e));
    }
}

/**
 * A 1x1 lock at (x,y) must address THAT pixel. The surface is painted with a per-pixel
 * gradient first: over one flat colour this assertion cannot fail however wrong pBits is,
 * which is what a first cut of it did.
 */
async function assertSubRectLock(s: Scene, sys: number, out: ConformanceCheck[]): Promise<void> {
    try {
        await s.paintGradient(sys);
        for (const [x, y] of [[0, 0], [17, 5], [63, 63]] as const) {
            out.push(colourRow(`sublock.pixelAt(${x},${y})`, SUBLOCK, gradientColour(x, y),
                await s.lockedPixel(sys, s.rect(x, y, x + 1, y + 1), D3DLOCK_READONLY)));
        }
    } catch (e) {
        out.push(setupFailure("sublock.pixelAt", SUBLOCK, e));
    }
}

/** The flag algebra: DISCARD's extent rule and READONLY's no-write-back rule. */
async function assertLockFlags(
    s: Scene, device: number, rt: number, sys: number, out: ConformanceCheck[],
): Promise<void> {
    // DISCARD naming an 8x8 rect must not cost the app the other 4032 pixels. The staging
    // surface is primed to WHITE first so "the old contents were not produced" is a
    // DIFFERENT value rather than whatever happened to be there.
    try {
        await s.fillSurface(sys, WHITE);
        await s.clearTo(device, rt, GREEN);
        await s.must("IDirect3DDevice9_GetRenderTargetData", [device, rt, sys]);
        const lr = s.alloc(LOCKED_RECT_SIZE);
        await s.must("IDirect3DSurface9_LockRect", [sys, lr, s.rect(0, 0, 8, 8), D3DLOCK_DISCARD]);
        s.fillLocked(s.u32(lr + 4), s.u32(lr), SCRIBBLE, 8, 8);
        await s.must("IDirect3DSurface9_UnlockRect", [sys]);
        out.push(colourRow("lockflags.discardKeepsUnnamedPixels", DISCARD_SRC, GREEN,
            await s.lockedPixel(sys, s.rect(32, 32, 33, 33), D3DLOCK_READONLY)));
    } catch (e) {
        out.push(setupFailure("lockflags.discardKeepsUnnamedPixels", DISCARD_SRC, e));
    }

    // A READONLY lock the app scribbles over must not have those bytes written back. Read
    // through a SECOND lock and no new readback: re-reading the GPU would refresh the CPU
    // copy and hide the write-back entirely.
    try {
        await s.clearTo(device, rt, BLUE);
        await s.must("IDirect3DDevice9_GetRenderTargetData", [device, rt, sys]);
        const lr = s.alloc(LOCKED_RECT_SIZE);
        await s.must("IDirect3DSurface9_LockRect", [sys, lr, 0, D3DLOCK_READONLY]);
        s.fillLocked(s.u32(lr + 4), s.u32(lr), SCRIBBLE, SURF_H, SURF_W);
        await s.must("IDirect3DSurface9_UnlockRect", [sys]);
        out.push(colourRow("lockflags.readonlyDoesNotUpload", READONLY_SRC, BLUE,
            await s.lockedPixel(sys, s.rect(0, 0, 1, 1), D3DLOCK_READONLY)));
    } catch (e) {
        out.push(setupFailure("lockflags.readonlyDoesNotUpload", READONLY_SRC, e));
    }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const ARENA_BYTES = 0x10000;

export async function runD3D9Conformance(opts: { mutate?: Mutation | null } = {}): Promise<ConformanceResult> {
    const mutation = opts.mutate ?? null;
    if (mutation && !(mutation in MUTATIONS)) {
        throw new Error(`d3d9Conformance: unknown mutation '${mutation}' (have: ${Object.keys(MUTATIONS).join(", ")})`);
    }

    const system = System.getInstance();
    const process = system.process;
    if (!process) throw new Error("d3d9Conformance: no process — the emulator has not reached emulator-ready");
    const d3d9Module = process.getModule("d3d9") as { exports: Record<string, ThunkImplementation> } | undefined;
    if (!d3d9Module) {
        // Name what IS there: "not registered" alone cannot tell a module-init failure from a
        // tab that never reached module init at all.
        throw new Error(`d3d9Conformance: d3d9 module not registered (have: ${
            [...process.modules.keys()].join(", ") || "none"})`);
    }

    const flags = globalThis as {
        __noD3D9LockReadback?: boolean;
        __d3d9LockDiscardWholeSurface?: boolean;
        __noD3D9LockFlags?: boolean;
    };
    const saved = {
        readback: flags.__noD3D9LockReadback,
        discard: flags.__d3d9LockDiscardWholeSurface,
        lockFlags: flags.__noD3D9LockFlags,
    };
    if (mutation === "no-lock-readback") flags.__noD3D9LockReadback = true;
    if (mutation === "discard-whole-surface") flags.__d3d9LockDiscardWholeSurface = true;
    if (mutation === "ignore-lock-flags") flags.__noD3D9LockFlags = true;

    const arena = process.memory.alloc(ARENA_BYTES, "HEAP", "rw", 16);
    const checks: ConformanceCheck[] = [];
    try {
        const s = new Scene(d3d9Module.exports, arena, arena + ARENA_BYTES, mutation);

        const d3d9 = await s.call("Direct3DCreate9", [D3D_SDK_VERSION]);
        if (!d3d9) throw new Error("d3d9Conformance: Direct3DCreate9 returned NULL");

        const pp = s.alloc(PP_SIZE);
        s.setU32(pp + PP.backBufferWidth, SURF_W);
        s.setU32(pp + PP.backBufferHeight, SURF_H);
        s.setU32(pp + PP.backBufferFormat, D3DFMT_X8R8G8B8);
        s.setU32(pp + PP.backBufferCount, 1);
        s.setU32(pp + PP.swapEffect, D3DSWAPEFFECT_DISCARD);
        s.setU32(pp + PP.windowed, 1);

        const devOut = s.alloc(4);
        await s.must("IDirect3D9_CreateDevice", [
            d3d9, 0, D3DDEVTYPE_HAL, 0, D3DCREATE_SOFTWARE_VERTEXPROCESSING, pp, devOut,
        ]);
        const device = s.u32(devOut);
        if (!device) throw new Error("d3d9Conformance: CreateDevice wrote a NULL device");

        const rt = await s.createRenderTarget(device);
        const sys = await s.createOffscreenPlain(device, D3DPOOL_SYSTEMMEM);

        await assertRenderTargetData(s, device, rt, sys, checks);
        await assertRenderTargetLock(s, device, rt, checks);
        await assertSubRectLock(s, sys, checks);
        await assertLockFlags(s, device, rt, sys, checks);

        const failed = checks.filter((c) => !c.pass).length;
        return {
            checks,
            passed: checks.length - failed,
            failed,
            mutation,
            setup: {
                d3d9: hex(d3d9),
                device: hex(device),
                renderTarget: hex(rt),
                sysmemSurface: hex(sys),
                arena: hex(arena),
                gpuFormat: system.services.render.getBackend()?.kind === "webgpu"
                    ? String((system.services.render.getBackend() as { getFormat?: () => string | null })
                        .getFormat?.() ?? "unknown")
                    : "no-webgpu-backend",
                mutationHow: mutation ? MUTATIONS[mutation].how : "none",
            },
        };
    } finally {
        flags.__noD3D9LockReadback = saved.readback;
        flags.__d3d9LockDiscardWholeSurface = saved.discard;
        flags.__noD3D9LockFlags = saved.lockFlags;
        process.memory.free(arena);
    }
}

export function registerD3D9ConformanceCommands(svc: HarnessService): void {
    /** d3d9Conformance({mutate}) — the D3D9 lock/readback assertions. No bundle required. */
    svc.register("d3d9Conformance", async (args) =>
        runD3D9Conformance((args[0] ?? {}) as { mutate?: Mutation | null }));

    /** d3d9ConformanceMutations() — the roster, so the scenario need not hardcode it. */
    svc.register("d3d9ConformanceMutations", () =>
        Object.entries(MUTATIONS).map(([name, m]) => ({ name, how: m.how, groups: m.groups })));
}
