/** GetTempFileName: with uUnique 0 it creates the file (an empty, closed file the caller
 * then opens), with a nonzero uUnique it only formats the name.
 * https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettempfilenamea
 */
import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { ThreadState } from '../../core/scheduler/types';
import { decodeAnsiString, encodeAnsiString, isSingleByteCodePage } from '../../core/emulator-config-manager';
import { TimeService } from '../../runtime/time';
import { encodeUTF16LE, fileApiCodePage } from './file-io-strings';

class TempNameError extends Error {
    constructor(readonly code: number) { super(`GetTempFileName error ${code}`); }
}
function storageError(error: unknown): number {
    if (error instanceof TempNameError) return error.code;
    switch ((error as { name?: string })?.name) {
        case 'QuotaExceededError': return 112;
        case 'NotFoundError': return 3;
        case 'NotAllowedError': case 'SecurityError': case 'NoModificationAllowedError': return 5;
        case 'TypeMismatchError': return 183;
        default: return 1117;
    }
}

function temporaryFileName(wide: boolean): ThunkImplementation {
    return (_ctx, mem, args) => {
        const system = System.getInstance(), process = system.process, vfs = system.fileSystem;
        const scheduler = system.scheduler, issuer = scheduler.getCurrentThread();
        if (!process) { scheduler.setLastError(87); return 0; }
        const generation = process.resetGeneration, space = process.addressSpace;
        const setLastError = scheduler.captureLastError();
        const alive = () => system.process === process && process.resetGeneration === generation &&
            system.scheduler === scheduler && issuer?.state !== ThreadState.TERMINATED;
        const fail = (code: number): number => { if (alive()) setLastError(code); return 0; };
        const valid = (bytes: Uint8Array, pointer: number, size: number, permission: 'r' | 'w') =>
            Number.isInteger(pointer) && pointer > 0 && pointer + size <= bytes.length &&
            space.validateRange(pointer, size, permission);
        const [pathPointer, prefixPointer, uniqueArgument, outputPointer] = args.map(value => value >>> 0);
        const cp = fileApiCodePage();
        // The ANSI conversion has no DBCS tables; refuse rather than mangle the name.
        if (!wide && !isSingleByteCodePage(cp) && cp !== 65001) return fail(50);
        const read = (pointer: number, maximum: number, prefix: boolean): string => {
            if (!pointer) throw new TempNameError(87);
            let result = '';
            const utf8 = !wide && cp === 65001 ? new TextDecoder('utf-8') : null;
            for (let offset = 0; offset < maximum * (wide ? 2 : utf8 ? 4 : 1);) {
                const width = wide ? 2 : 1;
                if (!valid(mem, pointer + offset, width, 'r')) throw new TempNameError(87);
                const code = wide ? mem[pointer + offset] | (mem[pointer + offset + 1] << 8) : mem[pointer + offset];
                if (!code) return result + (utf8 ? utf8.decode() : '');
                result += wide ? String.fromCharCode(code) : utf8 ? utf8.decode(Uint8Array.of(code), { stream: true }) : decodeAnsiString(mem, pointer + offset, 1, cp);
                offset += width;
                if (result.length >= maximum) {
                    if (prefix) return result.slice(0, maximum);
                    throw new TempNameError(111);
                }
            }
            throw new TempNameError(111);
        };
        try {
            // Reading 247 characters permits exactly 246 plus its NUL.
            const path = read(pathPointer, 247, false), prefix = read(prefixPointer, 3, true);
            if (/[<>:"/\\|?*\x00-\x1f]/.test(prefix)) return fail(123);
            const directory = path.replace(/\//g, '\\');
            const stem = directory + (directory.endsWith('\\') ? '' : '\\') + prefix;
            const name = (value: number) => `${stem}${(value & 0xffff).toString(16).toUpperCase()}.tmp`;
            const encode = (text: string) => wide ? encodeUTF16LE(text) : encodeAnsiString(text + '\0', cp);
            const publish = (bytes: Uint8Array, result: number): number => {
                if (!alive()) return 0;
                const current = process.getCurrentMemory();
                if (!valid(current, outputPointer, bytes.length, 'w')) return fail(87);
                current.set(bytes, outputPointer);
                return result;
            };
            if (uniqueArgument) {
                const bytes = encode(name(uniqueArgument));
                if (bytes.length > 260 * (wide ? 2 : 1)) return fail(111);
                return publish(bytes, uniqueArgument);
            }
            if (!directory || !vfs.directoryExists(directory)) return fail(3);
            let unique = (Math.trunc(TimeService.getInstance().nowUnixMs()) & 0xffff) || 1;
            for (let attempt = 0; attempt < 0xffff; attempt++, unique = unique === 0xffff ? 1 : unique + 1) {
                const candidate = name(unique), bytes = encode(candidate);
                if (bytes.length > 260 * (wide ? 2 : 1)) return fail(111);
                if (!valid(mem, outputPointer, bytes.length, 'w')) return fail(87);
                // A directory with this name is a collision too; openSync alone
                // does not distinguish it from a new filename.
                if (vfs.directoryExists(candidate) || vfs.fileExists(candidate)) continue;
                const handle = vfs.openSync(candidate, 0x40000000, 1 /* CREATE_NEW */);
                if (!handle) {
                    const code = vfs.classifyOpenFailure(candidate, 1);
                    if (code === 80 || code === 183) continue;
                    return fail(code);
                }
                const result = unique;
                // openSync reserves the name before the first await, so concurrent calls
                // cannot pick the same one; flushFile commits the empty file.
                return vfs.flushFile(handle.path).then(() => {
                    if (!alive() || system.fileSystem !== vfs) return 0;
                    return publish(bytes, result);
                }, error => fail(storageError(error)));
            }
            return fail(80); // ERROR_FILE_EXISTS: the nonzero 16-bit namespace is full.
        } catch (error) { return fail(storageError(error)); }
    };
}

export function registerFileIoTempExports(exports: Record<string, ThunkImplementation>): void {
    exports.GetTempFileNameA = temporaryFileName(false);
    exports.GetTempFileNameW = temporaryFileName(true);
}
