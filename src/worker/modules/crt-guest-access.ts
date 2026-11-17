import {Mem} from "../core/memory/mem-accessor";
import {isValidUserAddress} from "../core/memory/address-guard";
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
    return admitted(address, 2, "w") && Mem.writeUint16(address, value);
}

/** Fault attribution uses the same process guard as admission, then any extra Mem policy. */
export function crtFaultAddress(address: number, size: number, access: "r" | "w"): number {
    for (let i = 0; i < size; i++) if (!admitted(address + i, 1, access)) return address + i;
    return Mem.firstInaccessibleByte(address, size, access);
}
