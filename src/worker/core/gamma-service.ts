/**
 * Unified gamma-ramp sink.
 *
 * Real Windows/DirectX applies a per-channel 256-entry gamma ramp as a RAMDAC
 * lookup over the final scanned-out framebuffer (an identity ramp = passthrough).
 * Games set it through many different APIs that all carry the *same* Windows
 * GAMMARAMP payload (WORD red[256], green[256], blue[256] = 1536 bytes):
 *   - DDraw   IDirectDrawGammaControl::SetGammaRamp
 *   - D3D8/9  IDirect3DDevice::SetGammaRamp
 *   - GDI     SetDeviceGammaRamp
 *   - wgl     wglSetDeviceGammaRamp
 *
 * This service is the single place that reads that payload from guest memory,
 * normalizes it, and pushes it to the render backend's gamma LUT — so every
 * entry point behaves identically and faithfully, instead of each API stubbing
 * gamma on its own (which is why most games' brightness sliders did nothing).
 */
import { System } from "./system";
import type { RenderBackend } from "../runtime/runtime-services";

/** Windows GAMMARAMP: 3 channels × 256 WORDs. */
const GAMMARAMP_BYTES = 256 * 2 * 3; // 1536

export interface GammaRampData {
    red: Float32Array;
    green: Float32Array;
    blue: Float32Array;
    isIdentity: boolean;
}

class GammaService {
    private last: GammaRampData | null = null;

    /**
     * Read a Windows GAMMARAMP from guest memory at `rampPtr`, normalize to
     * [0,1] floats, and push to the active render backend. Returns false on a
     * bad pointer (caller maps to E_INVALIDARG / FALSE as appropriate).
     */
    applyFromGuest(mem: Uint8Array, rampPtr: number): boolean {
        if (!rampPtr || rampPtr + GAMMARAMP_BYTES > mem.length) return false;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const red = new Float32Array(256);
        const green = new Float32Array(256);
        const blue = new Float32Array(256);
        let isIdentity = true;

        for (let i = 0; i < 256; i++) {
            const r = view.getUint16(rampPtr + i * 2, true);
            const g = view.getUint16(rampPtr + 512 + i * 2, true);
            const b = view.getUint16(rampPtr + 1024 + i * 2, true);
            red[i] = r / 65535;
            green[i] = g / 65535;
            blue[i] = b / 65535;
            // The linear/identity ramp encodes channel value as i*257 = (i<<8)|i.
            if (r !== i * 257 || g !== i * 257 || b !== i * 257) isIdentity = false;
        }

        this.last = { red, green, blue, isIdentity };
        this.push();
        return true;
    }

    /**
     * Write the current ramp (or a linear identity ramp if none was set) back
     * into guest memory for Get*GammaRamp round-trips.
     */
    writeToGuest(mem: Uint8Array, rampPtr: number): boolean {
        if (!rampPtr || rampPtr + GAMMARAMP_BYTES > mem.length) return false;

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const r = this.last && !this.last.isIdentity ? this.last : null;
        for (let i = 0; i < 256; i++) {
            const rv = r ? Math.round(r.red[i] * 65535) : i * 257;
            const gv = r ? Math.round(r.green[i] * 65535) : i * 257;
            const bv = r ? Math.round(r.blue[i] * 65535) : i * 257;
            view.setUint16(rampPtr + i * 2, rv & 0xffff, true);
            view.setUint16(rampPtr + 512 + i * 2, gv & 0xffff, true);
            view.setUint16(rampPtr + 1024 + i * 2, bv & 0xffff, true);
        }
        return true;
    }

    /** Re-push the last ramp (e.g. after the backend is (re)created). */
    reapply(): void {
        this.push();
    }

    captureRamp(): GammaRampData | null {
        const last = this.last;
        return last
            ? { red: last.red.slice(), green: last.green.slice(), blue: last.blue.slice(), isIdentity: last.isIdentity }
            : null;
    }

    restoreRamp(ramp: GammaRampData | null): void {
        this.last = ramp
            ? { red: ramp.red.slice(), green: ramp.green.slice(), blue: ramp.blue.slice(), isIdentity: ramp.isIdentity }
            : null;
        this.push();
    }

    private push(): void {
        if (!this.last) return;
        const backend = System.getInstance().services.render.getBackend() as RenderBackend | null;
        // Non-WebGPU backend (or none created yet): nothing to apply to.
        backend?.updateGammaLUT?.(this.last.red, this.last.green, this.last.blue, this.last.isIdentity);
    }
}

export const gammaService = new GammaService();
