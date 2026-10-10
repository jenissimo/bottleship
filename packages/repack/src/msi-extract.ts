import {MsiDatabase, msiFilePaths} from '@bottleship/formats/msi';
import {extractCabToMap, type CabInflateBlock} from '@bottleship/formats/cab';
import {Md5} from '@bottleship/formats/unpack';

/** Extract only a selected installed tree from MSI cabinets. No custom actions run. */
export async function extractMsiPayload(
    msi: Uint8Array,
    resolveCabinet: (name: string) => Uint8Array | null | Promise<Uint8Array | null>,
    options: {installDirectory?: string; inflateBlock?: CabInflateBlock; onProgress?: (done: number, total: number, name: string) => void} = {},
): Promise<Map<string, Uint8Array>> {
    const db = new MsiDatabase(msi);
    const paths = msiFilePaths(db, options.installDirectory ?? 'INSTALLDIR');
    if (!paths.length) throw new Error('MSI install directory has no payload files');
    const media = db.table('Media').sort((a, b) => Number(a.LastSequence) - Number(b.LastSequence));
    let lastSequence = 0;
    for (const row of media) {
        if (typeof row.LastSequence !== 'number' || !Number.isInteger(row.LastSequence) || row.LastSequence <= lastSequence) throw new Error('Invalid MSI Media sequence');
        lastSequence = row.LastSequence;
    }
    const hashes = new Map<string, Uint8Array>();
    if (db.streams.has('MsiFileHash')) {
        for (const row of db.table('MsiFileHash')) {
            if (typeof row.File_ !== 'string' || !row.File_ || row.Options !== 0 || hashes.has(row.File_)) throw new Error('Invalid MSI file hash row');
            const digest = new Uint8Array(16); const dv = new DataView(digest.buffer);
            for (let i = 0; i < 4; i++) {
                const value = row[`HashPart${i + 1}`];
                if (typeof value !== 'number') throw new Error('Invalid MSI file hash');
                dv.setUint32(i * 4, value >>> 0, true);
            }
            hashes.set(row.File_ as string, digest);
        }
    }
    const cabinets = new Map<string, Map<string, Uint8Array>>();
    const out = new Map<string, Uint8Array>(); const installedNames = new Set<string>();
    for (const file of paths) {
        const medium = media.find(m => Number(m.LastSequence) >= file.sequence);
        if (!medium || typeof medium.Cabinet !== 'string' || !medium.Cabinet) throw new Error(`MSI file needs unsupported loose media: ${file.key}`);
        const name = medium.Cabinet;
        let contents = cabinets.get(name);
        if (!contents) {
            const data = name.startsWith('#') ? db.streams.get(name.slice(1)) : await resolveCabinet(name);
            if (!data) throw new Error(`MSI cabinet missing: ${name}`);
            const extracted = await extractCabToMap(data, {inflateBlock: options.inflateBlock});
            contents = new Map();
            for (const [key, bytes] of extracted) {
                const lower = key.toLowerCase();
                if (contents.has(lower)) throw new Error(`Duplicate MSI cabinet file key: ${key}`);
                contents.set(lower, bytes);
            }
            cabinets.set(name, contents);
        }
        const bytes = contents.get(file.key.toLowerCase());
        if (!bytes || bytes.length !== file.size) throw new Error(`MSI cabinet size mismatch or missing file: ${file.key}`);
        const expected = hashes.get(file.key);
        if (expected) {
            // MsiGetFileHash returns four zero DWORDs for a zero-byte file.
            const md5 = new Md5(); md5.update(bytes);
            const actual = bytes.length ? md5.finalize() : new Uint8Array(16);
            if (!actual.every((byte, i) => byte === expected[i])) throw new Error(`MSI file checksum mismatch: ${file.path}`);
        }
        const lower = file.path.toLowerCase();
        if (installedNames.has(lower)) throw new Error(`Duplicate MSI installed path: ${file.path}`);
        installedNames.add(lower); out.set(file.path, bytes);
        options.onProgress?.(out.size, paths.length, file.path);
    }
    return out;
}
