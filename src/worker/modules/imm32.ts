/**
 * IMM32.dll stubs.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";

const TRUE = 1;
const FALSE = 0;
const IMM_ERROR_NODATA = -1;
const DEFAULT_HIMC = 0x00011000;

export class Imm32 implements IModule {
    name = "imm32";
    exports: Record<string, ThunkImplementation> = {};
    private openStatus = false;
    private conversion = 0;
    private sentence = 0;

    initialize(_process: Process): void {
        // BOOL ImmDisableIME(DWORD idThread)
        this.exports["ImmDisableIME"] = (ctx, mem, args) => {
            const idThread = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmDisableIME(idThread=${idThread}) -> TRUE`);
            return TRUE;
        };

        // BOOL ImmIsIME(HKL hKL)
        this.exports["ImmIsIME"] = (ctx, mem, args) => {
            const hKL = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmIsIME(hKL=0x${hKL.toString(16)}) -> FALSE`);
            return FALSE;
        };

        // HIMC ImmGetContext(HWND hWnd)
        this.exports["ImmGetContext"] = (ctx, mem, args) => {
            const hWnd = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetContext(hWnd=0x${hWnd.toString(16)}) -> 0x${DEFAULT_HIMC.toString(16)}`);
            return DEFAULT_HIMC;
        };

        /**
         * HIMC ImmCreateContext(void) — a caller stores the result and dereferences it
         * later, so a NULL from an unimplemented export is not a no-op: it is a pointer the
         * app will read through. There is no IME here, but the HANDLE must still be a
         * handle; the same one ImmGetContext hands out keeps the two consistent.
         */
        this.exports["ImmCreateContext"] = () => DEFAULT_HIMC;

        // BOOL ImmDestroyContext(HIMC hIMC)
        this.exports["ImmDestroyContext"] = () => TRUE;

        // BOOL ImmReleaseContext(HWND hWnd, HIMC hIMC)
        this.exports["ImmReleaseContext"] = (ctx, mem, args) => {
            const hWnd = args[0] >>> 0;
            const hIMC = args[1] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmReleaseContext(hWnd=0x${hWnd.toString(16)}, hIMC=0x${hIMC.toString(16)}) -> TRUE`);
            return TRUE;
        };

        // BOOL ImmGetOpenStatus(HIMC hIMC)
        this.exports["ImmGetOpenStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetOpenStatus(hIMC=0x${hIMC.toString(16)}) -> ${this.openStatus ? "TRUE" : "FALSE"}`);
            return this.openStatus ? TRUE : FALSE;
        };

        // BOOL ImmSetOpenStatus(HIMC hIMC, BOOL fOpen)
        this.exports["ImmSetOpenStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const fOpen = (args[1] >>> 0) !== 0;
            this.openStatus = fOpen;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmSetOpenStatus(hIMC=0x${hIMC.toString(16)}, fOpen=${fOpen ? 1 : 0}) -> TRUE`);
            return TRUE;
        };

        // LONG ImmGetCompositionStringA(HIMC hIMC, DWORD dwIndex, LPVOID lpBuf, DWORD dwBufLen)
        this.exports["ImmGetCompositionStringA"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwIndex = args[1] >>> 0;
            const lpBuf = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetCompositionStringA(hIMC=0x${hIMC.toString(16)}, index=0x${dwIndex.toString(16)}, buf=0x${lpBuf.toString(16)}, len=${dwBufLen}) -> IMM_ERROR_NODATA`);
            return IMM_ERROR_NODATA;
        };

        // DWORD ImmGetCandidateListA(HIMC hIMC, DWORD deIndex, LPCANDIDATELIST lpCandList, DWORD dwBufLen)
        this.exports["ImmGetCandidateListA"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const deIndex = args[1] >>> 0;
            const lpCandList = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetCandidateListA(hIMC=0x${hIMC.toString(16)}, index=${deIndex}, list=0x${lpCandList.toString(16)}, len=${dwBufLen}) -> 0`);
            return 0;
        };

        // DWORD ImmGetCandidateListCountA(HIMC hIMC, LPDWORD lpdwListCount)
        this.exports["ImmGetCandidateListCountA"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpdwListCount = args[1] >>> 0;
            if (lpdwListCount) {
                Mem.writeUint32(lpdwListCount, 0);
            }
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetCandidateListCountA(hIMC=0x${hIMC.toString(16)}, out=0x${lpdwListCount.toString(16)}) -> 0`);
            return 0;
        };

        // BOOL ImmGetConversionStatus(HIMC hIMC, LPDWORD lpfdwConversion, LPDWORD lpfdwSentence)
        this.exports["ImmGetConversionStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpfdwConversion = args[1] >>> 0;
            const lpfdwSentence = args[2] >>> 0;

            if (lpfdwConversion) Mem.writeUint32(lpfdwConversion, this.conversion >>> 0);
            if (lpfdwSentence) Mem.writeUint32(lpfdwSentence, this.sentence >>> 0);

            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmGetConversionStatus(hIMC=0x${hIMC.toString(16)}) -> conv=0x${this.conversion.toString(16)} sent=0x${this.sentence.toString(16)}`);
            return TRUE;
        };

        // BOOL ImmSetConversionStatus(HIMC hIMC, DWORD fdwConversion, DWORD fdwSentence)
        this.exports["ImmSetConversionStatus"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const fdwConversion = args[1] >>> 0;
            const fdwSentence = args[2] >>> 0;
            this.conversion = fdwConversion;
            this.sentence = fdwSentence;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmSetConversionStatus(hIMC=0x${hIMC.toString(16)}, conv=0x${fdwConversion.toString(16)}, sent=0x${fdwSentence.toString(16)}) -> TRUE`);
            return TRUE;
        };

        // HIMC ImmAssociateContext(HWND hWnd, HIMC hIMC)
        // Associates (or disassociates) an IME context with a window; returns previous HIMC.
        this.exports["ImmAssociateContext"] = (ctx, mem, args) => {
            const hWnd = args[0] >>> 0;
            const hIMC = args[1] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmAssociateContext(hWnd=0x${hWnd.toString(16)}, hIMC=0x${hIMC.toString(16)}) -> prev=0x${DEFAULT_HIMC.toString(16)}`);
            // Return previous context (our single default context)
            return DEFAULT_HIMC;
        };

        // BOOL ImmSetCompositionStringA(HIMC hIMC, DWORD dwIndex, LPVOID lpComp, DWORD dwCompLen, LPVOID lpRead, DWORD dwReadLen)
        this.exports["ImmSetCompositionStringA"] = (ctx, mem, args) => {
            // Stub: we have no real IME composition state
            return FALSE;
        };

        // BOOL ImmSimulateHotKey(HWND hWnd, DWORD dwHotKeyID)
        this.exports["ImmSimulateHotKey"] = (ctx, mem, args) => {
            const hWnd = args[0] >>> 0;
            const dwHotKeyID = args[1] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `imm32:ImmSimulateHotKey(hWnd=0x${hWnd.toString(16)}, hotKey=${dwHotKeyID}) -> FALSE`);
            return FALSE;
        };

        // LONG ImmGetCompositionStringW(HIMC hIMC, DWORD dwIndex, LPVOID lpBuf, DWORD dwBufLen)
        //
        // Returns the number of bytes copied / required. If no composition data is
        // available, returns IMM_ERROR_NODATA (-1). dwBufLen is in bytes even for W.
        this.exports["ImmGetCompositionStringW"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwIndex = args[1] >>> 0;
            const lpBuf = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmGetCompositionStringW(hIMC=0x${hIMC.toString(16)}, index=0x${dwIndex.toString(16)}, buf=0x${lpBuf.toString(16)}, len=${dwBufLen}) -> IMM_ERROR_NODATA`
            );

            return IMM_ERROR_NODATA;
        };

        // DWORD ImmGetCandidateListW(HIMC hIMC, DWORD deIndex, LPCANDIDATELIST lpCandList, DWORD dwBufLen)
        //
        // Returns bytes copied / required, or 0 on failure/no candidate list.
        this.exports["ImmGetCandidateListW"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const deIndex = args[1] >>> 0;
            const lpCandList = args[2] >>> 0;
            const dwBufLen = args[3] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmGetCandidateListW(hIMC=0x${hIMC.toString(16)}, index=${deIndex}, list=0x${lpCandList.toString(16)}, len=${dwBufLen}) -> 0`
            );

            return 0;
        };

        // UINT ImmGetIMEFileNameA(HKL hKL, LPSTR lpszFileName, UINT uBufLen)
        //
        // Retrieves IME DLL filename for keyboard layout. Since ImmIsIME() returns FALSE
        // in this shim, report no IME filename. Return value excludes null terminator.
        this.exports["ImmGetIMEFileNameA"] = (ctx, mem, args) => {
            const hKL = args[0] >>> 0;
            const lpszFileName = args[1] >>> 0;
            const uBufLen = args[2] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmGetIMEFileNameA(hKL=0x${hKL.toString(16)}, file=0x${lpszFileName.toString(16)}, len=${uBufLen}) -> 0`
            );

            return 0;
        };

        // BOOL ImmNotifyIME(HIMC hIMC, DWORD dwAction, DWORD dwIndex, DWORD dwValue)
        //
        // Notifies IME about changes in the input context. We have no real IME, but
        // returning TRUE keeps legacy apps that merely poke IME state moving.
        this.exports["ImmNotifyIME"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwAction = args[1] >>> 0;
            const dwIndex = args[2] >>> 0;
            const dwValue = args[3] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmNotifyIME(hIMC=0x${hIMC.toString(16)}, action=0x${dwAction.toString(16)}, index=0x${dwIndex.toString(16)}, value=0x${dwValue.toString(16)}) -> TRUE`
            );

            return TRUE;
        };

        // BOOL ImmSetCandidateWindow(HIMC hIMC, LPCANDIDATEFORM lpCandidate)
        //
        // Sets candidate window position/style. No-op success: games often call this
        // while initializing text input even if no IME UI is actually needed.
        this.exports["ImmSetCandidateWindow"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpCandidate = args[1] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmSetCandidateWindow(hIMC=0x${hIMC.toString(16)}, candidate=0x${lpCandidate.toString(16)}) -> TRUE`
            );

            return TRUE;
        };

        // BOOL ImmSetCompositionStringW(HIMC hIMC, DWORD dwIndex, LPVOID lpComp, DWORD dwCompLen, LPVOID lpRead, DWORD dwReadLen)
        //
        // Stub: we do not maintain real IME composition state. Match the A variant.
        this.exports["ImmSetCompositionStringW"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const dwIndex = args[1] >>> 0;
            const lpComp = args[2] >>> 0;
            const dwCompLen = args[3] >>> 0;
            const lpRead = args[4] >>> 0;
            const dwReadLen = args[5] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmSetCompositionStringW(hIMC=0x${hIMC.toString(16)}, index=0x${dwIndex.toString(16)}, comp=0x${lpComp.toString(16)}, compLen=${dwCompLen}, read=0x${lpRead.toString(16)}, readLen=${dwReadLen}) -> FALSE`
            );

            return FALSE;
        };

        // BOOL ImmSetCompositionWindow(HIMC hIMC, LPCOMPOSITIONFORM lpCompForm)
        //
        // Sets composition window position/style. No-op success.
        this.exports["ImmSetCompositionWindow"] = (ctx, mem, args) => {
            const hIMC = args[0] >>> 0;
            const lpCompForm = args[1] >>> 0;

            Logger.verbose(
                LogCategory.SYSTEM,
                `imm32:ImmSetCompositionWindow(hIMC=0x${hIMC.toString(16)}, compForm=0x${lpCompForm.toString(16)}) -> TRUE`
            );

            return TRUE;
        };
    }

    reset(): void {
        this.openStatus = false;
        this.conversion = 0;
        this.sentence = 0;
    }
}
