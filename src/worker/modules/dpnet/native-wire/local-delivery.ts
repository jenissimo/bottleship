import { DPN } from "../constants";
type Enqueue = (data: Uint8Array, flags: number, processed?: () => void) => boolean;
/** Shared native self-delivery lifetime; completion is observable before Promise reactions. */
export class NativeLocalDelivery {
    private operations = new Set<(result: number) => void>();
    private bytes = 0;
    get pending(): number { return this.operations.size; }
    deliver(exactSelf: boolean, flags: number, data: Uint8Array, enqueue: Enqueue, signal?: AbortSignal,
        accepted?: () => void, completed?: (result: number) => void): number | Promise<number> {
        if (signal?.aborted) return DPN.USERCANCEL;
        if (!(flags & 4)) {
            if (!enqueue(data, flags & 8 ? 1 : 0)) return DPN.TABLEFULL;
            accepted?.(); return DPN.OK;
        }
        if (this.operations.size >= 256 || data.length > 4 * 1024 * 1024 - this.bytes) return DPN.TABLEFULL;
        return new Promise<number>(resolve => {
            const size = data.length, abort = () => finish(DPN.USERCANCEL);
            const finish = (result: number) => {
                if (!this.operations.delete(finish)) return;
                this.bytes -= size; signal?.removeEventListener("abort", abort); resolve(result);
                if (exactSelf) completed?.(result);
            };
            this.operations.add(finish); this.bytes += size;
            signal?.addEventListener("abort", abort, { once: true });
            if (!enqueue(data, flags & 8 ? 1 : 0, () => finish(DPN.OK))) finish(DPN.TABLEFULL);
            else accepted?.();
        });
    }
    cancel(result: number): void { for (const finish of [...this.operations]) finish(result); }
}
