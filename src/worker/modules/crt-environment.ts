import { Mem } from "../core/memory/mem-accessor";
import { encodeAnsi } from "./crt-format";

export interface CrtEnvironmentHost {
    alloc(size: number): number;
    free(ptr: number): void;
    setErrno(value: number): unknown;
    publish(vector: number): void;
}

type EnvironmentBlock = { ptr: number; values: Map<string, number> };

/** CRT environment is a snapshot: Win32 setters do not refresh it, while CRT
 * setters update both the snapshot and the process environment. */
export class CrtEnvironment {
    private entries: Map<string, string>;
    private narrow: EnvironmentBlock | null = null;
    private wide: EnvironmentBlock | null = null;

    constructor(private readonly processEnvironment: Map<string, string>, private readonly host: CrtEnvironmentHost) {
        this.entries = new Map(Array.from(processEnvironment, ([name, value]) => [name.toUpperCase(), value]));
    }

    vector(): number {
        if (!this.narrow) {
            this.narrow = this.build(this.entries, false);
            if (this.narrow) this.host.publish(this.narrow.ptr);
        }
        return this.narrow?.ptr ?? 0;
    }

    get(name: string, wide = false): number {
        if (!name || name.includes('=')) return 0;
        if (wide && !this.wide) this.wide = this.build(this.entries, true);
        if (!wide) this.vector();
        return (wide ? this.wide : this.narrow)?.values.get(name.toUpperCase()) ?? 0;
    }

    put(definition: string, wide = false): number {
        const equals = definition.indexOf('=');
        if (equals <= 0) { this.host.setErrno(22); return -1; }
        const name = definition.slice(0, equals).toUpperCase();
        const value = definition.slice(equals + 1);
        const entries = new Map(this.entries);
        if (value) entries.set(name, value);
        else entries.delete(name);
        const narrow = this.build(entries, false);
        if (!narrow) return -1;
        const wideBlock = wide || this.wide ? this.build(entries, true) : null;
        if ((wide || this.wide) && !wideBlock) {
            this.host.free(narrow.ptr);
            return -1;
        }
        const previousNarrow = this.narrow;
        const previousWide = this.wide;
        this.entries = entries;
        this.narrow = narrow;
        this.wide = wideBlock;
        this.host.publish(narrow.ptr);
        if (value) this.processEnvironment.set(name, value);
        else this.processEnvironment.delete(name);
        if (previousNarrow) this.host.free(previousNarrow.ptr);
        if (previousWide) this.host.free(previousWide.ptr);
        return 0;
    }

    private build(entries: Map<string, string>, wide: boolean): EnvironmentBlock | null {
        const vectorBytes = (entries.size + 1) * 4;
        const strings: Array<{ name: string; bytes: Uint8Array; valueOffset: number }> = [];
        let size = vectorBytes;
        for (const [name, value] of entries) {
            const text = `${name}=${value}\0`;
            let bytes: Uint8Array;
            if (wide) {
                bytes = new Uint8Array(text.length * 2);
                const view = new DataView(bytes.buffer);
                for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
            } else bytes = encodeAnsi(text);
            strings.push({ name, bytes, valueOffset: wide ? (name.length + 1) * 2 : encodeAnsi(name + '=').length });
            size += bytes.length;
        }
        let ptr = 0;
        try {
            ptr = this.host.alloc(size);
            if (!ptr) throw new Error("environment allocation failed");
            const bytes = new Uint8Array(size);
            const view = new DataView(bytes.buffer);
            const values = new Map<string, number>();
            let offset = vectorBytes;
            for (let i = 0; i < strings.length; i++) {
                const entry = strings[i];
                view.setUint32(i * 4, ptr + offset, true);
                bytes.set(entry.bytes, offset);
                values.set(entry.name, ptr + offset + entry.valueOffset);
                offset += entry.bytes.length;
            }
            if (!Mem.writeBytes(ptr, bytes)) throw new Error("environment publication failed");
            return { ptr, values };
        } catch {
            if (ptr) this.host.free(ptr);
            this.host.setErrno(12);
            return null;
        }
    }
}

export function readWideEnvironmentString(ptr: number): string {
    const units: number[] = [];
    for (let i = 0; i < 32768; i++) {
        const unit = Mem.readUint16(ptr + i * 2);
        if (unit === null || unit === 0) break;
        units.push(unit);
    }
    return String.fromCharCode(...units);
}
