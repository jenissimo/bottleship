/**
 * MS-DOS packed date/time (ZIP headers, InstallShield and CAB file records):
 * date = (year-1980)<<9 | month<<5 | day, time = hour<<11 | minute<<5 | second/2.
 *
 * A stamp is a LOCAL wall-clock reading with no zone. We carry it as "wall-clock
 * seconds": the reading laid on the Unix scale as if it were UTC, so a stamp survives
 * a write/read round trip exactly on any host. It becomes an instant only against a
 * zone — the host's for a file on disk (wallClockToInstant), the guest's for what
 * Win32 reports (runtime/filesystem/file-time.ts).
 */

/** Wall-clock seconds, or undefined for the "no date" stamp (date 0) or an impossible one. */
export function dosDateTimeToUnix(date: number, time: number): number | undefined {
    const day = date & 0x1f, month = (date >> 5) & 0xf, year = 1980 + (date >> 9);
    const hour = time >> 11, minute = (time >> 5) & 0x3f, second = (time & 0x1f) * 2;
    if (!day || !month || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    if (new Date(ms).getUTCDate() !== day) return undefined; // Feb 30th and friends
    return ms / 1000;
}

/** `date << 16 | time` for wall-clock seconds, or 0 when DOS cannot hold it (before 1980 / after 2107). */
export function unixToDosDateTime(seconds: number): number {
    const d = new Date(Math.floor(seconds) * 1000);
    const year = d.getUTCFullYear();
    if (!Number.isFinite(seconds) || year < 1980 || year > 2107) return 0;
    const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    return ((date << 16) | time) >>> 0;
}

/** The Unix instant at which the host's local clock reads `wall`. */
export function wallClockToInstant(wall: number): number {
    const d = new Date(wall * 1000);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime() / 1000;
}

/** What the host's local clock read at the Unix instant `seconds`, as wall-clock seconds. */
export function instantToWallClock(seconds: number): number {
    const d = new Date(Math.floor(seconds) * 1000);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
        d.getHours(), d.getMinutes(), d.getSeconds()) / 1000;
}
