/**
 * flushAll() is the teardown barrier every child-process exit and guest exit runs
 * through, so a commit that can never settle is not a slow flush — it is a hang with no
 * upper bound.
 *
 * One shape reaches that. A CloseHandle commit (flushFile) registers itself in
 * pendingFlushes and then awaits the entry's flushInFlight; that buffer flush reaches
 * ensureWriter; and ensureWriter's NoModificationAllowedError recovery awaits
 * pendingFlushes for the same path — which is the commit awaiting it. The path's whole
 * chain then never settles, and neither does flushAll.
 *
 * A guest that rewrites one file in a loop (any engine's log) supplies the commit
 * traffic and any transient OPFS lock conflict on that file supplies the refusal, so it
 * is reachable on every title. Far Cry hit it on c:\log.txt while its shader-compiler
 * child process was exiting; that child flushes through the parent, so its exit never
 * completed and the engine polled for the compile forever without ever presenting.
 *
 * The invariant: a commit that is ON THE STACK for a path is not something the recovery
 * may wait for. This drives that seam directly rather than recreating the race, so the
 * assertion is deterministic — a timing-shaped version of it passed against the bug.
 */
import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive } from "@bottleship/formats/zip";
import { installFakeOpfs } from "./fixtures/fake-opfs";

const GENERIC_WRITE = 0x40000000;
const CREATE_ALWAYS = 2;

let seq = 0;

interface OverlayInternals {
    pendingFlushes: Map<string, Promise<void>>;
    committingPaths: Set<string>;
    writerCache: Map<string, unknown>;
    flushWriteBuffer(entry: unknown): Promise<void>;
}

async function overlayWithBufferedWrite(name: string) {
    const gameId = `test:flushre${++seq}`;
    installFakeOpfs();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(null as unknown as ZipArchive, "rom", new Map());
    await vfs.initOverlay(gameId);

    const h = vfs.openSync(`C:\\${name}`, GENERIC_WRITE, CREATE_ALWAYS)!;
    vfs.writeSync(h, new Uint8Array([1, 2, 3, 4]));

    const overlay = (vfs as unknown as { overlay: OverlayInternals }).overlay;
    const key = `c:\\${name}`.toLowerCase();
    const entry = overlay.writerCache.get(key);
    expect(entry).toBeDefined();
    return { vfs, overlay, key, entry };
}

function noModificationAllowed(): Error {
    const e = new Error("locked");
    (e as unknown as { name: string }).name = "NoModificationAllowedError";
    return e;
}

/** Refuse the first createWritable for this file, then behave: the transient conflict
 *  ensureWriter's recovery exists to ride out. */
function refuseFirstWritable(overlay: unknown, path: string): void {
    const o = overlay as { getFileHandle(p: string, c?: boolean): Promise<Record<string, unknown>> };
    const original = o.getFileHandle.bind(o);
    let refused = false;
    o.getFileHandle = async (p: string, c?: boolean) => {
        const handle = await original(p, c);
        if (p.toLowerCase() !== path.toLowerCase()) return handle;
        const createWritable = (handle.createWritable as (opts?: unknown) => Promise<unknown>).bind(handle);
        handle.createWritable = async (opts?: unknown) => {
            if (!refused) { refused = true; throw noModificationAllowed(); }
            return createWritable(opts);
        };
        return handle;
    };
}

/** Resolves to "hung" rather than hanging the suite, so a regression states a verdict. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
    return Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);
}

describe("a commit chain never awaits itself", () => {
    test("ensureWriter's lock-conflict recovery does not await the commit it runs under", async () => {
        const { overlay, key, entry } = await overlayWithBufferedWrite("log.txt");
        refuseFirstWritable(overlay, "C:\\log.txt");

        // The state flushFile establishes before awaiting flushInFlight: its own commit is
        // registered for this path and is on the stack. It cannot settle until this buffer
        // flush does, so a recovery that awaited it would close the cycle.
        let release!: () => void;
        const ownCommit = new Promise<void>((r) => { release = r; });
        overlay.pendingFlushes.set(key, ownCommit);
        overlay.committingPaths.add(key);
        try {
            expect(await within(overlay.flushWriteBuffer(entry), 3000)).not.toBe("hung");
        } finally {
            overlay.committingPaths.delete(key);
            overlay.pendingFlushes.delete(key);
            release();
        }
    });

    test("a commit for a path NOT on the stack is still awaited", async () => {
        const { overlay, key, entry } = await overlayWithBufferedWrite("other.txt");
        refuseFirstWritable(overlay, "C:\\other.txt");

        // Nothing marked committing: this is an unrelated in-flight commit, and riding it
        // out is exactly what the recovery is for — so it must block until that settles.
        let release!: () => void;
        const unrelated = new Promise<void>((r) => { release = r; });
        overlay.pendingFlushes.set(key, unrelated);

        const flushing = overlay.flushWriteBuffer(entry);
        expect(await within(flushing, 250)).toBe("hung");
        release();
        overlay.pendingFlushes.delete(key);
        expect(await within(flushing, 3000)).not.toBe("hung");
    });
});
