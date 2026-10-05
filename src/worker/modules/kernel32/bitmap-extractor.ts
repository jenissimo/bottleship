/**
 * PE Bitmap Extractor
 *
 * Reads RT_BITMAP resources from a loaded PE module in guest memory,
 * converts DIB → BMP, and registers a SystemResourceProvider handle.
 */

import { findResourceInPE } from './resource';
import { parseBMPHeader, parseBMPPixels } from '../gdi32/gdi-raster';
import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';

const RT_BITMAP = 2;

/**
 * Parse a dialog control title field into a PE resource name/id.
 * Ordinal resources are stored as "#119" by dialog-template.ts.
 */
export function parseResourceNameFromTitle(title: string): number | string | null {
    if (!title) return null;
    if (title.startsWith('#')) {
        const id = parseInt(title.slice(1), 10);
        if (!Number.isNaN(id)) return id;
        return null;
    }
    return title;
}

/**
 * Load an RT_BITMAP resource from a PE module and register it as a user object.
 * Returns 0 on failure.
 */
export function loadBitmapFromPeResource(
    mem: Uint8Array,
    moduleBase: number,
    resourceName: number | string,
): number {
    if (!moduleBase) moduleBase = 0x00400000;

    const entry = findResourceInPE(mem, moduleBase, RT_BITMAP, resourceName);
    if (!entry) {
        Logger.warn(LogCategory.KERNEL32,
            `loadBitmapFromPeResource: RT_BITMAP not found (name=${resourceName}, module=0x${moduleBase.toString(16)})`);
        return 0;
    }

    const dibOffset = moduleBase + entry.dataRVA;
    const dibSize = entry.size;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const biSize = view.getUint32(dibOffset, true);
    const biBitCount = view.getUint16(dibOffset + 14, true);
    const biClrUsed = view.getUint32(dibOffset + 32, true);
    const paletteColors = biClrUsed || (biBitCount <= 8 ? 1 << biBitCount : 0);
    const paletteSize = paletteColors * 4;
    const pixelDataOffset = 14 + biSize + paletteSize;

    const totalSize = 14 + dibSize;
    const bmpData = new Uint8Array(totalSize);
    const bmpView = new DataView(bmpData.buffer);

    bmpData[0] = 0x42;
    bmpData[1] = 0x4D;
    bmpView.setUint32(2, totalSize, true);
    bmpView.setUint32(6, 0, true);
    bmpView.setUint32(10, pixelDataOffset, true);
    bmpData.set(mem.subarray(dibOffset, dibOffset + dibSize), 14);

    const header = parseBMPHeader(bmpData);
    if (!header) {
        Logger.warn(LogCategory.KERNEL32, `loadBitmapFromPeResource: failed to parse BMP header`);
        return 0;
    }

    const pixels = parseBMPPixels(bmpData, header);
    if (!pixels) {
        Logger.warn(LogCategory.KERNEL32, `loadBitmapFromPeResource: failed to parse BMP pixels`);
        return 0;
    }

    const resourceData: {
        type: 'BITMAP';
        name: number | string;
        width: number;
        height: number;
        pixels: Uint8Array;
        isTopDown: boolean;
        loading: boolean;
        palette?: Uint32Array;
        bitCount: number;
        dibStride: number;
        dibTopDown: boolean;
        dibBits: Uint8Array;
    } = {
        type: 'BITMAP',
        name: resourceName,
        width: header.width,
        height: header.height,
        pixels,
        isTopDown: header.isTopDown,
        loading: false,
        // An RT_BITMAP resource IS a DIB: keep its own depth, stride and rows so
        // GetObject can report the real DIBSECTION a LR_CREATEDIBSECTION caller asked
        // for. The 32bpp `pixels` above is the GPU-upload form, not the guest's view.
        bitCount: header.bitsPerPixel,
        dibStride: header.rowSize,
        dibTopDown: header.isTopDown,
        dibBits: bmpData.slice(header.offset, header.offset + header.rowSize * header.height),
    };
    if (header.palette) {
        resourceData.palette = header.palette;
    }

    const handle = System.getInstance().resourceProvider.registerUserObject(resourceData);
    Logger.log(LogCategory.KERNEL32,
        `loadBitmapFromPeResource: loaded ${header.width}x${header.height} ${header.bitsPerPixel}bpp ` +
        `bitmap (name=${resourceName}) -> handle=0x${handle.toString(16)}`);
    return handle;
}
