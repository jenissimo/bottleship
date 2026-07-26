import { System } from "../../core/system";
import { Mem } from "../../core/memory/mem-accessor";
import { Logger, LogCategory } from "../../core/logger";
import { DirectDrawSurfaceObject } from "./com-objects";

export const bytesToGuid = (bytes: Uint8Array): string => {
    const data1 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    const data2 = (bytes[4] | (bytes[5] << 8)) >>> 0;
    const data3 = (bytes[6] | (bytes[7] << 8)) >>> 0;
    const data4 = Array.from(bytes.slice(8, 16))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

    return `{${data1.toString(16).padStart(8, "0")}-${data2.toString(16).padStart(4, "0")}-${data3
        .toString(16)
        .padStart(4, "0")}-${data4.slice(0, 4)}-${data4.slice(4)}}`;
};

export type Rect = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

export const readRect = (_mem: Uint8Array, address: number): Rect | null => {
    if (!address) return null;

    const left = Mem.readInt32(address);
    const top = Mem.readInt32(address + 4);
    const right = Mem.readInt32(address + 8);
    const bottom = Mem.readInt32(address + 12);

    if (left === null || top === null || right === null || bottom === null) {
        return null;
    }

    if (left > right || top > bottom) {
        return null;
    }

    return { left, top, right, bottom };
};

/**
 * Convert absolute address (process address space) to relative index in mem view.
 *
 * NOTE: In v86's memory model, x86 address A maps to mem8[A] = buffer[byteOffset + A].
 * Since we use the same mem8 array, mem[A] accesses the same location as x86 address A.
 * No conversion is needed - just use the address directly.
 *
 * The previous implementation (abs - mem.byteOffset) was WRONG and caused texture
 * data written by x86 code to be read from the wrong location.
 */
export const absToRel = (_mem: Uint8Array, abs: number): number => {
    // x86 address maps directly to mem[] index - no conversion needed
    return abs;
};

/**
 * Validate absolute address against address space.
 * This function expects ABSOLUTE addresses (process address space), not relative indices.
 */
export const isValidAddress = (_mem: Uint8Array, address: number, size: number = 1): boolean => {
    if (address < 0 || size < 0) {
        return false;
    }

    const process = System.getInstance().process;
    const space = process?.addressSpace;
    if (!space) return true;
    const valid = space.validateRange(address, size, "rw");
    if (!valid) {
        Logger.warn(LogCategory.SYSTEM, `isValidAddress: rejected 0x${address.toString(16)}+${size.toString(16)}`);
    }
    return valid;
};

/**
 * Convert guest pointer (absolute address) to offset for mem[] indexing.
 * Guest address X maps to mem[X] directly — do NOT subtract mem.byteOffset.
 * (mem.byteOffset can be ~9.5MB in WASM v86, but mem[] is already indexed by guest address.)
 *
 * @param ptr - Guest absolute address
 * @param memView - Uint8Array view on guest memory
 * @returns The same ptr (guest addresses are direct mem[] indices), or -1 if invalid
 */
export const guestPtrToMemOffset = (ptr: number, memView: Uint8Array): number => {
    if (ptr < 0) return -1;
    if (ptr >= memView.length) {
        Logger.warn(LogCategory.SYSTEM,
            `guestPtrToMemOffset: out of bounds ptr=0x${ptr.toString(16)} mem.length=${memView.length}`
        );
        return -1;
    }
    return ptr;
};

/**
 * Utility functions for safe absolute address access.
 * Never use mem[abs] directly - always use these utilities.
 * Guest absolute addresses map directly to mem indices (absToRel is identity).
 */

/**
 * Get relative offset for absolute address (for use with mem[] or DataView)
 */
export const rel = (mem: Uint8Array, abs: number): number => {
    return absToRel(mem, abs);
};

/**
 * Read Uint32 from absolute address
 */
export const readU32Abs = (mem: Uint8Array, abs: number): number | null => {
    const r = absToRel(mem, abs);
    if (r < 0 || r + 4 > mem.length) return null;
    return new DataView(mem.buffer, mem.byteOffset + r, 4).getUint32(0, true);
};

/**
 * Read Uint16 from absolute address
 */
export const readU16Abs = (mem: Uint8Array, abs: number): number | null => {
    const r = absToRel(mem, abs);
    if (r < 0 || r + 2 > mem.length) return null;
    return new DataView(mem.buffer, mem.byteOffset + r, 2).getUint16(0, true);
};

/**
 * Read bytes from absolute address
 */
export const readBytesAbs = (mem: Uint8Array, abs: number, length: number): Uint8Array | null => {
    const r = absToRel(mem, abs);
    if (r < 0 || r + length > mem.length) return null;
    return mem.subarray(r, r + length);
};

/**
 * Typed surface lookup. COM object addresses are recycled: once a surface is
 * released its slot can be handed to a device / execute buffer / texture, so a
 * cached address (ctx.surfaces.primary, an attached-surface link, a mip parent)
 * may resolve to an object that is NOT a surface. Casting blindly and calling
 * getState() throws deep inside an unrelated call. Resolve through this instead.
 */
export const surfaceAt = (
    provider: { getComObjectByAddress(addr: number): unknown },
    addr: number,
): DirectDrawSurfaceObject | null => {
    if (!addr) return null;
    const obj = provider.getComObjectByAddress(addr);
    if (obj instanceof DirectDrawSurfaceObject) return obj;
    if (obj) {
        Logger.verbose(LogCategory.DDRAW,
            `surfaceAt: 0x${addr.toString(16)} now holds ${obj.constructor.name}, not a surface`);
    }
    return null;
};
