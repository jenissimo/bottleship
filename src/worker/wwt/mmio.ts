interface MmioAperture {
    end: number;
    read8(address: number): number;
    write8(address: number, value: number): void;
    read32?: (address: number) => number;
    write32?: (address: number, value: number) => void;
}

const PAGE_SIZE = 0x1000;
const MAX_PHYSICAL_ADDRESS = 0x100000000;

export class WwtMmio {
    private readonly pages = new Map<number, MmioAperture>();

    get hasApertures(): boolean { return this.pages.size !== 0; }

    register(base: number, size: number, read8: MmioAperture["read8"], write8: MmioAperture["write8"],
        read32?: MmioAperture["read32"], write32?: MmioAperture["write32"]): () => void {
        const end = base + size;
        if (!Number.isSafeInteger(base) || !Number.isSafeInteger(size) || base < 0 ||
            size <= 0 || base % PAGE_SIZE !== 0 || size % PAGE_SIZE !== 0 || end > MAX_PHYSICAL_ADDRESS) {
            throw new RangeError("Invalid WWT MMIO aperture");
        }
        for (let address = base; address < end; address += PAGE_SIZE) {
            if (this.pages.has(address >>> 12)) throw new Error("Overlapping WWT MMIO aperture");
        }
        const aperture: MmioAperture = { end, read8, write8, read32, write32 };
        for (let address = base; address < end; address += PAGE_SIZE) {
            this.pages.set(address >>> 12, aperture);
        }
        return () => {
            for (let address = base; address < end; address += PAGE_SIZE) {
                if (this.pages.get(address >>> 12) === aperture) this.pages.delete(address >>> 12);
            }
        };
    }

    /**
     * Preflight every page before invoking any callbacks. Native CPU scratch
     * contains the operand's raw little-endian bytes (including SSE operands).
     */
    transfer(address: number, width: number, write: boolean, data: DataView, scratch: number,
        ramSize: number, translate: (address: number, write: boolean) => number | undefined,
        invalidate: (start: number, end: number) => void): number {
        if (![1, 2, 4, 8, 16].includes(width)) return address;
        const end = address + width;
        const chunks: Array<{ physical: number; count: number; aperture?: MmioAperture }> = [];
        for (let linear = address; linear < end;) {
            const physical = translate(linear, write);
            if (physical === undefined) return linear;
            const count = Math.min(end - linear, PAGE_SIZE - (linear & (PAGE_SIZE - 1)));
            const aperture = physical >= ramSize ? this.pages.get(physical >>> 12) : undefined;
            if (physical >= ramSize ? !aperture || physical + count > aperture.end : physical !== linear) {
                return linear;
            }
            chunks.push({ physical, count, aperture });
            linear += count;
        }
        for (const { physical, count, aperture } of chunks) {
            if (write && !aperture) invalidate(physical, physical + count);
            for (let i = 0; i < count;) {
                const at = physical + i;
                const word = count - i >= 4 && (at & 3) === 0 && (write ? aperture?.write32 : aperture?.read32);
                if (word) {
                    if (write) aperture!.write32!(at, data.getUint32(scratch + i, true));
                    else data.setUint32(scratch + i, aperture!.read32!(at), true);
                    i += 4;
                } else {
                    if (write) {
                        const value = data.getUint8(scratch + i);
                        if (aperture) aperture.write8(at, value);
                        else data.setUint8(at, value);
                    } else {
                        const value = aperture ? aperture.read8(at) : data.getUint8(at);
                        data.setUint8(scratch + i, value);
                    }
                    i++;
                }
            }
            scratch += count;
        }
        return -1;
    }
}
