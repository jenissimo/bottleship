/**
 * DDraw read-lock conformance — the Wine ddraw7 assertions a Lock has to satisfy,
 * driven against our own implementation with no game bundle.
 *
 * The failure this exists to catch is a Lock that serves a STALE frame. It is invisible
 * to every visual check we have: the screen keeps showing the right picture while the
 * bytes handed to the guest describe the previous one, so a screenshot agrees with a
 * build that is wrong. The only instrument that can see it is a read whose expected
 * value is known in advance, which is what the conformance suite is.
 *
 * The assertions are Wine's, at `dlls/ddraw/tests/ddraw7.c`:
 *   test_flip_3d          20301-20347  a Lock of the current back buffer must show the
 *                                      quad drawn AFTER the Flip, and the far chain slot
 *                                      the one drawn BEFORE it. This is the statement that
 *                                      makes serving the previous frame illegal.
 *   get_surface_color       453-474    a 1x1 DDLOCK_READONLY sub-rect Lock returns the pixel
 *                                      AT THAT RECT — the dominant read-lock shape in the
 *                                      suite (check_rect_ at 500-535 fires sixteen per rect)
 *                                      and the case a rect-scoped download must get right.
 *   test_sysmem_x_channel 20639-20679  after DDBLT_COLORFILL a full-surface Lock(NULL) reads
 *                                      the fill colour — the case an analytic "cleared"
 *                                      location would later have to keep true.
 *   test_getdc            14292-14300  a second Lock on a locked surface is DDERR_SURFACEBUSY.
 *
 * Shape, not scaffolding: there is no window, no message loop and no guest. The scene calls
 * the ddraw thunk table the way the dispatcher would — `(ctx, mem, args)` with guest
 * addresses — so it exercises the real COM entry points, the real flip chain and the real
 * readback path. Two deliberate deviations from the C, both narrowing rather than weakening:
 * surfaces are asked for an explicit 32-bit X8R8G8B8 format so a colour compare is a DWORD
 * compare instead of a display-mode round trip (and the pixel is decoded through whatever
 * format actually came back, so a surface we got wrong reports its own format rather than a
 * wrong colour); and the quad is D3DFVF_XYZRHW, which keeps the transform pipeline — not
 * under test here — out of the result.
 *
 * Every row carries the observed value next to the expected one. A row that says only
 * "false" is not evidence.
 *
 * MUTATIONS — each assertion has to be shown capable of failing, so the scene can inject the
 * corresponding bug itself: `ddrawConformance({mutate})`, roster in MUTATIONS below. A run
 * with a mutation returns its own rows; whether the bug was CAUGHT is decided by the caller
 * against the clean run (mutationVerdict), because a row that was already red proves nothing.
 * A mutation that changes nothing is a finding about the SCENE — the assertion is not watching
 * what it claims — and the regression scenario fails on it.
 */

import type { HarnessService } from "../service";
import type { DDraw } from "../../modules/ddraw";
import type { WebGPUBackend } from "../../backends/webgpu/webgpu-backend";
import type { X86Context, ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { System } from "../../core/system";
import { writeGuidToMem } from "../../core/com/typelib/typelib-types";
import {
    MUTATIONS, decodeRgb, encodeRgb,
    type Mutation, type PixelFormat, type ConformanceCheck,
} from "./ddraw-conformance-eval";
import {
    DD_OK,
    DDERR_SURFACEBUSY,
    DDSCL_NORMAL,
    DDSD_CAPS, DDSD_WIDTH, DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_BACKBUFFERCOUNT,
    DDSD_CKSRCBLT, DDCKEY_SRCBLT, DDCKEY_DESTBLT, DDCKEY_COLORSPACE, DDERR_NOCOLORKEYHW,
    DDSCAPS_3DDEVICE, DDSCAPS_FLIP, DDSCAPS_COMPLEX, DDSCAPS_SYSTEMMEMORY,
    DDSURFACEDESC2_SIZE, DDSURFACEDESC2_OFFSETS,
    DDPIXELFORMAT_OFFSETS, DDPF_RGB,
    DDBLTFX_SIZE, DDBLTFX_OFFSETS, DDBLT_COLORFILL, DDBLT_WAIT,
    DDLOCK_READONLY, DDLOCK_WAIT,
    DDFLIP_WAIT,
    D3DPT_TRIANGLESTRIP, D3DFVF_XYZRHW,
    D3DRENDERSTATE_ZENABLE, D3DRENDERSTATE_LIGHTING, D3DRENDERSTATE_CULLMODE, D3DCULL_NONE,
    IID_IDirectDraw7, IID_IDirect3D7, IID_IDirect3DHALDevice,
} from "../../modules/ddraw/constants";

/** DDSCAPS_OFFSCREENPLAIN — the one cap in this scene that constants.ts has no name for. */
const DDSCAPS_OFFSCREENPLAIN = 0x00000040;
/** D3DFVF_DIFFUSE — likewise; draw-handler.ts spells it 0x40 inline. */
const D3DFVF_DIFFUSE = 0x00000040;

/** 16x16 is Wine's flip-chain size; 32x32 its sysmem/quadrant size. */
const FLIP_W = 16, FLIP_H = 16, FLIP_BACKBUFFERS = 3;
const PLAIN_W = 32, PLAIN_H = 32;

/** Pure-channel colours: exact through 565 as well as 8888, so a surface that came back at a
 *  different depth still compares exactly instead of needing a tolerance. */
const GREEN = 0x00ff00, BLUE = 0x0000ff, RED = 0xff0000, WHITE = 0xffffff;

export interface ConformanceResult {
    checks: ConformanceCheck[];
    passed: number;
    failed: number;
    mutation: Mutation | null;
    /** What the surfaces actually came back as — a wrong colour is often a wrong format. */
    setup: Record<string, string | number>;
}

const hex = (n: number, digits = 8): string => `0x${(n >>> 0).toString(16).padStart(digits, "0")}`;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

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
        // A plausible stack pointer: several handlers refuse to write an out-pointer that
        // lands inside their own argument frame, and 0 would put every scratch address
        // "in the frame". The scratch stack sits at the top of the arena, away from the
        // structures the calls write through.
        const esp = arenaEnd - 0x100;
        this.ctx = { eax: 0, ecx: 0, edx: 0, ebx: 0, esp, ebp: esp, esi: 0, edi: 0, eip: 0, eflags: 0 };
    }

    /** Guest memory is re-derived per use: a plain view detaches when WASM memory grows. */
    private mem(): Uint8Array {
        const process = System.getInstance().process;
        if (!process) throw new Error("ddrawConformance: no process");
        return process.getCurrentMemory();
    }

    private view(): DataView {
        const m = this.mem();
        return new DataView(m.buffer, m.byteOffset, m.byteLength);
    }

    /** Bump-allocate zeroed scratch inside the arena. */
    alloc(bytes: number): number {
        const at = (this.bump + 15) & ~15;
        if (at + bytes > this.arenaEnd) throw new Error("ddrawConformance: scratch arena exhausted");
        this.bump = at + bytes;
        this.mem().fill(0, at, at + bytes);
        return at;
    }

    u32(addr: number): number { return this.view().getUint32(addr, true) >>> 0; }
    setU32(addr: number, value: number): void { this.view().setUint32(addr, value >>> 0, true); }
    setF32(addr: number, value: number): void { this.view().setFloat32(addr, value, true); }

    /** Read `bytes` bytes little-endian — a pixel word at 8/16/24/32 bpp. */
    readWord(addr: number, bytes: number): number {
        const m = this.mem();
        let v = 0;
        for (let i = bytes - 1; i >= 0; i--) v = (v << 8) | m[addr + i]!;
        return v >>> 0;
    }

    /** Call a ddraw thunk exactly as the dispatcher would, with the active mutation applied. */
    async call(name: string, args: number[]): Promise<number> {
        const impl = this.exports[name];
        if (!impl) throw new Error(`ddrawConformance: ddraw exports no ${name}`);
        const m = this.mutation;

        if (m === "noop-flip" && name === "IDirectDrawSurface7_Flip") return DD_OK;
        if (m === "skip-colorfill" && name === "IDirectDrawSurface7_Blt" && (args[4]! & DDBLT_COLORFILL) !== 0) return DD_OK;
        if (m === "ignore-subrect" && name === "IDirectDrawSurface7_Lock") args = [args[0]!, 0, ...args.slice(2)];

        const raw = await impl(this.ctx, this.mem(), args);
        const hr = (typeof raw === "number" ? raw : (raw as ThunkResult).value) >>> 0;

        if (m === "allow-double-lock" && name === "IDirectDrawSurface7_Lock" && hr === DDERR_SURFACEBUSY) return DD_OK;
        return hr;
    }

    /** Call and require success — a setup step that fails must name itself. */
    async must(name: string, args: number[]): Promise<number> {
        const hr = await this.call(name, args);
        if (hr !== DD_OK) throw new CallFailure(name, hr);
        return hr;
    }

    // -- structures ---------------------------------------------------------

    /** A zeroed DDSURFACEDESC2 with dwSize set — every Lock/CreateSurface argument. */
    desc(): number {
        const p = this.alloc(DDSURFACEDESC2_SIZE);
        this.setU32(p + DDSURFACEDESC2_OFFSETS.size, DDSURFACEDESC2_SIZE);
        return p;
    }

    /** X8R8G8B8 in the descriptor's DDPIXELFORMAT slot. */
    writeKeyDescPixelFormat(descPtr: number): void { this.writeX8R8G8B8(descPtr); }

    private writeX8R8G8B8(descPtr: number): void {
        const pf = descPtr + DDSURFACEDESC2_OFFSETS.pixelFormat;
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.size, 32);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.flags, DDPF_RGB);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.rgbBitCount, 32);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.rMask, 0x00ff0000);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.gMask, 0x0000ff00);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.bMask, 0x000000ff);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.aMask, 0);
    }

    private readPixelFormatAt(pf: number): PixelFormat {
        return {
            bpp: this.u32(pf + DDPIXELFORMAT_OFFSETS.rgbBitCount),
            rMask: this.u32(pf + DDPIXELFORMAT_OFFSETS.rMask),
            gMask: this.u32(pf + DDPIXELFORMAT_OFFSETS.gMask),
            bMask: this.u32(pf + DDPIXELFORMAT_OFFSETS.bMask),
            aMask: this.u32(pf + DDPIXELFORMAT_OFFSETS.aMask),
        };
    }

    /**
     * The format to decode a locked pixel with. The locked descriptor is the authority; a Lock
     * that leaves DDPIXELFORMAT unwritten falls back to GetPixelFormat, so an unfilled field
     * shows up as itself instead of as a wrong colour on the row under test.
     */
    private async formatFor(descPtr: number, surface: number): Promise<PixelFormat> {
        const fromDesc = this.readPixelFormatAt(descPtr + DDSURFACEDESC2_OFFSETS.pixelFormat);
        if (fromDesc.bpp) return fromDesc;
        const pf = this.alloc(32);
        this.setU32(pf + DDPIXELFORMAT_OFFSETS.size, 32);
        await this.must("IDirectDrawSurface7_GetPixelFormat", [surface, pf]);
        return this.readPixelFormatAt(pf);
    }

    rect(left: number, top: number, right: number, bottom: number): number {
        const p = this.alloc(16);
        this.setU32(p, left); this.setU32(p + 4, top); this.setU32(p + 8, right); this.setU32(p + 12, bottom);
        return p;
    }

    guid(iid: string): number {
        const p = this.alloc(16);
        writeGuidToMem(this.mem(), p, iid);
        return p;
    }

    // -- surface creation ---------------------------------------------------

    /** IDirectDraw7::CreateSurface with an explicit 32-bit format; returns the COM address. */
    async createSurface(ddraw: number, caps: number, w: number, h: number, backBuffers = 0): Promise<number> {
        const d = this.desc();
        let flags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT;
        this.setU32(d + DDSURFACEDESC2_OFFSETS.width, w);
        this.setU32(d + DDSURFACEDESC2_OFFSETS.height, h);
        this.setU32(d + DDSURFACEDESC2_OFFSETS.caps, caps);
        this.writeX8R8G8B8(d);
        if (backBuffers > 0) {
            flags |= DDSD_BACKBUFFERCOUNT;
            this.setU32(d + DDSURFACEDESC2_OFFSETS.backBufferCount, backBuffers);
        }
        this.setU32(d + DDSURFACEDESC2_OFFSETS.flags, flags);
        const out = this.alloc(4);
        await this.must("IDirectDraw7_CreateSurface", [ddraw, d, out, 0]);
        const addr = this.u32(out);
        if (!addr) throw new CallFailure("IDirectDraw7_CreateSurface (null out)", DD_OK);
        return addr;
    }

    // -- the read under test ------------------------------------------------

    /**
     * get_surface_color (ddraw7.c:453-474): a 1x1 DDLOCK_READONLY lock at (x,y), the DWORD at
     * lpSurface, masked to 0x00ffffff. Decoded through the format the Lock itself reported, so
     * a surface at an unexpected depth reports its depth rather than a wrong colour.
     */
    async surfaceColor(surface: number, x: number, y: number): Promise<{ rgb: number; raw: number; fmt: PixelFormat }> {
        const r = this.rect(x, y, x + 1, y + 1);
        const d = this.desc();
        await this.must("IDirectDrawSurface7_Lock", [surface, r, d, DDLOCK_READONLY, 0]);
        const fmt = await this.formatFor(d, surface);
        const bytes = Math.max(1, fmt.bpp >>> 3);
        const raw = this.readWord(this.u32(d + DDSURFACEDESC2_OFFSETS.lpSurface), bytes);
        await this.must("IDirectDrawSurface7_Unlock", [surface, r]);
        return { rgb: decodeRgb(raw, fmt), raw, fmt };
    }

    /** Lock(NULL, DDLOCK_READONLY) and read the first pixel — test_sysmem_x_channel's shape. */
    async fullLockFirstPixel(surface: number): Promise<{ rgb: number; raw: number; fmt: PixelFormat }> {
        const d = this.desc();
        await this.must("IDirectDrawSurface7_Lock", [surface, 0, d, DDLOCK_READONLY, 0]);
        const fmt = await this.formatFor(d, surface);
        const bytes = Math.max(1, fmt.bpp >>> 3);
        const raw = this.readWord(this.u32(d + DDSURFACEDESC2_OFFSETS.lpSurface), bytes);
        await this.must("IDirectDrawSurface7_Unlock", [surface, 0]);
        return { rgb: decodeRgb(raw, fmt), raw, fmt };
    }

    /** DDBLT_COLORFILL of `rgb` over `rect` (NULL = whole surface), in the surface's own format. */
    async colorFill(surface: number, rgb: number, fmt: PixelFormat, rectPtr: number): Promise<void> {
        const fx = this.alloc(DDBLTFX_SIZE);
        this.setU32(fx, DDBLTFX_SIZE);
        this.setU32(fx + DDBLTFX_OFFSETS.fillColor, encodeRgb(rgb, fmt));
        await this.must("IDirectDrawSurface7_Blt", [surface, rectPtr, 0, 0, DDBLT_COLORFILL | DDBLT_WAIT, fx]);
    }

    /** draw_color_quad (ddraw7.c:767-795), as pre-transformed vertices over the whole target. */
    async drawColorQuad(device: number, colour: number, w: number, h: number): Promise<void> {
        const argb = (0xff000000 | colour) >>> 0;
        const stride = 20; // x,y,z,rhw,diffuse
        const verts = this.alloc(stride * 4);
        const corners: [number, number][] = [[0, 0], [w, 0], [0, h], [w, h]];
        corners.forEach(([x, y], i) => {
            const at = verts + i * stride;
            this.setF32(at, x); this.setF32(at + 4, y); this.setF32(at + 8, 0.5); this.setF32(at + 12, 1);
            this.setU32(at + 16, argb);
        });
        await this.must("IDirect3DDevice7_SetRenderState", [device, D3DRENDERSTATE_LIGHTING, 0]);
        await this.must("IDirect3DDevice7_SetRenderState", [device, D3DRENDERSTATE_ZENABLE, 0]);
        await this.must("IDirect3DDevice7_SetRenderState", [device, D3DRENDERSTATE_CULLMODE, D3DCULL_NONE]);
        await this.must("IDirect3DDevice7_BeginScene", [device]);
        await this.must("IDirect3DDevice7_DrawPrimitive",
            [device, D3DPT_TRIANGLESTRIP, D3DFVF_XYZRHW | D3DFVF_DIFFUSE, verts, 4, 0]);
        await this.must("IDirect3DDevice7_EndScene", [device]);
    }
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

const check = (
    name: string, wine: string, expected: string, observed: string, pass: boolean, note?: string,
): ConformanceCheck => ({ name, wine, expected, observed, pass, ...(note ? { note } : {}) });

/** A group that could not run reports WHERE it stopped — a setup error is evidence too. */
const setupFailure = (name: string, wine: string, e: unknown): ConformanceCheck => check(
    name, wine, "the assertion runs", `setup failed: ${e instanceof Error ? e.message : String(e)}`, false,
    "the statement was never reached — fix the setup before reading this row as a conformance failure",
);

/**
 * A DirectDraw colour key is a single value, never a range — no hardware implemented the
 * range form. Getting this wrong is invisible from the outside: a title that asked for a
 * range was REFUSED on the machine it was written for and took another path, while a
 * permissive implementation hands it a key that silently rejects a whole band of colours.
 */
async function assertColorKeyRange(s: Scene, ddraw: number, out: ConformanceCheck[]): Promise<void> {
    const WINE = "ddraw1.c:10532-10604 test_colorkey_range";
    const CAPS = DDSCAPS_OFFSCREENPLAIN;
    /** A create whose desc declares ddckCKSrcBlt low..high; returns the HRESULT. */
    const createWithKey = async (low: number, high: number): Promise<number> => {
        const d = s.desc();
        s.setU32(d + DDSURFACEDESC2_OFFSETS.width, 1);
        s.setU32(d + DDSURFACEDESC2_OFFSETS.height, 1);
        s.setU32(d + DDSURFACEDESC2_OFFSETS.caps, CAPS);
        s.writeKeyDescPixelFormat(d);
        s.setU32(d + DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt, low);
        s.setU32(d + DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt + 4, high);
        s.setU32(d + DDSURFACEDESC2_OFFSETS.flags,
            DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_CKSRCBLT);
        const outPtr = s.alloc(4);
        s.setU32(outPtr, 0);
        return s.call("IDirectDraw7_CreateSurface", [ddraw, d, outPtr, 0]);
    };

    try {
        const ranged = await createWithKey(0x00000000, 0x00000001);
        out.push(check(
            "colorKey.createRangeRefused", WINE, hex(DDERR_NOCOLORKEYHW), hex(ranged >>> 0),
            (ranged >>> 0) === DDERR_NOCOLORKEYHW,
            "CreateSurface with DDSD_CKSRCBLT and low != high must fail — no surface is created",
        ));

        const single = await createWithKey(0x00000000, 0x00000000);
        out.push(check(
            "colorKey.createSingleAccepted", WINE, hex(DD_OK), hex(single >>> 0),
            (single >>> 0) === DD_OK,
            "the control: the same create with low == high must still succeed",
        ));

        const surface = await s.createSurface(ddraw, CAPS, 1, 1);
        const key = s.alloc(8);

        // Without DDCKEY_COLORSPACE the high dword is IGNORED, not honoured: the key
        // collapses to low and the call succeeds.
        s.setU32(key, 0x00000000);
        s.setU32(key + 4, 0x00000001);
        const collapsed = await s.call("IDirectDrawSurface7_SetColorKey", [surface, DDCKEY_SRCBLT, key]);
        s.setU32(key, 0xdeadbeef);
        s.setU32(key + 4, 0xdeadbeef);
        await s.call("IDirectDrawSurface7_GetColorKey", [surface, DDCKEY_SRCBLT, key]);
        const readLow = s.u32(key), readHigh = s.u32(key + 4);
        out.push(check(
            "colorKey.setRangeCollapses", WINE, `${hex(DD_OK)} then 0x0-0x0`,
            `${hex(collapsed >>> 0)} then ${hex(readLow)}-${hex(readHigh)}`,
            (collapsed >>> 0) === DD_OK && readLow === 0 && readHigh === 0,
            "a range passed WITHOUT DDCKEY_COLORSPACE is accepted and collapsed to low",
        ));

        // With the flag, the same range is refused — for src and for dest alike.
        s.setU32(key, 0x00000001);
        s.setU32(key + 4, 0x00000000);
        const srcRanged = await s.call(
            "IDirectDrawSurface7_SetColorKey", [surface, DDCKEY_SRCBLT | DDCKEY_COLORSPACE, key]);
        out.push(check(
            "colorKey.srcColorspaceRangeRefused", WINE, hex(DDERR_NOCOLORKEYHW), hex(srcRanged >>> 0),
            (srcRanged >>> 0) === DDERR_NOCOLORKEYHW,
            "DDCKEY_SRCBLT|DDCKEY_COLORSPACE with low != high has no hardware behind it",
        ));

        const destRanged = await s.call(
            "IDirectDrawSurface7_SetColorKey", [surface, DDCKEY_DESTBLT | DDCKEY_COLORSPACE, key]);
        out.push(check(
            "colorKey.destColorspaceRangeRefused", WINE, hex(DDERR_NOCOLORKEYHW), hex(destRanged >>> 0),
            (destRanged >>> 0) === DDERR_NOCOLORKEYHW,
            "range DESTINATION keys do not work either",
        ));

        // The flag on a SINGLE value is simply ignored — the refusal is about the range,
        // not about the flag, and a check that cannot tell those apart proves nothing.
        s.setU32(key, 0x00000000);
        s.setU32(key + 4, 0x00000000);
        const singleWithFlag = await s.call(
            "IDirectDrawSurface7_SetColorKey", [surface, DDCKEY_SRCBLT | DDCKEY_COLORSPACE, key]);
        out.push(check(
            "colorKey.colorspaceSingleAccepted", WINE, hex(DD_OK), hex(singleWithFlag >>> 0),
            (singleWithFlag >>> 0) === DD_OK,
            "DDCKEY_COLORSPACE is ignored when the key is a single value",
        ));
    } catch (e) {
        out.push(setupFailure("colorKey.createRangeRefused", WINE, e));
    }
}

async function assertFlip3d(s: Scene, ddraw: number, d3d: number, out: ConformanceCheck[]): Promise<void> {
    const WINE = "ddraw7.c:20301-20347 test_flip_3d";
    try {
        const front = await s.createSurface(
            ddraw,
            DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE | DDSCAPS_FLIP | DDSCAPS_COMPLEX,
            FLIP_W, FLIP_H, FLIP_BACKBUFFERS,
        );
        const buffers = [front];
        for (let i = 0; i < FLIP_BACKBUFFERS; i++) {
            const caps = s.alloc(16);
            s.setU32(caps, DDSCAPS_FLIP);
            const outPtr = s.alloc(4);
            await s.must("IDirectDrawSurface7_GetAttachedSurface", [buffers[i]!, caps, outPtr]);
            const next = s.u32(outPtr);
            if (!next) throw new CallFailure(`GetAttachedSurface(chain slot ${i + 1})`, DD_OK);
            buffers.push(next);
        }

        const devOut = s.alloc(4);
        await s.must("IDirect3D7_CreateDevice", [d3d, s.guid(IID_IDirect3DHALDevice), buffers[0]!, devOut]);
        const device = s.u32(devOut);
        await s.must("IDirect3DDevice7_SetRenderTarget", [device, buffers[0]!, 0]);

        await s.drawColorQuad(device, GREEN, FLIP_W, FLIP_H);
        await s.must("IDirectDrawSurface7_Flip", [buffers[0]!, 0, DDFLIP_WAIT]);
        await s.drawColorQuad(device, BLUE, FLIP_W, FLIP_H);

        const current = await s.surfaceColor(buffers[0]!, 0, 0);
        out.push(check(
            "flip3d.currentBackBuffer", WINE, hex(BLUE, 6),
            `${hex(current.rgb, 6)} (raw ${hex(current.raw)}, ${current.fmt.bpp}bpp)`,
            current.rgb === BLUE,
            "the quad drawn AFTER the Flip; the pre-Flip colour here means a stale frame was served",
        ));

        const other = await s.surfaceColor(buffers[FLIP_BACKBUFFERS]!, 0, 0);
        out.push(check(
            "flip3d.otherChainSlot", WINE, hex(GREEN, 6),
            `${hex(other.rgb, 6)} (raw ${hex(other.raw)}, ${other.fmt.bpp}bpp)`,
            other.rgb === GREEN,
            "the pre-Flip quad must still be readable in the slot the rotation moved it to",
        ));
    } catch (e) {
        out.push(setupFailure("flip3d.currentBackBuffer", WINE, e));
        out.push(setupFailure("flip3d.otherChainSlot", WINE, e));
    }
}

/**
 * A 1x1 read of each quadrant of a GPU-authored surface. Four DDBLT_COLORFILLs give the
 * surface a pattern a whole-surface read cannot fake: a Lock that ignores the rect answers
 * every probe with the (0,0) quadrant, so the origin probe is the control that stays green
 * while the other three go red.
 */
async function assertSubRect1x1(s: Scene, ddraw: number, out: ConformanceCheck[]): Promise<void> {
    const WINE = "ddraw7.c:453-474 get_surface_color (used by check_rect_, 500-535)";
    const probes: { x: number; y: number; rgb: number }[] = [];
    try {
        const surface = await s.createSurface(ddraw, DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE, PLAIN_W, PLAIN_H);
        const probe = await s.fullLockFirstPixel(surface); // the format the surface actually has
        const fmt = probe.fmt;
        const hw = PLAIN_W >> 1, hh = PLAIN_H >> 1;
        const quadrants: { rect: [number, number, number, number]; rgb: number }[] = [
            { rect: [0, 0, hw, hh], rgb: RED },
            { rect: [hw, 0, PLAIN_W, hh], rgb: GREEN },
            { rect: [0, hh, hw, PLAIN_H], rgb: BLUE },
            { rect: [hw, hh, PLAIN_W, PLAIN_H], rgb: WHITE },
        ];
        for (const q of quadrants) await s.colorFill(surface, q.rgb, fmt, s.rect(...q.rect));

        probes.push(
            { x: 0, y: 0, rgb: RED },
            { x: hw + 1, y: 1, rgb: GREEN },
            { x: 1, y: hh + 1, rgb: BLUE },
            { x: PLAIN_W - 1, y: PLAIN_H - 1, rgb: WHITE },
            { x: hw, y: hh, rgb: WHITE },
        );
        for (const p of probes) {
            const got = await s.surfaceColor(surface, p.x, p.y);
            out.push(check(
                `subrect1x1.(${p.x},${p.y})`, WINE, hex(p.rgb, 6),
                `${hex(got.rgb, 6)} (raw ${hex(got.raw)}, ${got.fmt.bpp}bpp)`,
                got.rgb === p.rgb,
                p.x === 0 && p.y === 0 ? "origin probe: the control a rect-ignoring Lock still answers correctly" : undefined,
            ));
        }
    } catch (e) {
        const names = probes.length ? probes.map((p) => `subrect1x1.(${p.x},${p.y})`) : ["subrect1x1.setup"];
        for (const n of names) if (!out.some((c) => c.name === n)) out.push(setupFailure(n, WINE, e));
    }
}

async function assertColorfillFullLock(s: Scene, ddraw: number, out: ConformanceCheck[]): Promise<void> {
    const WINE = "ddraw7.c:20639-20679 test_sysmem_x_channel";
    try {
        const surface = await s.createSurface(ddraw, DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, PLAIN_W, PLAIN_H);
        const before = await s.fullLockFirstPixel(surface);
        await s.colorFill(surface, GREEN, before.fmt, 0);
        const got = await s.fullLockFirstPixel(surface);

        out.push(check(
            "colorfill.fullSurfaceLock", WINE, hex(GREEN, 6),
            `${hex(got.rgb, 6)} (raw ${hex(got.raw)}, ${got.fmt.bpp}bpp)`,
            got.rgb === GREEN,
            "a full-surface Lock(NULL, DDLOCK_READONLY) must show the DDBLT_COLORFILL",
        ));

        // Wine compares the WHOLE dword: on a B8G8R8X8 surface the unused X channel reads 0.
        const expectRaw = encodeRgb(GREEN, got.fmt) >>> 0;
        const applicable = got.fmt.bpp === 32 && got.fmt.aMask === 0;
        out.push(check(
            "colorfill.xChannel", WINE, applicable ? hex(expectRaw) : "n/a",
            applicable ? hex(got.raw) : `not asserted (surface came back ${got.fmt.bpp}bpp, aMask ${hex(got.fmt.aMask)})`,
            applicable ? got.raw === expectRaw : true,
            "Wine's own compare is the full DWORD — the X channel of an X8R8G8B8 fill reads 0",
        ));
    } catch (e) {
        out.push(setupFailure("colorfill.fullSurfaceLock", WINE, e));
        out.push(setupFailure("colorfill.xChannel", WINE, e));
    }
}

async function assertLockExclusivity(s: Scene, ddraw: number, out: ConformanceCheck[]): Promise<void> {
    const WINE = "ddraw7.c:14292-14300 test_getdc (Lock exclusivity)";
    try {
        const surface = await s.createSurface(ddraw, DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, PLAIN_W, PLAIN_H);
        const first = await s.call("IDirectDrawSurface7_Lock", [surface, 0, s.desc(), DDLOCK_READONLY | DDLOCK_WAIT, 0]);
        if (first !== DD_OK) throw new CallFailure("IDirectDrawSurface7_Lock (first)", first);
        const second = await s.call("IDirectDrawSurface7_Lock", [surface, 0, s.desc(), DDLOCK_READONLY | DDLOCK_WAIT, 0]);
        const unlock = await s.call("IDirectDrawSurface7_Unlock", [surface, 0]);

        out.push(check(
            "lockExclusivity.secondLock", WINE, hex(DDERR_SURFACEBUSY), hex(second),
            second === DDERR_SURFACEBUSY,
            `DDLOCK_WAIT does not make a second Lock legal (first Lock ${hex(first)}, Unlock ${hex(unlock)})`,
        ));
    } catch (e) {
        out.push(setupFailure("lockExclusivity.secondLock", WINE, e));
    }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const ARENA_BYTES = 0x10000;

export async function runDDrawConformance(opts: { mutate?: Mutation | null } = {}): Promise<ConformanceResult> {
    const mutation = opts.mutate ?? null;
    if (mutation && !(mutation in MUTATIONS)) {
        throw new Error(`ddrawConformance: unknown mutation '${mutation}' (have: ${Object.keys(MUTATIONS).join(", ")})`);
    }

    const system = System.getInstance();
    const process = system.process;
    if (!process) throw new Error("ddrawConformance: no process — the emulator has not reached emulator-ready");
    const ddrawModule = process.getModule("ddraw") as DDraw | undefined;
    if (!ddrawModule) throw new Error("ddrawConformance: ddraw module not registered");

    // A bundle-less tab may not have handed the module its backend yet; the D3D half of the
    // scene needs the executor, so wire it here rather than reporting four format failures.
    if (!system.ddrawContext?.executor) {
        const backend = system.services.render.getBackend();
        if (backend?.kind !== "webgpu") {
            throw new Error(`ddrawConformance: needs the WebGPU backend, have '${backend?.kind ?? "none"}'`);
        }
        ddrawModule.setBackend(backend as WebGPUBackend);
    }

    const globals = globalThis as { __noReadLockReadback?: boolean };
    const previousNoReadback = globals.__noReadLockReadback;
    if (mutation === "stale-read-lock") globals.__noReadLockReadback = true;

    const arena = process.memory.alloc(ARENA_BYTES, "HEAP", "rw", 16);
    const checks: ConformanceCheck[] = [];
    try {
        const s = new Scene(ddrawModule.exports, arena, arena + ARENA_BYTES, mutation);

        const ddOut = s.alloc(4);
        await s.must("DirectDrawCreateEx", [0, ddOut, s.guid(IID_IDirectDraw7), 0]);
        const ddraw = s.u32(ddOut);
        await s.must("IDirectDraw7_SetCooperativeLevel", [ddraw, 0, DDSCL_NORMAL]);
        const d3dOut = s.alloc(4);
        await s.must("IDirectDraw7_QueryInterface", [ddraw, s.guid(IID_IDirect3D7), d3dOut]);
        const d3d = s.u32(d3dOut);

        await assertFlip3d(s, ddraw, d3d, checks);
        await assertSubRect1x1(s, ddraw, checks);
        await assertColorfillFullLock(s, ddraw, checks);
        await assertLockExclusivity(s, ddraw, checks);
        await assertColorKeyRange(s, ddraw, checks);

        const failed = checks.filter((c) => !c.pass).length;
        // Whether a mutation was CAUGHT is a two-run question (clean vs mutated) and is
        // decided by the caller, which holds both. A single run cannot tell "I broke this"
        // from "this was already red".
        return {
            checks,
            passed: checks.length - failed,
            failed,
            mutation,
            setup: {
                ddraw: hex(ddraw),
                d3d: hex(d3d),
                arena: hex(arena),
                displayBpp: system.ddrawContext?.display.bpp ?? 0,
                mutationHow: mutation ? MUTATIONS[mutation].how : "none",
            },
        };
    } finally {
        globals.__noReadLockReadback = previousNoReadback;
        process.memory.free(arena);
    }
}

export function registerDDrawConformanceCommands(svc: HarnessService): void {
    /** ddrawConformance({mutate}) — run the Wine ddraw7 read-lock assertions against our
     *  own implementation. No bundle required. `mutate` injects one of MUTATIONS. */
    svc.register("ddrawConformance", async (args) =>
        runDDrawConformance((args[0] ?? {}) as { mutate?: Mutation | null }));

    /** ddrawConformanceMutations() — the roster, so the scenario need not hardcode it. */
    svc.register("ddrawConformanceMutations", () =>
        Object.entries(MUTATIONS).map(([name, m]) => ({ name, how: m.how, groups: m.groups })));
}
