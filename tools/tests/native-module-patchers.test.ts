/**
 * The native-module patch registry. Its two load-bearing properties are isolation (one entry
 * throwing must not stop another, and must not fail the DLL load) and the predicate contract —
 * both are shown here failing the way they would if the registry lost them.
 */

import { describe, expect, test } from "bun:test";
import {
    nativeModulePatcherIds, registerNativeModulePatcher, runNativeModulePatchers,
} from "../../src/worker/core/hooks/native-module-patchers";
import type { LoadedPEModule } from "../../src/worker/core/module-registry";
import type { Process } from "../../src/worker/core/process";

const moduleNamed = (name: string): LoadedPEModule => ({
    name, path: `c:\\${name}.dll`, baseAddress: 0x10000, size: 0x1000, entryPoint: 0,
    exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: true,
});
const fakeProcess = {} as Process;

describe("native module patch registry", () => {
    test("a throwing entry does not stop later entries and does not propagate", () => {
        const seen: string[] = [];
        registerNativeModulePatcher({ id: "t-throws", patch: () => { throw new Error("boom"); } });
        registerNativeModulePatcher({ id: "t-after", patch: () => { seen.push("after"); } });
        expect(() => runNativeModulePatchers(fakeProcess, moduleNamed("anything"))).not.toThrow();
        expect(seen).toEqual(["after"]);
    });

    test("a predicate keeps an entry away from modules it did not ask for", () => {
        const seen: string[] = [];
        registerNativeModulePatcher({
            id: "t-picky",
            matches: (m) => /^avcodec-\d+$/.test(m.name),
            patch: (_p, m) => { seen.push(m.name); },
        });
        runNativeModulePatchers(fakeProcess, moduleNamed("d3d9"));
        expect(seen).toEqual([]);
        runNativeModulePatchers(fakeProcess, moduleNamed("avcodec-56"));
        expect(seen).toEqual(["avcodec-56"]);
    });

    test("an entry without a predicate is asked about every module — Galaxy's shape", () => {
        const seen: string[] = [];
        registerNativeModulePatcher({ id: "t-always", patch: (_p, m) => { seen.push(m.name); } });
        runNativeModulePatchers(fakeProcess, moduleNamed("one"));
        runNativeModulePatchers(fakeProcess, moduleNamed("two"));
        expect(seen).toEqual(["one", "two"]);
    });

    test("re-registering an id replaces it instead of running both", () => {
        const seen: string[] = [];
        registerNativeModulePatcher({ id: "t-dup", patch: () => { seen.push("first"); } });
        registerNativeModulePatcher({ id: "t-dup", patch: () => { seen.push("second"); } });
        runNativeModulePatchers(fakeProcess, moduleNamed("x"));
        expect(seen).toEqual(["second"]);
        expect(nativeModulePatcherIds().filter((i) => i === "t-dup")).toHaveLength(1);
    });
});
