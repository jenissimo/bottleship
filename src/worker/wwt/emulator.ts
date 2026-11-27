import { createTickYield } from "../core/host-task";
import type { WwtCpu } from "./cpu";

/** Worker-facing lifecycle for a CPU that already owns initialized guest memory. */
export class WwtEmulator {
    readonly v86 = this;
    running = false;
    idle = true;
    tick_counter = 0;
    tick_hooks_before?: () => void;
    tick_hooks_after?: (delayMs: number) => void;

    private readonly queueTick = createTickYield(tick => this.tick(tick));

    constructor(readonly cpu: WwtCpu, private readonly onFault: (error: unknown) => void) {}

    get mem8(): Uint8Array {
        return this.cpu.mem8;
    }

    add_listener(event: string, listener: () => void): void {
        if (event === "emulator-ready") listener();
    }

    is_running(): boolean {
        return this.running;
    }

    run(): void {
        if (this.running) return;
        this.running = true;
        this.cpu.setClockRunning(true);
        this.idle = true;
        this.queueTick(0, ++this.tick_counter);
    }

    stop(): Promise<void> {
        this.running = false;
        this.cpu.setClockRunning(false);
        if (!this.idle) this.cpu.requestYield();
        return this.cpu.flushPeProfile() ?? Promise.resolve();
    }

    dispose(): void {
        void this.stop();
        this.cpu.dispose();
    }

    restart(): void {
        void this.stop();
        this.cpu.reset();
    }

    private tick(tick: number): void {
        if (!this.running || tick !== this.tick_counter) return;
        this.idle = false;
        let delayMs = 0;
        try {
            try {
                this.tick_hooks_before?.();
                if (this.running) delayMs = this.cpu.main_loop();
            } finally {
                this.idle = true;
                this.tick_hooks_after?.(delayMs);
            }
        } catch (error) {
            void this.stop();
            this.onFault(error);
        }
        if (this.running && tick === this.tick_counter) this.queueTick(delayMs, ++this.tick_counter);
    }
}
