/** Winsock ABI adapters. Async completions publish guest outputs at dispatcher safe points. */
import type { Process } from "../core/process";
import { wsaProtocols, protocolInfoSize, protocolInfo } from "./wsa-catalog";
import type { WsaActorTable } from "./wsa-actor-table";
import { getWsaOverlapped, type WsaIoResult } from "./wsa-overlapped";
import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { writeGuestCode } from "../core/memory/guest-code";
import { parseIpv4, parseIpv6, formatIpv6 } from "../net/netplay-wire";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import type { DeferredWrite, ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, ipv6Address, type WsaAddress, type WsaPacket } from "./wsa-network";
import { IPX_NETNUM, IPX_MAX_PAYLOAD, UDP_MAX_PAYLOAD, UDP6_MAX_PAYLOAD } from "../net/lan-network";

export type WsaErrorSetter = ((code: number) => void) & { capture?: () => (code: number) => void };
interface Counter { started: boolean; }
interface Prepared { value: number; writes?: DeferredWrite[]; error?: number; }
function fail(code: number): never { throw new WsaFailure(code); }
function guard(ptr: number, size: number, write = false): void {
    const mem = Mem.getView();
    if (!mem || !ptr || size < 0 || ptr + size > mem.length || !isValidAddress(mem, ptr, size, write ? "rw" : "r")) fail(WSA.EFAULT);
}
function u32(ptr: number): number { guard(ptr, 4); return Mem.readUint32(ptr) ?? fail(WSA.EFAULT); }
function bytes(ptr: number, size: number): Uint8Array {
    if (!size) return new Uint8Array(0);
    guard(ptr, size);
    return Mem.readBytes(ptr, size)?.slice() ?? fail(WSA.EFAULT);
}
function patches(ptr: number, data: Uint8Array): DeferredWrite[] {
    const result: DeferredWrite[] = [];
    let i = 0;
    for (; i + 4 <= data.length; i += 4) result.push({ address: ptr + i,
        value: (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24) >>> 0, size: 4 });
    for (; i < data.length; i++) result.push({ address: ptr + i, value: data[i], size: 1 });
    return result;
}
function dword(address: number, value: number): DeferredWrite { return { address, value, size: 4 }; }
function publish(result: Prepared, deferred: boolean): number | ThunkResult {
    if (deferred) return { value: result.value, deferredWrites: result.writes };
    for (const w of result.writes ?? []) {
        const ok = w.size === 1 ? Mem.writeUint8(w.address, w.value) :
            w.size === 2 ? Mem.writeUint16(w.address, w.value) : Mem.writeUint32(w.address, w.value);
        if (!ok) fail(WSA.EFAULT);
    }
    return result.value;
}
function address(ptr: number, length: number): WsaAddress {
    if (length < 2) fail(WSA.EFAULT);
    const familyBytes = bytes(ptr, 2);
    const family = familyBytes[0] | familyBytes[1] << 8;
    if (family === 2) {
        if (length < 16) fail(WSA.EFAULT);
        const data = bytes(ptr, 16);
        return ipv4Address(data.slice(4, 8), data[2] << 8 | data[3]);
    }
    if (!family) return { family: 0, node: new Uint8Array(6), port: 0 };
    if (family === 23) {
        if (length < 28) fail(WSA.EFAULT);
        const data = bytes(ptr, 28), view = new DataView(data.buffer);
        return ipv6Address(data.slice(8, 24), data[2] << 8 | data[3], view.getUint32(24, true), view.getUint32(4, true));
    }
    if (family === 6) {
        if (length < 14) fail(WSA.EFAULT);
        const data = bytes(ptr, 14);
        // One virtual IPX network. Reject a different nonzero network.
        if (data.slice(2, 6).some(v => v) && !data.slice(2, 6).every((v, i) => v === IPX_NETNUM[i])) fail(WSA.EADDRNOTAVAIL);
        return { family, node: data.slice(6, 12), port: data[12] << 8 | data[13], ...(length >= 15 ? { packetType: bytes(ptr + 14, 1)[0] } : {}) };
    }
    fail(WSA.EAFNOSUPPORT);
}
function encodeAddress(a: WsaAddress, extended = false): Uint8Array {
    const data = new Uint8Array(a.family === 23 ? 28 : a.family === 6 && !extended ? 14 : 16);
    data[0] = a.family;
    if (a.family === 6) { data.set(IPX_NETNUM, 2); data.set(a.node, 6); data[12] = a.port >>> 8; data[13] = a.port & 255;
        if (extended) { data[14] = a.packetType ?? 0; data[15] = a.flags ?? 0; } }
    else if (a.family === 23) {
        const view = new DataView(data.buffer); data[2] = a.port >>> 8; data[3] = a.port & 255;
        if (a.ip6) data.set(a.ip6, 8); view.setUint32(4, a.flowInfo ?? 0, true); view.setUint32(24, a.scopeId ?? 0, true);
    }
    else { data[2] = a.port >>> 8; data[3] = a.port & 255; if (a.ip) data.set(a.ip, 4); }
    return data;
}
function outputAddress(ptr: number, lengthPtr: number, family: number, extended = false): ((a: WsaAddress) => DeferredWrite[]) {
    if (!ptr) return () => [];
    const size = family === 23 ? 28 : family === 6 && !extended ? 14 : 16;
    guard(lengthPtr, 4, true);
    if ((u32(lengthPtr) | 0) < size) fail(WSA.EFAULT);
    guard(ptr, size, true);
    return a => [...patches(ptr, encodeAddress(a, extended)), dword(lengthPtr, size)];
}
interface ReceiveAttempt { (): WsaPacket; partial(): WsaPacket | undefined; }
/** MSG_WAITALL consumes progressively, returning window credit while the guest remains blocked. */
function receiveAttempt(table: WsaSocketTable, socket: number, length: number, flags: number): ReceiveAttempt {
    const chunks: Uint8Array[] = [];
    let count = 0, source: WsaAddress | undefined, done = false;
    const packed = (): WsaPacket => {
        const data = new Uint8Array(count); let position = 0;
        for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; }
        return { data, from: source! };
    };
    const attempt = (() => {
        if (!(flags & 8) || table.get(socket).type !== 1 || (flags & 2)) return table.receive(socket, length, flags);
        if (done) return packed();
        while (count < length || !length) {
            let packet: WsaPacket;
            try { packet = table.receive(socket, length - count, flags & ~8); }
            catch (error) {
                if (count && error instanceof WsaFailure && error.code !== WSA.EWOULDBLOCK) { done = true; return packed(); }
                throw error;
            }
            source = packet.from; chunks.push(packet.data); count += packet.data.length;
            if (!packet.data.length || count >= length) { done = true; return packed(); }
        }
        return packed();
    }) as ReceiveAttempt;
    attempt.partial = () => count ? packed() : undefined;
    return attempt;
}
export function waitOperation<T>(table: WsaSocketTable, sid: number, attempt: () => T,
    timeout: number, poll = false, partial?: () => T | undefined, ignoreNonblocking = false): T | Promise<T> {
    try { return attempt(); } catch (error) {
        if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK || (!ignoreNonblocking && table.get(sid).nonBlocking)) throw error;
    }
    const generation = table.generation, signal = table.blockingSignal;
    if (signal?.aborted) fail(WSA.EINTR);
    return new Promise<T>((resolve, reject) => {
        let settled = false, checking = false, timer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe = () => {};
        const finish = (error?: unknown, value?: T) => {
            if (settled) return;
            settled = true; unsubscribe(); signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); if (pollTimer) clearTimeout(pollTimer);
            if (error) reject(error); else resolve(value!);
        };
        const check = () => {
            if (settled || checking) return;
            if (generation !== table.generation || !table.isValid(sid)) { finish(new WsaFailure(WSA.EINTR)); return; }
            checking = true;
            try { finish(undefined, attempt()); }
            catch (error) {
                if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK) finish(error);
                else if (poll && !pollTimer) pollTimer = setTimeout(() => { pollTimer = undefined; check(); }, 10);
            } finally { checking = false; }
        };
        const abort = () => finish(new WsaFailure(WSA.EINTR));
        signal?.addEventListener("abort", abort, { once: true });
        unsubscribe = table.subscribe(check);
        if (timeout) timer = setTimeout(() => {
            const result = partial?.();
            if (result !== undefined) finish(undefined, result); else finish(new WsaFailure(WSA.ETIMEDOUT));
        }, timeout);
        check();
    });
}
function adapt(counter: Counter, setError: WsaErrorSetter,
    impl: (args: number[]) => Prepared | Promise<Prepared>, failure = -1): ThunkImplementation {
    return (_ctx, _mem, args) => {
        const report = setError.capture?.() ?? setError;
        const failed = (e: unknown): number => {
            if (!(e instanceof WsaFailure)) throw e;
            report(e.code); return failure;
        };
        try {
            if (!counter.started) fail(WSA.NOTINITIALISED);
            // ThunkDispatcher reuses its argument array across calls/threads.
            const result = impl(args.slice());
            if (result instanceof Promise) return result.then<ThunkResult, ThunkResult>(r => {
                if (r.error !== undefined) report(r.error); return publish(r, true) as ThunkResult;
            }, e => ({ value: failed(e) }));
            const value = publish(result, false); if (result.error !== undefined) report(result.error); return value;
        } catch (e) { return failed(e); }
    };
}
function mapPrepared<T>(result: T | Promise<T>, prepare: (value: T) => Prepared): Prepared | Promise<Prepared> {
    return result instanceof Promise ? result.then(prepare) : prepare(result);
}
export function makeNetworkSocketExports(table: WsaSocketTable, setError: WsaErrorSetter, counter: Counter,
    validate: (af: number, type: number, protocol: number) => number, process?: Process): Record<string, ThunkImplementation> {
    const api: Record<string, ThunkImplementation> = {};
    const create = (args: number[], fromProtocolInfo = false, wide = false): Prepared => {
        let [af, type, protocol] = args.map(v => v | 0);
        if (fromProtocolInfo && args[3]) {
            guard(args[3], protocolInfoSize(wide));
            const reserved = u32(args[3] + 112);
            if (reserved) {
                const provider = table as WsaActorTable;
                if (!provider.importDuplicate) fail(WSA.ENETDOWN);
                return { value: provider.importDuplicate(reserved), error: 0 };
            }
            if (af === -1) af = u32(args[3] + 76) | 0;
            if (type === -1) type = u32(args[3] + 88) | 0;
            if (protocol === -1) protocol = u32(args[3] + 92) | 0;
        }
        const error = validate(af, type, protocol);
        if (error) fail(error);
        if (!af) af = protocol >= 1000 ? 6 : 2;
        if (!type) type = protocol === 17 || af === 6 ? 2 : protocol === 6 ? 1 : 3;
        const id = table.socket(type, af, protocol);
        if(fromProtocolInfo)table.get(id).overlapped=!!(args[5]&1);
        setError(0); // Native Windows socket()/WSASocket success clears the thread error.
        return { value: id };
    };
    api.socket = adapt(counter, setError, args => create(args));
    api.WSASocketA = adapt(counter, setError, args => create(args, true));
    api.WSASocketW = adapt(counter, setError, args => create(args, true, true));
    for (const wide of [false, true]) api[wide ? "WSADuplicateSocketW" : "WSADuplicateSocketA"] = adapt(counter, setError, a => {
        const socket = table.get(a[0]), output = a[2]; guard(output, protocolInfoSize(wide), true);
        const provider = table as WsaActorTable;
        if (!provider.duplicate) fail(WSA.ENETDOWN);
        const entry = wsaProtocols.find(p => p.family === socket.af && p.type === socket.type && (p.protocol === socket.protocol || socket.type === 3));
        if (!entry) fail(WSA.EPROTONOSUPPORT);
        const image = protocolInfo({ ...entry, protocol: socket.protocol }, wide);
        new DataView(image.buffer).setUint32(112, provider.duplicate(a[0], a[1]), true);
        return { value: 0, writes: patches(output, image) };
    });
    for (const wide of [false, true]) api[wide ? "WSAEnumProtocolsW" : "WSAEnumProtocolsA"] = adapt(counter, setError, a => {
        guard(a[2], 4, true);
        const filter = new Set<number>();
        if (a[0]) {
            let i = 0;
            for (; i < 256; i++) { const protocol = u32(a[0] + 4 * i); if (!protocol) break; filter.add(protocol); }
            if (i === 256) fail(WSA.EFAULT);
        }
        const entries = wsaProtocols.filter(p => !a[0] || filter.has(p.protocol));
        const size = entries.length * protocolInfoSize(wide), capacity = u32(a[2]);
        if (!a[1] || capacity < size) return { value: -1, error: WSA.ENOBUFS, writes: [dword(a[2], size)] };
        if (size) guard(a[1], size, true);
        return { value: entries.length, error: 0, writes: entries.flatMap((entry, i) => patches(a[1] + i * protocolInfoSize(wide), protocolInfo(entry, wide))) };
    });
    for (const short of [false, true]) for (const inbound of [false, true]) {
        const name = `WSA${inbound ? "Ntoh" : "Hton"}${short ? "s" : "l"}`;
        api[name] = adapt(counter, setError, a => {
            table.get(a[0]); guard(a[2], short ? 2 : 4, true);
            const value = short ? ((a[1] & 255) << 8) | ((a[1] >>> 8) & 255) :
                ((a[1] & 255) << 24) | ((a[1] & 0xff00) << 8) | ((a[1] >>> 8) & 0xff00) | (a[1] >>> 24);
            return { value: 0, error: 0, writes: [{ address: a[2], value: value >>> 0, size: short ? 2 : 4 }] };
        });
    }
    api.WSAConnect = (ctx, mem, args) => api.connect(ctx, mem, args);
    api.WSASendDisconnect = adapt(counter, setError, a => ({ value: table.shutdown(a[0], 1), error: 0 }));
    api.WSARecvDisconnect = adapt(counter, setError, a => ({ value: table.shutdown(a[0], 0), error: 0 }));
    api.closesocket = adapt(counter, setError, a => ({ value: table.closesocket(a[0]) }));
    api.bind = adapt(counter, setError, a => ({ value: table.bind(a[0], address(a[1], a[2] | 0)) }));
    api.listen = adapt(counter, setError, a => ({ value: table.listen(a[0], a[1]) }));
    api.connect = adapt(counter, setError, a => {
        const peer = address(a[1], a[2] | 0);
        try { return { value: table.connect(a[0], peer) }; }
        catch (e) {
            if (!(e instanceof WsaFailure) || e.code !== WSA.EWOULDBLOCK) throw e;
            const signal = table.blockingSignal, abort = () => table.cancelConnect(a[0]);
            const result = waitOperation(table, a[0], () => {
                const s = table.get(a[0]);
                if (s.state === "connected") return 0;
                if (s.error) fail(s.error);
                fail(WSA.EWOULDBLOCK);
            }, 0);
            if (result instanceof Promise && signal) {
                signal.addEventListener("abort", abort, { once: true });
                return result.then(value => { signal.removeEventListener("abort", abort); return { value }; }, error => { signal.removeEventListener("abort", abort); throw error; });
            }
            return mapPrepared(result, value => ({ value }));
        }
    });
    api.accept = adapt(counter, setError, a => {
        const s = table.get(a[0]), out = outputAddress(a[1], a[2], s.af);
        return mapPrepared(waitOperation(table, a[0], () => table.accept(a[0]), 0),
            id => ({ value: id, writes: out(table.get(id).peer!) }));
    });
    api.WSAAccept = (ctx, mem, args) => {
        if (!args[3]) return api.accept(ctx, mem, args);
        const a = args.slice(0, 5), report = setError.capture?.() ?? setError;
        const failure = (error: unknown): number => {
            if (!(error instanceof WsaFailure)) throw error;
            report(error.code); return -1;
        };
        try {
            if (!counter.started) fail(WSA.NOTINITIALISED);
            if (!isValidAddress(mem, a[3], 1, "rx")) fail(WSA.EFAULT);
            const owner = process ?? System.getInstance().process;
            if (!owner) fail(WSA.EFAULT);
            const socket = table.get(a[0]), out = outputAddress(a[1], a[2], socket.af);
            const begin = (frame: { esp: number; returnAddr?: number; wsaBlockingFrameId?: number }, child: number): ThunkResult => {
                const manager = owner.dispatcher.callbackManager;
                if (!manager) fail(WSA.ENOBUFS);
                const accepted = table.get(child);
                const caller = encodeAddress(accepted.peer!), callee = encodeAddress(accepted.local!);
                const scratch = owner.memory.alloc(36 + caller.length + callee.length, "THUNK_DATA", "rw");
                if (!scratch) fail(WSA.ENOBUFS);
                const id = frame.wsaBlockingFrameId ?? manager.saveSuspendedThunkContext(frame, 20, "WSAAccept condition");
                if (!id) { owner.memory.free(scratch); fail(WSA.ENOBUFS); }
                const writes: DeferredWrite[] = [dword(scratch, caller.length), dword(scratch + 4, scratch + 36),
                    dword(scratch + 8, callee.length), dword(scratch + 12, scratch + 36 + caller.length),
                    dword(scratch + 16, 0), dword(scratch + 20, 0), dword(scratch + 24, 0),
                    dword(scratch + 28, 0), dword(scratch + 32, 0),
                    ...patches(scratch + 36, caller), ...patches(scratch + 36 + caller.length, callee)];
                try {
                    publish({ value: 0, writes }, false);
                    const invocation = manager.invokeCallback(a[3],
                        [scratch, 0, 0, 0, scratch + 8, 0, scratch + 16, a[4]], 20, result => {
                            try {
                                if (!table.isValid(child) || !table.isValid(a[0])) fail(WSA.EINTR);
                                if (result === 0) {
                                    const value = publish({ value: child, writes: out(table.get(child).peer!) }, false);
                                    report(0); return typeof value === "number" ? value : value.value;
                                }
                                if (result === 2) { table.deferAccepted(a[0], child); fail(11002); } // WSATRY_AGAIN
                                table.rejectAccepted(child);
                                fail(result === 1 ? WSA.ECONNREFUSED : WSA.EINVAL);
                            } catch (error) { return failure(error); }
                            finally { owner.memory.free(scratch); }
                        }, false, "WSAAccept condition", id);
                    if (!invocation.callbackId) fail(WSA.ENOBUFS);
                    return { value: 0, suspendedForCallback: true, callbackId: invocation.callbackId, stackCleanup: 20, skipStackCheck: true };
                } catch (error) {
                    owner.memory.free(scratch); manager.abandonSuspendedFrame(id); throw error;
                }
            };
            const child = waitOperation(table, a[0], () => table.accept(a[0]), 0);
            if (child instanceof Promise) return child.then<ThunkResult, ThunkResult>(accepted => ({
                value: -1, startCallbackChain: frame => {
                    try { return !!begin(frame, accepted).suspendedForCallback; }
                    catch (error) { if (table.isValid(accepted) && table.isValid(a[0])) table.deferAccepted(a[0], accepted); failure(error); return false; }
                },
            }), error => ({ value: failure(error) }));
            try { return begin(ctx, child); }
            catch (error) { if (table.isValid(child) && table.isValid(a[0])) table.deferAccepted(a[0], child); throw error; }
        } catch (error) { return failure(error); }
    };
    const send = (a: number[], to: boolean): Prepared | Promise<Prepared> => {
        const s = table.get(a[0]);
        const length = a[2] | 0;
        if (length < 0) fail(WSA.EINVAL);
        if (s.type !== 1 && length > table.maxMessageSize(s.id)) fail(WSA.EMSGSIZE);
        if (a[3] & ~5) fail(WSA.EOPNOTSUPP);
        const data = bytes(a[1], s.type === 1 ? Math.min(length, 16384) : length);
        const dst = to && a[4] ? address(a[4], a[5] | 0) : undefined;
        return mapPrepared(waitOperation(table, a[0], () => table.send(a[0], data, dst, a[3]), s.sendTimeout, true),
            value => ({ value }));
    };
    api.send = adapt(counter, setError, a => send(a, false));
    api.sendto = adapt(counter, setError, a => send(a, true));
    const recv = (a: number[], from: boolean): Prepared | Promise<Prepared> => {
        const s = table.get(a[0]), length = a[2] | 0;
        if (length < 0) fail(WSA.EINVAL);
        if (length) guard(a[1], length, true);
        const out = from ? outputAddress(a[4], a[5], s.af, s.extendedAddress) : () => [];
        const attempt = receiveAttempt(table, a[0], length, a[3]);
        return mapPrepared(waitOperation(table, a[0], attempt, s.receiveTimeout, false, attempt.partial),
            packet => ({ value: packet.truncated ? -1 : packet.data.length, error: packet.truncated ? WSA.EMSGSIZE : 0,
                writes: [...patches(a[1], packet.data), ...out(packet.from),
                    // Truncation reports an error while preserving the copied prefix.
                ] }));
    };
    api.recv = adapt(counter, setError, a => recv(a, false));
    api.recvfrom = adapt(counter, setError, a => recv(a, true));
    api.WSARecvEx = adapt(counter, setError, a => {
        const socket = table.get(a[0]), length = a[2] | 0;
        guard(a[3], 4, true);
        if (length < 0) fail(WSA.EINVAL);
        if (length) guard(a[1], length, true);
        // Winsock 1 WSARecvEx's flags pointer is output-only; MSG_PEEK in it is ignored.
        const prepare = (packet: WsaPacket): Prepared => ({ value: packet.data.length,
            error: packet.truncated ? WSA.EMSGSIZE : 0,
            writes: [...patches(a[1], packet.data), dword(a[3], packet.truncated ? 0x8000 : 0)] });
        const failure = (error: unknown): Prepared => {
            if (!(error instanceof WsaFailure)) throw error;
            return { value: -1, error: error.code, writes: [dword(a[3], 0)] };
        };
        try {
            const result = waitOperation(table, a[0], () => table.receive(a[0], length, 0), socket.receiveTimeout);
            return result instanceof Promise ? result.then(prepare, failure) : prepare(result);
        } catch (error) { return failure(error); }
    });
    api.shutdown = adapt(counter, setError, a => ({ value: table.shutdown(a[0], a[1] | 0) }));
    for (const [name, peer] of [["getsockname", false], ["getpeername", true]] as const) {
        api[name] = adapt(counter, setError, a => {
            const s = table.get(a[0]), addr = peer ? s.peer : s.local;
            if (!addr) fail(peer ? WSA.ENOTCONN : WSA.EINVAL);
            if (s.acceptListener !== undefined || s.connectContextPending) fail(WSA.EINVAL);
            const out = outputAddress(a[1], a[2], s.af);
            if (!a[1]) fail(WSA.EFAULT);
            return { value: 0, writes: out(addr) };
        });
    }
    api.ioctlsocket = adapt(counter, setError, a => {
        const s = table.get(a[0]); guard(a[2], 4, true);
        switch (a[1] >>> 0) {
            case 0x8004667e: table.setNonBlocking(s.id, u32(a[2]) !== 0); return { value: 0 };
            case 0x4004667f: return { value: 0, writes: [dword(a[2], table.bytesAvailable(s.id))] };
            case 0x40047307: return { value: 0, writes: [dword(a[2], +table.atMark(s.id))] };
            default: fail(WSA.EINVAL);
        }
    });
    const extensionPointer = (name: string, argc: number): number => {
        const owner = process ?? System.getInstance().process;
        if (!owner?.dispatcher) fail(WSA.ENOBUFS);
        const dispatcher = owner.dispatcher, generator = owner.thunkGenerator;
        let pointer = generator.getExportAddress("__winsock:" + name);
        if (!pointer) {
            const stub = generator.allocateOneStub("__winsock", name, argc, "stdcall", argc * 4);
            writeGuestCode(owner.getCurrentMemory(), stub.code, stub.address); pointer = stub.address;
        }
        dispatcher.register("__winsock", name, api[name]); return pointer;
    };
    api.WSAIoctl = adapt(counter, setError, a => {
        const s = table.get(a[0]);
        guard(a[6], 4, true);
        if ((a[1] >>> 0) === 0xc8000006) {
            if (a[3] < 16 || a[5] < 4) fail(WSA.EFAULT); guard(a[4], 4, true);
            const guid = bytes(a[2], 16), view = new DataView(guid.buffer), id = view.getUint32(0, true);
            const legacyTail = [0xac, 0xcb, 0xcf, 0x11, 0x95, 0xca, 0, 0x80, 0x5f, 0x48, 0xa1, 0x92];
            const matches = (tail: number[]) => tail.every((v, i) => v === guid[i + 4]);
            const extension = matches(legacyTail) && id === 0xb5367df0 ? ["TransmitFile", 7] :
                matches(legacyTail) && id === 0xb5367df1 ? ["AcceptEx", 8] :
                matches(legacyTail) && id === 0xb5367df2 ? ["GetAcceptExSockaddrs", 8] :
                id === 0x25a207b9 && matches([0xf3,0xdd,0x60,0x46,0x8e,0xe9,0x76,0xe5,0x8c,0x74,0x06,0x3e]) ? ["ConnectEx", 7] :
                id === 0x7fda2e11 && matches([0x30,0x86,0x6f,0x43,0xa0,0x31,0xf5,0x36,0xa6,0xee,0xc1,0x57]) ? ["DisconnectEx", 4] : null;
            if (!extension) fail(WSA.EINVAL);
            const pointer = extensionPointer(extension[0] as string, extension[1] as number);
            return { value: 0, error: 0, writes: [dword(a[4], pointer), dword(a[6], 4)] };
        }
        if (a[7] || a[8]) fail(WSA.EOPNOTSUPP);
        if ((a[1] >>> 0) === 0x8004667e) {
            if (a[3] < 4) fail(WSA.EFAULT);
            table.setNonBlocking(s.id, u32(a[2]) !== 0);
            return { value: 0, writes: [dword(a[6], 0)] };
        }
        if ((a[1] >>> 0) === 0x4004667f) {
            if (a[5] < 4) fail(WSA.EFAULT);
            guard(a[4], 4, true);
            return { value: 0, writes: [dword(a[4], table.bytesAvailable(s.id)), dword(a[6], 4)] };
        }
        fail(WSA.EOPNOTSUPP);
    });
    api.setsockopt = adapt(counter, setError, a => {
        const s = table.get(a[0]);
        if ((s.af === 2 || s.af === 23) && (((a[1] >>> 0) === 0xffff && a[2] === 8) || (a[1] === 6 && a[2] === 1))) {
            // The native TCP provider consumes a BOOLEAN, including when optlen is four.
            guard(a[3], 1);
            if (s.type !== 1) fail(a[1] === 6 ? WSA.EINVAL : WSA.ENOPROTOOPT);
            if ((a[4] | 0) < 1) fail(WSA.EFAULT);
            const on = (Mem.readUint8(a[3]) ?? 0) !== 0;
            if (a[1] === 6) table.setNoDelay(s.id, on); else table.setKeepAlive(s.id, on);
            return { value: 0 };
        }
        if (s.af === 6 && a[1] === 1000) {
            if (a[2] === 0x4003) { s.filterPacketType = null; return { value: 0 }; }
            if (a[4] < 4) fail(WSA.EFAULT);
            const value = u32(a[3]);
            if (a[2] === 0x4004) { s.extendedAddress = !!value; return { value: 0 }; }
            if (a[2] === 0x4005) { s.receiveHeader = !!value; return { value: 0 }; }
            if (a[2] === 0x400f) { s.receiveBroadcast = !!value; return { value: 0 }; }
            if (value > 255) fail(WSA.EINVAL);
            if (a[2] === 0x4000) s.packetType = value;
            else if (a[2] === 0x4001) s.filterPacketType = value;
            else fail(WSA.ENOPROTOOPT);
            return { value: 0 };
        }
        if ((s.af === 2 && a[1] === 0) || (s.af === 23 && a[1] === 41)) {
            if (a[4] < 4) fail(WSA.EFAULT);
            const value = u32(a[3]) | 0;
            if (a[2] === 2) {
                if (s.type !== 3) fail(WSA.EINVAL);
                s.headerInclude = !!value; return { value: 0 };
            }
            if ((s.af === 2 && a[2] === 4) || (s.af === 23 && a[2] === 4)) {
                if (s.type !== 3) fail(WSA.ENOPROTOOPT);
                if (value < (s.af === 23 ? -1 : 0) || value > 255) fail(WSA.EINVAL);
                s.ipTtl = value; s.ipOptionsChanged = true; return { value: 0 };
            }
            if ((s.af === 2 && a[2] === 3) || (s.af === 23 && a[2] === 39)) {
                if (s.type !== 3) fail(WSA.ENOPROTOOPT);
                if (value < 0 || value > 255) fail(WSA.EINVAL);
                s.ipTos = value; s.ipOptionsChanged = true; return { value: 0 };
            }
            fail(WSA.ENOPROTOOPT);
        }
        if ((a[1] >>> 0) === 0xffff && a[2] === 0x7010) {
            if (!s.connectContextPending || s.state !== "connected") fail(WSA.EINVAL);
            s.connectContextPending = false; return { value: 0, error: 0 };
        }
        if ((a[1] >>> 0) !== 0xffff || a[4] < 4) fail(WSA.ENOPROTOOPT);
        const value = u32(a[3]);
        switch (a[2]) {
            case 0x700b: if (s.acceptListener !== value || !table.isValid(value)) fail(WSA.EINVAL); s.acceptListener = undefined; break;
            case 4: s.reuse = !!value; break;
            case 0x20: s.broadcast = !!value; break;
            case 0x80: s.lingerEnabled = !!(value & 0xffff); s.lingerSeconds = value >>> 16; break;
            case 0xffffff7f: s.lingerEnabled = !value; break;
            case 0x100: table.setOobInline(s.id, !!value); break;
            case 0x1001: s.sendLimit = Math.min(1024 * 1024, Math.max(1, value)); break;
            case 0x1002:
                if (s.state === "connected" && s.type === 1) fail(WSA.EOPNOTSUPP);
                s.receiveLimit = Math.min(1024 * 1024, Math.max(1, value)); break;
            case 0x1005: s.sendTimeout = value; break;
            case 0x1006: s.receiveTimeout = value; break;
            default: fail(WSA.ENOPROTOOPT);
        }
        return { value: 0 };
    });
    api.getsockopt = adapt(counter, setError, a => {
        const s = table.get(a[0]); guard(a[4], 4, true);
        if ((s.af === 2 || s.af === 23) && (((a[1] >>> 0) === 0xffff && a[2] === 8) || (a[1] === 6 && a[2] === 1))) {
            if ((u32(a[4]) | 0) < 1) fail(WSA.EFAULT);
            guard(a[3], 1, true);
            if (s.type !== 1) {
                if (a[1] === 6) return { value: -1, error: WSA.EINVAL, writes: [dword(a[4], 0)] };
                fail(WSA.ENOPROTOOPT);
            }
            return { value: 0, writes: [{ address: a[3], value: +(a[1] === 6 ? s.noDelay : s.keepAlive), size: 1 }, dword(a[4], 1)] };
        }
        if (s.af === 6 && a[1] === 1000) {
            const length = u32(a[4]) | 0;
            if (a[2] === 0x4007) { // IPX_ADDRESS_DATA (Win32 layout, 24 bytes)
                if (length < 24) fail(WSA.EFAULT);
                guard(a[3], 24, true);
                if (u32(a[3]) !== 0) fail(WSA.EINVAL);
                const data = new Uint8Array(24);
                data.set(IPX_NETNUM, 4); data.set(table.network.node, 8);
                data[15] = 1; // adapter status (wan == false)
                const view = new DataView(data.buffer);
                view.setUint32(16, IPX_MAX_PAYLOAD, true); view.setUint32(20, 100000, true);
                return { value: 0, writes: [...patches(a[3], data), dword(a[4], 24)] };
            }
            if ([0x4000, 0x4001, 0x4004, 0x4005, 0x4006, 0x400d, 0x400f].includes(a[2])) {
                if (length < 4) fail(WSA.EFAULT); guard(a[3], 4, true);
                const value = a[2] === 0x4000 ? s.packetType : a[2] === 0x4001 ? s.filterPacketType ?? -1 :
                    a[2] === 0x4004 ? +s.extendedAddress : a[2] === 0x4005 ? +s.receiveHeader : a[2] === 0x400f ? +s.receiveBroadcast :
                    a[2] === 0x4006 ? IPX_MAX_PAYLOAD : 1;
                return { value: 0, writes: [dword(a[3], value), dword(a[4], 4)] };
            }
            fail(WSA.ENOPROTOOPT);
        }
        if ((u32(a[4]) | 0) < 4) fail(WSA.EFAULT);
        guard(a[3], 4, true);
        if ((s.af === 2 && a[1] === 0) || (s.af === 23 && a[1] === 41)) {
            let value: number;
            if (a[2] === 2) { if (s.type !== 3) fail(WSA.EINVAL); value = +s.headerInclude; }
            else if (a[2] === 4 && s.type === 3) value = s.ipTtl;
            else if (s.type === 3 && ((s.af === 2 && a[2] === 3) || (s.af === 23 && a[2] === 39))) value = s.ipTos;
            else fail(WSA.ENOPROTOOPT);
            return { value: 0, writes: [dword(a[3], value), dword(a[4], 4)] };
        }
        if ((a[1] >>> 0) !== 0xffff) fail(WSA.ENOPROTOOPT);
        let value: number;
        switch (a[2]) {
            case 2: value = s.state === "listening" ? 1 : 0; break;
            case 4: value = +s.reuse; break;
            case 0x20: value = +s.broadcast; break;
            case 0x80: value = +s.lingerEnabled | s.lingerSeconds << 16; break;
            case 0xffffff7f: value = +!s.lingerEnabled; break;
            case 0x100: value = +s.oobInline; break;
            case 0x1001: value = s.sendLimit; break;
            case 0x1002: value = s.receiveLimit; break;
            case 0x1005: value = s.sendTimeout; break;
            case 0x1006: value = s.receiveTimeout; break;
            case 0x1007: value = s.pendingError; s.pendingError = 0; if (s.type !== 1 && s.error !== WSA.ENETDOWN) s.error = 0; break;
            case 0x1008: value = s.type; break;
            case 0x700c: value = s.state === "connected" ? Math.floor((Date.now() - s.connectedAt) / 1000) : 0xffffffff; break;
            case 0x2003: value = table.maxMessageSize(s.id); break;
            default: fail(WSA.ENOPROTOOPT);
        }
        return { value: 0, writes: [dword(a[3], value), dword(a[4], 4)] };
    });
    api.WSAAsyncSelect = adapt(counter, setError, a => {
        table.get(a[0]);
        if ((a[3] & ~0x3f) || (a[3] && (!a[1] || !a[2]))) fail(WSA.EINVAL);
        table.configureEvents(a[0], a[3], (bit, error) => {
            const system = System.getInstance();
            system.windowManager.postMessage(a[1], a[2], a[0], ((error << 16) | bit) >>> 0);
            system.scheduler.wakeMessageWaiters();
        });
        return { value: 0 };
    });
    api.WSAEventSelect = adapt(counter, setError, a => {
        if (a[2] & ~0x3f) fail(WSA.EINVAL);
        if (a[2]) {
            const object = System.getInstance().resourceProvider.getKernelObject(a[1]);
            if (!object || object.kind !== "event") fail(WSA.EINVAL);
        }
        table.configureEvents(a[0], a[2], () => { System.getInstance().scheduler.setEvent(a[1]); });
        return { value: 0 };
    });
    api.WSAEnumNetworkEvents = adapt(counter, setError, a => {
        guard(a[2], 44, true);
        if (a[1] && !System.getInstance().scheduler.resetEvent(a[1])) fail(WSA.EINVAL);
        const events = table.enumEvents(a[0]);
        return { value: 0, writes: [dword(a[2], events.mask), ...events.errors.map((v, i) => dword(a[2] + 4 + i * 4, v))] };
    });
    const buffers = (ptr: number, count: number, writing: boolean): Array<{ ptr: number; length: number }> => {
        if (!count || count > 1024) fail(WSA.EINVAL);
        guard(ptr, count * 8);
        let total = 0;
        return Array.from({ length: count }, (_, i) => {
            const length = u32(ptr + i * 8), target = u32(ptr + i * 8 + 4);
            total += length;
            if (total > 0xffffffff) fail(WSA.EINVAL);
            if (length) guard(target, length, writing);
            return { ptr: target, length };
        });
    };
    const overlap = () => {
        const owner = process ?? System.getInstance().process;
        if (!owner) fail(WSA.EFAULT);
        return getWsaOverlapped(table, owner);
    };
    const validateOverlapped = (ov: number, routine: number): void => {
        guard(ov, 20, true);
        if (routine) {
            const memory = Mem.getView()!;
            if (!isValidAddress(memory, routine, 1, "rx")) fail(WSA.EFAULT);
        }
    };
    const issueSocketIo = (socket: number, ov: number, routine: number, direction: "read" | "urgent" | "write",
        attempt: (operation: WsaSocketTable) => WsaIoResult, immediateWrites: (result: WsaIoResult) => DeferredWrite[]): Prepared | Promise<Prepared> => {
        const provider = overlap(), state = table.get(socket), synchronous = !state.overlapped;
        const warningReturn = direction !== "write" && state.af !== 6 ? (result: WsaIoResult) => result.error === WSA.EMSGSIZE ? 997 : undefined : undefined;
        const lease = table.acquireNativeIo(socket);
        const answer = provider.issue(socket, ov, routine, direction, () => attempt(lease.table), immediateWrites, true, undefined,
            { nativeIoLease: lease, cancellable: !synchronous, immediateReturnError: warningReturn, completionBytes: synchronous ? () => 0 : undefined, immediateErrorHasNoCompletion: true });
        if (!synchronous || answer.error !== 997) return answer;
        // FILE_SYNCHRONOUS_IO_NONALERT blocks even with an OVERLAPPED. Native Winsock
        // ignores FIONBIO/timeouts here and does not expose this operation to CancelIoEx.
        return new Promise(resolve => {
            const observed = provider.observeCompletion(socket, ov, result => {
                const error = warningReturn?.(result) ?? result.error ?? 0;
                resolve({ value: error ? -1 : 0, error, writes: error && error !== result.error ? [] : immediateWrites(result) });
            });
            if (!observed) fail(WSA.EINVAL);
        });
    };
    const booleanIo = (answer: { value: number; error?: number; writes?: DeferredWrite[] }): Prepared =>
        ({ ...answer, value: answer.value === 0 ? 1 : 0 });
    api.AcceptEx = adapt(counter, setError, a => {
        const listener = table.get(a[0]), target = table.get(a[1]), size = listener.af === 23 ? 28 : 16;
        if (listener.type !== 1 || listener.state !== "listening" || target.af !== listener.af || target.type !== 1 || target.local || target.state !== "new") fail(WSA.EINVAL);
        if (a[4] < size + 16 || a[5] < size + 16) fail(WSA.EFAULT);
        const extent = a[3] + a[4] + a[5];
        if (extent > 0xffffffff) fail(WSA.EFAULT); guard(a[2], extent, true);
        if (a[6]) guard(a[6], 4, true);
        validateOverlapped(a[7], 0);
        let accepted = false;
        const attempt = (): WsaIoResult => {
            if (!table.isValid(a[0]) || !table.isValid(a[1])) fail(995);
            if (!accepted) {
                const child = table.accept(a[0]); table.adoptAccepted(a[1], child); accepted = true;
                table.get(a[1]).acceptListener = a[0];
            }
            const socket = table.get(a[1]), packet = a[3] ? table.receive(a[1], a[3]) : { data: new Uint8Array(0) };
            const local = a[2] + a[3], remote = local + a[4];
            return { bytes: packet.data.length, flags: 0, writes: [...patches(a[2], packet.data),
                dword(local, size), ...patches(local + 16, encodeAddress(socket.local!)),
                dword(remote, size), ...patches(remote + 16, encodeAddress(socket.peer!))] };
        };
        return booleanIo(overlap().issue(a[0], a[7], 0, "read", attempt, result => a[6] ? [dword(a[6], result.bytes)] : []));
    }, 0);
    api.GetAcceptExSockaddrs = (_ctx, _mem, a) => {
        try {
            const local = a[0] + a[1], remote = local + a[2];
            guard(local, a[2]); guard(remote, a[3]);
            for (const pointer of [a[4], a[5], a[6], a[7]]) guard(pointer, 4, true);
            const localSize = u32(local), remoteSize = u32(remote);
            if (localSize + 16 > a[2] || remoteSize + 16 > a[3]) fail(WSA.EFAULT);
            publish({ value: 0, writes: [dword(a[4], local + 16), dword(a[5], localSize), dword(a[6], remote + 16), dword(a[7], remoteSize)] }, false);
        } catch (error) { if (!(error instanceof WsaFailure)) throw error; setError(error.code); }
        return 0;
    };
    api.ConnectEx = adapt(counter, setError, a => {
        const socket = table.get(a[0]);
        if (socket.type !== 1 || !socket.local) fail(WSA.EINVAL);
        if (socket.state === "connected") fail(WSA.EISCONN);
        const peer = address(a[1], a[2]), data = bytes(a[3], a[4]);
        if (a[5]) guard(a[5], 4, true);
        validateOverlapped(a[6], 0);
        let started = false, sent = 0;
        const attempt = (): WsaIoResult => {
            if (!started) {
                started = true; socket.originalLocal = socket.local;
                try { table.connect(a[0], peer); } catch (error) {
                    if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK) throw error;
                }
            }
            const current = table.get(a[0]);
            if (current.error) fail(current.error);
            if (current.state !== "connected") fail(WSA.EWOULDBLOCK);
            while (sent < data.length) sent += table.send(a[0], data.subarray(sent, Math.min(sent + 16384, data.length)));
            current.connectContextPending = true;
            return { bytes: sent, flags: 0, writes: [] };
        };
        return booleanIo(overlap().issue(a[0], a[6], 0, "write", attempt, result => a[5] ? [dword(a[5], result.bytes)] : [], false, () => table.cancelConnect(a[0])));
    }, 0);
    api.DisconnectEx = adapt(counter, setError, a => {
        table.get(a[0]); if (a[2] & ~2 || a[3]) fail(WSA.EINVAL);
        const attempt = (): WsaIoResult => { table.disconnect(a[0], !!(a[2] & 2)); return { bytes: 0, flags: 0, writes: [] }; };
        if (!a[1]) return mapPrepared(waitOperation(table, a[0], attempt, 0), () => ({ value: 1, error: 0 }));
        validateOverlapped(a[1], 0);
        return booleanIo(overlap().issue(a[0], a[1], 0, "write", attempt, () => []));
    }, 0);
    api.TransmitFile = adapt(counter, setError, a => {
        const socket = table.get(a[0]), flags = a[6] >>> 0, ov = a[4];
        if (socket.type !== 1 || socket.state !== "connected") fail(WSA.ENOTCONN);
        if ((flags & ~0x37) || ((flags & 2) && !(flags & 1)) || ((flags & 0x30) === 0x30)) fail(WSA.EINVAL);
        if (ov) validateOverlapped(ov, 0);
        const extra = a[5] ? bytes(a[5], 16) : new Uint8Array(16), view = new DataView(extra.buffer);
        const head = bytes(view.getUint32(0, true), view.getUint32(4, true));
        const tail = bytes(view.getUint32(8, true), view.getUint32(12, true));
        const system = System.getInstance(), vfs = system.fileSystem;
        const file = a[1] ? system.resourceProvider.getFileHandle(a[1]) : undefined;
        if (a[1] && (!file?.vfsHandle || file.vfsHandle.kind !== "file")) fail(6);
        if (file && !(file.vfsHandle.access & 0x80000001)) fail(5);
        const offset = file ? ov ? u32(ov + 8) + u32(ov + 12) * 0x100000000 : file.position : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) fail(WSA.EINVAL);
        const available = file ? Math.max(0, file.size - offset) : 0;
        const fileLength = file ? Math.min(a[2] || available, available) : 0;
        if (fileLength + head.length + tail.length > 0x7ffffffe) fail(WSA.EINVAL);
        const cursor = file ? vfs.duplicateHandle(file.vfsHandle, offset) : undefined;
        const generation = table.generation, provider = ov ? overlap() : undefined;
        let phase = 0, position = 0, sent = 0, fileSent = 0;
        let chunk: Uint8Array | undefined, reading = false, readError = 0;
        const chunkSize = Math.min(a[3] || 65536, 65536);
        const attempt = (): WsaIoResult => {
            try {
                if (generation !== table.generation) fail(995);
                if (readError) fail(readError);
                while (phase < 3) {
                    let buffer: Uint8Array;
                    if (phase === 1) {
                        if (fileSent >= fileLength) { phase++; position = 0; continue; }
                        if (!chunk) {
                            if (reading) fail(WSA.EWOULDBLOCK);
                            const count = Math.min(chunkSize, fileLength - fileSent);
                            const cached = vfs.readSync(cursor!, count, "park-preferred");
                            if (cached === null) {
                                reading = true;
                                void vfs.read(cursor!, count).then(data => {
                                    if (generation !== table.generation) return;
                                    reading = false; chunk = data.slice();
                                    if (!chunk.length) readError = 38;
                                    provider?.resume();
                                }, () => { if (generation === table.generation) { reading = false; readError = 30; provider?.resume(); } });
                                fail(WSA.EWOULDBLOCK);
                            }
                            chunk = cached.slice();
                            if (!chunk.length) fail(38);
                        }
                        buffer = chunk;
                    } else buffer = phase === 0 ? head : tail;
                    if (position === buffer.length) { if (phase === 1) chunk = undefined; else phase++; position = 0; continue; }
                    const count = table.send(a[0], buffer.subarray(position, Math.min(position + 16384, buffer.length)));
                    position += count; sent += count; if (phase === 1) fileSent += count;
                }
                if (flags & 1) table.disconnect(a[0], !!(flags & 2));
                return { bytes: sent, flags: 0, writes: [] };
            } catch (error) {
                if (!(error instanceof WsaFailure) || error.code === WSA.EWOULDBLOCK) throw error;
                return { bytes: sent, flags: 0, writes: [], error: error.code };
            }
        };
        if (ov) return booleanIo(provider!.issue(a[0], ov, 0, "write", attempt, () => [], true));
        return mapPrepared(waitOperation(table, a[0], attempt, socket.sendTimeout, true, undefined, true),
            result => ({ value: result.error ? 0 : 1, error: result.error ?? 0 }));
    }, 0);
    for (const to of [false, true]) {
        api[to ? "WSASendTo" : "WSASend"] = adapt(counter, setError, a => {
            const s = table.get(a[0]), oi = to ? 7 : 5, ov = a[oi], routine = a[oi + 1];
            if (!ov && routine) fail(WSA.EINVAL);
            if (a[4] & ~5) fail(WSA.EOPNOTSUPP);
            if (a[3]) guard(a[3], 4, true); else if (!ov) fail(WSA.EFAULT);
            const bufs = buffers(a[1], a[2], false);
            const total = bufs.reduce((sum, b) => sum + b.length, 0);
            if (s.type !== 1 && total > table.maxMessageSize(s.id)) fail(WSA.EMSGSIZE);
            const data = new Uint8Array(ov ? total : s.type === 1 ? Math.min(total, 16384) : total);
            let offset = 0;
            for (const b of bufs) {
                const count = Math.min(b.length, data.length - offset);
                if (count) data.set(bytes(b.ptr, count), offset);
                offset += count; if (offset === data.length) break;
            }
            const dst = to && a[5] ? address(a[5], a[6] | 0) : undefined;
            if (!ov) return mapPrepared(waitOperation(table, a[0], () => table.send(a[0], data, dst, a[4]), s.sendTimeout, true),
                count => ({ value: 0, error: 0, writes: [dword(a[3], count)] }));
            validateOverlapped(ov, routine);
            let sent = 0, attemptedEmpty = false;
            const attempt = (operation: WsaSocketTable): WsaIoResult => {
                const current = operation.get(a[0]), stream = current.type === 1;
                if(!stream && !dst && !current.peer)fail(WSA.ENOTCONN);
                while (sent < data.length || (!data.length && !attemptedEmpty)) {
                    const end = stream ? Math.min(sent + 16384, data.length) : data.length;
                    const flags = end === data.length ? a[4] : a[4] & ~1;
                    const count = operation.send(a[0], data.subarray(sent, end), dst, flags);
                    attemptedEmpty = true; sent += count;
                    if (!count && sent < data.length) fail(WSA.EWOULDBLOCK);
                }
                return { bytes: sent, flags: 0, writes: [] };
            };
            return issueSocketIo(a[0], ov, routine, "write", attempt,
                result => a[3] ? [dword(a[3], result.bytes)] : []);
        });
        api[to ? "WSARecvFrom" : "WSARecv"] = adapt(counter, setError, a => {
            const s = table.get(a[0]), oi = to ? 7 : 5, ov = a[oi], routine = a[oi + 1];
            if (!ov && routine) fail(WSA.EINVAL);
            if (a[3]) guard(a[3], 4, true); else if (!ov) fail(WSA.EFAULT);
            guard(a[4], 4, true);
            const flags = u32(a[4]), bufs = buffers(a[1], a[2], true), family = s.af;
            const total = bufs.reduce((sum, b) => sum + b.length, 0);
            const out = to ? outputAddress(a[5], a[6], s.af, s.extendedAddress) : () => [];
            const receive = receiveAttempt(table, a[0], total, flags);
            const prepare = (packet: WsaPacket): WsaIoResult => {
                const writes: DeferredWrite[] = [];
                let offset = 0;
                for (const b of bufs) {
                    const part = packet.data.subarray(offset, offset + b.length);
                    writes.push(...patches(b.ptr, part)); offset += part.length;
                }
                const resultFlags = family === 6 ? packet.truncated ? 0x8000 : flags & 1 : 0;
                writes.push(dword(a[4], resultFlags), ...out(packet.from));
                return { bytes: packet.data.length, flags: resultFlags, error: packet.truncated ? WSA.EMSGSIZE : 0, writes };
            };
            if (!ov) return mapPrepared(waitOperation(table, a[0], receive, s.receiveTimeout, false, receive.partial), packet => {
                const result = prepare(packet);
                return { value: result.error ? -1 : 0, error: result.error, writes: [...result.writes, dword(a[3], result.bytes)] };
            });
            validateOverlapped(ov, routine);
            if(s.af !== 6 && !Mem.writeUint32(a[4],0)) fail(WSA.EFAULT);
            let issuedReceive: ReceiveAttempt | undefined;
            return issueSocketIo(a[0], ov, routine, s.type === 1 && (flags & 1) ? "urgent" : "read", operation => {
                const current = operation.get(a[0]);
                if((flags & 1) && !(flags & ~3) && current.type === 1 && !current.oobInline && current.oob === null && current.state === "connected" && !current.error && !current.eof && !current.readShutdown)fail(WSA.EWOULDBLOCK);
                issuedReceive ??= receiveAttempt(operation, a[0], total, flags);
                return prepare(issuedReceive());
            },
                result => a[3] ? [dword(a[3], result.bytes)] : []);
        });
    }
    const conversion = (impl: (a: number[], mem: Uint8Array) => Prepared, failure = -1): ThunkImplementation =>
        (_ctx, mem, args) => {
            try { const result = impl(args, mem); const value = publish(result, false); if (result.error !== undefined) setError(result.error); return value; }
            catch (error) { if (!(error instanceof WsaFailure)) throw error; setError(error.code); return failure; }
        };
    const textBytes = (text: string, wide: boolean) => {
        if (!wide) return new TextEncoder().encode(text + "\0");
        const data = new Uint8Array((text.length + 1) * 2), view = new DataView(data.buffer);
        for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
        return data;
    };
    const formatIp = (family: number, ip: Uint8Array): string => {
        if (family === 2) return Array.from(ip).join(".");
        if (ip.slice(0, 10).every(v => !v) && ip[10] === 255 && ip[11] === 255) return "::ffff:" + Array.from(ip.slice(12)).join(".");
        return formatIpv6(ip);
    };
    const strictIp = (family: number, text: string): Uint8Array | null => {
        if (family === 23) return text.includes("%") ? null : parseIpv6(text);
        const ip = parseIpv4(text);
        return ip && text.split(".").every(part => part.length === 1 || part[0] !== "0") ? ip : null;
    };
    for (const wide of [false, true]) {
        const readText = (mem: Uint8Array, ptr: number) => { guard(ptr, wide ? 2 : 1); return wide ? Marshaler.readWideString(mem, ptr) : Marshaler.readString(mem, ptr); };
        const pton = conversion((a, mem) => {
            if (a[0] !== 2 && a[0] !== 23) fail(WSA.EAFNOSUPPORT);
            const text = readText(mem, a[1]); guard(a[2], a[0] === 2 ? 4 : 16, true);
            const ip = strictIp(a[0], text);
            return ip ? { value: 1, writes: patches(a[2], ip) } : { value: 0 };
        });
        api[wide ? "InetPtonW" : "InetPtonA"] = pton; if (!wide) api.inet_pton = pton;
        const ntop = conversion(a => {
            if (a[0] !== 2 && a[0] !== 23) fail(WSA.EAFNOSUPPORT);
            const text = formatIp(a[0], bytes(a[1], a[0] === 2 ? 4 : 16)), data = textBytes(text, wide);
            if (a[3] < text.length + 1) fail(WSA.EFAULT); guard(a[2], data.length, true);
            return { value: a[2], writes: patches(a[2], data) };
        }, 0);
        api[wide ? "InetNtopW" : "InetNtopA"] = ntop; if (!wide) api.inet_ntop = ntop;
        api[wide ? "WSAAddressToStringW" : "WSAAddressToStringA"] = conversion(a => {
            const addr = address(a[0], a[1]); guard(a[4], 4, true);
            let host: string;
            if (addr.family === 2 || addr.family === 23) {
                host = formatIp(addr.family, addr.ip ?? addr.ip6!);
                if (addr.scopeId) host += "%" + addr.scopeId;
                if (addr.port) host = addr.family === 23 ? "[" + host + "]:" + addr.port : host + ":" + addr.port;
            } else {
                host = Array.from(IPX_NETNUM, n => n.toString(16).padStart(2, "0")).join("") + "." +
                    Array.from(addr.node, n => n.toString(16).padStart(2, "0")).join("") + ":" + addr.port.toString(16).padStart(4, "0");
            }
            const required = host.length + 1;
            if (!a[3] || u32(a[4]) < required) return { value: -1, error: WSA.EFAULT, writes: [dword(a[4], required)] };
            const data = textBytes(host, wide); guard(a[3], data.length, true);
            return { value: 0, error: 0, writes: [...patches(a[3], data), dword(a[4], required)] };
        });
        api[wide ? "WSAStringToAddressW" : "WSAStringToAddressA"] = conversion((a, mem) => {
            const text = readText(mem, a[0]), family = a[1]; guard(a[4], 4, true);
            if (family !== 2 && family !== 23 && family !== 6) fail(WSA.EAFNOSUPPORT);
            const size = family === 23 ? 28 : family === 6 ? 14 : 16;
            if (!a[3] || u32(a[4]) < size) return { value: -1, error: WSA.EFAULT, writes: [dword(a[4], size)] };
            let addr: WsaAddress;
            if (family === 6) {
                const match = /^([0-9a-f]{8})\.([0-9a-f]{12})(?::([0-9a-f]{1,4}))?$/i.exec(text);
                if (!match || match[1].toLowerCase() !== "00000001") fail(WSA.EINVAL);
                addr = { family, port: parseInt(match[3] ?? "0", 16), node: Uint8Array.from(match[2].match(/../g)!.map(part => parseInt(part, 16))) };
            } else {
                let host = text, port = 0, scopeId = 0;
                if (family === 2) {
                    const match = /^([^:]+)(?::([0-9]+))?$/.exec(text); if (!match) fail(WSA.EINVAL);
                    host = match[1]; port = Number(match[2] ?? 0);
                } else if (text[0] === "[") {
                    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(text); if (!match) fail(WSA.EINVAL);
                    host = match[1]; port = Number(match[2] ?? 0);
                }
                if (port > 65535 || !Number.isInteger(port)) fail(WSA.EINVAL);
                if (family === 23 && host.includes("%")) {
                    const parts = host.split("%"); if (parts.length !== 2 || !/^[0-9]+$/.test(parts[1]) || Number(parts[1]) > 0xffffffff) fail(WSA.EINVAL);
                    host = parts[0]; scopeId = Number(parts[1]);
                }
                const ip = strictIp(family, host); if (!ip) fail(WSA.EINVAL);
                addr = family === 23 ? ipv6Address(ip, port, scopeId) : ipv4Address(ip, port);
            }
            guard(a[3], size, true);
            return { value: 0, error: 0, writes: [...patches(a[3], encodeAddress(addr)), dword(a[4], size)] };
        });
    }
    api.WSAGetOverlappedResult = adapt(counter, setError, a => {
        table.get(a[0]);
        if (!a[1]) fail(87); // WSA_INVALID_PARAMETER
        guard(a[1], 20);
        if (a[2]) guard(a[2], 4, true);
        if (a[4]) guard(a[4], 4, true);
        return overlap().result(a[0], a[1], !!a[3], a[2], a[4]);
    }, 0);
    return api;
}

export function makeNetworkSelect(table: WsaSocketTable, setError: WsaErrorSetter, counter: Counter = { started: true }): ThunkImplementation {
    // select's snapshot is host-owned. Only its completion writes fd_sets back.
    return adapt(counter, setError, a => {
        const pointers = [a[1], a[2], a[3]];
        const sets = pointers.map(ptr => {
            if (!ptr) return [];
            const count = u32(ptr);
            if (count > 65536) fail(WSA.EINVAL);
            guard(ptr, 4 + count * 4, true);
            return Array.from({ length: count }, (_, i) => u32(ptr + 4 + i * 4));
        });
        if (!sets.some(s => s.length)) fail(WSA.EINVAL);
        for (const s of sets.flat()) table.get(s);
        let timeout = -1;
        if (a[4]) {
            const seconds = u32(a[4]) | 0, micros = u32(a[4] + 4) | 0;
            if (seconds < 0 || micros < 0 || micros >= 1000000) fail(WSA.EINVAL);
            timeout = seconds * 1000 + Math.ceil(micros / 1000);
        }
        const generation = table.generation, signal = table.blockingSignal;
        const check = (): Prepared | null => {
            if (generation !== table.generation) fail(WSA.EINTR);
            const ready = [sets[0].filter(s => table.readable(s)), sets[1].filter(s => table.writable(s)),
                sets[2].filter(s => table.exceptional(s))];
            const count = ready.reduce((n, set) => n + set.length, 0);
            if (!count) return null;
            return prepare(ready, count);
        };
        const prepare = (ready: number[][], count: number): Prepared => ({
            value: count,
            writes: pointers.flatMap((ptr, i) => !ptr ? [] : [dword(ptr, ready[i].length),
                ...ready[i].map((sid, j) => dword(ptr + 4 + j * 4, sid))]),
        });
        const immediate = check();
        if (immediate) return immediate;
        if (timeout === 0) return prepare([[], [], []], 0);
        return new Promise<Prepared>((resolve, reject) => {
            let done = false, timer: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe = () => {};
            const finish = (result?: Prepared, error?: unknown) => {
                if (done) return;
                done = true; unsubscribe(); signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer);
                if (error) reject(error); else resolve(result!);
            };
            const abort = () => finish(undefined, new WsaFailure(WSA.EINTR));
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener("abort", abort, { once: true });
            unsubscribe = table.subscribe(() => {
                try { const result = check(); if (result) finish(result); } catch (error) { finish(undefined, error); }
            });
            if (timeout >= 0) timer = setTimeout(() => finish(prepare([[], [], []], 0)), timeout);
        });
    });
}
