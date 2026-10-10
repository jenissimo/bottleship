/** Single-thread PE32 for crossingCost; initializes one valid TLS slot, then stays in JMP $. */
export const CROSSING_TLS_INDEX_VA = 0x401300;

export function crossingFixturePe(): Uint8Array {
    const image = new Uint8Array(0x1200);
    const v = new DataView(image.buffer);
    const word = (at: number, x: number) => v.setUint16(at, x, true);
    const dword = (at: number, x: number) => v.setUint32(at, x, true);
    const ascii = (at: number, s: string) => image.set(new TextEncoder().encode(s + "\0"), at);
    const fileOffset = (rva: number) => 0x200 + rva - 0x1000;
    word(0, 0x5a4d); dword(0x3c, 0x80);
    dword(0x80, 0x4550); word(0x84, 0x14c); word(0x86, 1);
    word(0x94, 224); word(0x96, 0x102);
    const opt = 0x98;
    word(opt, 0x10b);
    dword(opt + 4, 0x1000); dword(opt + 16, 0x1000); dword(opt + 20, 0x1000);
    dword(opt + 28, 0x400000); dword(opt + 32, 0x1000); dword(opt + 36, 0x200);
    word(opt + 40, 4); word(opt + 48, 4);
    dword(opt + 56, 0x2000); dword(opt + 60, 0x200); word(opt + 68, 2);
    dword(opt + 72, 0x100000); dword(opt + 76, 0x1000);
    dword(opt + 80, 0x100000); dword(opt + 84, 0x1000); dword(opt + 92, 16);
    dword(opt + 104, 0x1100); dword(opt + 108, 40);
    const sec = opt + 224;
    ascii(sec, ".text"); dword(sec + 8, 0x1000); dword(sec + 12, 0x1000);
    dword(sec + 16, 0x1000); dword(sec + 20, 0x200); dword(sec + 36, 0xe0000020);
    dword(fileOffset(0x1100), 0x1140);
    dword(fileOffset(0x1100) + 12, 0x1200); dword(fileOffset(0x1100) + 16, 0x1160);
    ascii(fileOffset(0x1200), "kernel32.dll");
    ["GetCurrentThreadId", "GetCurrentProcessId", "TlsAlloc", "TlsSetValue"].forEach((name, i) => {
        const rva = 0x1220 + i * 0x30;
        dword(fileOffset(0x1140) + i * 4, rva);
        dword(fileOffset(0x1160) + i * 4, rva);
        ascii(fileOffset(rva) + 2, name);
    });
    // The slot is allocated through the real API, so TlsSetValue measures its successful path.
    image.set([0xff, 0x15, 0x68, 0x11, 0x40, 0x00, 0xa3, 0x00, 0x13, 0x40, 0x00, 0xeb, 0xfe], 0x200);
    dword(fileOffset(0x1300), 0xffffffff);
    return image;
}

if (import.meta.main) {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: bun tools/harness/fixtures/crossings-pe.ts <output.exe>");
    await Bun.write(path, crossingFixturePe());
    console.log(`Wrote ${path}; load with harness().reload().loadPe(url), then call crossingCost.`);
}
