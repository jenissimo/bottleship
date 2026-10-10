import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { VFS_FILETIME } from '../../runtime/filesystem/file-time';
import { readStringA, readStringW } from './file-io-strings';

export function registerFileIoAttributeExports(exports: Record<string, ThunkImplementation>): void {
    const getAttributes = (mem: Uint8Array, name: string | null, level: number, output: number): number => {
        const system = System.getInstance();
        const fail = (error: number) => { system.scheduler.setLastError(error); return 0; };
        if (name === null || level !== 0) return fail(87); // ERROR_INVALID_PARAMETER
        if (!name || /[*?]/.test(name.replace(/^\\\\\?\\/, ''))) return fail(123); // ERROR_INVALID_NAME
        if (!output || !isValidAddress(mem, output, 36, 'rw')) return fail(998); // ERROR_NOACCESS
        const vfs = system.fileSystem;
        const path = vfs.resolvePath(name);
        const entry = vfs.statEntry(path);
        if (!entry) {
            const cut = path.lastIndexOf('\\');
            const parent = cut > 2 ? path.slice(0, cut) : path.slice(0, 3);
            return fail(vfs.directoryExists(parent) ? 2 : 3);
        }
        const size = entry.kind === 'dir' ? 0 : entry.size;
        Mem.writeUint32(output, entry.kind === 'dir' ? 0x10 : 0x20);
        // Keep every VFS metadata API on the same timestamp until storage records per-file times.
        for (let offset = 4; offset < 28; offset += 8) {
            Mem.writeUint32(output + offset, Number(VFS_FILETIME & 0xffffffffn));
            Mem.writeUint32(output + offset + 4, Number(VFS_FILETIME >> 32n));
        }
        Mem.writeUint32(output + 28, Math.floor(size / 0x100000000));
        Mem.writeUint32(output + 32, size >>> 0);
        return 1;
    };
    exports['GetFileAttributesExA'] = (_ctx, mem, args) => getAttributes(mem,
        args[0] ? readStringA(mem, args[0]) : null, args[1] >>> 0, args[2] >>> 0);
    exports['GetFileAttributesExW'] = (_ctx, mem, args) => getAttributes(mem,
        args[0] ? readStringW(mem, args[0]) : null, args[1] >>> 0, args[2] >>> 0);
}
