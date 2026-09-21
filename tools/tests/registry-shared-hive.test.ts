/**
 * The registry is ONE object shared by the whole process tree. Forwarding a child's write
 * up to the owner covers persistence, but not visibility: a parent that writes while its
 * child runs was invisible to that child's copy, so the two processes disagreed about the
 * hive they are both supposed to be reading.
 *
 * The relay is flooding on the process tree: apply, then hand the mutation to every
 * neighbour EXCEPT the one it came from. A tree has no cycles, so it terminates and every
 * store converges; drop the exclusion and a parent and child trade one write forever.
 *
 * What must NOT come back: a child's store owns no container, so it must still never write
 * the owner's registry.json — flush() refuses without a gameId, and nothing here hands one
 * down.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RegistryStore, type RegistryMutation } from "../../src/worker/runtime/filesystem/registry";
import { installFakeOpfs, findFakeByName } from "./fixtures/fake-opfs";
import {
    startChildProcess, stopChildProcesses, setChildRegistrySink, forwardRegistryToChildren,
    type ChildBoot,
} from "../../src/worker/core/child-process";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

afterEach(async () => { await stopChildProcesses(); setChildRegistrySink(undefined); });

const dword = (name: string, data: number): RegistryValueLike => ({ name, type: "REG_DWORD", data });
type RegistryValueLike = { name: string; type: "REG_DWORD"; data: number };

/**
 * A parent and its children, wired exactly as the workers wire themselves: each child
 * forwards up tagged with its own id, and the parent relays down to all but that id.
 */
function tree(parent: RegistryStore, children: RegistryStore[]): void {
    const relays = new Map<number, RegistryStore>();
    children.forEach((child, index) => {
        const id = index + 1;
        relays.set(id, child);
        child.setMutationSink(m => parent.applyMutation(m, { from: "child", id }));
    });
    parent.setDownstreamSink((m, except) => {
        for (const [id, child] of relays) if (id !== except) child.applyMutation(m, { from: "owner" });
    });
}

function read(store: RegistryStore, path: string, name: string): unknown {
    const key = store.open("HKCU", path);
    return key === null ? null : store.getValue(key, name)?.data ?? null;
}

describe("the hive is shared in both directions", () => {
    test("a parent's write while a child runs is visible to that child", () => {
        const parent = new RegistryStore();
        parent.setGameId("gog:1");
        const child = new RegistryStore();
        child.restore(parent.serialize());
        tree(parent, [child]);

        const { key } = parent.createKey("HKCU", "Software\\Shared");
        parent.setValue(key, "V", dword("V", 5));

        expect(read(child, "Software\\Shared", "V")).toBe(5);
    });

    test("a write converges on every process and stops there", () => {
        const parent = new RegistryStore();
        const a = new RegistryStore();
        const b = new RegistryStore();
        tree(parent, [a, b]);

        // A write from one child must reach the parent AND the sibling — and must not
        // come back to its origin, which is what an unterminated relay looks like.
        let applied = 0;
        parent.setOnChange(() => { applied++; });

        const { key } = a.createKey("HKCU", "Software\\Fan");
        a.setValue(key, "V", dword("V", 9));

        expect(read(parent, "Software\\Fan", "V")).toBe(9);
        expect(read(b, "Software\\Fan", "V")).toBe(9);
        expect(read(a, "Software\\Fan", "V")).toBe(9);
        // createKey + setValue, each once. A bouncing relay reapplies without bound.
        expect(applied).toBe(2);
    });

    test("a grandchild still reaches the root, and the root reaches the grandchild", () => {
        const root = new RegistryStore();
        root.setGameId("gog:1");
        const middle = new RegistryStore();
        const leaf = new RegistryStore();
        tree(root, [middle]);
        tree(middle, [leaf]);

        const up = leaf.createKey("HKCU", "Software\\Deep");
        leaf.setValue(up.key, "Up", dword("Up", 7));
        expect(read(root, "Software\\Deep", "Up")).toBe(7);
        expect(read(middle, "Software\\Deep", "Up")).toBe(7);

        const down = root.createKey("HKCU", "Software\\Top");
        root.setValue(down.key, "Down", dword("Down", 3));
        expect(read(middle, "Software\\Top", "Down")).toBe(3);
        expect(read(leaf, "Software\\Top", "Down")).toBe(3);
    });

    test("a child that received the owner's write still owns no container", async () => {
        const opfs = installFakeOpfs();
        const parent = new RegistryStore();
        parent.setGameId("gog:1");
        const child = new RegistryStore();
        tree(parent, [child]);

        const { key } = parent.createKey("HKCU", "Software\\Shared");
        parent.setValue(key, "V", dword("V", 1));
        expect(read(child, "Software\\Shared", "V")).toBe(1);

        await child.flush();
        expect(findFakeByName(opfs, "registry.json")).toBeNull();
    });
});

describe("the child_process route carries the write downward", () => {
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        onmessageerror: (() => void) | null = null;
        boot: ChildBoot | null = null;
        down: RegistryMutation[] = [];
        postMessage(message: any) {
            if (message.type === "child_boot") this.boot = message;
            else if (message.type === "child_registry_down") this.down.push(message.mutation);
        }
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

    async function spawn(worker: FakeWorker) {
        startChildProcess(filesystem(), {
            imagePath: "C:\\helper.exe", commandLine: "", currentDirectory: "C:\\",
        }, () => worker as unknown as Worker);
        for (let i = 0; i < 100 && !worker.boot; i++) await new Promise(r => setTimeout(r, 1));
        expect(worker.boot).not.toBeNull();
    }

    test("an owner write is posted to every live child", async () => {
        const worker = new FakeWorker();
        await spawn(worker);

        const owner = new RegistryStore();
        owner.setGameId("gog:1");
        owner.setDownstreamSink(forwardRegistryToChildren);
        const { key } = owner.createKey("HKCU", "Software\\Live");
        owner.setValue(key, "V", dword("V", 11));

        expect(worker.down.map(m => m.op)).toEqual(["createKey", "setValue"]);
    });

    test("a child's own write is not posted back to it", async () => {
        const worker = new FakeWorker();
        await spawn(worker);

        const owner = new RegistryStore();
        owner.setGameId("gog:1");
        owner.setDownstreamSink(forwardRegistryToChildren);
        setChildRegistrySink((m, childId) => owner.applyMutation(m, { from: "child", id: childId }));

        worker.onmessage?.({ data: { type: "child_registry", mutation: { op: "createKey", root: "HKCU", path: "Software\\Mine" } } });

        expect(read(owner, "Software\\Mine", "anything")).toBeNull();
        expect(owner.open("HKCU", "Software\\Mine")).not.toBeNull();
        expect(worker.down).toEqual([]);
    });
});
