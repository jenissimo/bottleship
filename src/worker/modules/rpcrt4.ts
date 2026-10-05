/**
 * RPC Runtime (rpcrt4.dll) — UUID helpers.
 *
 * Guest UUID layout (rpcdce.h UUID == GUID, 16 bytes):
 *   +0  Data1  u32 LE
 *   +4  Data2  u16 LE
 *   +6  Data3  u16 LE
 *   +8  Data4  u8[8]
 *
 * UuidCreate returns a version-4 (random) UUID like post-XP Windows.
 * UuidToString* allocate the guest string; RpcStringFree* release it and
 * NULL the caller's pointer, matching the documented contract.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

const RPC_S_OK = 0;
const RPC_S_INVALID_ARG = 87;
const RPC_S_INVALID_STRING_UUID = 1705;

const UUID_STR_LEN = 36; // "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

export class Rpcrt4 implements IModule {
    name = "rpcrt4";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    initialize(process: Process): void {
        this.process = process;

        this.exports["UuidCreate"] = (_ctx, mem, args) => {
            return this.writeRandomUuid(mem, args[0]);
        };
        // Real UuidCreateSequential is MAC-address-based (v1); a random v4 satisfies
        // the uniqueness contract without host identifiers. RPC_S_OK, not
        // RPC_S_UUID_LOCAL_ONLY — callers treat anything != OK as failure.
        this.exports["UuidCreateSequential"] = (_ctx, mem, args) => {
            return this.writeRandomUuid(mem, args[0]);
        };
        this.exports["UuidCreateNil"] = (_ctx, mem, args) => {
            const ptr = args[0] >>> 0;
            if (ptr === 0) return RPC_S_OK;
            mem.fill(0, ptr, ptr + 16);
            return RPC_S_OK;
        };

        this.exports["UuidToStringA"] = (_ctx, mem, args) => {
            const out = args[1] >>> 0;
            if (out === 0) return RPC_S_INVALID_ARG;
            const str = this.formatUuid(mem, args[0] >>> 0);
            const buf = this.process.memory.alloc(UUID_STR_LEN + 1, "HEAP", "rw");
            for (let i = 0; i < str.length; i++) mem[buf + i] = str.charCodeAt(i);
            mem[buf + str.length] = 0;
            this.writeU32(mem, out, buf);
            return RPC_S_OK;
        };
        this.exports["UuidToStringW"] = (_ctx, mem, args) => {
            const out = args[1] >>> 0;
            if (out === 0) return RPC_S_INVALID_ARG;
            const str = this.formatUuid(mem, args[0] >>> 0);
            const buf = this.process.memory.alloc((UUID_STR_LEN + 1) * 2, "HEAP", "rw");
            for (let i = 0; i < str.length; i++) this.writeU16(mem, buf + i * 2, str.charCodeAt(i));
            this.writeU16(mem, buf + str.length * 2, 0);
            this.writeU32(mem, out, buf);
            return RPC_S_OK;
        };

        this.exports["UuidFromStringA"] = (_ctx, mem, args) => {
            const strPtr = args[0] >>> 0;
            const out = args[1] >>> 0;
            if (out === 0) return RPC_S_INVALID_ARG;
            if (strPtr === 0) { mem.fill(0, out, out + 16); return RPC_S_OK; } // NULL → nil UUID
            let s = "";
            for (let i = 0; i < UUID_STR_LEN + 1 && mem[strPtr + i] !== 0; i++) {
                s += String.fromCharCode(mem[strPtr + i]);
            }
            return this.parseUuid(mem, s, out);
        };
        this.exports["UuidFromStringW"] = (_ctx, mem, args) => {
            const strPtr = args[0] >>> 0;
            const out = args[1] >>> 0;
            if (out === 0) return RPC_S_INVALID_ARG;
            if (strPtr === 0) { mem.fill(0, out, out + 16); return RPC_S_OK; }
            let s = "";
            for (let i = 0; i < UUID_STR_LEN + 1; i++) {
                const c = mem[strPtr + i * 2] | (mem[strPtr + i * 2 + 1] << 8);
                if (c === 0) break;
                s += String.fromCharCode(c);
            }
            return this.parseUuid(mem, s, out);
        };

        this.exports["UuidCompare"] = (_ctx, mem, args) => {
            this.writeStatus(mem, args[2] >>> 0, RPC_S_OK);
            const a = this.readUuidBytes(mem, args[0] >>> 0);
            const b = this.readUuidBytes(mem, args[1] >>> 0);
            for (let i = 0; i < 16; i++) {
                if (a[i] !== b[i]) return a[i] < b[i] ? -1 >>> 0 : 1;
            }
            return 0;
        };
        this.exports["UuidEqual"] = (_ctx, mem, args) => {
            this.writeStatus(mem, args[2] >>> 0, RPC_S_OK);
            const a = this.readUuidBytes(mem, args[0] >>> 0);
            const b = this.readUuidBytes(mem, args[1] >>> 0);
            for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return 0;
            return 1;
        };
        this.exports["UuidIsNil"] = (_ctx, mem, args) => {
            this.writeStatus(mem, args[1] >>> 0, RPC_S_OK);
            const a = this.readUuidBytes(mem, args[0] >>> 0);
            for (let i = 0; i < 16; i++) if (a[i] !== 0) return 0;
            return 1;
        };
        // DCE 1.1 uuid_hash (mod-255 Fletcher fold over the 16 bytes).
        this.exports["UuidHash"] = (_ctx, mem, args) => {
            this.writeStatus(mem, args[1] >>> 0, RPC_S_OK);
            const a = this.readUuidBytes(mem, args[0] >>> 0);
            let c0 = 0, c1 = 0;
            for (let i = 0; i < 16; i++) { c0 = (c0 + a[i]) % 255; c1 = (c1 + c0) % 255; }
            const x = (255 - ((c0 + c1) % 255)) % 255;
            let y = (c1 - x) % 255;
            if (y < 0) y += 255;
            return ((x << 8) | y) & 0xffff;
        };

        this.exports["RpcStringFreeA"] = (_ctx, mem, args) => this.freeRpcString(mem, args[0] >>> 0);
        this.exports["RpcStringFreeW"] = (_ctx, mem, args) => this.freeRpcString(mem, args[0] >>> 0);
    }

    private writeRandomUuid(mem: Uint8Array, ptr: number): number {
        const p = ptr >>> 0;
        if (p === 0) return RPC_S_OK;
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        // Memory byte 7 is the high byte of LE Data3 (version); Data4[0] carries the variant.
        bytes[7] = (bytes[7] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        mem.set(bytes, p);
        return RPC_S_OK;
    }

    private readUuidBytes(mem: Uint8Array, ptr: number): Uint8Array {
        if (ptr === 0) return new Uint8Array(16); // NULL is treated as the nil UUID
        return mem.subarray(ptr, ptr + 16);
    }

    private formatUuid(mem: Uint8Array, ptr: number): string {
        const b = this.readUuidBytes(mem, ptr);
        const hex = (v: number, w: number) => v.toString(16).padStart(w, "0");
        const data1 = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
        const data2 = b[4] | (b[5] << 8);
        const data3 = b[6] | (b[7] << 8);
        let tail = "";
        for (let i = 8; i < 16; i++) tail += hex(b[i], 2);
        return `${hex(data1, 8)}-${hex(data2, 4)}-${hex(data3, 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
    }

    private parseUuid(mem: Uint8Array, s: string, out: number): number {
        if (out === 0) return RPC_S_INVALID_ARG;
        const m = /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})$/.exec(s.trim());
        if (!m) return RPC_S_INVALID_STRING_UUID;
        const data1 = parseInt(m[1], 16) >>> 0;
        const data2 = parseInt(m[2], 16);
        const data3 = parseInt(m[3], 16);
        this.writeU32(mem, out, data1);
        this.writeU16(mem, out + 4, data2);
        this.writeU16(mem, out + 6, data3);
        const tail = m[4] + m[5];
        for (let i = 0; i < 8; i++) mem[out + 8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16);
        return RPC_S_OK;
    }

    private freeRpcString(mem: Uint8Array, ptrToPtr: number): number {
        if (ptrToPtr === 0) return RPC_S_OK;
        const strPtr = (mem[ptrToPtr] | (mem[ptrToPtr + 1] << 8) | (mem[ptrToPtr + 2] << 16) | (mem[ptrToPtr + 3] << 24)) >>> 0;
        if (strPtr !== 0) this.process.memory.free(strPtr);
        this.writeU32(mem, ptrToPtr, 0);
        return RPC_S_OK;
    }

    private writeU32(mem: Uint8Array, addr: number, value: number): void {
        mem[addr] = value & 0xff;
        mem[addr + 1] = (value >> 8) & 0xff;
        mem[addr + 2] = (value >> 16) & 0xff;
        mem[addr + 3] = (value >> 24) & 0xff;
    }

    private writeStatus(mem: Uint8Array, addr: number, value: number): void {
        if (addr !== 0) this.writeU32(mem, addr, value);
    }

    private writeU16(mem: Uint8Array, addr: number, value: number): void {
        mem[addr] = value & 0xff;
        mem[addr + 1] = (value >> 8) & 0xff;
    }
}
