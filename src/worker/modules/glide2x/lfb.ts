import { leaseRegistry } from "../../core/memory/lease-registry";
import { isSafeSurfaceAddress, isValidAddress, overlapsThunkCode } from "../../core/memory/address-guard";
import { MemoryAccessType, reportMemoryFault } from "../../core/memory/memory-fault";
import { Mem } from "../../core/memory/mem-accessor";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import {
    bytesPerPixelForLfbWriteMode,
    FXFALSE,
    FXTRUE,
    GLIDE_LFB_CANARY_VALUE,
    GLIDE_LFB_GUARD_BYTES,
    GR_BUFFER_BACKBUFFER,
    GR_BUFFER_FRONTBUFFER,
    GR_LFBINFO_SIZE,
    GR_LFB_SRC_FMT_1555,
    GR_LFB_SRC_FMT_1555_DEPTH,
    GR_LFB_SRC_FMT_555,
    GR_LFB_SRC_FMT_555_DEPTH,
    GR_LFB_SRC_FMT_565,
    GR_LFB_SRC_FMT_565_DEPTH,
    GR_LFB_SRC_FMT_888,
    GR_LFB_SRC_FMT_8888,
    GR_LFB_SRC_FMT_RLE16,
    GR_LFB_SRC_FMT_ZA16,
    GR_LFBWRITEMODE_1555,
    GR_LFBWRITEMODE_1555_DEPTH,
    GR_LFBWRITEMODE_565,
    GR_LFBWRITEMODE_565_DEPTH,
    GR_LFBWRITEMODE_ANY,
    GR_LFBWRITEMODE_555,
    GR_LFBWRITEMODE_555_DEPTH,
    GR_LFBWRITEMODE_888,
    GR_LFBWRITEMODE_8888,
    GR_LFBWRITEMODE_ZA16,
    GR_LFB_READ_ONLY,
} from "./constants";
import { GlideContext, GlideLfbSurfaceState } from "./context";
import { GrLfbInfoView } from "./structs";

const lfbInfoView = new GrLfbInfoView();

function shouldLogEntry(context: GlideContext): boolean {
    const fid = context.frameSnapshot.frameId;
    return fid < 30 || (fid & 63) === 0;
}

function setLfbError(context: GlideContext, code: number, message: string): void {
    context.frameSnapshot.lastError = {
        code: code >>> 0,
        message,
        timestamp: performance.now(),
    };
    context.diagnostics.push("error", `${code >>> 0}: ${message}`);
    if (shouldLogEntry(context)) {
        Logger.warn(LogCategory.SYSTEM, `[Glide][LFB] error 0x${(code >>> 0).toString(16)}: ${message}`);
    }
}

function raiseFault(
    context: GlideContext,
    address: number,
    size: number,
    perms: string,
    accessType: MemoryAccessType,
    where: string,
    reason: string,
): void {
    reportMemoryFault({
        address: address >>> 0,
        size: size >>> 0,
        perms,
        accessType,
        context: where,
        reason,
        region: context.process.addressSpace.getRegion(address),
    });
}

function initCanaries(base: number, size: number): boolean {
    const guard = new Uint8Array(GLIDE_LFB_GUARD_BYTES);
    guard.fill(GLIDE_LFB_CANARY_VALUE);
    const okLo = Mem.writeBytes(base, guard) === guard.length;
    const okHi = Mem.writeBytes(base + GLIDE_LFB_GUARD_BYTES + size, guard) === guard.length;
    return okLo && okHi;
}

function verifyCanaries(surface: GlideLfbSurfaceState): boolean {
    const lo = Mem.readBytes(surface.allocationBase, GLIDE_LFB_GUARD_BYTES);
    const hi = Mem.readBytes(surface.allocationBase + GLIDE_LFB_GUARD_BYTES + surface.byteSize, GLIDE_LFB_GUARD_BYTES);
    if (!lo || !hi) return false;
    for (let i = 0; i < GLIDE_LFB_GUARD_BYTES; i++) {
        if (lo[i] !== GLIDE_LFB_CANARY_VALUE || hi[i] !== GLIDE_LFB_CANARY_VALUE) {
            return false;
        }
    }
    return true;
}

function isSupportedSourceFormat(format: number): boolean {
    switch (format | 0) {
        case GR_LFB_SRC_FMT_565:
        case GR_LFB_SRC_FMT_555:
        case GR_LFB_SRC_FMT_1555:
        case GR_LFB_SRC_FMT_888:
        case GR_LFB_SRC_FMT_8888:
        case GR_LFB_SRC_FMT_565_DEPTH:
        case GR_LFB_SRC_FMT_555_DEPTH:
        case GR_LFB_SRC_FMT_1555_DEPTH:
        case GR_LFB_SRC_FMT_ZA16:
        case GR_LFB_SRC_FMT_RLE16:
            return true;
        default:
            return false;
    }
}

function sourceFormatToWriteMode(format: number): number {
    if ((format | 0) === GR_LFB_SRC_FMT_RLE16) {
        return GR_LFBWRITEMODE_565;
    }
    return format | 0;
}

function sourceFormatToBytesPerPixel(format: number): number {
    switch (format | 0) {
        case GR_LFB_SRC_FMT_565:
        case GR_LFB_SRC_FMT_555:
        case GR_LFB_SRC_FMT_1555:
        case GR_LFB_SRC_FMT_ZA16:
        case GR_LFB_SRC_FMT_RLE16:
            return 2;
        case GR_LFB_SRC_FMT_888:
        case GR_LFB_SRC_FMT_8888:
        case GR_LFB_SRC_FMT_565_DEPTH:
        case GR_LFB_SRC_FMT_555_DEPTH:
        case GR_LFB_SRC_FMT_1555_DEPTH:
            return 4;
        default:
            return 0;
    }
}

function computeSourceSpan(srcPtr: number, srcStride: number, height: number, rowBytes: number): { start: number; size: number } | null {
    if (height <= 0 || rowBytes <= 0) return null;
    const firstRowAddr = srcPtr >>> 0;
    const lastRowAddr = firstRowAddr + (height - 1) * srcStride;
    const start = Math.min(firstRowAddr, lastRowAddr);
    const end = Math.max(firstRowAddr, lastRowAddr) + rowBytes;
    const size = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0) return null;
    return { start, size };
}

function resolveTargetBuffer(context: GlideContext, requestedBuffer: number): number {
    if ((requestedBuffer | 0) >= 0) {
        return requestedBuffer | 0;
    }
    const current = context.renderBuffer | 0;
    if (current === GR_BUFFER_FRONTBUFFER || current === GR_BUFFER_BACKBUFFER) {
        return current;
    }
    return GR_BUFFER_BACKBUFFER;
}

function ensureSurfaceForBuffer(
    context: GlideContext,
    buffer: number,
    writeMode: number,
    bytesPerPixelOverride?: number,
): GlideLfbSurfaceState | null {
    const bpp = bytesPerPixelOverride ?? bytesPerPixelForLfbWriteMode(writeMode);
    const pitch = Math.max(1, context.width) * Math.max(1, bpp);
    const byteSize = Math.max(1, context.height) * pitch;
    const existing = context.lfbSurfaces.get(buffer);

    if (
        existing &&
        existing.width === context.width &&
        existing.height === context.height &&
        existing.pitch === pitch &&
        existing.bytesPerPixel === bpp
    ) {
        existing.writeMode = writeMode | 0;
        return existing;
    }

    if (existing?.activeLeaseId) {
        leaseRegistry.revokeLease(existing.activeLeaseId);
    }
    if (existing?.allocationBase) {
        context.process.memory.free(existing.allocationBase);
        context.lfbSurfaces.delete(buffer);
    }

    const total = byteSize + GLIDE_LFB_GUARD_BYTES * 2;
    const allocBase = context.process.allocateSurface(total);
    if (!allocBase) {
        setLfbError(context, 0x4001, `grLfb: allocation failed for buffer ${buffer}`);
        return null;
    }
    if (!isSafeSurfaceAddress(allocBase, total) || !isValidAddress(allocBase, total, "rw")) {
        raiseFault(
            context,
            allocBase,
            total,
            "rw",
            "write",
            "glide2x.grLfb.ensureSurfaceForBuffer",
            "Allocated LFB surface is outside safe surface region",
        );
        context.process.memory.free(allocBase);
        return null;
    }

    if (overlapsThunkCode(allocBase, total)) {
        raiseFault(
            context,
            allocBase,
            total,
            "rw",
            "write",
            "glide2x.grLfb.ensureSurfaceForBuffer",
            "LFB allocation overlaps THUNK_CODE",
        );
        context.process.memory.free(allocBase);
        return null;
    }

    const okCanary = initCanaries(allocBase, byteSize);
    if (!okCanary) {
        context.process.memory.free(allocBase);
        setLfbError(context, 0x4002, "grLfb: failed to initialize canaries");
        return null;
    }

    const surface: GlideLfbSurfaceState = {
        buffer,
        allocationBase: allocBase >>> 0,
        dataPtr: (allocBase + GLIDE_LFB_GUARD_BYTES) >>> 0,
        byteSize: byteSize >>> 0,
        pitch: pitch >>> 0,
        width: context.width,
        height: context.height,
        bytesPerPixel: bpp >>> 0,
        writeMode: writeMode | 0,
        dirty: false,
        activeLeaseId: 0,
    };

    // Fresh LFB surfaces start cleared to deterministic black.
    const zero = new Uint8Array(byteSize);
    Mem.writeBytes(surface.dataPtr, zero);

    context.lfbSurfaces.set(buffer, surface);
    return surface;
}

function revokeLock(context: GlideContext): void {
    const lock = context.activeLfbLock;
    if (!lock) return;
    leaseRegistry.revokeLease(lock.leaseId);
    const surface = context.lfbSurfaces.get(lock.buffer);
    if (surface) {
        surface.activeLeaseId = 0;
        if (lock.writeAccess) {
            surface.dirty = true;
            context.lfbContentVersion++;
            context.lfbWriteMark = context.stream.commandCount;
        }
    }
    context.activeLfbLock = null;
}

function copyRegionToGuest(
    surface: GlideLfbSurfaceState,
    srcX: number,
    srcY: number,
    width: number,
    height: number,
    dstPtr: number,
    dstStride: number,
): boolean {
    if (srcX >= surface.width || srcY >= surface.height) return false;
    const clippedWidth = Math.max(0, Math.min(width, surface.width - srcX));
    const clippedHeight = Math.max(0, Math.min(height, surface.height - srcY));
    if (clippedWidth <= 0 || clippedHeight <= 0) return false;
    const bpp = surface.bytesPerPixel;
    const rowBytes = clippedWidth * bpp;
    // The caller supplies the destination row stride in bytes; fall back to a
    // tightly-packed layout when a non-positive stride is given.
    const effectiveDstStride = dstStride > 0 ? dstStride : rowBytes;
    for (let y = 0; y < clippedHeight; y++) {
        const srcOffset = (srcY + y) * surface.pitch + srcX * bpp;
        const dstOffset = dstPtr + y * effectiveDstStride;
        const row = Mem.readBytes(surface.dataPtr + srcOffset, rowBytes);
        if (!row) return false;
        if (Mem.writeBytes(dstOffset, row) !== row.length) return false;
    }
    return true;
}

function copyRegionFromGuest(
    surface: GlideLfbSurfaceState,
    dstX: number,
    dstY: number,
    width: number,
    height: number,
    srcStride: number,
    srcPtr: number,
    srcBpp: number,
): boolean {
    if (dstX >= surface.width || dstY >= surface.height) return false;
    const clippedWidth = Math.max(0, Math.min(width, surface.width - dstX));
    const clippedHeight = Math.max(0, Math.min(height, surface.height - dstY));
    if (clippedWidth <= 0 || clippedHeight <= 0) return false;

    const copyBpp = Math.min(surface.bytesPerPixel, srcBpp);
    const rowBytes = clippedWidth * copyBpp;
    for (let y = 0; y < clippedHeight; y++) {
        const srcOffset = srcPtr + y * srcStride;
        const dstOffset = surface.dataPtr + (dstY + y) * surface.pitch + dstX * surface.bytesPerPixel;
        const row = Mem.readBytes(srcOffset, rowBytes);
        if (!row) return false;
        if (Mem.writeBytes(dstOffset, row) !== row.length) return false;
    }
    surface.dirty = true;
    return true;
}

export function validateAllLfbCanaries(context: GlideContext): boolean {
    for (const surface of context.lfbSurfaces.values()) {
        if (!verifyCanaries(surface)) {
            raiseFault(
                context,
                surface.allocationBase,
                surface.byteSize + GLIDE_LFB_GUARD_BYTES * 2,
                "rw",
                "write",
                "glide2x.grLfb.validateAllLfbCanaries",
                `LFB canary mismatch in buffer ${surface.buffer}`,
            );
            setLfbError(context, 0x4003, `LFB canary mismatch in buffer ${surface.buffer}`);
            return false;
        }
    }
    return true;
}

export function revokeAllLfbLeases(context: GlideContext): void {
    revokeLock(context);
    for (const surface of context.lfbSurfaces.values()) {
        if (surface.activeLeaseId) {
            leaseRegistry.revokeLease(surface.activeLeaseId);
            surface.activeLeaseId = 0;
        }
    }
}

export function destroyLfbSurfaces(context: GlideContext): void {
    revokeAllLfbLeases(context);
    for (const surface of context.lfbSurfaces.values()) {
        if (surface.allocationBase) {
            context.process.memory.free(surface.allocationBase);
        }
    }
    context.lfbSurfaces.clear();
    context.activeLfbLock = null;
}

/**
 * Publish the rendered frame into an LFB surface before the guest reads it.
 *
 * A read lock on the front/back buffer is the guest asking for the pixels the
 * rasterizer produced, not for its own last writes. The executor keeps a CPU
 * mirror of the render target (armed here, on the first read); this converts it
 * into the surface's own pixel layout so a post-process reads a real frame.
 */
export function syncSurfaceFromRenderedFrame(
    context: GlideContext,
    surface: GlideLfbSurfaceState,
    // Only a GUEST read may set lfbReadThisFrame: it feeds the composite-order
    // decision, so a debug dump that set it would change the frame it is inspecting.
    fromGuestRead = true,
): void {
    const executor = context.executor;
    if (!executor) return;
    if (fromGuestRead) context.lfbReadThisFrame = true;
    // Once per frame: a second sync would overwrite what the guest wrote after the first.
    if (context.lfbSyncedFrame === context.frameSnapshot.frameId) return;
    context.lfbSyncedFrame = context.frameSnapshot.frameId;
    // We are about to rewrite the surface behind the presenter's back; its cached
    // RGBA conversion is keyed on "the guest did not write since the last present"
    // and this write is not the guest's.
    context.lfbRgbaSource = 0;
    context.lfbContentVersion++;
    executor.enableFramebufferMirror();
    const mirror = executor.getFramebufferMirror();
    if (!mirror) return;

    const width = Math.min(surface.width, mirror.width);
    const height = Math.min(surface.height, mirror.height);
    if (width <= 0 || height <= 0) return;

    const bpp = surface.bytesPerPixel;
    const row = new Uint8Array(surface.pitch);
    const src = mirror.rgba;

    for (let y = 0; y < height; y++) {
        const srcRow = y * mirror.width * 4;
        if (bpp === 2) {
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 4;
                const r = src[s] ?? 0, g = src[s + 1] ?? 0, b = src[s + 2] ?? 0;
                let packed: number;
                switch (surface.writeMode) {
                    case GR_LFBWRITEMODE_555:
                        packed = (((r >> 3) & 0x1f) << 10) | (((g >> 3) & 0x1f) << 5) | ((b >> 3) & 0x1f);
                        break;
                    case GR_LFBWRITEMODE_1555:
                        packed = 0x8000 | (((r >> 3) & 0x1f) << 10) | (((g >> 3) & 0x1f) << 5) | ((b >> 3) & 0x1f);
                        break;
                    default: // 565 — the Voodoo's natural 16-bit colour buffer
                        packed = (((r >> 3) & 0x1f) << 11) | (((g >> 2) & 0x3f) << 5) | ((b >> 3) & 0x1f);
                        break;
                }
                row[x * 2] = packed & 0xff;
                row[x * 2 + 1] = (packed >>> 8) & 0xff;
            }
        } else if (bpp === 4) {
            for (let x = 0; x < width; x++) {
                const s = srcRow + x * 4;
                // ARGB in memory order for the default GR_COLORFORMAT_ARGB lane mapping.
                row[x * 4] = src[s + 2] ?? 0;
                row[x * 4 + 1] = src[s + 1] ?? 0;
                row[x * 4 + 2] = src[s] ?? 0;
                row[x * 4 + 3] = 0xff;
            }
        } else {
            return;
        }
        Mem.writeBytes(surface.dataPtr + y * surface.pitch, row.subarray(0, width * bpp));
    }
}

export function createLfbExports(context: GlideContext): Record<string, ThunkImplementation> {
    return {
        "_grLfbLock@24": (_ctx, _mem, args) => {
            const lockType = args[0] | 0;
            const buffer = args[1] | 0;
            // GR_LFBWRITEMODE_ANY (0xFF) lets Glide pick the buffer's natural format;
            // resolve it to 565 (our default 16-bit color buffer) and report that back,
            // otherwise the caller reads info->writeMode == 0xFF and can't pack pixels.
            const requestedWriteMode = args[2] | 0;
            const origin = args[3] | 0;
            const infoPtr = args[5] >>> 0;
            if (shouldLogEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grLfbLock type=${lockType} buf=${buffer} writeMode=${requestedWriteMode} ` +
                    `origin=${origin} infoPtr=0x${infoPtr.toString(16)} winOpen=${context.winOpen}`,
                );
            }
            if (!context.winOpen) return FXFALSE;
            if (context.activeLfbLock) {
                setLfbError(context, 0x4010, "grLfbLock called while another lock is active");
                return FXFALSE;
            }

            const writeAccess = lockType !== GR_LFB_READ_ONLY;
            const targetBuffer = resolveTargetBuffer(context, buffer);
            // A READ lock names no write mode, so it must not choose one: coercing ANY to
            // 565 here would re-lay an existing 8888 surface and then read it back in the
            // wrong format. Only a write lock may (re)configure the surface.
            const existingMode = context.lfbSurfaces.get(targetBuffer)?.writeMode;
            const writeMode = requestedWriteMode === GR_LFBWRITEMODE_ANY
                ? (existingMode ?? GR_LFBWRITEMODE_565)
                : requestedWriteMode;
            const surface = ensureSurfaceForBuffer(context, targetBuffer, writeMode);
            if (!surface) return FXFALSE;

            const owner = `glide2x_lfb_${targetBuffer}`;
            const leaseId = leaseRegistry.createLease(
                surface.dataPtr,
                surface.byteSize,
                owner,
                writeAccess ? "rw" : "r",
                {
                    pitch: surface.pitch,
                    tag: `grLfbLock(${targetBuffer})`,
                },
            );
            if (!leaseId) {
                setLfbError(context, 0x4011, "grLfbLock failed: lease conflict");
                return FXFALSE;
            }

            // A read lock obviously needs the frame. A WRITE lock does too once the
            // guest has read the frame this frame: it is writing back a post-process,
            // and the pixels it does not touch must still be the frame, not the
            // backdrop the guest last wrote.
            if (!writeAccess || context.lfbReadThisFrame) {
                syncSurfaceFromRenderedFrame(context, surface);
            }

            surface.activeLeaseId = leaseId;
            context.activeLfbLock = {
                type: lockType,
                buffer: targetBuffer,
                leaseId,
                infoPtr,
                writeMode,
                origin,
                dataPtr: surface.dataPtr,
                byteSize: surface.byteSize,
                pitch: surface.pitch,
                writeAccess,
            };
            lfbInfoView.setPtr(infoPtr).write(
                GR_LFBINFO_SIZE,
                surface.dataPtr,
                surface.pitch,
                surface.writeMode,
                origin,
            );

            context.frameSnapshot.lfbLocks++;
            if (!writeAccess) context.frameSnapshot.lfbReadLocks++;
            context.diagnostics.push("lfb_lock", `buf=${targetBuffer} lease=${leaseId} mode=${writeMode}`);
            return FXTRUE;
        },

        // LFB write configuration. grLfbWriteRegion carries its source format explicitly;
        // grLfbWriteColorFormat/Swizzle configure lane mapping on real hardware — track
        // state here; presenter/executor consume it when decoding 32-bit LFB pixels.
        "_grLfbConstantAlpha@4": () => 0,
        "_grLfbConstantDepth@4": () => 0,
        "_grLfbWriteColorFormat@4": (_ctx, _mem, args) => {
            const fmt = args[0] | 0;
            if (fmt < 0 || fmt > 3) {
                setLfbError(context, 0x4018, `grLfbWriteColorFormat: invalid format ${fmt}`);
                return 0;
            }
            context.lfbWriteColorFormat = fmt;
            return 0;
        },
        "_grLfbWriteColorSwizzle@8": (_ctx, _mem, args) => {
            context.lfbWriteColorSwizzleBytes = (args[0] | 0) !== 0;
            context.lfbWriteColorSwizzleWords = (args[1] | 0) !== 0;
            return 0;
        },

        "_grLfbUnlock@8": (_ctx, _mem, args) => {
            const lock = context.activeLfbLock;
            const buffer = args[1] | 0;
            if (shouldLogEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grLfbUnlock type=${args[0] | 0} buf=${buffer} ` +
                    `hasActiveLock=${!!lock} lockBuf=${lock?.buffer ?? -1}`,
                );
            }
            if (!lock) return FXFALSE;
            if (buffer !== lock.buffer && buffer !== GR_BUFFER_FRONTBUFFER && buffer !== GR_BUFFER_BACKBUFFER) {
                return FXFALSE;
            }

            const surface = context.lfbSurfaces.get(lock.buffer);
            if (!surface || !verifyCanaries(surface)) {
                if (surface) {
                    raiseFault(
                        context,
                        surface.allocationBase,
                        surface.byteSize + GLIDE_LFB_GUARD_BYTES * 2,
                        "rw",
                        "write",
                        "glide2x.grLfbUnlock",
                        "LFB canary mismatch on unlock",
                    );
                }
                setLfbError(context, 0x4012, "grLfbUnlock detected canary corruption");
                revokeLock(context);
                return FXFALSE;
            }

            revokeLock(context);
            context.frameSnapshot.lfbUnlocks++;
            context.diagnostics.push("lfb_unlock", `buf=${buffer}`);
            return FXTRUE;
        },

        // grLfbReadRegion(src_buffer, src_x, src_y, src_width, src_height, dst_stride, dst_data)
        // — 7 args (@28). The destination pointer is the LAST arg; args[5] is the row stride.
        "_grLfbReadRegion@28": (_ctx, _mem, args) => {
            const buffer = args[0] | 0;
            const srcX = Math.max(0, args[1] | 0);
            const srcY = Math.max(0, args[2] | 0);
            const width = Math.max(0, args[3] | 0);
            const height = Math.max(0, args[4] | 0);
            const dstStride = args[5] | 0;
            const dstPtr = args[6] >>> 0;

            if (shouldLogEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grLfbReadRegion buf=${buffer} src=(${srcX},${srcY}) ${width}x${height} ` +
                    `dstStride=${dstStride} dstPtr=0x${dstPtr.toString(16)}`,
                );
            }
            if (!dstPtr || width <= 0 || height <= 0) return FXFALSE;
            const surface = context.lfbSurfaces.get(buffer) ?? context.lfbSurfaces.get(context.renderBuffer);
            if (!surface) return FXFALSE;
            // Same contract as a read lock: this reads the frame buffer, not our copy of
            // what the guest last wrote into it.
            syncSurfaceFromRenderedFrame(context, surface);

            const rowBytes = width * surface.bytesPerPixel;
            const effectiveDstStride = dstStride > 0 ? dstStride : rowBytes;
            // Destination span: (height-1) full strides + one row of pixels.
            const total = effectiveDstStride * Math.max(0, height - 1) + rowBytes;
            if (!isValidAddress(dstPtr, total, "rw")) {
                setLfbError(context, 0x4013, "grLfbReadRegion invalid destination pointer");
                return FXFALSE;
            }
            if (overlapsThunkCode(dstPtr, total)) {
                raiseFault(
                    context,
                    dstPtr,
                    total,
                    "rw",
                    "write",
                    "glide2x.grLfbReadRegion",
                    "Destination overlaps THUNK_CODE",
                );
                return FXFALSE;
            }

            const ok = copyRegionToGuest(surface, srcX, srcY, width, height, dstPtr, effectiveDstStride);
            if (ok) {
                context.frameSnapshot.lfbReads++;
                context.diagnostics.push("lfb_read", `buf=${buffer} ${width}x${height}`);
            }
            return ok ? FXTRUE : FXFALSE;
        },

        "_grLfbWriteRegion@32": (_ctx, _mem, args) => {
            const buffer = args[0] | 0;
            const dstX = Math.max(0, args[1] | 0);
            const dstY = Math.max(0, args[2] | 0);
            const srcFormat = args[3] | 0;
            const width = Math.max(0, args[4] | 0);
            const height = Math.max(0, args[5] | 0);
            const srcStride = args[6] | 0;
            const srcPtr = args[7] >>> 0;

            if (shouldLogEntry(context)) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] grLfbWriteRegion ENTRY buf=${buffer} dst=(${dstX},${dstY}) fmt=${srcFormat} ` +
                    `${width}x${height} stride=${srcStride} srcPtr=0x${srcPtr.toString(16)}`,
                );
            }
            if (!srcPtr || width <= 0 || height <= 0 || srcStride === 0) {
                if (shouldLogEntry(context)) {
                    Logger.warn(
                        LogCategory.SYSTEM,
                        `[Glide] grLfbWriteRegion rejected: srcPtr=0x${srcPtr.toString(16)} ` +
                        `w=${width} h=${height} stride=${srcStride}`,
                    );
                }
                return FXFALSE;
            }
            if (!isSupportedSourceFormat(srcFormat)) {
                setLfbError(context, 0x4016, `grLfbWriteRegion unsupported source format ${srcFormat}`);
                return FXFALSE;
            }
            // Glide has a legacy RLE16 path, but it is intentionally unimplemented in 3dfx sources as well.
            if ((srcFormat | 0) === GR_LFB_SRC_FMT_RLE16) {
                setLfbError(context, 0x4017, "grLfbWriteRegion GR_LFB_SRC_FMT_RLE16 is not supported");
                return FXFALSE;
            }

            const formatBpp = sourceFormatToBytesPerPixel(srcFormat);
            const inferredBpp = Math.max(1, Math.min(4, Math.floor(Math.abs(srcStride) / Math.max(1, width))));
            const effectiveBpp = formatBpp > 0 ? formatBpp : inferredBpp;
            const targetWriteMode = sourceFormatToWriteMode(srcFormat);
            const targetBuffer = resolveTargetBuffer(context, buffer);
            const surface = ensureSurfaceForBuffer(context, targetBuffer, targetWriteMode, effectiveBpp);
            if (!surface) return FXFALSE;

            const clippedWidth = Math.max(0, Math.min(width, surface.width - dstX));
            const clippedHeight = Math.max(0, Math.min(height, surface.height - dstY));
            if ((context.frameSnapshot.frameId < 240 || ((context.frameSnapshot.frameId & 63) === 0))) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `[Glide] lfbWrite buf=${targetBuffer} fmt=${srcFormat} mode=${targetWriteMode} ` +
                    `dst=(${dstX},${dstY}) src=${width}x${height} stride=${srcStride} bpp=${effectiveBpp} ` +
                    `clip=${clippedWidth}x${clippedHeight} surf=${surface.width}x${surface.height}`
                );
            }
            if (clippedWidth <= 0 || clippedHeight <= 0) {
                return FXFALSE;
            }

            const rowBytes = width * effectiveBpp;
            const span = computeSourceSpan(srcPtr, srcStride, height, rowBytes);
            if (!span || !isValidAddress(span.start, span.size, "r")) {
                setLfbError(context, 0x4014, "grLfbWriteRegion invalid source pointer");
                return FXFALSE;
            }
            if (overlapsThunkCode(span.start, span.size)) {
                raiseFault(
                    context,
                    span.start,
                    span.size,
                    "r",
                    "read",
                    "glide2x.grLfbWriteRegion",
                    "Source overlaps THUNK_CODE",
                );
                return FXFALSE;
            }

            const ok = copyRegionFromGuest(surface, dstX, dstY, width, height, srcStride, srcPtr, effectiveBpp);
            if (ok) {
                context.lfbWriteMark = context.stream.commandCount;
                context.lfbContentVersion++;
                context.frameSnapshot.lfbWrites++;
                context.diagnostics.push("lfb_write", `buf=${targetBuffer} ${width}x${height} fmt=${srcFormat} bpp=${effectiveBpp}`);
            }
            return ok ? FXTRUE : FXFALSE;
        },
    };
}

