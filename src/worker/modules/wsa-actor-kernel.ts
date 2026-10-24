/** Host socket objects outlive individual guest descriptors and issuing processes. */
import { WsaSocketTable, WsaFailure, WSA, type WsaIoPurpose } from "./wsa-network";
import type { WsaActorIdentity, WsaActorNotification } from "./wsa-actor-protocol";
type State = ReturnType<WsaSocketTable["get"]>;
type Cache = Partial<State>;
interface Alias { id: number; physical: number; owner: Context; cache: Cache; imported: boolean; handleFlags: number; }
interface NativeIo extends Alias { purpose: WsaIoPurpose; }
interface Context extends WsaActorIdentity { aliases: Map<number, Alias>; nativeIo: Map<number, NativeIo>; notify?: (message: WsaActorNotification) => void; }
const cached = new Set<keyof State>(["overlapped","broadcast","reuse","receiveLimit","sendLimit","receiveTimeout","sendTimeout","oobInline","lingerEnabled","lingerSeconds","connectContextPending"]);
const mutable = new Set<keyof State>([...cached,"packetType","filterPacketType","extendedAddress","receiveHeader","receiveBroadcast","headerInclude","ipTtl","ipTos","ipOptionsChanged","error","pendingError","originalLocal","acceptListener","acceptListenerObjectId","connectExCompleted"]);
const omitted = new Set(["notify","connectTimer","packets","chunks","oobPending"]);
const operations = new Set(["bind","listen","acceptError","connect","cancelConnect","send","sendto","receive","recv","recvfrom","shutdown","setNonBlocking","setOobInline","setKeepAlive","setNoDelay","setUdpConnReset","setV6Only","getMulticastOption","setMulticastOption","changeMulticastMembership","readable","writable","exceptional","atMark","bytesAvailable","enumEvents","maxMessageSize","isConnected","disconnect","deferAccepted","rejectAccepted","adoptAccepted"]);
function fail(error: number): never { throw new WsaFailure(error); }
export class WsaActorKernel {
    private processes = new Map<number, Context>();
    private references = new Map<number, Set<Alias>>();
    private nextHandle = 0x10000000;
    private nextNativeIo = 1;
    private ended = new Set<string>();
    private identityKey(identity:WsaActorIdentity):string{return identity.pid+":"+identity.slot+":"+identity.epoch;}
    private selected = new Map<number, Alias>();
    constructor(readonly table: WsaSocketTable) {
        table.subscribe(() => { for (const context of this.processes.values()) if (context.aliases.size || context.nativeIo.size) context.notify?.({ type: "changed" }); });
    }
    register(identity: WsaActorIdentity): void {
        if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !Number.isInteger(identity.slot) || identity.slot < 0 || !Number.isInteger(identity.epoch) || identity.epoch <= 0) fail(WSA.EINVAL);
        if(this.ended.has(this.identityKey(identity))) fail(WSA.EACCES);
        const old = this.processes.get(identity.pid);
        if (old) { if (old.slot !== identity.slot || old.epoch !== identity.epoch) fail(WSA.EACCES); return; }
        this.processes.set(identity.pid, { ...identity, aliases: new Map(), nativeIo: new Map() });
    }
    reconcile(live: WsaActorIdentity[]): void {
        for (const context of [...this.processes.values()]) if (!live.some(item => item.pid === context.pid && item.slot === context.slot && item.epoch === context.epoch)) this.drop(context);
        const liveKeys=new Set(live.map(item=>this.identityKey(item)));
        for(const key of this.ended)if(!liveKeys.has(key))this.ended.delete(key);
        for (const item of live) if(!this.ended.has(this.identityKey(item)))this.register(item);
    }
    private context(identity: WsaActorIdentity): Context {
        const context = this.processes.get(identity.pid);
        if (!context || context.slot !== identity.slot || context.epoch !== identity.epoch) fail(WSA.EACCES);
        return context;
    }
    attach(identity: WsaActorIdentity, notify: (message: WsaActorNotification) => void): void { this.context(identity).notify = notify; }
    drop(identity: WsaActorIdentity, abortive = true): void {
        const context = this.processes.get(identity.pid);
        if (!context || context.slot !== identity.slot || context.epoch !== identity.epoch) return;
        this.processes.delete(identity.pid); this.ended.add(this.identityKey(identity)); context.notify = undefined;
        context.nativeIo.clear();
        for (const alias of [...context.aliases.values()]) this.release(alias, abortive);
    }
    private alias(context: Context, id: number): Alias {
        const alias = context.aliases.get(id >>> 0);
        if (!alias || !this.table.isValid(alias.physical)) fail(WSA.ENOTSOCK);
        return alias;
    }
    private reserve(context: Context, physical: number, cache?: Cache, imported = true): number {
        if (context.aliases.size >= 4096 || this.nextHandle > 0x7fffffff) fail(WSA.ENOBUFS);
        const id = this.nextHandle++, state = this.table.get(physical), values: Cache = {};
        for (const key of cached) (values as any)[key] = cache && Object.hasOwn(cache, key) ? cache[key] : state[key];
        const alias: Alias = { id, physical, owner: context, cache: values, imported, handleFlags: 1 };
        context.aliases.set(id, alias);
        let refs = this.references.get(physical); if (!refs) this.references.set(physical, refs = new Set());
        refs.add(alias); return id;
    }
    private release(alias: Alias, abortive = false): void {
        alias.owner.aliases.delete(alias.id);
        const refs = this.references.get(alias.physical); refs?.delete(alias);
        if (this.selected.get(alias.physical) === alias) { this.selected.delete(alias.physical); if (this.table.isValid(alias.physical)) this.table.configureEvents(alias.physical, 0); }
        if (refs?.size) return;
        this.references.delete(alias.physical);
        if (this.table.isValid(alias.physical)) {
            Object.assign(this.table.get(alias.physical), { lingerEnabled: abortive || alias.cache.lingerEnabled, lingerSeconds: abortive ? 0 : alias.cache.lingerSeconds });
            this.table.closesocket(alias.physical);
        }
    }
    private snapshot(alias: Alias): State {
        const output: any = {};
        for (const [key, value] of Object.entries(this.table.get(alias.physical))) if (!omitted.has(key)) output[key] = value;
        Object.assign(output, alias.cache, { id: alias.id, handleFlags: alias.handleFlags, packets: [], chunks: [], oobPending: [] });
        return structuredClone(output);
    }
    execute(identity: WsaActorIdentity, command: string, args: unknown[], nativeHandleOnly = false): unknown {
        const context = this.context(identity);
        if (nativeHandleOnly && !["get", "isValid", "send", "receive", "readable", "writable", "closesocket", "setHandleFlags", "fileObjectId", "hasFileObject", "acquireNativeIo", "nativeIo", "releaseNativeIo"].includes(command)) fail(WSA.EINVAL);
        if (command === "fileObjectId") return this.alias(context, args[0] as number).physical;
        if (command === "hasFileObject") return this.table.isValid(args[0] as number) && [...context.aliases.values()].some(alias => alias.physical === args[0]);
        if (command === "acquireNativeIo") {
            const alias = this.alias(context, args[0] as number);
            if (context.nativeIo.size >= 4096 || this.nextNativeIo > Number.MAX_SAFE_INTEGER) fail(WSA.ENOBUFS);
            const purpose = (args[1] ?? "data") as WsaIoPurpose;
            if (!["data","connect","accept","acceptTarget","disconnect","transmit"].includes(purpose)) fail(WSA.EINVAL);
            const token = this.nextNativeIo++;
            // Capture the issuing handle's provider metadata without adding a physical reference.
            context.nativeIo.set(token, { ...alias, cache: structuredClone(alias.cache), purpose });
            return token;
        }
        if (command === "releaseNativeIo") { context.nativeIo.delete(args[0] as number); return null; }
        if (command === "nativeIo") {
            const lease = context.nativeIo.get(args[0] as number), operation = args[1];
            if (!lease) fail(WSA.ENOTSOCK);
            const allowed = ["get", "isValid", "send", "receive", "readable", "writable", "fileObjectId",
                ...(lease.purpose === "connect" ? ["connect","cancelConnect","set"] : []),
                ...(lease.purpose === "accept" ? ["acceptInto"] : []),
                ...(lease.purpose === "acceptTarget" ? ["set"] : []),
                ...(lease.purpose === "disconnect" || lease.purpose === "transmit" ? ["disconnect"] : [])];
            if (!allowed.includes(operation as string)) fail(WSA.EINVAL);
            const actual = args[2];
            if (!Array.isArray(actual) || !lease || actual[0] !== lease.id) fail(WSA.ENOTSOCK);
            const valid = this.table.isValid(lease.physical) && !!this.references.get(lease.physical)?.size;
            if (operation === "isValid") return valid;
            if (!valid) fail(WSA.ENOTSOCK);
            if (operation === "get") return this.snapshot(lease);
            if (operation === "fileObjectId") return lease.physical;
            if (operation === "set") {
                const values = actual[1], permitted = lease.purpose === "connect" ? ["originalLocal","connectContextPending","connectExCompleted"] : ["acceptListener","acceptListenerObjectId"];
                if (!values || typeof values !== "object" || Array.isArray(values)) fail(WSA.EINVAL);
                const entries = Object.entries(values as Record<string, unknown>);
                if (entries.some(([key,value]) => !permitted.includes(key) || !(value === undefined || value === null || typeof value === "number" || typeof value === "boolean" || (key === "originalLocal" && value && typeof value === "object" && (value as State["local"])?.node instanceof Uint8Array && (value as NonNullable<State["local"]>).node.length === 6)))) fail(WSA.EINVAL);
                const state = this.table.get(lease.physical), current = context.aliases.get(lease.id);
                for (const [key,value] of entries) {
                    (state as any)[key] = value;
                    if (cached.has(key as keyof State)) { (lease.cache as any)[key] = value; if (current) (current.cache as any)[key] = value; }
                }
                return null;
            }
            if (operation === "acceptInto") {
                const target = context.nativeIo.get(actual[1] as number);
                if (!target || target.purpose !== "acceptTarget" || target.id !== actual[2] || !this.table.isValid(target.physical) || !this.references.get(target.physical)?.size) fail(995);
                const accepted = this.table.accept(lease.physical);
                try { this.table.adoptAccepted(target.physical, accepted); }
                catch (error) { this.table.deferAccepted(lease.physical, accepted); throw error; }
                const refs = this.references.get(accepted);
                if (refs) {
                    const into = this.references.get(target.physical)!;
                    for (const alias of refs) { alias.physical = target.physical; into.add(alias); }
                    this.references.delete(accepted); this.selected.delete(accepted);
                }
                const state = this.table.get(target.physical);
                state.acceptListener = lease.id; state.acceptListenerObjectId = lease.physical;
                return null;
            }
            const state = this.table.get(lease.physical), broadcast = state.broadcast, reuse = state.reuse;
            const forwarded = actual.slice(); forwarded[0] = lease.physical;
            state.broadcast = lease.cache.broadcast!; state.reuse = lease.cache.reuse!;
            try { return (this.table[operation as keyof WsaSocketTable] as (...values: any[]) => unknown).apply(this.table, forwarded); }
            finally { if (this.table.isValid(lease.physical)) { state.broadcast = broadcast; state.reuse = reuse; } }
        }
        if (command === "socket") {
            const physical = this.table.socket(args[0] as number, args[1] as number, args[2] as number);
            try { return this.reserve(context, physical); } catch (error) { this.table.closesocket(physical); throw error; }
        }
        if (command === "reset") { for (const alias of [...context.aliases.values()]) if(alias.imported)this.release(alias); return null; }
        if (command === "isValid") { const alias = context.aliases.get((args[0] as number) >>> 0); return !!alias && this.table.isValid(alias.physical); }
        if (command === "accept") return this.accept(identity, args[0] as number);
        const alias = this.alias(context, args[0] as number), state = this.table.get(alias.physical);
        // A Winsock lookup can attach the duplicated OS handle before an explicit WSASocket import.
        if (!nativeHandleOnly) alias.imported = true;
        if (command === "get") return this.snapshot(alias);
        if (command === "setHandleFlags") {
            alias.handleFlags = (alias.handleFlags & ~((args[1] as number) & 3)) | ((args[2] as number) & (args[1] as number) & 3);
            return 0;
        }
        if (command === "import") { alias.imported = true; return alias.id; } // Provider cleanup owns descriptors only after WSASocket imports them.
        if (command === "duplicate") {
            const target = this.processes.get(args[1] as number); if (!target) fail(WSA.EINVAL);
            // Existing descriptor caches stay stale; a new UDP provider context sees the latest request.
            const cache = state.type === 2 && (state.af === 2 || state.af === 23)
                ? { ...alias.cache, receiveLimit: state.receiveLimit } : alias.cache;
            return this.reserve(target, alias.physical, cache, false);
        }
        if (command === "set") {
            const values = args[1]; if (!values || typeof values !== "object" || Array.isArray(values)) fail(WSA.EINVAL);
            const entries = Object.entries(values as Record<string, unknown>);
            if (entries.some(([key, value]) => !mutable.has(key as keyof State) || !(value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || (key === "originalLocal" && value && typeof value === "object" && (value as State["local"])?.node instanceof Uint8Array && (value as NonNullable<State["local"]>).node.length === 6)))) fail(WSA.EINVAL);
            for (const [key, value] of entries) {
                if (cached.has(key as keyof State)) (alias.cache as any)[key] = value;
                (state as any)[key] = value;
            }
            return null;
        }
        if (command === "closesocket") {
            if (alias.handleFlags & 2) return 0;
            this.release(alias); context.notify?.({ type: "changed" }); return 0;
        }
        if (command === "configureEvents") {
            this.selected.set(alias.physical, alias);
            this.table.configureEvents(alias.physical, args[1] as number, (bit, error) => {
                const owner = this.selected.get(alias.physical); if (owner) owner.owner.notify?.({ type: "event", socket: owner.id, bit, error });
            }); return null;
        }
        if (!operations.has(command)) fail(WSA.EINVAL);
        const actual = args.slice(); actual[0] = alias.physical;
        if (["deferAccepted","adoptAccepted"].includes(command)) actual[1] = this.alias(context, args[1] as number).physical;
        // These checks use the caller's provider context; the queue/window/OOB mode stay shared.
        const broadcast = state.broadcast, reuse = state.reuse;
        state.broadcast = alias.cache.broadcast!; state.reuse = alias.cache.reuse!;
        try {
            if (command === "adoptAccepted") {
                const accepted = this.alias(context, args[1] as number), oldPhysical = accepted.physical;
                const result = this.table.adoptAccepted(alias.physical, accepted.physical);
                accepted.owner.aliases.delete(accepted.id);
                const survivors = this.references.get(oldPhysical);
                this.references.delete(oldPhysical); this.selected.delete(oldPhysical);
                const targetRefs = this.references.get(alias.physical)!;
                for (const survivor of survivors ?? []) if (survivor !== accepted) { survivor.physical = alias.physical; targetRefs.add(survivor); }
                return result;
            }
            const result = (this.table[command as keyof WsaSocketTable] as (...args: any[]) => unknown).apply(this.table, actual);
            if (command === "setOobInline") alias.cache.oobInline = !!args[1];
            return result;
        } finally {
            if (this.table.isValid(alias.physical)) { const current = this.table.get(alias.physical); current.broadcast = broadcast; current.reuse = reuse; }
            for (const [physical, refs] of this.references) if (!this.table.isValid(physical)) {
                for (const stale of refs) stale.owner.aliases.delete(stale.id);
                this.references.delete(physical); this.selected.delete(physical);
            }
        }
    }
    accept(identity: WsaActorIdentity, socket: number): number {
        const context = this.context(identity), parent = this.alias(context, socket), physical = this.table.accept(parent.physical);
        parent.imported = true;
        for (const alias of context.aliases.values()) if (alias.physical === physical) return alias.id;
        try { return this.reserve(context, physical, parent.cache); }
        catch (error) { this.table.deferAccepted(parent.physical, physical); throw error; }
    }
}
