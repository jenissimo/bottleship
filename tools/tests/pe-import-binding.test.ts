// The import-binding decision (src/worker/core/pe-import-binding.ts): our HLE module, or the
// real PE the game ships? The binding is invisible until the guest CALLS the slot, so a wrong
// answer surfaces as an illegal instruction (the shared UD2 trap an unbound alias import gets)
// somewhere else entirely — which is exactly how Far Cry died: MSVCP71.dll sits next to the
// exe, our msvcp90 alias claimed it, and 47 of its C++ imports bound to the trap.

import { describe, it, expect } from "bun:test";
import {
    resolveImportBinding, type ImportBindingDeps, type ImportFn,
} from "../../src/worker/core/pe-import-binding";

function deps(over: Partial<ImportBindingDeps> & { modules?: string[]; files?: string[]; known?: Record<string, number> } = {}): ImportBindingDeps {
    const modules = new Set(over.modules ?? []);
    const files = new Set((over.files ?? []).map(f => f.toLowerCase()));
    const known = over.known ?? {};
    return {
        hasThunkedModule: (n) => modules.has(n),
        findDllPath: (n) => (files.has(n.toLowerCase()) ? `C:\\GAME\\${n}.dll` : null),
        appDirRule: () => null,
        isUnderSystemDirectory: () => false,
        exportFacts: (thunked, f) => {
            const n = known[`${thunked}:${f.name}`];
            return n === undefined ? {} : { argCount: n };
        },
        log: () => {},
        warn: () => {},
        ...over,
    };
}

/** A C++ export whose MSVC mangling yields a stack cleanup but which no descriptor implements. */
const MANGLED: ImportFn = { name: "?_Lock@_Mutex@std@@QAEXXZ" };
const PLAIN: ImportFn = { name: "_spawnl" };

describe("resolveImportBinding", () => {
    it("an alias does not shadow the real DLL the app ships when it cannot cover the imports", () => {
        const b = resolveImportBinding("MSVCP71.dll", [MANGLED], deps({
            modules: ["msvcp90"], files: ["msvcp71"],
        }));
        expect(b.isThunked).toBe(false);
        // The native load must happen under the name the IMAGE asked for — msvcp90.dll is not
        // a file anyone ships, so keeping the alias here binds nothing at all.
        expect(b.dllName).toBe("msvcp71");
        expect(b.aliasTarget).toBeNull();
    });

    it("a derivable mangled name is not coverage for an ALIAS — only for the module that is the DLL", () => {
        // Same import, no alias involved: the HLE module IS msvcrt, so an unimplemented export
        // stays thunked and reports itself through the OUT trap.
        const b = resolveImportBinding("msvcrt.dll", [MANGLED], deps({
            modules: ["msvcrt"], files: ["msvcrt"],
        }));
        expect(b.isThunked).toBe(true);
        expect(b.dllName).toBe("msvcrt");
    });

    it("the alias stands when the app ships no copy of the DLL", () => {
        const b = resolveImportBinding("msvcp71.dll", [MANGLED], deps({ modules: ["msvcp90"] }));
        expect(b.isThunked).toBe(true);
        expect(b.dllName).toBe("msvcp90");
        expect(b.aliasTarget).toBe("msvcp90");
    });

    it("full coverage keeps the HLE module even with the real file present", () => {
        const b = resolveImportBinding("MSVCR71.dll", [PLAIN], deps({
            modules: ["msvcrt"], files: ["msvcr71"], known: { "msvcrt:_spawnl": 3 },
        }));
        expect(b.isThunked).toBe(true);
        expect(b.dllName).toBe("msvcrt");
        expect(b.aliasTarget).toBe("msvcrt");
    });

    it("an HLE-only DLL stays thunked however uncovered, even with a shipped copy", () => {
        const b = resolveImportBinding("kernel32.dll", [{ name: "SomeUndocumentedThing" }], deps({
            modules: ["kernel32"], files: ["kernel32"],
        }));
        expect(b.isThunked).toBe(true);
        expect(b.dllName).toBe("kernel32");
    });

    it("a d3dx9 redist stays thunked — the canonical module is the only implementation", () => {
        const b = resolveImportBinding("d3dx9_43.dll", [{ name: "D3DXSomethingNew" }], deps({
            modules: ["d3dx9"], files: ["d3dx9_43"],
        }));
        expect(b.isThunked).toBe(true);
        expect(b.dllName).toBe("d3dx9");
    });

    it("manifest.appDirDlls hands a wrapper its slot before coverage is considered", () => {
        const b = resolveImportBinding("ddraw.dll", [{ name: "DirectDrawCreate" }], deps({
            modules: ["ddraw"], files: ["ddraw"],
            appDirRule: () => "ddraw.dll",
        }));
        expect(b.isThunked).toBe(false);
    });
});
