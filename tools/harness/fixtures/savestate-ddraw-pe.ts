import JSZip from "jszip";

export const SAVESTATE_FIXTURE_BASE = 0x400000;
export const SAVESTATE_FIXTURE_COUNTER_VA = 0x401424;
export const SAVESTATE_FIXTURE_TICK_MS = 1500;
export const SAVESTATE_FIXTURE_GREEN = 0x80;
export const SAVESTATE_FIXTURE_BLUE = 0x40;
export const SAVESTATE_FIXTURE_KEYBOARD_BUFFER = 16;

export function savestateFixtureRed(counter: number): number {
    return (counter * 37) & 0xff;
}

const IMPORTS: Array<[string, string[]]> = [
    ["kernel32.dll", ["GetModuleHandleA", "ExitProcess", "CreateEventA"]],
    ["user32.dll", ["RegisterClassA", "CreateWindowExA", "DefWindowProcA", "GetMessageA", "DispatchMessageA", "SetTimer"]],
    ["ddraw.dll", ["DirectDrawCreate"]],
    ["dsound.dll", ["DirectSoundCreate"]],
    ["dinput.dll", ["DirectInputCreateA"]],
    ["winmm.dll", ["timeSetEvent"]],
];

const V = {
    hInst: 0x1400, hwnd: 0x1404, dd: 0x1408, prim: 0x140c, clip: 0x1410, ds: 0x1414, buf: 0x1418, di: 0x141c,
    evt: 0x1420, counter: 0x1424, off: 0x1428, kbd: 0x142c, msg: 0x1430, wc: 0x1450, ddsd: 0x1480, bltfx: 0x1500, dsbd: 0x1570, wfx: 0x15a0,
    cls: 0x15c0, title: 0x15d0, idata: 0x1600, ddsdOff: 0x1700, backCaps: 0x1770, kbdGuid: 0x1780, kbdFormat: 0x1790, bufferSize: 0x17b0, thunks: 0x1800,
};

export type SavestateFixtureMode = "windowed" | "flip";

export function savestateFixturePe(mode: SavestateFixtureMode = "windowed"): Uint8Array {
    const image = new Uint8Array(0x1200);
    const v = new DataView(image.buffer);
    const word = (at: number, x: number) => v.setUint16(at, x, true);
    const dword = (at: number, x: number) => v.setUint32(at, x >>> 0, true);
    const ascii = (at: number, s: string) => image.set(new TextEncoder().encode(s + "\0"), at);
    const off = (rva: number) => 0x200 + rva - 0x1000;
    const va = (rva: number) => SAVESTATE_FIXTURE_BASE + rva;

    word(0, 0x5a4d); dword(0x3c, 0x80);
    dword(0x80, 0x4550); word(0x84, 0x14c); word(0x86, 1);
    word(0x94, 224); word(0x96, 0x102);
    const opt = 0x98;
    word(opt, 0x10b);
    dword(opt + 4, 0x1000); dword(opt + 16, 0x1000); dword(opt + 20, 0x1000);
    dword(opt + 28, SAVESTATE_FIXTURE_BASE); dword(opt + 32, 0x1000); dword(opt + 36, 0x200);
    word(opt + 40, 4); word(opt + 48, 4);
    dword(opt + 56, 0x2000); dword(opt + 60, 0x200); word(opt + 68, 2);
    dword(opt + 72, 0x100000); dword(opt + 76, 0x1000);
    dword(opt + 80, 0x100000); dword(opt + 84, 0x1000); dword(opt + 92, 16);
    dword(opt + 104, V.idata); dword(opt + 108, (IMPORTS.length + 1) * 20);
    const sec = opt + 224;
    ascii(sec, ".text"); dword(sec + 8, 0x1000); dword(sec + 12, 0x1000);
    dword(sec + 16, 0x1000); dword(sec + 20, 0x200); dword(sec + 36, 0xe0000060);

    const iat = new Map<string, number>();
    let at = V.thunks;
    IMPORTS.forEach(([dll, names], i) => {
        const ilt = at;
        const iatRva = at + (names.length + 1) * 4;
        at = iatRva + (names.length + 1) * 4;
        const desc = off(V.idata + i * 20);
        dword(desc, ilt); dword(desc + 12, at); dword(desc + 16, iatRva);
        ascii(off(at), dll);
        at += (dll.length + 4) & ~3;
        names.forEach((name, n) => {
            dword(off(ilt + n * 4), at); dword(off(iatRva + n * 4), at);
            ascii(off(at) + 2, name);
            iat.set(name, va(iatRva + n * 4));
            at += (name.length + 5) & ~1;
        });
    });
    if (at > 0x2000) throw new Error("fixture imports overflow the section");

    dword(off(V.wc + 36), va(V.cls));
    ascii(off(V.cls), "BsSavestateFixture");
    ascii(off(V.title), "savestate fixture");
    const flip = mode === "flip";
    dword(off(V.ddsd), 108); dword(off(V.ddsd) + 4, flip ? 0x21 : 1); dword(off(V.ddsd) + 104, flip ? 0x218 : 0x200);
    if (flip) dword(off(V.ddsd) + 20, 1);
    dword(off(V.backCaps), 4);
    image.set([0x61, 0x2b, 0x1d, 0x6f, 0xa0, 0xd5, 0xcf, 0x11, 0xbf, 0xc7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00], off(V.kbdGuid));
    dword(off(V.kbdFormat), 24); dword(off(V.kbdFormat) + 4, 16); dword(off(V.kbdFormat) + 12, 256);
    dword(off(V.bufferSize), 20); dword(off(V.bufferSize) + 4, 16); dword(off(V.bufferSize) + 16, SAVESTATE_FIXTURE_KEYBOARD_BUFFER);
    dword(off(V.ddsdOff), 108); dword(off(V.ddsdOff) + 4, 7); dword(off(V.ddsdOff) + 8, 64); dword(off(V.ddsdOff) + 12, 64);
    dword(off(V.ddsdOff) + 104, 0x40);
    dword(off(V.bltfx), 100);
    dword(off(V.dsbd), 20); dword(off(V.dsbd) + 8, 4410); dword(off(V.dsbd) + 16, va(V.wfx));
    word(off(V.wfx), 1); word(off(V.wfx) + 2, 1); dword(off(V.wfx) + 4, 22050); dword(off(V.wfx) + 8, 22050);
    word(off(V.wfx) + 12, 1); word(off(V.wfx) + 14, 8);

    const code: number[] = [];
    const u32 = (x: number) => code.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
    const pushImm = (x: number) => { code.push(0x68); u32(x); };
    const pushMem = (rva: number) => { code.push(0xff, 0x35); u32(va(rva)); };
    const call = (name: string) => { code.push(0xff, 0x15); u32(iat.get(name)!); };
    const loadEax = (addr: number) => { code.push(0xa1); u32(addr); };
    const storeEax = (rva: number) => { code.push(0xa3); u32(va(rva)); };
    const method = (objRva: number, slot: number) => {
        loadEax(va(objRva));
        code.push(0x50, 0x8b, 0x08, 0xff, 0x51, slot);
    };
    const jcc = (op: number[]) => { code.push(...op); u32(0); return code.length; };
    const patch = (end: number, target: number) => {
        const rel = target - end;
        code.splice(end - 4, 4, rel & 0xff, (rel >>> 8) & 0xff, (rel >>> 16) & 0xff, (rel >>> 24) & 0xff);
    };

    pushImm(0); call("GetModuleHandleA"); storeEax(V.hInst);
    loadEax(iat.get("DefWindowProcA")!); storeEax(V.wc + 4);
    loadEax(va(V.hInst)); storeEax(V.wc + 16);
    pushImm(va(V.wc)); call("RegisterClassA");
    pushImm(0); pushMem(V.hInst); pushImm(0); pushImm(0); pushImm(240); pushImm(320); pushImm(0); pushImm(0);
    pushImm(0x10cf0000); pushImm(va(V.title)); pushImm(va(V.cls)); pushImm(0); call("CreateWindowExA"); storeEax(V.hwnd);
    pushImm(0); pushImm(va(V.dd)); pushImm(0); call("DirectDrawCreate");
    if (flip) {
        pushImm(0x11); pushMem(V.hwnd); method(V.dd, 0x50);
        pushImm(32); pushImm(480); pushImm(640); method(V.dd, 0x54);
        pushImm(0); pushImm(va(V.prim)); pushImm(va(V.ddsd)); method(V.dd, 0x18);
        pushImm(va(V.off)); pushImm(va(V.backCaps)); method(V.prim, 0x30);
    } else {
        pushImm(8); pushMem(V.hwnd); method(V.dd, 0x50);
        pushImm(0); pushImm(va(V.prim)); pushImm(va(V.ddsd)); method(V.dd, 0x18);
        pushImm(0); pushImm(va(V.off)); pushImm(va(V.ddsdOff)); method(V.dd, 0x18);
        pushImm(0); pushImm(va(V.clip)); pushImm(0); method(V.dd, 0x10);
        pushMem(V.hwnd); pushImm(0); method(V.clip, 0x20);
        pushMem(V.clip); method(V.prim, 0x70);
    }
    pushImm(0); pushImm(va(V.ds)); pushImm(0); call("DirectSoundCreate");
    pushImm(1); pushMem(V.hwnd); method(V.ds, 0x18);
    pushImm(0); pushImm(va(V.buf)); pushImm(va(V.dsbd)); method(V.ds, 0x0c);
    pushImm(1); pushImm(0); pushImm(0); method(V.buf, 0x30);
    pushImm(0); pushImm(va(V.di)); pushImm(0x0700); pushMem(V.hInst); call("DirectInputCreateA");
    pushImm(0); pushImm(va(V.kbd)); pushImm(va(V.kbdGuid)); method(V.di, 0x0c);
    pushImm(va(V.kbdFormat)); method(V.kbd, 0x2c);
    pushImm(6); pushMem(V.hwnd); method(V.kbd, 0x34);
    pushImm(va(V.bufferSize)); pushImm(1); method(V.kbd, 0x18);
    method(V.kbd, 0x1c);
    pushImm(0); pushImm(0); pushImm(0); pushImm(0); call("CreateEventA"); storeEax(V.evt);
    pushImm(0x11); pushImm(0); pushMem(V.evt); pushImm(1); pushImm(50); call("timeSetEvent");
    pushImm(0); pushImm(SAVESTATE_FIXTURE_TICK_MS); pushImm(1); pushMem(V.hwnd); call("SetTimer");

    const loop = code.length;
    pushImm(0); pushImm(0); pushImm(0); pushImm(va(V.msg)); call("GetMessageA");
    code.push(0x85, 0xc0);
    const toExit = jcc([0x0f, 0x84]);
    code.push(0x81, 0x3d); u32(va(V.msg + 4)); u32(0x113);
    const toDispatch = jcc([0x0f, 0x85]);
    code.push(0xff, 0x05); u32(va(V.counter));
    loadEax(va(V.counter));
    code.push(0x69, 0xc0); u32(37);
    code.push(0x25); u32(0xff);
    code.push(0xc1, 0xe0, 0x10);
    code.push(0x0d); u32((SAVESTATE_FIXTURE_GREEN << 8) | SAVESTATE_FIXTURE_BLUE);
    storeEax(V.bltfx + 0x50);
    pushImm(va(V.bltfx)); pushImm(0x01000400); pushImm(0); pushImm(0); pushImm(0); method(V.off, 0x14);
    if (flip) {
        pushImm(1); pushImm(0); method(V.prim, 0x2c);
    } else {
        pushImm(0); pushImm(0x01000000); pushImm(0); pushMem(V.off); pushImm(0); method(V.prim, 0x14);
    }
    const back1 = jcc([0xe9]); patch(back1, loop);
    patch(toDispatch, code.length);
    pushImm(va(V.msg)); call("DispatchMessageA");
    const back2 = jcc([0xe9]); patch(back2, loop);
    patch(toExit, code.length);
    pushImm(0); call("ExitProcess");

    if (code.length > V.hInst - 0x1000) throw new Error(`fixture code is ${code.length} bytes, too long`);
    image.set(code, off(0x1000));
    return image;
}

export async function savestateFixtureWgb(mode: SavestateFixtureMode = "windowed"): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
        formatVersion: 2, gameId: `app:savestate-ddraw-${mode}-fixture`, name: `savestate ddraw ${mode} fixture`,
        entrypoint: "rom/fixture.exe", rom: "rom", registry: "registry.json",
        emulator: {
            osVersion: { major: 5, minor: 1, build: 2600, platformId: 2 },
            screenResolution: { width: 640, height: 480, bpp: 32 },
            memory: { ram: 64 * 1024 * 1024 },
        },
    }, null, 2));
    zip.file("registry.json", JSON.stringify({ root: "HKLM", path: "Software", values: [] }));
    zip.file("rom/fixture.exe", savestateFixturePe(mode));
    return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

if (import.meta.main) {
    const [path, mode = "windowed"] = process.argv.slice(2);
    if (!path || (mode !== "windowed" && mode !== "flip")) throw new Error("Usage: bun tools/harness/fixtures/savestate-ddraw-pe.ts <output.wgb> [windowed|flip]");
    await Bun.write(path, await savestateFixtureWgb(mode));
    console.log(`Wrote ${path}`);
}
