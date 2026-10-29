import { payloadPath, peCertificateTable, peOverlay } from '../installer/binary';

/**
 * InstallShield 7's single-file "setup launcher": the disk image (data1.hdr, data{N}.cab,
 * setup.inx, …) appended to a PE stub as consecutive plain records —
 * `name\0 path\0 version\0 decimal-size\0` followed by that many raw bytes, to the end of
 * the overlay (EOF, or the Authenticode signature of a signed launcher).
 * Later launchers (ISSetupStream) obfuscate the records and are not this format.
 */
export interface InstallShieldLauncherEntry { name: string; path: string; version: string; offset: number; size: number; }

const MAX_FIELD = 512;

function field(bytes: Uint8Array, pos: number, limit: number): [string, number] | null {
    const end = bytes.subarray(pos, Math.min(limit, pos + MAX_FIELD + 1)).indexOf(0);
    if (end < 0) return null;
    let s = '';
    for (let i = pos; i < pos + end; i++) {
        const c = bytes[i]!;
        if (c < 0x20 || c > 0x7e) return null;
        s += String.fromCharCode(c);
    }
    return [s, pos + end + 1];
}

/**
 * The record chain, or null unless it parses cleanly and ends exactly at the overlay's end.
 * Only the record headers are read; the payloads are skipped by their declared size.
 */
export function parseInstallShieldLauncher(bytes: Uint8Array): InstallShieldLauncherEntry[] | null {
    let start: number | null;
    try { start = peOverlay(bytes); } catch { return null; }
    if (start == null || start >= bytes.length) return null;
    const cert = peCertificateTable(bytes);
    const end = cert && cert.offset >= start ? cert.offset : bytes.length;
    const entries: InstallShieldLauncherEntry[] = [];
    let pos = start;
    while (pos < end) {
        const name = field(bytes, pos, end); if (!name || !name[0]) return null;
        const path = field(bytes, name[1], end); if (!path || !path[0]) return null;
        const version = field(bytes, path[1], end); if (!version) return null;
        const size = field(bytes, version[1], end); if (!size || !/^\d+$/.test(size[0])) return null;
        const n = Number(size[0]);
        if (size[1] + n > end) return null;
        entries.push({ name: name[0], path: path[0], version: version[0], offset: size[1], size: n });
        pos = size[1] + n;
    }
    return entries.length ? entries : null;
}

export function isInstallShieldLauncher(bytes: Uint8Array): boolean {
    return parseInstallShieldLauncher(bytes)?.some(e => /1\.hdr$/i.test(e.name)) ?? false;
}

/** Files keyed by their disk path (`Disk1/data1.hdr`); the bytes are views into the input. */
export function extractInstallShieldLauncher(bytes: Uint8Array): Map<string, Uint8Array> {
    const entries = parseInstallShieldLauncher(bytes);
    if (!entries) throw new Error('Not an InstallShield setup launcher');
    const files = new Map<string, Uint8Array>();
    for (const e of entries) files.set(payloadPath(e.path), bytes.subarray(e.offset, e.offset + e.size));
    return files;
}
