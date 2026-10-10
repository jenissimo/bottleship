/**
 * iso-to-wgb gives D: the label of the disc it stands in for. readVolumeLabel reads that label
 * by the rules of Wine's mount manager, discLabelForCdPath decides which disc D: is, and the
 * CLI test packs a synthetic ISO and reads the manifest it wrote.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { discLabelForCdPath } from "@bottleship/repack/disc-label";
import { IsoImage, LAYOUT_ISO, readVolumeLabel } from "@bottleship/formats/iso";
import { BufferSource } from "@bottleship/formats/unpack/source";

/** Volume descriptors only: [sector, type, label bytes, joliet escape?]; 255 terminates. */
function descriptors(...vds: Array<[number, number, Uint8Array, boolean?]>): IsoImage {
    const img = new Uint8Array(24 * 2048);
    for (const [sector, type, label, joliet] of vds) {
        const o = sector * 2048;
        img[o] = type; img.set(new TextEncoder().encode("CD001"), o + 1); img[o + 6] = 1;
        for (let i = 40; i < 72; i++) img[o + i] = joliet && i % 2 === 0 ? 0 : 0x20;
        img.set(label.subarray(0, 32), o + 40);
        if (joliet) img.set([0x25, 0x2f, 0x45], o + 88);
    }
    return new IsoImage(new BufferSource(img), LAYOUT_ISO);
}
const a = (s: string) => new TextEncoder().encode(s);
const w = (s: string) => Uint8Array.from([...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]));
const end = (sector: number): [number, number, Uint8Array] => [sector, 255, new Uint8Array(0)];

describe("readVolumeLabel (Wine mountmgr rules)", () => {
    test("the primary descriptor alone: its 32-byte label, trailing spaces dropped", () => {
        expect(readVolumeLabel(descriptors([16, 1, a("BFN_PC")], end(17)))).toBe("BFN_PC");
    });

    test("a Joliet supplementary descriptor outranks the primary and is read as UCS-2", () => {
        expect(readVolumeLabel(descriptors([16, 1, a("PRIMARY")], [17, 2, w("Joliet Label"), true], end(18)))).toBe("Joliet Label");
        expect(readVolumeLabel(descriptors([16, 2, w("Joliet First"), true], [17, 1, a("PRIMARY")], end(18)))).toBe("Joliet First");
    });

    test("a supplementary without the Joliet escape still outranks, read single-byte", () => {
        expect(readVolumeLabel(descriptors([16, 1, a("PRIMARY")], [17, 2, a("SUPPLEMENTARY")], end(18)))).toBe("SUPPLEMENTARY");
    });

    test("on a tie the first descriptor of the highest type wins", () => {
        expect(readVolumeLabel(descriptors([16, 1, a("P")], [17, 2, a("FIRST")], [18, 2, w("Second"), true], end(19)))).toBe("FIRST");
    });

    test("only sectors 16..19 are scanned, and the terminator ends the scan", () => {
        expect(readVolumeLabel(descriptors([16, 1, a("P")], [17, 0, a("BOOT")], [18, 0, a("BOOT")], [19, 0, a("BOOT")],
            [20, 2, w("Too Late"), true], end(21)))).toBe("P");
        expect(readVolumeLabel(descriptors([16, 1, a("P")], end(17), [18, 2, w("After End"), true]))).toBe("P");
    });

    test("only trailing spaces go; leading and inner spaces stay, and a NUL ends the label", () => {
        expect(readVolumeLabel(descriptors([16, 1, a("  MY DISC  ")], end(17)))).toBe("  MY DISC");
        expect(readVolumeLabel(descriptors([16, 1, a("ABC\0XYZ")], end(17)))).toBe("ABC");
    });

    test("a disc with no CD001 descriptor has no label", () => {
        expect(readVolumeLabel(new IsoImage(new BufferSource(new Uint8Array(24 * 2048)), LAYOUT_ISO))).toBe("");
    });
});

describe("discLabelForCdPath", () => {
    test("a single disc packs at C:\\, so that is the only path that is the disc", () => {
        for (const p of ["C:\\", "C:", "c:\\", " C:\\\\ ", "C:/"]) expect(discLabelForCdPath(p, ["BFN_PC"], false)).toBe("BFN_PC");
        for (const p of ["C:\\GAME", "D:\\", "C:\\disc1"]) expect(discLabelForCdPath(p, ["BFN_PC"], false)).toBeUndefined();
    });

    test("with --disc-dirs, C:\\discN is disc N and C:\\ is no disc", () => {
        const labels = ["GAME_DISC1", "GAME_DISC2"];
        expect(discLabelForCdPath("C:\\disc1", labels, true)).toBe("GAME_DISC1");
        expect(discLabelForCdPath("c:\\DISC2\\", labels, true)).toBe("GAME_DISC2");
        for (const p of ["C:\\", "C:\\disc3", "C:\\disc0", "C:\\disc1\\data"]) expect(discLabelForCdPath(p, labels, true)).toBeUndefined();
    });

    test("the disc's label passes through as read, and an empty one gives no label", () => {
        expect(discLabelForCdPath("C:\\", ["  MY DISC"], false)).toBe("  MY DISC");
        expect(discLabelForCdPath("C:\\", [""], false)).toBeUndefined();
    });
});

// --- CLI: a one-file ISO9660 image with a primary and a Joliet volume descriptor -------------

const SECTOR = 2048;

function isoWithLabel(primaryLabel: string, jolietLabel: string | null): Uint8Array {
    const exe = new TextEncoder().encode("MZ");
    const ROOT = 20, JROOT = 21, FILE = 22;
    const img = new Uint8Array((FILE + 1) * SECTOR);
    const record = (name: Uint8Array, lba: number, size: number, dir: boolean): Uint8Array => {
        const len = (33 + name.length + 1) & ~1;
        const r = new Uint8Array(len), v = new DataView(r.buffer);
        r[0] = len;
        v.setUint32(2, lba, true); v.setUint32(6, lba, false);
        v.setUint32(10, size, true); v.setUint32(14, size, false);
        r[25] = dir ? 2 : 0; r[32] = name.length; r.set(name, 33);
        return r;
    };
    const utf16be = (s: string) => Uint8Array.from([...s].flatMap((c) => [0, c.charCodeAt(0)]));
    const dir = (at: number, self: number, name: Uint8Array) => {
        let p = at * SECTOR;
        for (const r of [record(Uint8Array.of(0), self, SECTOR, true), record(Uint8Array.of(1), self, SECTOR, true),
            record(name, FILE, exe.length, false)]) { img.set(r, p); p += r.length; }
    };
    const descriptor = (at: number, type: number, label: Uint8Array, root: number, joliet: boolean) => {
        const o = at * SECTOR;
        img[o] = type; img.set(new TextEncoder().encode("CD001"), o + 1); img[o + 6] = 1;
        // Space-padded: one byte per space on the primary, UCS-2 (00 20) on Joliet.
        for (let i = 40; i < 72; i++) img[o + i] = joliet && i % 2 === 0 ? 0 : 0x20;
        img.set(label.subarray(0, 32), o + 40);
        if (joliet) img.set([0x25, 0x2f, 0x45], o + 88);
        img.set(record(Uint8Array.of(0), root, SECTOR, true), o + 156);
    };
    descriptor(16, 1, new TextEncoder().encode(primaryLabel), ROOT, false);
    let next = 17;
    if (jolietLabel !== null) descriptor(next++, 2, utf16be(jolietLabel), JROOT, true);
    img[next * SECTOR] = 255; img.set(new TextEncoder().encode("CD001"), next * SECTOR + 1);
    dir(ROOT, ROOT, new TextEncoder().encode("GAME.EXE;1"));
    dir(JROOT, JROOT, utf16be("game.exe;1"));
    img.set(exe, FILE * SECTOR);
    return img;
}

describe("iso-to-wgb --cd-path", () => {
    const run = async (iso: Uint8Array, ...flags: string[]) => {
        const logs = resolve("logs"); mkdirSync(logs, { recursive: true });
        const root = mkdtempSync(join(logs, "iso-cd-label-"));
        try {
            const image = join(root, "disc.iso"), output = join(root, "disc.wgb");
            writeFileSync(image, iso);
            const pack = Bun.spawnSync(["bun", "tools/iso-to-wgb.ts", image, output, "--game-id", "app:cd-label", ...flags],
                { stdout: "pipe", stderr: "pipe" });
            expect(pack.exitCode, pack.stderr.toString()).toBe(0);
            const cat = Bun.spawnSync(["bun", "tools/wgb.ts", "cat", output, "manifest.json"], { stdout: "pipe", stderr: "pipe" });
            expect(cat.exitCode, cat.stderr.toString()).toBe(0);
            return JSON.parse(cat.stdout.toString()).emulator as { cdPath?: string; cdLabel?: string };
        } finally {
            if (!root.startsWith(logs + sep)) throw new Error("fixture outside logs");
            rmSync(root, { recursive: true, force: true });
        }
    };

    test("D: at the disc root carries the disc's label; Joliet's wins, as Windows shows it", async () => {
        expect(await run(isoWithLabel("BFN_PC", null), "--cd-path", "C:\\")).toMatchObject({ cdPath: "C:\\", cdLabel: "BFN_PC" });
        expect((await run(isoWithLabel("PRIMARY", "Joliet Label"), "--cd-path", "C:\\")).cdLabel).toBe("Joliet Label");
    });

    test("--cd-label overrides it, and no --cd-path means no D: label", async () => {
        expect((await run(isoWithLabel("BFN_PC", null), "--cd-path", "C:\\", "--cd-label", "OTHER")).cdLabel).toBe("OTHER");
        const none = await run(isoWithLabel("BFN_PC", null));
        expect(none.cdPath).toBeUndefined();
        expect(none.cdLabel).toBeUndefined();
    });
});
