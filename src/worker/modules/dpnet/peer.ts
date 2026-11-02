import { DirectPlaySession, DP, type SessionDesc, type Entity, type JoinRequest, type JoinDecision, type Reply, type Address } from "../dplayx/session";
import type { LanNetwork } from "../../net/lan-network";
import { DPN } from "./constants";
import type { DirectPlay8Backend, DirectPlay8HostProvider, DirectPlay8ConnectCompletionLease } from "./backend";
import { NativeHostBackend } from "./native-wire/host-backend";
import type { NativeHostDecision, NativeHostJoin } from "./native-wire/host";
import { NativeDirectPlayCore } from "./native-wire/core";

export type DirectPlay8Role = "peer" | "client" | "server";
export interface PlayerInfo { name: string; nameNull?: boolean; data: number[]; flags: number; }
export interface DirectPlay8Event {
    type: number; id?: number; player?: number; owner?: number; context?: number; groupContext?: number;
    playerContext?: number; reason?: number; data?: Uint8Array; flags?: number; result?: number; processed?: (result?: number) => void;
    isCurrent?: () => boolean;
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
    localInfo: PlayerInfo = { name: "", nameNull: true, data: [], flags: 0 };
    onEvent?: (event: DirectPlay8Event) => boolean | void;
    onCancelNativeTermination?: () => void;
    private events: DirectPlay8Event[] = [];
    private eventBytes = 0;
    private eventRetry?: ReturnType<typeof setTimeout>;
    private overflow = false;
    get pendingLocalProcessing(): number { return this.engine.pendingLocalProcessing ?? this.localProcessed.size; }
    get pendingEventCount(): number { return this.events.length; }
    onIndicate?: (request: JoinRequest) => JoinDecision | Promise<JoinDecision>;
    onNativeIndicate?: (request: NativeHostJoin) => NativeHostDecision | Promise<NativeHostDecision>;
    private known = new Map<number, Entity>();
    private retiredGroups = new Map<number, { entity: Entity; generation: number; engine: DirectPlay8Backend }>();
    groupEntity(id: number): Entity | undefined {
        const retired = this.retiredGroups.get(id);
        const entity = this.engine.queryGroup?.(id) ?? this.engine.entities.get(id) ??
            (retired?.generation === this.generation && retired.engine === this.engine ? retired.entity : undefined);
        return entity?.group ? entity : undefined;
    }
    private previousDesc = "";
    private creatingGroups: { context: number; assigned: boolean }[] = [];
    private groupReturns = new Map<number, (result?: number) => void>();
    private groupDestructions = new Map<number, (result?: number) => void>();
    private memberReturns = new Set<(result?: number) => void>();
    private playerReturns = new Set<(result?: number) => void>();
    private serverCreations = new Map<number, object>();
    private peerCreations = new Map<number, { engine: DirectPlay8Backend; generation: number }>();
    private peerCreated = new Set<number>();
    private retiredPlayers = new Map<number, { engine: DirectPlay8Backend; generation: number; created: boolean }>();
    private peerNotifications = new Map<number, { engine: DirectPlay8Backend; generation: number; refs: Set<object>; failed: boolean; destroy?: DirectPlay8Event }>();
    private peerGroupNotifications = new Map<number, { engine: DirectPlay8Backend; generation: number; refs: Set<object>; failed: boolean; destroy?: DirectPlay8Event }>();
    playerContextError(id: number): number {
        const live = this.engine.entities.get(id);
        if (live?.group) return DPN.INVALIDPLAYER;
        if (this.role === "server" && this.engine.kind === "native" && live && this.serverCreations.has(id)) return DPN.NOTREADY;
        if (this.role !== "peer" || this.engine.kind !== "native") return live ? DPN.OK : DPN.INVALIDPLAYER;
        if (live) return this.peerCreated.has(id) ? DPN.OK : DPN.NOTREADY;
        const retired = this.retiredPlayers.get(id);
        return retired?.engine === this.engine && retired.generation === this.generation && retired.created ? DPN.OK : DPN.INVALIDPLAYER;
    }
    isGroupCreated(id: number): boolean { return !this.groupReturns.has(id); }
    isGroupDestroying(id: number): boolean {
        const state = this.engine.groupState?.(id);
        return this.groupDestructions.has(id) || state === "disconnecting" || state === "deleted";
    }
    groupDestroyError(id: number): number {
        if (this.engine.groupState?.(id) === "deleted") return DPN.CONNECTIONLOST;
        return !this.engine.entities.get(id)?.group || this.isGroupDestroying(id) ? DPN.INVALIDGROUP : DPN.OK;
    }
    private previousHost = 0;
    private infoReturned?: () => void;
    private infoNotification?: { id: number; assigned: boolean; complete(result?: number): void };
    private localClosing = false;
    private localProcessed = new Set<(result: number) => void>();
    private localProcessedBytes = 0;
    private suppress = false;
    private generation = 0;
    private termination: { data: Uint8Array; reason: number; notified?: boolean; awaitingReturn?: boolean } | null = null;
    private playerDestroyReasons = new Map<number, { engine: DirectPlay8Backend; generation: number; reason: number }>();
    constructor(readonly network: LanNetwork, readonly role: DirectPlay8Role = "peer", private timeout = 10000) {
        this.engine = this.virtualProvider = this.newEngine();
    }
    private attach(engine: DirectPlay8Backend): void {
        if (this.engine !== engine) {
            this.cancelNativeTermination();
            this.playerDestroyReasons.clear(); this.serverCreations.clear(); this.peerCreations.clear(); this.peerCreated.clear(); this.retiredPlayers.clear(); this.peerNotifications.clear(); this.peerGroupNotifications.clear(); this.termination = null;
            for (const finish of [...this.groupDestructions.values()]) finish(DPN.USERCANCEL);
            for (const finish of [...this.memberReturns]) finish(DPN.USERCANCEL);
            for (const finish of [...this.playerReturns]) finish(DPN.USERCANCEL);
            this.retiredGroups.clear();
        }
        this.engine = engine;
        engine.onChange = () => { if (this.engine === engine) this.sync(); };
        engine.onMessage = () => { if (this.engine === engine) this.drain(); };
        engine.onInfo = (id, returned, notify = true) => {
            if (this.engine !== engine) { returned(DPN.USERCANCEL); return; }
            if (!notify) {
                const entity = engine.entities.get(id); if (entity) this.known.set(id, clone(entity));
                returned(); return;
            }
            const after = this.infoReturned, prior = this.infoNotification;
            let finished = false;
            const notification = { id, assigned: false, complete: (result: number = DPN.OK) => {
                if (finished) return; finished = true; returned(result); if (!result) after?.();
            } };
            this.infoNotification = notification;
            try { this.sync(); } finally { this.infoNotification = prior; }
            if (!notification.assigned) notification.complete();
        };
        engine.onPlayerCreated = (id, returned) => {
            const entity = engine.entities.get(id), generation = this.generation;
            if (this.engine !== engine || !entity || entity.group || this.disposed) { returned(DPN.USERCANCEL); return; }
            let finished = false;
            const owner = {};
            if (this.role === "server" && engine.kind === "native") this.serverCreations.set(id, owner);
            const current = () => this.engine === engine && generation === this.generation && !this.disposed &&
                engine.entities.get(id) === entity && this.playerReturns.has(complete);
            const complete = (result: number = DPN.OK) => {
                if (finished) return; finished = true;
                const live = current(); this.playerReturns.delete(complete);
                if (this.serverCreations.get(id) === owner) this.serverCreations.delete(id);
                returned(live ? result : DPN.USERCANCEL);
            };
            this.playerReturns.add(complete);
            this.known.set(id, clone(entity));
            this.emit({ type: 7, id, context: this.contexts.get(id) ?? 0, processed: complete, isCurrent: current });
        };
        engine.onGroupCreated = (id, returned, context = 0) => {
            const entity = engine.entities.get(id), generation = this.generation;
            if (this.engine !== engine || !entity?.group || this.disposed) { returned(DPN.USERCANCEL); return; }
            const current = () => this.engine === engine && generation === this.generation && !this.disposed;
            let finished = false;
            const complete = (result: number = DPN.OK) => {
                if (finished) return; finished = true;
                if (this.groupReturns.get(id) === complete) this.groupReturns.delete(id);
                returned(current() ? result : DPN.USERCANCEL);
            };
            this.groupReturns.set(id, complete);
            this.groupContexts.set(id, context);
            // Commit notification ownership before calling a possibly reentrant sink.
            this.known.set(id, clone(entity));
            this.emit({ type: 6, id, owner: entity.flags & 1 ? entity.groupOwner : 0,
                context, processed: complete, isCurrent: current });
        };
        engine.onGroupDestroyed = (id, returned) => {
            const entity = engine.queryGroup?.(id) ?? engine.entities.get(id), generation = this.generation;
            if (this.engine !== engine || !entity?.group || this.disposed) { returned(DPN.USERCANCEL); return; }
            let finished = false;
            const current = () => this.engine === engine && generation === this.generation &&
                this.groupDestructions.get(id) === complete && !this.disposed;
            const complete = (result: number = DPN.OK) => {
                if (finished) return; finished = true;
                const live = current();
                if (this.groupDestructions.get(id) === complete) this.groupDestructions.delete(id);
                if (live) this.groupContexts.delete(id);
                returned(live ? result : DPN.USERCANCEL);
            };
            this.groupDestructions.set(id, complete);
            this.known.delete(id);
            this.emitPeerGroupDestroy({ type: 8, id, context: this.groupContexts.get(id) ?? 0, reason: 1,
                processed: complete, isCurrent: current });
        };
        engine.onGroupMember = (group, player, add, returned) => {
            const generation = this.generation;
            if (this.engine !== engine || this.disposed) { returned(DPN.USERCANCEL); return; }
            let finished = false;
            const release = this.holdPeerMemberNotification(group, player);
            const current = () => this.engine === engine && generation === this.generation && this.memberReturns.has(complete) && !this.disposed;
            const complete = (result: number = DPN.OK) => {
                if (finished) return; finished = true;
                const live = current(); this.memberReturns.delete(complete);
                let success = false;
                try { returned(live ? result : DPN.USERCANCEL); success = live && !result; }
                finally { release?.(success); }
            };
            this.memberReturns.add(complete);
            const entity = engine.entities.get(group);
            if (entity?.group && !this.groupDestructions.has(group)) this.known.set(group, clone(entity));
            this.emit({ type: add ? 1 : 0x12, id: group, player,
                groupContext: this.groupContexts.get(group) ?? 0, playerContext: this.contexts.get(player) ?? 0,
                processed: complete, isCurrent: current });
            if (release && !this.onEvent) complete();
        };
        engine.onTermination = (data, reason) => { if (this.engine === engine) this.termination = { data, reason: reason ?? DPN.HOSTTERMINATEDSESSION }; };
        engine.onLocalTermination = reason => {
            if (this.engine === engine && !this.disposed)
                this.termination = { data: new Uint8Array(), reason, notified: true };
        };
        engine.onPlayerDestroyReason = (id, reason) => {
            if (this.engine !== engine || !this.known.has(id) || !reason) return;
            const prior = this.playerDestroyReasons.get(id);
            if (!prior || prior.engine !== engine || prior.generation !== this.generation || !prior.reason)
                this.playerDestroyReasons.set(id, { engine, generation: this.generation, reason });
        };
        engine.onNativeTermination = (data, reason, returned) => {
            const generation = this.generation;
            if (this.engine !== engine || this.disposed) { returned(DPN.USERCANCEL); return; }
            const terminal = { data: data.slice(), reason, notified: true, awaitingReturn: true };
            this.termination = terminal;
            const current = () => this.engine === engine && generation === this.generation && this.termination === terminal && !this.disposed;
            let finished = false;
            const finish = (result: number = DPN.OK) => {
                if (finished) return; finished = true;
                if (!current()) { returned(DPN.USERCANCEL); return; }
                if (result) { this.termination = null; returned(result); return; }
                terminal.awaitingReturn = false; returned();
            };
            if (!this.onEvent) { finish(); return; }
            this.emit({ type: 0x16, result: reason, data: terminal.data, processed: finish, isCurrent: current });
        };
    }
    private newEngine(): DirectPlaySession {
        const engine = new DirectPlaySession(this.network, this.timeout, 8);
        this.attach(engine);
        engine.onJoinRequest = request => this.onIndicate?.(request) ?? { hr: DPN.OK };
        engine.onJoinAccepted = (id, context) => this.contexts.set(id, context);
        return engine;
    }
    get error(): number {
        const completion = this.role === "client" ? this.engine.connectCompletionLease?.() : undefined;
        return this.overflow ? DPN.TABLEFULL : !this.initialized ? DPN.UNINITIALIZED :
            this.connecting || completion?.current() && !completion.entered ? DPN.CONNECTING : this.engine.openError ? dp8Result(this.engine.openError) : DPN.OK;
    }
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
            flags: this.role === "server" ? 0x100 : 0, name: { short: this.localInfo.name, shortNull: this.localInfo.nameNull, long: "", longNull: true }, data: this.localInfo.data }) as Reply;
        this.suppress = false;
        if (created.hr || !created.id) { this.engine.close(); return dp8Result(created.hr); }
        this.localId = created.id; this.contexts.set(created.id, context); this.sync(); return DPN.OK;
    }
    async hostNative(desc: SessionDesc, context: number, provider: DirectPlay8HostProvider, port = 0, caps = [20, 0, 200, 14, 25000]): Promise<number> {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (this.connecting) return DPN.CONNECTING;
        if (this.engine.desc) return this.engine.isHost ? DPN.HOSTING : DPN.ALREADYCONNECTED;
        if (this.role === "client") return DPN.INVALIDPARAM;
        if ((this.role === "server") !== !!((desc.extended?.flags ?? 0) & 1)) return DPN.INVALIDPARAM;
        const generation = ++this.generation; this.peerCreations.clear(); this.peerCreated.clear(); this.retiredPlayers.clear(); this.peerNotifications.clear(); this.peerGroupNotifications.clear(); this.localClosing = false; this.connecting = true; this.suppress = true;
        if (this.engine !== this.virtualProvider) this.engine.dispose();
        const backend = new NativeHostBackend(this.network, Math.max(1, caps[4]), Math.max(1, caps[2]), this.role);
        this.attach(backend);
        const result = await backend.start(desc, { name: this.localInfo.nameNull ? null : this.localInfo.name, data: Uint8Array.from(this.localInfo.data) }, provider, port,
            request => this.onNativeIndicate?.(request) ?? { hr: DPN.HOSTREJECTEDCONNECTION },
            (id, value) => { if (this.engine === backend && generation === this.generation) this.contexts.set(id, typeof value === "number" ? value : 0); },
            value => { if (this.engine === backend && !this.disposed) this.emit({ type: 0xf, context: typeof value === "number" ? value : 0 }); });
        if (generation !== this.generation || this.engine !== backend) return DPN.USERCANCEL;
        this.connecting = false; this.suppress = false;
        if (!result) { this.localId = backend.localId; this.contexts.set(this.localId, context); this.sync(); }
        return result;
    }
    async connect(desc: SessionDesc, context = 0, data = new Uint8Array()): Promise<number> {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (this.role === "server") return DPN.INVALIDPARAM;
        if (this.connecting) return DPN.CONNECTING;
        if (this.engine.desc) return DPN.ALREADYCONNECTED;
        if ((this.role === "client") !== !!((desc.extended?.flags ?? 0) & 1)) return DPN.INVALIDAPPLICATION;
        this.localClosing = false; this.useVirtual();
        const generation = ++this.generation; this.peerCreations.clear(); this.peerCreated.clear(); this.retiredPlayers.clear(); this.peerNotifications.clear(); this.peerGroupNotifications.clear(); this.connecting = true; this.suppress = true;
        const hr = dp8Result(await this.virtualProvider.join(desc, { name: { short: this.localInfo.name, shortNull: this.localInfo.nameNull, long: "", longNull: true }, data: this.localInfo.data, flags: 0 }, data));
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
        const generation = ++this.generation; this.peerCreations.clear(); this.peerCreated.clear(); this.retiredPlayers.clear(); this.peerNotifications.clear(); this.peerGroupNotifications.clear(); this.connecting = true; this.suppress = true;
        if (this.engine !== this.virtualProvider) this.engine.dispose();
        const backend = new NativeDirectPlayCore(this.network, this.role, Math.max(1, caps[4]), Math.max(1, caps[2]), Math.min(255, caps[3]));
        this.attach(backend);
        const hr = await backend.connect(address, desc, { name: { short: this.localInfo.name, shortNull: this.localInfo.nameNull, long: "", longNull: true }, data: this.localInfo.data, flags: 0 }, data, port).catch(() => { backend.close(); return DPN.GENERIC; });
        if (generation !== this.generation) return DPN.USERCANCEL;
        this.connecting = false; this.suppress = false;
        if (!hr) { this.localId = backend.localId; this.contexts.set(this.localId, context); this.sync(); }
        return hr;
    }
    connectCompletionLease(): DirectPlay8ConnectCompletionLease | undefined {
        const engine = this.engine, generation = this.generation, lease = engine.connectCompletionLease?.();
        if (!lease) return;
        const current = () => !this.disposed && this.engine === engine && this.generation === generation && lease.current();
        return { current, get entered() { return current() && lease.entered; },
            enter: () => { if (current()) lease.enter(); },
            complete: () => { if (current()) lease.complete(); },
            cancel: result => { if (current()) lease.cancel(result); } };
    }
    async beginClose(): Promise<number> { this.localClosing = true; return this.engine.shutdown ? this.engine.shutdown() : DPN.OK; }
    cancelConnect(): void {
        ++this.generation; this.peerCreations.clear(); this.peerCreated.clear(); this.retiredPlayers.clear(); this.peerNotifications.clear(); this.peerGroupNotifications.clear(); this.connecting = false; this.suppress = false; this.engine.close();
        this.localId = 0; this.sync();
    }
    close(): number {
        if (!this.initialized) return DPN.UNINITIALIZED;
        ++this.generation; this.serverCreations.clear(); this.cancelNativeTermination(); this.retiredGroups.clear(); this.playerDestroyReasons.clear(); this.peerCreations.clear(); this.peerCreated.clear(); this.retiredPlayers.clear(); this.peerNotifications.clear(); this.peerGroupNotifications.clear(); this.termination = null; this.localClosing = true; this.connecting = false; this.suppress = false;
        for (const finish of [...this.localProcessed]) finish(DPN.USERCANCEL);
        for (const finish of [...this.groupReturns.values()]) finish(DPN.USERCANCEL);
        for (const finish of [...this.groupDestructions.values()]) finish(DPN.USERCANCEL);
        for (const finish of [...this.memberReturns]) finish(DPN.USERCANCEL);
        for (const finish of [...this.playerReturns]) finish(DPN.USERCANCEL);
        this.engine.close(); this.sync(); this.localId = 0; this.contexts.clear(); this.groupContexts.clear(); return DPN.OK;
    }
    dispose(): void {
        this.close(); this.engine.dispose(); if (this.engine !== this.virtualProvider) this.virtualProvider.dispose(); this.initialized = false; this.disposed = true;
        if (this.eventRetry) clearTimeout(this.eventRetry); this.eventRetry = undefined;
        this.events = []; this.eventBytes = 0; this.retiredGroups.clear();
    }
    send(to: number, flags: number, data: Uint8Array, signal?: AbortSignal,
        delivered?: (metadata: import("./send-operations").DirectPlaySendMetadata) => void, completedLocal?: (result: number) => void): number | Promise<number> {
        if (signal?.aborted) return DPN.USERCANCEL;
        if (this.error) return this.error;
        if (!this.localId || (to && !this.engine.entities.has(to))) return DPN.INVALIDPLAYER;
        const localDelivery = () => delivered?.({ firstFrameRtt: 0, firstFrameRetries: 0, flags: flags & 8 ? 1 : 0 });
        if (this.engine.sendDpn) return this.engine.sendDpn(to, flags, data, signal, to === this.localId ? localDelivery : undefined, completedLocal);
        if (flags & 4) {
            const target = this.engine.entities.get(to);
            const recipients = !to ? [...this.engine.entities.values()].filter(e => !e.group).map(e => e.id) : target!.group ? target!.members : [to];
            const local = recipients.includes(this.localId) && !(flags & 0x20);
            if (local && (this.localProcessed.size >= 256 || this.localProcessedBytes + data.length > 4 * 1024 * 1024)) return DPN.TABLEFULL;
            const remote = recipients.some(id => id !== this.localId) ? this.engine.send(this.localId, to, flags & 8 ? 1 : 0, data) : DP.OK;
            const processed = local ? new Promise<number>(resolve => {
                const size = data.length, abort = () => finish(DPN.USERCANCEL);
                const finish = (result: number) => {
                    if (!this.localProcessed.delete(finish)) return;
                    this.localProcessedBytes -= size; signal?.removeEventListener("abort", abort); resolve(result);
                    // Groups and broadcasts may still await remote recipients.
                    if (to === this.localId) completedLocal?.(result);
                };
                this.localProcessed.add(finish); this.localProcessedBytes += size; signal?.addEventListener("abort", abort, { once: true });
                this.emit({ type: 0x11, id: this.localId, context: this.contexts.get(this.localId) ?? 0, data: data.slice(), flags: flags & 8 ? 1 : 0, processed: () => finish(DPN.OK) });
            }) : Promise.resolve(DPN.OK);
            if (local) localDelivery();
            return Promise.all([Promise.resolve(remote).then(dp8Result), processed]).then(([sent, handled]) => sent || handled);
        }
        const wireFlags = (flags & 8 ? 1 : 0) | (flags & 0x20 ? 0 : 0x10000);
        const result = this.engine.send(this.localId, to, wireFlags, data);
        if (to === this.localId && result === DP.OK) localDelivery();
        return result instanceof Promise ? result.then(dp8Result) : dp8Result(result);
    }
    setInfo(id: number, info: PlayerInfo, mask: number, afterInfo?: () => void): number | Promise<number> {
        if (!this.initialized) return DPN.UNINITIALIZED;
        if (!id) { if (mask & 1) { this.localInfo.name = info.name; this.localInfo.nameNull = !!info.nameNull; } if (mask & 2) this.localInfo.data = info.data.slice(); return DPN.OK; }
        if (this.error) return this.error;
        const prior = this.infoReturned; this.infoReturned = afterInfo;
        let result: Reply | Promise<Reply>;
        try { result = this.engine.mutate({ op: "mutate", action: "info", id, ...(mask & 1 ? { name: { short: info.name, shortNull: !!info.nameNull, long: "", longNull: true } } : {}),
            ...(mask & 2 ? { data: info.data } : {}) }); }
        finally { this.infoReturned = prior; }
        return result instanceof Promise ? result.then(reply => dp8Result(reply.hr)) : dp8Result(result.hr);
    }
    beginCreateGroup(info: PlayerInfo, context: number, completed?: (reply: Reply) => void): Reply | Promise<Reply> {
        if (this.error) { const reply = { hr: this.error }; completed?.(reply); return reply; }
        const native = this.engine.kind === "native", generation = this.generation;
        const pending = { context, assigned: false };
        if (!native) this.creatingGroups.push(pending);
        let finished = false;
        const finish = (reply: Reply): Reply => {
            const result = { ...reply, hr: generation === this.generation ? dp8Result(reply.hr) : DPN.USERCANCEL };
            if (!finished) {
                finished = true; this.creatingGroups = this.creatingGroups.filter(item => item !== pending);
                if (!native && !result.hr && result.id) {
                    if (!this.groupContexts.has(result.id)) this.groupContexts.set(result.id, context);
                    this.sync();
                }
                completed?.(result);
            }
            return result;
        };
        try {
            const result = this.engine.mutate({ op: "mutate", action: "create", group: true, parent: 0, flags: info.flags,
                name: { short: info.name, shortNull: !!info.nameNull, long: "", longNull: true }, data: info.data,
                context, completed: finish });
            return result instanceof Promise ? result.then(finish, () => finish({ hr: DPN.GENERIC })) : finish(result);
        } catch { return finish({ hr: DPN.GENERIC }); }
    }
    async createGroup(info: PlayerInfo, context: number): Promise<Reply> {
        return this.beginCreateGroup(info, context);
    }
    beginDestroyGroup(id: number, completed?: (reply: Reply) => void): Reply | Promise<Reply> {
        const generation = this.generation;
        let finished = false;
        const finish = (reply: Reply): Reply => {
            const result = { ...reply, hr: generation === this.generation ? dp8Result(reply.hr) : DPN.USERCANCEL };
            if (!finished) { finished = true; completed?.(result); }
            return result;
        };
        if (this.error) return finish({ hr: this.error });
        const error = this.groupDestroyError(id); if (error) return finish({ hr: error });
        try {
            const result = this.engine.mutate({ op: "mutate", action: "destroy", group: true, id, completed: finish });
            return result instanceof Promise ? result.then(finish, () => finish({ hr: DPN.GENERIC })) : finish(result);
        } catch { return finish({ hr: DPN.GENERIC }); }
    }
    async destroyGroup(id: number): Promise<number> { return (await this.beginDestroyGroup(id)).hr; }
    beginMember(group: number, player: number, add: boolean, completed?: (reply: Reply) => void): Reply | Promise<Reply> {
        const generation = this.generation;
        let finished = false;
        const finish = (reply: Reply): Reply => {
            const result = { ...reply, hr: generation === this.generation ? dp8Result(reply.hr) : DPN.USERCANCEL };
            if (!finished) { finished = true; completed?.(result); }
            return result;
        };
        if (this.error) return finish({ hr: this.error });
        const g = this.engine.entities.get(group), p = this.engine.entities.get(player);
        if (!g?.group) return finish({ hr: DPN.INVALIDGROUP });
        if (!player) return finish({ hr: add ? DPN.INVALIDPLAYER : DPN.INVALIDPARAM });
        if (!p || p.group) return finish({ hr: DPN.INVALIDPLAYER });
        if (this.engine.kind !== "native") {
            const linked = g.members.includes(player);
            if (add && linked) return finish({ hr: DPN.PLAYERALREADYINGROUP });
            if (!add && !linked) return finish({ hr: DPN.PLAYERNOTINGROUP });
        }
        try {
            const result = this.engine.mutate({ op: "mutate", action: "member", id: group, member: player, add, completed: finish });
            return result instanceof Promise ? result.then(finish, () => finish({ hr: DPN.GENERIC })) : finish(result);
        } catch { return finish({ hr: DPN.GENERIC }); }
    }
    async member(group: number, player: number, add: boolean): Promise<number> { return (await this.beginMember(group, player, add)).hr; }
    playerFlags(id: number): number { return (id === this.localId ? 2 : 0) | (id === this.hostId ? 4 : 0); }
    address(id: number): Address | null { return this.engine.playerAddress(id); }
    async flush(): Promise<void> { while (!this.disposed && this.events.length) await new Promise(resolve => setTimeout(resolve, 4)); }
    private cancelNativeTermination(): void {
        const cancelled = this.events.filter(event => event.type === 0x16 && event.isCurrent);
        this.events = this.events.filter(event => !(event.type === 0x16 && event.isCurrent));
        for (const event of cancelled) { this.eventBytes -= event.data?.length ?? 64; event.processed?.(DPN.USERCANCEL); }
        this.onCancelNativeTermination?.();
    }
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
    private flushingEvents = false;
    private flushEvents(): void {
        if (this.flushingEvents) return;
        this.flushingEvents = true;
        const generation = this.generation;
        try {
            while (this.events.length && generation === this.generation) {
                const event = this.events[0];
                if (this.onEvent?.(event) === false) break;
                if (this.events[0] === event) { this.events.shift(); this.eventBytes -= event.data?.length ?? 64; }
            }
        } finally { this.flushingEvents = false; }
        if (this.events.length && !this.eventRetry) {
            this.eventRetry = setTimeout(() => { this.eventRetry = undefined; this.flushEvents(); this.drain(); }, 4);
            (this.eventRetry as unknown as { unref?(): void }).unref?.();
        }
    }
    private holdPeerNotification(player: number): ((success: boolean) => void) | undefined {
        if (this.role !== "peer" || this.engine.kind !== "native") return undefined;
        let owner = this.peerNotifications.get(player);
        if (!owner || owner.engine !== this.engine || owner.generation !== this.generation) {
            owner = { engine: this.engine, generation: this.generation, refs: new Set(), failed: false };
            this.peerNotifications.set(player, owner);
        }
        const held = owner, token = {}; held.refs.add(token);
        return success => {
            if (!held.refs.delete(token)) return;
            if (this.peerNotifications.get(player) !== held || held.engine !== this.engine || held.generation !== this.generation || this.disposed) return;
            if (!success) held.failed = true;
            this.releasePeerDestroy(player);
        };
    }
    private releasePeerDestroy(player: number): void {
        const owner = this.peerNotifications.get(player);
        if (!owner || owner.engine !== this.engine || owner.generation !== this.generation || owner.refs.size || this.peerCreations.has(player)) return;
        // A discarded notification is not an actual return; retain its failure until destruction or generation change.
        if (owner.failed && !owner.destroy) return;
        this.peerNotifications.delete(player);
        if (!owner.failed && owner.destroy) {
            const event = owner.destroy, retired = this.retiredPlayers.get(player);
            event.context = this.contexts.get(player) ?? 0;
            const current = () => !!retired && this.retiredPlayers.get(player) === retired && this.engine === owner.engine &&
                this.generation === owner.generation && !this.disposed && !this.engine.entities.has(player);
            let finished = false;
            event.isCurrent = current;
            event.processed = result => {
                if (finished) return; finished = true;
                if (!result && current()) this.retiredPlayers.delete(player);
            };
            this.emit(event);
            if (!this.onEvent) event.processed();
        }
    }
    private holdPeerGroupNotification(group: number): ((success: boolean, after: (success: boolean) => void) => void) | undefined {
        if (this.role !== "peer" || this.engine.kind !== "native") return undefined;
        let owner = this.peerGroupNotifications.get(group);
        if (!owner || owner.engine !== this.engine || owner.generation !== this.generation) {
            owner = { engine: this.engine, generation: this.generation, refs: new Set(), failed: false };
            this.peerGroupNotifications.set(group, owner);
        }
        const held = owner, token = {}; held.refs.add(token);
        return (success, after) => {
            if (!held.refs.delete(token)) return;
            if (this.peerGroupNotifications.get(group) !== held || held.engine !== this.engine || held.generation !== this.generation || this.disposed) { after(false); return; }
            if (!success) held.failed = true;
            this.releasePeerGroupDestroy(group, after, success);
        };
    }
    private releasePeerGroupDestroy(group: number, after?: (success: boolean) => void, ownSuccess = true): void {
        const owner = this.peerGroupNotifications.get(group);
        if (!owner || owner.engine !== this.engine || owner.generation !== this.generation) { after?.(false); return; }
        if (owner.refs.size) { after?.(ownSuccess); return; }
        if (owner.failed && !owner.destroy) { after?.(ownSuccess); return; }
        this.peerGroupNotifications.delete(group);
        if (owner.failed) { after?.(ownSuccess); return; }
        if (!owner.destroy) { after?.(true); return; }
        const event = owner.destroy, processed = event.processed;
        if (after) {
            let finished = false;
            const finish = (result?: number) => {
                if (finished) return; finished = true;
                try { processed?.(result); } finally { after(!result); }
            };
            event.processed = finish;
        }
        this.emit(event);
        if (!this.onEvent) event.processed?.();
    }
    private emitPeerGroupDestroy(event: DirectPlay8Event): void {
        if (this.role !== "peer" || this.engine.kind !== "native") { this.emit(event); return; }
        const group = event.id!;
        let owner = this.peerGroupNotifications.get(group);
        if (!owner || owner.engine !== this.engine || owner.generation !== this.generation) {
            owner = { engine: this.engine, generation: this.generation, refs: new Set(), failed: false };
            this.peerGroupNotifications.set(group, owner);
        }
        owner.destroy ??= event;
        this.releasePeerGroupDestroy(group);
    }
    private holdPeerMemberNotification(group: number, player: number): ((success: boolean) => void) | undefined {
        const groupRelease = this.holdPeerGroupNotification(group), playerRelease = this.holdPeerNotification(player);
        if (!groupRelease && !playerRelease) return undefined;
        return success => {
            if (groupRelease) groupRelease(success, groupSuccess => playerRelease?.(success && groupSuccess));
            else playerRelease?.(success);
        };
    }
    private emitImplicitPeerRemoval(event: DirectPlay8Event): void {
        const release = this.holdPeerMemberNotification(event.id!, event.player!);
        if (release) event.processed = result => release(!result);
        this.emit(event);
        if (release && !this.onEvent) release(true);
    }
    private sync(): void {
        if (this.suppress || this.connecting) return;
        const syncEngine = this.engine, syncGeneration = this.generation, next = this.engine.entities;
        const implicitRemovals = new Set<string>();
        if (this.role === "peer" && this.engine.kind === "native") {
            // Stage unlinked membership notifications before a removed player can be destroyed.
            for (const [id, entity] of next) if (entity.group && !this.groupDestructions.has(id)) {
                const old = this.known.get(id);
                for (const player of [...(old?.members ?? [])]) if (!entity.members.includes(player)) {
                    implicitRemovals.add(id + ":" + player);
                    // Commit the projection before a reentrant sink can repeat this notification.
                    old!.members = old!.members.filter(member => member !== player);
                    this.emitImplicitPeerRemoval({ type: 0x12, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
                    if (this.engine !== syncEngine || this.generation !== syncGeneration) return;
                }
            }
        }
        for (const [id, old] of [...this.known].sort((a, b) => Number(b[1].group) - Number(a[1].group))) if (!next.has(id) && this.known.get(id) === old) {
            if (old.group && this.engine.groupState?.(id) === "deleted") continue;
            // Own the removal before a callback can reenter synchronization.
            this.known.delete(id);
            for (const player of old.members) {
                this.emitImplicitPeerRemoval({ type: 0x12, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
                if (this.engine !== syncEngine || this.generation !== syncGeneration) return;
            }
            const endedReason = this.localClosing ? 1 : this.termination?.reason === DPN.HOSTTERMINATEDSESSION ? 3 : !old.group && this.engine.lost ? 2 : 1;
            const captured = this.playerDestroyReasons.get(id); this.playerDestroyReasons.delete(id);
            const playerReason = captured?.engine === this.engine && captured.generation === this.generation ? captured.reason : undefined;
            if (!(this.role === "client" && this.engine.kind === "native" && !old.group)) {
                const event: DirectPlay8Event = { type: old.group ? 8 : 9, id,
                    context: (old.group ? this.groupContexts : this.contexts).get(id) ?? 0,
                    reason: !old.group && playerReason !== undefined ? playerReason :
                        !this.engine.desc || this.termination?.notified && !this.termination.awaitingReturn ? endedReason :
                            old.group && (old.flags & 1) && !next.has(old.groupOwner) ? 2 : 1 };
                if (old.group) {
                    // Native keeps the deleted entry queryable until DESTROY_GROUP returns.
                    const retired = { entity: old, generation: this.generation, engine: this.engine };
                    this.retiredGroups.set(id, retired);
                    const current = () => retired.generation === this.generation && retired.engine === this.engine &&
                        this.retiredGroups.get(id) === retired && !this.disposed;
                    let finished = false;
                    event.isCurrent = current;
                    event.processed = () => {
                        if (finished) return; finished = true;
                        if (this.retiredGroups.get(id) !== retired) return;
                        const live = current(); this.retiredGroups.delete(id); if (live) this.groupContexts.delete(id);
                    };
                }
                if (!old.group && this.role === "peer" && this.engine.kind === "native") {
                    this.retiredPlayers.set(id, { engine: this.engine, generation: this.generation, created: this.peerCreated.has(id) });
                    this.peerCreated.delete(id);
                    let notification = this.peerNotifications.get(id);
                    if (!notification || notification.engine !== this.engine || notification.generation !== this.generation) {
                        notification = { engine: this.engine, generation: this.generation, refs: new Set(), failed: false };
                        this.peerNotifications.set(id, notification);
                    }
                    notification.destroy ??= event;
                    this.releasePeerDestroy(id);
                } else if (old.group) this.emitPeerGroupDestroy(event);
                else this.emit(event);
            }
        }
        for (const [id, entity] of next) {
            if (this.groupDestructions.has(id)) continue;
            const old = this.known.get(id);
            if (!old) {
                const owner = entity.group ? (entity.flags & 1 ? entity.groupOwner : 0) : [...next.values()].find(p => !p.group && p.owner === entity.owner)?.id ?? 0;
                if (entity.group && this.engine.kind !== "native" && entity.owner === this.engine.ownKey) {
                    const pending = this.creatingGroups.find(item => !item.assigned);
                    if (pending) { pending.assigned = true; this.groupContexts.set(id, pending.context); }
                }
                if (!(this.role === "client" && this.engine.kind === "native" && !entity.group)) {
                    if (this.role === "peer" && this.engine.kind === "native" && !entity.group) {
                        const creation = { engine: this.engine, generation: this.generation };
                        this.peerCreations.set(id, creation);
                        // Publish identity before the callback sink can reenter synchronization.
                        this.known.set(id, clone(entity));
                        const current = () => this.engine === creation.engine && this.generation === creation.generation &&
                            this.peerCreations.get(id) === creation && !this.disposed;
                        const complete = (result: number = DPN.OK) => {
                            if (!current()) return;
                            this.peerCreations.delete(id);
                            if (!result) {
                                const retired = this.retiredPlayers.get(id);
                                if (retired?.engine === creation.engine && retired.generation === creation.generation) retired.created = true;
                                else if (this.engine.entities.has(id)) this.peerCreated.add(id);
                            }
                            const notification = this.peerNotifications.get(id);
                            if (result && notification) notification.failed = true;
                            this.releasePeerDestroy(id);
                        };
                        this.emit({ type: 7, id, owner, context: this.contexts.get(id) ?? 0, processed: complete, isCurrent: current });
                        if (!this.onEvent) complete();
                    } else this.emit({ type: entity.group ? 6 : 7, id, owner, context: (entity.group ? this.groupContexts : this.contexts).get(id) ?? 0 });
                }
            } else if ((this.infoNotification?.id === id && !this.infoNotification.assigned) || JSON.stringify(old.name) !== JSON.stringify(entity.name) || JSON.stringify(old.data) !== JSON.stringify(entity.data)) {
                const notification = this.infoNotification?.id === id ? this.infoNotification : undefined;
                if (notification) notification.assigned = true;
                const nativeClient = this.engine.kind === "native" && this.role === "client" && !entity.group;
                const silent = this.engine.kind === "native" && !entity.group &&
                    (this.role === "server" && id === this.localId || nativeClient && id !== this.hostId);
                if (silent) { notification?.complete(); continue; }
                this.emit({ type: entity.group ? 0xc : this.role === "client" ? 0x15 : this.role === "server" ? 4 : 0x10,
                    id: nativeClient ? 0 : id, context: nativeClient ? 0 : (entity.group ? this.groupContexts : this.contexts).get(id) ?? 0, processed: notification?.complete });
            }
        }
        // Membership callbacks follow all create notifications so both contexts exist.
        for (const [id, entity] of next) if (entity.group && !this.groupDestructions.has(id)) {
                const old = this.known.get(id);
                for (const player of old?.members ?? []) if (!entity.members.includes(player) && !implicitRemovals.has(id + ":" + player)) this.emitImplicitPeerRemoval({ type: 0x12, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
                for (const player of entity.members) if (!old?.members.includes(player)) this.emit({ type: 1, id, player, groupContext: this.groupContexts.get(id) ?? 0, playerContext: this.contexts.get(player) ?? 0 });
        }
        const desc = this.engine.desc ? JSON.stringify(this.engine.desc) : "";
        if (this.previousDesc && desc && this.previousDesc !== desc) this.emit({ type: 2 });
        const host = this.hostId;
        if (this.previousHost && host && host !== this.previousHost) this.emit({ type: 0xd, id: host, context: this.contexts.get(host) ?? 0 });
        this.previousHost = host; this.previousDesc = desc;
        this.known = new Map([...next].filter(([id]) => !this.groupDestructions.has(id)).map(([id, entity]) => [id, clone(entity)]));
        if ((this.engine.lost || this.termination) && !this.termination?.awaitingReturn &&
            !(this.termination?.notified && this.engine.desc)) {
            const terminal = this.termination; this.termination = null;
            if (!terminal?.notified)
                this.emit({ type: 0x16, result: terminal?.reason ?? DPN.CONNECTIONLOST, data: terminal?.data ?? new Uint8Array() });
        }
        this.drain();
    }
    private drain(): void {
        if (this.suppress || this.connecting) return;
        while (this.engine.queue.length) {
            if (this.events.length >= 4096 || this.eventBytes >= 4 * 1024 * 1024) return;
            const message = this.engine.queue[0]; this.engine.removeMessage(0);
            if (!message.system) this.emit({ type: 0x11, id: this.role === "client" && this.engine.kind === "native" ? 0 : message.from,
                context: this.contexts.get(this.role === "client" && this.engine.kind === "native" ? this.hostId : message.from) ?? 0, data: message.data, processed: message.processed, flags: message.flags && (message.flags & 1) ? 1 : 0 });
        }
    }
}
