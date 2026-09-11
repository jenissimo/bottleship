/** Nested workers have no native rAF. Use the owning window's refresh clock via the parent. */
export class ChildFrameClock {
    private callbacks = new Map<number, FrameRequestCallback>();
    private nextId = 1;
    private requested = false;
    constructor(private requestFrame: () => void,
        private report: (error: unknown) => void = error => { setTimeout(() => { throw error; }, 0); },
    ) {}
    request = (callback: FrameRequestCallback): number => {
        const id = this.nextId++;
        this.callbacks.set(id, callback);
        if (!this.requested) { this.requested = true; this.requestFrame(); }
        return id;
    };
    cancel = (id: number): void => { this.callbacks.delete(id); };
    frame(timestamp: number): void {
        this.requested = false;
        const ids = [...this.callbacks.keys()];
        for (const id of ids) {
            const callback = this.callbacks.get(id);
            this.callbacks.delete(id);
            try { callback?.(timestamp); } catch (error) { this.report(error); }
        }
    }
}
