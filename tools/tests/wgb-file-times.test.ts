/**
 * A bundle can carry each file's write time from the packed directory to the guest: the
 * writer stamps a date the caller knows, the runtime ZIP reader returns it, and `wgb.ts`
 * rebuilds keep it. A title may refuse a data file whose date is not the one it shipped.
 * A file with no known date gets no stamp, so a bundle does not record when it was built.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BufferSource, ZipArchive, dosDateTimeToUnix, unixToDosDateTime, wallClockToInstant, instantToWallClock,
} from "@bottleship/formats/zip";
import { ZipStoreWriter } from "../internal/zip-store-writer";

/** 2001-10-05 12:07:22 wall clock — even seconds, which is all DOS time can hold. */
const SHIPPED = 1002283642;
/** Pinned so the host bias is known and non-zero: Tokyo is UTC+9 with no DST. */
const ZONE = "Asia/Tokyo";

const hostZone = process.env.TZ;
beforeAll(() => { process.env.TZ = ZONE; });
afterAll(() => {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
});

async function pack(add: (w: ZipStoreWriter, src: string) => void, mtime?: number): Promise<ZipArchive> {
    const dir = mkdtempSync(join(tmpdir(), "wgb-times-"));
    const src = join(dir, "mp_castle.map");
    writeFileSync(src, "map");
    if (mtime !== undefined) utimesSync(src, mtime, mtime);
    const out = join(dir, "t.wgb");
    const w = new ZipStoreWriter(out);
    w.addBuffer("manifest.json", Buffer.from("{}"));
    add(w, src);
    w.finish();
    const zip = new ZipArchive(new BufferSource(new Uint8Array(readFileSync(out))));
    await zip.init();
    return zip;
}

describe("DOS date/time", () => {
    test("round-trips an even-second reading through the packed stamp", () => {
        const stamp = unixToDosDateTime(SHIPPED);
        expect(stamp >>> 16).toBe(0x2b45);
        expect(stamp & 0xffff).toBe(0x60eb);
        expect(dosDateTimeToUnix(stamp >>> 16, stamp & 0xffff)).toBe(SHIPPED);
    });

    test("a zero date is no date, and pre-1980 instants have no stamp", () => {
        expect(dosDateTimeToUnix(0, 0)).toBeUndefined();
        expect(unixToDosDateTime(0)).toBe(0);
    });

    test("a day the month does not have is no date", () => {
        expect(dosDateTimeToUnix((21 << 9) | (2 << 5) | 30, 0)).toBeUndefined(); // 2001-02-30
        expect(dosDateTimeToUnix((20 << 9) | (2 << 5) | 29, 0)).toBe(Date.UTC(2000, 1, 29) / 1000);
    });

    test("a reading is an instant only against the host zone, and converts back exactly", () => {
        expect(wallClockToInstant(SHIPPED)).toBe(SHIPPED - 9 * 3600);
        expect(instantToWallClock(wallClockToInstant(SHIPPED))).toBe(SHIPPED);
    });
});

describe("bundle file times", () => {
    test("the writer stamps a known date and the runtime reader returns it", async () => {
        const zip = await pack((w, src) => w.addFile("rom/mp_castle.map", src, SHIPPED));
        expect(zip.getEntry("rom/mp_castle.map")?.modified).toBe(SHIPPED);
        expect(zip.getEntry("manifest.json")?.modified).toBeUndefined();
    });

    test("a file's mtime is not stamped unless the caller asks", async () => {
        const zip = await pack((w, src) => w.addFile("rom/mp_castle.map", src), wallClockToInstant(SHIPPED));
        expect(zip.getEntry("rom/mp_castle.map")?.modified).toBeUndefined();
    });

    test("an installer date restored on disk survives make-wgb --file-times", async () => {
        // installer-extract sets the mtime with wallClockToInstant; make-wgb reads it back.
        const zip = await pack((w, src) =>
            w.addFile("rom/mp_castle.map", src, instantToWallClock(statSync(src).mtimeMs / 1000)),
        wallClockToInstant(SHIPPED));
        expect(zip.getEntry("rom/mp_castle.map")?.modified).toBe(SHIPPED);
    });
});
