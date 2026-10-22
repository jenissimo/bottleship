import { afterEach, expect, test } from "bun:test";
import { DirectPlaySendQueue, type QueuedSend, type SendCompletion } from "../../src/worker/modules/dplayx/send-queue";
import { DirectPlaySession, DP } from "../../src/worker/modules/dplayx/session";
import { LanNetwork } from "../../src/worker/net/lan-network";
const queues: DirectPlaySendQueue[] = [];
afterEach(() => { for (const queue of queues.splice(0)) queue.reset(); });
const job = (context: number, timeout = 0, flags = 0): QueuedSend => ({ from: 1, to: 2, flags, priority: 1, timeout, context, data: () => Uint8Array.of(context) });
const until = async (condition: () => boolean) => { const deadline = Date.now() + 2000; while (!condition()) { if (Date.now() >= deadline) throw Error("Send queue progress timeout"); await Bun.sleep(1); } };
test("job and byte admission include the active send, preserve rejected ownership and release cancelled capacity", async () => {
    let began!: () => void, release!: (hr: number) => void; const started = new Promise<void>(resolve => { began = resolve; }), completed: SendCompletion[] = [];
    const queue = new DirectPlaySendQueue(() => { began(); return new Promise(resolve => { release = resolve; }); }, result => { completed.push(result); }, undefined, { jobs: 2, bytes: 5 }); queues.push(queue);
    expect(queue.enqueue(job(1), 3).hr).toBe(0); await started;
    const second = queue.enqueue(job(2), 2); expect(second.hr).toBe(0); expect(queue.pendingBytes).toBe(5);
    let touched = false; expect(queue.enqueue({ ...job(3), data: () => { touched = true; return new Uint8Array(); } }, 1)).toEqual({ hr: DP.OUTOFMEMORY, id: 0 }); expect(touched).toBe(false);
    expect(queue.cancel(second.id)).toBe(0); expect(queue.pendingBytes).toBe(3);
    expect(queue.enqueue(job(4), 3).hr).toBe(DP.OUTOFMEMORY); expect(queue.enqueue(job(4), 2).hr).toBe(0);
    queue.reset(); release(0); await Bun.sleep(2); expect(queue.pendingBytes).toBe(0); expect(queue.reservedJobs).toBe(0);
    expect(completed.map(c => c.hr)).toEqual([DP.CANCELLED]);
});
test("completion backpressure holds a finite reservation, releases payload bytes and retries FIFO exactly once", async () => {
    let ready = false; const completed: number[] = [];
    const queue = new DirectPlaySendQueue(() => 0, result => { if (!ready) return false; completed.push(result.context); return true; }, undefined, { jobs: 2, bytes: 4 }); queues.push(queue);
    expect(queue.enqueue(job(1), 2).hr).toBe(0); expect(queue.enqueue(job(2), 2).hr).toBe(0);
    await until(() => queue.pending.length === 0); expect(queue.pendingBytes).toBe(0); expect(queue.reservedJobs).toBe(2);
    expect(queue.enqueue(job(3), 1).hr).toBe(DP.OUTOFMEMORY); expect(completed).toEqual([]);
    ready = true; queue.retryCompletions(); expect(completed).toEqual([1, 2]); expect(queue.reservedJobs).toBe(0);
    queue.retryCompletions(); await Bun.sleep(5); expect(completed).toEqual([1, 2]); expect(queue.enqueue(job(3), 4).hr).toBe(0);
});
test("a reentrant reset during completion cannot retire or block the next lifetime", async () => {
    const completed: number[] = []; let queue!: DirectPlaySendQueue;
    queue = new DirectPlaySendQueue(() => 0, result => { if (result.context === 1) { queue.reset(); expect(queue.enqueue(job(2), 1).hr).toBe(0); return false; } completed.push(result.context); return true; }, undefined, { jobs: 1, bytes: 1 }); queues.push(queue);
    expect(queue.enqueue(job(1), 1).hr).toBe(0); await until(() => completed.length === 1); expect(completed).toEqual([2]); expect(queue.reservedJobs).toBe(0); expect(queue.pendingBytes).toBe(0);
});
test("NOCOMPLETE releases its reservation even when the completion consumer is blocked", async () => {
    let called = 0; const queue = new DirectPlaySendQueue(() => 0, () => { called++; return false; }, undefined, { jobs: 1, bytes: 1 }); queues.push(queue);
    expect(queue.enqueue(job(1, 0, 0x400), 1).hr).toBe(0); await until(() => queue.reservedJobs === 0);
    expect(called).toBe(0); expect(queue.pendingBytes).toBe(0); expect(queue.enqueue(job(2, 0, 0x400), 1).hr).toBe(0);
});
test("invalid data collection and thrown delivery finish with errors and do not strand reserved memory", async () => {
    const completed: number[] = [], queue = new DirectPlaySendQueue(() => { throw Error("carrier"); }, result => { completed.push(result.hr); }); queues.push(queue);
    expect(queue.enqueue({ ...job(1), data: () => { throw Error("memory retired"); } }, 1).hr).toBe(0); expect(queue.enqueue(job(2), 1).hr).toBe(0);
    await until(() => completed.length === 2); expect(completed).toEqual([DP.INVALIDPARAMS, DP.CONNECTIONLOST]); expect(queue.pendingBytes).toBe(0); expect(queue.reservedJobs).toBe(0);
    expect(queue.enqueue(job(3), -1).hr).toBe(DP.INVALIDPARAMS); expect(queue.enqueue(job(3), Number.NaN).hr).toBe(DP.INVALIDPARAMS);
});
test("classic SendEx completion waits for Receive space without clearing an existing transcript or losing its session", async () => {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 1)); network.attach({ send() { return true; }, close() {} });
    const session = new DirectPlaySession(network);
    try {
        expect(session.initialize()).toBe(0); expect(session.create({ application: "1".repeat(32), instance: "0".repeat(32), flags: 0, maxPlayers: 4, name: "", password: "", user: [0, 0, 0, 0] })).toBe(0);
        const created = await session.mutate({ op: "mutate", action: "create", group: false, name: { short: "", long: "" }, data: [], flags: 0, parent: 0 }); expect(created.hr).toBe(0);
        while (session.queue.length) session.removeMessage(0);
        for (let i = 0; i < 4096; i++) expect(session.enqueueSystem(created.id!, { type: 0x104 })).toBe(true);
        const queue = new DirectPlaySendQueue(() => 0, completion => session.enqueueSystem(created.id!, { type: 0x10d, completion })); queues.push(queue);
        expect(queue.enqueue({ ...job(99), from: created.id! }, 1).hr).toBe(0); await until(() => queue.pending.length === 0);
        expect(queue.reservedJobs).toBe(1); expect(session.queue.length).toBe(4096); expect(session.openError).toBe(0);
        session.removeMessage(0); queue.retryCompletions(); expect(queue.reservedJobs).toBe(0); expect(session.queue.length).toBe(4096);
        expect(session.queue.at(-1)?.system?.completion?.context).toBe(99); expect(session.openError).toBe(0);
    } finally { session.dispose(); network.attach(null); }
});
