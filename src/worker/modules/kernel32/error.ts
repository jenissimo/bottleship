/**
 * Kernel32 Error functions
 *
 * Atomic implementation for error handling
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { encodeAnsi } from '../codepage-utils';
import { expandMessage, FORMAT_MESSAGE_MAX_WIDTH_MASK } from './format-message';

export const exports: Record<string, ThunkImplementation> = (() => {
    const exports: Record<string, ThunkImplementation> = {};
    const FORMAT_MESSAGE_ALLOCATE_BUFFER = 0x00000100;
    const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
    const FORMAT_MESSAGE_FROM_STRING = 0x00000400;
    const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
    const FORMAT_MESSAGE_ARGUMENT_ARRAY = 0x00002000;

    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_INSUFFICIENT_BUFFER = 122;

    const systemMessages: Record<number, string> = {
        0: 'The operation completed successfully.',
        1: 'Incorrect function.',
        2: 'The system cannot find the file specified.',
        3: 'The system cannot find the path specified.',
        5: 'Access is denied.',
        6: 'The handle is invalid.',
        50: 'The request is not supported.',
        87: 'The parameter is incorrect.',
        111: 'The file name is too long.',
        122: 'The data area passed to a system call is too small.',
        259: 'No more data is available.',
        267: 'The directory name is invalid.',
    };

    const resolveFormatMessageText = (dwFlags: number, lpSource: number, dwMessageId: number, mem: Uint8Array, wide: boolean): string => {
        const readSource = () => wide ? Marshaler.readStringW(mem, lpSource) : Marshaler.readString(mem, lpSource);
        if (dwFlags & FORMAT_MESSAGE_FROM_STRING) {
            return lpSource ? readSource() : '';
        }

        if (dwFlags & FORMAT_MESSAGE_FROM_SYSTEM) {
            return systemMessages[dwMessageId] ?? `Unknown error (0x${dwMessageId.toString(16)})`;
        }

        return lpSource ? readSource() : (systemMessages[dwMessageId] ?? '');
    };

    const writeWide = (dest: number, text: string): number => {
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < text.length; i++) {
            view.setUint16(i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(text.length * 2, 0, true);
        return Mem.writeBytes(dest, bytes);
    };

    exports['GetLastError'] = (ctx, mem, args) => {
        const lastError = System.getInstance().scheduler.getLastError();
        Logger.verbose(LogCategory.KERNEL32, `GetLastError() -> ${lastError}`);
        return lastError;
    };

    exports['SetLastError'] = (ctx, mem, args) => {
        const dwErrCode = args[0];
        System.getInstance().scheduler.setLastError(dwErrCode);
        Logger.verbose(LogCategory.KERNEL32, `SetLastError(${dwErrCode})`);
        return 0; // Thunks must return a value
    };

    // SetErrorMode - Set how the system handles serious errors
    // Returns the previous error mode
    exports['SetErrorMode'] = (ctx, mem, args) => {
        const uMode = args[0];
        Logger.log(LogCategory.KERNEL32, `SetErrorMode(0x${uMode.toString(16)}) called`);
        // Return 0 (previous mode was default) - no-op for emulation
        return 0;
    };

    // DWORD FormatMessage{A,W}(dwFlags, lpSource, dwMessageId, dwLanguageId, lpBuffer, nSize, Arguments)
    const formatMessage = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const lpSource = args[1] >>> 0;
        const dwMessageId = args[2] >>> 0;
        const dwLanguageId = args[3] >>> 0;
        const lpBufferArg = args[4] >>> 0;
        const nSize = args[5] >>> 0;
        const argumentsPtr = args[6] >>> 0;
        const api = wide ? 'FormatMessageW' : 'FormatMessageA';

        const template = resolveFormatMessageText(dwFlags, lpSource, dwMessageId, mem, wide);
        // Arguments is a DWORD_PTR array under ARGUMENT_ARRAY, otherwise a va_list*; on
        // x86 both are runs of 32-bit slots, the va_list one level further away.
        const slotBase = !argumentsPtr ? 0
            : (dwFlags & FORMAT_MESSAGE_ARGUMENT_ARRAY) ? argumentsPtr
            : (Mem.readUint32(argumentsPtr) ?? 0);
        const text = template ? expandMessage(template, {
            ignoreInserts: (dwFlags & FORMAT_MESSAGE_IGNORE_INSERTS) !== 0,
            maxWidth: dwFlags & FORMAT_MESSAGE_MAX_WIDTH_MASK,
        }, slotBase ? {
            readSlot: (index) => Mem.readUint32(slotBase + index * 4) ?? 0,
            readCString: (addr) => Marshaler.readString(mem, addr),
            readWString: (addr) => Marshaler.readStringW(mem, addr),
            wide,
        } : null) : null;
        if (!text) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const encoded = wide ? null : encodeAnsi(`${text}\0`);
        const charCount = encoded ? encoded.length - 1 : text.length;
        const byteSize = encoded ? encoded.length : (text.length + 1) * 2;
        const isAllocate = (dwFlags & FORMAT_MESSAGE_ALLOCATE_BUFFER) !== 0;
        let targetPtr = lpBufferArg;

        if (isAllocate) {
            targetPtr = System.getInstance().process?.memory.alloc(byteSize) ?? 0;
            if (!targetPtr) {
                System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }
            if (!lpBufferArg || !Mem.writeUint32(lpBufferArg, targetPtr)) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
        } else {
            if (!targetPtr || nSize === 0) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            if (charCount + 1 > nSize) {
                System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }
        }

        const written = encoded ? Mem.writeBytes(targetPtr, encoded) : writeWide(targetPtr, text);
        if (written <= 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        Logger.verbose(
            LogCategory.KERNEL32,
            `${api}(flags=0x${dwFlags.toString(16)}, msgId=${dwMessageId}, lang=${dwLanguageId}, args=0x${argumentsPtr.toString(16)}) -> ${charCount}`
        );

        return charCount;
    };

    exports['FormatMessageA'] = formatMessage(false);
    exports['FormatMessageW'] = formatMessage(true);

    exports['OutputDebugStringA'] = (ctx, mem, args) => {
        const lpOutputString = args[0] >>> 0;
        const text = lpOutputString ? Marshaler.readString(mem, lpOutputString) : '';
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const callerRet = (ctx?.esp && ctx.esp >= 0 && ctx.esp + 4 <= mem.length)
            ? view.getUint32(ctx.esp, true) >>> 0
            : 0;
        Logger.warn(LogCategory.KERNEL32, `OutputDebugStringA(ret=0x${callerRet.toString(16)}): "${text}"`);
        return 0;
    };

    exports['OutputDebugStringW'] = (ctx, mem, args) => {
        const lpOutputString = args[0] >>> 0;
        const text = lpOutputString ? Marshaler.readStringW(mem, lpOutputString) : '';
        Logger.warn(LogCategory.KERNEL32, `OutputDebugStringW: "${text}"`);
        return 0;
    };

    return exports;
})();
