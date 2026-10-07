import type { SyncAccessHandleLike } from "@bottleship/formats/zip";

/** Bytes scanned from the tail for the EOCD record: 22-byte record + max 64K comment. */
const EOCD_SCAN_BYTES = 22 + 0xffff;
const EOCD_SIGNATURE = 0x06054b50;

/**
 * Does this file actually end in a ZIP end-of-central-directory record?
 *
 * The only checks the cache used to make were "non-empty" and "matches Content-Length",
 * and neither can tell a bundle from what a server hands back when something goes wrong:
 * an HTML error page is a perfectly well-formed 1.6 KB response, and once written under
 * the bundle's key it is served from cache forever, failing the loader with "EOCD not
 * found" on every later launch with no way for the user to know why. Reading the tail is
 * one seek and answers the question the loader is about to ask anyway — so a poisoned
 * entry is caught on write AND healed on read, including entries already on disk.
 */
export function hasZipEocd(sah: SyncAccessHandleLike, size: number): boolean {
    if (size < 22) return false;
    const scan = Math.min(size, EOCD_SCAN_BYTES);
    const buf = new Uint8Array(scan);
    const got = sah.read(buf, { at: size - scan });
    if (got < 22) return false;
    const view = new DataView(buf.buffer, buf.byteOffset, got);
    for (let i = got - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === EOCD_SIGNATURE) return true;
    }
    return false;
}
