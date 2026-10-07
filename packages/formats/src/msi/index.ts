/** Read MSI database tables; map cabinet File keys to the installed directory tree.
 * Does not execute custom actions or emulate the Windows Installer engine.
 * File/Component/Directory layouts: Microsoft Windows Installer table reference.
 */
import {readCompoundStreams} from './compound';
export {readCompoundStreams} from './compound';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';

export function decodeMsiStreamName(name: string): string {
    let out = '';
    for (const char of name) {
        const n = char.charCodeAt(0);
        if (n === 0x4840 && !out) continue; // table stream marker
        if (n >= 0x3800 && n < 0x4800) {
            out += ALPHABET[(n - 0x3800) & 63]! + ALPHABET[((n - 0x3800) >>> 6) & 63]!;
        } else if (n >= 0x4800 && n < 0x4840) out += ALPHABET[n - 0x4800];
        else out += char;
    }
    return out;
}

interface Column {name: string; type: number}
export type MsiRow = Record<string, string | number | null>;

export class MsiDatabase {
    readonly streams = new Map<string, Uint8Array>();
    private readonly strings: string[] = [''];
    private readonly columns = new Map<string, Column[]>();
    private readonly strWidth: number;

    constructor(bytes: Uint8Array) {
        for (const [name, data] of readCompoundStreams(bytes)) {
            const decoded = decodeMsiStreamName(name);
            if (this.streams.has(decoded)) throw new Error(`Duplicate MSI stream: ${decoded}`);
            this.streams.set(decoded, data);
        }
        const pool = this.requireStream('_StringPool');
        const data = this.requireStream('_StringData');
        if (pool.length < 4 || pool.length % 4) throw new Error('Invalid MSI string pool');
        const pv = new DataView(pool.buffer, pool.byteOffset, pool.byteLength);
        const flags = pv.getUint16(2, true);
        this.strWidth = flags & 0x8000 ? 3 : 2;
        const cp = pv.getUint16(0, true) + (flags & 0x7fff) * 65536;
        const decoder = new TextDecoder(cp === 65001 ? 'utf-8' : cp === 0 || cp === 1252 ? 'windows-1252' : `windows-${cp}`, {fatal: true});
        let offset = 0;
        for (let p = 4; p < pool.length; p += 4) {
            let size = pv.getUint16(p, true);
            const refs = pv.getUint16(p + 2, true);
            if (!size && !refs) {this.strings.push(''); continue;}
            if (!size) {
                if (p + 8 > pool.length) throw new Error('Truncated MSI long string');
                size = pv.getUint32(p + 4, true); p += 4;
            }
            if (offset + size > data.length) throw new Error('MSI string outside StringData');
            this.strings.push(decoder.decode(data.subarray(offset, offset + size))); offset += size;
        }
        if (offset !== data.length) throw new Error('MSI StringData has unmatched bytes');
        const metadata = this.readWithSchema('_Columns', [{name: 'Table', type: 0x800}, {name: 'Number', type: 2}, {name: 'Name', type: 0x800}, {name: 'Type', type: 2}]);
        const ordered = new Map<string, Map<number, Column>>();
        for (const row of metadata) {
            const table = row.Table as string; const position = row.Number as number;
            if (!table || position < 1 || !row.Name || typeof row.Type !== 'number') throw new Error('Invalid MSI column schema');
            let cols = ordered.get(table); if (!cols) {cols = new Map(); ordered.set(table, cols);}
            if (cols.has(position)) throw new Error('Duplicate MSI column ordinal');
            cols.set(position, {name: row.Name as string, type: row.Type});
        }
        for (const [table, cols] of ordered) {
            const schema: Column[] = [];
            for (let i = 1; i <= cols.size; i++) {const col = cols.get(i); if (!col) throw new Error('Non-contiguous MSI column ordinals'); schema.push(col);}
            this.columns.set(table, schema);
        }
    }
    private requireStream(name: string): Uint8Array {
        const data = this.streams.get(name); if (!data) throw new Error(`MSI stream missing: ${name}`); return data;
    }
    private readWithSchema(name: string, schema: Column[]): MsiRow[] {
        const data = this.streams.get(name); if (!data) return [];
        const widths = schema.map(c => c.type & 0x800 ? this.strWidth : (c.type & 255) <= 2 ? 2 : (c.type & 255) === 4 ? 4 : 0);
        if (widths.includes(0)) throw new Error(`Unsupported MSI column type in ${name}`);
        const rowSize = widths.reduce((sum, n) => sum + n, 0);
        if (!rowSize || data.length % rowSize) throw new Error(`Invalid MSI table size: ${name}`);
        const count = data.length / rowSize; const rows = Array.from({length: count}, () => ({} as MsiRow));
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength); let base = 0;
        for (let c = 0; c < schema.length; c++) {
            const width = widths[c]!; const col = schema[c]!;
            for (let r = 0; r < count; r++) {
                const off = base + r * width;
                const raw = width === 4 ? dv.getUint32(off, true) : width === 3 ? dv.getUint16(off, true) + data[off + 2]! * 65536 : dv.getUint16(off, true);
                let value: string | number | null = null;
                if (raw) {
                    if (col.type & 0x800) {if (raw >= this.strings.length) throw new Error(`MSI string reference out of range: ${raw}`); value = this.strings[raw]!;}
                    else value = raw - (width === 4 ? 0x80000000 : 0x8000);
                }
                rows[r]![col.name] = value;
            }
            base += width * count;
        }
        return rows;
    }
    table(name: string): MsiRow[] {
        const schema = this.columns.get(name); if (!schema) throw new Error(`MSI table schema missing: ${name}`);
        return this.readWithSchema(name, schema);
    }
}

export interface MsiFilePath {key: string; path: string; size: number; sequence: number}
function targetName(value: string): string {
    const target = value.split(':')[0]!;
    return target.includes('|') ? target.split('|')[1]! : target;
}
/** Resolve beneath an install directory, whose ancestors (ProgramFilesFolder etc.) are omitted. */
export function msiFilePaths(db: MsiDatabase, installDirectory: string): MsiFilePath[] {
    const dirs = new Map(db.table('Directory').map(row => [row.Directory as string, row]));
    const components = new Map(db.table('Component').map(row => [row.Component as string, row.Directory_ as string]));
    if (!dirs.has(installDirectory)) throw new Error(`MSI install directory missing: ${installDirectory}`);
    // INSTALLDIR can be an alias (DefaultDir='.') beneath the real target root.
    // Sibling components then resolve into the same physical installed directory.
    let rootDirectory = installDirectory;
    const aliases = new Set<string>();
    while (targetName(dirs.get(rootDirectory)!.DefaultDir as string) === '.') {
        if (aliases.has(rootDirectory)) throw new Error('Cyclic MSI Directory alias'); aliases.add(rootDirectory);
        const parent = dirs.get(rootDirectory)!.Directory_Parent;
        if (typeof parent !== 'string' || !dirs.has(parent)) throw new Error('Invalid MSI Directory alias');
        rootDirectory = parent;
    }
    const resolveDir = (id: string, visited = new Set<string>()): string | null => {
        if (id === rootDirectory) return '';
        if (visited.has(id)) throw new Error('Cyclic MSI Directory table'); visited.add(id);
        const row = dirs.get(id);
        if (!row) throw new Error(`MSI Directory row missing: ${id}`);
        if (!row.Directory_Parent) return null;
        const parent = resolveDir(row.Directory_Parent as string, visited);
        if (parent === null) return null;
        const leaf = targetName(row.DefaultDir as string);
        if (!leaf || leaf === '.') return parent;
        if (/[\\/]/.test(leaf) || leaf === '..') throw new Error(`Unsafe MSI directory name: ${leaf}`);
        return parent ? `${parent}/${leaf}` : leaf;
    };
    return db.table('File').flatMap(row => {
        const componentDir = components.get(row.Component_ as string);
        if (!componentDir) throw new Error(`MSI component missing for file ${row.File}`);
        const dir = resolveDir(componentDir);
        if (dir === null) return []; // system prerequisites are outside the chosen installed tree
        const filename = targetName(row.FileName as string);
        if (!filename || filename === '.' || filename === '..' || /[\\/]/.test(filename)) throw new Error('Unsafe MSI filename');
        if (typeof row.File !== 'string' || !row.File || typeof row.FileSize !== 'number' || row.FileSize < 0 || typeof row.Sequence !== 'number' || row.Sequence < 1) throw new Error('Invalid MSI File table');
        return [{key: row.File as string, path: dir ? `${dir}/${filename}` : filename, size: row.FileSize, sequence: row.Sequence}];
    });
}
