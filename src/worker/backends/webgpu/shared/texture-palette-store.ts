/**
 * D3D8/D3D9 device texture-palette store (P8/A8P8 decode at draw/upload time).
 * Matches DXVK D3D9DeviceEx::SetPaletteEntries semantics.
 */

export class TexturePaletteStore {
    private readonly palettes = new Map<number, Uint32Array>();
    currentTexturePalette = 0;

    setPaletteEntries(paletteNumber: number, pEntries: number, mem: Uint8Array): void {
        if (!pEntries || pEntries + 256 * 4 > mem.length) return;
        const pal = new Uint32Array(256);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < 256; i++) {
            pal[i] = view.getUint32(pEntries + i * 4, true);
        }
        this.palettes.set(paletteNumber >>> 0, pal);
    }

    setPalette(paletteNumber: number, entries: Uint32Array): void {
        this.palettes.set(paletteNumber >>> 0, entries.slice(0, 256));
    }

    getPaletteEntries(paletteNumber: number, pEntries: number, mem: Uint8Array): boolean {
        if (!pEntries || pEntries + 256 * 4 > mem.length) return false;
        const pal = this.palettes.get(paletteNumber >>> 0);
        if (!pal) return false;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < 256; i++) {
            view.setUint32(pEntries + i * 4, pal[i], true);
        }
        return true;
    }

    setCurrentTexturePalette(paletteNumber: number): void {
        this.currentTexturePalette = paletteNumber >>> 0;
    }

    getCurrentTexturePalette(): number {
        return this.currentTexturePalette >>> 0;
    }

    getPalette(paletteNumber: number): Uint32Array | undefined {
        return this.palettes.get(paletteNumber >>> 0);
    }
}
