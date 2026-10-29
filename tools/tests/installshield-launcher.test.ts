/**
 * The InstallShield 7 setup launcher's record chain runs to the end of the PE overlay. A
 * signed launcher carries its Authenticode certificate after that, so the chain ends at the
 * certificate, not at EOF.
 */
import { describe, expect, test } from "bun:test";
import {
    extractInstallShieldLauncher, isInstallShieldLauncher, parseInstallShieldLauncher,
} from "@bottleship/formats/installshield-launcher/index.ts";

const PE = 0x40, OPT = PE + 24, SECTIONS = OPT + 0xe0, OVERLAY = 0x400;

function launcher(records: { name: string; path: string; data: string }[], trailer?: { cert: boolean; bytes: number }): Uint8Array {
    const enc = new TextEncoder();
    const chain = records.flatMap(r => [...enc.encode(`${r.name}\0${r.path}\0\0${r.data.length}\0${r.data}`)]);
    const tail = trailer?.bytes ?? 0;
    const out = new Uint8Array(OVERLAY + chain.length + tail);
    const dv = new DataView(out.buffer);
    out[0] = 0x4d; out[1] = 0x5a;
    dv.setUint32(0x3c, PE, true);
    dv.setUint32(PE, 0x4550, true);
    dv.setUint16(PE + 6, 1, true);              // one section
    dv.setUint16(PE + 20, 0xe0, true);          // PE32 optional header size
    dv.setUint16(OPT, 0x10b, true);
    dv.setUint32(OPT + 92, 16, true);           // NumberOfRvaAndSizes
    dv.setUint32(SECTIONS + 16, 0x200, true);   // SizeOfRawData
    dv.setUint32(SECTIONS + 20, 0x200, true);   // PointerToRawData → overlay at 0x400
    out.set(chain, OVERLAY);
    if (trailer?.cert) {
        dv.setUint32(OPT + 96 + 4 * 8, OVERLAY + chain.length, true);
        dv.setUint32(OPT + 96 + 4 * 8 + 4, tail, true);
        dv.setUint32(OVERLAY + chain.length, tail, true);   // WIN_CERTIFICATE.dwLength
    }
    return out;
}

const RECORDS = [
    { name: "data1.hdr", path: "Disk1\\data1.hdr", data: "ISc(hdr" },
    { name: "data1.cab", path: "Disk1\\data1.cab", data: "ISc(cab-bytes" },
];

describe("InstallShield setup launcher", () => {
    test("an unsigned launcher's chain runs to EOF", () => {
        const bytes = launcher(RECORDS);
        expect(isInstallShieldLauncher(bytes)).toBe(true);
        const files = extractInstallShieldLauncher(bytes);
        expect([...files.keys()]).toEqual(["Disk1/data1.hdr", "Disk1/data1.cab"]);
        expect(new TextDecoder().decode(files.get("Disk1/data1.cab"))).toBe("ISc(cab-bytes");
    });

    test("a signed launcher's chain ends at the certificate table", () => {
        const bytes = launcher(RECORDS, { cert: true, bytes: 0x40 });
        expect(isInstallShieldLauncher(bytes)).toBe(true);
        expect(parseInstallShieldLauncher(bytes)!.map(e => e.name)).toEqual(["data1.hdr", "data1.cab"]);
    });

    test("unexplained bytes after the chain are not a launcher", () => {
        expect(parseInstallShieldLauncher(launcher(RECORDS, { cert: false, bytes: 0x40 }))).toBeNull();
    });
});
