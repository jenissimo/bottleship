/**
 * NSIS 2 ANSI/non-solid zlib payload reader, without executing installer code.
 * Reference: nsis-dev/nsis v246 Source/exehead/{fileform.h,exec.c,util.c}
 * and Source/zlib/trees.c. Solid, Unicode, other codecs, and conditional file
 * sections are deliberately rejected. Installer plugins/custom actions do not run.
 */
import type {RandomAccessSource} from '../unpack/source';
import {Crc32} from '../unpack/checksums';
import {inflateNsisSync} from '../zip/inflate';

export interface NsisFile {path: string; dataOffset: number}
export interface NsisArchive {
    files: NsisFile[];
    directories: string[];
    dataStart: number;
    dataEnd: number;
}
const ROOT = '$INSTDIR';
const MAX_HEADER = 16 * 1024 * 1024;
const MAX_FILE = 512 * 1024 * 1024;

function range(source: RandomAccessSource, start: number, length: number): Uint8Array {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > source.size) throw new Error('Truncated NSIS data');
    const bytes = source.readRangeSync(start, start + length);
    if (bytes.length !== length) throw new Error('Truncated NSIS data');
    return bytes;
}
function view(bytes: Uint8Array): DataView {return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)}

/** NSIS scans its stub in 512-byte blocks, so signatures in code are ignored. */
export function findNsis(source: RandomAccessSource): number | null {
    const bytes = range(source, 0, Math.min(source.size, MAX_HEADER));
    const dv = view(bytes);
    for (let p = 512; p + 28 <= bytes.length; p += 512) {
        if (dv.getUint32(p + 4, true) === 0xdeadbeef && dv.getUint32(p + 8, true) === 0x6c6c754e && dv.getUint32(p + 12, true) === 0x74666f73 && dv.getUint32(p + 16, true) === 0x74736e49) return p;
    }
    return null;
}

function decode(payload: Uint8Array, limit: number, expected?: number): Uint8Array {
    let capacity = expected ?? Math.min(limit, Math.max(65536, payload.length * 2));
    for (;;) {
        const out = new Uint8Array(capacity);
        const result = inflateNsisSync(payload, out);
        if (result.status === 'ok') {
            if (result.consumed !== payload.length || (expected !== undefined && result.written !== expected)) throw new Error('NSIS payload size mismatch');
            return out.subarray(0, result.written);
        }
        if (result.status !== 'output-full' || capacity === limit || expected !== undefined) throw new Error(`Unsupported or corrupt NSIS zlib stream: ${result.message}`);
        capacity = Math.min(limit, capacity * 2);
    }
}

function relativePath(path: string): string | null {
    path = path.replace(/\\/g, '/');
    if (path !== ROOT && !path.startsWith(ROOT + '/')) return null;
    const parts = path.slice(ROOT.length).split('/').filter(p => p !== '' && p !== '.');
    if (parts.some(p => p === '..' || /[:\x00-\x1f]/.test(p))) throw new Error(`Unsafe NSIS path: ${path}`);
    return parts.join('/');
}

export function parseNsis(source: RandomAccessSource): NsisArchive {
    const offset = findNsis(source);
    if (offset === null) throw new Error('No NSIS firstheader found');
    const first = view(range(source, offset, 32));
    const flags = first.getUint32(0, true), headerSize = first.getUint32(20, true);
    const archiveEnd = offset + first.getUint32(24, true);
    if (flags & ~15 || headerSize < 68 || headerSize > MAX_HEADER || archiveEnd > source.size || archiveEnd < offset + 32) throw new Error('Invalid NSIS firstheader');
    const hasCrc = !(flags & 4) || !!(flags & 8);
    const dataEnd = archiveEnd - (hasCrc ? 4 : 0);
    if (hasCrc) {
        const crc = new Crc32();
        for (let p = 512; p < dataEnd; p += 1048576) crc.update(range(source, p, Math.min(1048576, dataEnd - p)));
        if (crc.finalize() !== view(range(source, dataEnd, 4)).getUint32(0, true)) throw new Error('NSIS installer CRC mismatch');
    }
    const stored = first.getUint32(28, true), length = stored & 0x7fffffff;
    const dataStart = offset + 32 + length;
    if (dataStart > dataEnd || length > MAX_HEADER) throw new Error('Unsupported NSIS solid header');
    const payload = range(source, offset + 32, length);
    const header = stored >>> 31 ? decode(payload, MAX_HEADER, headerSize) : payload;
    if (header.length !== headerSize) throw new Error('NSIS header size mismatch');
    const dv = view(header);
    const sections = dv.getUint32(12, true), sectionCount = dv.getUint32(16, true);
    const entries = dv.getUint32(20, true), entryCount = dv.getUint32(24, true);
    const strings = dv.getUint32(28, true), stringsEnd = dv.getUint32(36, true);
    if (sections < 68 || sectionCount > 65536 || sections + sectionCount * 1048 > entries || entries + entryCount * 28 > strings || strings >= stringsEnd || stringsEnd > header.length) throw new Error('Unsupported NSIS header layout (requires ANSI NSIS 2)');
    if (strings + 1 >= stringsEnd || dv.getUint16(strings, true) === 0) throw new Error('Unicode NSIS strings are unsupported');
    const files: NsisFile[] = [], directories = new Set<string>();
    for (let s = 0; s < sectionCount; s++) {
        const section = sections + s * 1048;
        const start = dv.getUint32(section + 12, true), count = dv.getUint32(section + 16, true);
        if (start + count > entryCount) throw new Error('NSIS section outside instruction table');
        const vars = new Map<number, string>([[21, ROOT]]);
        let output = ROOT;
        const string = (index: number): string => {
            if (index < 0) return `$UNRESOLVEDLANG${index}`;
            if (strings + index >= stringsEnd) throw new Error('Unsupported NSIS path string');
            let text = '', p = strings + index;
            for (; p < stringsEnd; p++) {
                const b = header[p];
                if (b === 0) return text;
                if (b === 252) {if (++p >= stringsEnd) break; text += String.fromCharCode(header[p]);}
                else if (b === 253) {
                    if (p + 2 >= stringsEnd) break;
                    const v = (header[p + 1] & 127) | ((header[p + 2] & 127) << 7); p += 2;
                    text += v === 22 ? output : vars.get(v) ?? `$UNRESOLVED${v}`;
                } else if (b >= 254) {
                    if (p + 2 >= stringsEnd) break;
                    text += `$UNRESOLVED${b}_${header[p + 1]}_${header[p + 2]}`; p += 2;
                }
                else text += String.fromCharCode(b);
            }
            throw new Error('Unterminated NSIS string');
        };
        const sectionFiles: NsisFile[] = [];
        let conditional = false;
        for (let i = start; i < start + count; i++) {
            const p = entries + i * 28, op = dv.getUint32(p, true);
            const a = (n: number) => dv.getInt32(p + 4 + n * 4, true);
            if ([2, 5, 12, 14, 26, 28].includes(op)) conditional = true;
            if (op === 11 && a(1)) output = string(a(0)); // SetOutPath
            if (op === 25) vars.set(a(0), a(2) || a(3) ? `$UNRESOLVED${a(0)}` : string(a(1)));
            if (op === 11) {const path = relativePath(string(a(0))); if (path) directories.add(path);}
            if (op === 20) {
                const name = string(a(1));
                const full = name.startsWith('$') || /^[A-Za-z]:/.test(name) || name.startsWith('\\') ? name : output + '/' + name;
                if (full.includes('$UNRESOLVED')) throw new Error('NSIS payload path depends on dynamic variables');
                const path = relativePath(full);
                if (path === '') throw new Error('NSIS file has an empty path');
                if (path !== null) {
                    if (conditional) throw new Error('Conditional NSIS file section requires installer interpretation');
                    sectionFiles.push({path, dataOffset: a(2)});
                }
            }
        }
        files.push(...sectionFiles);
    }
    const unique = new Map<string, NsisFile>();
    for (const file of files) {
        const key = file.path.toLowerCase(), old = unique.get(key);
        if (old && old.dataOffset !== file.dataOffset) throw new Error(`Ambiguous NSIS payload: ${file.path}`);
        unique.set(key, file);
    }
    if (!unique.size) throw new Error('NSIS installer has no static files below $INSTDIR');
    return {files: [...unique.values()], directories: [...directories], dataStart, dataEnd};
}

/** Extract one independent block, so callers can write and release it immediately. */
export function extractNsisFile(source: RandomAccessSource, archive: NsisArchive, file: NsisFile): Uint8Array {
    const offset = archive.dataStart + file.dataOffset;
    if (file.dataOffset < 0 || offset + 4 > archive.dataEnd) throw new Error('NSIS file block outside archive');
    const stored = view(range(source, offset, 4)).getUint32(0, true), size = stored & 0x7fffffff;
    if (size > MAX_FILE || offset + 4 + size > archive.dataEnd) throw new Error('NSIS file block outside archive or size limit');
    const payload = range(source, offset + 4, size);
    return stored >>> 31 ? decode(payload, MAX_FILE) : payload;
}
