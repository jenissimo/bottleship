/**
 * DirectDraw COM objects: DirectDraw, Clipper, Palette.
 */
import { Logger, LogCategory } from "../../core/logger";
import { BaseComObject } from "../../core/com/base-com-object";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { System } from "../../core/system";
import { Mem } from "../../core/memory/mem-accessor";
import {
    IID_IDirectDraw,
    IID_IDirectDrawAlias,
    IID_IDirectDraw2,
    IID_IDirectDraw4,
    IID_IDirectDraw7,
    IID_IDirectDrawClipper,
    IID_IDirectDrawPalette,
} from "./constants";
import { guestPtrToMemOffset } from "./helpers";

export class DirectDrawObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDirectDraw7, vtableAddress);
    }

    // IDirectDraw/2/4/7 and IDirect3D/2/3/7 are tear-offs of this one driver object, and
    // DirectDraw gives each its own refcount (see BaseComObject.perInterfaceRefs).
    protected override get perInterfaceRefs(): boolean {
        return true;
    }

    protected destroy(): void {
        const resourceProvider = SystemResourceProvider.getInstance();
        const allCom = resourceProvider.getAllComObjects();
        let releasedDevices = 0;
        let releasedSurfaces = 0;
        let releasedAux = 0;

        // A DirectDraw object owns only what was created THROUGH it. Games routinely keep several
        // alive at once (driver/mode enumeration builds and drops throwaway instances while the
        // real one already serves the renderer), so releasing one must not reach into another's
        // surfaces, devices or context state — that silently wipes a live scene's textures.
        // Surfaces carry their creator; the rest cannot be attributed, so they are only swept
        // when this is the last DirectDraw standing.
        const siblings = allCom.filter((o) =>
            o !== this && o.constructor.name === "DirectDrawObject" && o.refCount > 0);
        const isLast = siblings.length === 0;
        const siblingHandles = new Set(siblings.map((o) => o.handle));
        const ownedByASibling = (obj: BaseComObject): boolean => {
            const ownerAddr = (obj as { getDDrawOwnerAddr?: () => number }).getDDrawOwnerAddr?.() ?? 0;
            if (!ownerAddr) return false;
            const ownerHandle = resourceProvider.getComObjectByAddress(ownerAddr)?.handle;
            return ownerHandle !== undefined && siblingHandles.has(ownerHandle);
        };

        // Phase 1: Destroy D3D devices first (they hold texture/RT refs)
        for (const obj of isLast ? allCom : []) {
            if (obj.constructor.name.includes("Direct3DDevice")) {
                try {
                    obj.forceRelease();
                    releasedDevices++;
                } catch (e) {
                    Logger.warn(LogCategory.COM, `DirectDraw cascade: error releasing device: ${e}`);
                }
            }
        }

        // Phase 2: Destroy surfaces (re-scan since getAllComObjects returns snapshot)
        const afterDevices = resourceProvider.getAllComObjects();
        for (const obj of afterDevices) {
            if (obj.constructor.name === "DirectDrawSurfaceObject" && !ownedByASibling(obj)) {
                try {
                    obj.forceRelease();
                    releasedSurfaces++;
                } catch (e) {
                    Logger.warn(LogCategory.COM, `DirectDraw cascade: error releasing surface: ${e}`);
                }
            }
        }

        if (!isLast) {
            Logger.log(LogCategory.COM,
                `DirectDrawObject destroy (handle=0x${this.handle.toString(16)}): ${siblings.length} sibling(s) live — ` +
                `released ${releasedSurfaces} own surfaces, left their objects and the shared context alone`);
            return;
        }

        // Phase 3: Destroy auxiliaries (clippers, palettes, viewports, materials, lights, textures)
        const afterSurfaces = resourceProvider.getAllComObjects();
        for (const obj of afterSurfaces) {
            const name = obj.constructor.name;
            if (name === "DirectDrawClipperObject" ||
                name === "DirectDrawPaletteObject" ||
                name === "Direct3DViewport3Object" ||
                name === "Direct3DViewport2Object" ||
                name === "Direct3DMaterial3Object" ||
                name === "Direct3DLight3Object" ||
                name === "Direct3DTextureObject" ||
                name === "Direct3DTexture2Object") {
                try {
                    obj.forceRelease();
                    releasedAux++;
                } catch (e) {
                    Logger.warn(LogCategory.COM, `DirectDraw cascade: error releasing auxiliary: ${e}`);
                }
            }
        }

        // Clear DDraw context state
        try {
            const ddrawModule = System.getInstance().process?.getModule("ddraw") as any;
            const context = ddrawModule?.context;
            if (context) {
                context.surfaces.primary = 0;
                context.surfaces.backBuffer = 0;
                context.textureHandles.clear();
                context.nextTextureHandle = context.defaults?.nextTextureHandleStart ?? 1;
            }
        } catch (e) {
            Logger.warn(LogCategory.COM, `DirectDraw cascade: error clearing context: ${e}`);
        }

        Logger.log(LogCategory.COM,
            `DirectDrawObject cascade destroy: ${releasedDevices} devices, ${releasedSurfaces} surfaces, ${releasedAux} auxiliaries`);
    }

    protected queryAdditionalInterfaces(riid: string): string | null {
        const normalized = riid.replace(/[{}]/g, "").toLowerCase();
        const supported = [
            IID_IDirectDraw.toLowerCase(),
            IID_IDirectDrawAlias.toLowerCase(),
            IID_IDirectDraw2.toLowerCase(),
            IID_IDirectDraw4.toLowerCase(),
        ];
        if (supported.includes(normalized)) {
            return riid;
        }
        return null;
    }
}

export class DirectDrawClipperObject extends BaseComObject {
    private hwnd: number = 0;
    private clipListData: Uint8Array | null = null;
    private clipListChanged = false;

    constructor(vtableAddress: number) {
        super(IID_IDirectDrawClipper, vtableAddress);
    }

    setHwnd(hwnd: number): void {
        if (this.hwnd !== hwnd) {
            this.clipListChanged = true;
        }
        this.hwnd = hwnd;
    }

    getHwnd(): number {
        return this.hwnd;
    }

    setClipList(mem: Uint8Array, lpClipList: number): boolean {
        if (!lpClipList) {
            this.clipListData = null;
            this.clipListChanged = true;
            return true;
        }
        const offset = guestPtrToMemOffset(lpClipList, mem);
        if (offset < 0 || offset + 32 > mem.length) return false;
        const headerSize = Mem.readUint32(offset) ?? 0;
        if (headerSize < 32) return false;
        const nRgnSize = Mem.readUint32(offset + 12) ?? 0;
        const totalSize = headerSize + nRgnSize;
        if (totalSize < headerSize || offset + totalSize > mem.length) return false;
        this.clipListData = mem.slice(offset, offset + totalSize);
        this.clipListChanged = true;
        return true;
    }

    getClipList(mem: Uint8Array, lpClipList: number, lpdwSize: number): "ok" | "size" | "invalid" {
        if (!this.clipListData) return "invalid";
        if (!lpClipList) {
            if (!lpdwSize) return "invalid";
            const offset = guestPtrToMemOffset(lpdwSize, mem);
            if (offset < 0) return "invalid";
            Mem.writeUint32(offset, this.clipListData.length);
            return "size";
        }
        const offset = guestPtrToMemOffset(lpClipList, mem);
        if (offset < 0) return "invalid";
        if (lpdwSize) {
            const sizeOffset = guestPtrToMemOffset(lpdwSize, mem);
            if (sizeOffset < 0) return "invalid";
            const bufSize = Mem.readUint32(sizeOffset) ?? 0;
            if (bufSize < this.clipListData.length) {
                Mem.writeUint32(sizeOffset, this.clipListData.length);
                return "size";
            }
        }
        if (offset + this.clipListData.length > mem.length) return "invalid";
        mem.set(this.clipListData, offset);
        this.clipListChanged = false;
        return "ok";
    }

    isClipListChanged(): boolean {
        return this.clipListChanged;
    }

    clearClipListChanged(): void {
        this.clipListChanged = false;
    }

    protected destroy(): void {
        this.clipListData = null;
        Logger.verbose(LogCategory.COM, "DirectDrawClipperObject destroyed");
    }

    protected queryAdditionalInterfaces(_riid: string): string | null {
        return null;
    }
}

export class DirectDrawPaletteObject extends BaseComObject {
    private entriesRaw: Uint8Array = new Uint8Array(256 * 4);
    private paletteRGBA: Uint32Array = new Uint32Array(256);
    private caps: number = 0;
    private version: number = 0;

    constructor(vtableAddress: number) {
        super(IID_IDirectDrawPalette, vtableAddress);
    }

    setEntries(startIndex: number, count: number, entriesPtr: number, mem: Uint8Array): void {
        const srcOffset = guestPtrToMemOffset(entriesPtr, mem);
        if (srcOffset < 0) {
            Logger.warn(LogCategory.DDRAW, `DirectDrawPaletteObject.setEntries: invalid pointer 0x${entriesPtr.toString(16)}`);
            return;
        }

        for (let i = 0; i < count; i++) {
            const idx = startIndex + i;
            if (idx >= 256) break;

            const base = idx * 4;
            const entryOffset = srcOffset + i * 4;

            if (entryOffset < 0 || entryOffset + 3 >= mem.length) {
                Logger.warn(LogCategory.DDRAW, `DirectDrawPaletteObject.setEntries: out of bounds access at offset ${entryOffset}`);
                break;
            }

            this.entriesRaw[base] = mem[entryOffset];
            this.entriesRaw[base + 1] = mem[entryOffset + 1];
            this.entriesRaw[base + 2] = mem[entryOffset + 2];
            this.entriesRaw[base + 3] = mem[entryOffset + 3];

            const r = this.entriesRaw[base];
            const g = this.entriesRaw[base + 1];
            const b = this.entriesRaw[base + 2];
            this.paletteRGBA[idx] = 0xff000000 | (b << 16) | (g << 8) | r;
        }

        this.version++;

        // Diagnostic: log first 8 palette entries for debugging color issues
        if (count >= 8) {
            const samples: string[] = [];
            for (let i = 0; i < 8; i++) {
                const idx = startIndex + i;
                const b = idx * 4;
                samples.push(`[${idx}]=(${this.entriesRaw[b]},${this.entriesRaw[b+1]},${this.entriesRaw[b+2]},${this.entriesRaw[b+3]})→0x${this.paletteRGBA[idx].toString(16).padStart(8,'0')}`);
            }
            Logger.log(LogCategory.DDRAW, `PAL setEntries start=${startIndex} count=${count}: ${samples.join(' ')}`);
        }
    }

    /** Set palette from BGRA Uint8Array (e.g., from video decoder). 4 bytes per entry. */
    setEntriesFromBGRA(bgraPalette: Uint8Array, count: number): void {
        for (let i = 0; i < count && i < 256; i++) {
            const si = i * 4; // BGRA
            const base = i * 4;
            const r = bgraPalette[si + 2];
            const g = bgraPalette[si + 1];
            const b = bgraPalette[si];
            this.entriesRaw[base]     = r;
            this.entriesRaw[base + 1] = g;
            this.entriesRaw[base + 2] = b;
            this.entriesRaw[base + 3] = 0;
            this.paletteRGBA[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
        this.version++;
    }

    getEntries(): Uint32Array {
        return this.paletteRGBA;
    }

    getEntriesRaw(): Uint8Array {
        return this.entriesRaw;
    }

    getCaps(): number {
        return this.caps;
    }

    setCaps(caps: number): void {
        this.caps = caps;
    }

    getVersion(): number {
        return this.version;
    }

    /** Set palette from RGB triplets (e.g. from Smacker HSMACK+24). */
    setEntriesFromRGB(rgbData: Uint8Array, rgbOffset: number, count: number): void {
        for (let i = 0; i < count && i < 256; i++) {
            const si = rgbOffset + i * 3;
            const base = i * 4;
            const r = rgbData[si];
            const g = rgbData[si + 1];
            const b = rgbData[si + 2];
            this.entriesRaw[base]     = r;
            this.entriesRaw[base + 1] = g;
            this.entriesRaw[base + 2] = b;
            this.entriesRaw[base + 3] = 0;
            this.paletteRGBA[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
        this.version++;

        if (count >= 8) {
            const samples: string[] = [];
            for (let i = 0; i < 8; i++) {
                const b = i * 4;
                samples.push(`[${i}]=(${this.entriesRaw[b]},${this.entriesRaw[b+1]},${this.entriesRaw[b+2]})→0x${this.paletteRGBA[i].toString(16).padStart(8,'0')}`);
            }
            Logger.log(LogCategory.DDRAW, `PAL setEntriesFromRGB count=${count}: ${samples.join(' ')}`);
        }
    }

    protected destroy(): void {
        Logger.verbose(LogCategory.COM, "DirectDrawPaletteObject destroyed");
    }

    protected queryAdditionalInterfaces(_riid: string): string | null {
        return null;
    }
}
