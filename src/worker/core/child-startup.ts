/** Holds the first guest instruction while a child image and its process services load. */
export class ChildStartupGate<Preparation = unknown> {
    private prepared = false;
    private requested = false;
    private starting = false;
    private stopped = false;
    private released = false;
    private revision = 0;
    private preparation: Preparation | undefined;
    private beforeStart: ((preparation: Preparation | undefined) => void | Promise<void>) | null = null;
    private startCpu: (() => void) | null = null;
    constructor(private readonly notifyReady: () => void, private readonly fail: (error: unknown) => void) {}
    get canRun(): boolean { return this.released && !this.stopped; }
    get isPrepared(): boolean { return this.prepared; }
    prepare(beforeStart: (preparation: Preparation | undefined) => void | Promise<void>, startCpu: () => void): void {
        if (this.stopped || this.prepared) return;
        this.beforeStart = beforeStart;
        this.startCpu = startCpu;
        this.prepared = true;
        this.notifyReady();
        this.tryStart();
    }
    resume(preparation?: Preparation): void {
        if (this.stopped || this.released || this.requested) return;
        this.preparation = preparation;
        this.requested = true;
        this.revision++;
        this.tryStart();
    }
    /** A primary-thread suspension arriving before its first instruction revokes an early resume. */
    hold(): void {
        if (this.stopped || this.released) return;
        this.requested = false;
        this.revision++;
    }
    cancel(): void { this.stopped = true; this.revision++; }
    private tryStart(): void {
        if (!this.prepared || !this.requested || this.starting || this.stopped || this.released) return;
        this.starting = true;
        const revision = this.revision;
        void (async () => {
            try {
                await this.beforeStart!(this.preparation);
                if (this.stopped || !this.requested || this.revision !== revision) return;
                this.released = true;
                this.startCpu!();
            } catch (error) {
                this.stopped = true;
                this.fail(error);
            } finally {
                this.starting = false;
                this.tryStart();
            }
        })();
    }
}
