/**
 * kernel32 console I/O: the ConsoleDeviceHandle device wrapper (CONOUT$/CONIN$/NUL)
 * plus the console-mode / screen-buffer / console-input handler family. The device
 * wrapper and its type guard are exported because the file-io hot paths
 * (CreateFile/ReadFile/WriteFile/CloseHandle) still branch on console handles.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import {
    consoleScreenBuffers,
    readCoordFromMem,
    readSmallRectFromMem,
    type ConsoleScreenBuffer,
} from './console-screen-buffer';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOACCESS = 998;
const INPUT_RECORD_SIZE = 20;
const DEFAULT_CONSOLE_INPUT_MODE = 0x0007; // ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT
const DEFAULT_CONSOLE_OUTPUT_MODE = 0x0001; // ENABLE_PROCESSED_OUTPUT

/**
 * Recognize Windows special device names (CONOUT$, CONIN$, NUL, etc.)
 */
export function isWindowsDevice(path: string): 'CONOUT' | 'CONIN' | 'NUL' | null {
    const normalized = path.toUpperCase().replace(/[\\/]/g, '').replace(/\$/g, '');
    if (normalized === 'CONOUT' || normalized === 'CON') return 'CONOUT';
    if (normalized === 'CONIN') return 'CONIN';
    if (normalized === 'NUL') return 'NUL';
    // Can add PRN, AUX, COM1-9, LPT1-9 later
    return null;
}

/**
 * Get code page name for console output decoding
 * Uses OEM code page (CP437) for old games, falls back to UTF-8
 */
function getConsoleCodePage(): string {
    // Try to get OEM CP from System, but for now use CP437 as default for old games
    // CP437 is US IBM, commonly used in DOS/early Windows games
    // Can be extended to call GetOEMCP() through System if needed
    return 'ibm437'; // CP437 for OEM encoding
}

/**
 * Strip ANSI escape sequences from text
 */
function stripAnsiCodes(text: string): string {
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// Marker for type checking
const CONSOLE_DEVICE_MARKER = Symbol('ConsoleDeviceHandle');

/**
 * Handle for Windows console devices (CONOUT$, CONIN$, NUL)
 * Provides buffered output to Logger system instead of direct console.log
 */
export class ConsoleDeviceHandle {
    // Marker for instanceof check in WriteFile/ReadFile
    readonly [CONSOLE_DEVICE_MARKER] = true;

    private buffer: Uint8Array = new Uint8Array(0);
    private flushTimer: number | null = null;
    private readonly FLUSH_TIMEOUT_MS = 16; // One frame at 60fps

    constructor(public readonly deviceType: 'CONOUT' | 'CONIN' | 'NUL') { }

    // Methods for compatibility with FileHandleWrapper API
    get vfsHandle(): never {
        throw new Error('ConsoleDeviceHandle is not a VFS handle');
    }

    get position(): number {
        return 0; // Console devices don't have position
    }

    get size(): number {
        return 0; // Console devices don't have size
    }

    readSync(length: number): null {
        return null; // Always async for console devices
    }

    async write(data: Uint8Array): Promise<number> {
        if (this.deviceType === 'NUL') {
            return data.length; // Instant no-op
        }

        if (this.deviceType === 'CONOUT') {
            // Append to buffer
            const newBuffer = new Uint8Array(this.buffer.length + data.length);
            newBuffer.set(this.buffer);
            newBuffer.set(data, this.buffer.length);
            this.buffer = newBuffer;

            // Check for newline or flush on timeout
            const hasNewline = this.buffer.includes(0x0A); // \n
            if (hasNewline) {
                this.flush();
            } else if (this.flushTimer === null) {
                this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_TIMEOUT_MS) as unknown as number;
            }

            return data.length;
        }

        return 0;
    }

    private flush(): void {
        if (this.buffer.length === 0) return;

        // Decode with appropriate code page
        const codePage = getConsoleCodePage();
        let text: string;
        try {
            text = new TextDecoder(codePage).decode(this.buffer);
        } catch {
            // Fallback to UTF-8
            text = new TextDecoder().decode(this.buffer);
        }

        // Strip ANSI codes
        text = stripAnsiCodes(text);

        // Log through Logger system (not direct console.log)
        Logger.info(LogCategory.KERNEL32, `[CONOUT] ${text.trimEnd()}`);

        // Clear buffer and timer
        this.buffer = new Uint8Array(0);
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    async read(length: number): Promise<Uint8Array> {
        if (this.deviceType === 'CONIN') {
            return new Uint8Array(0); // Empty - no input support yet
        }
        throw new Error('Cannot read from this device');
    }

    close(): void {
        this.flush(); // Flush any remaining data
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }
}

// Type guard for checking in WriteFile/ReadFile
export function isConsoleDeviceHandle(handle: any): handle is ConsoleDeviceHandle {
    return handle && (handle instanceof ConsoleDeviceHandle || handle[CONSOLE_DEVICE_MARKER] === true);
}

const consoleModeByHandle = new Map<number, number>();

export function resetConsoleModeState(): void {
    consoleModeByHandle.clear();
}

const resolveConsoleOutputBuffer = (hConsoleOutput: number): ConsoleScreenBuffer => {
    const direct = consoleScreenBuffers.resolveOutputHandle(hConsoleOutput);
    if (direct) return direct;
    const fh = System.getInstance().resourceProvider.getFileHandle(hConsoleOutput);
    if (fh && isConsoleDeviceHandle(fh) && fh.deviceType === 'CONOUT') {
        return consoleScreenBuffers.getDefault();
    }
    return consoleScreenBuffers.getDefault();
};

export function registerFileIoConsoleExports(exports: Record<string, ThunkImplementation>): void {
    exports['AllocConsole'] = (ctx, mem, args) => {
        // AllocConsole allocates a new console for the calling process
        // In the emulator context, console is already available through logging
        Logger.verbose(LogCategory.KERNEL32, 'AllocConsole() called');

        // Return TRUE (1) to indicate success
        // In a real Windows system, this would create a console window
        // Here we just acknowledge that console is available
        return 1; // TRUE
    };

    exports['FreeConsole'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, 'FreeConsole() called');
        return 1;
    };

    // BOOL AttachConsole(DWORD dwProcessId)
    // Connects the calling process to an existing console owned by another process.
    // In BottleShip, console I/O is log-backed and our pseudo-handles are always valid,
    // so we have nothing real to attach to. Games and installers call this either to
    // inherit the parent's console or as a compatibility probe before WriteConsole /
    // WriteFile(stderr). Returning TRUE (no error) is more compatible than failing with
    // ERROR_ACCESS_DENIED ("already has a console"), which some callers treat as fatal.
    exports['AttachConsole'] = (ctx, mem, args) => {
        const ATTACH_PARENT_PROCESS = 0xFFFFFFFF;
        const dwProcessId = args[0] >>> 0;
        Logger.verbose(
            LogCategory.KERNEL32,
            `AttachConsole(${dwProcessId === ATTACH_PARENT_PROCESS ? 'ATTACH_PARENT_PROCESS' : dwProcessId}) -> TRUE`
        );
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    // HWND GetConsoleWindow(void)
    // Our console is log-backed and owns no window, so there is no HWND to hand out.
    // NULL is the documented answer for a process with no console window, and callers
    // (crash reporters hiding/raising the console) all test for it.
    exports['GetConsoleWindow'] = () => {
        Logger.verbose(LogCategory.KERNEL32, 'GetConsoleWindow() -> NULL (log-backed console has no window)');
        return 0;
    };

    exports['GetConsoleMode'] = (ctx, mem, args) => {
        const hConsoleHandle = args[0];
        const lpMode = args[1];
        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hConsoleHandle);
        if (!fileHandle || !isConsoleDeviceHandle(fileHandle)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }
        if (lpMode) {
            const mode = consoleModeByHandle.get(hConsoleHandle) ??
                (fileHandle.deviceType === 'CONIN' ? DEFAULT_CONSOLE_INPUT_MODE : DEFAULT_CONSOLE_OUTPUT_MODE);
            if (!Mem.writeUint32(lpMode, mode >>> 0)) {
                System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
                return 0; // FALSE
            }
        }
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    exports['SetConsoleMode'] = (ctx, mem, args) => {
        const hConsoleHandle = args[0];
        const dwMode = args[1] >>> 0;
        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hConsoleHandle);
        if (!fileHandle || !isConsoleDeviceHandle(fileHandle)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }
        consoleModeByHandle.set(hConsoleHandle, dwMode);
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    exports['GetConsoleScreenBufferInfo'] = (ctx, mem, args) => {
        const lpInfo = args[1] >>> 0;
        const buf = resolveConsoleOutputBuffer(args[0]);
        if (lpInfo) buf.fillScreenBufferInfo(mem, lpInfo);
        System.getInstance().scheduler.setLastError(0);
        return 1;
    };

    exports['SetConsoleTextAttribute'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        buf.attributes = args[1] & 0xffff;
        return 1;
    };
    exports['SetConsoleCursorPosition'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        buf.setCursorPosition(readCoordFromMem(mem, args[1] >>> 0));
        return 1;
    };
    exports['SetConsoleCursorInfo'] = () => 1;
    exports['SetConsoleScreenBufferSize'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const size = readCoordFromMem(mem, args[1] >>> 0);
        buf.setScreenBufferSize(size.x, size.y);
        return 1;
    };
    exports['SetConsoleWindowInfo'] = () => 1;
    exports['SetConsoleTitleA'] = () => 1;
    exports['GetConsoleCursorInfo'] = (ctx, mem, args) => {
        const lpInfo = args[1] >>> 0;
        if (lpInfo && lpInfo + 8 <= mem.length) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            dv.setUint32(lpInfo + 0, 25, true); // dwSize (cursor height %)
            dv.setUint32(lpInfo + 4, 1, true);  // bVisible = TRUE
        }
        return 1;
    };
    exports['GetLargestConsoleWindowSize'] = () => (25 << 16) | 80; // COORD {X=80,Y=25} packed
    // The screen buffer stores UTF-16, so the W entry point must keep all 16 bits;
    // only the A entry point's CHAR argument is one byte wide.
    const fillConsoleOutputCharacter = (mask: number): ThunkImplementation =>
        (ctx, mem, args) => {
            const buf = resolveConsoleOutputBuffer(args[0]);
            const ch = args[1] & mask;
            const n = args[2] >>> 0;
            const coord = readCoordFromMem(mem, args[3] >>> 0);
            const written = buf.fillCharacter(ch, n, coord);
            const lpWritten = args[4] >>> 0;
            if (lpWritten) Mem.writeUint32(lpWritten, written);
            return 1;
        };
    exports['FillConsoleOutputCharacterA'] = fillConsoleOutputCharacter(0xff);
    exports['FillConsoleOutputCharacterW'] = fillConsoleOutputCharacter(0xffff);
    exports['FillConsoleOutputAttribute'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const attr = args[1] & 0xffff;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const written = buf.fillAttribute(attr, n, coord);
        const lpWritten = args[4] >>> 0;
        if (lpWritten) Mem.writeUint32(lpWritten, written);
        return 1;
    };
    exports['WriteConsoleOutputCharacterA'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpChars = args[1] >>> 0;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const written = buf.writeCharactersA(mem, lpChars, n, coord);
        const lpWritten = args[4] >>> 0;
        if (lpWritten) Mem.writeUint32(lpWritten, written);
        return 1;
    };
    exports['WriteConsoleOutputCharacterW'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpChars = args[1] >>> 0;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const written = buf.writeCharactersW(mem, lpChars, n, coord);
        const lpWritten = args[4] >>> 0;
        if (lpWritten) Mem.writeUint32(lpWritten, written);
        return 1;
    };
    exports['WriteConsoleOutputAttribute'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpAttrs = args[1] >>> 0;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let written = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < n; i++) {
            const off = lpAttrs + i * 2;
            if (off + 1 >= mem.length) break;
            const attr = view.getUint16(off, true);
            written += buf.writeAttributes({ x, y }, 1, attr);
            x++;
            if (x >= buf.cols) { x = 0; y++; }
        }
        const lpWritten = args[4] >>> 0;
        if (lpWritten) Mem.writeUint32(lpWritten, written);
        return 1;
    };
    exports['ReadConsoleOutputCharacterA'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpBuffer = args[1] >>> 0;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const read = buf.readCharactersA(mem, lpBuffer, n, coord);
        const lpRead = args[4] >>> 0;
        if (lpRead) Mem.writeUint32(lpRead, read);
        return 1;
    };
    exports['ReadConsoleOutputCharacterW'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpBuffer = args[1] >>> 0;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const read = buf.readCharactersW(mem, lpBuffer, n, coord);
        const lpRead = args[4] >>> 0;
        if (lpRead) Mem.writeUint32(lpRead, read);
        return 1;
    };
    exports['ReadConsoleOutputAttribute'] = (ctx, mem, args) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpBuffer = args[1] >>> 0;
        const n = args[2] >>> 0;
        const coord = readCoordFromMem(mem, args[3] >>> 0);
        const read = buf.readAttributes(mem, lpBuffer, n, coord);
        const lpRead = args[4] >>> 0;
        if (lpRead) Mem.writeUint32(lpRead, read);
        return 1;
    };
    const readConsoleOutput = (wide: boolean) => (ctx: unknown, mem: Uint8Array, args: number[]) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpBuffer = args[1] >>> 0;
        const bufferSize = readCoordFromMem(mem, args[2] >>> 0);
        const bufferCoord = readCoordFromMem(mem, args[3] >>> 0);
        const readRegion = readSmallRectFromMem(mem, args[4] >>> 0);
        const ok = wide
            ? buf.readOutputW(mem, lpBuffer, bufferSize, bufferCoord, readRegion)
            : buf.readOutputA(mem, lpBuffer, bufferSize, bufferCoord, readRegion);
        System.getInstance().scheduler.setLastError(ok ? 0 : ERROR_NOACCESS);
        return ok ? 1 : 0;
    };
    const writeConsoleOutput = (wide: boolean) => (ctx: unknown, mem: Uint8Array, args: number[]) => {
        const buf = resolveConsoleOutputBuffer(args[0]);
        const lpBuffer = args[1] >>> 0;
        const bufferSize = readCoordFromMem(mem, args[2] >>> 0);
        const bufferCoord = readCoordFromMem(mem, args[3] >>> 0);
        const writeRegion = readSmallRectFromMem(mem, args[4] >>> 0);
        const ok = wide
            ? buf.writeOutputW(mem, lpBuffer, bufferSize, bufferCoord, writeRegion)
            : buf.writeOutputA(mem, lpBuffer, bufferSize, bufferCoord, writeRegion);
        System.getInstance().scheduler.setLastError(ok ? 0 : ERROR_NOACCESS);
        return ok ? 1 : 0;
    };
    exports['ReadConsoleOutputA'] = readConsoleOutput(false);
    exports['ReadConsoleOutputW'] = readConsoleOutput(true);
    exports['WriteConsoleOutputA'] = writeConsoleOutput(false);
    exports['WriteConsoleOutputW'] = writeConsoleOutput(true);
    const scrollConsoleScreenBuffer = (wide: boolean) => (ctx: unknown, mem: Uint8Array, args: number[]) => {
        void wide;
        const buf = resolveConsoleOutputBuffer(args[0]);
        const scrollRectPtr = args[1] >>> 0;
        const clipRectPtr = args[2] >>> 0;
        const destOrigin = readCoordFromMem(mem, args[3] >>> 0);
        const fillPtr = args[4] >>> 0;
        const scrollRect = scrollRectPtr ? readSmallRectFromMem(mem, scrollRectPtr) : null;
        const clipRect = clipRectPtr ? readSmallRectFromMem(mem, clipRectPtr) : null;
        let fillCh = 0x20;
        let fillAttr = 0x07;
        if (fillPtr && fillPtr + 4 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            fillCh = view.getUint16(fillPtr, true);
            fillAttr = view.getUint16(fillPtr + 2, true);
        }
        buf.scroll(scrollRect, clipRect, destOrigin, fillCh, fillAttr);
        return 1;
    };
    exports['ScrollConsoleScreenBufferA'] = scrollConsoleScreenBuffer(false);
    exports['ScrollConsoleScreenBufferW'] = scrollConsoleScreenBuffer(true);
    exports['CreateConsoleScreenBuffer'] = (ctx, mem, args) => {
        const { handle } = consoleScreenBuffers.createScreenBuffer(80, 25);
        System.getInstance().scheduler.setLastError(0);
        return handle >>> 0;
    };
    exports['WriteConsoleInputA'] = (ctx, mem, args) => {
        const lpWritten = args[3] >>> 0;
        if (lpWritten) Mem.writeUint32(lpWritten, 0);
        return 1;
    };

    exports['ReadConsoleInputA'] = (ctx, mem, args) => {
        const hConsoleInput = args[0];
        const lpBuffer = args[1] >>> 0;
        const nLength = args[2] >>> 0;
        const lpNumberOfEventsRead = args[3] >>> 0;

        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hConsoleInput);
        if (!fileHandle || !isConsoleDeviceHandle(fileHandle) || fileHandle.deviceType !== 'CONIN') {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }
        if (!lpNumberOfEventsRead) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0; // FALSE
        }
        if (nLength > 0 && (!lpBuffer || (lpBuffer + (INPUT_RECORD_SIZE * nLength) > mem.length))) {
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return 0; // FALSE
        }

        // No host keyboard queue wired into CONIN yet: report zero available records.
        if (!Mem.writeUint32(lpNumberOfEventsRead, 0)) {
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return 0; // FALSE
        }
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    exports['PeekConsoleInputA'] = (ctx, mem, args) => {
        const hConsoleInput = args[0];
        const lpBuffer = args[1] >>> 0;
        const nLength = args[2] >>> 0;
        const lpNumberOfEventsRead = args[3] >>> 0;

        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hConsoleInput);
        if (!fileHandle || !isConsoleDeviceHandle(fileHandle) || fileHandle.deviceType !== 'CONIN') {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }
        if (!lpNumberOfEventsRead) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0; // FALSE
        }
        if (nLength > 0 && (!lpBuffer || (lpBuffer + (INPUT_RECORD_SIZE * nLength) > mem.length))) {
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return 0; // FALSE
        }

        if (!Mem.writeUint32(lpNumberOfEventsRead, 0)) {
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return 0; // FALSE
        }
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    exports['GetNumberOfConsoleInputEvents'] = (ctx, mem, args) => {
        const hConsoleInput = args[0];
        const lpcNumberOfEvents = args[1] >>> 0;

        const fileHandle = System.getInstance().resourceProvider.getFileHandle(hConsoleInput);
        if (!fileHandle || !isConsoleDeviceHandle(fileHandle) || fileHandle.deviceType !== 'CONIN') {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
            return 0; // FALSE
        }
        if (!lpcNumberOfEvents) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0; // FALSE
        }

        // No host keyboard queue wired into CONIN yet: always report zero pending events.
        if (!Mem.writeUint32(lpcNumberOfEvents, 0)) {
            System.getInstance().scheduler.setLastError(ERROR_NOACCESS);
            return 0; // FALSE
        }
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    exports['WriteConsoleW'] = (ctx, mem, args) => {
        const hConsoleOutput = args[0];
        const lpBuffer = args[1];
        const nNumberOfCharsToWrite = args[2];
        const lpNumberOfCharsWritten = args[3];

        if (lpNumberOfCharsWritten) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpNumberOfCharsWritten, nNumberOfCharsToWrite, true);
        }
        return 1; // TRUE
    };

    exports['WriteConsoleA'] = (ctx, mem, args) => {
        const hConsoleOutput = args[0];
        const lpBuffer = args[1];
        const nNumberOfCharsToWrite = args[2];
        const lpNumberOfCharsWritten = args[3];

        if (lpNumberOfCharsWritten) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpNumberOfCharsWritten, nNumberOfCharsToWrite, true);
        }
        return 1; // TRUE
    };

    exports['GetConsoleOutputCP'] = (ctx, mem, args) => {
        return 65001; // UTF-8
    };

    exports['GetConsoleCP'] = (ctx, mem, args) => {
        return 65001; // UTF-8
    };

    // BOOL ReadConsoleA(HANDLE hConsoleInput, LPVOID lpBuffer, DWORD nNumberOfCharsToRead,
    //   LPDWORD lpNumberOfCharsRead, LPVOID lpReserved)
    // Stub — no console input in emulator, return 0 chars read
    exports['ReadConsoleA'] = (ctx, mem, args) => {
        const lpNumberOfCharsRead = args[3] >>> 0;
        if (lpNumberOfCharsRead) Mem.writeUint32(lpNumberOfCharsRead, 0);
        return 1;
    };
    exports['ReadConsoleW'] = exports['ReadConsoleA'];

    // SetConsoleCtrlHandler - add/remove console control handler
    exports['SetConsoleCtrlHandler'] = (ctx, mem, args) => {
        const handlerRoutine = args[0];
        const add = args[1];
        Logger.verbose(LogCategory.KERNEL32,
            `SetConsoleCtrlHandler(handler=0x${handlerRoutine.toString(16)}, add=${add})`);
        // Stub: always succeed (we don't actually handle Ctrl+C etc.)
        return 1; // TRUE
    };
}
