import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Marshaler } from "../core/memory/marshaler";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";

// Windows Print Spooler API (winspool.drv)
// Minimal stub implementation for legacy applications that check for printer availability

const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PRINTER_NAME = 1801;
const ERROR_INSUFFICIENT_BUFFER = 122;

export class Winspool implements IModule {
    name = "winspool.drv";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // OpenPrinterA - Opens a handle to the specified printer
        // BOOL OpenPrinterA(LPCSTR pPrinterName, LPHANDLE phPrinter, LPPRINTER_DEFAULTS pDefault)
        this.exports["OpenPrinterA"] = (ctx, mem, args) => {
            const pPrinterName = args[0];
            const phPrinter = args[1];
            const pDefault = args[2];

            const printerName = pPrinterName ? Marshaler.readString(mem, pPrinterName) : "(default)";
            Logger.log(LogCategory.SYSTEM, `OpenPrinterA: pPrinterName="${printerName}", phPrinter=0x${phPrinter.toString(16)}`);

            // Always fail - no printer available in emulated environment
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PRINTER_NAME);
            return { value: 0, stackCleanup: 12 }; // FALSE
        };

        // OpenPrinterW - Wide char version
        this.exports["OpenPrinterW"] = (ctx, mem, args) => {
            const pPrinterName = args[0];
            const phPrinter = args[1];
            const pDefault = args[2];

            const printerName = pPrinterName ? Marshaler.readWideString(mem, pPrinterName) : "(default)";
            Logger.log(LogCategory.SYSTEM, `OpenPrinterW: pPrinterName="${printerName}", phPrinter=0x${phPrinter.toString(16)}`);

            System.getInstance().scheduler.setLastError(ERROR_INVALID_PRINTER_NAME);
            return { value: 0, stackCleanup: 12 }; // FALSE
        };

        // ClosePrinter - Closes a handle to the specified printer
        // BOOL ClosePrinter(HANDLE hPrinter)
        this.exports["ClosePrinter"] = (ctx, mem, args) => {
            const hPrinter = args[0];
            Logger.log(LogCategory.SYSTEM, `ClosePrinter: hPrinter=0x${hPrinter.toString(16)}`);

            if (hPrinter === 0) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
                return { value: 0, stackCleanup: 4 }; // FALSE
            }

            // Stub success
            return { value: 1, stackCleanup: 4 }; // TRUE
        };

        // DocumentPropertiesA - Retrieves or modifies printer configuration
        // LONG DocumentPropertiesA(HWND hWnd, HANDLE hPrinter, LPSTR pDeviceName,
        //                          PDEVMODE pDevModeOutput, PDEVMODE pDevModeInput, DWORD fMode)
        this.exports["DocumentPropertiesA"] = (ctx, mem, args) => {
            const hWnd = args[0];
            const hPrinter = args[1];
            const pDeviceName = args[2];
            const pDevModeOutput = args[3];
            const pDevModeInput = args[4];
            const fMode = args[5];

            const deviceName = pDeviceName ? Marshaler.readString(mem, pDeviceName) : "";
            Logger.log(LogCategory.SYSTEM, `DocumentPropertiesA: hPrinter=0x${hPrinter.toString(16)}, deviceName="${deviceName}", fMode=${fMode}`);

            // Return error - operation not supported
            const IDCERR_DRIVERNOTFOUND = -1;
            return { value: IDCERR_DRIVERNOTFOUND, stackCleanup: 24 };
        };

        // DocumentPropertiesW - Wide char version
        this.exports["DocumentPropertiesW"] = (ctx, mem, args) => {
            const hWnd = args[0];
            const hPrinter = args[1];
            const pDeviceName = args[2];
            const pDevModeOutput = args[3];
            const pDevModeInput = args[4];
            const fMode = args[5];

            const deviceName = pDeviceName ? Marshaler.readWideString(mem, pDeviceName) : "";
            Logger.log(LogCategory.SYSTEM, `DocumentPropertiesW: hPrinter=0x${hPrinter.toString(16)}, deviceName="${deviceName}", fMode=${fMode}`);

            const IDCERR_DRIVERNOTFOUND = -1;
            return { value: IDCERR_DRIVERNOTFOUND, stackCleanup: 24 };
        };

        // GetPrinterA - Retrieves information about a specified printer
        // BOOL GetPrinterA(HANDLE hPrinter, DWORD Level, LPBYTE pPrinter, DWORD cbBuf, LPDWORD pcbNeeded)
        this.exports["GetPrinterA"] = (ctx, mem, args) => {
            const hPrinter = args[0];
            const Level = args[1];
            const pPrinter = args[2];
            const cbBuf = args[3];
            const pcbNeeded = args[4];

            Logger.log(LogCategory.SYSTEM, `GetPrinterA: hPrinter=0x${hPrinter.toString(16)}, Level=${Level}`);

            // Set required buffer size (arbitrary small value)
            if (pcbNeeded && pcbNeeded + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(pcbNeeded, 256, true);
            }

            System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return { value: 0, stackCleanup: 20 }; // FALSE
        };

        // GetPrinterW - Wide char version
        this.exports["GetPrinterW"] = (ctx, mem, args) => {
            const hPrinter = args[0];
            const Level = args[1];
            const pPrinter = args[2];
            const cbBuf = args[3];
            const pcbNeeded = args[4];

            Logger.log(LogCategory.SYSTEM, `GetPrinterW: hPrinter=0x${hPrinter.toString(16)}, Level=${Level}`);

            if (pcbNeeded && pcbNeeded + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(pcbNeeded, 256, true);
            }

            System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return { value: 0, stackCleanup: 20 }; // FALSE
        };

        // EnumPrintersA - Enumerates available printers
        // BOOL EnumPrintersA(DWORD Flags, LPSTR Name, DWORD Level, LPBYTE pPrinterEnum,
        //                    DWORD cbBuf, LPDWORD pcbNeeded, LPDWORD pcReturned)
        this.exports["EnumPrintersA"] = (ctx, mem, args) => {
            const Flags = args[0];
            const Name = args[1];
            const Level = args[2];
            const pPrinterEnum = args[3];
            const cbBuf = args[4];
            const pcbNeeded = args[5];
            const pcReturned = args[6];

            Logger.log(LogCategory.SYSTEM, `EnumPrintersA: Flags=0x${Flags.toString(16)}, Level=${Level}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Return 0 printers found
            if (pcbNeeded && pcbNeeded + 4 <= mem.length) {
                view.setUint32(pcbNeeded, 0, true);
            }
            if (pcReturned && pcReturned + 4 <= mem.length) {
                view.setUint32(pcReturned, 0, true);
            }

            return { value: 1, stackCleanup: 28 }; // TRUE (0 printers is valid)
        };

        // EnumPrintersW - Wide char version
        this.exports["EnumPrintersW"] = (ctx, mem, args) => {
            const Flags = args[0];
            const Name = args[1];
            const Level = args[2];
            const pPrinterEnum = args[3];
            const cbBuf = args[4];
            const pcbNeeded = args[5];
            const pcReturned = args[6];

            Logger.log(LogCategory.SYSTEM, `EnumPrintersW: Flags=0x${Flags.toString(16)}, Level=${Level}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (pcbNeeded && pcbNeeded + 4 <= mem.length) {
                view.setUint32(pcbNeeded, 0, true);
            }
            if (pcReturned && pcReturned + 4 <= mem.length) {
                view.setUint32(pcReturned, 0, true);
            }

            return { value: 1, stackCleanup: 28 }; // TRUE
        };

        // GetDefaultPrinterA - Retrieves the default printer name
        // BOOL GetDefaultPrinterA(LPSTR pszBuffer, LPDWORD pcchBuffer)
        this.exports["GetDefaultPrinterA"] = (ctx, mem, args) => {
            const pszBuffer = args[0];
            const pcchBuffer = args[1];

            Logger.log(LogCategory.SYSTEM, `GetDefaultPrinterA: pszBuffer=0x${pszBuffer.toString(16)}, pcchBuffer=0x${pcchBuffer.toString(16)}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Set required size to 0 (no default printer)
            if (pcchBuffer && pcchBuffer + 4 <= mem.length) {
                view.setUint32(pcchBuffer, 0, true);
            }

            const ERROR_FILE_NOT_FOUND = 2;
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return { value: 0, stackCleanup: 8 }; // FALSE
        };

        // GetDefaultPrinterW - Wide char version
        this.exports["GetDefaultPrinterW"] = (ctx, mem, args) => {
            const pszBuffer = args[0];
            const pcchBuffer = args[1];

            Logger.log(LogCategory.SYSTEM, `GetDefaultPrinterW: pszBuffer=0x${pszBuffer.toString(16)}, pcchBuffer=0x${pcchBuffer.toString(16)}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (pcchBuffer && pcchBuffer + 4 <= mem.length) {
                view.setUint32(pcchBuffer, 0, true);
            }

            const ERROR_FILE_NOT_FOUND = 2;
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            return { value: 0, stackCleanup: 8 }; // FALSE
        };
    }
}
