/**
 * Video for Windows (msvfw32.dll)
 *
 * Provides DrawDib functions used by games to render AVI frames to a DC.
 * DrawDibDraw is essentially StretchDIBits with optional dithering/stretching.
 * We delegate to gdi32's StretchDIBits implementation.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";

/** Fake HDRAWDIB handle — just a non-zero sentinel */
let nextDrawDibHandle = 0xDD000001;

export class Msvfw32 implements IModule {
    name = "msvfw32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    initialize(process: Process): void {
        this.process = process;

        // No VCM codec is installed, which is a state real Windows can be in: ICLocate
        // and ICOpen answer NULL and ICInfo FALSE, so a caller sees "this format has no
        // decompressor" and takes its own fallback. Handing back a non-NULL HIC we
        // cannot drive would instead make it commit to the compressed path.
        this.exports["ICLocate"] = () => 0;
        this.exports["ICOpen"] = () => 0;
        this.exports["ICInfo"] = () => 0;

        // With no handle ever issued, every call carrying one is ICERR_BADHANDLE.
        // These return LRESULT, where 0 is ICERR_OK — the failure has to be explicit.
        const ICERR_BADHANDLE = -8;
        this.exports["ICClose"] = () => ICERR_BADHANDLE;
        this.exports["ICSendMessage"] = () => ICERR_BADHANDLE;
        this.exports["ICDecompress"] = () => ICERR_BADHANDLE;

        // VideoForWindowsVersion() — VFW 1.1, the version every 32-bit Windows reports.
        const videoForWindowsVersion = () => 0x040003B6;
        this.exports["VideoForWindowsVersion"] = videoForWindowsVersion;
        this.exports["ord_2"] = videoForWindowsVersion;

        // DrawDibOpen() → HDRAWDIB
        this.exports["DrawDibOpen"] = (_ctx, _mem, _args) => {
            const handle = nextDrawDibHandle++;
            Logger.log(LogCategory.SYSTEM, `[MSVFW32] DrawDibOpen() → 0x${handle.toString(16)}`);
            return handle;
        };

        // DrawDibClose(hdd) → BOOL
        this.exports["DrawDibClose"] = (_ctx, _mem, args) => {
            Logger.log(LogCategory.SYSTEM, `[MSVFW32] DrawDibClose(0x${args[0].toString(16)})`);
            return 1; // TRUE
        };

        // DrawDibDraw(hdd, hdc, xDst, yDst, dxDst, dyDst, lpbi, lpBits, xSrc, ySrc, dxSrc, dySrc, wFlags)
        // Delegate to gdi32 StretchDIBits for actual rendering.
        this.exports["DrawDibDraw"] = (_ctx, mem, args) => {
            const hdd    = args[0];
            const hdc    = args[1];
            const xDst   = args[2] | 0;
            const yDst   = args[3] | 0;
            const dxDst  = args[4] | 0;
            const dyDst  = args[5] | 0;
            const lpbi   = args[6];   // BITMAPINFOHEADER*
            const lpBits = args[7];   // pixel data
            const xSrc   = args[8] | 0;
            const ySrc   = args[9] | 0;
            const dxSrc  = args[10] | 0;
            const dySrc  = args[11] | 0;
            const wFlags = args[12];

            Logger.log(LogCategory.SYSTEM,
                `[MSVFW32] DrawDibDraw(hdd=0x${hdd.toString(16)}, hdc=0x${hdc.toString(16)}, ` +
                `dst=(${xDst},${yDst},${dxDst}x${dyDst}), lpbi=0x${lpbi.toString(16)}, ` +
                `lpBits=0x${lpBits.toString(16)}, src=(${xSrc},${ySrc},${dxSrc}x${dySrc}), flags=0x${wFlags.toString(16)})`);

            if (!lpbi || !lpBits || !hdc) return 1; // nothing to draw, return success

            // Call gdi32's StretchDIBits: (hdc, xDest, yDest, wDest, hDest, xSrc, ySrc, wSrc, hSrc, lpBits, lpBmi, iUsage, rop)
            const gdi32 = this.process.getModule("gdi32");
            if (gdi32 && gdi32.exports["StretchDIBits"]) {
                const SRCCOPY = 0x00CC0020;
                const DIB_RGB_COLORS = 0;
                gdi32.exports["StretchDIBits"](
                    _ctx, mem,
                    [hdc, xDst, yDst, dxDst, dyDst, xSrc, ySrc, dxSrc, dySrc, lpBits, lpbi, DIB_RGB_COLORS, SRCCOPY]
                );
            }

            return 1; // TRUE = success
        };
    }

    reset(): void {}
}
