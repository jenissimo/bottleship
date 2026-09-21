/**
 * The Windows registry is system-wide. A child process that writes HKCU writes the hive
 * its parent reads, and the write is durable by the time the process is gone.
 *
 * Ours is per-worker: a child boots into its own worker with its own RegistryStore,
 * restored from a COPY of the parent's keys. Only the root boot calls setGameId and
 * installs the debounced autosave, so a child's store owns no container and has no
 * persistence trigger — every RegSetValueEx it makes lives and dies inside that worker.
 * A game whose configurator runs as a child process (Mafia's game.exe spawns setup.exe,
 * which writes HKCU\Software\Illusion Softworks\Mafia\LS3D_setup and exits) therefore
 * re-ran its setup dialog on every launch.
 *
 * Two invariants, both driven at the seam rather than through a timing window:
 *   - a guest write on a child store reaches the owner's store, which is what triggers
 *     persistence — including through the child_process message route that carries it;
 *   - a store with no gameId never writes a container, so a child's partial copy cannot
 *     land on top of the owner's registry.json.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RegistryStore, type RegistryMutation } from "../../src/worker/runtime/filesystem/registry";
import { installFakeOpfs, findFakeByName } from "./fixtures/fake-opfs";
import {
    startChildProcess, stopChildProcesses, setChildRegistrySink, type ChildBoot,
} from "../../src/worker/core/child-process";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

afterEach(async () => { await stopChildProcesses(); setChildRegistrySink(undefined); });

/** A child store wired to an owner exactly as the child worker wires it at boot. */
function wired(): { owner: RegistryStore; child: RegistryStore; ownerChanges: number } {
    const owner = new RegistryStore();
    const child = new RegistryStore();
    const counter = { n: 0 };
    owner.setGameId("gog:1");
    owner.setOnChange(() => { counter.n++; });
    child.restore(owner.serialize());
    child.setMutationSink((m) => owner.applyMutation(m));
    return { owner, child, get ownerChanges() { return counter.n; } };
}

describe("a child process writes the parent's hive", () => {
    test("RegSetValueEx on the child reaches the owner and triggers its persistence", () => {
        const w = wired();
        const { key } = w.child.createKey("HKCU", "Software\\Illusion Softworks\\Mafia");
        w.child.setValue(key, "LS3D_setup", { name: "LS3D_setup", type: "REG_BINARY", data: "1400000400" });

        const ownerKey = w.owner.open("HKCU", "Software\\Illusion Softworks\\Mafia");
        expect(ownerKey).not.toBeNull();
        expect(w.owner.getValue(ownerKey!, "LS3D_setup")?.data).toBe("1400000400");
        // The owner's onChange is the autosave trigger — a value that arrives without it
        // is in memory only, which is the whole defect.
        expect(w.ownerChanges).toBeGreaterThan(0);
    });

    test("deletes propagate too, so the owner never keeps a value the guest removed", () => {
        const w = wired();
        const { key } = w.child.createKey("HKCU", "Software\\Test");
        w.child.setValue(key, "Keep", { name: "Keep", type: "REG_DWORD", data: 1 });
        w.child.setValue(key, "Drop", { name: "Drop", type: "REG_DWORD", data: 2 });
        expect(w.child.deleteValue(key, "Drop")).toBe(true);

        const ownerKey = w.owner.open("HKCU", "Software\\Test")!;
        expect(w.owner.getValue(ownerKey, "Keep")?.data).toBe(1);
        expect(w.owner.getValue(ownerKey, "Drop")).toBeNull();

        expect(w.child.deleteKey("hkcu\\software\\test")).toBe(true);
        expect(w.owner.open("HKCU", "Software\\Test")).toBeNull();
    });

    test("a grandchild's write forwards through its parent to the root", () => {
        const root = new RegistryStore();
        root.setGameId("gog:1");
        const middle = new RegistryStore();
        const leaf = new RegistryStore();
        middle.setMutationSink((m) => root.applyMutation(m));
        leaf.setMutationSink((m) => middle.applyMutation(m));

        const { key } = leaf.createKey("HKCU", "Software\\Deep");
        leaf.setValue(key, "V", { name: "V", type: "REG_DWORD", data: 7 });

        expect(root.getValue(root.open("HKCU", "Software\\Deep")!, "V")?.data).toBe(7);
    });
});

describe("only the owner writes the container", () => {
    test("flush() persists when a gameId is held", async () => {
        const root = installFakeOpfs();
        const owner = new RegistryStore();
        owner.setGameId("gog:1");
        const { key } = owner.createKey("HKCU", "Software\\Test");
        owner.setValue(key, "V", { name: "V", type: "REG_SZ", data: "kept" });

        await owner.flush();

        const file = findFakeByName(root, "registry.json");
        expect(file).not.toBeNull();
        const state = JSON.parse(new TextDecoder().decode(file!.data));
        expect(state.gameId).toBe("gog:1");
        expect(state.keys["hkcu\\software\\test"].v.data).toBe("kept");
    });

    test("a child's store holds no gameId, so flush() writes nothing", async () => {
        const root = installFakeOpfs();
        const child = new RegistryStore();
        const { key } = child.createKey("HKCU", "Software\\Test");
        child.setValue(key, "V", { name: "V", type: "REG_SZ", data: "local" });

        await child.flush();

        expect(findFakeByName(root, "registry.json")).toBeNull();
    });
});

describe("the child_process route carries the mutation", () => {
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        onmessageerror: (() => void) | null = null;
        boot: ChildBoot | null = null;
        postMessage(message: any) { if (message.type === "child_boot") this.boot = message; }
        terminate() { /* nothing to release in the fake */ }
    }

    function filesystem() {
        const bytes = Uint8Array.from([0x4d, 0x5a, 3, 4, 5]);
        const entry = {
            name: "rom/helper.exe", uncompressedSize: bytes.length, compressedSize: bytes.length,
            compression: 0, localHeaderOffset: 0, isDirectory: false,
        } as ZipEntry;
        const vfs = new VirtualFileSystem();
        vfs.mountRom({
            readEntryRangeSync: (_e: ZipEntry, o: number, l: number) => bytes.slice(o, o + l),
            readEntryRange: async (_e: ZipEntry, o: number, l: number) => bytes.slice(o, o + l),
        } as unknown as ZipArchive, "rom", new Map([["helper.exe", entry]]));
        return vfs;
    }

    test("a child_registry message is applied to the registered store", async () => {
        const owner = new RegistryStore();
        owner.setGameId("gog:1");
        setChildRegistrySink((m: RegistryMutation) => owner.applyMutation(m));

        const worker = new FakeWorker();
        startChildProcess(filesystem(), {
            imagePath: "C:\\helper.exe", commandLine: "", currentDirectory: "C:\\",
        }, () => worker as unknown as Worker);
        for (let i = 0; i < 100 && !worker.boot; i++) await new Promise((r) => setTimeout(r, 1));
        expect(worker.boot).not.toBeNull();

        worker.onmessage?.({ data: { type: "child_registry", mutation: { op: "createKey", root: "HKCU", path: "Software\\Wired" } } });
        worker.onmessage?.({
            data: {
                type: "child_registry",
                mutation: { op: "setValue", key: "hkcu\\software\\wired", name: "V", value: { name: "V", type: "REG_DWORD", data: 42 } },
            },
        });

        const key = owner.open("HKCU", "Software\\Wired");
        expect(key).not.toBeNull();
        expect(owner.getValue(key!, "V")?.data).toBe(42);
    });
});
