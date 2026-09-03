/**
 * Glide Tier-0 write-buffer (WBUF) registration.
 *
 * A Glide title sets state per TRIANGLE. Carmageddon 2's menu measures ~1200
 * grDrawTriangle and ~5100 state-setter calls per frame, and every one of those
 * was an OUT trap: the JIT leaves its block, the dispatcher marshals a context,
 * JS runs for ~2.5us, execution resumes. The setters carry no return value and
 * dereference no guest pointer, so they belong on the ring — they then run as
 * JIT'd guest trampolines and JS sees them once per drain.
 *
 * That is the admission test, and it is why only SCALAR setters are here. A call
 * whose work reads through a guest pointer cannot be deferred: the guest keeps
 * running between the call and the drain, so the bytes read are the bytes at
 * drain time, not at call time. Struct capture copies an argument struct into the
 * ring and fixes that for the struct itself, but not for anything the struct
 * POINTS at.
 *
 * Ordering is preserved for free: grDrawTriangle stays a trapped call and the
 * dispatcher drains the ring before any trap, so a draw always observes every
 * setter that preceded it. That is also why per-funcId coalescing is safe — a
 * drain never spans two draws, so "last write wins within a drain" is exactly
 * "the state the next draw sees".
 *
 * Every handler here is the SAME implementation the trap path uses, adapted to
 * read its arguments from the ring. A second copy of the state machine would
 * drift silently: the two paths would disagree only under load, on whichever
 * setter someone edited once.
 *
 * Kill-switch for A/B: globalThis.__noGlideWbuf (boot-time).
 */

import { Logger, LogCategory } from "../../core/logger";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { GlideContext } from "./context";
import { applyGrTexSource } from "./texture";
import { ParsedGrTexInfo } from "./structs";
import { GR_TEXINFO_SIZE } from "./constants";

type WriteBufHandler = (mem8: Uint8Array, mem32: Uint32Array, dataPtr: number) => void;

/** Reused across drains — a drain is single-threaded and the impl never retains it. */
const argScratch: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Adapt a thunk implementation to the ring. The glide state handlers take
 * (ctx, mem, args) and touch neither ctx nor mem — they read scalars out of
 * `args` and write module state — so the ring's dwords are the whole input.
 */
function fromRing(impl: ThunkImplementation, argCount: number): WriteBufHandler {
    return (_mem8: Uint8Array, mem32: Uint32Array, dataPtr: number) => {
        for (let i = 0; i < argCount; i++) {
            argScratch[i] = mem32[(dataPtr + i * 4) >> 2] ?? 0;
        }
        impl(null as never, null as never, argScratch as never);
    };
}

/** argCount from the stdcall decoration, so it cannot drift from the export name. */
function argCountFromName(name: string): number {
    const at = name.lastIndexOf("@");
    if (at < 0) return -1;
    const bytes = Number(name.slice(at + 1));
    return Number.isFinite(bytes) ? bytes / 4 : -1;
}

/**
 * Scalar, last-write-wins setters. The mask names the argument that selects the
 * state slot (TMU index, hint type); 0 means the function itself is the slot.
 */
const WBUF_SETTERS: Array<[name: string, coalesceArgMask: number]> = [
    ["_grColorCombine@20", 0],
    ["_guColorCombineFunction@4", 0],
    ["_grAlphaCombine@20", 0],
    ["_grAlphaBlendFunction@16", 0],
    ["_grAlphaTestFunction@4", 0],
    ["_grAlphaTestReferenceValue@4", 0],
    ["_grConstantColorValue@4", 0],
    ["_grConstantColorValue4@16", 0],
    ["_grFogMode@4", 0],
    ["_grFogColorValue@4", 0],
    ["_grDepthMask@4", 0],
    ["_grDepthBufferMode@4", 0],
    ["_grDepthBufferFunction@4", 0],
    ["_grDepthBiasLevel@4", 0],
    ["_grChromakeyMode@4", 0],
    ["_grChromakeyValue@4", 0],
    ["_grCullMode@4", 0],
    ["_grColorMask@8", 0],
    ["_grDitherMode@4", 0],
    ["_grClipWindow@16", 0],
    ["_grViewport@16", 0],
    ["_grSstOrigin@4", 0],
    ["_grGammaCorrectionValue@4", 0],
    ["_grHints@8", 0x1],
    ["_grTexClampMode@12", 0x1],
    ["_grTexFilterMode@12", 0x1],
    ["_grTexMipMapMode@12", 0x1],
    ["_grTexLodBiasValue@8", 0x1],
    ["_grTexCombineFunction@8", 0x1],
    ["_grTexDetailControl@16", 0x1],
    ["_grTexCombine@28", 0x1],
    ["_grTexMultibase@8", 0x1],
    ["_grTexBaseAddress@8", 0x1],
];


/**
 * GrTexInfo is 5 dwords {smallLod, largeLod, aspectRatio, format, data} (glide.h) — the
 * whole struct fits in the ring, so the drain never dereferences the guest pointer.
 * Reused across drains: a drain is single-threaded and applyGrTexSource does not retain it.
 */
const capturedTexInfo: ParsedGrTexInfo = { smallLod: 0, largeLod: 0, aspectRatio: 0, format: 0, data: 0 };
const GR_TEXINFO_DWORDS = GR_TEXINFO_SIZE / 4;

/**
 * grTexSource(tmu, startAddress, evenOdd, GrTexInfo*) — the only hot Glide entry point
 * whose argument is a pointer, and the reason it stayed on the OUT trap while every
 * scalar setter moved to the ring. Real grTexSource (gtex.c) reads exactly the five
 * dwords of GrTexInfo and nothing they point at, so capture-at-call is not an
 * approximation of the contract, it IS the contract: the trampoline copies the struct
 * into the ring at call time and the drain reads it from there.
 *
 * Not a coalescer (the mask stays 0): consecutive grTexSource calls address different
 * TMU start addresses and each one binds, so "last write wins" would drop binds that a
 * later triangle depends on. Not a barrier either — it is a setter, and the draw that
 * observes it (grDrawTriangle) is still a trap, which is what drains the ring.
 */
function registerGrTexSourceCapture(
    dispatcher: {
        registerStructCaptureWriteBufferFunction?: (
            dll: string, func: string, argCount: number, ptrArgIndex: number,
            payloadDwords: number, handler: WriteBufHandler,
        ) => void;
    },
    context: GlideContext,
): boolean {
    if (typeof dispatcher.registerStructCaptureWriteBufferFunction !== "function") return false;
    if ((globalThis as unknown as { __noStructCapture?: boolean }).__noStructCapture) return false;

    // Ring entry: [funcId][tmu][startAddress][evenOdd][infoPtr][GrTexInfo × 5dw].
    dispatcher.registerStructCaptureWriteBufferFunction(
        "glide2x", "_grTexSource@16", 4, 3, GR_TEXINFO_DWORDS,
        (_mem8: Uint8Array, mem32: Uint32Array, dataPtr: number) => {
            const w = dataPtr >> 2;
            // The trampoline OUT-traps on a null pointer rather than capturing, so a null
            // infoPtr cannot reach here — but the capture must still mean "these are the
            // bytes at *infoPtr", not "five zeroes", or the two paths diverge on it.
            const infoPtr = mem32[w + 3]! >>> 0;
            capturedTexInfo.smallLod = mem32[w + 4]! | 0;
            capturedTexInfo.largeLod = mem32[w + 5]! | 0;
            capturedTexInfo.aspectRatio = mem32[w + 6]! | 0;
            capturedTexInfo.format = mem32[w + 7]! | 0;
            capturedTexInfo.data = mem32[w + 8]! >>> 0;
            applyGrTexSource(
                context,
                mem32[w]! | 0,
                mem32[w + 1]! >>> 0,
                mem32[w + 2]! | 0,
                infoPtr,
                infoPtr ? capturedTexInfo : null,
            );
        },
    );
    return true;
}

export function registerGlideWriteBufferFunctions(
    dispatcher: {
        registerWriteBufferFunction?: (
            dll: string, func: string, argCount: number, handler: WriteBufHandler,
            isStdcall?: boolean, coalesceArgMask?: number,
        ) => boolean | void;
        registerStructCaptureWriteBufferFunction?: (
            dll: string, func: string, argCount: number, ptrArgIndex: number,
            payloadDwords: number, handler: WriteBufHandler,
        ) => void;
    },
    exports: Record<string, ThunkImplementation>,
    context: GlideContext,
): void {
    if (typeof dispatcher.registerWriteBufferFunction !== "function") return;
    if ((globalThis as unknown as { __noGlideWbuf?: boolean }).__noGlideWbuf) {
        Logger.log(LogCategory.SYSTEM, "[Glide] WBUF disabled by __noGlideWbuf");
        return;
    }

    let registered = 0;
    let skipped = 0;
    for (const [name, mask] of WBUF_SETTERS) {
        const impl = exports[name];
        const argCount = argCountFromName(name);
        if (!impl || argCount < 1 || argCount > 8) { skipped++; continue; }
        if (dispatcher.registerWriteBufferFunction("glide2x", name, argCount, fromRing(impl, argCount), true, mask) === false) {
            skipped++;
            continue;
        }
        registered++;
    }

    const texSource = registerGrTexSourceCapture(dispatcher, context);
    Logger.log(LogCategory.SYSTEM,
        `[Glide] WBUF: grTexSource struct capture ${texSource ? "requested" : "unavailable"}`);

    // Registration can decline (the WBUF control page is not up yet), and a count of
    // ATTEMPTS would report a win that never happened.
    if (registered === 0) {
        Logger.warn(LogCategory.SYSTEM, `[Glide] WBUF: nothing registered (${skipped} declined) — every setter stays on the OUT trap`);
    } else {
        Logger.log(LogCategory.SYSTEM, `[Glide] WBUF: ${registered} entry points moved off the OUT trap (${skipped} declined)`);
    }
}
