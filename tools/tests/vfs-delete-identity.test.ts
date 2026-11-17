import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { FakeDirHandle, installFakeOpfs } from "./fixtures/fake-opfs";

let root: FakeDirHandle, vfs: VirtualFileSystem, overlay: any, seq = 0;
let navigatorBefore: PropertyDescriptor | undefined;
const removeEntry = FakeDirHandle.prototype.removeEntry;
function disk(): any { return overlay.root; }
async function physical(path: string): Promise<any> {
    let node: any = disk();
    for (const component of path.split("/").filter(Boolean)) node = node?.children.get(component);
    return node;
}
async function mkdirs(): Promise<void> {
    expect(vfs.createDirectorySync("C:\\Save").ok).toBe(true);
    expect(vfs.createDirectorySync("C:\\Save\\Current").ok).toBe(true);
    await overlay.ensureDirectory("C:\\Save\\Current");
}
function write(path: string, bytes = [25, 0, 0, 0]): any {
    const h = vfs.openSync(path, 0x40000000, 2)!;
    expect(h).toBeTruthy();
    expect(vfs.writeSync(h, new Uint8Array(bytes))).toBe(bytes.length);
    return h;
}
beforeEach(async () => {
    navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    root = installFakeOpfs();
    // The shared fake ignores nonempty directories. Model this rule locally only.
    FakeDirHandle.prototype.removeEntry = async function(name, opts) {
        const child = this.children.get(name);
        if (child?.kind === "directory" && child.children.size && !opts?.recursive) {
            const error = new Error("directory not empty");
            error.name = "InvalidModificationError";
            throw error;
        }
        return removeEntry.call(this, name, opts);
    };
    vfs = new VirtualFileSystem();
    vfs.mountRom(null as any, "rom", new Map());
    await vfs.initOverlay("delete-contract-" + ++seq);
    overlay = (vfs as any).overlay;
});
afterEach(async () => {
    try { await overlay?.close(); }
    finally {
        FakeDirHandle.prototype.removeEntry = removeEntry;
        if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});

describe("overlay deletion uses physical identity and settles admitted writes", () => {
    test("canonical file and empty directory removal is durable", async () => {
        await mkdirs();
        write("C:\\Save\\Current\\DATA.SAV");
        await vfs.flushAll();
        expect(await vfs.deleteFile("C:\\Save\\Current\\DATA.SAV")).toBe(true);
        expect(await physical("C/Save/Current/DATA.SAV")).toBeUndefined();
        expect(await vfs.removeDirectory("C:\\Save\\Current")).toEqual({ ok: true });
        expect(await physical("C/Save/Current")).toBeUndefined();
        await overlay.loadIndex();
        expect(vfs.statEntry("C:\\Save\\Current")).toBeNull();
    });

    test("file deletion resolves parent and leaf case without leaving hidden bytes", async () => {
        await mkdirs();
        write("C:\\Save\\Current\\DATA.SAV");
        await vfs.flushAll();
        expect(await vfs.deleteFile("C:\\sAvE\\cUrReNt\\data.sav")).toBe(true);
        expect(await physical("C/Save/Current/DATA.SAV")).toBeUndefined();
        await overlay.loadIndex();
        expect(vfs.statEntry("C:\\Save\\Current\\DATA.SAV")).toBeNull();
    });

    test("directory deletion resolves case and leaves no phantom parent child", async () => {
        await mkdirs();
        expect(await vfs.removeDirectory("C:\\save\\current")).toEqual({ ok: true });
        expect(await physical("C/Save/Current")).toBeUndefined();
        expect(await vfs.removeDirectory("C:\\Save")).toEqual({ ok: true });
        expect(await physical("C/Save")).toBeUndefined();
    });

    test("mutable index spelling does not replace physical path identity", async () => {
        await mkdirs();
        const h = write("C:\\Save\\Current\\DATA.SAV");
        await vfs.flushAll();
        // Existing handles ordinarily retain spelling; exercise the overlay's public
        // write route with another spelling, which currently updates entry.path.
        overlay.writeFileSync("C:\\sAvE\\cUrReNt\\data.sav", 0, new Uint8Array([99]));
        expect(overlay.getEntry(h.path).path).toBe("C:\\sAvE\\cUrReNt\\data.sav");
        // The admitted writer's spelling is also intentionally varied. Deletion
        // must not manufacture a second hierarchy just to flush this replacement.
        await vfs.deleteFile(h.path);
        expect(await physical("C/Save/Current/DATA.SAV")).toBeUndefined();
        expect(await physical("C/sAvE")).toBeUndefined();
        await overlay.loadIndex();
        expect(vfs.statEntry(h.path)).toBeNull();
    });

    test("case-colliding physical entries fail explicitly and preserve both", async () => {
        await mkdirs();
        write("C:\\Save\\Current\\DATA.SAV");
        await vfs.flushAll();
        const current = await physical("C/Save/Current");
        await current.getFileHandle("data.sav", { create: true });
        await expect(vfs.deleteFile("C:\\Save\\Current\\DATA.SAV")).rejects.toThrow("case");
        expect(await physical("C/Save/Current/DATA.SAV")).toBeTruthy();
        expect(await physical("C/Save/Current/data.sav")).toBeTruthy();
        expect(vfs.statEntry("C:\\Save\\Current\\DATA.SAV")).toBeTruthy();
    });

    test("stale directory metadata cannot delete a physical file", async () => {
        write("C:\\different.bin", [7, 8]);
        await vfs.flushAll();
        overlay.entries.set("c:\\different.bin", { path: "C:\\different.bin", kind: "dir", size: 0 });
        await expect(vfs.removeDirectory("C:\\different.bin")).rejects.toMatchObject({ name: "TypeMismatchError" });
        const file = await physical("C/different.bin");
        expect(file.kind).toBe("file");
        expect([...file.file.data]).toEqual([7, 8]);
        expect(overlay.getEntry("C:\\different.bin")).toBeTruthy();
    });

    test("stale file metadata cannot delete a physical directory", async () => {
        await mkdirs();
        overlay.entries.set("c:\\save\\current", { path: "C:\\Save\\Current", kind: "file", size: 0 });
        await expect(vfs.deleteFile("C:\\Save\\Current")).rejects.toMatchObject({ name: "TypeMismatchError" });
        expect((await physical("C/Save/Current")).kind).toBe("directory");
        expect(overlay.getEntry("C:\\Save\\Current")).toBeTruthy();
    });

    test("nonempty directories and missing entries retain normal failure semantics", async () => {
        await mkdirs();
        write("C:\\Save\\Current\\DATA.SAV");
        await vfs.flushAll();
        expect(await vfs.removeDirectory("C:\\Save\\Current")).toEqual({ ok: false, error: 145 });
        expect(await vfs.deleteFile("C:\\missing.bin")).toBe(false);
        expect(await physical("C/Save/Current/DATA.SAV")).toBeTruthy();
    });

    test("delete awaits an existing lazy close commit before removing its bytes", async () => {
        const h = write("C:\\pending.bin");
        const original = overlay.ensureSyncHandle;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let entered = false, deleted = false;
        overlay.ensureSyncHandle = async function(...args: unknown[]) {
            entered = true; await gate; return original.apply(this, args);
        };
        const closing = vfs.flushFile(h.path);
        expect(entered).toBe(true);
        const deleting = vfs.deleteFile(h.path).then(value => { deleted = true; return value; });
        try {
            for (let i = 0; i < 8; i++) await Promise.resolve();
            expect(deleted).toBe(false);
            release();
            expect(await deleting).toBe(true);
            await closing;
            expect(await physical("C/pending.bin")).toBeUndefined();
            await overlay.loadIndex();
            expect(vfs.statEntry(h.path)).toBeNull();
        } finally { release(); await Promise.allSettled([closing, deleting]); overlay.ensureSyncHandle = original; }
    });

    test("a successor writer behind a close commit is drained without self-deadlock", async () => {
        const h = write("C:\\successor.bin", [1]);
        const original = overlay.ensureSyncHandle;
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        overlay.ensureSyncHandle = async function(...args: unknown[]) { await gate; return original.apply(this, args); };
        const closing = vfs.flushFile(h.path);
        expect(vfs.writeSync(h, new Uint8Array([2]))).toBe(1);
        const deleting = vfs.deleteFile(h.path);
        try {
            release();
            expect(await deleting).toBe(true);
            await closing;
            await vfs.flushAll();
            expect(await physical("C/successor.bin")).toBeUndefined();
            await overlay.loadIndex();
            expect(vfs.statEntry(h.path)).toBeNull();
        } finally { release(); await Promise.allSettled([closing, deleting]); overlay.ensureSyncHandle = original; }
    });

    test("a rejected admitted commit propagates instead of deleting metadata or bytes", async () => {
        const h = write("C:\\failed.bin");
        await vfs.flushAll();
        const failure = new Error("actual commit refusal");
        const pending = Promise.reject(failure); void pending.catch(() => {});
        overlay.pendingFlushes.set("c:\\failed.bin", pending);
        try {
            await expect(vfs.deleteFile(h.path)).rejects.toBe(failure);
            expect(overlay.pendingFlushes.get("c:\\failed.bin")).toBe(pending);
            expect(vfs.statEntry(h.path)).toBeTruthy();
            expect(await physical("C/failed.bin")).toBeTruthy();
        } finally { overlay.pendingFlushes.delete("c:\\failed.bin"); }
    });

    test("new files under differently cased existing parents share one physical hierarchy", async () => {
        await mkdirs();
        write("C:\\save\\current\\one.bin", [1]);
        write("C:\\SAVE\\CURRENT\\two.bin", [2]);
        await vfs.flushAll();
        expect(await physical("C/Save/Current/one.bin")).toBeTruthy();
        expect(await physical("C/Save/Current/two.bin")).toBeTruthy();
        expect(await physical("C/save")).toBeUndefined();
        expect(await physical("C/SAVE")).toBeUndefined();
    });

    test("concurrent mkdir cannot race enumeration against the actual physical create", async () => {
        const original = FakeDirHandle.prototype.getDirectoryHandle;
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const ready = new Promise<void>(r => { entered = r; });
        let held = false;
        FakeDirHandle.prototype.getDirectoryHandle = async function(name, opts) {
            if (!held && name === "Save" && opts?.create) {
                held = true; entered(); await gate;
            }
            return original.call(this, name, opts);
        };
        const first = overlay.ensureDirectory("C:\\Save\\Current");
        try {
            await ready; // hold BEFORE the fake actually creates Save
            const second = overlay.ensureDirectory("C:\\save\\current");
            for (let i = 0; i < 8; i++) await Promise.resolve();
            release();
            await Promise.all([first, second]);
            const c = await physical("C");
            expect([...c.children.keys()]).toEqual(["Save"]);
            expect([...c.children.get("Save").children.keys()]).toEqual(["Current"]);
        } finally { release(); await first; FakeDirHandle.prototype.getDirectoryHandle = original; }
    });

    test("a physical file in a parent component is refused without destroying its bytes", async () => {
        write("C:\\parent.bin", [7, 8, 9]);
        await vfs.flushAll();
        await expect(overlay.ensureDirectory("C:\\PARENT.BIN\\child")).rejects.toMatchObject({ name: "TypeMismatchError" });
        const file = await physical("C/parent.bin");
        expect(file.kind).toBe("file");
        expect([...file.file.data]).toEqual([7, 8, 9]);
        expect(await physical("C/PARENT.BIN")).toBeUndefined();
    });

    test("case-colliding parents reject create without changing either directory", async () => {
        await mkdirs();
        const c = await physical("C");
        await c.getDirectoryHandle("save", { create: true });
        await expect(overlay.ensureDirectory("C:\\SAVE\\new")).rejects.toThrow("case");
        expect((await physical("C/Save")).children.has("new")).toBe(false);
        expect((await physical("C/save")).children.has("new")).toBe(false);
        expect(await physical("C/SAVE")).toBeUndefined();
    });

    test("delete then recreate honors the new physical spelling without stale path cache", async () => {
        await mkdirs();
        expect(await vfs.removeDirectory("C:\\Save\\Current")).toEqual({ ok: true });
        expect(await vfs.removeDirectory("C:\\Save")).toEqual({ ok: true });
        expect(vfs.createDirectorySync("C:\\save").ok).toBe(true);
        await overlay.ensureDirectory("C:\\save");
        write("C:\\SAVE\\new.bin", [3]);
        await vfs.flushAll();
        expect(await physical("C/save/new.bin")).toBeTruthy();
        expect(await physical("C/Save")).toBeUndefined();
        expect(await physical("C/SAVE")).toBeUndefined();
        expect(await vfs.deleteFile("C:\\SAVE\\NEW.BIN")).toBe(true);
        expect(await physical("C/save/new.bin")).toBeUndefined();
    });

    test("unflushed buffered output is deleted without later resurrection", async () => {
        const h = write("C:\\buffered.bin");
        expect(await vfs.deleteFile(h.path)).toBe(true);
        await vfs.flushAll();
        expect(await physical("C/buffered.bin")).toBeUndefined();
        await overlay.loadIndex();
        expect(vfs.statEntry(h.path)).toBeNull();
    });
});
