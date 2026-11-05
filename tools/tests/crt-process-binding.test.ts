// One C runtime per process (src/worker/core/crt-binding.ts, issue #117). The per-module rule
// in resolveImportBinding put a module whose msvcrt imports HLE covers on HLE msvcrt, and a
// module with one uncovered import on the bundle's own msvcrt.dll — two heaps, two FILE tables
// in one process. Empires: Dawn of the Modern World lost its random-map list that way.
//
// Fixtures are synthetic PE32 images assembled in memory and read back through the same
// on-disk import parser the loader's pre-walk uses.

import { describe, it, expect, beforeEach } from "bun:test";
import { parsePeImports } from "@bottleship/formats/pe";
import {
    crtRuntimeKind, planProcessCrt, processCrtBinding,
    type CrtBindingMode, type CrtPlanDeps, type CrtScanImport,
} from "../../src/worker/core/crt-binding";
import {
    resolveImportBinding, uncoveredHleImports, type ImportBindingDeps, type ImportFn,
} from "../../src/worker/core/pe-import-binding";

// --- synthetic PE32 with an import directory ------------------------------------------------

const SEC_RVA = 0x1000;
const SEC_RAW = 0x200;
const SEC_SIZE = 0x1000;
const PE_OFF = 0x40;
const OPT_SIZE = 224;

/** A PE32 image whose import directory links `imports` (dll → function names). */
function buildPe(imports: Record<string, string[]>, isDll = false): Uint8Array {
    const image = new Uint8Array(SEC_RAW + SEC_SIZE);
    const view = new DataView(image.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, PE_OFF, true);
    view.setUint32(PE_OFF, 0x00004550, true);
    view.setUint16(PE_OFF + 4, 0x014c, true);
    view.setUint16(PE_OFF + 6, 1, true);
    view.setUint16(PE_OFF + 20, OPT_SIZE, true);
    view.setUint16(PE_OFF + 22, isDll ? 0x2102 : 0x0102, true);
    const opt = PE_OFF + 24;
    view.setUint16(opt, 0x010b, true);
    view.setUint32(opt + 28, isDll ? 0x10000000 : 0x400000, true);
    view.setUint32(opt + 56, SEC_RVA + SEC_SIZE, true);
    view.setUint32(opt + 92, 16, true);
    const sec = opt + OPT_SIZE;
    ".idata".split("").forEach((c, i) => { image[sec + i] = c.charCodeAt(0); });
    view.setUint32(sec + 8, SEC_SIZE, true);
    view.setUint32(sec + 12, SEC_RVA, true);
    view.setUint32(sec + 16, SEC_SIZE, true);
    view.setUint32(sec + 20, SEC_RAW, true);

    const dlls = Object.entries(imports);
    const at = (rva: number): number => SEC_RAW + (rva - SEC_RVA);
    const descriptors = SEC_RVA;
    let cursor = descriptors + (dlls.length + 1) * 20;
    const put = (bytes: number[]): number => {
        const rva = cursor;
        image.set(bytes, at(rva));
        cursor += (bytes.length + 3) & ~3;
        return rva;
    };
    const cstr = (s: string): number[] => [...s].map(c => c.charCodeAt(0)).concat(0);
    dlls.forEach(([dll, names], d) => {
        const nameRvas = names.map(n => put([0, 0, ...cstr(n)]));
        const thunks = (): number[] => nameRvas.concat(0).flatMap(r => [r & 0xff, (r >> 8) & 0xff, (r >> 16) & 0xff, r >>> 24]);
        const ilt = put(thunks());
        const iat = put(thunks());
        const dllName = put(cstr(dll));
        const base = at(descriptors + d * 20);
        view.setUint32(base, ilt, true);
        view.setUint32(base + 12, dllName, true);
        view.setUint32(base + 16, iat, true);
    });
    view.setUint32(opt + 96 + 8, descriptors, true);
    view.setUint32(opt + 96 + 12, (dlls.length + 1) * 20, true);
    return image;
}

function importsOf(image: Uint8Array): CrtScanImport[] {
    return parsePeImports(image).dlls.map(d => ({
        dll: d.dll,
        functions: d.entries.map(e => (e.name !== undefined ? { name: e.name } : { ordinal: e.ordinal })),
    }));
}

// --- a tiny process: HLE modules, what they implement, the files the bundle ships -----------

/** What the HLE registry knows: module → implemented exports (all cdecl, arg count known). */
const HLE: Record<string, string[]> = {
    kernel32: ["GetVersion"],
    msvcrt: ["malloc", "free", "fopen", "_mbscmp"],
    msvcp60: ["?_Xlen@std@@YAXXZ"],
};

interface World {
    files: Record<string, Uint8Array>;
    logs: string[];
    warns: string[];
}

function bindingDeps(w: World): ImportBindingDeps {
    return {
        hasThunkedModule: (n) => n in HLE,
        findDllPath: (n) => (n.toLowerCase() in w.files ? `C:\\GAME\\${n}.dll` : null),
        appDirRule: () => null,
        isUnderSystemDirectory: () => false,
        exportFacts: (thunked, f) => (f.name && HLE[thunked]?.includes(f.name)
            ? { callingConvention: "cdecl", argCount: 1 } : {}),
        log: (m) => w.logs.push(m),
        warn: (m) => w.warns.push(m),
    };
}

function planDeps(w: World): CrtPlanDeps {
    const quiet: ImportBindingDeps = { ...bindingDeps(w), log: () => {}, warn: () => {} };
    const base = (raw: string): string => raw.toLowerCase().replace(/\.dll$/, "");
    return {
        readImports: async (raw) => (w.files[base(raw)] ? importsOf(w.files[base(raw)]) : null),
        bindAlone: (raw, fns) => resolveImportBinding(raw, fns, quiet),
        uncovered: (raw, fns) => uncoveredHleImports(raw, fns, quiet),
        shipped: (raw) => base(raw) in w.files,
        log: (m) => w.logs.push(m),
        warn: (m) => w.warns.push(m),
    };
}

/** Plan the process from `exe`, then bind every image's CRT import the way processImports does. */
async function boot(exe: Uint8Array, files: Record<string, Uint8Array>, mode: CrtBindingMode = "auto") {
    const w: World = { files, logs: [], warns: [] };
    const { choices, importers } = await planProcessCrt("game.exe", importsOf(exe), mode, planDeps(w));
    processCrtBinding.adoptPlan(mode, choices, importers);
    const bindDeps = { ...bindingDeps(w), processCrtChoice: (raw: string) => processCrtBinding.choiceFor(raw) };
    const bound = (image: Uint8Array, dll: string): boolean => {
        const imp = importsOf(image).find(i => i.dll.toLowerCase() === dll.toLowerCase());
        if (!imp) throw new Error(`no ${dll} import`);
        return resolveImportBinding(imp.dll, imp.functions as ImportFn[], bindDeps).isThunked;
    };
    return { w, choices, importers, bound, bindDeps };
}

const MSVCRT_FILE = buildPe({ "KERNEL32.dll": ["GetVersion"] }, true);

beforeEach(() => processCrtBinding.reset());

describe("crtRuntimeKind", () => {
    it("knows the C runtime under every import name and the C++ runtime on top of it", () => {
        expect(crtRuntimeKind("MSVCRT.dll")).toBe("c");
        expect(crtRuntimeKind("msvcr71.dll")).toBe("c");
        expect(crtRuntimeKind("api-ms-win-crt-runtime-l1-1-0.dll")).toBe("c");
        expect(crtRuntimeKind("MSVCP60.dll")).toBe("cpp");
        expect(crtRuntimeKind("msvcp71.dll")).toBe("cpp");
        expect(crtRuntimeKind("mfc42.dll")).toBeNull();
        expect(crtRuntimeKind("kernel32.dll")).toBeNull();
    });
});

describe("planProcessCrt: one CRT for the whole process", () => {
    // Empires: the EXE's msvcrt imports are covered, its engine DLL's are not.
    const exe = buildPe({ "ENGINE.dll": ["Run"], "MSVCRT.dll": ["malloc", "free"] });
    const engine = buildPe({ "MSVCRT.dll": ["malloc", "_ismbcalpha"], "KERNEL32.dll": ["GetVersion"] }, true);

    it("one covered and one uncovered importer end up on the SAME (shipped) CRT", async () => {
        const { choices, importers, bound } = await boot(exe, { engine, msvcrt: MSVCRT_FILE });
        expect(choices.get("msvcrt")).toBe("native");
        expect(importers).toEqual(["game.exe", "engine"]);
        // The EXE alone would have stayed on HLE — it follows the process now.
        expect(bound(exe, "MSVCRT.dll")).toBe(false);
        expect(bound(engine, "MSVCRT.dll")).toBe(false);
    });

    it("all importers covered keeps HLE for all, even with a shipped msvcrt.dll", async () => {
        const coveredEngine = buildPe({ "MSVCRT.dll": ["fopen", "_mbscmp"] }, true);
        const { choices, bound } = await boot(exe, { engine: coveredEngine, msvcrt: MSVCRT_FILE });
        expect(choices.get("msvcrt")).toBe("hle");
        expect(bound(exe, "MSVCRT.dll")).toBe(true);
        expect(bound(coveredEngine, "MSVCRT.dll")).toBe(true);
    });

    it("no shipped CRT: HLE for all, and a warning naming what HLE does not cover", async () => {
        const { choices, w, bound } = await boot(exe, { engine });
        expect(choices.get("msvcrt")).toBe("hle");
        expect(bound(engine, "MSVCRT.dll")).toBe(true);
        expect(w.warns.some(m => m.includes("ships no copy") && m.includes("_ismbcalpha"))).toBe(true);
    });

    it('manifest crt "hle" keeps HLE for an uncovered importer and says so at bind time', async () => {
        const { choices, w, bound } = await boot(exe, { engine, msvcrt: MSVCRT_FILE }, "hle");
        expect(choices.get("msvcrt")).toBe("hle");
        expect(bound(engine, "MSVCRT.dll")).toBe(true);
        expect(w.warns.some(m => m.includes("_ismbcalpha") && m.includes("binds this CRT to HLE"))).toBe(true);
    });

    it('manifest crt "native" binds a fully covered process to the shipped DLL', async () => {
        const coveredEngine = buildPe({ "MSVCRT.dll": ["fopen"] }, true);
        const { choices, bound } = await boot(exe, { engine: coveredEngine, msvcrt: MSVCRT_FILE }, "native");
        expect(choices.get("msvcrt")).toBe("native");
        expect(bound(exe, "MSVCRT.dll")).toBe(false);
        expect(bound(coveredEngine, "MSVCRT.dll")).toBe(false);
    });

    it("an importer reached only through a native mfc42 (no HLE module) takes part", async () => {
        const mfcExe = buildPe({ "MFC42.dll": ["Foo"], "MSVCRT.dll": ["malloc"] });
        const mfc42 = buildPe({ "MSVCRT.dll": ["_uncovered_thing"] }, true);
        const { choices, importers } = await boot(mfcExe, { mfc42, msvcrt: MSVCRT_FILE });
        expect(importers).toContain("mfc42");
        expect(choices.get("msvcrt")).toBe("native");
    });

    it("a native C runtime pulls the shipped C++ runtime along, and a native C++ runtime's own CRT imports count", async () => {
        // msvcp60 is covered by the EXE's imports, but the C runtime goes native: HLE msvcp60
        // allocates through HLE msvcrt, so it must not stay behind.
        const cppExe = buildPe({ "ENGINE.dll": ["Run"], "MSVCP60.dll": ["?_Xlen@std@@YAXXZ"] });
        const msvcp60 = buildPe({ "MSVCRT.dll": ["malloc"] }, true);
        const a = await boot(cppExe, { engine, msvcrt: MSVCRT_FILE, msvcp60 });
        expect(a.choices.get("msvcrt")).toBe("native");
        expect(a.choices.get("msvcp60")).toBe("native");
        expect(a.bound(cppExe, "MSVCP60.dll")).toBe(false);

        // The other direction: msvcp60 needs the shipped copy, and THAT copy's msvcrt import is
        // the uncovered one — the walk follows it and flips the C runtime as well.
        processCrtBinding.reset();
        const cppExe2 = buildPe({ "MSVCP60.dll": ["_NotInHle"], "MSVCRT.dll": ["malloc"] });
        const msvcp60b = buildPe({ "MSVCRT.dll": ["_ismbcalpha"] }, true);
        const b = await boot(cppExe2, { msvcrt: MSVCRT_FILE, msvcp60: msvcp60b });
        expect(b.choices.get("msvcp60")).toBe("native");
        expect(b.choices.get("msvcrt")).toBe("native");
        expect(b.bound(cppExe2, "MSVCRT.dll")).toBe(false);
    });
});

describe("processCrtBinding: late modules follow the decision", () => {
    it("a LoadLibrary'd module with uncovered imports stays on the HLE the process chose", async () => {
        const exe = buildPe({ "MSVCRT.dll": ["malloc"] });
        const { bindDeps, w } = await boot(exe, { msvcrt: MSVCRT_FILE });
        expect(processCrtBinding.choiceFor("msvcrt.dll")).toBe("hle");
        const late = resolveImportBinding("MSVCRT.dll", [{ name: "_ismbcalpha" }], bindDeps);
        expect(late.isThunked).toBe(true);
        expect(w.warns.some(m => m.includes("binds this CRT to HLE"))).toBe(true);
    });

    it("a CRT name no static image imported is decided by its first binding", () => {
        processCrtBinding.adoptPlan("auto", new Map());
        processCrtBinding.noteLateBinding("MSVCR71.dll", false);
        processCrtBinding.noteLateBinding("msvcr71", true);
        expect(processCrtBinding.choiceFor("msvcr71.dll")).toBe("native");
        processCrtBinding.noteLateBinding("ddraw.dll", false);
        expect(processCrtBinding.choiceFor("ddraw.dll")).toBeUndefined();
    });
});
