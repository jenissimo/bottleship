import { DirectPlaySession, DP, type SessionDesc, type Entity, type JoinRequest, type JoinDecision, type Reply, type Address } from "../dplayx/session";
import type { LanNetwork } from "../../net/lan-network";
import { DPN } from "./constants";
import type { DirectPlay8Backend } from "./backend";
import { NativeDirectPlayCore } from "./native-wire/core";

export type DirectPlay8Role = "peer" | "client" | "server";
export interface PlayerInfo { name: string; data: number[]; flags: number; }
export interface DirectPlay8Event {
    type: number; id?: number; player?: number; owner?: number; context?: number; groupContext?: number;
    playerContext?: number; reason?: number; data?: Uint8Array; flags?: number; result?: number; processed?: () => void;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function dp8Result(hr: number): number {
    switch (hr) {
        case DP.OK: return DPN.OK;
        case DP.UNINITIALIZED: return DPN.UNINITIALIZED;
        case DP.ALREADYINITIALIZED: return DPN.ALREADYINITIALIZED;
        case DP.ACTIVEPLAYERS: return DPN.ALREADYCONNECTED;
        case DP.NOSESSIONS: return DPN.NOCONNECTION;
        case DP.INVALIDPARAMS: return DPN.INVALIDPARAM;
        case DP.INVALIDFLAGS: return DPN.INVALIDFLAGS;
        case DP.INVALIDPLAYER: return DPN.INVALIDPLAYER;
        case DP.INVALIDGROUP: return DPN.INVALIDGROUP;
        case DP.ACCESSDENIED: return DPN.NOTALLOWED;
        case DP.CANTCREATEPLAYER: return DPN.SESSIONFULL;
        case DP.TIMEOUT: return DPN.TIMEDOUT;
        case DP.SESSIONLOST: case DP.CONNECTIONLOST: return DPN.CONNECTIONLOST;
        case DP.INVALIDPASSWORD: return DPN.INVALIDPASSWORD;
        case DP.UNAVAILABLE: return 0x80158510;
        default: return hr;
    }
}
/** DirectPlay 8 object state; its event sink owns guest callback scheduling. */
export class DirectPlay8Session {
    engine: DirectPlay8Backend;
    virtualProvider: DirectPlaySession;
    private disposed = false;
    readonly contexts = new Map<number, number>();
    readonly groupContexts = new Map<number, number>();
    localId = 0;
    initialized = false;
    connecting = false;
    localInfo: PlayerInfo = { name: "", data: [], flags: 0 };
    onEvent?: (event: DirectPlay8Event) => boolean | void;
    private events: DirectPlay8Event[] = [];
    private eventBytes = 0;
    private eventRetry?: ReturnType<typeof setTimeout>;
    private overflow = false;
    get pendingEventCount(): number { return this.events.length; }
    onIndicate?: (request: JoinRequest) => JoinDecision | Promise<JoinDecision>;
    private known = new Map<number, Entity>();
    private previousDesc = "";
    private creatingGroups: { context: number; assigned: boolean }[] = [];
    private previousHost = 0;
    private localClosing = false;
    private suppress = false;
    private generation = 0;
    private termination: { data: Uint8Array; reason: number } | null = null;
    constructor(readonly network: LanNetwork, readonly role: DirectPlay8Role = "peer", private timeout = 10000) {
        this.engine = this.virtualProvider = this.newEngine();
    }
    private attach(engine: DirectPlay8Backend): void {
        this.engine = engine;
        engine.onChange = () => { if (this.engine === engine) this.sync(); };
        engine.onMessage = () => { if (this.engine === engine) this.drain(); };
        engine.onTermination = (data, reason) => { if (this.engine === engine) this.termination = { data, reason: reason ?? DPN.HOSTTERMINATEDSESSION }; };
    }
    private newEngine(): DirectPlaySession {
        const engine = new DirectPlaySession(this.network, this.timeout, 8);
        this.attach(engine);
        engine.onJoinRequest = request => this.onIndicate?.(request) ?? { hr: DPN.OK };
        engine.onJoinAccepted = (id, context) => this.contexts.set(id, context);
        return engine;
    }
    get error(): number { return this.overflow ? DPN.TABLEFULL : !this.initialized ? DPN.UNINITIALIZED : this.connecting ? DPN.CONNECTING : this.engine.openError ? dp8Result(this.engine.openError) : DPN.OK; }
    get hostId(): number {
        const address = this.engine.hostAddress;
        if (!address) return 0;
        const key = address.node.join(".") + ":" + address.port;
        return [...this.engine.entities.values()].find(e => !e.group && e.owner === key)?.id ?? 0;
    }
    initialize(): number {
        if (this.initialized) return DPN.ALREADYINITIALIZED;
        if (this.disposed) { this.engine = this.virtualProvider = this.newEngine(); this.disposed = false; this.overflow = false; }
        const hr = dp8Result(this.virtualProvider.initialize());
        if (!hr) this.initialized = true; return hr;
    }
    bindPort(port: number): number {
        if (this.engine.desc || this.connecting) return DPN.ALREADYCONNECTED;
        this.useVirtual(); return dp8Result(this.virtualProvider.bindPort(port));
    }
    private useVirtual(): void { if (this.engine !== this.virtualProvider) { this.engine.dispose(); this.attach(this.virtualProvider); } }
    host(desc: SessionDesc, context = 0): number {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (this.connecting) return DPN.CONNECTING;
        if (this.engine.desc) return this.engine.isHost ? DPN.HOSTING : DPN.ALREADYCONNECTED;
        if ((this.role === "server") !== !!(desc.extended!.flags & 1)) return DPN.INVALIDFLAGS;
        this.localClosing = false; this.useVirtual();
        const hr = dp8Result(this.virtualProvider.create(desc)); if (hr) return hr;
        this.suppress = true;
        const created = this.engine.mutate({ op: "mutate", action: "create", group: false, parent: 0,
            flags: this.role === "server" ? 0x100 : 0, name: { short: this.localInfo.name, long: "" }, data: this.localInfo.data }) as Reply;
        this.suppress = false;
        if (created.hr || !created.id) { this.engine.close(); return dp8Result(created.hr); }
        this.localId = created.id; this.contexts.set(created.id, context); this.sync(); return DPN.OK;
    }
    async connect(desc: SessionDesc, context = 0, data = new Uint8Array()): Promise<number> {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (this.role === "server") return DPN.INVALIDPARAM;
        if (this.connecting) return DPN.CONNECTING;
        if (this.engine.desc) return DPN.ALREADYCONNECTED;
        if ((this.role === "client") !== !!((desc.extended?.flags ?? 0) & 1)) return DPN.INVALIDAPPLICATION;
        this.localClosing = false; this.useVirtual();
        const generation = ++this.generation; this.connecting = true; this.suppress = true;
        const hr = dp8Result(await this.virtualProvider.join(desc, { name: { short: this.localInfo.name, long: "" }, data: this.localInfo.data, flags: 0 }, data));
        if (generation !== this.generation) return DPN.USERCANCEL;
        this.connecting = false; this.suppress = false;
        if (!hr) {
            this.localId = this.engine.joinReply?.id ?? 0;
            if (!this.localId) { this.engine.close(); return 0x80158130; }
            this.contexts.set(this.localId, context); this.sync();
        }
        return hr;
    }
    async connectNative(address: Address, desc: SessionDesc, context = 0, data = new Uint8Array(), port = 0, caps = [20, 0, 200, 14, 25000]): Promise<number> {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (this.role === "server") return DPN.INVALIDPARAM;
        if (this.connecting) return DPN.CONNECTING;
        if (this.engine.desc) return DPN.ALREADYCONNECTED;
        this.localClosing = false;
        const generation = ++this.generation; this.connecting = true; this.suppress = true;
        if (this.engine !== this.virtualProvider) this.engine.dispose();
        const backend = new NativeDirectPlayCore(this.network, this.role, Math.max(1, caps[4]), Math.max(1, caps[2]), Math.min(255, caps[3]));
        this.attach(backend);
        const hr = await backend.connect(address, desc, { name: { short: this.localInfo.name, long: "" }, data: this.localInfo.data, flags: 0 }, data, port).catch(() => { backend.close(); return DPN.GENERIC; });
        if (generation !== this.generation) return DPN.USERCANCEL;
        this.connecting = false; this.suppress = false;
        if (!hr) { this.localId = backend.localId; this.contexts.set(this.localId, context); this.sync(); }
        return hr;
    }
    async beginClose(): Promise<number> { this.localClosing = true; return this.engine.shutdown ? this.engine.shutdown() : DPN.OK; }
    cancelConnect(): void {
        ++this.generation; this.connecting = false; this.suppress = false; this.engine.close();
        this.localId = 0; this.sync();
    }
    close(): number {
        if (!this.initialized) return DPN.UNINITIALIZED;
        ++this.generation; this.localClosing = true; this.connecting = false; this.suppress = false;
        this.engine.close(); this.sync(); this.localId = 0; this.contexts.clear(); this.groupContexts.clear(); return DPN.OK;
    }
    dispose(): void {
        this.close(); this.engine.dispose(); if (this.engine !== this.virtualProvider) this.virtualProvider.dispose(); this.initialized = false; this.disposed = true;
        if (this.eventRetry) clearTimeout(this.eventRetry); this.eventRetry = undefined;
        this.events = []; this.eventBytes = 0;
    }
    send(to: number, flags: number, data: Uint8Array): number | Promise<number> {
        if (this.error) return this.error;
        if (!this.localId || (to && !this.engine.entities.has(to))) return DPN.INVALIDPLAYER;
        if (this.engine instanceof NativeDirectPlayCore) return this.engine.sendDpn(to, flags, data);
        const wireFlags = (flags & 8 ? 1 : 0) | (flags & 0x20 ? 0 : 0x10000);
        const result = this.engine.send(this.localId, to, wireFlags, data);
        return result instanceof Promise ? result.then(dp8Result) : dp8Result(result);
    }
    async setInfo(id: number, info: PlayerInfo, mask: number): Promise<number> {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (!id) { if (mask & 1) this.localInfo.name = info.name; if (mask & 2) this.localInfo.data = info.data.slice(); return DPN.OK; }
        if (this.error) return this.error;
        const result = await this.engine.mutate({ op: "mutate", action: "info", id, ...(mask & 1 ? { name: { short: info.name, long: "" } } : {}),
            ...(mask & 2 ? { data: info.data } : {}) });
        return dp8Result(result.hr);
    }
    async createGroup(info: PlayerInfo, context: number): Promise<{ hr: number; id?: number }> {
        if (this.error) return { hr: this.error };
        const pending = { context, assigned: false }; this.creatingGroups.push(pending);
        const result = await this.engine.mutate({ op: "mutate", action: "create", group: true, parent: 0, flags: info.flags,
            name: { short: info.name, long: "" }, data: info.data });
        this.creatingGroups = this.creatingGroups.filter(item => item !== pending);
        if (!result.hr && result.id) { if (!this.groupContexts.has(result.id)) this.groupContexts.set(result.id, context); this.sync(); }
        return { hr: dp8Result(result.hr), id: result.id };
    }
    async destroyGroup(id: number): Promise<number> {
        if (this.error) return this.error;
        if (!this.engine.entities.get(id)?.group) return DPN.INVALIDGROUP;
        const reply = await this.engine.mutate({ op: "mutate", action: "destroy", group: true, id }); return dp8Result(reply.hr);
    }
    async member(group: number, player: number, add: boolean): Promise<number> {
        if (this.error) return this.error;
        const g = this.engine.entities.get(group), p = this.engine.entities.get(player);
        if (!g?.group) return DPN.INVALIDGROUP; if (!p || p.group) return DPN.INVALIDPLAYER;
        if (g.members.includes(player) === add) return add ? DPN.PLAYERALREADYINGROUP : DPN.PLAYERNOTINGROUP;
        const reply = await this.engine.mutate({ op: "mutate", action: "member", id: group, member: player, add }); return dp8Result(reply.hr);
    }
    playerFlags(id: number): number { return (id === this.localId ? 2 : 0) | (id === this.hostId ? 4 : 0); }
    address(id: number): Address | null { return this.engine.playerAddress(id); }
    async flush(): Promise<void> { while (!this.disposed && this.events.length) await new Promise(resolve => setTimeout(resolve, 4)); }
    private emit(event: DirectPlay8Event): void {
        this.events.push(event); this.eventBytes += event.data?.length ?? 64;
        if (!this.overflow && this.events.length >= 4096 && event.type !== 0x11) {
            this.overflow = true;
            // Keep the existing callback transcript, then explicitly end an exhausted connection.
            queueMicrotask(() => {
                if (this.disposed) return;
                this.termination = { data: new Uint8Array(), reason: DPN.TABLEFULL };
                this.engine.close(); this.sync();
            });
        }
        this.flushEvents();
    }
    /** Resume a backpressured transcript when the guest callback consumer frees capacity. */
    resumeCallbacks(): void { if (!this.disposed) { this.flushEvents(); this.drain(); } }
    private flushEvents(): void {
        while (this.events.length) {
            const event = this.events[0];
            if (this.onEvent?.(event) === false) break;
            this.events.shift(); this.eventBytes -= event.data?.length ?? 64;
        }
        if (this.events.length && !this.eventRetry) {
            this.eventRetry = setTimeout(() => { this.eventRetry = undefined; this.flushEvents(); this.drain(); }, 4);
            (this.eventRetry as unknown as { unref?(): void }).unref?.();
        }
    }
    private sync(): void {
        if (this.suppress || this.connecting) return;
        const next = this.engine.entities;
        for (const [id, old] of [...this.known].sort((a, b) => Number(b[1].group) - Number(a[1].group))) if (!next.has(id)) {
            for (const player of old.members) this.emit({ type: 0x12, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
            const endedReason = this.localClosing ? 1 : this.termination?.reason === DPN.HOSTTERMINATEDSESSION ? 3 : !old.group && this.engine.lost ? 2 : 1;
            if (!(this.role === "client" && this.engine.kind === "native" && !old.group)) this.emit({ type: old.group ? 8 : 9, id, context: (old.group ? this.groupContexts : this.contexts).get(id) ?? 0, reason: !this.engine.desc ? endedReason : old.group && (old.flags & 1) && !next.has(old.groupOwner) ? 2 : 1 });
        }
        for (const [id, entity] of next) {
            const old = this.known.get(id);
            if (!old) {
                const owner = entity.group ? (entity.flags & 1 ? entity.groupOwner : 0) : [...next.values()].find(p => !p.group && p.owner === entity.owner)?.id ?? 0;
                if (entity.group && entity.owner === this.engine.ownKey) {
                    const pending = this.creatingGroups.find(item => !item.assigned);
                    if (pending) { pending.assigned = true; this.groupContexts.set(id, pending.context); }
                }
                if (!(this.role === "client" && this.engine.kind === "native" && !entity.group)) this.emit({ type: entity.group ? 6 : 7, id, owner, context: (entity.group ? this.groupContexts : this.contexts).get(id) ?? 0 });
            } else if (JSON.stringify(old.name) !== JSON.stringify(entity.name) || JSON.stringify(old.data) !== JSON.stringify(entity.data)) {
                this.emit({ type: entity.group ? 0xc : this.role === "client" ? 0x15 : this.role === "server" ? 4 : 0x10,
                    id, context: (entity.group ? this.groupContexts : this.contexts).get(id) ?? 0 });
            }
        }
        // Membership callbacks follow all create notifications so both contexts exist.
        for (const [id, entity] of next) if (entity.group) {
                const old = this.known.get(id);
                for (const player of old?.members ?? []) if (!entity.members.includes(player)) this.emit({ type: 0x12, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
                for (const player of entity.members) if (!old?.members.includes(player)) this.emit({ type: 1, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
        }
        const desc = this.engine.desc ? JSON.stringify(this.engine.desc) : "";
        if (this.previousDesc && desc && this.previousDesc !== desc) this.emit({ type: 2 });
        const host = this.hostId;
        if (this.previousHost && host && host !== this.previousHost) this.emit({ type: 0xd, id: host, context: this.contexts.get(host) ?? 0 });
        this.previousHost = host; this.previousDesc = desc;
        this.known = new Map([...next].map(([id, entity]) => [id, clone(entity)]));
        if (this.engine.lost || this.termination) {
            const terminal = this.termination; this.termination = null;
            this.emit({ type: 0x16, result: terminal?.reason ?? DPN.CONNECTIONLOST, data: terminal?.data ?? new Uint8Array() });
        }
        this.drain();
    }
    private drain(): void {
        if (this.suppress || this.connecting) return;
        while (this.engine.queue.length) {
            if (this.events.length >= 4096 || this.eventBytes >= 4 * 1024 * 1024) return;
            const message = this.engine.queue[0]; this.engine.removeMessage(0);
            if (!message.system) this.emit({ type: 0x11, id: message.from, context: this.contexts.get(message.from) ?? 0, data: message.data, processed: message.processed, flags: message.flags && (message.flags & 1) ? 1 : 0 });
        }
    }
}
