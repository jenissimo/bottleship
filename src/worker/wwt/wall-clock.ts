export const WWT_WALL_QUANTUM_MS = 20;

// The upstream i386 preemption check compares unsigned millisecond values.
// Rotate the epoch between guest slices, while no translated code is active.
const EPOCH_END = 0xffff0000;

export class WwtWallClock {
    private worker?: Worker;
    private error?: Error;
    private resetting = false;
    private running = false;
    private readonly cell: Uint32Array;

    constructor(memory: WebAssembly.Memory, readonly address: number) {
        this.cell = new Uint32Array(memory.buffer, address, 1);
    }

    async init(): Promise<void> {
        const worker = new Worker(new URL("./wall-clock.worker.ts", import.meta.url), { type: "module" });
        this.worker = worker;
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("WWT clock did not initialize")), 5000);
                worker.onmessage = ({ data }) => {
                    if (data !== "ready") return;
                    clearTimeout(timeout);
                    this.resetting = false;
                    resolve();
                };
                worker.onerror = event => {
                    clearTimeout(timeout);
                    this.error = new Error(event.message || "WWT clock worker failed");
                    reject(this.error);
                };
                worker.postMessage({ buffer: this.cell.buffer, address: this.address });
            });
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    setRunning(running: boolean): void {
        if (this.running === running) return;
        this.running = running;
        this.worker?.postMessage(running ? "resume" : "pause");
    }

    arm(durationMs: number): number | undefined {
        if (this.error) throw this.error;
        if (this.resetting) return undefined;
        const now = this.now();
        if (now >= EPOCH_END) {
            this.reset();
            return undefined;
        }
        return now + Math.ceil(durationMs);
    }

    now(): number { return Atomics.load(this.cell, 0); }

    reset(): void {
        if (this.resetting) return;
        if (!this.worker) {
            Atomics.store(this.cell, 0, 0);
            return;
        }
        this.resetting = true;
        this.worker.postMessage("reset");
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = undefined;
        this.running = false;
    }
}
