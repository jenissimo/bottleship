import { afterEach, describe, expect, test } from "bun:test";
import { PELoader } from "../../src/worker/core/pe-loader";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

const config = EmulatorConfig.getInstance();
const original = config.appDirDlls;
afterEach(() => { config.appDirDlls = original; });

function loaderWithFile(path: string | null): PELoader {
    return Object.assign(Object.create(PELoader.prototype), {
        vfs: {}, moduleRegistry: { getByName: () => undefined },
        loadingDlls: new Set(), findDllPath: () => path,
    });
}

describe("explicit native video DLL selection", () => {
    test("the default keeps video decoding on the HLE path", () => {
        config.appDirDlls = [];
        expect(loaderWithFile("C:\\Game\\binkw32.dll").peekLoadDll("binkw32")).toEqual({ kind: "none" });
    });
    test("a manifest rule allows the actual game-shipped decoder to load", () => {
        config.appDirDlls = ["binkw32"];
        expect(loaderWithFile("C:\\Game\\binkw32.dll").peekLoadDll("binkw32")).toEqual({ kind: "io" });
    });
    test("a rule without an existing decoder does not manufacture a DLL", () => {
        config.appDirDlls = ["binkw32"];
        expect(loaderWithFile(null).peekLoadDll("binkw32")).toEqual({ kind: "none" });
    });
    test("a matching rule does not select a system-directory decoder", () => {
        config.appDirDlls = ["bink*"];
        expect(loaderWithFile("C:\\Windows\\System32\\binkw32.dll").peekLoadDll("BINKW32.DLL")).toEqual({ kind: "none" });
    });
    test("case-insensitive wildcard rules select an application copy", () => {
        config.appDirDlls = ["BINK*.DLL"];
        expect(loaderWithFile("C:\\Game\\binkw32.dll").peekLoadDll("binkw32.dll")).toEqual({ kind: "io" });
    });
    test("an unrelated rule leaves video HLE enabled", () => {
        config.appDirDlls = ["ddraw"];
        expect(loaderWithFile("C:\\Game\\binkw32.dll").peekLoadDll("binkw32")).toEqual({ kind: "none" });
    });
});
