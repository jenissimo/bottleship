/** Checked guest accesses for the VC6 C++ helpers, including test hosts
 * without an address-space validator. Mem's rejected accesses return sentinels;
 * propagating them as successful ABI results would hide unsupported execution. */
import { Mem } from "../core/memory/mem-accessor";

function bounds(address: number, size: number): void {
    const memory = Mem.getView();
    if (!memory || !Number.isInteger(address) || !Number.isInteger(size) || address < 0 || size < 0
        || address + size > memory.length || address + size > 0x100000000) {
        throw new Error(`msvcp60: invalid guest range at 0x${address.toString(16)} (${size} bytes)`);
    }
}

export function vc6ReadBytes(address: number, size: number): Uint8Array {
    bounds(address, size);
    const bytes = Mem.readBytes(address, size);
    if (!bytes || bytes.length !== size) throw new Error(`msvcp60: invalid guest read at 0x${address.toString(16)}`);
    return bytes;
}

export function vc6WriteBytes(address: number, bytes: Uint8Array): void {
    bounds(address, bytes.length);
    if (Mem.writeBytes(address, bytes) !== bytes.length) {
        throw new Error(`msvcp60: invalid guest write at 0x${address.toString(16)}`);
    }
}

export function vc6ReadU32(address: number): number {
    const bytes = vc6ReadBytes(address, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

export function vc6WriteU32(address: number, value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    vc6WriteBytes(address, bytes);
}
