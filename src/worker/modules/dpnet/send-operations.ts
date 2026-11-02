import type { Process } from "../../core/process";
const pools = new WeakMap<Process, DirectPlaySendOperationPool>();

export interface DirectPlaySendMetadata { firstFrameRtt: number; firstFrameRetries: number; flags: number; }
interface Node extends DirectPlaySendMetadata { epoch: number; released: boolean; }

/** Process-owned metadata retained by reused native async operations. */
export class DirectPlaySendOperationPool {
    static forProcess(process: Process): DirectPlaySendOperationPool {
        let pool = pools.get(process);
        if (!pool) { pool = new DirectPlaySendOperationPool(); pools.set(process, pool); const owner = pool; process.onReset(() => owner.reset()); }
        return pool;
    }
    private free: Node[] = [];
    private active = new Set<Node>();
    private epoch = 0;
    // Two retained nodes per send/callback reservation, plus one submitted delivery.
    constructor(readonly cacheLimit = 256, readonly maxActive = 2 * (256 + 256 + 2048) + 1) {
        if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0 || !Number.isSafeInteger(maxActive) || maxActive < 1)
            throw new RangeError("Invalid DirectPlay operation limits");
    }
    get activeLeases(): number { return this.active.size; }
    get cachedNodes(): number { return this.free.length; }
    begin(processing: boolean): DirectPlaySendOperation | null {
        if (this.active.size + (processing ? 3 : 2) > this.maxActive) return null;
        const user = this.take(), request = processing ? this.take() : undefined, delivery = this.take();
        user.firstFrameRtt = processing ? 0xffffffff : 0; user.firstFrameRetries = 0;
        // Request payload initialization clears the metadata union independently of user-handle reuse.
        if (request) { request.firstFrameRtt = 0; request.firstFrameRetries = 0; request.flags = 0; }
        return new DirectPlaySendOperation(this, user, request, delivery);
    }
    private take(): Node {
        const node = this.free.pop() ?? { firstFrameRtt: 0, firstFrameRetries: 0, flags: 0, epoch: this.epoch, released: true };
        node.epoch = this.epoch; node.released = false; this.active.add(node); return node;
    }
    owns(node: Node): boolean { return node.epoch === this.epoch && !node.released && this.active.has(node); }
    release(node: Node): void {
        if (node.released || node.epoch !== this.epoch || !this.active.delete(node)) return;
        node.released = true;
        if (this.cacheLimit) { if (this.free.length === this.cacheLimit) this.free.shift(); this.free.push(node); }
    }
    reset(): void { this.epoch++; this.active.clear(); this.free = []; }
}
export class DirectPlaySendOperation {
    private delivery?: Node;
    private submitted = false;
    private released = false;
    constructor(private pool: DirectPlaySendOperationPool, private user: Node, private request?: Node, delivery?: Node) { this.delivery = delivery; }
    metadata(): DirectPlaySendMetadata {
        return { firstFrameRtt: this.user.firstFrameRtt, firstFrameRetries: this.user.firstFrameRetries, flags: this.user.flags };
    }
    delivered(metadata: DirectPlaySendMetadata): void {
        if (this.released || this.submitted || !this.pool.owns(this.user)) return; this.submitted = true;
        const child = this.delivery!; Object.assign(child, metadata);
        if (this.request) { this.pool.release(child); this.delivery = undefined; }
        else Object.assign(this.user, metadata);
    }
    /** The processing request outlives the user callback that its completion invokes. */
    release(): void {
        if (this.released) return; this.released = true;
        this.pool.release(this.user);
        if (this.request) this.pool.release(this.request);
        if (this.delivery) this.pool.release(this.delivery);
    }
    rollback(): void {
        if (this.released) return; this.released = true;
        if (this.delivery) this.pool.release(this.delivery);
        if (this.request) this.pool.release(this.request);
        this.pool.release(this.user);
    }
}
