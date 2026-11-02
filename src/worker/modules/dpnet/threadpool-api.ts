import type { Process } from "../../core/process";
import type { VTableInfo } from "../../api/adapters/module-adapter";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { allocateComObject } from "../../core/com/com-memory";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { DirectPlayGuestMemory } from "./guest-memory";
import { DirectPlayCallbackExecutor } from "./executor";
import { DPN, guidString } from "./constants";
export const DP8_THREADPOOL = "0d22ee73-4a46-4a0d-89b2-045b4d666425";

/** ThreadPool COM views share the process's DirectPlay executor, not their COM identity. */
export class DirectPlayThreadPoolApi {
    private unknown = new Map<number, number>();
    private guest: DirectPlayGuestMemory;
    constructor(readonly process: Process, readonly tables: () => Record<string, VTableInfo>) { this.guest = new DirectPlayGuestMemory(process); }
    get executor(): DirectPlayCallbackExecutor { return DirectPlayCallbackExecutor.forProcess(this.process); }
    reset(): void { this.unknown.clear(); this.executor.reset(); }
    install(exports: Record<string, ThunkImplementation>): void {
        const methods: Record<string, (ctx: X86Context, args: number[]) => ReturnType<ThunkImplementation>> = {};
        methods.QueryInterface = (_ctx, args) => {
            if (!this.guest.valid(args[1], 16) || !this.guest.valid(args[2], 4, "rw")) return DPN.INVALIDPOINTER;
            Mem.writeUint32(args[2], 0);
            const iid = guidString(Mem.readBytes(args[1], 16)!);
            if (iid !== DP8_THREADPOOL && iid !== "00000000-0000-0000-c000-000000000046") return DPN.NOINTERFACE;
            const resource = SystemResourceProvider.getInstance(), object = resource.getComObjectByAddress(args[0])!;
            let pointer = resource.getPrimaryAddressForHandle(object.handle) ?? args[0];
            if (iid !== DP8_THREADPOOL) {
                let unknown = this.unknown.get(object.handle);
                if (!unknown) {
                    const memory = this.process.getCurrentMemory();
                    unknown = allocateComObject(this.process.memory, memory, this.tables().IDirectPlay8ThreadPool.address);
                    resource.mapAddressToHandle(unknown, object.handle); this.unknown.set(object.handle, unknown);
                } pointer = unknown;
            }
            object.addRef(); Mem.writeUint32(args[2], pointer); return DPN.OK;
        };
        methods.AddRef = (_ctx, args) => SystemResourceProvider.getInstance().getComObjectByAddress(args[0])!.addRef();
        methods.Release = (_ctx, args) => {
            const object = SystemResourceProvider.getInstance().getComObjectByAddress(args[0])!, count = object.release();
            if (!count) {
                this.unknown.delete(object.handle);
                if (this.executor.initialized && !SystemResourceProvider.getInstance().getAllComObjects().some(other => other.iid === DP8_THREADPOOL)) {
                    const insideCallback = this.executor.inCallback, closed = this.executor.close(true);
                    if (closed instanceof Promise) {
                        if (insideCallback) { void closed; return count; }
                        return closed.then<ThunkResult>(() => ({ value: count }));
                    }
                }
            }
            return count;
        };
        methods.Initialize = (_ctx, args) => {
            if (!args[2] || !this.guest.valid(args[2], 1, "rx")) return DPN.INVALIDPARAM;
            if (args[3] & ~1) return DPN.INVALIDFLAGS;
            return this.executor.initialize(args[2], args[1]);
        };
        methods.Close = (_ctx, args) => {
            if (args[1]) return DPN.INVALIDFLAGS;
            return this.executor.initialized ? this.executor.close() : DPN.UNINITIALIZED;
        };
        methods.GetThreadCount = (_ctx, args) => {
            if (!this.guest.valid(args[2], 4, "rw")) return DPN.INVALIDPOINTER;
            if (args[1] !== 0 && args[1] !== 0xffffffff) return DPN.INVALIDPARAM;
            if (args[3]) return DPN.INVALIDFLAGS;
            if (!this.executor.initialized) return DPN.UNINITIALIZED;
            Mem.writeUint32(args[2], this.executor.count); return DPN.OK;
        };
        methods.SetThreadCount = (_ctx, args) => {
            if (args[1] !== 0 && args[1] !== 0xffffffff) return DPN.INVALIDPARAM;
            if (args[3]) return DPN.INVALIDFLAGS;
            if (!this.executor.initialized) return DPN.UNINITIALIZED;
            return this.executor.setCount(args[2]);
        };
        methods.DoWork = (ctx, args) => {
            if (args[2]) return DPN.INVALIDFLAGS;
            if (!this.executor.initialized) return DPN.UNINITIALIZED;
            if (this.executor.count) return DPN.NOTREADY;
            if (this.executor.inCallback) return DPN.NOTALLOWED;
            return this.executor.run(ctx, 12, undefined, args[1] || 0xffffffff);
        };
        const bind = (method: string): ThunkImplementation => (ctx, _mem, args) => {
            const object = SystemResourceProvider.getInstance().getComObjectByAddress(args[0]);
            if (object?.iid !== DP8_THREADPOOL) return DPN.INVALIDOBJECT;
            return methods[method](ctx, [...args]);
        };
        exports["IDirectPlay8ThreadPool_QueryInterface"] = bind("QueryInterface");
        exports["IDirectPlay8ThreadPool_AddRef"] = bind("AddRef");
        exports["IDirectPlay8ThreadPool_Release"] = bind("Release");
        exports["IDirectPlay8ThreadPool_Initialize"] = bind("Initialize");
        exports["IDirectPlay8ThreadPool_Close"] = bind("Close");
        exports["IDirectPlay8ThreadPool_GetThreadCount"] = bind("GetThreadCount");
        exports["IDirectPlay8ThreadPool_SetThreadCount"] = bind("SetThreadCount");
        exports["IDirectPlay8ThreadPool_DoWork"] = bind("DoWork");
    }
}
