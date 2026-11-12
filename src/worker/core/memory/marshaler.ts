// marshaler.ts
// Handles data translation between x86 memory and JS objects

import { MemoryGuard } from "./mem-guard";
import { EmulatorConfig, getCodePageDecoder, encodeAnsiString } from "../emulator-config-manager";
import { asBufferSource } from "../../../dom-buffer";

export interface StructField {
    name: string;
    type: 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'f32' | 'f64' | 'ptr' | 'wstr' | 'str';
    offset: number;
}

export interface StructDef {
    name: string;
    size: number;
    fields: StructField[];
}

export class Marshaler {
    private structs: Map<string, StructDef> = new Map();

    constructor() {
        this.initCommonStructs();
    }

    private initCommonStructs() {
        this.defineStruct('RECT', 16, [
            { name: 'left', type: 'i32', offset: 0 },
            { name: 'top', type: 'i32', offset: 4 },
            { name: 'right', type: 'i32', offset: 8 },
            { name: 'bottom', type: 'i32', offset: 12 },
        ]);
    }

    defineStruct(name: string, size: number, fields: StructField[]): void {
        this.structs.set(name, { name, size, fields });
    }

    read(memory: Uint8Array, address: number, structName: string): Record<string, any> {
        const def = this.structs.get(structName);
        if (!def) throw new Error(`Unknown struct: ${structName}`);

        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const result: Record<string, any> = {};

        for (const field of def.fields) {
            const addr = address + field.offset;

            switch (field.type) {
                case 'u8': result[field.name] = memory[addr]; break;
                case 'i8': result[field.name] = view.getInt8(addr); break;
                case 'u16': result[field.name] = view.getUint16(addr, true); break;
                case 'i16': result[field.name] = view.getInt16(addr, true); break;
                case 'u32':
                case 'ptr': result[field.name] = view.getUint32(addr, true); break;
                case 'i32': result[field.name] = view.getInt32(addr, true); break;
                case 'f32': result[field.name] = view.getFloat32(addr, true); break;
                case 'f64': result[field.name] = view.getFloat64(addr, true); break;
                case 'wstr': result[field.name] = Marshaler.readWideString(memory, view.getUint32(addr, true)); break;
                case 'str': result[field.name] = Marshaler.readString(memory, view.getUint32(addr, true)); break;
            }
        }
        return result;
    }

    write(memory: Uint8Array, address: number, structName: string, data: Record<string, any>): void {
        const def = this.structs.get(structName);
        if (!def) throw new Error(`Unknown struct: ${structName}`);

        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);

        for (const field of def.fields) {
            if (!(field.name in data)) continue;
            const addr = address + field.offset;
            const value = data[field.name];

            switch (field.type) {
                case 'u8':
                case 'i8': memory[addr] = value & 0xFF; break;
                case 'u16': view.setUint16(addr, value, true); break;
                case 'i16': view.setInt16(addr, value, true); break;
                case 'u32':
                case 'ptr': view.setUint32(addr, value >>> 0, true); break;
                case 'i32': view.setInt32(addr, value, true); break;
                case 'f32': view.setFloat32(addr, value, true); break;
                case 'f64': view.setFloat64(addr, value, true); break;
            }
        }
    }

    static readWideString(memory: Uint8Array, address: number): string {
        if (address <= 0 || address >= memory.length) return '';
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        let str = '';
        let offset = 0;
        while (address + offset + 1 < memory.length) {
            const code = view.getUint16(address + offset, true);
            if (code === 0) break;
            str += String.fromCharCode(code);
            offset += 2;
        }
        return str;
    }

    static readString(memory: Uint8Array, address: number): string {
        if (address <= 0 || address >= memory.length) return '';
        // Find null terminator
        let end = address;
        while (end < memory.length && memory[end] !== 0) end++;
        if (end === address) return '';
        return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage)
            .decode(asBufferSource(memory.subarray(address, end)));
    }

    /** At most `count` ANSI bytes, stopping at a NUL inside them: a counted string such as
     *  GDI's text calls take, read without scanning the rest of the buffer for its terminator. */
    static readStringN(memory: Uint8Array, address: number, count: number): string {
        if (address <= 0 || address >= memory.length) return '';
        const limit = Math.min(memory.length, address + Math.max(0, count | 0));
        let end = address;
        while (end < limit && memory[end] !== 0) end++;
        if (end === address) return '';
        return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage)
            .decode(asBufferSource(memory.subarray(address, end)));
    }

    static readStringW(memory: Uint8Array, address: number): string {
        if (address <= 0 || address >= memory.length - 1) return '';
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        let str = '';
        let offset = address;
        while (offset < memory.length - 1) {
            const char = view.getUint16(offset, true); // little-endian
            if (char === 0) break;
            str += String.fromCharCode(char);
            offset += 2;
        }
        return str;
    }

    static writeString(memory: Uint8Array, address: number, value: string, maxSize?: number): number {
        if (address <= 0 || address >= memory.length) return 0;
        const encoded = encodeAnsiString(value, EmulatorConfig.getInstance().ansiCodePage);
        // +1 for null terminator
        const total = encoded.length + 1;
        const toWrite = maxSize !== undefined ? Math.min(total, maxSize) : total;
        const data = new Uint8Array(toWrite);
        data.set(encoded.subarray(0, Math.min(encoded.length, toWrite)));
        // Null terminator (last byte or at end of encoded data)
        if (toWrite > encoded.length) data[encoded.length] = 0;
        return MemoryGuard.writeBytes(memory, address, data, "Marshaler.writeString");
    }

    static writeWideString(memory: Uint8Array, address: number, value: string, maxChars?: number): number {
        if (address <= 0 || address >= memory.length) return 0;
        const toWrite = maxChars !== undefined ? Math.min(value.length, maxChars - 1) : value.length;
        const totalBytes = (toWrite + 1) * 2;
        const data = new Uint8Array(totalBytes);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < toWrite; i++) {
            view.setUint16(i * 2, value.charCodeAt(i), true);
        }
        view.setUint16(toWrite * 2, 0, true);
        return MemoryGuard.writeBytes(memory, address, data, "Marshaler.writeWideString");
    }
}
