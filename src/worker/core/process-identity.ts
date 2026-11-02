export interface ProcessIdentityBoot { pid: number; parentPid: number; rootPid: number; ids: SharedArrayBuffer; }
export class SharedProcessIds {
    readonly buffer: SharedArrayBuffer;
    private readonly words: Int32Array;
    constructor(buffer?: SharedArrayBuffer) {
        this.buffer = buffer ?? new SharedArrayBuffer(4);
        if (this.buffer.byteLength !== 4) throw new Error("Invalid process identity allocator");
        this.words = new Int32Array(this.buffer);
        if (!buffer) Atomics.store(this.words, 0, 5000);
    }
    allocate(): number {
        for (;;) {
            const pid = Atomics.load(this.words, 0);
            if (pid < 1 || pid >= 0x7fffffff) throw new Error("Virtual process IDs exhausted");
            if (Atomics.compareExchange(this.words, 0, pid, pid + 1) === pid) return pid;
        }
    }
}
let allocator = new SharedProcessIds();
export let currentProcessId = 1234;
let parentPid = 0, rootPid = currentProcessId;
export function allocateProcessId(): number { return allocator.allocate(); }
export function getProcessIdentity(): ProcessIdentityBoot { return { pid: currentProcessId, parentPid, rootPid, ids: allocator.buffer }; }
export function childProcessIdentity(pid = allocateProcessId()): ProcessIdentityBoot {
    return { pid, parentPid: currentProcessId, rootPid, ids: allocator.buffer };
}
export function adoptProcessIdentity(boot: ProcessIdentityBoot): void {
    if (!Number.isInteger(boot.pid) || boot.pid < 1 || boot.pid > 0x7fffffff || !Number.isInteger(boot.parentPid) ||
        !Number.isInteger(boot.rootPid) || boot.rootPid < 1) throw new Error("Invalid child process identity");
    allocator = new SharedProcessIds(boot.ids); currentProcessId = boot.pid; parentPid = boot.parentPid; rootPid = boot.rootPid;
}
