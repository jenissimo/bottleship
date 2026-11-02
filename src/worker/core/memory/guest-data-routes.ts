const PAGE = 0x1000;
const MAX_PAGES = 4096;

export interface GuestDataLease {
    release(): void;
}

interface DataPage {
    bytes: Uint8Array;
    offset: number;
    token: object;
}

/**
 * Opt-in guest-VA data routing. RAM stays a fresh per-turn borrow; external
 * pages retain only their explicit SAB. This does not create Win32 Sections,
 * map CPU PTEs, supply atomics, or represent an executable/global memory view.
 */
export class GuestDataRoutes {
    private readonly pages = new Map<number, DataPage>();
    private readonly scratch = new Uint8Array(8);
    private readonly floats = new DataView(this.scratch.buffer);

    constructor(
        private readonly getMemory: () => Uint8Array,
        private readonly accessible: (address: number, size: number, write: boolean) => boolean,
    ) {}

    get hasMappings(): boolean { return this.pages.size !== 0; }

    map(address: number, backing: SharedArrayBuffer, offset: number, size: number): GuestDataLease {
        const mem = this.getMemory();
        if (!(backing instanceof SharedArrayBuffer) ||
            !this.extent(address, size, mem.length) || size === 0 ||
            !this.extent(offset, size, backing.byteLength) ||
            address % PAGE !== 0 || offset % PAGE !== 0 || size % PAGE !== 0 ||
            this.pages.size + size / PAGE > MAX_PAGES) {
            throw new RangeError("Invalid external data route");
        }
        const first = address / PAGE, count = size / PAGE;
        for (let i = 0; i < count; i++) {
            if (this.pages.has(first + i)) throw new Error("External data route overlap");
        }
        const token = {}, bytes = new Uint8Array(backing);
        for (let i = 0; i < count; i++) {
            this.pages.set(first + i, { bytes, offset: offset + i * PAGE, token });
        }
        return {
            release: () => {
                for (let i = 0; i < count; i++) {
                    if (this.pages.get(first + i)?.token === token) this.pages.delete(first + i);
                }
            },
        };
    }

    clear(): void { this.pages.clear(); }

    private extent(address: number, size: number, limit: number): boolean {
        return Number.isSafeInteger(address) && Number.isSafeInteger(size) &&
            address >= 0 && size >= 0 && address + size <= Math.min(limit, 0x100000000);
    }

    isAccessible(address: number, size: number, write: boolean): boolean {
        return this.extent(address, size, this.getMemory().length) &&
            this.accessible(address, size, write);
    }

    private check(address: number, size: number, write: boolean): void {
        if (!this.isAccessible(address, size, write)) throw new RangeError("Inaccessible guest data range");
    }

    private hasExternal(address: number, size: number): boolean {
        if (size === 0 || this.pages.size === 0) return false;
        const end = Math.ceil((address + size) / PAGE);
        for (let page = Math.floor(address / PAGE); page < end; page++) {
            if (this.pages.has(page)) return true;
        }
        return false;
    }

    private readByte(mem: Uint8Array, address: number): number {
        const page = this.pages.get(address >>> 12);
        return page ? page.bytes[page.offset + (address & (PAGE - 1))]! : mem[address]!;
    }

    private writeByte(mem: Uint8Array, address: number, value: number): void {
        const page = this.pages.get(address >>> 12);
        if (page) page.bytes[page.offset + (address & (PAGE - 1))] = value;
        else mem[address] = value;
    }

    readUint(address: number, width: 1 | 2 | 4): number {
        this.check(address, width, false);
        const mem = this.getMemory();
        let value = 0;
        for (let i = 0; i < width; i++) value |= this.readByte(mem, address + i) << (i * 8);
        return value >>> 0;
    }

    writeUint(address: number, value: number, width: 1 | 2 | 4): void {
        this.check(address, width, true);
        const mem = this.getMemory();
        for (let i = 0; i < width; i++) this.writeByte(mem, address + i, value >>> (i * 8));
    }

    readFloat(address: number, width: 4 | 8): number {
        this.check(address, width, false);
        const mem = this.getMemory();
        for (let i = 0; i < width; i++) this.scratch[i] = this.readByte(mem, address + i);
        return width === 4 ? this.floats.getFloat32(0, true) : this.floats.getFloat64(0, true);
    }

    writeFloat(address: number, value: number, width: 4 | 8): void {
        this.check(address, width, true);
        if (width === 4) this.floats.setFloat32(0, value, true);
        else this.floats.setFloat64(0, value, true);
        const mem = this.getMemory();
        for (let i = 0; i < width; i++) this.writeByte(mem, address + i, this.scratch[i]!);
    }

    /** External/mixed reads are snapshots; only plain RAM retains the historical borrow. */
    readBytes(address: number, size: number): Uint8Array {
        this.check(address, size, false);
        const mem = this.getMemory();
        if (!this.hasExternal(address, size)) return mem.subarray(address, address + size);
        const bytes = new Uint8Array(size);
        this.readIntoUnchecked(mem, address, bytes);
        return bytes;
    }

    private readIntoUnchecked(mem: Uint8Array, address: number, out: Uint8Array): void {
        let copied = 0;
        while (copied < out.length) {
            const at = address + copied, page = this.pages.get(at >>> 12);
            const count = Math.min(PAGE - (at & (PAGE - 1)), out.length - copied);
            const bytes = page?.bytes ?? mem, offset = page ? page.offset + (at & (PAGE - 1)) : at;
            out.set(bytes.subarray(offset, offset + count), copied);
            copied += count;
        }
    }

    private writeFromUnchecked(mem: Uint8Array, address: number, input: Uint8Array): void {
        let copied = 0;
        while (copied < input.length) {
            const at = address + copied, page = this.pages.get(at >>> 12);
            const count = Math.min(PAGE - (at & (PAGE - 1)), input.length - copied);
            const bytes = page?.bytes ?? mem, offset = page ? page.offset + (at & (PAGE - 1)) : at;
            bytes.set(input.subarray(copied, copied + count), offset);
            copied += count;
        }
    }

    writeBytes(address: number, input: Uint8Array): void {
        this.check(address, input.length, true);
        const mem = this.getMemory();
        if (!this.hasExternal(address, input.length)) { mem.set(input, address); return; }
        // A source may alias another VA's SAB or span several segments. Snapshot
        // before the first write so physical overlap cannot corrupt later input.
        this.writeFromUnchecked(mem, address, input.slice());
    }

    copy(destination: number, source: number, size: number): void {
        this.check(source, size, false);
        this.check(destination, size, true);
        const mem = this.getMemory();
        if (!this.hasExternal(source, size) && !this.hasExternal(destination, size)) {
            mem.copyWithin(destination, source, source + size);
            return;
        }
        const bytes = new Uint8Array(size);
        this.readIntoUnchecked(mem, source, bytes);
        this.writeFromUnchecked(mem, destination, bytes);
    }
}
