/**
 * GDI32 font enumeration, metafile, pen, and color helpers.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { encodeAnsi } from '../codepage-utils';
import { addFontResource, removeFontResource } from './font-resource';
import { PS_STYLE_MASK } from './gdi-objects';

let nextMetafileHandle = 0x50000;

/** ExtCreatePen pen-type bits: cosmetic (0) vs geometric (PS_GEOMETRIC). */
const PS_TYPE_MASK = 0x000F0000;
const PS_GEOMETRIC = 0x00010000;

export function registerPaintingMiscExports(exports: Record<string, ThunkImplementation>): void {
    // int EnumFontFamiliesA(HDC hdc, LPCSTR lpszFamily, FONTENUMPROCA lpFontFamProc, LPARAM lParam)
    exports['EnumFontFamiliesA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpszFamily = args[1];
        const lpFontFamProc = args[2];
        const family = lpszFamily ? Marshaler.readString(mem, lpszFamily) : '';
        Logger.verbose(
            LogCategory.GDI32,
            `EnumFontFamiliesA(hdc=0x${hdc.toString(16)}, family='${family}', proc=0x${lpFontFamProc.toString(16)})`,
        );
        if (!lpFontFamProc) return 0;
        // Vacuous enumeration — report success without re-entering the guest callback.
        return 1;
    };

    // int EnumFontFamiliesExA(HDC hdc, LPLOGFONTA lpLogfont, FONTENUMPROCA lpCallback, LPARAM lParam, DWORD dwFlags)
    exports['EnumFontFamiliesExA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpCallback = args[2];
        const dwFlags = args[4] >>> 0;
        Logger.verbose(
            LogCategory.GDI32,
            `EnumFontFamiliesExA(hdc=0x${hdc.toString(16)}, proc=0x${lpCallback.toString(16)}, flags=0x${dwFlags.toString(16)})`,
        );
        if (!lpCallback) return 0;
        return 1;
    };

    // int GetTextFaceA(HDC hdc, int c, LPSTR lpName)
    exports['GetTextFaceA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const c = args[1] | 0;
        const lpName = args[2];
        const face = System.getInstance().gdiContext.getSelectedFontFace(hdc);
        Logger.verbose(LogCategory.GDI32, `GetTextFaceA(hdc=0x${hdc.toString(16)}, c=${c}) -> '${face}'`);

        const required = face.length + 1;
        if (!lpName || c === 0) return required;
        if (c < required) return 0;

        const bytes = encodeAnsi(face + '\0');
        mem.set(bytes.subarray(0, Math.min(bytes.length, c)), lpName);
        return face.length;
    };

    // COLORREF GetNearestColor(HDC hdc, COLORREF crColor)
    exports['GetNearestColor'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const color = args[1] >>> 0;
        Logger.verbose(
            LogCategory.GDI32,
            `GetNearestColor(hdc=0x${hdc.toString(16)}, color=0x${color.toString(16)})`,
        );
        return color;
    };

    // HPEN ExtCreatePen(DWORD iPenStyle, DWORD cWidth, const LOGBRUSH *plbrush, DWORD cStyle, const DWORD *pstyle)
    exports['ExtCreatePen'] = (ctx, mem, args): number => {
        const iPenStyle = args[0] >>> 0;
        const cWidth = args[1] >>> 0;
        const plbrush = args[2] >>> 0;
        Logger.verbose(
            LogCategory.GDI32,
            `ExtCreatePen(style=0x${iPenStyle.toString(16)}, width=${cWidth}, brush=0x${plbrush.toString(16)})`,
        );

        let color = 0;
        if (plbrush && plbrush + 8 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            color = view.getUint32(plbrush + 4, true);
        }

        // A cosmetic ext pen is always one device pixel wide regardless of cWidth
        // (dibdrv_SelectPen); only PS_GEOMETRIC honours the width.
        const geometric = (iPenStyle & PS_TYPE_MASK) === PS_GEOMETRIC;
        return System.getInstance().gdiContext.createPen(
            iPenStyle & PS_STYLE_MASK,
            geometric ? (cWidth || 1) : 1,
            color,
        );
    };

    // HMETAFILE CloseMetaFile(HDC hdc)
    exports['CloseMetaFile'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hmf = nextMetafileHandle++;
        Logger.verbose(
            LogCategory.GDI32,
            `CloseMetaFile(hdc=0x${hdc.toString(16)}) -> 0x${hmf.toString(16)}`,
        );
        return hmf;
    };

    // HMETAFILE CopyMetaFileA(HMETAFILE hmfSrc, LPCSTR pszFile)
    exports['CopyMetaFileA'] = (ctx, mem, args): number => {
        const hmfSrc = args[0];
        const pszFile = args[1];
        const path = pszFile ? Marshaler.readString(mem, pszFile) : '';
        const hmf = nextMetafileHandle++;
        Logger.verbose(
            LogCategory.GDI32,
            `CopyMetaFileA(hmf=0x${hmfSrc.toString(16)}, path='${path}') -> 0x${hmf.toString(16)}`,
        );
        return hmfSrc || hmf;
    };

    // BOOL PlayMetaFile(HDC hdc, HMETAFILE hmf)
    exports['PlayMetaFile'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hmf = args[1];
        Logger.verbose(
            LogCategory.GDI32,
            `PlayMetaFile(hdc=0x${hdc.toString(16)}, hmf=0x${hmf.toString(16)}) — stub`,
        );
        return 1;
    };

    // BOOL EnumMetaFile(HDC hdc, HMETAFILE hmf, MFENUMPROC lpMetaFunc, LPARAM lParam)
    exports['EnumMetaFile'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const hmf = args[1];
        const lpMetaFunc = args[2];
        Logger.verbose(
            LogCategory.GDI32,
            `EnumMetaFile(hdc=0x${hdc.toString(16)}, hmf=0x${hmf.toString(16)}, proc=0x${lpMetaFunc.toString(16)}) — stub`,
        );
        return 1;
    };

    // BOOL PlayMetaFileRecord(HDC hdc, LPHANDLETABLE lpHandleTable, LPMETARECORD lpMR, UINT noObjs)
    exports['PlayMetaFileRecord'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `PlayMetaFileRecord(hdc=0x${hdc.toString(16)}) — stub`);
        return 1;
    };

    // int AddFontResourceA(LPCSTR pszFilename)
    exports['AddFontResourceA'] = (ctx, mem, args): number | Promise<number> => {
        const path = args[0] ? Marshaler.readString(mem, args[0]) : '';
        Logger.verbose(LogCategory.GDI32, `AddFontResourceA("${path}")`);

        if (!path) return 0;

        const vfs = System.getInstance().fileSystem;
        const resolved = vfs.resolvePath(path);
        const size = vfs.getFileSize(resolved);
        if (size <= 0) {
            Logger.verbose(LogCategory.GDI32, `AddFontResourceA: file not found "${path}"`);
            return 0;
        }

        // Async thunk: blocks the calling guest thread until the FontFace is
        // installed — faithful to AddFontResource returning with the font usable.
        return (async (): Promise<number> => {
            try {
                const GENERIC_READ = 0x80000000;
                const OPEN_EXISTING = 3;
                const handle = await vfs.open(resolved, GENERIC_READ, OPEN_EXISTING);
                if (!handle) return 0;
                const data = await vfs.read(handle, size);
                return await addFontResource(resolved, data);
            } catch (e) {
                Logger.warn(LogCategory.GDI32, `AddFontResourceA: read failed for "${path}": ${e}`);
                return 0;
            }
        })();
    };

    // BOOL RemoveFontResourceA(LPCSTR pszFilename)
    exports['RemoveFontResourceA'] = (ctx, mem, args): number => {
        const path = args[0] ? Marshaler.readString(mem, args[0]) : '';
        Logger.verbose(LogCategory.GDI32, `RemoveFontResourceA("${path}")`);
        if (!path) return 0;
        const vfs = System.getInstance().fileSystem;
        return removeFontResource(vfs.resolvePath(path)) ? 1 : 0;
    };

    // BOOL GetICMProfileW(HDC hdc, LPDWORD pBufSize, LPWSTR pszFilename)
    //
    // Retrieves the color profile path for the given DC.
    //
    // Per MSDN — three distinct cases:
    //   1. lpcbName == NULL                 → ERROR_INVALID_PARAMETER (87), FALSE
    //   2. pszFilename == NULL              → write required size to *lpcbName, TRUE
    //      (two-pass probe: GetICMProfileW(hdc, &n, NULL) then alloc(n) + real call)
    //   3. pszFilename != NULL, too small   → write required size to *lpcbName,
    //                                         ERROR_INSUFFICIENT_BUFFER (122), FALSE
    //   4. pszFilename != NULL, fits        → write path + size, TRUE
    //
    // We always return the sRGB profile path — the standard Windows default for
    // display DCs. HDC is accepted but not dispatched further for now.
    exports['GetICMProfileW'] = (ctx, mem, args): number => {
        const hdc         = args[0] >>> 0;
        const lpcbName    = args[1] >>> 0;
        const pszFilename = args[2] >>> 0;

        // Default sRGB profile returned by Windows for display DCs.
        const ICM_PROFILE = 'C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm';
        // Required buffer size in WCHARs, including null terminator.
        const requiredChars = ICM_PROFILE.length + 1;

        Logger.verbose(
            LogCategory.GDI32,
            `GetICMProfileW(hdc=0x${hdc.toString(16)}, lpcbName=0x${lpcbName.toString(16)}, pszFilename=0x${pszFilename.toString(16)})`,
        );

        const ERROR_INVALID_PARAMETER    = 87;
        const ERROR_INSUFFICIENT_BUFFER  = 122;
        const scheduler = System.getInstance().scheduler;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Case 1: lpcbName is required by the contract.
        if (!lpcbName || lpcbName + 4 > mem.length) {
            scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0; // FALSE
        }

        // Case 2: NULL pszFilename — size probe, return TRUE.
        if (!pszFilename) {
            view.setUint32(lpcbName, requiredChars, true);
            Logger.verbose(LogCategory.GDI32, `GetICMProfileW: size probe -> ${requiredChars} WCHARs`);
            return 1; // TRUE
        }

        // Read caller-supplied buffer capacity (in WCHARs).
        const capacity = view.getUint32(lpcbName, true);

        // Always update *lpcbName with the required size (both success and failure).
        view.setUint32(lpcbName, requiredChars, true);

        // Case 3: buffer present but too small.
        if (capacity < requiredChars) {
            scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
            Logger.verbose(
                LogCategory.GDI32,
                `GetICMProfileW: buffer too small (capacity=${capacity}, required=${requiredChars}) -> FALSE`,
            );
            return 0; // FALSE
        }

        // Case 4: write profile path as UTF-16LE into the caller's buffer.
        Marshaler.writeWideString(mem, pszFilename, ICM_PROFILE, requiredChars);
        Logger.verbose(LogCategory.GDI32, `GetICMProfileW(hdc=0x${hdc.toString(16)}) -> "${ICM_PROFILE}"`);
        return 1; // TRUE
    };
}
