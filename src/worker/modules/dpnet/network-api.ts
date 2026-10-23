import type { Process } from "../../core/process";
import type { VTableInfo } from "../../api/adapters/module-adapter";
import type { ThunkImplementation, ThunkResult, X86Context } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { System } from "../../core/system";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { ComObjectFactory } from "../../core/com/base-com-object";
import { allocateComObject } from "../../core/com/com-memory";
import { dpnetModule } from "../../api/dpnet.api";
import { lanNetwork, type LanNetwork, nodeToIpv4 } from "../../net/lan-network";
import { DirectPlaySendQueue } from "../dplayx/send-queue";
import type { SessionDesc, Discovery, Address } from "../dplayx/session";
import { DirectPlay8Session, dp8Result, type DirectPlay8Role } from "./peer";
import { DirectPlay8Callbacks } from "./callbacks";
import { lanDirectPlay8HostProvider } from "./lan-host-provider";
import { DirectPlaySendOperationPool, type DirectPlaySendOperation } from "./send-operations";
import { NativeDirectPlayDiscovery, type NativeDiscoveryOperation } from "./native-wire/discovery";
import { isExternalIpv4Node } from "../../net/netplay-wire";
import { DirectPlayAddressApi } from "./address-api";
import { DirectPlayAddress } from "./address";
import { DirectPlayGuestMemory } from "./guest-memory";
import { packApplication, readApplication, readInfo, packInfo, StructBuffer } from "./structures";
import { LobbyPeerRegistration } from "../dpnlobby/peer-bridge";
import type { Lobby8Settings } from "../dpnlobby/structures";
import { DPN, DP8_TCPIP, DP8_IPX, DP8_PEER, DP8_CLIENT, DP8_SERVER, guidBytes, guidString, utf16 } from "./constants";

interface Operation { kind: "connect" | "enum" | "other"; context: number; done: boolean; cancel?(): void; }
interface SendRecord { handle: number; flags: number; context: number; bytes: number; accounted: boolean;
    localOperation?: DirectPlaySendOperation; descriptors: { pointer: number; size: number }[]; }
interface PeerState {
    session: DirectPlay8Session; callbacks?: DirectPlay8Callbacks; nativeDiscovery?: NativeDirectPlayDiscovery; generation: number; nextHandle: number;
    operations: Map<number, Operation>; closing: boolean; pendingConnect: boolean; connectGeneration: number; sends: DirectPlaySendQueue; sendRecords: Map<number, SendRecord>;
    lobby?: LobbyPeerRegistration; lobbyEvents: WeakSet<object>; lobbyDevice?: DirectPlayAddress;
    caps: number[]; spcaps: Map<string, number[]>; stats: Map<number, number[]>;
}
const roleNames: Record<string, DirectPlay8Role> = { IDirectPlay8Peer: "peer", IDirectPlay8Client: "client", IDirectPlay8Server: "server" };
const SYNC = 0x80000000;
export class DirectPlay8NetworkApi {
    private states = new Map<number, PeerState>();
    private lobbyRegistrations = new Set<LobbyPeerRegistration>();
    private guest: DirectPlayGuestMemory;
    private sendOperations: DirectPlaySendOperationPool;
    constructor(readonly process: Process, readonly tables: () => Record<string, VTableInfo>,
        readonly addresses: DirectPlayAddressApi, readonly network: LanNetwork = lanNetwork) { this.guest = new DirectPlayGuestMemory(process); this.sendOperations = DirectPlaySendOperationPool.forProcess(process); }
    reset(): void { for (const registration of this.lobbyRegistrations) registration.release(); this.lobbyRegistrations.clear(); for (const s of this.states.values()) { s.generation++; s.lobby?.release(); s.lobby = undefined; s.sends.reset(); this.clearSendRecords(s); s.nativeDiscovery?.close(); s.session.dispose(); s.callbacks?.close(); } this.states.clear(); }
    private clearSendRecords(state: PeerState): void { for (const record of state.sendRecords.values()) record.localOperation?.release(); state.sendRecords.clear(); }
    private state(ptr: number, role: DirectPlay8Role): PeerState | null {
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(ptr);
        if (!obj || ![DP8_PEER, DP8_CLIENT, DP8_SERVER].includes(obj.iid)) return null;
        let state = this.states.get(obj.handle);
        if (!state) {
            state = { session: new DirectPlay8Session(this.network, role), generation: 0, nextHandle: 1,
                operations: new Map(), closing: false, pendingConnect: false, connectGeneration: 0, lobbyEvents: new WeakSet(), sends: null!, sendRecords: new Map(), caps: [20, 0, 200, 14, 25000], spcaps: new Map(), stats: new Map() };
            const owner = state;
            state.sends = new DirectPlaySendQueue((job, data, settled) => {
                const record = owner.sendRecords.get(job.context);
                return owner.session.send(job.to, record?.flags ?? 0, data, job.signal, metadata => record?.localOperation?.delivered(metadata), settled);
            }, completion => {
                const record = owner.sendRecords.get(completion.context); if (!record) return true;
                const result = completion.hr === 0x8877019a ? DPN.USERCANCEL : dp8Result(completion.hr);
                const stats = this.stats(owner, completion.to);
                if (!record.accounted) {
                    record.accounted = true;
                    if (!result) { const guaranteed = !!(record.flags & 8); stats[guaranteed ? 4 : 6] += record.bytes; stats[guaranteed ? 5 : 7]++; stats[record.flags & 0x80 ? 12 : record.flags & 0x40 ? 16 : 14]++; }
                }
                if (record.flags & 2) { record.localOperation?.release(); owner.sendRecords.delete(completion.context); return true; }
                const descriptors = record.flags & 1 ? record.descriptors : [];
                const metadata = record.localOperation?.metadata();
                const release = () => record.localOperation?.release();
                const accepted = owner.callbacks?.native(0x14, 40 + descriptors.length * 8, ptr => {
                    Mem.writeUint32(ptr, 40);
                    [record.handle, record.context, result, completion.sendTime, metadata?.firstFrameRtt ?? 0, metadata?.firstFrameRetries ?? 0, metadata?.flags ?? (record.flags & 8 ? 1 : 0), descriptors.length ? ptr + 40 : 0, descriptors.length].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n));
                    descriptors.forEach((d, i) => { Mem.writeUint32(ptr + 40 + i * 8, d.size); Mem.writeUint32(ptr + 44 + i * 8, d.pointer); });
                }, () => { release(); }, release, record) ?? false;
                if (accepted) owner.sendRecords.delete(completion.context);
                return accepted;
            });
            state.session.onEvent = event => {
                if (owner.lobby && !owner.closing && (event.type === 0xd || event.type === 0x16) && !owner.lobbyEvents.has(event)) {
                    if (!owner.lobby.tryPublish(event.type === 0x16 ? 3 : event.id === owner.session.localId ? 6 : 5)) return false;
                    owner.lobbyEvents.add(event);
                }
                if (!owner.callbacks?.emit(event)) return false;
                if (event.type === 0x11) {
                    const stats = this.stats(owner, event.id ?? 0), guaranteed = !!event.flags;
                    stats[guaranteed ? 18 : 20] += event.data?.length ?? 0; stats[guaranteed ? 19 : 21]++; stats[22]++;
                }
                return true;
            };
            this.states.set(obj.handle, state);
        }
        return state;
    }
    private lobbySettings(state: PeerState): Lobby8Settings | undefined {
        const desc = state.session.engine.desc; if (!desc) return undefined;
        const address = (value: DirectPlayAddress) => structuredClone({ components: value.components, userData: value.userData });
        const device = state.lobbyDevice?.clone() ?? new DirectPlayAddress();
        const local = state.session.engine.advertisedAddress ?? state.session.engine.localAddress;
        device.setText("hostname", Array.from(nodeToIpv4(Uint8Array.from(local.node))).join(".")); device.setDword("port", local.port);
        if (!device.guid("provider")) device.setGuid("provider", DP8_TCPIP);
        const remote = state.session.engine.hostAddress;
        return { flags: state.session.engine.isHost ? 1 : 0, desc: structuredClone(desc), players: state.session.engine.currentPlayers,
            host: state.session.engine.isHost || !remote ? null : address(this.endpoint(remote)), devices: [address(device)],
            player: state.session.localInfo.name || null };
    }
    private retireLobby(registration: LobbyPeerRegistration | undefined): number | Promise<ThunkResult> {
        if (!registration) return DPN.OK;
        if (!registration.pending) { registration.release(); this.lobbyRegistrations.delete(registration); return DPN.OK; }
        return registration.flush().then<ThunkResult>(() => ({ value: DPN.OK, resumeOnOwner: () => { registration.release(); this.lobbyRegistrations.delete(registration); return DPN.OK; } }));
    }
    private stats(s: PeerState, id: number): number[] { let values = s.stats.get(id); if (!values) { values = Array<number>(23).fill(0); values[0] = 92; s.stats.set(id, values); } return values; }
    private handle(s: PeerState): number { return s.nextHandle++ >>> 0 || s.nextHandle++ >>> 0; }
    private output(out: number, sizePtr: number, pack: (base: number) => Uint8Array): number {
        if (!this.guest.valid(sizePtr, 4, "rw")) return DPN.INVALIDPOINTER;
        const capacity = Mem.readUint32(sizePtr)!, bytes = pack(out);
        Mem.writeUint32(sizePtr, bytes.length);
        if (!out || capacity < bytes.length) return DPN.BUFFERTOOSMALL;
        if (!this.guest.valid(out, bytes.length, "rw")) return DPN.INVALIDPOINTER;
        Mem.writeBytes(out, bytes); return DPN.OK;
    }
    private operation(s: PeerState, context: number, handlePtr: number, flags: number, kind: Operation["kind"],
        action: () => number | Promise<number>, cancel?: () => void, complete?: (handle: number, hr: number) => void): number | Promise<ThunkResult> {
        if (flags & SYNC) {
            if (context || handlePtr) return DPN.INVALIDPARAM;
            return Promise.resolve(action()).then<ThunkResult>(value => ({ value }));
        }
        if (handlePtr && !this.guest.valid(handlePtr, 4, "rw")) return DPN.INVALIDPOINTER;
        const handle = this.handle(s), op: Operation = { kind, context, done: false, cancel };
        s.operations.set(handle, op); if (handlePtr) Mem.writeUint32(handlePtr, handle);
        const generation = s.generation;
        void Promise.resolve().then(() => op.done || generation !== s.generation ? DPN.USERCANCEL : action()).then(hr => {
            if (op.done || generation !== s.generation) return;
            op.done = true; s.operations.delete(handle);
            if (complete) complete(handle, hr);
            else s.callbacks?.native(3, 16, ptr => { [handle, context, hr].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n)); });
        }, () => {
            if (op.done || generation !== s.generation) return;
            op.done = true; s.operations.delete(handle);
            if (complete) complete(handle, DPN.GENERIC);
            else s.callbacks?.native(3, 16, ptr => { [handle, context, DPN.GENERIC].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n)); });
        });
        return DPN.PENDING;
    }
    private endpoint(address: Address): DirectPlayAddress {
        const result = new DirectPlayAddress();
        result.buildHost(Array.from(nodeToIpv4(new Uint8Array(address.node))).join("."), address.port); return result;
    }
    private async resolveHost(host: DirectPlayAddress): Promise<Uint8Array | null> {
        const name = host.text("hostname"); if (!name) return null;
        let ip = name.toLowerCase() === "localhost" ? "127.0.0.1" : name;
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
            try { ip = (await this.network.resolve(ip, 4)).addresses.find(a => a.family === 4)?.address ?? ""; } catch { return null; }
        }
        const octets = ip.split(".").map(Number);
        if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        try { return this.network.routeIpv4(new Uint8Array(octets)); } catch { return null; }
    }
    private async findHosts(s: PeerState, desc: SessionDesc, host: DirectPlayAddress | null, data: Uint8Array): Promise<number> {
        if (host) {
            const name = host.text("hostname");
            if (!name) return DPN.INVALIDHOSTADDRESS;
            let ip = name.toLowerCase() === "localhost" ? "127.0.0.1" : name;
            if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
                try { ip = (await this.network.resolve(ip, 4)).addresses.find(a => a.family === 4)?.address ?? ""; } catch { return DPN.INVALIDHOSTADDRESS; }
            }
            const octets = ip.split(".").map(Number); if (octets.length !== 4 || octets.some(n => n > 255)) return DPN.INVALIDHOSTADDRESS;
            const node = this.network.routeIpv4(new Uint8Array(octets));
            return dp8Result(s.session.virtualProvider.discoverAt(desc.application, { node: Array.from(node), port: host.dword("port") || 47624 }, data));
        }
        return dp8Result(s.session.virtualProvider.discover(desc.application, data));
    }
    install(exports: Record<string, ThunkImplementation>): void {
        const methods: Record<string, (s: PeerState, args: number[], iface: string, ctx: X86Context) => ReturnType<ThunkImplementation>> = {};
        methods.QueryInterface = (_s, a, iface) => {
            if (!this.guest.valid(a[2], 4, "rw") || !this.guest.valid(a[1], 16)) return DPN.INVALIDPOINTER;
            Mem.writeUint32(a[2], 0);
            const iid = guidString(Mem.readBytes(a[1], 16)!), descriptor = dpnetModule.interfaces!.find(i => i.name === iface)!;
            if (iid !== descriptor.iid && iid !== "00000000-0000-0000-c000-000000000046") return DPN.NOINTERFACE;
            const obj = SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!;
            const ptr = SystemResourceProvider.getInstance().getPrimaryAddressForHandle(obj.handle) ?? a[0];
            obj.addRef(); Mem.writeUint32(a[2], ptr); return DPN.OK;
        };
        methods.AddRef = (_s, a) => SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!.addRef();
        methods.Release = (s, a) => {
            const obj = SystemResourceProvider.getInstance().getComObjectByAddress(a[0])!, handle = obj.handle, count = obj.release();
            if (!count) {
                s.generation++; s.sends.reset(); this.clearSendRecords(s); s.nativeDiscovery?.close(); s.session.dispose(); s.callbacks?.close(); this.states.delete(handle);
                const registration = s.lobby; s.lobby = undefined;
                return this.retireLobby(registration);
            }
            return count;
        };
        methods.Initialize = (s, a) => {
            if (s.session.initialized) return DPN.ALREADYINITIALIZED;
            if (a[3] & ~7) return DPN.INVALIDFLAGS;
            if (!this.guest.valid(a[2], 1, "rx")) return DPN.INVALIDPOINTER;
            const hr = s.session.initialize(); if (hr) return hr;
            s.callbacks = new DirectPlay8Callbacks(this.process, s.session, this.addresses, a[2], a[1]);
            s.callbacks.onSpace = () => s.sends.retryCompletions();
            s.session.onIndicate = request => s.callbacks!.indicate(request);
            s.session.onNativeIndicate = request => s.callbacks!.indicateNative(request);
            s.session.virtualProvider.onEnumQuery = request => s.callbacks!.query(request);
            const executor = s.callbacks.queue.executor, generation = s.generation;
            return executor.initialized ? executor.ready().then<ThunkResult, ThunkResult>(() => ({ value: generation === s.generation ? DPN.OK : DPN.USERCANCEL }), () => ({ value: DPN.OUTOFMEMORY,
                resumeOnOwner: () => { if (generation !== s.generation) return DPN.USERCANCEL;
                    s.callbacks?.close(); s.callbacks = undefined; s.session.dispose(); return DPN.OUTOFMEMORY; } })) : DPN.OK;
        };
        methods.EnumServiceProviders = (_s, a) => {
            if (a[6] & ~1) return DPN.INVALIDFLAGS;
            if (!this.guest.valid(a[4], 4, "rw") || !this.guest.valid(a[5], 4, "rw")) return DPN.INVALIDPOINTER;
            if (a[1] && !this.guest.valid(a[1], 16)) return DPN.INVALIDPOINTER;
            if (a[2] && !this.guest.valid(a[2], 16)) return DPN.INVALIDPOINTER;
            const requested = a[1] ? guidString(Mem.readBytes(a[1], 16)!) : null;
            const providers = requested ? requested === DP8_TCPIP || requested === DP8_IPX ? [{ guid: "00000000-0000-0000-0000-000000000000", name: "All Adapters" }] : [] :
                [{ guid: DP8_TCPIP, name: "TCP/IP Service Provider" }, { guid: DP8_IPX, name: "IPX Service Provider" }];
            Mem.writeUint32(a[5], providers.length);
            const nameBytes = providers.map(p => utf16(p.name + "\0"));
            return this.output(a[3], a[4], base => {
                const out = new StructBuffer(providers.length * 32, nameBytes.reduce((n, b) => n + b.length, 0), base);
                providers.forEach((p, i) => { out.bytes.set(guidBytes(p.guid), i * 32 + 4); out.blob(i * 32 + 20, nameBytes[i]); }); return out.bytes;
            });
        };
        methods.Host = (s, a, _iface, ctx) => {
            if (a[7] & ~1) return DPN.INVALIDFLAGS;
            const desc = readApplication(this.guest, a[1]); if (!desc) return DPN.INVALIDPARAM;
            if (desc.extended!.flags & ~0x7c5) return DPN.INVALIDFLAGS;
            if (a[4] || a[5] || desc.extended!.flags & 0x600) return DPN.UNSUPPORTED;
            if (!a[3] || a[3] > 16 || !this.guest.valid(a[2], a[3] * 4)) return DPN.INVALIDPARAM;
            let port = 0;
            for (let i = 0; i < a[3]; i++) {
                const address = this.addresses.address(Mem.readUint32(a[2] + i * 4)!);
                if (!address || ![DP8_TCPIP, DP8_IPX].includes(address.guid("provider") ?? "")) return DPN.INVALIDDEVICEADDRESS;
                if (i) return DPN.INVALIDDEVICEADDRESS;
                port = address.dword("port") ?? 0;
            }
            const provider = lanDirectPlay8HostProvider(this.network);
            if (provider) {
                const device = this.addresses.address(Mem.readUint32(a[2])!)!;
                if (device.guid("provider") !== DP8_TCPIP) return DPN.UNSUPPORTED;
                s.lobbyDevice = device.clone();
                const callbacks = s.callbacks!, resume = callbacks.queue.pause(), issuing = { ...ctx };
                const generation = s.generation, epoch = this.process.resetGeneration, context = a[6];
                const current = () => generation === s.generation && epoch === this.process.resetGeneration && s.callbacks === callbacks && !s.closing;
                return s.session.hostNative(desc, context, provider, port, s.caps).then(async result => {
                    if (current() && !result && s.lobby) await s.lobby.publish(1, this.lobbySettings(s));
                    if (!current()) resume();
                    return { value: DPN.GENERIC, resumeOnOwner: () => {
                        if (!current()) { resume(); return DPN.USERCANCEL; }
                        const value = result || s.session.error;
                        if (value) { resume(); return value; }
                        return { value: DPN.GENERIC, startCallbackChain: frame => {
                            if (!current()) { resume(); return false; }
                            const result = callbacks.queue.run({ ...issuing, esp: frame.esp, returnAddr: frame.returnAddr }, 32, value, resume);
                            return typeof result !== "number" && !!result.suspendedForCallback;
                        } };
                    } } satisfies ThunkResult;
                }).catch(() => { resume(); return { value: DPN.GENERIC, resumeOnOwner: () => current() ? DPN.GENERIC : DPN.USERCANCEL }; });
            }
            const hr = s.session.bindPort(port); if (hr) return hr;
            s.lobbyDevice = this.addresses.address(Mem.readUint32(a[2])!)!.clone();
            const callbacks = s.callbacks!, resume = callbacks.queue.pause();
            const result = s.session.host(desc, a[6]);
            if (result) { resume(); return result; }
            if (s.lobby) {
                const generation = s.generation;
                return s.lobby.publish(1, this.lobbySettings(s)).then<ThunkResult>(() => ({
                    value: generation === s.generation ? result : DPN.USERCANCEL,
                    startCallbackChain: frame => {
                        if (generation !== s.generation) { resume(); return false; }
                        const value = callbacks.queue.run({ ...ctx, esp: frame.esp, returnAddr: frame.returnAddr }, 32, result, resume);
                        return typeof value !== "number" && !!value.suspendedForCallback;
                    },
                }));
            }
            return callbacks.queue.run(ctx, 32, result, resume);
        };
        methods.Connect = (s, a) => {
            if (s.pendingConnect || [...s.operations.values()].some(op => op.kind === "connect")) return DPN.CONNECTING;
            if (a[11] & ~(SYNC | 1)) return DPN.INVALIDFLAGS;
            const desc = readApplication(this.guest, a[1]); if (!desc) return DPN.INVALIDPARAM;
            const host = this.addresses.address(a[2]), device = a[3] ? this.addresses.address(a[3]) : null;
            if (!host || ![DP8_TCPIP, DP8_IPX].includes(host.guid("provider") ?? "")) return DPN.INVALIDHOSTADDRESS;
            if (a[3] && !device) return DPN.INVALIDDEVICEADDRESS;
            if (a[4] || a[5] || desc.extended!.flags & 0x600) return DPN.UNSUPPORTED;
            if (a[7] > 60000 || (a[7] && !this.guest.valid(a[6], a[7]))) return DPN.INVALIDPARAM;
            const data = a[7] ? Mem.readBytes(a[6], a[7])!.slice() : new Uint8Array(), address = host.clone(), generation = s.generation;
            const localDevice = device?.clone(), ticket = ++s.connectGeneration;
            const current = () => generation === s.generation && ticket === s.connectGeneration;
            const connect = async (): Promise<number> => {
                s.pendingConnect = true;
                try {
                const node = await this.resolveHost(address);
                if (!current()) return DPN.USERCANCEL;
                if (!node) return DPN.INVALIDHOSTADDRESS;
                if (isExternalIpv4Node(node) && address.guid("provider") === DP8_TCPIP)
                    return await s.session.connectNative({ node: Array.from(node), port: address.dword("port") || 6073 }, desc, a[8], data, localDevice?.dword("port") ?? 0, s.caps);
                let found = desc.instance !== "0".repeat(32) ? s.session.virtualProvider.discovered.get(desc.instance) : undefined;
                if (!found) {
                    const hr = await this.findHosts(s, desc, address, new Uint8Array()); if (!current()) return DPN.USERCANCEL; if (hr) return hr;
                    await new Promise(resolve => setTimeout(resolve, 300));
                    if (!current()) return DPN.USERCANCEL;
                    found = [...s.session.virtualProvider.discovered.values()].find(item => item.desc.application === desc.application &&
                        (desc.instance === "0".repeat(32) || item.desc.instance === desc.instance) && (item.address.port === (address.dword("port") || item.address.port)));
                }
                if (!found) return DPN.NORESPONSE;
                return await s.session.connect({ ...found.desc, password: desc.password }, a[8], data);
                } finally { if (ticket === s.connectGeneration) s.pendingConnect = false; }
            };
            return this.operation(s, a[9], a[10], a[11], "connect", async () => {
                if (!current()) return DPN.USERCANCEL;
                s.lobbyDevice = localDevice;
                const hr = await connect();
                if (s.lobby && generation === s.generation) await s.lobby.publish(hr ? 2 : 1, hr ? undefined : this.lobbySettings(s));
                return generation === s.generation ? hr : DPN.USERCANCEL;
            }, () => { ++s.connectGeneration; s.pendingConnect = false; s.session.cancelConnect(); }, (handle, hr) => {
                const reply = s.session.engine.joinReply?.data ?? new Uint8Array();
                s.callbacks?.native(5, 28 + reply.length, ptr => {
                    Mem.writeUint32(ptr, 28);
                    [handle, a[9], hr, reply.length ? ptr + 28 : 0, reply.length, hr ? 0 : s.session.localId].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n));
                    Mem.writeBytes(ptr + 28, reply);
                });
            });
        };
        methods.GetApplicationDesc = (s, a) => a[3] ? DPN.INVALIDFLAGS : s.session.error || this.output(a[1], a[2], base => packApplication(s.session.engine.desc!, s.session.engine.currentPlayers, base));
        methods.SetApplicationDesc = (s, a) => {
            if (a[2]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error; if (!s.session.engine.isHost) return DPN.NOTHOST;
            const desc = readApplication(this.guest, a[1]); if (!desc) return DPN.INVALIDPARAM;
            const current = s.session.engine.desc!; desc.instance = current.instance;
            const reply = s.session.engine.mutate({ op: "mutate", action: "session", desc });
            return reply instanceof Promise ? reply.then<number>(v => dp8Result(v.hr)) : dp8Result(reply.hr);
        };
        methods.SetInfo = (s, a) => {
            if (a[4] & ~SYNC) return DPN.INVALIDFLAGS;
            const info = readInfo(this.guest, a[1]); if (!info || info.info.flags) return DPN.INVALIDPARAM;
            return this.operation(s, a[2], a[3], a[4], "other", () => s.session.setInfo(s.session.localId, info.info, info.mask));
        };
        methods.GetInfo = (s, a) => {
            if (a[4]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            const entity = s.session.engine.entities.get(a[1]); if (!entity || entity.group) return DPN.INVALIDPLAYER;
            return this.output(a[2], a[3], base => packInfo(entity, s.session.playerFlags(entity.id), base));
        };
        methods.GetAddress = (s, a) => {
            if (a[3]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            const address = s.session.address(a[1]); if (!address) return DPN.INVALIDPLAYER;
            const ptr = this.addresses.create(this.endpoint(address)); Mem.writeUint32(a[2], ptr); return ptr ? DPN.OK : DPN.OUTOFMEMORY;
        };
        methods.GetLocalHostAddresses = (s, a) => {
            if (a[3] & ~1) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            const count = Mem.readUint32(a[2])!; Mem.writeUint32(a[2], 1);
            if (!count || !a[1]) return DPN.BUFFERTOOSMALL; if (!this.guest.valid(a[1], 4, "rw")) return DPN.INVALIDPOINTER;
            const ptr = this.addresses.create(this.endpoint(s.session.engine.advertisedAddress ?? s.session.engine.localAddress)); Mem.writeUint32(a[1], ptr); return ptr ? DPN.OK : DPN.OUTOFMEMORY;
        };
        methods.CreateGroup = (s, a) => {
            if (a[5] & ~SYNC) return DPN.INVALIDFLAGS;
            const info = readInfo(this.guest, a[1]); if (!info || info.info.flags & ~1) return DPN.INVALIDPARAM;
            return this.operation(s, a[3], a[4], a[5], "other", async () => (await s.session.createGroup(info.info, a[2])).hr);
        };
        methods.DestroyGroup = (s, a) => a[4] & ~SYNC ? DPN.INVALIDFLAGS : this.operation(s, a[2], a[3], a[4], "other", () => s.session.destroyGroup(a[1]));
        methods.AddPlayerToGroup = (s, a) => a[5] & ~SYNC ? DPN.INVALIDFLAGS : this.operation(s, a[3], a[4], a[5], "other", () => s.session.member(a[1], a[2], true));
        methods.RemovePlayerFromGroup = (s, a) => a[5] & ~SYNC ? DPN.INVALIDFLAGS : this.operation(s, a[3], a[4], a[5], "other", () => s.session.member(a[1], a[2], false));
        methods.SetGroupInfo = (s, a) => {
            if (a[5] & ~SYNC) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (!s.session.engine.entities.get(a[1])?.group) return DPN.INVALIDGROUP;
            const info = readInfo(this.guest, a[2]); if (!info || info.info.flags) return DPN.INVALIDPARAM;
            return this.operation(s, a[3], a[4], a[5], "other", () => s.session.setInfo(a[1], info.info, info.mask));
        };
        methods.GetGroupInfo = (s, a) => {
            if (a[4]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            const entity = s.session.engine.entities.get(a[1]); if (!entity?.group) return DPN.INVALIDGROUP;
            return this.output(a[2], a[3], base => packInfo(entity, entity.flags, base));
        };
        const enumerate = (a: number[], list: number[], out: number, count: number): number => {
            if (!this.guest.valid(count, 4, "rw")) return DPN.INVALIDPOINTER;
            const capacity = Mem.readUint32(count)!; Mem.writeUint32(count, list.length);
            if (capacity < list.length) return DPN.BUFFERTOOSMALL;
            if (list.length && !this.guest.valid(out, list.length * 4, "rw")) return DPN.INVALIDPOINTER;
            list.forEach((id, i) => Mem.writeUint32(out + i * 4, id)); return DPN.OK;
        };
        methods.EnumPlayersAndGroups = (s, a) => {
            if (!a[3] || a[3] & ~0x11) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            return enumerate(a, [...s.session.engine.entities.values()].filter(e => a[3] & (e.group ? 0x10 : 1)).map(e => e.id), a[1], a[2]);
        };
        methods.EnumGroupMembers = (s, a) => {
            if (a[4]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            const group = s.session.engine.entities.get(a[1]); if (!group?.group) return DPN.INVALIDGROUP;
            return enumerate(a, group.members, a[2], a[3]);
        };
        methods.GetPlayerContext = (s, a) => {
            if (a[3]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (!s.session.engine.entities.has(a[1]) || s.session.engine.entities.get(a[1])!.group) return DPN.INVALIDPLAYER;
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            Mem.writeUint32(a[2], s.session.contexts.get(a[1]) ?? 0); return DPN.OK;
        };
        methods.GetGroupContext = (s, a) => {
            if (a[3]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (!s.session.engine.entities.get(a[1])?.group) return DPN.INVALIDGROUP;
            if (!this.guest.valid(a[2], 4, "rw")) return DPN.INVALIDPOINTER;
            Mem.writeUint32(a[2], s.session.groupContexts.get(a[1]) ?? 0); return DPN.OK;
        };
        methods.ReturnBuffer = (s, a) => a[2] ? DPN.INVALIDFLAGS : s.callbacks?.returnBuffer(a[1]) ?? DPN.UNINITIALIZED;
        methods.SendTo = (s, a, _iface, ctx) => {
            const flags = a[7];
            if (flags & ~(SYNC | 0x1ff)) return DPN.INVALIDFLAGS;
            if ((flags & 0xc0) === 0xc0 || ((flags & 1) && (flags & 2)) || ((flags & 4) && (!(flags & 8) || (flags & 2))) ||
                ((flags & 8) && !(flags & SYNC) && (flags & 2))) return DPN.INVALIDFLAGS;
            if ((flags & SYNC ? !!a[6] : !a[6]) || ((flags & 0x20) && a[1] === s.session.localId)) return DPN.INVALIDPARAM;
            if (s.session.error) return s.session.error;
            if (!a[3] || a[3] > 1024 || !this.guest.valid(a[2], a[3] * 8)) return DPN.INVALIDPARAM;
            const descriptors = Array.from({ length: a[3] }, (_, i) => ({ size: Mem.readUint32(a[2] + i * 8)!, pointer: Mem.readUint32(a[2] + i * 8 + 4)! }));
            const total = descriptors.reduce((sum, d) => sum + d.size, 0);
            if (!total || total > 60000 || descriptors.some(d => d.size && !this.guest.valid(d.pointer, d.size))) return DPN.INVALIDPARAM;
            const collect = (): Uint8Array | null => {
                const result = new Uint8Array(total);
                let offset = 0;
                for (const d of descriptors) {
                    if (d.size && !this.guest.valid(d.pointer, d.size)) return null;
                    // NOCOPY jobs run outside guest thunks: read this process's view, never the ambient Mem owner.
                    const current = this.process.getCurrentMemory();
                    result.set(current.slice(d.pointer, d.pointer + d.size), offset); offset += d.size;
                }
                return result;
            };
            if (!(flags & SYNC)) { const admissionError = s.sends.admissionError(total); if (admissionError) return dp8Result(admissionError); }
            const local = a[1] === s.session.localId;
            const copy = flags & 1 && !local ? undefined : collect(); if (copy === null) return DPN.INVALIDPARAM;
            if (flags & SYNC) {
                const callbacks = s.callbacks, inline = !!(flags & 4) && a[1] === s.session.localId && callbacks;
                const resume = inline ? callbacks.queue.pause() : undefined;
                const processing = s.session.pendingLocalProcessing, generation = s.generation;
                const result = s.session.send(a[1], flags, copy ?? collect()!);
                if (inline && s.session.pendingLocalProcessing > processing) return callbacks.queue.run(ctx, 32, () => generation === s.generation ? DPN.OK : DPN.USERCANCEL, resume);
                resume?.(); return Promise.resolve(result).then<number>(hr => hr);
            }
            if (a[6] && !this.guest.valid(a[6], 4, "rw")) return DPN.INVALIDPOINTER;
            const localOperation = local ? this.sendOperations.begin(!!(flags & 4)) : undefined;
            if (local && !localOperation) return DPN.OUTOFMEMORY;
            const handle = this.handle(s), generation = s.generation;
            const record: SendRecord = { handle, flags, descriptors, context: a[5], bytes: total, accounted: false, localOperation: localOperation ?? undefined };
            const callbacks = s.callbacks, inline = local && !(flags & 4) && callbacks?.queue.executor.count === 0;
            const resume = local ? callbacks?.queue.pause() : undefined;
            s.sendRecords.set(handle, record);
            const admitted = s.sends.enqueue({ from: s.session.localId, to: a[1], flags: 0, priority: flags & 0x80 ? 2 : flags & 0x40 ? 0 : 1,
                timeout: a[4], context: handle, cancelActive: !!(flags & 4), eager: local, processing: local && !!(flags & 4), data: () => copy ?? collect() }, total);
            if (admitted.hr) { s.sendRecords.delete(handle); record.localOperation?.rollback(); resume?.(); return dp8Result(admitted.hr); }
            if (a[6]) Mem.writeUint32(a[6], handle);
            if (inline) return callbacks.queue.runSelected(ctx, 32, task => task.key === record,
                () => generation === s.generation ? DPN.PENDING : DPN.USERCANCEL, resume);
            resume?.(); return DPN.PENDING;
        };
        methods.GetSendQueueInfo = (s, a) => {
            if (a[4] & ~7) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (a[1] === s.session.localId || (a[1] && !s.session.engine.entities.has(a[1]))) return DPN.INVALIDPLAYER;
            if ((a[2] && !this.guest.valid(a[2], 4, "rw")) || (a[3] && !this.guest.valid(a[3], 4, "rw"))) return DPN.INVALIDPOINTER;
            const jobs = s.sends.pending.filter(j => (!a[1] || j.to === a[1]) && (!a[4] || (a[4] & (j.priority === 2 ? 2 : j.priority === 0 ? 4 : 1))));
            if (a[2]) Mem.writeUint32(a[2], jobs.length); if (a[3]) Mem.writeUint32(a[3], jobs.reduce((n, j) => n + j.bytes, 0)); return DPN.OK;
        };
        methods.CancelAsyncOperation = (s, a) => {
            const flags = a[2];
            if (flags & ~(0x8000 | 7)) return DPN.INVALIDFLAGS;
            if (a[1] && flags) return DPN.INVALIDPARAM;
            let found = false;
            for (const [handle, op] of [...s.operations]) if ((!a[1] || handle === a[1]) && (!flags || flags & 0x8000 || (op.kind === "connect" ? flags & 1 : op.kind === "enum" ? flags & 2 : false))) {
                found = true; op.done = true; op.cancel?.(); s.operations.delete(handle);
                if (op.kind === "connect") s.callbacks?.native(5, 28, ptr => { [handle, op.context, DPN.USERCANCEL].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n)); });
                else s.callbacks?.native(3, 16, ptr => { [handle, op.context, DPN.USERCANCEL].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n)); });
            }
            if (!a[1] && (!flags || flags & (4 | 0x8000))) { found ||= s.sends.pending.length > 0; s.sends.cancel(0); }
            else for (const job of s.sends.pending) {
                const record = s.sendRecords.get(job.context);
                if (record?.handle === a[1]) { found = true; return s.sends.cancel(job.id) ? DPN.CANNOTCANCEL : DPN.OK; }
            }
            return found || !a[1] ? DPN.OK : DPN.INVALIDHANDLE;
        };
        methods.DestroyPeer = (s, a) => {
            if (a[4]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error; if (!s.session.engine.isHost) return DPN.NOTHOST;
            if (a[3] > 60000 || (a[3] && !this.guest.valid(a[2], a[3]))) return DPN.INVALIDPARAM;
            return dp8Result(s.session.engine.kick(a[1], a[3] ? Mem.readBytes(a[2], a[3])! : new Uint8Array()));
        };
        methods.TerminateSession = (s, a) => {
            if (a[3]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error; if (!s.session.engine.isHost) return DPN.NOTHOST;
            if (a[2] > 60000 || (a[2] && !this.guest.valid(a[1], a[2]))) return DPN.INVALIDPARAM;
            return dp8Result(s.session.engine.terminate(a[2] ? Mem.readBytes(a[1], a[2])! : new Uint8Array(), DPN.HOSTTERMINATEDSESSION));
        };
        methods.GetCaps = (s, a) => {
            if (a[2]) return DPN.INVALIDFLAGS;
            if (!this.guest.valid(a[1], 4, "rw")) return DPN.INVALIDPOINTER;
            const size = Mem.readUint32(a[1])!; if (size !== 20 && size !== 48) return DPN.INVALIDPARAM;
            if (!this.guest.valid(a[1], size, "rw")) return DPN.INVALIDPOINTER;
            const values = size === 20 ? s.caps.slice(0, 5) : [48, ...s.caps.slice(1, 5), ...(s.caps.length === 12 ? s.caps.slice(5) : [0xffffffff, 10, 5000, 7, 25, 3, 500])];
            values.forEach((n, i) => Mem.writeUint32(a[1] + i * 4, n)); return DPN.OK;
        };
        methods.SetCaps = (s, a) => {
            if (a[2]) return DPN.INVALIDFLAGS; if (!this.guest.valid(a[1], 20)) return DPN.INVALIDPOINTER;
            const size = Mem.readUint32(a[1])!; if (size !== 20 && size !== 48) return DPN.INVALIDPARAM;
            if (!this.guest.valid(a[1], size)) return DPN.INVALIDPOINTER;
            if (Mem.readUint32(a[1] + 4)) return DPN.INVALIDFLAGS;
            s.caps = Array.from({ length: size / 4 }, (_, i) => Mem.readUint32(a[1] + i * 4)!); s.caps[0] = 20; return DPN.OK;
        };
        for (const method of ["GetSPCaps", "SetSPCaps"]) methods[method] = (s, a) => {
            if (a[3]) return DPN.INVALIDFLAGS;
            if (!this.guest.valid(a[1], 16) || !this.guest.valid(a[2], 36, method === "GetSPCaps" ? "rw" : "r")) return DPN.INVALIDPOINTER;
            if (Mem.readUint32(a[2]) !== 36) return DPN.INVALIDPARAM;
            const guid = guidString(Mem.readBytes(a[1], 16)!); if (![DP8_TCPIP, DP8_IPX].includes(guid)) return DPN.DOESNOTEXIST;
            if (method === "GetSPCaps") (s.spcaps.get(guid) ?? [36, 15, 1, 5, 1500, 1500, 983, 1, 65536]).forEach((n, i) => Mem.writeUint32(a[2] + i * 4, n));
            else s.spcaps.set(guid, Array.from({ length: 9 }, (_, i) => Mem.readUint32(a[2] + i * 4)!));
            return DPN.OK;
        };
        methods.GetConnectionInfo = (s, a) => {
            if (a[3]) return DPN.INVALIDFLAGS; if (s.session.error) return s.session.error;
            if (!s.session.engine.entities.has(a[1]) || s.session.engine.entities.get(a[1])!.group) return DPN.INVALIDPLAYER;
            if (!this.guest.valid(a[2], 92, "rw")) return DPN.INVALIDPOINTER; if (Mem.readUint32(a[2]) !== 92) return DPN.INVALIDPARAM;
            this.stats(s, a[1]).forEach((n, i) => Mem.writeUint32(a[2] + i * 4, n)); return DPN.OK;
        };
        methods.RegisterLobby = (s, a) => {
            if (a[2] && !this.guest.valid(a[2], 4)) return DPN.INVALIDPOINTER;
            if (a[3] === 3) return DPN.INVALIDPARAM;
            if (a[3] !== 1 && a[3] !== 2) return DPN.INVALIDFLAGS;
            if (a[3] === 1) {
                if (!a[1]) return DPN.INVALIDHANDLE;
                if (!a[2]) return DPN.INVALIDPOINTER;
            } else if (a[1] || a[2]) return DPN.INVALIDPARAM;
            if (!s.session.initialized) return DPN.UNINITIALIZED;
            if (a[3] === 1) {
                if (s.lobby) return DPN.ALREADYREGISTERED;
                const registration = LobbyPeerRegistration.create(this.process, a[2], a[1]);
                if (!registration) return DPN.INVALIDPOINTER;
                this.lobbyRegistrations.add(registration);
                s.lobby = registration; return DPN.OK;
            }
            if (!s.lobby) return DPN.NOTREGISTERED;
            const registration = s.lobby; s.lobby = undefined;
            return this.retireLobby(registration);
        };
        methods.Close = (s, a, _iface, ctx) => {
            if (a[1] & ~1) return DPN.INVALIDFLAGS;
            if (s.callbacks?.queue.threadId === System.getInstance().scheduler.getCurrentThreadId()) return DPN.NOTALLOWED;
            s.closing = true;
            const callbacks = s.callbacks, registration = s.lobby;
            const manual = callbacks && !callbacks.queue.executor.count, resume = manual ? callbacks.queue.pause() : undefined;
            const lobbyUpdate = registration && s.session.engine.desc ? registration.publish(3) : Promise.resolve();
            s.lobby = undefined;
            const generation = ++s.generation, processGeneration = this.process.resetGeneration;
            const live = () => generation === s.generation && processGeneration === this.process.resetGeneration;
            callbacks?.beginClose(); s.sends.seal(); s.nativeDiscovery?.close(); s.nativeDiscovery = undefined; s.operations.clear();
            const nativeClose = s.session.engine.kind === "native" ? s.session.beginClose().then(hr => { if (!live()) return DPN.USERCANCEL; s.session.close(); return hr; }) : undefined;
            if (!nativeClose) s.session.close();
            if (manual) {
                const finish = () => {
                    registration?.release(); if (registration) this.lobbyRegistrations.delete(registration);
                    if (!live()) { resume?.(); return; }
                    s.sends.reset(); this.clearSendRecords(s); callbacks.close(); resume?.();
                    if (s.callbacks === callbacks) { s.callbacks = undefined; s.session.dispose(); s.closing = false; }
                };
                if (!registration && !nativeClose) return callbacks.queue.run(ctx, 8, () => live() ? DPN.OK : DPN.USERCANCEL, finish);
                return Promise.resolve(nativeClose).then(() => lobbyUpdate).then(() => registration?.flush()).then<ThunkResult>(() => ({
                    value: live() ? DPN.OK : DPN.USERCANCEL,
                    startCallbackChain: frame => {
                        if (!live()) { resume?.(); return false; }
                        const value = callbacks.queue.run({ ...ctx, esp: frame.esp, returnAddr: frame.returnAddr }, 8, () => live() ? DPN.OK : DPN.USERCANCEL, finish);
                        return typeof value !== "number" && !!value.suspendedForCallback;
                    },
                }));
            }
            return Promise.resolve(nativeClose).then(() => live() ? s.sends.flushCompletions() : undefined).then(() => live() ? s.session.flush() : undefined).then(() => live() ? callbacks?.flush() : undefined).then(() => lobbyUpdate).then(() => registration?.flush()).then<ThunkResult>(() => ({ value: live() ? DPN.OK : DPN.USERCANCEL, startCallbackChain: () => { registration?.release(); if (registration) this.lobbyRegistrations.delete(registration); if (!live()) return false; s.sends.reset(); this.clearSendRecords(s); callbacks?.close(); if (s.callbacks === callbacks) { s.callbacks = undefined; s.session.dispose(); s.closing = false; } return false; } }));
        };
        methods.EnumHosts = (s, a) => {
            if (a[11] & ~(SYNC | 3)) return DPN.INVALIDFLAGS;
            const desc = readApplication(this.guest, a[1]); if (!desc) return DPN.INVALIDPARAM;
            const host = a[2] ? this.addresses.address(a[2]) : null, device = a[3] ? this.addresses.address(a[3]) : null;
            if (a[2] && !host) return DPN.INVALIDHOSTADDRESS; if (a[3] && !device) return DPN.INVALIDDEVICEADDRESS;
            if (a[5] > 1024 || (a[5] && !this.guest.valid(a[4], a[5]))) return DPN.INVALIDPARAM;
            const query = a[5] ? Mem.readBytes(a[4], a[5])!.slice() : new Uint8Array(), address = host?.clone() ?? null;
            let cancelled = false, active = true, native: NativeDiscoveryOperation | undefined;
            const generation = s.generation, application = desc.application === "0".repeat(32) ? null : desc.application;
            const old = s.session.virtualProvider.onDiscovery;
            const receive = (item: Discovery, latency = 0, localPort = s.session.engine.localAddress.port): boolean => {
                if (!active || generation !== s.generation || (application !== null && item.desc.application !== application)) return true;
                if (desc.instance !== "0".repeat(32) && item.desc.instance !== desc.instance) return true;
                const app = packApplication(item.desc, item.currentPlayers), response = item.data ?? new Uint8Array();
                let sender = 0, local = 0;
                const releaseAddresses = () => { for (const pointer of [sender, local]) if (pointer) SystemResourceProvider.getInstance().getComObjectByAddress(pointer)?.release(); sender = local = 0; };
                return s.callbacks?.native(0xb, 32 + app.length + response.length, ptr => {
                    sender = this.addresses.create(this.endpoint(item.address)); local = this.addresses.create(this.endpoint({ node: Array.from(this.network.node), port: localPort }));
                    Mem.writeUint32(ptr, 32); Mem.writeUint32(ptr + 4, sender); Mem.writeUint32(ptr + 8, local); Mem.writeUint32(ptr + 12, ptr + 32);
                    Mem.writeBytes(ptr + 32, packApplication(item.desc, item.currentPlayers, ptr + 32));
                    Mem.writeUint32(ptr + 16, response.length ? ptr + 32 + app.length : 0); Mem.writeUint32(ptr + 20, response.length); Mem.writeUint32(ptr + 24, a[9]); Mem.writeUint32(ptr + 28, Math.min(0xffffffff, Math.round(latency)));
                    Mem.writeBytes(ptr + 32 + app.length, response);
                }, releaseAddresses, releaseAddresses) ?? false;
            };
            const forward = (item: Discovery) => { old?.(item); receive(item); };
            const action = async () => {
                if (cancelled || generation !== s.generation) return DPN.USERCANCEL;
                if (address && address.guid("provider") === DP8_TCPIP) {
                    const node = await this.resolveHost(address);
                    if (cancelled || generation !== s.generation) return DPN.USERCANCEL;
                    if (!node) return DPN.INVALIDHOSTADDRESS;
                    if (isExternalIpv4Node(node)) {
                        try { s.nativeDiscovery ??= new NativeDirectPlayDiscovery(this.network); } catch { return DPN.OUTOFMEMORY; }
                        const provider = s.nativeDiscovery;
                        native = provider.discover({ node, port: address.dword("port") || 6073, application, data: query,
                            count: a[6], interval: a[7], timeout: a[8], onResponse: (reply, from, latency) => receive({
                                desc: { instance: reply.instance, application: reply.application, flags: (reply.flags & 1 ? 0x1000 : 0) | (reply.flags & 4) | (reply.flags & 0x100 ? 0x200 : 0),
                                    maxPlayers: reply.maxPlayers, name: reply.name ?? "", password: "", user: [0, 0, 0, 0],
                                    extended: { flags: reply.flags, reserved: Array.from(reply.reserved), application: Array.from(reply.applicationData) } },
                                currentPlayers: reply.players, address: { node: Array.from(from.node), port: from.port }, seen: Date.now(), data: reply.data,
                            }, latency, provider.port) });
                        try { return await native.done; } finally { active = false; }
                    }
                }
                s.session.virtualProvider.onDiscovery = forward;
                const count = a[6] || 5, interval = a[7] || 1500, timeout = a[8] || 1500;
                let hr: number = DPN.OK;
                try {
                    for (let i = 0; i < count && !cancelled; i++) {
                        hr = await this.findHosts(s, desc, address, query); if (hr) break;
                        await new Promise(resolve => setTimeout(resolve, i + 1 === count ? timeout : interval));
                    }
                    return cancelled ? DPN.USERCANCEL : hr;
                } finally { active = false; if (s.session.virtualProvider.onDiscovery === forward) s.session.virtualProvider.onDiscovery = old; }
            };
            return this.operation(s, a[9], a[10], a[11], "enum", action, () => { cancelled = true; active = false; native?.cancel(); });
        };
        const bind = (iface: string, method: string): ThunkImplementation => (ctx, _mem, args) => {
            const role = roleNames[iface], s = this.state(args[0], role); if (!s) return DPN.INVALIDOBJECT;
            if (s.closing && !["QueryInterface", "AddRef", "Release", "ReturnBuffer"].includes(method)) return DPN.ALREADYCLOSING;
            let a = [...args], target = method;
            if (role === "client") {
                if (method === "Connect") a.splice(8, 0, 0);
                if (["Send", "GetSendQueueInfo", "GetServerInfo", "GetServerAddress", "GetConnectionInfo"].includes(method)) a.splice(1, 0, s.session.hostId);
            }
            if (["SetPeerInfo", "SetClientInfo", "SetServerInfo"].includes(method)) target = "SetInfo";
            if (["GetPeerInfo", "GetClientInfo", "GetServerInfo"].includes(method)) target = "GetInfo";
            if (["GetPeerAddress", "GetClientAddress", "GetServerAddress"].includes(method)) target = "GetAddress";
            if (method === "Send") target = "SendTo";
            if (method === "DestroyClient") target = "DestroyPeer";
            if (!s.session.initialized && !["QueryInterface", "AddRef", "Release", "Initialize", "EnumServiceProviders", "RegisterLobby"].includes(method)) return DPN.UNINITIALIZED;
            return methods[target](s, a, iface, ctx);
        };
        exports["IDirectPlay8Peer_QueryInterface"] = bind("IDirectPlay8Peer", "QueryInterface");
        exports["IDirectPlay8Peer_AddRef"] = bind("IDirectPlay8Peer", "AddRef");
        exports["IDirectPlay8Peer_Release"] = bind("IDirectPlay8Peer", "Release");
        exports["IDirectPlay8Peer_Initialize"] = bind("IDirectPlay8Peer", "Initialize");
        exports["IDirectPlay8Peer_EnumServiceProviders"] = bind("IDirectPlay8Peer", "EnumServiceProviders");
        exports["IDirectPlay8Peer_CancelAsyncOperation"] = bind("IDirectPlay8Peer", "CancelAsyncOperation");
        exports["IDirectPlay8Peer_Connect"] = bind("IDirectPlay8Peer", "Connect");
        exports["IDirectPlay8Peer_SendTo"] = bind("IDirectPlay8Peer", "SendTo");
        exports["IDirectPlay8Peer_GetSendQueueInfo"] = bind("IDirectPlay8Peer", "GetSendQueueInfo");
        exports["IDirectPlay8Peer_Host"] = bind("IDirectPlay8Peer", "Host");
        exports["IDirectPlay8Peer_GetApplicationDesc"] = bind("IDirectPlay8Peer", "GetApplicationDesc");
        exports["IDirectPlay8Peer_SetApplicationDesc"] = bind("IDirectPlay8Peer", "SetApplicationDesc");
        exports["IDirectPlay8Peer_CreateGroup"] = bind("IDirectPlay8Peer", "CreateGroup");
        exports["IDirectPlay8Peer_DestroyGroup"] = bind("IDirectPlay8Peer", "DestroyGroup");
        exports["IDirectPlay8Peer_AddPlayerToGroup"] = bind("IDirectPlay8Peer", "AddPlayerToGroup");
        exports["IDirectPlay8Peer_RemovePlayerFromGroup"] = bind("IDirectPlay8Peer", "RemovePlayerFromGroup");
        exports["IDirectPlay8Peer_SetGroupInfo"] = bind("IDirectPlay8Peer", "SetGroupInfo");
        exports["IDirectPlay8Peer_GetGroupInfo"] = bind("IDirectPlay8Peer", "GetGroupInfo");
        exports["IDirectPlay8Peer_EnumPlayersAndGroups"] = bind("IDirectPlay8Peer", "EnumPlayersAndGroups");
        exports["IDirectPlay8Peer_EnumGroupMembers"] = bind("IDirectPlay8Peer", "EnumGroupMembers");
        exports["IDirectPlay8Peer_SetPeerInfo"] = bind("IDirectPlay8Peer", "SetPeerInfo");
        exports["IDirectPlay8Peer_GetPeerInfo"] = bind("IDirectPlay8Peer", "GetPeerInfo");
        exports["IDirectPlay8Peer_GetPeerAddress"] = bind("IDirectPlay8Peer", "GetPeerAddress");
        exports["IDirectPlay8Peer_GetLocalHostAddresses"] = bind("IDirectPlay8Peer", "GetLocalHostAddresses");
        exports["IDirectPlay8Peer_Close"] = bind("IDirectPlay8Peer", "Close");
        exports["IDirectPlay8Peer_EnumHosts"] = bind("IDirectPlay8Peer", "EnumHosts");
        exports["IDirectPlay8Peer_DestroyPeer"] = bind("IDirectPlay8Peer", "DestroyPeer");
        exports["IDirectPlay8Peer_ReturnBuffer"] = bind("IDirectPlay8Peer", "ReturnBuffer");
        exports["IDirectPlay8Peer_GetPlayerContext"] = bind("IDirectPlay8Peer", "GetPlayerContext");
        exports["IDirectPlay8Peer_GetGroupContext"] = bind("IDirectPlay8Peer", "GetGroupContext");
        exports["IDirectPlay8Peer_GetCaps"] = bind("IDirectPlay8Peer", "GetCaps");
        exports["IDirectPlay8Peer_SetCaps"] = bind("IDirectPlay8Peer", "SetCaps");
        exports["IDirectPlay8Peer_SetSPCaps"] = bind("IDirectPlay8Peer", "SetSPCaps");
        exports["IDirectPlay8Peer_GetSPCaps"] = bind("IDirectPlay8Peer", "GetSPCaps");
        exports["IDirectPlay8Peer_GetConnectionInfo"] = bind("IDirectPlay8Peer", "GetConnectionInfo");
        exports["IDirectPlay8Peer_RegisterLobby"] = bind("IDirectPlay8Peer", "RegisterLobby");
        exports["IDirectPlay8Peer_TerminateSession"] = bind("IDirectPlay8Peer", "TerminateSession");
        exports["IDirectPlay8Client_QueryInterface"] = bind("IDirectPlay8Client", "QueryInterface");
        exports["IDirectPlay8Client_AddRef"] = bind("IDirectPlay8Client", "AddRef");
        exports["IDirectPlay8Client_Release"] = bind("IDirectPlay8Client", "Release");
        exports["IDirectPlay8Client_Initialize"] = bind("IDirectPlay8Client", "Initialize");
        exports["IDirectPlay8Client_EnumServiceProviders"] = bind("IDirectPlay8Client", "EnumServiceProviders");
        exports["IDirectPlay8Client_EnumHosts"] = bind("IDirectPlay8Client", "EnumHosts");
        exports["IDirectPlay8Client_CancelAsyncOperation"] = bind("IDirectPlay8Client", "CancelAsyncOperation");
        exports["IDirectPlay8Client_Connect"] = bind("IDirectPlay8Client", "Connect");
        exports["IDirectPlay8Client_Send"] = bind("IDirectPlay8Client", "Send");
        exports["IDirectPlay8Client_GetSendQueueInfo"] = bind("IDirectPlay8Client", "GetSendQueueInfo");
        exports["IDirectPlay8Client_GetApplicationDesc"] = bind("IDirectPlay8Client", "GetApplicationDesc");
        exports["IDirectPlay8Client_SetClientInfo"] = bind("IDirectPlay8Client", "SetClientInfo");
        exports["IDirectPlay8Client_GetServerInfo"] = bind("IDirectPlay8Client", "GetServerInfo");
        exports["IDirectPlay8Client_GetServerAddress"] = bind("IDirectPlay8Client", "GetServerAddress");
        exports["IDirectPlay8Client_Close"] = bind("IDirectPlay8Client", "Close");
        exports["IDirectPlay8Client_ReturnBuffer"] = bind("IDirectPlay8Client", "ReturnBuffer");
        exports["IDirectPlay8Client_GetCaps"] = bind("IDirectPlay8Client", "GetCaps");
        exports["IDirectPlay8Client_SetCaps"] = bind("IDirectPlay8Client", "SetCaps");
        exports["IDirectPlay8Client_SetSPCaps"] = bind("IDirectPlay8Client", "SetSPCaps");
        exports["IDirectPlay8Client_GetSPCaps"] = bind("IDirectPlay8Client", "GetSPCaps");
        exports["IDirectPlay8Client_GetConnectionInfo"] = bind("IDirectPlay8Client", "GetConnectionInfo");
        exports["IDirectPlay8Client_RegisterLobby"] = bind("IDirectPlay8Client", "RegisterLobby");
        exports["IDirectPlay8Server_QueryInterface"] = bind("IDirectPlay8Server", "QueryInterface");
        exports["IDirectPlay8Server_AddRef"] = bind("IDirectPlay8Server", "AddRef");
        exports["IDirectPlay8Server_Release"] = bind("IDirectPlay8Server", "Release");
        exports["IDirectPlay8Server_Initialize"] = bind("IDirectPlay8Server", "Initialize");
        exports["IDirectPlay8Server_EnumServiceProviders"] = bind("IDirectPlay8Server", "EnumServiceProviders");
        exports["IDirectPlay8Server_CancelAsyncOperation"] = bind("IDirectPlay8Server", "CancelAsyncOperation");
        exports["IDirectPlay8Server_GetSendQueueInfo"] = bind("IDirectPlay8Server", "GetSendQueueInfo");
        exports["IDirectPlay8Server_GetApplicationDesc"] = bind("IDirectPlay8Server", "GetApplicationDesc");
        exports["IDirectPlay8Server_SetServerInfo"] = bind("IDirectPlay8Server", "SetServerInfo");
        exports["IDirectPlay8Server_GetClientInfo"] = bind("IDirectPlay8Server", "GetClientInfo");
        exports["IDirectPlay8Server_GetClientAddress"] = bind("IDirectPlay8Server", "GetClientAddress");
        exports["IDirectPlay8Server_GetLocalHostAddresses"] = bind("IDirectPlay8Server", "GetLocalHostAddresses");
        exports["IDirectPlay8Server_SetApplicationDesc"] = bind("IDirectPlay8Server", "SetApplicationDesc");
        exports["IDirectPlay8Server_Host"] = bind("IDirectPlay8Server", "Host");
        exports["IDirectPlay8Server_SendTo"] = bind("IDirectPlay8Server", "SendTo");
        exports["IDirectPlay8Server_CreateGroup"] = bind("IDirectPlay8Server", "CreateGroup");
        exports["IDirectPlay8Server_DestroyGroup"] = bind("IDirectPlay8Server", "DestroyGroup");
        exports["IDirectPlay8Server_AddPlayerToGroup"] = bind("IDirectPlay8Server", "AddPlayerToGroup");
        exports["IDirectPlay8Server_RemovePlayerFromGroup"] = bind("IDirectPlay8Server", "RemovePlayerFromGroup");
        exports["IDirectPlay8Server_SetGroupInfo"] = bind("IDirectPlay8Server", "SetGroupInfo");
        exports["IDirectPlay8Server_GetGroupInfo"] = bind("IDirectPlay8Server", "GetGroupInfo");
        exports["IDirectPlay8Server_EnumPlayersAndGroups"] = bind("IDirectPlay8Server", "EnumPlayersAndGroups");
        exports["IDirectPlay8Server_EnumGroupMembers"] = bind("IDirectPlay8Server", "EnumGroupMembers");
        exports["IDirectPlay8Server_Close"] = bind("IDirectPlay8Server", "Close");
        exports["IDirectPlay8Server_DestroyClient"] = bind("IDirectPlay8Server", "DestroyClient");
        exports["IDirectPlay8Server_ReturnBuffer"] = bind("IDirectPlay8Server", "ReturnBuffer");
        exports["IDirectPlay8Server_GetPlayerContext"] = bind("IDirectPlay8Server", "GetPlayerContext");
        exports["IDirectPlay8Server_GetGroupContext"] = bind("IDirectPlay8Server", "GetGroupContext");
        exports["IDirectPlay8Server_GetCaps"] = bind("IDirectPlay8Server", "GetCaps");
        exports["IDirectPlay8Server_SetCaps"] = bind("IDirectPlay8Server", "SetCaps");
        exports["IDirectPlay8Server_SetSPCaps"] = bind("IDirectPlay8Server", "SetSPCaps");
        exports["IDirectPlay8Server_GetSPCaps"] = bind("IDirectPlay8Server", "GetSPCaps");
        exports["IDirectPlay8Server_GetConnectionInfo"] = bind("IDirectPlay8Server", "GetConnectionInfo");
        exports["IDirectPlay8Server_RegisterLobby"] = bind("IDirectPlay8Server", "RegisterLobby");
        const create: ThunkImplementation = (_ctx, _mem, args) => {
            if (!this.guest.valid(args[0], 16)) return DPN.INVALIDPOINTER;
            const iid = guidString(Mem.readBytes(args[0], 16)!);
            const iface = dpnetModule.interfaces!.find(i => i.iid === iid && /^IDirectPlay8(Peer|Client|Server|ThreadPool)$/.test(i.name));
            if (!iface) return DPN.INVALIDPARAM;
            if (!this.guest.valid(args[1], 4, "rw")) return DPN.INVALIDPOINTER;
            if (args[2]) return DPN.INVALIDPARAM;
            const table = this.tables()[iface.name].address, object = ComObjectFactory.create(iid, table);
            if (!object) return DPN.OUTOFMEMORY;
            const current = this.process.getCurrentMemory();
            const ptr = allocateComObject(this.process.memory, current, table);
            SystemResourceProvider.getInstance().mapAddressToHandle(ptr, object.handle); Mem.writeUint32(args[1], ptr); return DPN.OK;
        };
        exports["directplay8create"] = create; exports["ord_1"] = create;
    }
}
