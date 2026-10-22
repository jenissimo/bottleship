import type { Process } from "../../core/process";
import type { VTableInfo } from "../../api/adapters/module-adapter";
import type { ThunkImplementation, ThunkResult, OwnerThunkResult } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { System } from "../../core/system";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { ComObjectFactory } from "../../core/com/base-com-object";
import { allocateComObject } from "../../core/com/com-memory";
import { prepareChildLaunch, type PreparedChildLaunch } from "../../core/launch-child";
import { DirectPlayGuestMemory } from "../dpnet/guest-memory";
import type { DirectPlayAddressApi } from "../dpnet/address-api";
import { DPN, guidString } from "../dpnet/constants";
import { dpnlobbyModule } from "../../api/dpnlobby.api";
import { DPL8_APP, DPL8_CLIENT } from "./constants";
import { DirectPlay8LobbyEndpoint, ensureLobby8Broker, type Lobby8Kind, type Lobby8Reply, type Lobby8Request } from "./broker";
import { Lobby8Callbacks } from "./callbacks";
import { registerLobbyPeerProvider } from "./peer-bridge";
import { lobby8Programs, lobby8Registration } from "./registry";
import { packPrograms, packSettings, readProgram, readSettings, settingsSize, type Lobby8Settings } from "./structures";

interface LobbyState {
    token: number; kind: Lobby8Kind; initialized: boolean; generation: number; callbacks?: Lobby8Callbacks;
    unknown?: number;
    contexts: Map<number, number>; pumping: boolean; retry?: ReturnType<typeof setTimeout>;
    accepted: Map<number, number>; waiters: Map<number, (hr: number) => void>;
}
const syncResult = (result: number | OwnerThunkResult): number => {
    if (typeof result === "number") return result;
    for (const write of result.deferredWrites ?? []) {
        if (write.size === 4) Mem.writeUint32(write.address, write.value);
        else if (write.size === 2) Mem.writeUint16(write.address, write.value);
        else if (write.size === 1) Mem.writeUint8(write.address, write.value);
    }
    return result.value;
};
export class DirectPlay8LobbyApi {
    private states = new Map<number, LobbyState>();
    private nextToken = 1;
    private endpoint?: DirectPlay8LobbyEndpoint;
    private guest: DirectPlayGuestMemory;
    constructor(readonly process: Process, readonly tables: () => Record<string, VTableInfo>, readonly addresses: () => DirectPlayAddressApi) {
        this.guest = new DirectPlayGuestMemory(process);
        ensureLobby8Broker(undefined, lobby8Programs(), lobby8Registration, lobby8Programs);
        registerLobbyPeerProvider(process, {
            retain: pointer => {
                const object = SystemResourceProvider.getInstance().getComObjectByAddress(pointer);
                if (!object || !this.state(pointer, "app")) return null;
                object.addRef(); let released = false;
                return () => {
                    if (released) return; released = true;
                    if (!object.release()) {
                        const state = this.states.get(object.handle);
                        if (state) this.closeState(state);
                        this.states.delete(object.handle);
                    }
                };
            },
            post: async (pointer, connection, status, settings) => {
                const state = this.state(pointer, "app"); if (!state?.initialized) return DPN.UNINITIALIZED;
                return (await this.call(state, { op: "publish", connection, settings, status })).hr;
            },
        });
    }
    private get link(): DirectPlay8LobbyEndpoint {
        if (!this.endpoint) {
            this.endpoint = new DirectPlay8LobbyEndpoint();
            this.endpoint.onMessage = (kind, token) => {
                const state = [...this.states.values()].find(s => s.kind === kind && s.token === token);
                if (state) this.pump(state);
            };
        } return this.endpoint;
    }
    reset(): void {
        for (const state of this.states.values()) this.closeState(state);
        this.states.clear(); this.endpoint?.close(); this.endpoint = undefined;
    }
    private state(pointer: number, kind: Lobby8Kind): LobbyState | null {
        const object = SystemResourceProvider.getInstance().getComObjectByAddress(pointer);
        if (!object || object.iid !== (kind === "client" ? DPL8_CLIENT : DPL8_APP)) return null;
        let state = this.states.get(object.handle);
        if (!state) {
            state = { token: this.nextToken++, kind, initialized: false, generation: 0, contexts: new Map(), pumping: false, accepted: new Map(), waiters: new Map() };
            this.states.set(object.handle, state);
        } return state;
    }
    private call(state: LobbyState, request: Lobby8Request): Lobby8Reply | Promise<Lobby8Reply> {
        return this.link.call({ ...request, kind: state.kind, token: state.token });
    }
    private finish(state: LobbyState, reply: Lobby8Reply | Promise<Lobby8Reply>, apply: (reply: Lobby8Reply) => number | OwnerThunkResult = reply => reply.hr): number | OwnerThunkResult | Promise<ThunkResult> {
        if (!(reply instanceof Promise)) return syncResult(apply(reply));
        const generation = state.generation;
        return reply.then(value => ({ value: DPN.GENERIC, resumeOnOwner: () =>
            generation === state.generation ? apply(value) : DPN.UNINITIALIZED }));
    }
    private closeState(state: LobbyState): void {
        if (state.initialized) void this.call(state, { op: "close" });
        state.initialized = false; state.generation++; state.pumping = false; state.callbacks?.close(); state.callbacks = undefined;
        if (state.retry) clearTimeout(state.retry); state.retry = undefined;
        for (const done of state.waiters.values()) done(DPN.CONNECTIONLOST);
        state.waiters.clear(); state.accepted.clear(); state.contexts.clear();
    }
    private connected(state: LobbyState, connection: number, result: number): void {
        state.accepted.set(connection, result);
        state.waiters.get(connection)?.(result); state.waiters.delete(connection);
        if (state.initialized) void this.call(state, { op: "accept", connection, result });
    }
    private pump(state: LobbyState): void {
        if (!state.initialized || state.pumping || !state.callbacks) return;
        state.pumping = true; const generation = state.generation;
        void (async () => {
            while (state.initialized && state.generation === generation) {
                const reply = await this.call(state, { op: "peek" });
                if (state.generation !== generation || reply.hr || !reply.event) return;
                if (!state.callbacks?.enqueue(reply.event)) {
                    state.retry = setTimeout(() => { state.retry = undefined; this.pump(state); }, 4);
                    (state.retry as unknown as { unref?(): void }).unref?.(); return;
                }
                await this.call(state, { op: "ack", serial: reply.event.serial });
            }
        })().finally(() => { if (state.generation === generation) state.pumping = false; });
    }
    private initialize(state: LobbyState, args: number[]): ReturnType<ThunkImplementation> {
        if (state.initialized) return DPN.ALREADYINITIALIZED;
        const app = state.kind === "app", flags = args[app ? 4 : 3], output = app ? args[3] : 0;
        if (!this.guest.valid(args[2], 1, "rx") || (output && !this.guest.valid(output, 4, "rw"))) return DPN.INVALIDPOINTER;
        if (flags & ~1) return DPN.INVALIDFLAGS;
        state.initialized = true;
        const callbackGeneration = state.generation;
        state.callbacks = new Lobby8Callbacks(this.process, this.addresses(), args[2], args[1], state.contexts,
            (id, hr) => { if (callbackGeneration === state.generation) this.connected(state, id, hr); },
            id => { if (callbackGeneration === state.generation) state.accepted.delete(id); });
        const reply = this.call(state, { op: "initialize", image: System.getInstance().executablePath });
        const generation = state.generation;
        const apply = (value: Lobby8Reply): number | OwnerThunkResult => {
            if (value.hr) { this.closeState(state); return value.hr; }
            this.pump(state);
            return { value: DPN.OK, deferredWrites: output ? [{ address: output, value: value.connection ?? 0, size: 4 }] : undefined };
        };
        if (!(reply instanceof Promise) && (!app || !reply.connection)) return syncResult(apply(reply));
        return Promise.resolve(reply).then(async value => {
            if (value.hr || !value.connection || generation !== state.generation) return value;
            this.pump(state);
            const result = state.accepted.get(value.connection);
            const hr = result ?? await new Promise<number>(resolve => {
                state.waiters.set(value.connection!, resolve);
            });
            return { ...value, hr: hr & 0x80000000 ? hr : DPN.OK };
        }).then<ThunkResult>(value => ({ value: DPN.GENERIC, resumeOnOwner: () => generation === state.generation ? apply(value) : DPN.UNINITIALIZED }));
    }
    private async connect(state: LobbyState, settings: Lobby8Settings | undefined, application: string, flags: number, data: Uint8Array,
        context: number, output: number, timeout: number): Promise<ThunkResult> {
        const generation = state.generation;
        let launch: PreparedChildLaunch | undefined, connection = 0;
        let hr: number = DPN.GENERIC;
        try {
            const found = await this.call(state, { op: "find", guid: application });
            hr = found.hr;
            if (!hr && found.program) {
                let pid = flags & 1 ? 0 : found.app ?? 0;
                if (!pid && !(flags & 3)) hr = DPN.NOCONNECTION;
                if (!hr && !pid) {
                    const program = found.program.strings;
                    const image = program[5] ? program[5] + "\\" + (program[4] ?? "") : program[4] ?? "";
                    launch = await prepareChildLaunch({ imagePath: image, commandLine: '"' + image + '" ' + (program[1] ?? ""), currentDirectory: program[2] || program[5] || "C:\\" });
                    pid = launch.processId;
                }
                if (generation !== state.generation) hr = DPN.UNINITIALIZED;
                if (!hr) {
                    const attached = await this.call(state, { op: "attach", app: pid, settings, data });
                    hr = attached.hr; connection = attached.connection ?? 0;
                    if (!hr && generation === state.generation) {
                        state.contexts.set(connection, context); launch?.start();
                        const accepted = await this.call(state, { op: "wait", connection, timeout });
                        hr = accepted.hr;
                    } else if (!hr) hr = DPN.UNINITIALIZED;
                }
            }
        } catch { hr = DPN.GENERIC; }
        finally { if (hr) launch?.cancel(); launch?.closeHandles(); }
        if (generation !== state.generation) hr = DPN.UNINITIALIZED;
        if (hr && connection) { void this.call(state, { op: "release", connection }); state.contexts.delete(connection); }
        return { value: hr, resumeOnOwner: () => generation !== state.generation ? DPN.UNINITIALIZED :
            { value: hr, deferredWrites: !hr ? [{ address: output, size: 4, value: connection }] : undefined } };
    }
    install(exports: Record<string, ThunkImplementation>): void {
        const methods: Record<string, (state: LobbyState, args: number[]) => ReturnType<ThunkImplementation>> = {};
        methods.QueryInterface = (state, args) => {
            if (!this.guest.valid(args[1], 16) || !this.guest.valid(args[2], 4, "rw")) return DPN.INVALIDPOINTER;
            Mem.writeUint32(args[2], 0);
            const iid = guidString(Mem.readBytes(args[1], 16)!);
            if (iid !== (state.kind === "client" ? DPL8_CLIENT : DPL8_APP) && iid !== "00000000-0000-0000-c000-000000000046") return DPN.NOINTERFACE;
            const resource = SystemResourceProvider.getInstance(), object = resource.getComObjectByAddress(args[0])!;
            let pointer = resource.getPrimaryAddressForHandle(object.handle) ?? args[0];
            if (iid === "00000000-0000-0000-c000-000000000046") {
                if (!state.unknown) {
                    const table = this.tables()[state.kind === "client" ? "IDirectPlay8LobbyClient" : "IDirectPlay8LobbiedApplication"].address;
                    try {
                        const memory = this.process.getCurrentMemory();
                        state.unknown = allocateComObject(this.process.memory, memory, table); resource.mapAddressToHandle(state.unknown, object.handle);
                    } catch { return DPN.OUTOFMEMORY; }
                }
                pointer = state.unknown;
            }
            object.addRef(); Mem.writeUint32(args[2], pointer); return DPN.OK;
        };
        methods.AddRef = (_state, args) => SystemResourceProvider.getInstance().getComObjectByAddress(args[0])!.addRef();
        methods.Release = (state, args) => {
            const object = SystemResourceProvider.getInstance().getComObjectByAddress(args[0])!, handle = object.handle, result = object.release();
            if (!result) { this.closeState(state); this.states.delete(handle); } return result;
        };
        methods.Initialize = (state, args) => this.initialize(state, args);
        methods.Close = (state, args) => {
            if (args[1]) return DPN.INVALIDFLAGS;
            if (!state.initialized) return DPN.UNINITIALIZED;
            const callbacks = state.callbacks;
            if (callbacks?.queue.threadId && callbacks.queue.threadId === System.getInstance().scheduler.getCurrentThreadId()) return DPN.NOTALLOWED;
            const reply = this.call(state, { op: "close" }); this.closeState(state);
            if (!callbacks?.queue.size) return this.finish(state, reply);
            const generation = state.generation;
            return Promise.resolve(reply).then<ThunkResult>(async value => {
                while (callbacks.queue.size && state.generation === generation) await new Promise(resolve => setTimeout(resolve, 1));
                return { value: state.generation === generation ? value.hr : DPN.UNINITIALIZED };
            });
        };
        methods.RegisterProgram = (state, args) => {
            const program = readProgram(this.guest, args[1]); if (program.hr || !program.value) return program.hr;
            if (args[2]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "register", program: program.value }), reply => {
                if (!reply.hr) lobby8Registration(program.value!); return reply.hr;
            });
        };
        methods.UnRegisterProgram = (state, args) => {
            if (!this.guest.valid(args[1], 16)) return DPN.INVALIDPOINTER;
            if (args[2]) return DPN.INVALIDFLAGS;
            const guid = guidString(Mem.readBytes(args[1], 16)!);
            return this.finish(state, this.call(state, { op: "unregister", guid }), reply => { if (!reply.hr) lobby8Registration(guid); return reply.hr; });
        };
        methods.EnumLocalPrograms = (state, args) => {
            if (!this.guest.valid(args[3], 4, "rw") || !this.guest.valid(args[4], 4, "rw") || (args[1] && !this.guest.valid(args[1], 16))) return DPN.INVALIDPOINTER;
            const capacity = Mem.readUint32(args[3])!, guid = args[1] ? guidString(Mem.readBytes(args[1], 16)!) : undefined;
            if (capacity && !this.guest.valid(args[2], capacity, "rw")) return DPN.INVALIDPOINTER;
            if (args[5]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "enum", guid }), reply => {
                if (reply.hr) return reply.hr;
                const programs = reply.programs ?? [], bytes = packPrograms(programs, args[2]);
                if (capacity < bytes.length) return { value: DPN.BUFFERTOOSMALL, deferredWrites: [{ address: args[3], value: bytes.length, size: 4 }] };
                if (bytes.length) Mem.writeBytes(args[2], bytes);
                return { value: DPN.OK, deferredWrites: [{ address: args[4], value: programs.length, size: 4 }] };
            });
        };
        methods.SetAppAvailable = (state, args) => {
            if (args[2] & ~1) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "available", available: !!args[1], multiple: !!args[2] }));
        };
        methods.ConnectApplication = (state, args) => {
            if (!this.guest.valid(args[1], 36)) return DPN.INVALIDPOINTER;
            if (Mem.readUint32(args[1]) !== 36) return DPN.INVALIDPARAM;
            const flags = Mem.readUint32(args[1] + 4)!; if (flags & ~3) return DPN.INVALIDFLAGS;
            if (flags === 3 || Mem.readBytes(args[1] + 8, 16)!.every(byte => byte === 0)) return DPN.INVALIDPARAM;
            const settingsPtr = Mem.readUint32(args[1] + 24)!;
            const settings = settingsPtr ? readSettings(this.guest, this.addresses(), settingsPtr) : { hr: 0, value: undefined };
            if (settings.hr) return settings.hr;
            const pointer = Mem.readUint32(args[1] + 28)!, size = Mem.readUint32(args[1] + 32)!;
            if (size > 65536 || (size && !this.guest.valid(pointer, size))) return DPN.INVALIDPOINTER;
            if (!this.guest.valid(args[3], 4, "rw")) return DPN.INVALIDPOINTER;
            if (args[5]) return DPN.INVALIDFLAGS;
            if (!state.initialized) return DPN.UNINITIALIZED;
            const application = guidString(Mem.readBytes(args[1] + 8, 16)!);
            return this.connect(state, settings.value, application, flags, size ? Mem.readBytes(pointer, size)!.slice() : new Uint8Array(), args[2], args[3], args[4]);
        };
        methods.Send = (state, args) => {
            if (!args[1]) return DPN.INVALIDHANDLE;
            if (!this.guest.valid(args[2], args[3])) return DPN.INVALIDPOINTER;
            if (!args[3]) return DPN.INVALIDPARAM;
            if (args[3] > 65536) return 0x80158600; // DPNERR_SENDTOOLARGE
            if (args[4]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "send", connection: args[1], data: Mem.readBytes(args[2], args[3])!.slice() }));
        };
        methods.ReleaseApplication = (state, args) => {
            if (!args[1]) return DPN.INVALIDHANDLE;
            if (args[2]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "release", connection: args[1] }), reply => { if (!reply.hr) state.contexts.delete(args[1]); return reply.hr; });
        };
        methods.UpdateStatus = (state, args) => {
            if (!args[1]) return DPN.INVALIDHANDLE;
            if (args[2] < 1 || args[2] > 6) return DPN.INVALIDPARAM;
            if (args[3]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "status", connection: args[1], status: args[2] }));
        };
        methods.GetConnectionSettings = (state, args) => {
            if (!args[1] || args[1] === 0xffffffff) return DPN.INVALIDHANDLE;
            if (!this.guest.valid(args[3], 4, "rw")) return DPN.INVALIDPOINTER;
            const capacity = Mem.readUint32(args[3])!;
            if (capacity && !this.guest.valid(args[2], capacity, "rw")) return DPN.INVALIDPOINTER;
            if (args[4]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "get", connection: args[1] }), reply => {
                if (reply.hr === DPN.DOESNOTEXIST) return { value: reply.hr, deferredWrites: [{ address: args[3], value: 0, size: 4 }] };
                if (reply.hr || !reply.settings) return reply.hr;
                const required = settingsSize(reply.settings);
                if (!args[2] || capacity < required) return { value: DPN.BUFFERTOOSMALL, deferredWrites: [{ address: args[3], value: required, size: 4 }] };
                if (!this.guest.valid(args[2], required, "rw")) return DPN.INVALIDPOINTER;
                try {
                    const result = packSettings(reply.settings, args[2], this.addresses()); Mem.writeBytes(args[2], result.bytes);
                    return { value: DPN.OK, deferredWrites: [{ address: args[3], value: required, size: 4 }] };
                }
                catch { return DPN.OUTOFMEMORY; }
            });
        };
        methods.SetConnectionSettings = (state, args) => {
            if (!args[1]) return DPN.INVALIDHANDLE;
            const settings = args[2] ? readSettings(this.guest, this.addresses(), args[2]) : { hr: 0, value: undefined };
            if (settings.hr) return settings.hr;
            if (args[3]) return DPN.INVALIDFLAGS;
            return this.finish(state, this.call(state, { op: "set", connection: args[1], settings: settings.value }));
        };
        const bind = (kind: Lobby8Kind, method: string): ThunkImplementation => (_ctx, _mem, args) => {
            const copied = args.map(value => value >>> 0), state = this.state(copied[0], kind);
            return state ? methods[method](state, copied) : DPN.INVALIDOBJECT;
        };
        exports["IDirectPlay8LobbyClient_QueryInterface"] = bind("client", "QueryInterface");
        exports["IDirectPlay8LobbyClient_AddRef"] = bind("client", "AddRef");
        exports["IDirectPlay8LobbyClient_Release"] = bind("client", "Release");
        exports["IDirectPlay8LobbyClient_Initialize"] = bind("client", "Initialize");
        exports["IDirectPlay8LobbyClient_EnumLocalPrograms"] = bind("client", "EnumLocalPrograms");
        exports["IDirectPlay8LobbyClient_ConnectApplication"] = bind("client", "ConnectApplication");
        exports["IDirectPlay8LobbyClient_Send"] = bind("client", "Send");
        exports["IDirectPlay8LobbyClient_ReleaseApplication"] = bind("client", "ReleaseApplication");
        exports["IDirectPlay8LobbyClient_Close"] = bind("client", "Close");
        exports["IDirectPlay8LobbyClient_GetConnectionSettings"] = bind("client", "GetConnectionSettings");
        exports["IDirectPlay8LobbyClient_SetConnectionSettings"] = bind("client", "SetConnectionSettings");
        exports["IDirectPlay8LobbiedApplication_QueryInterface"] = bind("app", "QueryInterface");
        exports["IDirectPlay8LobbiedApplication_AddRef"] = bind("app", "AddRef");
        exports["IDirectPlay8LobbiedApplication_Release"] = bind("app", "Release");
        exports["IDirectPlay8LobbiedApplication_Initialize"] = bind("app", "Initialize");
        exports["IDirectPlay8LobbiedApplication_RegisterProgram"] = bind("app", "RegisterProgram");
        exports["IDirectPlay8LobbiedApplication_UnRegisterProgram"] = bind("app", "UnRegisterProgram");
        exports["IDirectPlay8LobbiedApplication_Send"] = bind("app", "Send");
        exports["IDirectPlay8LobbiedApplication_SetAppAvailable"] = bind("app", "SetAppAvailable");
        exports["IDirectPlay8LobbiedApplication_UpdateStatus"] = bind("app", "UpdateStatus");
        exports["IDirectPlay8LobbiedApplication_Close"] = bind("app", "Close");
        exports["IDirectPlay8LobbiedApplication_GetConnectionSettings"] = bind("app", "GetConnectionSettings");
        exports["IDirectPlay8LobbiedApplication_SetConnectionSettings"] = bind("app", "SetConnectionSettings");
        exports.DirectPlay8LobbyCreate = (_ctx, _mem, args) => {
            const [iidPointer, output, outer] = args.map(value => value >>> 0);
            if (!this.guest.valid(iidPointer, 16) || !this.guest.valid(output, 4, "rw")) return DPN.INVALIDPOINTER;
            if (outer) return DPN.INVALIDPARAM;
            const iid = guidString(Mem.readBytes(iidPointer, 16)!);
            const iface = dpnlobbyModule.interfaces!.find(item => item.iid === iid && [DPL8_CLIENT, DPL8_APP].includes(iid));
            if (!iface) return DPN.INVALIDPARAM;
            Mem.writeUint32(output, 0);
            const table = this.tables()[iface.name]?.address;
            if (!table) return DPN.OUTOFMEMORY;
            const object = ComObjectFactory.create(iid, table); if (!object) return DPN.OUTOFMEMORY;
            try {
                const memory = this.process.getCurrentMemory(), pointer = allocateComObject(this.process.memory, memory, table);
                SystemResourceProvider.getInstance().mapAddressToHandle(pointer, object.handle); Mem.writeUint32(output, pointer); return DPN.OK;
            } catch { object.release(); return DPN.OUTOFMEMORY; }
        };
    }
}
