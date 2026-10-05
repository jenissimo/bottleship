import { Mem } from "../../core/memory/mem-accessor";
import {
    GR_HWCONFIG_NUM_SST_OFFSET,
    GR_HWCONFIG_SST0_FBIREV_OFFSET,
    GR_HWCONFIG_SST0_FBRAM_OFFSET,
    GR_HWCONFIG_SST0_NTEXELFX_OFFSET,
    GR_HWCONFIG_SST0_SLIDETECT_OFFSET,
    GR_HWCONFIG_SST0_TMUCONFIG_OFFSET,
    GR_HWCONFIG_SST0_TYPE_OFFSET,
    GR_SSTTYPE_VOODOO,
    GR_TMUCONFIG_SIZE,
    GR_TMUCONFIG_TMURAM_OFFSET,
    GR_TMUCONFIG_TMUREV_OFFSET,
    GR_LFBINFO_LFBPTR_OFFSET,
    GR_LFBINFO_ORIGIN_OFFSET,
    GR_LFBINFO_SIZE_OFFSET,
    GR_LFBINFO_STRIDE_OFFSET,
    GR_LFBINFO_WRITE_MODE_OFFSET,
    GR_TEXINFO_ASPECT_OFFSET,
    GR_TEXINFO_DATA_OFFSET,
    GR_TEXINFO_FORMAT_OFFSET,
    GR_TEXINFO_LARGE_LOD_OFFSET,
    GR_TEXINFO_SMALL_LOD_OFFSET,
    GR_VERTEX_A_OFFSET,
    GR_VERTEX_B_OFFSET,
    GR_VERTEX_G_OFFSET,
    GR_VERTEX_OOW_OFFSET,
    GR_VERTEX_OOZ_OFFSET,
    GR_VERTEX_R_OFFSET,
    GR_VERTEX_SOW_OFFSET,
    GR_VERTEX_TOW_OFFSET,
    GR_VERTEX_TMU0_OOW_OFFSET,
    GR_VERTEX_X_OFFSET,
    GR_VERTEX_Y_OFFSET,
} from "./constants";

export class GrVertexView {
    private ptr = 0;

    setPtr(ptr: number): this {
        this.ptr = ptr >>> 0;
        return this;
    }

    get x(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_X_OFFSET) ?? 0;
    }

    get y(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_Y_OFFSET) ?? 0;
    }

    get ooz(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_OOZ_OFFSET) ?? 0;
    }

    get oow(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_OOW_OFFSET) ?? 1;
    }

    get r(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_R_OFFSET) ?? 255;
    }

    get g(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_G_OFFSET) ?? 255;
    }

    get b(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_B_OFFSET) ?? 255;
    }

    get a(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_A_OFFSET) ?? 255;
    }

    get sow(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_SOW_OFFSET) ?? 0;
    }

    get tow(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_TOW_OFFSET) ?? 0;
    }

    get tmu0oow(): number {
        return Mem.readFloat32(this.ptr + GR_VERTEX_TMU0_OOW_OFFSET) ?? 0;
    }
}

export class GrLfbInfoView {
    private ptr = 0;

    setPtr(ptr: number): this {
        this.ptr = ptr >>> 0;
        return this;
    }

    write(size: number, lfbPtr: number, stride: number, writeMode: number, origin: number): boolean {
        if (!this.ptr) return false;
        if (!Mem.writeUint32(this.ptr + GR_LFBINFO_SIZE_OFFSET, size >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_LFBINFO_LFBPTR_OFFSET, lfbPtr >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_LFBINFO_STRIDE_OFFSET, stride >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_LFBINFO_WRITE_MODE_OFFSET, writeMode >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_LFBINFO_ORIGIN_OFFSET, origin >>> 0)) return false;
        return true;
    }
}

export type ParsedGrTexInfo = {
    smallLod: number;
    largeLod: number;
    aspectRatio: number;
    format: number;
    data: number;
};

export class GrTexInfoView {
    private ptr = 0;

    setPtr(ptr: number): this {
        this.ptr = ptr >>> 0;
        return this;
    }

    read(): ParsedGrTexInfo | null {
        if (!this.ptr) return null;
        const smallLod = Mem.readInt32(this.ptr + GR_TEXINFO_SMALL_LOD_OFFSET);
        const largeLod = Mem.readInt32(this.ptr + GR_TEXINFO_LARGE_LOD_OFFSET);
        const aspectRatio = Mem.readInt32(this.ptr + GR_TEXINFO_ASPECT_OFFSET);
        const format = Mem.readInt32(this.ptr + GR_TEXINFO_FORMAT_OFFSET);
        const data = Mem.readUint32(this.ptr + GR_TEXINFO_DATA_OFFSET);
        if (
            smallLod === null ||
            largeLod === null ||
            aspectRatio === null ||
            format === null ||
            data === null
        ) {
            return null;
        }
        return {
            smallLod,
            largeLod,
            aspectRatio,
            format,
            data,
        };
    }
}

export class GrHwConfigurationView {
    private ptr = 0;

    setPtr(ptr: number): this {
        this.ptr = ptr >>> 0;
        return this;
    }

    /**
     * Fill SSTs[0] as a single Voodoo board. Every field of GrVoodooConfig_t is
     * written — a partial fill leaves the guest reading ITS OWN uninitialized memory
     * for nTexelfx and tmuConfig[], and the answer it most often gets (zero) means
     * "no texture units, no texture RAM", which is a board a Glide title will either
     * refuse or drive down an untextured / multi-pass path.
     */
    writeSingleVoodoo(fbRamMb: number, fbiRev: number, numTmu: number, tmuRamMb: number, tmuRev: number): boolean {
        if (!this.ptr) return false;
        if (!Mem.writeUint32(this.ptr + GR_HWCONFIG_NUM_SST_OFFSET, 1)) return false;
        if (!Mem.writeUint32(this.ptr + GR_HWCONFIG_SST0_TYPE_OFFSET, GR_SSTTYPE_VOODOO)) return false;
        if (!Mem.writeUint32(this.ptr + GR_HWCONFIG_SST0_FBRAM_OFFSET, fbRamMb >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_HWCONFIG_SST0_FBIREV_OFFSET, fbiRev >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_HWCONFIG_SST0_NTEXELFX_OFFSET, numTmu >>> 0)) return false;
        if (!Mem.writeUint32(this.ptr + GR_HWCONFIG_SST0_SLIDETECT_OFFSET, 0)) return false;
        for (let i = 0; i < numTmu; i++) {
            const tmu = this.ptr + GR_HWCONFIG_SST0_TMUCONFIG_OFFSET + i * GR_TMUCONFIG_SIZE;
            if (!Mem.writeUint32(tmu + GR_TMUCONFIG_TMUREV_OFFSET, tmuRev >>> 0)) return false;
            if (!Mem.writeUint32(tmu + GR_TMUCONFIG_TMURAM_OFFSET, tmuRamMb >>> 0)) return false;
        }
        return true;
    }
}
