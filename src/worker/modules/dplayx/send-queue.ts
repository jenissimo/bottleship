import { DP } from "./session";

export interface SendCompletion {
    from: number; to: number; flags: number; priority: number; timeout: number;
    context: number; id: number; hr: number; sendTime: number;
}
export interface QueuedSend {
    from: number; to: number; flags: number; priority: number; timeout: number;
    context: number; data: () => Uint8Array | null;
}
interface Job extends QueuedSend { id: number; bytes: number; created: number; phase: "queued" | "sending" | "done"; timer?: ReturnType<typeof setTimeout>; settled: Promise<void>; settle(): void; }
export class DirectPlaySendQueue {
    private jobs = new Map<number, Job>();
    private next = 1;
    private drainTimer?: ReturnType<typeof setTimeout>;
    private epoch = 0;
    private drainingEpoch: number | undefined;
    constructor(private deliver: (job: QueuedSend, data: Uint8Array) => number | Promise<number>,
        private complete: (result: SendCompletion) => void, private clock = () => Date.now() >>> 0) {}
    enqueue(send: QueuedSend, bytes: number): number {
        const id = this.next++ >>> 0 || this.next++ >>> 0;
        let settle!: () => void;
        const settled = new Promise<void>(resolve => { settle = resolve; });
        const job: Job = { ...send, id, bytes, created: this.clock(), phase: "queued", settled, settle };
        this.jobs.set(id, job);
        if (send.timeout) job.timer = setTimeout(() => this.finish(job, DP.TIMEOUT), send.timeout);
        this.kick();
        return id;
    }
    get pending(): { id: number; from: number; to: number; bytes: number; context: number; priority: number }[] {
        return [...this.jobs.values()].map(j => ({ id: j.id, from: j.from, to: j.to, bytes: j.bytes, context: j.context, priority: j.priority }));
    }
    cancel(id: number): number {
        if (!id) { for (const job of [...this.jobs.values()]) if (job.phase === "queued") this.finish(job, DP.CANCELLED); return DP.OK; }
        const job = this.jobs.get(id);
        if (!job) return DP.UNKNOWNMESSAGE;
        if (job.phase !== "queued") return DP.CANCELFAILED;
        this.finish(job, DP.CANCELLED); return DP.OK;
    }
    cancelPriority(min: number, max: number): number {
        if (min > max || max > 0xffff) return DP.INVALIDPARAMS;
        for (const job of [...this.jobs.values()]) if (job.phase === "queued" && job.priority >= min && job.priority <= max) this.finish(job, DP.CANCELLED);
        return DP.OK;
    }
    reset(): void {
        ++this.epoch;
        if (this.drainTimer) clearTimeout(this.drainTimer);
        this.drainTimer = undefined;
        for (const job of this.jobs.values()) { if (job.timer) clearTimeout(job.timer); job.phase = "done"; job.settle(); }
        this.jobs.clear();
    }
    private finish(job: Job, hr: number): void {
        if (job.phase === "done") return;
        job.phase = "done"; if (job.timer) clearTimeout(job.timer);
        this.jobs.delete(job.id);
        job.settle();
        if (!(job.flags & 0x400)) this.complete({ from: job.from, to: job.to, flags: job.flags, priority: job.priority,
            timeout: job.timeout, context: job.context, id: job.id, hr, sendTime: (this.clock() - job.created) >>> 0 });
    }
    private kick(): void {
        if (this.drainTimer || this.drainingEpoch === this.epoch) return;
        this.drainTimer = setTimeout(() => { this.drainTimer = undefined; void this.drain(); }, 0);
    }
    private async drain(): Promise<void> {
        const epoch = this.epoch;
        if (this.drainingEpoch === epoch) return;
        this.drainingEpoch = epoch;
        try { for (;;) {
            if (epoch !== this.epoch) return;
            const job = [...this.jobs.values()].filter(j => j.phase === "queued").sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
            if (!job) return;
            if (job.timeout && ((this.clock() - job.created) >>> 0) >= job.timeout) { this.finish(job, DP.TIMEOUT); continue; }
            const data = job.data();
            if (!data) { this.finish(job, DP.INVALIDPARAMS); continue; }
            job.phase = "sending";
            let hr: number;
            try { hr = await Promise.race([Promise.resolve(this.deliver(job, data)), job.settled.then(() => DP.TIMEOUT)]); } catch { hr = DP.CONNECTIONLOST; }
            if (epoch !== this.epoch) return;
            this.finish(job, hr);
        } } finally {
            if (this.drainingEpoch === epoch) this.drainingEpoch = undefined;
            if ([...this.jobs.values()].some(job => job.phase === "queued")) this.kick();
        }
    }
}
