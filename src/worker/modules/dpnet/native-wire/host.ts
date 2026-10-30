import type { LanNetwork, LanDatagram } from "../../../net/lan-network";
import type { Address, Entity, Reply, SessionDesc } from "../../dplayx/session";
import type { DirectPlay8Message } from "../backend";
import { DPN } from "../constants";
import { NativeDirectPlayPort } from "./port";
import { NativeDirectPlayChannel } from "./channel";
import { DN, decodeNativeProtocolFrame } from "./frame-codec";
import type { NativeReassembledMessage } from "./receive-window";
import { decodeNativePlayerConnect, encodeNativeCoreConnectInfo, NativeCoreSnapshotCapacityError, type NativeCoreApplication, type NativePlayerConnectInfo, type NativeNameTableEntry } from "./core-connect-codec";
import { decodeNativeCoreOperation, encodeNativePlayerAdded, nativeCoreWords } from "./core-operations";
import { decodeNativeInfoRequest, encodeNativeInfoUpdate, type NativeInfoRequest } from "./info-operations";
import { decodeNativeGroupRequest, encodeNativeGroupAdded, decodeNativeGroupDestroyRequest, encodeNativeGroupDestroyed, decodeNativeMemberRequest, encodeNativeMemberChanged } from "./group-operations";
import type { NativeReliableReservation } from "./reliable-link";
import { NativeGroupMemberships, type GroupState, type MemberHook } from "./group-memberships";

export interface NativeHostDecision { hr: number; data?: Uint8Array; context?: unknown; release?(): void; returnBuffer?(): void | Promise<void>; }
export interface NativeHostJoin { address: Address; info: NativePlayerConnectInfo; signal: AbortSignal; }
export type NativeHostRole = "peer" | "server";
export interface NativeHostOptions {
    role?: NativeHostRole;
    port: number | NativeDirectPlayPort;
    application: NativeCoreApplication;
    player: { name: string | null; data: Uint8Array };
    /** Provider-resolved URLs and ingress policy; no implicit wildcard or guessed NAT address. */
    url(address: Address): string;
    allowIncoming(address: Address): boolean;
    admit(request: NativeHostJoin): NativeHostDecision | Promise<NativeHostDecision>;
    accepted?(id: number, context: unknown): void;
    replyReleased?(decision: NativeHostDecision): void | Promise<void>;
    aborted?(context: unknown): void;
    timeout?: number;
    retryInterval?: number;
}
interface HeldPacket { connection: Connection; reservation: NativeReliableReservation; started: boolean; }
interface Publication { generation: number; held: HeldPacket[]; }
interface TerminationDrain { channels: Set<NativeDirectPlayChannel>; port?: NativeDirectPlayPort; release: () => void; }
interface Connection {
    address: Address; channel?: NativeDirectPlayChannel; controller: AbortController;
    phase: "handshake" | "admitting" | "table" | "connected" | "closing";
    generation: number; timer?: ReturnType<typeof setTimeout>; reserved: boolean; reportedVersion: number;
    creating?: boolean; releasingReceives?: boolean; heldReceives: DirectPlay8Message[];
    callbackActive?: boolean; retirement?: { result: number; reason?: 1 | 2 | 4 };
    destroyChannel?: NativeDirectPlayChannel;
    id?: number; entry?: NativeNameTableEntry; context?: unknown; admitted?: boolean; c3: boolean; replyReleased: boolean; membership?: Publication; promotion?: Publication;
}
const key = (a: Address) => a.node.join(".") + ":" + a.port;
const clone = (a: Address): Address => ({ node: a.node.slice(), port: a.port });
const zeroGuid = "0".repeat(32);
/**
 * Native peer authority: versioned snapshots and membership operations share
 * bounded, per-recipient reliable FIFO reservations. Physical binding/ingress
 * remain owned by the provider. No migration or failure-arbitration policy.
 */
export class NativeDirectPlayHost {
    readonly entities = new Map<number, Entity>();
    readonly queue: DirectPlay8Message[] = [];
    onChange?: () => void;
    onMessage?: (id: number) => void;
    onInfo?: (id: number, returned: (result?: number) => void, notify?: boolean) => void;
    onPlayerCreated?: (id: number, returned: (result?: number) => void) => void;
    onPlayerDestroyReason?: (id: number, reason: number) => void;
    onGroupCreated?: (id: number, returned: (result?: number) => void, context?: number) => void;
    onGroupDestroyed?: (id: number, returned: (result?: number) => void) => void;
    onGroupMember?: MemberHook;
    onProcessingComplete?: (id: number, handle: number) => void;
    localId = 0;
    desc: SessionDesc | null = null;
    private port?: NativeDirectPlayPort;
    private options?: NativeHostOptions;
    private role: NativeHostRole = "peer";
    private heldReceiveCount = 0;
    private heldReceiveBytes = 0;
    private hostEntry?: NativeNameTableEntry;
    private groups = new Map<number, NativeNameTableEntry>();
    private groupCreations = new Set<(result: number) => void>();
    private groupDestructions = new Map<number, (result: number) => void>();
    private memberships = new NativeGroupMemberships();
    private memberOperations = new Set<(result: number) => void>();
    private connections = new Map<string, Connection>();
    private generation = 0;
    private version = 2;
    // NT5 initializes NameTable.LatestVersion to0; normal C9/CA never advances it.
    private latestVersion = 0;
    private reservations = 0;
    private decisions = new Set<Connection>();
    private decisionBytes = 0;
    private draining = new Set<NativeDirectPlayChannel>();
    private terminationDrains = new Set<TerminationDrain>();
    private terminationOwners = new Set<{ generation: number; cancelled: boolean; queued: boolean; channels: Set<NativeDirectPlayChannel>; jobs: { channel: NativeDirectPlayChannel; result: Promise<number> }[] }>();
    private publications = new Set<Publication>();
    private queueBytes = 0;
    private closing = false;
    private disposed = false;
    private clearing = false;
    private removeState?: () => void;
    private incoming = (packet: LanDatagram) => this.acceptPacket(packet);
    constructor(readonly network: LanNetwork) {}
    get localAddress(): Address { return { node: Array.from(this.network.node), port: this.port?.localPort ?? 0 }; }
    get currentPlayers(): number { return [...this.entities.values()].filter(entity => !entity.group).length + this.reservations; }
    get pendingAdmissions(): number { return this.decisions.size; }
    get retainedAdmissionBytes(): number { return this.decisionBytes; }
    get retainedTableBytes(): number { return this.tableBytes(); }
    get pendingPeers(): number { return [...this.connections.values()].filter(c => c.phase !== "connected").length; }
    get peerCount(): number { return this.connections.size; }
    get pendingBytes(): number { return (this.port?.pendingBytes ?? 0) + this.queueBytes; }
    get isHost(): boolean { return !!this.desc && !this.closing; }
    start(options: NativeHostOptions): number {
        if (this.disposed) return DPN.INVALIDOBJECT;
        if (this.clearing) return DPN.ALREADYCLOSING;
        if (this.desc) return DPN.HOSTING;
        const role = options.role ?? "peer";
        if ((role === "server") !== !!(options.application.flags & 1)) return DPN.INVALIDPARAM;
        if (options.application.flags & ~1) return DPN.UNSUPPORTED;
        if (!Number.isInteger(options.application.maxPlayers) || options.application.maxPlayers < 0 || options.application.maxPlayers > 0xffffffff) return DPN.INVALIDPARAM;
        if (!this.network.connected) return DPN.NOCONNECTION;
        if (!/^[0-9a-f]{32}$/i.test(options.application.application) || !/^[0-9a-f]{32}$/i.test(options.application.instance)) return DPN.INVALIDPARAM;
        const appBytes = options.application.reserved.length + options.application.applicationData.length + options.player.data.length +
            2 * ((options.player.name?.length ?? 0) + (options.application.name?.length ?? 0) + (options.application.password?.length ?? 0));
        if (appBytes > 1024 * 1024) return DPN.DATATOOLARGE;
        this.options = { ...options, application: structuredClone(options.application), player: { name: options.player.name, data: options.player.data.slice() } };
        this.closing = false; this.role = role; const generation = ++this.generation; this.version = 2; this.latestVersion = 0;
        try {
            const port = typeof options.port === "number" ? new NativeDirectPlayPort(this.network, options.port) : options.port;
            if (port.network !== this.network || !port.live) throw Error("Invalid provider UDP binding");
            this.port = port;
            if (!this.port.listen(this.incoming)) throw Error("Native listen unavailable");
            this.localId = this.newId(this.version);
            const app = options.application;
            this.desc = { instance: app.instance, application: app.application, flags: 0, maxPlayers: app.maxPlayers, name: app.name ?? "", nameNull: app.name === null,
                password: app.password ?? "", passwordNull: app.password === null, user: [0, 0, 0, 0], extended: { flags: app.flags, reserved: [...app.reserved], application: [...app.applicationData] } };
            this.hostEntry = { id: this.localId, owner: 0, flags: role === "server" ? 0x402 : 0x102, version: 2, unused: 0, coreVersion: 2, name: options.player.name, data: options.player.data.slice(), url: null };
            const local = this.entity(this.hostEntry, this.localAddress);
            const tracked = this.memberships.track(local); if (tracked) { this.close(); return tracked; }
            this.entities.set(this.localId, local);
            this.removeState = this.network.onStateChange(() => { if (this.port && !this.port.live) this.close(); });
            if (!this.notifyChange()) { this.close(); return DPN.GENERIC; }
            return generation === this.generation && !this.closing ? DPN.OK : DPN.USERCANCEL;
        } catch { this.close(); return DPN.INVALIDDEVICEADDRESS; }
    }
    private newId(version: number): number {
        // NT5 NameTable handles contain a 20-bit slot and 12-bit entry version,
        // XORed with the first DWORD of the instance GUID (wire byte order).
        // FindEntry validates both parts; an arbitrary identifier is not a handle.
        if (version > 0xfff) throw Error("NameTable version exhausted");
        const prefix = this.options!.application.instance.slice(0, 8);
        const mask = parseInt(prefix.match(/../g)!.reverse().join(""), 16) >>> 0;
        const used = new Set<number>();
        for (const id of this.entities.keys()) used.add((id ^ mask) & 0xfffff);
        for (const c of this.connections.values()) if (c.id !== undefined) used.add((c.id ^ mask) & 0xfffff);
        // Slot zero is invalid, slot one belongs to the implicit ALL_PLAYERS group.
        // Keep finite slots so even hostile churn cannot
        // force a native receiver to grow a sparse million-entry table.
        for (let index = 2; index < 64; index++) {
            if (used.has(index)) continue;
            const id = ((version << 20 | index) ^ mask) >>> 0;
            if (id !== 0) return id;
        }
        throw Error("DPNID allocation exhausted");
    }
    private live(c: Connection): boolean { return c.generation === this.generation && !this.closing && this.connections.get(key(c.address)) === c; }
    private acceptPacket(packet: LanDatagram): void {
        if (!this.port?.live || !this.options || this.closing) return;
        const address = { node: Array.from(packet.srcNode), port: packet.srcPort };
        let frame = decodeNativeProtocolFrame(packet.data);
        // Native Windows peers wrap the CONNECT opcode in a data frame: the
        // payload starts with the opcode and carries the control body
        // (version, session id, timestamp, extra) after it. Normalize such
        // frames so admission sees the same shape our own link produces.
        if (frame?.kind === "data" && frame.payload.length >= 16 && frame.payload[0] === DN.CONNECT) {
            const body = frame.payload, view = new DataView(body.buffer, body.byteOffset, body.byteLength);
            frame = { kind: "control", command: frame.command, opcode: DN.CONNECT, messageId: frame.sequence, responseId: frame.nextReceive,
                version: view.getUint32(4, true), sessionId: view.getUint32(8, true), timestamp: view.getUint32(12, true), extra: body.subarray(16) };
        }
        if (!frame || frame.kind !== "control" || frame.opcode !== DN.CONNECT || frame.version >>> 16 !== 1 ||
            this.connections.size >= 16) return;
        const port = this.port, options = this.options, generation = this.generation;
        try { if (!options.allowIncoming(clone(address))) return; } catch { return; }
        // The provider policy is user code and may close/restart or reenter Host.
        if (generation !== this.generation || this.port !== port || !port.live || this.closing ||
            this.connections.has(key(address)) || this.connections.size >= 16) return;
        const c: Connection = { address, controller: new AbortController(), phase: "handshake", generation: this.generation, reserved: false, reportedVersion: 0, heldReceives: [], c3: false, replyReleased: false };
        this.connections.set(key(address), c);
        try {
            c.channel = new NativeDirectPlayChannel(this.network, address, { timeout: options.timeout, retryInterval: options.retryInterval,
                onMessage: m => !this.live(c) || this.receive(c, m),
                onState: (state, result) => { if (state === "closed" && this.live(c)) this.retire(c, result, result === DPN.OK ? 1 : 2); } }, 0, port);
            c.timer = setTimeout(() => { if (this.live(c) && c.phase !== "connected") this.retire(c, DPN.TIMEDOUT); }, options.timeout ?? 25000);
            (c.timer as unknown as { unref?(): void }).unref?.();
            void c.channel.link.listen(); c.channel.deliver(packet);
        } catch { this.retire(c, DPN.NOCONNECTION); }
    }
    private receive(c: Connection, message: NativeReassembledMessage): boolean {
        if (c.retirement || message.command & DN.USER2) return true;
        if (!(message.command & DN.USER1)) return this.enqueueConnection(c, message.payload, message.command & DN.RELIABLE ? 1 : 0);
        if (c.phase === "handshake") {
            const info = decodeNativePlayerConnect(message.payload);
            if (info) { c.phase = "admitting"; void this.admit(c, info, message.payload.length); }
            return true;
        }
        const info = decodeNativeInfoRequest(message.payload);
        if (info && c.phase === "connected") {
            const result = this.updateInfo(info, c.id!);
            if (result && this.live(c)) void c.channel!.link.sendReliable(nativeCoreWords(0xde, info.handle, result)).then(hr => { if (hr && this.live(c)) this.retire(c, hr); });
            return true;
        }
        const group = decodeNativeGroupRequest(message.payload);
        if (group && c.phase === "connected") {
            const result = this.createGroup(group.flags, group.name, group.data, c.id!, group.handle);
            const reply = (value: Reply) => {
                if (value.hr && this.live(c)) void c.channel!.link.sendReliable(nativeCoreWords(0xde, group.handle, value.hr)).then(hr => { if (hr && this.live(c)) this.retire(c, hr); });
            };
            if (result instanceof Promise) void result.then(reply); else reply(result);
            return true;
        }
        const destroyed = decodeNativeGroupDestroyRequest(message.payload);
        if (destroyed && c.phase === "connected") {
            const result = this.destroyGroup(destroyed.id, c.id!, destroyed.handle);
            const reply = (value: Reply) => {
                if (value.hr && this.live(c)) void c.channel!.link.sendReliable(nativeCoreWords(0xde, destroyed.handle, value.hr)).then(hr => { if (hr && this.live(c)) this.retire(c, hr); });
            };
            if (result instanceof Promise) void result.then(reply); else reply(result);
            return true;
        }
        const member = decodeNativeMemberRequest(message.payload);
        if (member && c.phase === "connected") {
            const result = this.member(member.group, member.player, member.add, c.id!, member.handle);
            const reply = (value: Reply) => {
                if (value.hr && this.live(c)) void c.channel!.link.sendReliable(nativeCoreWords(0xde, member.handle, value.hr)).then(hr => { if (hr && this.live(c)) this.retire(c, hr); });
            };
            if (result instanceof Promise) void result.then(reply); else reply(result);
            return true;
        }
        const op = decodeNativeCoreOperation(message.payload); if (!op) return true;
        if (op.command === 0xc3 && c.phase === "table") { c.c3 = true; this.promote(c); }
        else if (op.command === 0xc9 && c.phase === "connected" && this.role === "peer") this.receiveVersion(c, op.version);
        else if (op.command === 0xe1 && c.phase === "connected" && message.payload.length === 8)
            this.onProcessingComplete?.(c.id!, op.handle!);
        else if (op.command === 0xe0 && (c.phase === "connected" || this.role === "server" && c.phase === "table")) {
            let acknowledged = false;
            return this.enqueueConnection(c, op.data!, message.command & DN.RELIABLE ? 1 : 0, () => {
                if (!acknowledged && this.live(c)) { acknowledged = true; void c.channel!.link.sendReliable(nativeCoreWords(0xe1, op.handle!)); }
            });
        }
        return true;
    }
    /** Normal Host report assignment and aggregate resync; no Host-local history prune. */
    private receiveVersion(connection: Connection, version: number): void {
        connection.reportedVersion = version;
        let oldest = version;
        for (const other of this.connections.values()) if (other.phase === "connected" && !other.retirement && other.entry &&
            !(other.entry.flags & 0x10) && other.id !== this.localId)
            oldest = Math.min(oldest, other.reportedVersion);
        if (oldest <= this.latestVersion) return;
        const packet = nativeCoreWords(0xca, oldest, 0);
        // Operation version0/excludedID0 fans out independently of Available-min membership.
        this.publish(this.reserveCommitted(this.recipients(0).map(connection => ({ connection, data: packet }))));
    }
    setInfo(id: number, mask: number, name: string | null, data: Uint8Array): number {
        return this.updateInfo({ id, mask, name, data, handle: 0 }, this.localId);
    }
    private entryBytes(entry: NativeNameTableEntry): number { return 48 + 2 * (entry.name?.length ?? 0) + entry.data.length + (entry.url?.length ?? 0); }
    private tableBytes(): number {
        let bytes = this.hostEntry ? this.entryBytes(this.hostEntry) : 0;
        for (const c of this.connections.values()) if (c.entry) bytes += this.entryBytes(c.entry);
        for (const entry of this.groups.values()) bytes += this.entryBytes(entry);
        return bytes;
    }
    /**
     * Both local Host and authenticated D2 requests commit through this authority.
     * CREATE_GROUP return releases only this operation's tail, not all later versions.
     */
    createGroup(flags: number, name: string | null, source: Uint8Array, requesting: number, handle = 0,
        context = 0, completed?: (reply: Reply) => void): Reply | Promise<Reply> {
        const refuse = (hr: number): Reply => { const reply = { hr }; completed?.(reply); return reply; };
        if (this.closing) return refuse(DPN.ALREADYCLOSING);
        if (!this.desc || !this.port?.live) return refuse(DPN.NOCONNECTION);
        const owner = this.entities.get(requesting);
        if (!owner || owner.group) return refuse(DPN.INVALIDPLAYER);
        if (!Number.isInteger(flags) || flags < 0 || flags > 1 || !Number.isInteger(context) || context < 0 || context > 0xffffffff ||
            !Number.isInteger(handle) || handle < 0 || handle > 0xffffffff ||
            name !== null && (typeof name !== "string" || name.includes("\0"))) return refuse(DPN.INVALIDPARAM);
        if ((name?.length ?? 0) > 1024 || source.length > 60000) return refuse(DPN.DATATOOLARGE);
        if (this.version >= 0xfff) return refuse(DPN.TABLEFULL);
        const generation = this.generation, version = this.version + 1;
        let id: number, entry: NativeNameTableEntry;
        try {
            id = this.newId(version);
            entry = { id, owner: requesting, flags: 0x10 | (flags & 1 ? 0x40 : 0), version, unused: 0,
                coreVersion: 2, name, data: source.slice(), url: null };
        } catch { return refuse(DPN.TABLEFULL); }
        if (this.tableBytes() + this.entryBytes(entry) > 4 * 1024 * 1024) return refuse(DPN.TABLEFULL);
        const entity: Entity = { id, group: true, owner: owner.owner, flags: flags & 1,
            name: { short: name ?? "", shortNull: name === null, long: "", longNull: true },
            data: [...entry.data], members: [], parent: 0, groupOwner: requesting };
        const tracked = this.memberships.track(entity, false); if (tracked) return refuse(tracked);
        let settled: Reply | undefined, resolve: ((reply: Reply) => void) | undefined;
        let returned = false;
        const finish = (hr: number) => {
            if (settled) return;
            settled = { hr, ...(hr === DPN.OK ? { id } : {}) };
            this.groupCreations.delete(finish);
            try { completed?.(settled); } finally { resolve?.(settled); }
        };
        this.groupCreations.add(finish);
        this.version = version; this.groups.set(id, entry);
        this.entities.set(id, entity);
        const live = () => generation === this.generation && !this.closing && !!this.desc && this.groups.get(id) === entry;
        const afterReturn = (result: number = DPN.OK) => {
            if (returned || settled) return; returned = true;
            if (!live()) { finish(DPN.USERCANCEL); return; }
            if (result) { finish(result); if (live()) this.close(); return; }
            try {
                this.memberships.created(id);
                if (this.role === "peer") {
                    // NT5 packs CURRENT entry info after the handler, retaining its creation version.
                    const packet = encodeNativeGroupAdded(requesting, handle, entry);
                    const publication = this.reserveCommitted(this.recipients(entry.version).map(connection => ({ connection, data: packet })));
                    this.publish(publication);
                }
                finish(live() ? DPN.OK : DPN.USERCANCEL);
            } catch { finish(DPN.GENERIC); if (live()) this.close(); }
        };
        try {
            if (this.onGroupCreated) this.onGroupCreated(id, afterReturn, context);
            else { if (!this.notifyChange()) afterReturn(DPN.GENERIC); else afterReturn(); }
        } catch { afterReturn(DPN.GENERIC); }
        // Preserve a genuinely inline completion; held callbacks retain a finite Host-owned promise.
        if (settled) return settled;
        return new Promise<Reply>(done => { resolve = done; });
    }
    queryGroup(id: number): Entity | undefined { return this.memberships.queryGroup(id); }
    groupState(id: number): GroupState { return this.memberships.groupState(id); }
    private memberNotification: MemberHook = (group, player, add, returned) => {
        if (this.onGroupMember) this.onGroupMember(group, player, add, returned);
        else returned(this.notifyChange() ? DPN.OK : DPN.GENERIC);
    };
    member(group: number, player: number, add: boolean, requesting: number, handle = 0, completed?: (reply: Reply) => void): Reply | Promise<Reply> {
        const refuse = (hr: number): Reply => { const reply = { hr }; completed?.(reply); return reply; };
        if (this.closing) return refuse(DPN.ALREADYCLOSING);
        if (!this.desc || !this.port?.live) return refuse(DPN.NOCONNECTION);
        const requester = this.entities.get(requesting), entity = this.entities.get(group), member = this.entities.get(player);
        if (!requester || requester.group) return refuse(DPN.INVALIDPLAYER);
        if (!entity?.group || !this.groups.has(group)) return refuse(DPN.INVALIDGROUP);
        if (!member || member.group) return refuse(DPN.INVALIDPLAYER);
        if (!Number.isInteger(handle) || handle < 0 || handle > 0xffffffff) return refuse(DPN.INVALIDPARAM);
        if (this.memberOperations.size >= 256 || this.version >= 0xfffffffe) return refuse(DPN.TABLEFULL);
        const generation = this.generation, version = this.version + 1;
        const pair = add ? this.memberships.beginAdd(group, player, version) : this.memberships.beginRemove(group, player, version);
        if (typeof pair === "number") return refuse(pair);
        const current = () => generation === this.generation && !this.closing && !!this.desc && !!this.port?.live;
        let settled: Reply | undefined, resolve: ((reply: Reply) => void) | undefined;
        const finish = (hr: number) => {
            if (settled) return;
            settled = { hr }; this.memberOperations.delete(finish);
            try { completed?.(settled); } finally { resolve?.(settled); }
        };
        this.memberOperations.add(finish);
        // SetMembership/RemoveMembership precommit the reserved version and linked list.
        this.version = version; entity.members = this.memberships.members(group);
        this.memberships.notify(pair, add, this.memberNotification, result => {
            if (settled) return;
            if (!current()) { finish(DPN.USERCANCEL); return; }
            if (result) { finish(result); if (current()) this.close(); return; }
            try {
                if (this.role === "peer") {
                    // Later operations may already have committed. Never relabel this reserved version.
                    const packet = encodeNativeMemberChanged(group, player, add, version, requesting, handle);
                    const publication = this.reserveCommitted(this.recipients(version).map(connection => ({ connection, data: packet })));
                    this.publish(publication);
                }
                finish(current() ? DPN.OK : DPN.USERCANCEL);
            } catch { finish(DPN.GENERIC); if (current()) this.close(); }
        });
        if (settled) return settled;
        return new Promise<Reply>(done => { resolve = done; });
    }
    /** Own implicit REMOVE tails differ from references held by another already-unlinked REMOVE. */
    destroyGroup(id: number, requesting: number, handle = 0, completed?: (reply: Reply) => void): Reply | Promise<Reply> {
        const refuse = (hr: number): Reply => { const reply = { hr }; completed?.(reply); return reply; };
        if (this.closing) return refuse(DPN.ALREADYCLOSING);
        if (!this.desc || !this.port?.live) return refuse(DPN.NOCONNECTION);
        const requester = this.entities.get(requesting), entity = this.entities.get(id), entry = this.groups.get(id);
        if (!requester || requester.group) return refuse(DPN.INVALIDPLAYER);
        const state = this.memberships.groupState(id);
        if (state === "deleted") return refuse(DPN.CONNECTIONLOST);
        if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || !entity?.group || !entry || state !== "live")
            return refuse(DPN.INVALIDGROUP);
        if (!Number.isInteger(handle) || handle < 0 || handle > 0xffffffff) return refuse(DPN.INVALIDPARAM);
        if (this.groupDestructions.size >= 256 || this.version >= 0xfffffffe) return refuse(DPN.TABLEFULL);
        const generation = this.generation;
        const current = () => generation === this.generation && !this.closing && !!this.desc && !!this.port?.live;
        let settled: Reply | undefined, resolve: ((reply: Reply) => void) | undefined;
        const finish = (hr: number) => {
            if (settled) return;
            settled = { hr }; this.groupDestructions.delete(id);
            try { completed?.(settled); } finally { resolve?.(settled); }
        };
        this.groupDestructions.set(id, finish);
        const started = this.memberships.destroy(id, this.memberNotification, (group, returned) => {
            if (this.onGroupDestroyed) this.onGroupDestroyed(group, returned); else returned();
        }, result => {
            if (settled) return;
            if (!current() || this.groups.get(id) !== entry || this.entities.get(id) !== entity) { finish(DPN.USERCANCEL); return; }
            if (result) { finish(result); if (current()) this.close(); return; }
            if (this.version >= 0xfffffffe) { finish(DPN.TABLEFULL); if (current()) this.close(); return; }
            try {
                const version = this.version + 1, packet = this.role === "peer" ? encodeNativeGroupDestroyed(id, version, requesting, handle) : undefined;
                this.groups.delete(id); this.entities.delete(id); this.memberships.committed(id); this.version = version;
                const publication = packet ? this.reserveCommitted(this.recipients(version).map(connection => ({ connection, data: packet }))) : undefined;
                if (!this.notifyChange()) { if (publication) this.cancel(publication); finish(DPN.GENERIC); if (current()) this.close(); return; }
                if (publication) this.publish(publication);
                finish(current() ? DPN.OK : DPN.USERCANCEL);
            } catch { finish(DPN.GENERIC); if (current()) this.close(); }
        });
        if (started) finish(started);
        if (settled) return settled;
        return new Promise<Reply>(done => { resolve = done; });
    }
    /** NT5 worker recipient selector: older entries with a real, live connection. */
    private recipients(version: number, exclude?: Connection): Connection[] {
        return [...this.connections.values()].filter(c => c !== exclude && this.live(c) && !c.retirement && !!c.entry &&
            (c.phase === "table" || c.phase === "connected") && (!version || c.entry.version < version));
    }
    private reserve(packets: { connection: Connection; data: Uint8Array }[]): Publication | number {
        const publication: Publication = { generation: this.generation, held: [] };
        for (const { connection, data } of packets) {
            const reservation = this.live(connection) ? connection.channel!.link.reserveReliable(data) : DPN.NOCONNECTION;
            if (typeof reservation === "number") { this.cancel(publication); return reservation; }
            publication.held.push({ connection, reservation, started: false });
        }
        if (publication.held.length) this.publications.add(publication);
        return publication;
    }
    /** A committed operation keeps successful children when another immediate send is refused. */
    private reserveCommitted(packets: { connection: Connection; data: Uint8Array }[]): Publication {
        const publication: Publication = { generation: this.generation, held: [] };
        for (const { connection, data } of packets) {
            const reservation = this.live(connection) ? connection.channel!.link.reserveReliable(data) : DPN.NOCONNECTION;
            // NT5 worker: a non-PENDING child send does not undo the operation or
            // imply carrier loss; release that target and continue the others.
            if (typeof reservation === "number") continue;
            publication.held.push({ connection, reservation, started: false });
        }
        if (publication.held.length) this.publications.add(publication);
        return publication;
    }
    private cancel(publication: Publication): void {
        this.publications.delete(publication);
        for (const held of publication.held) if (!held.started) { held.started = true; held.reservation.cancel(); }
        publication.held = [];
    }
    private publish(publication: Publication, only?: Connection): void {
        if (publication.generation !== this.generation || this.closing) { this.cancel(publication); return; }
        for (const held of publication.held) {
            if (held.started || (only && held.connection !== only)) continue;
            if (publication.generation !== this.generation || this.closing) { this.cancel(publication); return; }
            held.started = true;
            if (!this.live(held.connection)) { held.reservation.cancel(); continue; }
            void held.reservation.result.then(result => {
                publication.held = publication.held.filter(item => item !== held);
                if (result && publication.generation === this.generation && this.live(held.connection)) this.retire(held.connection, result);
            });
            held.reservation.start();
        }
        if (publication.held.every(held => held.started)) this.publications.delete(publication);
    }
    private updateInfo(info: NativeInfoRequest, requesting: number): number {
        if (this.closing) return DPN.ALREADYCLOSING;
        if (!this.desc || !this.port?.live) return DPN.NOCONNECTION;
        const entity = this.entities.get(info.id), connection = [...this.connections.values()].find(c => c.id === info.id && c.phase === "connected");
        const entry = info.id === this.localId ? this.hostEntry : this.groups.get(info.id) ?? connection?.entry;
        if (!entity || !entry) return DPN.INVALIDPLAYER;
        if (entity.group && this.memberships.groupState(info.id) !== "live") return DPN.INVALIDGROUP;
        // D2 closes local Host reentrancy; remote group-info authorization is a separate contract.
        if (entity.group && requesting !== this.localId) return DPN.UNSUPPORTED;
        if (info.mask & ~3) return DPN.INVALIDFLAGS;
        if ((info.mask & 1) && (info.name?.length ?? 0) > 1024 || (info.mask & 2) && info.data.length > 60000) return DPN.DATATOOLARGE;
        if (this.version >= 0xfffffffe) return DPN.TABLEFULL;
        if (this.role === "server") return this.updateServerInfo(info, requesting, entity, entry);
        const generation = this.generation, version = this.version + 1;
        let packet: Uint8Array, data: Uint8Array, dataList: number[];
        try { data = info.mask & 2 ? info.data.slice() : entry.data; dataList = info.mask & 2 ? [...data] : entity.data; packet = encodeNativeInfoUpdate({ ...info, data, version, requesting }); }
        catch { return DPN.OUTOFMEMORY; }
        if (this.tableBytes() - this.entryBytes(entry) + this.entryBytes({ ...entry, data, name: info.mask & 1 ? info.name : entry.name }) > 4 * 1024 * 1024) return DPN.TABLEFULL;
        const publication = this.reserve(this.recipients(version).map(connection => ({ connection, data: packet })));
        if (typeof publication === "number") return publication;
        // Local callback return releases the already reserved FIFO positions.
        this.version = version;
        if (info.mask & 1) { entry.name = info.name; entity.name = { ...entity.name, short: info.name ?? "", shortNull: info.name === null }; }
        if (info.mask & 2) { entry.data = data; entity.data = dataList; }
        let published = false, notificationError: number = DPN.OK;
        const publish = (result: number = DPN.OK) => {
            if (published) return; published = true;
            if (result || generation !== this.generation || this.closing || !this.desc) {
                if (result && generation === this.generation && !this.closing) this.close();
                this.cancel(publication);
                return;
            }
            this.publish(publication);
        };
        try {
            if (this.onInfo) this.onInfo(info.id, publish);
            else if (this.notifyChange()) publish();
            else { notificationError = DPN.GENERIC; publish(notificationError); }
        } catch { notificationError = DPN.GENERIC; publish(notificationError); }
        if (notificationError) return notificationError;
        if (generation !== this.generation || this.closing || !this.desc) return DPN.USERCANCEL;
        return DPN.OK;
    }
    /** Server's local info is silent; a Client request notifies before reserving CURRENT version. */
    private updateServerInfo(info: NativeInfoRequest, requesting: number, entity: Entity, entry: NativeNameTableEntry): number {
        const generation = this.generation, hostRequested = requesting === this.localId;
        const requester = [...this.connections.values()].find(c => c.id === requesting && c.phase === "connected");
        let data: Uint8Array, dataList: number[];
        try { data = info.mask & 2 ? info.data.slice() : entry.data; dataList = info.mask & 2 ? [...data] : entity.data; }
        catch { return DPN.OUTOFMEMORY; }
        if (this.tableBytes() - this.entryBytes(entry) + this.entryBytes({ ...entry, data, name: info.mask & 1 ? info.name : entry.name }) > 4 * 1024 * 1024)
            return DPN.TABLEFULL;
        if (info.mask & 1) { entry.name = info.name; entity.name = { ...entity.name, short: info.name ?? "", shortNull: info.name === null }; }
        if (info.mask & 2) { entry.data = data; entity.data = dataList; }
        // The original invocation retains its entry after normal disconnect;
        // only whole Host generation/Close invalidates this actual-return tail.
        const current = () => generation === this.generation && !this.closing && !!this.desc;
        let finished = false, returned = false, invoking = true, result: number = DPN.OK;
        const finish = (hr: number) => {
            if (finished) return; finished = true; result = hr;
            if (!current()) { result = DPN.USERCANCEL; return; }
            if (hr) { this.close(); return; }
            if (this.version >= 0xfffffffe) { result = DPN.TABLEFULL; this.close(); return; }
            try {
                const version = this.version + 1, packet = encodeNativeInfoUpdate({ ...info, data, version, requesting });
                this.version = version;
                // CLIENT updates acknowledge only their original requesting connection.
                const targets = hostRequested ? this.recipients(version) : requester && this.live(requester) && !requester.retirement ? [requester] : [];
                this.publish(this.reserveCommitted(targets.map(connection => ({ connection, data: packet }))));
            } catch { result = DPN.GENERIC; if (current()) this.close(); }
        };
        const done = (hr: number = DPN.OK) => { if (returned) return; returned = true; result = hr; if (!invoking) finish(hr); };
        try {
            if (this.onInfo) this.onInfo(info.id, done, !hostRequested);
            else done();
        } catch { if (!returned || result === DPN.OK) result = DPN.GENERIC; returned = true; }
        invoking = false; if (returned) finish(result);
        return current() ? result : result || DPN.USERCANCEL;
    }
    private validate(info: NativePlayerConnectInfo): number {
        const app = this.options!.application;
        if (!(info.flags & (this.role === "server" ? 2 : 4))) return DPN.INVALIDINTERFACE;
        if (info.version >>> 16) return DPN.INVALIDVERSION;
        if (info.application !== zeroGuid && info.application !== app.application) return DPN.INVALIDAPPLICATION;
        if (info.instance !== zeroGuid && info.instance !== app.instance) return DPN.INVALIDINSTANCE;
        if ((info.password ?? "") !== (app.password ?? "")) return DPN.INVALIDPASSWORD;
        if (app.maxPlayers && this.currentPlayers >= app.maxPlayers) return DPN.SESSIONFULL;
        if (this.version >= 0xffe) return DPN.TABLEFULL;
        return DPN.OK;
    }
    private async admit(c: Connection, info: NativePlayerConnectInfo, bytes: number): Promise<void> {
        const options = this.options!, validation = this.validate(info);
        if (validation) { this.reject(c, validation, new Uint8Array()); return; }
        if (this.decisions.size >= 16 || bytes > 4 * 1024 * 1024 - this.decisionBytes) { this.reject(c, DPN.TABLEFULL, new Uint8Array()); return; }
        this.decisions.add(c); this.decisionBytes += bytes;
        c.reserved = true; this.reservations++;
        let decision: NativeHostDecision;
        try { decision = await options.admit({ address: clone(c.address), info: structuredClone(info), signal: c.controller.signal }); }
        catch { decision = { hr: DPN.HOSTREJECTEDCONNECTION }; }
        let copied = false;
        try {
            if (!this.live(c)) return;
            if ((decision.data?.length ?? 0) > 60000) { this.reject(c, DPN.DATATOOLARGE, new Uint8Array()); return; }
            const reply = decision.data?.slice() ?? new Uint8Array();
            if (decision.hr !== DPN.OK) {
                this.releaseReservation(c);
                // Native packs the rejection reply before RETURN_BUFFER and C5.
                const packet = this.failurePacket(DPN.HOSTREJECTEDCONNECTION, reply);
                copied = true; const returned = options.replyReleased?.(decision); if (returned) await returned;
                if (this.live(c)) this.rejectPacket(c, packet);
                return;
            }
            c.context = decision.context; c.admitted = true;
            const url = this.role === "peer" ? options.url(clone(c.address)) : null;
            if (!this.live(c)) return;
            if (url !== null && (url.length > 4096 || !url.startsWith("x-directplay:/"))) throw Error("Invalid provider player URL");
            const version = this.version + 1, id = this.newId(version);
            const entry: NativeNameTableEntry = { id, owner: 0, flags: this.role === "server" ? 0x200 : 0x100, version, unused: 0, coreVersion: info.version, name: info.name, data: info.data.slice(), url };
            if (this.tableBytes() + this.entryBytes(entry) > 4 * 1024 * 1024) { this.reject(c, DPN.TABLEFULL, new Uint8Array()); return; }
            // Pack a snapshot at this entry's creation version, not at later C3.
            const entries = this.role === "server" ? [this.hostEntry!, entry] :
                [this.hostEntry!, ...this.groups.values(), ...[...this.connections.values()].filter(other => other.entry && other.entry.version <= version &&
                    (other.phase === "table" || other.phase === "connected")).map(other => other.entry!), entry].sort((a, b) => a.version - b.version);
            let packet: Uint8Array;
            try {
                packet = encodeNativeCoreConnectInfo({ reply, application: { ...options.application, players: this.role === "server" ? this.currentPlayers : entries.filter(entry => !(entry.flags & 0x10)).length }, localId: id,
                    version, unused: 0, entries, members: this.role === "server" ? [] : this.memberships.snapshot().filter(pair => pair.version <= version &&
                        entries.some(entry => entry.id === pair.group) && entries.some(entry => entry.id === pair.player)) });
            } catch (error) {
                if (!(error instanceof NativeCoreSnapshotCapacityError)) throw error;
                // This local output quota precedes entry/version/FIFO commitment.
                // Pack the small refusal before returning the application's reply;
                // no committed native operation or arbitrary exception is rolled back.
                const failure = this.failurePacket(DPN.DATATOOLARGE, new Uint8Array());
                this.releaseReservation(c);
                copied = true; const returned = options.replyReleased?.(decision); if (returned) await returned;
                if (this.live(c)) this.rejectPacket(c, failure);
                return;
            }
            const add = encodeNativePlayerAdded(entry);
            const publication = this.reserve([{ connection: c, data: packet }, ...(this.role === "peer" ? this.recipients(version).map(connection => ({ connection, data: add })) : [])]);
            if (typeof publication === "number") { this.reject(c, publication, new Uint8Array()); return; }
            this.version = version; c.id = id; c.entry = entry; c.phase = "table"; c.membership = publication; c.callbackActive = true;
            // C2 owns copied reply bytes before the application gets RETURN_BUFFER.
            this.publish(publication, c);
            if (!this.live(c)) return;
            copied = true; const returned = options.replyReleased?.(decision); if (returned) await returned;
            if (!this.live(c)) return;
            this.publish(publication); c.membership = undefined;
            if (!this.live(c)) return;
            c.replyReleased = true; this.leaveCallback(c);
            if (this.live(c)) this.promote(c);
        } catch { if (this.live(c)) this.close(); }
        finally {
            // Host-only ownership cleanup, including a decision arriving after Close.
            if (!c.creating) c.callbackActive = false;
            try { decision.release?.(); } catch { /* Ownership was returned once. */ }
            if (this.decisions.delete(c)) this.decisionBytes -= bytes;
            if (!copied && this.live(c)) c.replyReleased = true;
        }
    }
    private promote(c: Connection): void {
        if (!this.live(c) || c.retirement || c.phase !== "table" || !c.c3 || !c.replyReleased) return;
        if (this.role === "server") { this.promoteServer(c); return; }
        if (this.version >= 0xfffffffe) { this.close(); return; }
        const version = this.version + 1, packet = nativeCoreWords(0xc6, c.id!, version, 0);
        const publication = this.reserve(this.recipients(version).map(connection => ({ connection, data: packet })));
        if (typeof publication === "number") { this.retire(c, publication); return; }
        this.version = version; c.promotion = publication; c.callbackActive = true; c.phase = "connected"; clearTimeout(c.timer); c.timer = undefined;
        this.releaseReservation(c); const entity = this.entity(c.entry!, c.address);
        const tracked = this.memberships.track(entity); if (tracked) { this.close(); return; }
        this.entities.set(c.id!, entity);
        try {
            this.options!.accepted?.(c.id!, c.context);
            if (!this.live(c)) return;
            if (!this.notifyChange()) { this.retire(c, DPN.GENERIC); return; }
            if (!this.live(c)) return;
            this.publish(publication);
        } catch { if (this.live(c)) this.retire(c, DPN.GENERIC); }
        finally { c.promotion = undefined; this.leaveCallback(c); }
    }
    private promoteServer(c: Connection): void {
        c.callbackActive = true; c.creating = true; c.phase = "connected"; clearTimeout(c.timer); c.timer = undefined;
        this.releaseReservation(c);
        const entity = this.entity(c.entry!, c.address), tracked = this.memberships.track(entity, false);
        if (tracked) { this.close(); return; }
        this.entities.set(c.id!, entity);
        let returned = false, invoking = true, result: number = DPN.OK;
        const finish = (hr: number) => {
            if (!this.live(c) || this.entities.get(c.id!) !== entity) return;
            c.creating = false;
            if (hr) { this.close(); return; }
            this.memberships.created(c.id!);
            this.leaveCallback(c);
            if (!this.live(c) || c.retirement || c.phase !== "connected") return;
            try { this.flushHeldReceives(c); } catch { if (this.live(c)) this.close(); }
        };
        const done = (hr: number = DPN.OK) => { if (returned) return; returned = true; result = hr; if (!invoking) finish(hr); };
        try {
            this.options!.accepted?.(c.id!, c.context);
            if (!this.live(c)) return;
            if (this.onPlayerCreated) this.onPlayerCreated(c.id!, done);
            else done(this.notifyChange() ? DPN.OK : DPN.GENERIC);
        } catch { if (!returned || result === DPN.OK) result = DPN.GENERIC; returned = true; }
        invoking = false; if (returned) finish(result);
    }
    private failurePacket(result: number, reply: Uint8Array): Uint8Array {
        const packet = new Uint8Array(16 + reply.length); packet.set(nativeCoreWords(0xc5, result, reply.length ? 12 : 0, reply.length)); packet.set(reply, 16); return packet;
    }
    private reject(c: Connection, result: number, reply: Uint8Array): void {
        this.releaseReservation(c); this.rejectPacket(c, this.failurePacket(result, reply));
    }
    private rejectPacket(c: Connection, packet: Uint8Array): void {
        if (!this.live(c)) return;
        c.phase = "closing";
        void c.channel!.link.sendReliable(packet).then(async result => {
            if (!this.live(c)) return;
            if (!result) await c.channel!.link.shutdown();
            if (this.live(c)) this.retire(c, result);
        });
    }
    private entity(entry: NativeNameTableEntry, address: Address): Entity {
        return { id: entry.id, group: false, owner: key(address), flags: 0, name: { short: entry.name ?? "", shortNull: entry.name === null, long: "", longNull: true },
            data: Array.from(entry.data), members: [], parent: 0, groupOwner: 0 };
    }
    private notifyChange(): boolean { try { this.onChange?.(); return true; } catch { return false; } }
    private releaseReservation(c: Connection): void { if (c.reserved) { c.reserved = false; this.reservations--; } }
    private leaveCallback(c: Connection): void {
        c.callbackActive = false;
        const retirement = c.retirement;
        if (retirement && this.live(c)) {
            c.retirement = undefined;
            this.retire(c, retirement.result, retirement.reason);
        }
    }
    private retire(c: Connection, result: number, reason?: 1 | 2 | 4): void {
        if (this.connections.get(key(c.address)) !== c) return;
        if (c.destroyChannel && !this.closing) reason = 4;
        if (c.callbackActive && !this.closing) {
            // NT5 waits for active connection callbacks before disconnect cleanup.
            // Keep the committed entry and held FIFO slots until RETURN_BUFFER or
            // the synchronous publication observer returns. Whole Close bypasses
            // the wait and cancels the old generation without publishing it.
            c.retirement ??= { result, reason };
            clearTimeout(c.timer); c.timer = undefined; c.controller.abort();
            return;
        }
        const generation = this.generation;
        let targets: { connection: Connection; data: Uint8Array }[] | undefined, departure: Publication | undefined;
        if (c.entry && !this.closing) {
            // A local callback/queue failure is not a measured carrier-loss cause.
            if (reason === undefined || this.version >= 0xfffffffe) { this.close(); return; }
            if (this.role === "peer") {
                const version = this.version + 1, packet = nativeCoreWords(0xd1, c.id!, version, 0, reason);
                targets = this.recipients(version, c).map(connection => ({ connection, data: packet }));
                this.version = version;
            }
        }
        this.dropHeldReceives(c);
        this.connections.delete(key(c.address)); clearTimeout(c.timer); c.phase = "closing"; c.membership = undefined; c.promotion = undefined;
        this.releaseReservation(c);
        try {
            const removed = !!c.id && this.entities.delete(c.id);
            // Deletion/version are committed before each child attempts admission.
            // Hold accepted FIFO slots before external observers can reenter Host.
            if (targets) departure = this.reserveCommitted(targets);
            c.controller.abort();
            if (generation !== this.generation) return;
            if (removed) {
                // NT5 DeletePlayer implicitly removes owned AUTO groups. Only the
                // owner D1 advances the table version; no additional D8 is sent.
                for (const [id, group] of this.groups) if ((group.flags & 0x40) && group.owner === c.id) {
                    this.groups.delete(id); this.entities.delete(id); this.memberships.retireGroup(id);
                }
                this.memberships.retirePlayer(c.id!);
                for (const entity of this.entities.values()) entity.members = entity.members.filter(id => id !== c.id);
                if (!this.closing) this.onPlayerDestroyReason?.(c.id!, reason ?? 1);
                if (generation === this.generation) this.notifyChange();
            }
            else if (c.admitted) this.options?.aborted?.(c.context);
        } catch { /* Observer failure cannot retain a connection. */ }
        finally {
            // Server DeletePlayer reserves CURRENT version after cleanup/notification.
            // No sibling D1 is generated. General held DESTROY_PLAYER refs are a separate lifetime contract.
            if (this.role === "server" && c.entry && generation === this.generation && !this.closing) {
                if (this.version >= 0xfffffffe) this.close(); else this.version++;
            }
            const channel = c.channel;
            if (channel && channel === c.destroyChannel && generation === this.generation && !this.closing) {
                // The admitted DF owns this channel independently of the retired player.
            } else if (generation === this.generation && channel?.link.state === "closed" && result === DPN.OK) {
                this.draining.add(channel);
                void channel.closed.then(() => { if (generation === this.generation) this.draining.delete(channel); });
            } else channel?.close(result); // An old channel retires locally, outside a replacement owner.
            if (departure) this.publish(departure);
        }
    }
    private enqueueConnection(c: Connection, payload: Uint8Array, flags: number, processed?: () => void): boolean {
        if (this.role === "server" && c.id !== undefined && (c.phase === "table" || c.creating || c.releasingReceives)) {
            if (this.queue.length + this.heldReceiveCount >= 4096 || payload.length > 4 * 1024 * 1024 - this.queueBytes - this.heldReceiveBytes)
                return false;
            c.heldReceives.push({ from: c.id, to: this.localId, data: payload.slice(), flags, processed });
            this.heldReceiveCount++; this.heldReceiveBytes += payload.length; return true;
        }
        return c.phase !== "connected" || this.enqueue(c.id!, payload, flags, processed);
    }
    private dropHeldReceives(c: Connection): void {
        this.heldReceiveCount -= c.heldReceives.length;
        for (const message of c.heldReceives) this.heldReceiveBytes -= message.data.length;
        c.heldReceives = []; c.releasingReceives = false;
    }
    private flushHeldReceives(c: Connection): void {
        if (c.releasingReceives) return;
        c.releasingReceives = true;
        try {
            while (c.heldReceives.length && this.live(c) && !c.retirement && !c.creating) {
                const message = c.heldReceives.shift()!;
                this.heldReceiveCount--; this.heldReceiveBytes -= message.data.length;
                this.queue.push(message); this.queueBytes += message.data.length; this.onMessage?.(c.id!);
            }
        } finally { c.releasingReceives = false; }
    }
    private enqueue(id: number, payload: Uint8Array, flags: number, processed?: () => void): boolean {
        if (this.queue.length + this.heldReceiveCount >= 4096 || payload.length > 4 * 1024 * 1024 - this.queueBytes - this.heldReceiveBytes) return false;
        this.queue.push({ from: id, to: this.localId, data: payload.slice(), flags, processed }); this.queueBytes += payload.length; this.onMessage?.(id); return true;
    }
    deliverLocal(data: Uint8Array, flags: number, processed?: () => void): boolean { return !!this.desc && !this.closing && this.enqueue(this.localId, data, flags, processed); }
    removeMessage(index: number): void { const [m] = this.queue.splice(index, 1); if (m) this.queueBytes -= m.data.length; }
    playerAddress(id: number): Address | null {
        if (id === this.localId && this.desc) return this.localAddress;
        const c = [...this.connections.values()].find(c => c.id === id && c.phase === "connected"); return c ? clone(c.address) : null;
    }
    /** Queue DF fanout before the caller enters its local termination callback. */
    beginNativeTermination(data: Uint8Array, detach: () => () => void): number | { current(): boolean; returned(): number; cancel(): void } {
        if (this.closing) return DPN.ALREADYCLOSING;
        if (!this.desc) return DPN.NOCONNECTION;
        if (this.role !== "peer") return DPN.UNSUPPORTED;
        let packet: Uint8Array;
        try { packet = new Uint8Array(12 + data.length); packet.set(nativeCoreWords(0xdf, data.length ? 8 : 0, data.length)); packet.set(data, 12); }
        catch { return DPN.OUTOFMEMORY; }
        const owner = { generation: this.generation, cancelled: false, queued: false, channels: new Set<NativeDirectPlayChannel>(), jobs: [] as { channel: NativeDirectPlayChannel; result: Promise<number> }[] };
        this.terminationOwners.add(owner);
        const current = () => this.terminationOwners.has(owner) && owner.generation === this.generation && !owner.cancelled && !this.closing && !!this.desc;
        queueMicrotask(() => {
            if (!current()) return;
            // The worker selects its live targets when it runs, independently for each send.
            for (const c of [...this.connections.values()]) {
                if (!current()) break;
                if (!c.entry || c.retirement || !c.channel || c.channel.link.state !== "connected") continue;
                const channel = c.channel, reservation = channel.link.reserveReliable(packet);
                if (typeof reservation === "number") continue;
                owner.channels.add(channel);
                owner.jobs.push({ channel, result: reservation.result });
                reservation.start();
            }
        });
        return {
            current,
            returned: () => {
                if (!current() || owner.queued) return DPN.USERCANCEL;
                owner.queued = true;
                queueMicrotask(() => {
                    if (!current()) return;
                    const port = this.port;
                    let release: () => void;
                    try { release = detach(); } catch { return; }
                    const drain: TerminationDrain = { channels: owner.channels, port, release };
                    this.terminationDrains.add(drain);
                    port?.stopListening(this.incoming);
                    this.port = undefined;
                    for (const c of this.connections.values()) if (c.channel && drain.channels.has(c.channel)) c.channel = undefined;
                    for (const channel of drain.channels) this.draining.delete(channel);
                    this.closeInternal(drain);
                    void Promise.all(owner.jobs.map(async ({ channel, result }) => {
                        try {
                            const hr = await result;
                            if (hr) channel.close(hr);
                            else if (channel.link.state === "connected") await channel.link.shutdown();
                            await channel.closed;
                        } catch { channel.close(DPN.GENERIC); }
                    })).then(() => this.finishTerminationDrain(drain), () => this.finishTerminationDrain(drain));
                });
                return DPN.OK;
            },
            cancel: () => { owner.cancelled = true; this.terminationOwners.delete(owner); },
        };
    }
    private finishTerminationDrain(drain: TerminationDrain): void {
        if (!this.terminationDrains.delete(drain)) return;
        for (const channel of drain.channels) channel.close();
        drain.port?.close();
        try { drain.release(); } catch { /* Provider release cannot retain the owned port. */ }
    }
    /** Admit the reliable terminate message before deleting the targeted player. */
    kick(id: number, data: Uint8Array): number {
        if (this.closing) return DPN.ALREADYCLOSING;
        if (!this.desc) return DPN.NOCONNECTION;
        if (!id || id === this.localId || this.entities.get(id)?.group) return DPN.INVALIDPLAYER;
        const c = [...this.connections.values()].find(item => item.id === id && !!item.entry);
        if (!c) return DPN.INVALIDPLAYER;
        if (c.retirement || c.destroyChannel) return DPN.CONNECTIONLOST;
        const channel = c.channel;
        if (!channel || channel.link.state !== "connected") return DPN.CONNECTIONLOST;
        let packet: Uint8Array;
        try {
            packet = new Uint8Array(12 + data.length);
            packet.set(nativeCoreWords(0xdf, data.length ? 8 : 0, data.length));
            packet.set(data, 12);
        } catch { return DPN.OUTOFMEMORY; }
        const reservation = channel.link.reserveReliable(packet);
        if (typeof reservation === "number") return reservation;
        const generation = this.generation;
        c.destroyChannel = channel;
        this.draining.add(channel);
        void channel.closed.then(() => { this.draining.delete(channel); });
        void reservation.result.then(result => {
            if (generation !== this.generation || this.closing || c.destroyChannel !== channel) return;
            if (result) channel.close(result);
            else if (channel.link.state === "connected") void channel.link.shutdown();
        });
        // DNSendMessage precedes DNHostDisconnect. Starting can synchronously
        // reenter the carrier, close the original channel, or replace the Host.
        reservation.start();
        if (generation === this.generation && !this.closing && c.destroyChannel === channel && this.live(c))
            this.retire(c, DPN.OK, 4);
        return DPN.OK;
    }
    async sendDpn(to: number, flags: number, data: Uint8Array, completionHandle?: number): Promise<number> {
        if (this.closing) return DPN.ALREADYCLOSING;
        if (!this.desc) return DPN.NOCONNECTION;
        const c = [...this.connections.values()].find(c => c.id === to && c.phase === "connected");
        if (!c?.channel) return DPN.INVALIDPLAYER;
        if (c.retirement || c.destroyChannel) return DPN.CONNECTIONLOST;
        if (!data.length || data.length > 1024 * 1024) return DPN.INVALIDPARAM;
        if (flags & ~0x1c) return DPN.UNSUPPORTED;
        if (flags & 4) {
            if (!(flags & 8)) return DPN.INVALIDFLAGS;
            if (!Number.isInteger(completionHandle) || completionHandle! < 1 || completionHandle! > 0xffffffff) return DPN.INVALIDPARAM;
            // NT5 DN_MSG_INTERNAL_REQ_PROCESS_COMPLETION: DWORD handle, then user bytes.
            const packet = new Uint8Array(8 + data.length);
            packet.set(nativeCoreWords(0xe0, completionHandle!)); packet.set(data, 8);
            return c.channel.link.sendReliable(packet);
        }
        return flags & 8 ? c.channel.link.sendReliable(data, 0, !(flags & 0x10)) : c.channel.link.sendUnreliable(data, 0, !(flags & 0x10));
    }
    async shutdown(): Promise<number> {
        this.closing = true; this.port?.stopListening(this.incoming);
        const connected: Connection[] = [];
        for (const c of [...this.connections.values()]) {
            if (c.phase === "connected" && c.channel?.link.state === "connected") connected.push(c);
            else this.retire(c, DPN.USERCANCEL);
        }
        const results = await Promise.all([
            ...connected.map(async c => { const result = await c.channel!.link.shutdown(); return result || await c.channel!.closed; }),
            ...[...this.draining].map(channel => channel.closed),
        ]);
        this.close(); return results.find(r => r !== DPN.OK) ?? DPN.OK;
    }
    close(): number { return this.closeInternal(); }
    private closeInternal(preserve?: TerminationDrain): number {
        if (this.clearing) return DPN.OK;
        this.clearing = true; this.closing = true; ++this.generation;
        for (const owner of this.terminationOwners) owner.cancelled = true;
        this.terminationOwners.clear();
        for (const drain of this.terminationDrains) if (drain !== preserve) this.finishTerminationDrain(drain);
        try {
            this.removeState?.(); this.removeState = undefined;
            this.memberships.clear(DPN.USERCANCEL);
            for (const c of [...this.connections.values()]) this.retire(c, DPN.USERCANCEL);
            for (const channel of this.draining) channel.close(DPN.USERCANCEL); this.draining.clear();
            for (const publication of this.publications) this.cancel(publication); this.publications.clear();
            for (const finish of [...this.groupCreations]) finish(DPN.USERCANCEL);
            for (const finish of [...this.groupDestructions.values()]) finish(DPN.USERCANCEL);
            for (const finish of [...this.memberOperations]) finish(DPN.USERCANCEL);
            this.groups.clear();
            this.port?.close(); this.port = undefined; this.hostEntry = undefined; this.desc = null;
            this.entities.clear(); this.queue.length = 0; this.queueBytes = 0; this.heldReceiveCount = 0; this.heldReceiveBytes = 0; this.reservations = 0; return this.notifyChange() ? DPN.OK : DPN.GENERIC;
        } finally { this.clearing = false; }
    }
    dispose(): void { this.close(); this.disposed = true; }
}
