import { isValidAddress } from '../../core/memory/address-guard';
import type { DirectDrawSurfaceState } from './com-objects';

/** CPU-mapped video memory remains visible to scanout between DirectDraw calls. */
export class PrimaryScanoutTracker {
    private surface: DirectDrawSurfaceState | null = null;
    private address = 0;
    private pixels: Uint8Array | null = null;

    reset(): void { this.surface = null; this.pixels = null; }

    changed(mem: Uint8Array, state: DirectDrawSurfaceState): boolean {
        const size = state.pitch * state.height, address = state.surfacePtr;
        if (size <= 0 || !address || !isValidAddress(mem, address, size, 'r') || address + size > mem.length) return false;
        const bytes = mem.subarray(address, address + size);
        if (this.surface !== state || this.address !== address || this.pixels?.length !== size) {
            this.surface = state; this.address = address; this.pixels = bytes.slice();
            return true;
        }
        const snapshot = this.pixels;
        const words = size >>> 2;
        let same = true;
        if (((mem.byteOffset + address) & 3) === 0) {
            const current = new Uint32Array(mem.buffer, mem.byteOffset + address, words);
            const previous = new Uint32Array(snapshot.buffer, snapshot.byteOffset, words);
            for (let i = 0; i < words; i++) if (current[i] !== previous[i]) { same = false; break; }
            if (same) for (let i = words * 4; i < size; i++) if (bytes[i] !== snapshot[i]) { same = false; break; }
        } else {
            for (let i = 0; i < size; i++) if (bytes[i] !== snapshot[i]) { same = false; break; }
        }
        if (same) return false;
        snapshot.set(bytes);
        return true;
    }
}
