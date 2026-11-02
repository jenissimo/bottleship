import { DP } from "./session";

export interface SendCompletion {
    from: number; to: number; flags: number; priority: number; timeout: number;
    context: number; id: number; hr: number; sendTime: number;
}
export interface QueuedSend {
    from: number; to: number; flags: number; priority: number; timeout: number;
    context: number; data: () => Uint8Array | null; signal?: AbortSignal; cancelActive?: boolean; eager?: boolean; processing?: boolean;
}
export interface SendAdmission { hr: number; id: number; }
export interface SendQueueLimits { jobs?: number; bytes?: number; }
interface Job extends QueuedSend {
    id: number; bytes: number; created: number; phase: "queued" | "sending" | "processing" | "completed" | "done";
    controller: AbortController; timer?: ReturnType<typeof setTimeout>; settled: Promise<void>; settle(): void; completion?: SendCompletion;
}
export class DirectPlaySendQueue {
    private jobs = new Map<number, Job>();
    private next = 1;
    private bytes = 0;
    private completions: Job[] = [];
    private completing = false;
    private completionRetry?: ReturnType<typeof setTimeout>;
    private drainTimer?: ReturnType<typeof setTimeout>;
    private epoch = 0;
    private sealed = false;
    private drainingEpoch: number | undefined;
    readonly maxJobs: number;
    readonly maxBytes: number;
    constructor(private deliver: (job: QueuedSend, data: Uint8Array, settled: (hr: number) => void) => number | Promise<number>,
        private complete: (result: SendCompletion) => boolean | void, private clock = () => Date.now() >>> 0,
        limits: SendQueueLimits = {}) {
        this.maxJobs = limits.jobs ?? 256; this.maxBytes = limits.bytes ?? 4 * 1024 * 1024;
        if (!Number.isSafeInteger(this.maxJobs) || this.maxJobs < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
            throw new RangeError("Invalid DirectPlay send queue limits");
    }
    get reservedJobs(): number { return this.jobs.size; }
    get pendingBytes(): number { return this.bytes; }
    /** Admission includes completed operations whose notifications have not been accepted. */
    admissionError(bytes: number): number {
        if (this.sealed) return DP.CONNECTIONLOST;
        if (!Number.isSafeInteger(bytes) || bytes < 1) return DP.INVALIDPARAMS;
        return this.jobs.size >= this.maxJobs || bytes > this.maxBytes - this.bytes ? DP.OUTOFMEMORY : DP.OK;
    }
    enqueue(send: QueuedSend, bytes: number): SendAdmission {
        const hr = this.admissionError(bytes); if (hr) return { hr, id: 0 };
        let id = this.next++ >>> 0; while (!id || this.jobs.has(id)) id = this.next++ >>> 0;
        let settle!: () => void;
        const settled = new Promise<void>(resolve => { settle = resolve; });
        const controller = new AbortController();
        const job: Job = { ...send, signal: controller.signal, controller, id, bytes, created: this.clock(), phase: "queued", settled, settle };
        this.jobs.set(id, job); this.bytes += bytes;
        if (send.timeout) job.timer = setTimeout(() => this.finish(job, DP.TIMEOUT), send.timeout);
        if (send.eager) {
            const epoch = this.epoch, result = this.dispatch(job);
            if (typeof result === "number") this.finish(job, result);
            else void result.then(hr => { if (epoch === this.epoch) this.finish(job, hr); },
                () => { if (epoch === this.epoch) this.finish(job, DP.CONNECTIONLOST); });
        } else this.kick();
        return { hr: DP.OK, id };
    }
    get pending(): { id: number; from: number; to: number; bytes: number; context: number; priority: number }[] {
        return [...this.jobs.values()].filter(j => j.phase === "queued" || j.phase === "sending" || j.phase === "processing")
            .map(j => ({ id: j.id, from: j.from, to: j.to, bytes: j.bytes, context: j.context, priority: j.priority }));
    }
    cancel(id: number): number {
        if (!id) { for (const job of [...this.jobs.values()]) if (job.phase === "queued" || ((job.phase === "sending" || job.phase === "processing") && job.cancelActive)) this.finish(job, DP.CANCELLED); return DP.OK; }
        const job = this.jobs.get(id);
        if (!job || job.phase === "completed" || job.phase === "done") return DP.UNKNOWNMESSAGE;
        if (job.phase !== "queued" && !job.cancelActive) return DP.CANCELFAILED;
        this.finish(job, DP.CANCELLED); return DP.OK;
    }
    cancelPriority(min: number, max: number): number {
        if (min > max || max > 0xffff) return DP.INVALIDPARAMS;
        for (const job of [...this.jobs.values()]) if (job.phase === "queued" && job.priority >= min && job.priority <= max) this.finish(job, DP.CANCELLED);
        return DP.OK;
    }
    /** Close cancels admitted work but retains every bounded completion until accepted. */
    seal(): void {
        this.sealed = true;
        if (this.drainTimer) clearTimeout(this.drainTimer); this.drainTimer = undefined;
        for (const job of [...this.jobs.values()]) this.finish(job, DP.CANCELLED);
    }
    async flushCompletions(): Promise<void> {
        const epoch = this.epoch;
        while (epoch === this.epoch && this.jobs.size) { this.retryCompletions(); await new Promise(resolve => setTimeout(resolve, 4)); }
    }
    reset(): void {
        ++this.epoch; this.sealed = false;
        if (this.drainTimer) clearTimeout(this.drainTimer); this.drainTimer = undefined;
        if (this.completionRetry) clearTimeout(this.completionRetry); this.completionRetry = undefined;
        const jobs = [...this.jobs.values()]; this.jobs.clear(); this.completions = []; this.bytes = 0;
        for (const job of jobs) { if (job.timer) clearTimeout(job.timer); job.phase = "done"; job.data = () => null; job.settle(); }
        for (const job of jobs) job.controller.abort();
    }
    private finish(job: Job, hr: number): void {
        if (job.phase === "done" || job.phase === "completed") return;
        const epoch = this.epoch;
        job.phase = "completed"; if (job.timer) clearTimeout(job.timer); job.timer = undefined;
        this.bytes -= job.bytes; job.data = () => null;
        if (hr === DP.CANCELLED || hr === DP.TIMEOUT) job.controller.abort();
        if (epoch !== this.epoch) return;
        job.settle();
        if (job.flags & 0x400) { job.phase = "done"; this.jobs.delete(job.id); return; }
        job.completion = { from: job.from, to: job.to, flags: job.flags, priority: job.priority,
            timeout: job.timeout, context: job.context, id: job.id, hr, sendTime: (this.clock() - job.created) >>> 0 };
        this.completions.push(job); this.retryCompletions();
    }
    /** False from the consumer retains FIFO ownership; reset explicitly abandons the old lifetime. */
    retryCompletions(): void {
        if (this.completing) return; this.completing = true; const epoch = this.epoch;
        try {
            while (this.completions.length && epoch === this.epoch) {
                const job = this.completions[0]; let accepted = false;
                try { accepted = this.complete(job.completion!) !== false; } catch { /* Keep the bounded notification for a later safe retry. */ }
                if (epoch !== this.epoch || !accepted) break;
                if (this.completions[0] === job) this.completions.shift();
                if (this.jobs.get(job.id) === job) { job.phase = "done"; this.jobs.delete(job.id); }
            }
        } finally { this.completing = false; }
        if (this.completions.length && !this.completionRetry) {
            this.completionRetry = setTimeout(() => { this.completionRetry = undefined; this.retryCompletions(); }, 4);
            (this.completionRetry as unknown as { unref?(): void }).unref?.();
        }
    }
    private dispatch(job: Job): number | Promise<number> {
        let data: Uint8Array | null;
        try { data = job.data(); } catch { data = null; }
        if (!data) return DP.INVALIDPARAMS;
        job.phase = "sending";
        try {
            // A local application ACK can arrive while guest DoWork is still on the stack.
            // Observe that result directly; Promise reactions run after the guest has resumed.
            const epoch = this.epoch;
            const result = this.deliver(job, data, hr => {
                if (epoch === this.epoch && this.jobs.get(job.id) === job) this.finish(job, hr);
            });
            if (typeof result !== "number" && job.processing && job.phase === "sending") job.phase = "processing";
            return result;
        } catch { return DP.CONNECTIONLOST; }
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
            let hr: number;
            try { hr = await Promise.race([Promise.resolve(this.dispatch(job)), job.settled.then(() => DP.TIMEOUT)]); } catch { hr = DP.CONNECTIONLOST; }
            if (epoch !== this.epoch) return;
            this.finish(job, hr);
        } } finally {
            if (this.drainingEpoch === epoch) this.drainingEpoch = undefined;
            if ([...this.jobs.values()].some(job => job.phase === "queued")) this.kick();
        }
    }
}
