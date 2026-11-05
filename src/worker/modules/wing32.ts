/**
 * WING32.dll — WinG 1.0, the Win32s/Windows 95 fast-DIB library.
 *
 * WinG is a thin layer over GDI DIB sections, and on NT-family Windows (and in Wine's
 * dlls/wing32) every export forwards to the matching GDI call. We do the same through
 * our gdi32 export table, so a WinG DC/bitmap is an ordinary memory DC holding a
 * CreateDIBSection bitmap and the guest's direct writes to its bits are seen by every
 * GDI path that already reads DIB sections.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, X86Context } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";

const SRCCOPY = 0x00CC0020;
const COLORONCOLOR = 3;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const BITMAPINFOHEADER_SIZE = 40;
const DIBSECTION_SIZE = 0x54;
const DIBSECTION_BMBITS = 0x14;
const DIBSECTION_BMIH = 0x18;

export class Wing32 implements IModule {
    name = "wing32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    /** Call a gdi32 handler synchronously; every GDI export WinG forwards to is sync. */
    private gdi(name: string, ctx: X86Context, mem: Uint8Array, args: number[]): number {
        const fn = this.process.getModule("gdi32")?.exports[name];
        if (!fn) {
            Logger.warn(LogCategory.GDI32, `wing32: gdi32!${name} is not available`);
            return 0;
        }
        const result = fn(ctx, mem, args);
        if (typeof result === "number") return result >>> 0;
        if (result && typeof result === "object" && "value" in result && typeof result.value === "number") {
            return result.value >>> 0;
        }
        Logger.warn(LogCategory.GDI32, `wing32: gdi32!${name} answered asynchronously`);
        return 0;
    }

    initialize(process: Process): void {
        this.process = process;

        // HDC WinGCreateDC(void): a memory DC compatible with the screen.
        this.exports["WinGCreateDC"] = (ctx, mem, _args) => this.gdi("CreateCompatibleDC", ctx, mem, [0]);

        // BOOL WinGRecommendDIBFormat(BITMAPINFO*): the fastest format is an 8bpp
        // top-down DIB (negative biHeight). Only the header is filled — no colour table.
        this.exports["WinGRecommendDIBFormat"] = (_ctx, _mem, args) => {
            const bmi = args[0] >>> 0;
            if (!bmi || !isValidAddress(bmi, BITMAPINFOHEADER_SIZE, "rw")) return 0;
            Mem.writeUint32(bmi + 0, BITMAPINFOHEADER_SIZE); // biSize
            Mem.writeUint32(bmi + 4, 320);                   // biWidth
            Mem.writeUint32(bmi + 8, -1 >>> 0);              // biHeight: top-down
            Mem.writeUint16(bmi + 12, 1);                    // biPlanes
            Mem.writeUint16(bmi + 14, 8);                    // biBitCount
            Mem.writeUint32(bmi + 16, BI_RGB);               // biCompression
            for (let off = 20; off < BITMAPINFOHEADER_SIZE; off += 4) Mem.writeUint32(bmi + off, 0);
            return 1;
        };

        // HBITMAP WinGCreateBitmap(HDC, const BITMAPINFO*, void** ppvBits)
        this.exports["WinGCreateBitmap"] = (ctx, mem, args) =>
            this.gdi("CreateDIBSection", ctx, mem, [args[0] >>> 0, args[1] >>> 0, DIB_RGB_COLORS, args[2] >>> 0, 0, 0]);

        // void* WinGGetDIBPointer(HBITMAP, BITMAPINFO* pbmi): the bits, and optionally the
        // section's BITMAPINFOHEADER. NULL for anything that is not a DIB section.
        this.exports["WinGGetDIBPointer"] = (_ctx, _mem, args) => {
            const hbm = args[0] >>> 0;
            const bmi = args[1] >>> 0;
            const scratch = new Uint8Array(4 + DIBSECTION_SIZE);
            const got = System.getInstance().gdiContext.getObject(hbm, DIBSECTION_SIZE, 4, scratch, true);
            if (got !== DIBSECTION_SIZE) return 0;
            if (bmi) {
                if (!isValidAddress(bmi, BITMAPINFOHEADER_SIZE, "rw")) return 0;
                Mem.writeBytes(bmi, scratch.subarray(4 + DIBSECTION_BMIH, 4 + DIBSECTION_BMIH + BITMAPINFOHEADER_SIZE));
            }
            return new DataView(scratch.buffer).getUint32(4 + DIBSECTION_BMBITS, true);
        };

        // UINT WinG{Set,Get}DIBColorTable(HDC, UINT start, UINT count, RGBQUAD*)
        this.exports["WinGSetDIBColorTable"] = (ctx, mem, args) => this.gdi("SetDIBColorTable", ctx, mem, args.slice(0, 4));
        this.exports["WinGGetDIBColorTable"] = (ctx, mem, args) => this.gdi("GetDIBColorTable", ctx, mem, args.slice(0, 4));

        // HPALETTE WinGCreateHalftonePalette(void)
        this.exports["WinGCreateHalftonePalette"] = (ctx, mem, _args) => this.gdi("CreateHalftonePalette", ctx, mem, [0]);

        // HBRUSH WinGCreateHalftoneBrush(HDC, COLORREF, WING_DITHER_TYPE): Wine answers a
        // solid brush of the colour — no dither pattern is reproduced.
        this.exports["WinGCreateHalftoneBrush"] = (ctx, mem, args) => this.gdi("CreateSolidBrush", ctx, mem, [args[1] >>> 0]);

        // BOOL WinGBitBlt(hdcDst, xDst, yDst, width, height, hdcSrc, xSrc, ySrc): SRCCOPY.
        this.exports["WinGBitBlt"] = (ctx, mem, args) =>
            this.gdi("BitBlt", ctx, mem, [...args.slice(0, 8), SRCCOPY]);

        // BOOL WinGStretchBlt(hdcDst, x, y, w, h, hdcSrc, x, y, w, h): SRCCOPY in COLORONCOLOR
        // mode, restoring the destination's own stretch mode afterwards.
        this.exports["WinGStretchBlt"] = (ctx, mem, args) => {
            const hdcDst = args[0] >>> 0;
            const oldMode = this.gdi("SetStretchBltMode", ctx, mem, [hdcDst, COLORONCOLOR]);
            const ok = this.gdi("StretchBlt", ctx, mem, [...args.slice(0, 10), SRCCOPY]);
            if (oldMode) this.gdi("SetStretchBltMode", ctx, mem, [hdcDst, oldMode]);
            return ok;
        };
    }

    reset(): void {}
}
