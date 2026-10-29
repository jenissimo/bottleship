/**
 * Since InstallShield 6 a file group carries its own destination, and a file's cabinet
 * directory is a subfolder beneath it. A header whose components have no destination
 * still installs `Data\Motion\*.bmf` and `Mods\…\Textures\GR\*` from that field alone.
 * The two compose even when they repeat a name: a real install of a group bound to
 * `<TARGETDIR>\help` whose cabinet dir is `help` has `help\help\*`.
 */
import { describe, expect, test } from "bun:test";
import { parseInstallShieldHeader, resolveInstallPath } from "@bottleship/formats/installshield/index.ts";

const CD = 0x40;          // cab descriptor
const FT = 0x400;         // file table, relative to CD
const FD = 0x100;         // v6 file descriptors, relative to the file table

function buildIs6(dirs: string[], files: { name: string; dir: number; date?: number }[],
                  groups: { name: string; first: number; last: number; dest: string }[]): Uint8Array {
    const hdr = new Uint8Array(0x2000);
    const dv = new DataView(hdr.buffer);
    const enc = new TextEncoder();
    let strPos = 0x1000;
    const str = (s: string, rel: number) => { hdr.set(enc.encode(s), strPos); const o = strPos - rel; strPos += s.length + 1; return o; };

    dv.setUint32(0, 0x28635349, true);
    dv.setUint32(4, 0x01006000, true);
    dv.setUint32(12, CD, true);
    dv.setUint32(CD + 0x0c, FT, true);
    dv.setUint32(CD + 0x1c, dirs.length, true);
    dv.setUint32(CD + 0x28, files.length, true);
    dv.setUint32(CD + 0x2c, FD, true);

    const base = CD + FT;
    dirs.forEach((d, i) => dv.setUint32(base + i * 4, str(d, base), true));
    files.forEach((f, i) => {
        const p = base + FD + i * 0x57;
        dv.setUint16(p, 8 /* FILE_INVALID: header-only */, true);
        dv.setUint32(p + 0x3a, str(f.name, base), true);
        dv.setUint16(p + 0x3e, f.dir, true);
        dv.setUint16(p + 0x44, f.date ?? 0x2b45, true);   // 2001-10-05
        dv.setUint16(p + 0x46, 0x60eb, true);   // 12:07:22
    });

    let pos = 0x900;
    groups.forEach((g, i) => {
        const node = pos, desc = pos + 0x10; pos += 0x60;
        dv.setUint32(CD + 0x3e + i * 4, node - CD, true);
        dv.setUint32(node + 4, desc - CD, true);
        dv.setUint32(desc, str(g.name, CD), true);
        dv.setInt32(desc + 0x16, g.first, true);
        dv.setInt32(desc + 0x1a, g.last, true);
        dv.setUint32(desc + 0x3a, str(g.dest, CD), true);
    });
    return hdr;
}

describe("InstallShield 6 file-group destination", () => {
    const info = parseInstallShieldHeader(buildIs6(
        ["", "GR", "kit\\sniper", "help"],
        [{ name: "001_tum_base.bmf", dir: 0 }, { name: "head.rsb", dir: 1 }, { name: "head.rsb", dir: 1 },
         { name: "icon.bmp", dir: 2 }, { name: "GRDemo.exe", dir: 0 }, { name: "msvcp.dll", dir: 0 },
         { name: "index.htm", dir: 3 }, { name: "readme.txt", dir: 0, date: (21 << 9) | (2 << 5) | 30 },
         { name: "anim.bmf", dir: 1 }],
        [{ name: "Data_Motion", first: 0, last: 0, dest: "<TARGETDIR>\\Data\\Motion" },
         { name: "Mods_Character", first: 1, last: 1, dest: "<TARGETDIR>\\Mods\\Origmiss\\Character" },
         { name: "Mods_Textures", first: 2, last: 3, dest: "<TARGETDIR>\\Mods\\Origmiss\\Textures" },
         { name: "Executable", first: 4, last: 4, dest: "<TARGETDIR>" },
         { name: "WinSysDir", first: 5, last: 5, dest: "<WINSYSDIR>" },
         { name: "Help", first: 6, last: 6, dest: "<TARGETDIR>\\help" },
         { name: "Readme", first: 7, last: 7, dest: "<TARGETDIR>" },
         { name: "Data_Anim", first: 8, last: 8, dest: "<TargetDir>\\Data\\Anim" }],
    ));
    const path = (i: number) => resolveInstallPath(info.files[i]!, info);

    test("reads each group's raw destination", () => {
        expect(info.fileGroups.map(g => g.destination)).toContain("<TARGETDIR>\\Data\\Motion");
    });

    test("a root-directory file lands in its group's destination", () => {
        expect(path(0)).toBe("Data/Motion/001_tum_base.bmf");
    });

    test("the cabinet directory is a subfolder of the group destination", () => {
        expect(path(1)).toBe("Mods/Origmiss/Character/GR/head.rsb");
        expect(path(2)).toBe("Mods/Origmiss/Textures/GR/head.rsb");
        expect(path(3)).toBe("Mods/Origmiss/Textures/kit/sniper/icon.bmp");
    });

    test("a cabinet directory that repeats the destination still nests beneath it", () => {
        expect(path(6)).toBe("help/help/index.htm");
    });

    test("<TARGETDIR> is matched in any case", () => {
        expect(path(8)).toBe("Data/Anim/GR/anim.bmf");
    });

    test("<TARGETDIR> itself is the install root", () => {
        expect(path(4)).toBe("GRDemo.exe");
    });

    test("a destination outside the install tree keeps the cabinet layout", () => {
        expect(path(5)).toBe("msvcp.dll");
    });

    test("each file carries the last-write time its descriptor records", () => {
        expect(info.files[0]!.modified).toBe(Date.UTC(2001, 9, 5, 12, 7, 22) / 1000);
    });

    test("an impossible descriptor date is ignored", () => {
        expect(info.files[7]!.modified).toBeUndefined();
    });
});
