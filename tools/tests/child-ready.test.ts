import { afterEach, expect, test } from "bun:test";
import { startChildProcess, stopChildProcesses, ChildProcessCancelled, type ChildBoot } from "../../src/worker/core/child-process";
import { closeProcessNetworkNamespace } from "../../src/worker/core/process-network";
import { getProcessIdentity } from "../../src/worker/core/process-identity";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

afterEach(async () => { await stopChildProcesses(); await closeProcessNetworkNamespace(); });

const turn = async () => { await Promise.resolve(); await Promise.resolve(); };
async function until(check: () => boolean): Promise<void> {
    for (let count = 0; count < 200 && !check(); count++) await Bun.sleep(1);
    expect(check()).toBe(true);
}
function filesystem(): VirtualFileSystem {
    const bytes = Uint8Array.of(0x4d, 0x5a, 1, 2, 3), vfs = new VirtualFileSystem();
    const entry = { name: "rom/child.exe", uncompressedSize: bytes.length, compressedSize: bytes.length, compression: 0, localHeaderOffset: 0 } as ZipEntry;
    vfs.mountRom({
        readEntryRange: async (_: unknown, offset: number, size: number) => bytes.slice(offset, offset + size),
        readEntryRangeSync: (_: unknown, offset: number, size: number) => bytes.slice(offset, offset + size),
    } as unknown as ZipArchive, "rom", new Map([["child.exe", entry]]));
    return vfs;
}
class WorkerBoundary {
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    boot: ChildBoot | null = null;
    messages: any[] = [];
    terminated = false;
    postMessage(message: any): void { this.messages.push(message); if (message.type === "child_boot") this.boot = message; }
    terminate(): void { this.terminated = true; }
    ready(bootId = this.boot!.bootId, processId = this.boot!.processIdentity!.pid): void {
        this.onmessage?.({ data: { type: "child_ready", bootId, processId } });
    }
    exit(exitCode: number): void { this.onmessage?.({ data: { type: "process_exit", exitCode } }); }
}
const request = { imagePath: "C:\\child.exe", currentDirectory: "C:\\", commandLine: "", startSuspended: true };

test("child readiness is fenced by boot token and PID; a ready suspended process never auto-resumes", async () => {
    const worker = new WorkerBoundary(), parentPid = getProcessIdentity().pid;
    const task = startChildProcess(filesystem(), request, () => worker as unknown as Worker);
    let ready = false;
    void task.ready.then(() => { ready = true; }, () => {});
    await until(() => !!worker.boot);
    worker.ready(worker.boot!.bootId + 1); worker.ready(worker.boot!.bootId, worker.boot!.processIdentity!.pid + 1);
    await turn();
    expect(ready).toBe(false);
    worker.ready(); await task.ready;
    expect(worker.messages.filter(message => message.type === "child_resume")).toHaveLength(0);
    task.resume!(); task.resume!();
    expect(worker.messages.filter(message => message.type === "child_resume")).toHaveLength(1);
    expect(getProcessIdentity().pid).toBe(parentPid);
    worker.exit(17);
    expect(await task.completion).toBe(17);
    expect(worker.terminated).toBe(true);
});

test("resume before boot is latched; another suspension revokes it until the next resume", async () => {
    const worker = new WorkerBoundary();
    const task = startChildProcess(filesystem(), request, () => worker as unknown as Worker);
    task.resume!(); task.holdStartup!();
    await until(() => !!worker.boot);
    worker.ready(); await task.ready;
    expect(worker.messages.filter(message => message.type === "child_resume")).toHaveLength(0);
    task.resume!();
    expect(worker.messages.filter(message => message.type === "child_resume")).toHaveLength(1);
    worker.exit(0); expect(await task.completion).toBe(0);
});

test("termination during image I/O rejects readiness immediately and cannot create a late Worker", async () => {
    const vfs = filesystem();
    let release!: (bytes: Uint8Array) => void, workers = 0;
    vfs.read = () => new Promise<Uint8Array>(resolve => { release = resolve; });
    const task = startChildProcess(vfs, request, () => { workers++; return new WorkerBoundary() as unknown as Worker; });
    const ready = task.ready.catch(error => error);
    await until(() => !!release);
    task.terminate(19);
    expect(await ready).toBeInstanceOf(ChildProcessCancelled);
    expect(workers).toBe(0);
    release(Uint8Array.of(0x4d, 0x5a, 1, 2, 3));
    expect(await task.completion).toBe(19);
    expect(workers).toBe(0);
});

test("Worker load failure rejects both readiness and completion while preserving the parent's identity", async () => {
    const worker = new WorkerBoundary(), parentPid = getProcessIdentity().pid;
    const task = startChildProcess(filesystem(), request, () => worker as unknown as Worker);
    const ready = task.ready.catch(error => error), completion = task.completion.catch(error => error);
    await until(() => !!worker.boot);
    worker.onerror?.({ message: "image failed" });
    expect(String(await ready)).toContain("image failed");
    expect(String(await completion)).toContain("image failed");
    expect(worker.terminated).toBe(true);
    expect(getProcessIdentity().pid).toBe(parentPid);
});
