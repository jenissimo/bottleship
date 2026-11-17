import {Mem} from "../core/memory/mem-accessor";
import {isValidUserAddress} from "../core/memory/address-guard";
import {invalidateGuestCode} from "../core/memory/guest-code";
import {System} from "../core/system";

/** CRT application pointers require admission even when privileged HLE memory is unvalidated. */
function admitted(address: number, size: number, access: "r" | "w"): boolean {
    // Without an active process, the bound Mem policy is the available access contract.
    return !System.getInstance().process?.addressSpace || isValidUserAddress(address, size, access === "w" ? "rw" : "r");
}

export function readCrtUint8(address: number): number | null {
    return admitted(address, 1, "r") ? Mem.readUint8(address) : null;
}

export function readCrtUint16(address: number): number | null {
    return admitted(address, 2, "r") ? Mem.readUint16(address) : null;
}

export function writeCrtUint16(address: number, value: number): boolean {
    if (!admitted(address, 2, "w") || !Mem.writeUint16(address, value)) return false;
    const space = System.getInstance().process?.addressSpace;
    const firstExecutable = space?.getRegion(address)?.perms.includes("x");
    const lastExecutable = space?.getRegion(address + 1)?.perms.includes("x");
    // Publish each successful word before a later access fault can enter guest SEH.
    // A crossing word may touch an executable page and an ordinary data page.
    if (firstExecutable) invalidateGuestCode(address, lastExecutable ? 2 : 1);
    else if (lastExecutable) invalidateGuestCode(address + 1, 1);
    return true;
}

/** Fault attribution uses the same process guard as admission, then any extra Mem policy. */
export function crtFaultAddress(address: number, size: number, access: "r" | "w"): number {
    for (let i = 0; i < size; i++) if (!admitted(address + i, 1, access)) return address + i;
    return Mem.firstInaccessibleByte(address, size, access);
}
