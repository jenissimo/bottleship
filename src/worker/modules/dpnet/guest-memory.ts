import type { Process } from "../../core/process";
import { Mem } from "../../core/memory/mem-accessor";
import { decodeAnsiString, getAnsiCodePage } from "../codepage-utils";
export class DirectPlayGuestMemory {
    constructor(readonly process: Process) {}
    valid(ptr: number, size: number, perms: "r" | "rw" | "rx" = "r"): boolean {
        return Number.isSafeInteger(ptr) && ptr >= 0x1000 && Number.isSafeInteger(size) && size >= 0 &&
            ptr + size <= this.process.getCurrentMemory().length && (this.process.addressSpace?.validateRange(ptr, size, perms) ?? true);
    }
    string(ptr: number, wide = true, limit = 32768): string | null {
        if (!ptr) return null;
        if (wide) {
            let s = "";
            for (let i = 0; i <= limit; i++) {
                if (!this.valid(ptr + i * 2, 2)) return null;
                const n = Mem.readUint16(ptr + i * 2)!; if (!n) return s; s += String.fromCharCode(n);
            }
        } else {
            const bytes: number[] = [];
            for (let i = 0; i <= limit; i++) {
                if (!this.valid(ptr + i, 1)) return null;
                const n = Mem.readUint8(ptr + i)!;
                if (!n) return decodeAnsiString(new Uint8Array(bytes), 0, bytes.length, getAnsiCodePage());
                bytes.push(n);
            }
        }
        return null;
    }
}
