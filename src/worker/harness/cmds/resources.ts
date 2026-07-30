/**
 * resources() — live handle-table census.
 *
 * The question "is this OUR leak or a guest that relies on a bigger handle space?" has one
 * decisive answer: how many handles of each class are LIVE while the guest believes it freed
 * them. Comparing the live count against the guest's own create/delete balance (apiCensus)
 * separates the two cases, and `next`/`remaining` say how close a class is to running off the
 * end of its range — the failure that shows up as `handle range exhausted!` in the log and then
 * as handles that alias the next class's range.
 */

import type { HarnessService } from "../service";
import { SystemResourceProvider, ResourceType } from "../../core/resources/system-resource-provider";

/** End of each typed handle range (system-resource-provider layout). */
const RANGE_END: Record<string, number> = {
    [ResourceType.KERNEL_OBJECT]: 0x40000,
    [ResourceType.USER_OBJECT]: 0x50000,
    [ResourceType.FILE_HANDLE]: 0x60000,
    [ResourceType.GDI_OBJECT]: 0x70000,
};

export function registerResourceCommands(svc: HarnessService): void {
    svc.register("resources", () => {
        const p = SystemResourceProvider.getInstance() as unknown as {
            getStatistics(): Record<string, { count: number; peak: number }>;
            nextComHandle: number; nextGdiHandle: number; nextKernelHandle: number;
            nextUserHandle: number; nextFileHandle: number;
            freeComHandles: number[]; freeUserHandles: number[];
        };
        const stats = p.getStatistics();
        const next: Record<string, number> = {
            [ResourceType.COM_OBJECT]: p.nextComHandle,
            [ResourceType.GDI_OBJECT]: p.nextGdiHandle,
            [ResourceType.KERNEL_OBJECT]: p.nextKernelHandle,
            [ResourceType.USER_OBJECT]: p.nextUserHandle,
            [ResourceType.FILE_HANDLE]: p.nextFileHandle,
        };
        const freeList: Record<string, number> = {
            [ResourceType.COM_OBJECT]: p.freeComHandles?.length ?? 0,
            [ResourceType.USER_OBJECT]: p.freeUserHandles?.length ?? 0,
        };
        const out: Record<string, unknown> = {};
        for (const type of Object.keys(stats)) {
            const end = RANGE_END[type];
            const nextHandle = next[type] ?? 0;
            out[type] = {
                live: stats[type].count,
                /** High-water mark across resources() CALLS, not a continuous maximum. */
                peakObserved: stats[type].peak,
                next: "0x" + (nextHandle >>> 0).toString(16),
                /** Handles left before the class runs into the next class's range (null: no fixed end). */
                remaining: end !== undefined ? Math.max(0, Math.floor((end - nextHandle) / 4)) : null,
                exhausted: end !== undefined ? nextHandle >= end : false,
                recycled: freeList[type] ?? 0,
            };
        }
        return out;
    });
}
