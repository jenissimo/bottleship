import { afterEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { readExternalManifest } from "../../src/worker/modules/kernel32/process/actctx";

const system = System.getInstance() as any;
const saved = { process: system.process, fileSystem: system.fileSystem };
afterEach(() => { system.process = saved.process; system.fileSystem = saved.fileSystem; });

function install(files: Record<string, string>) {
    const opened: string[] = [];
    system.process = { moduleRegistry: { getByBase: (base: number) => (base === 0x400000 ? { path: "C:\\Game.exe" } : undefined) } };
    system.fileSystem = {
        open: async (path: string) => { opened.push(path); return path in files ? { path } : null; },
        getFileSize: (path: string) => files[path]?.length ?? 0,
        read: async (h: { path: string }) => new TextEncoder().encode(files[h.path]),
    };
    return opened;
}

test("the manifest beside the executable is read when the image embeds none", async () => {
    const xml = '\uFEFF<assembly><dependency><dependentAssembly><assemblyIdentity name="Microsoft.VC80.CRT"/></dependentAssembly></dependency></assembly>';
    const opened = install({ "C:/Game.exe.manifest": xml });
    expect(await readExternalManifest(0x400000)).toBe(xml.slice(1));
    expect(opened).toEqual(["C:/Game.exe.manifest"]);
});

test("no file, or an unknown module, gives no manifest", async () => {
    install({});
    expect(await readExternalManifest(0x400000)).toBeUndefined();
    expect(await readExternalManifest(0x10000000)).toBeUndefined();
});
