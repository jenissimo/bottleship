import {afterEach, beforeEach, expect, test} from "bun:test";
import {VirtualFileSystem} from "../../src/worker/runtime/filesystem/vfs";
import {FakeDirHandle, installFakeOpfs} from "./fixtures/fake-opfs";
import fs from "node:fs";

let vfs: VirtualFileSystem, overlay: any, folder: FakeDirHandle;
let navigatorBefore: PropertyDescriptor | undefined;
const originalEntries = FakeDirHandle.prototype.entries;
let sequence = 0;
beforeEach(async () => {
    navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    installFakeOpfs();
    vfs = new VirtualFileSystem();
    vfs.mountRom(null as any, "rom", new Map());
    await vfs.initOverlay("name-index-" + ++sequence);
    overlay = (vfs as any).overlay;
    const drive = await overlay.root.getDirectoryHandle("C", {create: true});
    folder = await drive.getDirectoryHandle("Files", {create: true});
    await overlay.loadIndex(); // Make the externally prepared parent visible to VFS admission.
});
afterEach(async () => {
    FakeDirHandle.prototype.entries = originalEntries;
    try { await overlay.close(); }
    finally {
        if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});
async function physical(name: string, bytes: number[] = [7]) {
    const h = await folder.getFileHandle(name, {create: true});
    h.file.data = new Uint8Array(bytes);
    return h;
}
function write(name: string, bytes: number[]) {
    const path = "C:\\Files\\" + name;
    const h = vfs.openSync(path, 0x40000000, 2)!;
    expect(h).toBeTruthy();
    expect(vfs.writeSync(h, new Uint8Array(bytes))).toBe(bytes.length);
    return path;
}

test("one complete directory enumeration serves many distinct cold file opens", async () => {
    const n = 64;
    for (let i = 0; i < n; i++) await physical("File" + i + ".bin", [i]);
    let enumerations = 0, yielded = 0;
    FakeDirHandle.prototype.entries = async function* () {
        if (this === folder) enumerations++;
        for await (const pair of originalEntries.call(this)) {
            if (this === folder) yielded++;
            yield pair;
        }
    };
    // Includes the canonical initial metadata scan, not an uncounted warmup.
    await overlay.loadIndex();
    for (let i = 0; i < n; i++) {
        expect([...await overlay.readFile("C:\\fIlEs\\file" + i + ".BIN", 0, 1)]).toEqual([i]);
    }
    const evidence = {files: n, enumerations, yielded, expectedAllBytes: true,
        scope: "actual OPFS overlay with synthetic filesystem; no wall-clock or FPS claim"};
    const phase = process.env.BS_OPFS_NAME_INDEX_PHASE;
    if (phase) {
        fs.mkdirSync("logs/name-index", {recursive: true});
        fs.writeFileSync("logs/name-index/" + phase + "-counter.json", JSON.stringify(evidence, null, 2), {flag: "wx"});
    }
    expect(enumerations).toBe(1);
    expect(yielded).toBe(n);
});

test("a snapshot records all physical case collisions rather than choosing a winner", async () => {
    await physical("Leaf.bin", [1]); await physical("leaf.bin", [2]);
    await overlay.loadIndex();
    await expect(overlay.readFile("C:\\Files\\LEAF.BIN", 0, 1)).rejects.toThrow("case");
});

test("refresh detects an external case twin even with an authoritative content cache", async () => {
    const path = write("Leaf.bin", [7]); await vfs.flushAll();
    expect([...await overlay.readFile(path, 0, 1)]).toEqual([7]);
    await physical("leaf.bin", [9]);
    await overlay.loadIndex();
    await expect(overlay.readFile(path, 0, 1)).rejects.toThrow("case");
    expect(() => overlay.readFileSyncVia(path, 0, 1)).toThrow("case");
    expect(folder.children.size).toBe(2);
});

test("external collision after a cached read still refuses destructive removal", async () => {
    await physical("Leaf.bin", [1]); await overlay.loadIndex();
    expect([...await overlay.readFile("C:\\Files\\Leaf.bin", 0, 1)]).toEqual([1]);
    await physical("leaf.bin", [2]);
    await expect(vfs.deleteFile("C:\\Files\\Leaf.bin")).rejects.toThrow("case");
    expect([...folder.children.keys()]).toEqual(["Leaf.bin", "leaf.bin"]);
});

test("external parent collision after a cached read refuses create", async () => {
    await physical("Leaf.bin", [1]); await overlay.loadIndex();
    await overlay.readFile("C:\\Files\\Leaf.bin", 0, 1);
    const drive = await overlay.root.getDirectoryHandle("C");
    const other = await drive.getDirectoryHandle("files", {create: true});
    await expect(overlay.ensureDirectory("C:\\FILES\\New")).rejects.toThrow("case");
    expect(folder.children.has("New")).toBe(false);
    expect(other.children.size).toBe(0);
});

test("owned create/delete invalidates names and honours a new physical spelling", async () => {
    await physical("Old.bin", [1]); await overlay.loadIndex();
    await overlay.readFile("C:\\Files\\Old.bin", 0, 1);
    expect(await vfs.deleteFile("C:\\Files\\OLD.BIN")).toBe(true);
    const path = write("old.BIN", [8]); await vfs.flushAll();
    expect([...await overlay.readFile(path, 0, 1)]).toEqual([8]);
    expect([...folder.children.keys()]).toEqual(["old.BIN"]);
});

test("existing content cache is a session snapshot, not external immediate read coherence", async () => {
    const path = write("Cached.bin", [7]); await vfs.flushAll();
    const h = await folder.getFileHandle("Cached.bin");
    h.file.data = new Uint8Array([9]); // Out-of-band mutation, outside the VFS owner.
    expect([...await overlay.readFile(path, 0, 1)]).toEqual([7]);
});

test("read-side index is dropped on explicit refresh and close", async () => {
    await physical("One.bin", [1]); await overlay.loadIndex();
    await overlay.readFile("C:\\Files\\One.bin", 0, 1);
    await folder.removeEntry("One.bin"); await physical("Two.bin", [2]);
    await overlay.loadIndex();
    await expect(overlay.getFileHandle("C:\\Files\\One.bin", false)).rejects.toBeTruthy();
    expect([...await overlay.readFile("C:\\Files\\Two.bin", 0, 1)]).toEqual([2]);
    await overlay.close();
    expect(overlay.directoryNameIndexes?.size ?? 0).toBe(0);
});
