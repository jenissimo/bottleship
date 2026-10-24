import { WsaSocketTable, WsaFailure, WsaUdpReceiveFailure, WSA, type WsaAddress, type WsaNativeIoLease, type WsaIoPurpose } from "./wsa-network";
import type { LanNetwork } from "../net/lan-network";
import { TCP_SEGMENT } from "../net/netplay-wire";
import { WSA_ACTOR_MAILBOX_BYTES, WSA_ACTOR_HEADER_BYTES, WSA_ACTOR_PENDING, WSA_ACTOR_DONE, WSA_ACTOR_ERROR, WSA_ACTOR_CANCELLED, WSA_ACTOR_EXECUTING,
    actorRequestFits, decodeActorValue, copyActorUdpReceiveError, type WsaActorClientBoot, type WsaActorNotification, type WsaActorRoute } from "./wsa-actor-protocol";
type State = ReturnType<WsaSocketTable["get"]>;
export interface WsaActorTable extends WsaSocketTable { duplicate(socket: number, targetPid: number): number; importDuplicate(reservedHandle: number): number; }
const commands = new Set(["socket","isValid","isConnected","maxMessageSize","bind","closesocket","listen","acceptError","accept","adoptAccepted","disconnect","deferAccepted","rejectAccepted","connect","cancelConnect","send","sendto","receive","recv","recvfrom","shutdown","setHandleFlags","setOobInline","setKeepAlive","setNoDelay","setUdpConnReset","setV6Only","getMulticastOption","setMulticastOption","changeMulticastMembership","setNonBlocking","readable","writable","exceptional","atMark","bytesAvailable","enumEvents"]);
/** Each command is an immediate kernel operation; blocking guest calls wait on readiness after this returns. */
export function createWsaActorTable(network: LanNetwork, initialBoot: WsaActorClientBoot | (()=>WsaActorClientBoot)): WsaActorTable {
    const local = new WsaSocketTable(network), listeners = new Set<() => void>(), notifications = new Map<number, (bit:number,error:number)=>void>();
    let generation = 0, nativeGeneration = 0, closed = false;
    let boot = typeof initialBoot === "function" ? initialBoot() : initialBoot;
    const changed = () => { for (const callback of [...listeners]) callback(); };
    const attach = (current:WsaActorClientBoot) => {
        current.port.onmessage = ({ data }: MessageEvent<WsaActorNotification>) => {
            if(boot!==current)return;
            if (data?.type === "changed") changed();
            else if (data?.type === "event") notifications.get(data.socket)?.(data.bit, data.error);
        };
        current.port.addEventListener("close", () => { if(boot===current){closed = true; generation++; nativeGeneration++; changed();} }); current.port.start();
    };
    attach(boot);
    const renew = () => {
        if(typeof initialBoot!=="function")return;
        const next=initialBoot();
        if(next.port===boot.port&&next.pid===boot.pid&&next.slot===boot.slot&&next.epoch===boot.epoch)return;
        boot=next;closed=false;generation++;nativeGeneration++;notifications.clear();attach(next);changed();
    };
    const mailbox = new SharedArrayBuffer(WSA_ACTOR_MAILBOX_BYTES), header = new Int32Array(mailbox, 0, WSA_ACTOR_HEADER_BYTES / 4);
    const routesFor = (address?:WsaAddress):WsaActorRoute[] => {
        if(!address || (address.family!==2&&address.family!==23))return[];
        try{
            const ip=address.family===23?address.ip6:address.ip;
            if(!ip || (address.family===2&&ip[0]===127))return[];
            const node=address.family===23?network.routeIpv6(ip,address.scopeId??0):network.routeIpv4(ip);
            return node[0]===2&&(node[1]===1||node[1]===2)?[{family:address.family,address:ip.slice(),node,scopeId:address.scopeId??0}]:[];
        }catch{return[];} // Preserve the kernel operation\u2019s validation/error precedence for unknown destinations.
    };
    const call = (command: string, args: unknown[], routes:WsaActorRoute[]=[], nativeHandleOnly = false, expectedBoot?: WsaActorClientBoot): any => {
        renew();
        if (expectedBoot && expectedBoot !== boot) throw new WsaFailure(WSA.ENETDOWN);
        if (closed) throw new WsaFailure(WSA.ENETDOWN);
        if (!actorRequestFits(args)) throw new WsaFailure(WSA.EMSGSIZE);
        Atomics.store(header, 1, 0); Atomics.store(header, 0, WSA_ACTOR_PENDING);
        try { boot.port.postMessage({ type: "request", command, args, routes, mailbox, ...(nativeHandleOnly ? { nativeHandleOnly: true } : {}) }); }
        catch { closed = true; throw new WsaFailure(WSA.ENETDOWN); }
        const deadline = performance.now() + 5000;
        for (;;) {
            const state = Atomics.load(header, 0);
            if (state === WSA_ACTOR_DONE || state === WSA_ACTOR_ERROR) {
                const length = Atomics.load(header, 1);
                if (length < 0 || length > mailbox.byteLength - WSA_ACTOR_HEADER_BYTES) { closed = true; throw new WsaFailure(WSA.ENETDOWN); }
                const text = new TextDecoder().decode(new Uint8Array(mailbox, WSA_ACTOR_HEADER_BYTES, length).slice());
                // Error metadata must be checked as plain JSON, before the general byte-array reviver can clamp values.
                const result = state === WSA_ACTOR_ERROR ? JSON.parse(text) : decodeActorValue(text);
                if (state === WSA_ACTOR_ERROR) {
                    if (result && Object.prototype.hasOwnProperty.call(result, "udpReceive")) {
                        const from = copyActorUdpReceiveError(result.udpReceive);
                        if (result.error !== WSA.ECONNRESET || !from) { closed = true; throw new WsaFailure(WSA.ENETDOWN); }
                        throw new WsaUdpReceiveFailure({
                            family: from.family, port: from.port, node: Uint8Array.from(from.node),
                            ...(from.family === 2 ? { ip: Uint8Array.from(from.address) } :
                                { ip6: Uint8Array.from(from.address), scopeId: from.scopeId ?? 0, flowInfo: from.flowInfo ?? 0 }),
                        });
                    }
                    throw new WsaFailure(result.error);
                }
                return result;
            }
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
                // Never retry an uncertain mutation. Pending commands can be cancelled before execution.
                Atomics.compareExchange(header, 0, WSA_ACTOR_PENDING, WSA_ACTOR_CANCELLED);
                closed = true; throw new WsaFailure(WSA.ETIMEDOUT);
            }
            if (state !== WSA_ACTOR_PENDING && state !== WSA_ACTOR_EXECUTING) { closed = true; throw new WsaFailure(WSA.ENETDOWN); }
            Atomics.wait(header, 0, state, remaining);
        }
    };
    const properties = new Map<number, State>(), nativeProperties = new Map<number, State>();
    const get = (socket: number, nativeHandleOnly = false): State => {
        call("get", [socket], [], nativeHandleOnly);
        const views = nativeHandleOnly ? nativeProperties : properties;
        let proxy = views.get(socket);
        if (!proxy) {
            proxy = new Proxy({} as State, {
                get(_target, name) { if (name === "id") return socket; return call("get", [socket], [], nativeHandleOnly)[name as keyof State]; },
                set(_target, name, value) { call("set", [socket, { [name]: value }], [], nativeHandleOnly); return true; },
            }); views.set(socket, proxy);
        }
        return proxy;
    };
    const leaseTokens = new WeakMap<WsaSocketTable, { token: number; socket: number; boot: WsaActorClientBoot; purpose: WsaIoPurpose }>();
    const acquireNativeIo = (socket: number, purpose: WsaIoPurpose = "data"): WsaNativeIoLease => {
        const token = call("acquireNativeIo", [socket, purpose], [], true), issuingBoot = boot;
        let released = false;
        const invoke = (operation: string, args: unknown[]) => {
            if (released || args[0] !== socket) throw new WsaFailure(WSA.ENOTSOCK);
            return call("nativeIo", [token, operation, args], operation === "connect" ? routesFor(args[1] as WsaAddress | undefined) : operation === "send" ? routesFor(args[2] as WsaAddress | undefined) : [], true, issuingBoot);
        };
        const state = new Proxy({} as State, {
            get(_target, name) { return invoke("get", [socket])[name as keyof State]; },
            set(_target, name, value) { invoke("set", [socket, { [name]: value }]); return true; },
        });
        const table = new Proxy(local, {
            get(_target, name) {
                if (name === "nativeHandleView") return table;
                if (name === "generation") { try { renew(); } catch { return -1; } return boot === issuingBoot ? nativeGeneration : -1; }
                if (name === "subscribe") return overrides.subscribe;
                if (name === "withBlockingSignal" || name === "blockingSignal" || name === "blockingErrorSink") {
                    const value = Reflect.get(local, name, local); return typeof value === "function" ? value.bind(local) : value;
                }
                if (name === "get") return (handle: number) => { invoke("get", [handle]); return state; };
                if (name === "fileObjectId") return (handle: number) => invoke("fileObjectId", [handle]);
                if (name === "acceptInto") return (listener: number, destination: WsaSocketTable, target: number) => {
                    const metadata = leaseTokens.get(destination);
                    if (!metadata || metadata.boot !== issuingBoot || metadata.purpose !== "acceptTarget" || metadata.socket !== target) throw new WsaFailure(WSA.EINVAL);
                    return invoke("acceptInto", [listener, metadata.token, target]);
                };
                if (name === "isValid") return (handle: number) => { try { return !!invoke("isValid", [handle]); } catch { return false; } };
                if (["send", "receive", "readable", "writable", "connect", "cancelConnect", "disconnect"].includes(name as string)) return (...args: unknown[]) => {
                    if (name === "send" && args[1] instanceof Uint8Array) {
                        const payload = args[1], stream = invoke("get", [socket]).type === 1;
                        if (!stream && payload.length > 65535) throw new WsaFailure(WSA.EMSGSIZE);
                        const limit = stream ? TCP_SEGMENT : 65535;
                        if (payload.length > limit) args[3] = ((args[3] as number) || 0) & ~1;
                        args[1] = payload.slice(0, limit);
                    }
                    if (name === "receive") args[1] = Math.min(args[1] as number, 65535);
                    return invoke(name as string, args);
                };
                throw new WsaFailure(WSA.EINVAL);
            },
        }) as WsaSocketTable;
        leaseTokens.set(table, { token, socket, boot: issuingBoot, purpose });
        return { table, release() {
            if (released) return;
            released = true;
            if (closed || boot !== issuingBoot) return;
            try { call("releaseNativeIo", [token], [], true, issuingBoot); } catch { /* Process revocation already frees its tokens. */ }
        } };
    };
    const overrides: Record<string, unknown> = {
        acquireNativeIo,
        fileObjectId(socket: number) { return call("fileObjectId", [socket], [], true); },
        hasFileObject(objectId: number) { try { return !!call("hasFileObject", [objectId], [], true); } catch { return false; } },
        get, subscribe(callback:()=>void) { listeners.add(callback); return () => listeners.delete(callback); },
        reset() { try { if (!closed) call("reset", []); } catch { closed = true; /* A retired guest has already released its references. */ } finally { generation++; notifications.clear(); properties.clear(); nativeProperties.clear(); changed(); } },
        configureEvents(socket:number, mask:number, notify?:(bit:number,error:number)=>void) {
            if (notify) notifications.set(socket, notify); else notifications.delete(socket);
            call("configureEvents", [socket, mask]);
        },
        duplicate(socket:number,targetPid:number) { return call("duplicate",[socket,targetPid]); },
        importDuplicate(reservedHandle:number) { return call("import",[reservedHandle]); },
    };
    let nativeView: WsaSocketTable;
    const view = (nativeHandleOnly: boolean): WsaActorTable => new Proxy(local, {
        get(target, name) {
            if (name === "nativeHandleView") return nativeView;
            if (name === "nativeIoGeneration") { try { renew(); } catch { return -1; } return nativeGeneration; }
            if (name === "get") return (socket: number) => get(socket, nativeHandleOnly);
            if (name === "generation") return nativeHandleOnly ? nativeGeneration : generation;
            if (typeof name === "string" && Object.hasOwn(overrides, name)) return overrides[name];
            if (typeof name === "string" && commands.has(name)) return (...args:unknown[]) => {
                let destination = name==="connect" ? args[1] as WsaAddress|undefined : undefined;
                if ((name === "send" || name === "sendto") && args[1] instanceof Uint8Array) {
                    const payload = args[1], stream = call("get", [args[0]], [], nativeHandleOnly).type === 1;
                    if(!stream)destination=args[2] as WsaAddress|undefined;
                    if (!stream && payload.length > 65535) throw new WsaFailure(WSA.EMSGSIZE);
                    const limit = stream ? TCP_SEGMENT : 65535;
                    // A clipped OOB send contains only ordinary prefix bytes; the urgent byte is still at the original tail.
                    if (payload.length > limit && name === "send") args[3] = ((args[3] as number) || 0) & ~1;
                    args[1] = payload.slice(0, limit);
                }
                if (name === "receive") args[1] = Math.min(args[1] as number, 65535);
                const result = call(name,args,routesFor(destination),nativeHandleOnly);
                if (name === "closesocket") {
                    let retained = false;
                    try { retained = !!call("isValid", [args[0]], [], true); } catch { /* A revoked process already retired its aliases. */ }
                    if (!retained) { notifications.delete(args[0] as number); properties.delete(args[0] as number); nativeProperties.delete(args[0] as number); }
                    changed();
                }
                return result;
            };
            const value = Reflect.get(target, name, target); return typeof value === "function" ? value.bind(target) : value;
        },
    }) as WsaActorTable;
    nativeView = view(true);
    return view(false);
}
