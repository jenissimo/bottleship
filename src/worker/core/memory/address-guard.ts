import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import type { RegionPerms } from "./address-space";
import { isGuestRangeCommitted } from "./guest-page-commit";

export function isValidAddress(mem: Uint8Array, address: number, size?: number, perms?: RegionPerms): boolean;
export function isValidAddress(address: number, size?: number, perms?: RegionPerms): boolean;
export function isValidAddress(
    memOrAddress: Uint8Array | number,
    addressOrSize?: number,
    sizeOrPerms?: number | RegionPerms,
    perms: RegionPerms = "rw"
): boolean {
    const address = typeof memOrAddress === "number" ? memOrAddress : (addressOrSize ?? 0);
    const size = typeof memOrAddress === "number"
        ? (addressOrSize ?? 1)
        : (typeof sizeOrPerms === "number" ? sizeOrPerms : 1);
    const finalPerms = typeof sizeOrPerms === "string" ? sizeOrPerms : perms;

    if (address < 0 || size < 0) {
        return false;
    }

    const space = System.getInstance().process?.addressSpace;
    if (!space) return true;

    const valid = space.validateRange(address, size, finalPerms);
    if (!valid) {
        Logger.warn(LogCategory.SYSTEM, `AddressGuard: invalid access 0x${address.toString(16)}+${size.toString(16)} perms=${finalPerms}`);
    }
    return valid;
}

/**
 * Probe a Win32 application's buffer, rather than raw boot/DOS guest memory.
 * GetSystemInfo advertises 0x10000 as the minimum application address. LOW_MEM
 * also backs emulator-owned boot structures, so raw AddressSpace/Mem permissions
 * alone cannot establish that those bytes are valid Win32 parameter storage.
 * CPU Win9x compatibility and its null-page diagnostic do not change ownership.
 * Optional NULL pointers remain an API-level decision; this only probes bytes.
 */
export function isValidUserAddress(mem: Uint8Array, address: number, size?: number, perms?: RegionPerms): boolean;
export function isValidUserAddress(address: number, size?: number, perms?: RegionPerms): boolean;
export function isValidUserAddress(
    memOrAddress: Uint8Array | number,
    addressOrSize?: number,
    sizeOrPerms?: number | RegionPerms,
    perms: RegionPerms = "rw"
): boolean {
    const numeric = typeof memOrAddress === "number";
    const address = numeric ? memOrAddress : (addressOrSize ?? 0);
    const size = numeric ? (addressOrSize ?? 1) : (typeof sizeOrPerms === "number" ? sizeOrPerms : 1);
    const finalPerms = typeof sizeOrPerms === "string" ? sizeOrPerms : perms;
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) ||
        address < 0 || address > 0xffffffff || size < 0 || address + size > 0x100000000 ||
        (size > 0 && address < 0x10000)) return false;

    const process = System.getInstance().process;
    // Derive the current length per call: a numeric probe must not retain an old
    // plain memory view across WASM growth. The fallback supports isolated users
    // with an AddressSpace but no running CPU.
    const memoryLength = numeric
        ? (process?.getCurrentMemory?.().length ?? process?.addressSpace?.getMemorySize?.())
        : memOrAddress.length;
    if (memoryLength === undefined || address + size > memoryLength) return false;
    // A reservation retains its region permissions after MEM_DECOMMIT. PTEs
    // establish whether the guest can actually touch the proposed user buffer.
    if (!isGuestRangeCommitted(address, size)) return false;
    if (process?.pageTableManager?.isRangeAccessible?.(address, size, finalPerms.includes('w')) === false) return false;

    return numeric
        ? isValidAddress(address, size, finalPerms)
        : isValidAddress(memOrAddress, address, size, finalPerms);
}

/**
 * Check if an address range overlaps with THUNK_CODE region.
 * THUNK_CODE is executable code that must never be written to by surfaces or game code.
 *
 * @param address Starting address
 * @param size Size of the range
 * @returns true if overlaps with THUNK_CODE, false otherwise
 */
export function overlapsThunkCode(address: number, size: number): boolean {
    if (address < 0 || size < 0) {
        return false;
    }

    const space = System.getInstance().process?.addressSpace;
    if (!space) return false;

    // THUNK_CODE is now created by ThunkMemoryManager, not as a layout bucket
    const thunkRegion = space.findRegionByKind("THUNK_CODE") ?? space.getLayoutBucket("THUNK_CODE");
    if (!thunkRegion) return false;

    const end = address + size;
    const thunkEnd = thunkRegion.base + thunkRegion.size;

    return address < thunkEnd && end > thunkRegion.base;
}

/**
 * Check if an address range is safe for surface pixels (not in THUNK_CODE or other protected regions).
 *
 * @param address Starting address
 * @param size Size of the range
 * @returns true if safe to use as surface memory, false otherwise
 */
export function isSafeSurfaceAddress(address: number, size: number): boolean {
    if (address < 0 || size < 0) {
        return false;
    }

    // Check basic validity (not in noaccess regions)
    if (!isValidAddress(address, size, "rw")) {
        return false;
    }

    // Explicitly check THUNK_CODE overlap
    if (overlapsThunkCode(address, size)) {
        Logger.error(LogCategory.SYSTEM,
            `🚨 isSafeSurfaceAddress: BLOCKED - address 0x${address.toString(16)} size 0x${size.toString(16)} ` +
            `overlaps THUNK_CODE region!`);
        return false;
    }

    return true;
}
