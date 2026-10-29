import { nodeToIpv4 } from "../../../net/lan-network";
import { isExternalIpv4Node, validPort } from "../../../net/netplay-wire";
import { WSA, WsaFailure, WsaSocketTable, type WsaAddress } from "../../wsa-network";
import { decodeDirectPlay4TcpEnumReply, encodeDirectPlay4EnumSessionsRequest, type DirectPlay4DecodedEnumReply } from "./discovery";

export type NativeDiscoveryReply = DirectPlay4DecodedEnumReply & {peer: WsaAddress};

export interface NativeDiscoveryRequest {
    applicationGuid: Uint8Array;
    flags: number;
    destination: WsaAddress;
    /** Optional ordinary TCP enum; outbound-only connection reuse is unsupported. */
    tcpPort?: number;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Local resource limit, not native provider policy. */
    maxFrameBytes: number;
}

/**
 * Experimental unicast discovery building block. The supplied table owns real
 * relay TCP listener and UDP paths; native listener policy/capability is required.
 * Caller owns table, this operation owns all sockets it creates. This does not
 * implement the DirectPlay API or prove interoperability with native DirectPlay.
 */
export function discoverNativeSessions(table: WsaSocketTable, request: NativeDiscoveryRequest): Promise<NativeDiscoveryReply[]> {
    if (!(request.applicationGuid instanceof Uint8Array) || request.applicationGuid.length !== 16 ||
        !Number.isInteger(request.flags) || request.flags < 0 || request.flags > 0xffffffff ||
        (request.tcpPort !== undefined && !validPort(request.tcpPort)) ||
        !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30000 ||
        !Number.isInteger(request.maxFrameBytes) || request.maxFrameBytes < 112 || request.maxFrameBytes > 0xfffff ||
        request.destination.family !== 2 || !validPort(request.destination.port) ||
        !(request.destination.node instanceof Uint8Array) || !isExternalIpv4Node(request.destination.node) ||
        !(request.destination.ip instanceof Uint8Array) || request.destination.ip.length !== 4 ||
        !request.destination.ip.every((v, i) => v === request.destination.node[i + 2]))
        return Promise.reject(new RangeError("invalid native discovery request"));
    if (!table.network.winsock || !table.network.tcpHostListenV1 || !table.network.connected)
        return Promise.reject(new Error("native TCP listener unavailable"));
    if (request.signal?.aborted) return Promise.reject(new Error("discovery cancelled"));
    const {signal, flags, timeoutMs, maxFrameBytes, tcpPort} = request;
    const guid = request.applicationGuid.slice();
    const destination = {...request.destination, node: request.destination.node.slice(), ip: request.destination.ip.slice()};
    return new Promise((resolve, reject) => {
        let listener = 0, udp = 0, stream = 0, done = false, scheduled = false, sent = false;
        let streamStarted = false, streamDone = false, streamOffset = 0;
        let requestBytes: Uint8Array | undefined;
        const children = new Map<number, {buffer: Uint8Array; used: number; peer?: WsaAddress}>();
        const replies: NativeDiscoveryReply[] = [];
        let replyBytes = 0;
        const deadline = Date.now() + timeoutMs;
        let ready: ReturnType<WsaSocketTable["nativeListenerSnapshot"]>;
        const live = () => { try { return !!ready && table.nativeListenerCurrent(listener, ready.ownerToken); } catch { return false; } };
        let timer: ReturnType<typeof setTimeout>;
        const close = (id: number) => { try { if (id && table.isValid(id)) table.closesocket(id); } catch { /* actor revocation already owns cleanup */ } };
        let unsubscribe = () => {};
        const finish = (error?: unknown) => {
            if (done) return;
            done = true; unsubscribe(); signal?.removeEventListener("abort", abort); clearTimeout(timer);
            for (const id of children.keys()) close(id);
            children.clear(); close(stream); close(udp); close(listener);
            if (error !== undefined) reject(error); else resolve(replies);
        };
        const abort = () => finish(new Error("discovery cancelled"));
        const wake = () => {
            if (done || scheduled) return;
            scheduled = true;
            setTimeout(() => { scheduled = false; pump(); }, 0);
        };
        const blocked = (error: unknown) => error instanceof WsaFailure && error.code === WSA.EWOULDBLOCK;
        const pump = () => {
            if (done) return;
            if (Date.now() >= deadline) { sent && live() ? finish() : finish(new Error("native discovery timed out before send or listener retired")); return; }
            try {
                if (!ready) {
                    try { table.listen(listener, 8, true, 1); }
                    catch (error) { if (blocked(error)) return; throw error; }
                    ready = table.nativeListenerSnapshot(listener);
                    if (!ready || !live()) throw new Error("native listener READY was retired");
                }
                if (!live()) throw new Error("native listener retired");
                if (!sent) {
                    const sockaddr = new Uint8Array(16);
                    sockaddr[0] = 2; sockaddr[2] = ready.address.port >>> 8; sockaddr[3] = ready.address.port & 255;
                    sockaddr.set(nodeToIpv4(Uint8Array.from(ready.address.node)), 4);
                    requestBytes = encodeDirectPlay4EnumSessionsRequest(guid, sockaddr, flags);
                    if (!udp) udp = table.socket(2, 2, 17);
                    try { table.sendto(udp, requestBytes, destination); }
                    catch (error) { if (blocked(error)) return; throw error; }
                    if (!live() || signal?.aborted) throw new Error("native listener retired during send");
                    sent = true;
                }
                // NT5 dpsp.c:2083-2113 adds a background TCP request after
                // successful UDP unicast; its failure does not fail UDP search.
                // The peer replies to the advertised listener, not this socket.
                if (tcpPort && !streamDone) {
                    try {
                        if (!streamStarted) {
                            streamStarted = true;
                            stream = table.socket(1, 2, 6);
                            if (done) { close(stream); stream = 0; return; }
                            try { table.connect(stream, {...destination, port: tcpPort}); }
                            catch (error) { if (!blocked(error)) throw error; }
                        }
                        if (done) return;
                        if (table.isConnected(stream)) {
                            let writes = 0;
                            for (; writes < 4 && streamOffset < requestBytes!.length; writes++) {
                                if (done || Date.now() >= deadline || !live()) { wake(); return; }
                                let count: number;
                                try { count = table.send(stream, requestBytes!.subarray(streamOffset)); }
                                catch (error) { if (blocked(error)) break; throw error; }
                                if (done) return;
                                if (!Number.isInteger(count) || count <= 0 || count > requestBytes!.length - streamOffset)
                                    throw new Error("invalid native TCP enum send count");
                                streamOffset += count;
                            }
                            if (streamOffset === requestBytes!.length) { close(stream); stream = 0; streamDone = true; }
                            else if (writes === 4) wake();
                        } else if (table.get(stream).state === "failed") {
                            close(stream); stream = 0; streamDone = true;
                        }
                    } catch {
                        close(stream); stream = 0; streamDone = true;
                    }
                }
                let accepted = 0;
                for (; accepted < 8; accepted++) {
                    if (done || Date.now() >= deadline) { wake(); return; }
                    let child: number;
                    try { child = table.accept(listener); }
                    catch (error) { if (blocked(error)) break; throw error; }
                    if (children.size >= 8) { close(child); continue; }
                    children.set(child, {buffer: new Uint8Array(maxFrameBytes), used: 0});
                }
                if (accepted === 8) wake();
                for (const [child, state] of children) {
                    try {
                        let reads = 0;
                        for (; reads < 4; reads++) {
                            if (done || Date.now() >= deadline) { wake(); return; }
                            const remaining = maxFrameBytes - state.used;
                            if (!remaining) throw new Error("incomplete reply exceeds frame limit");
                            const packet = table.receive(child, Math.min(65536, remaining));
                            if (!packet.data.length) { close(child); children.delete(child); break; }
                            const peer = packet.from;
                            if (!peer || peer.family !== 2 || !(peer.node instanceof Uint8Array) ||
                                !isExternalIpv4Node(peer.node) || !(peer.ip instanceof Uint8Array) || peer.ip.length !== 4 ||
                                !peer.ip.every((v, i) => v === peer.node[i + 2]) || !validPort(peer.port))
                                throw new Error("invalid native reply peer");
                            if (!state.peer) state.peer = {family: 2, node: peer.node.slice(), ip: peer.ip.slice(), port: peer.port};
                            else if (state.peer.port !== peer.port || !state.peer.node.every((v, i) => v === peer.node[i]))
                                throw new Error("native reply peer changed");
                            state.buffer.set(packet.data, state.used);
                            state.used += packet.data.length;
                            const reply = decodeDirectPlay4TcpEnumReply(state.buffer.subarray(0, state.used), maxFrameBytes);
                            if (reply) {
                                if (!live() || signal?.aborted) throw new Error("listener retired");
                                if (replies.length < 128 && replyBytes + reply.consumed <= maxFrameBytes * 8) {
                                    replies.push({...reply, peer: state.peer}); replyBytes += reply.consumed;
                                }
                                close(child); children.delete(child); break;
                            }
                        }
                        if (reads === 4) wake();
                    } catch (error) {
                        if (!blocked(error)) { close(child); children.delete(child); }
                    }
                }
            } catch (error) { finish(error); }
        };
        try {
            listener = table.socket(1, 2, 6);
            table.bind(listener);
            unsubscribe = table.subscribe(wake);
            signal?.addEventListener("abort", abort, {once: true});
            timer = setTimeout(() => sent && live() ? finish() : finish(new Error("native discovery timed out before send or listener retired")), timeoutMs);
            if (signal?.aborted) abort(); else pump();
        } catch (error) { finish(error); }
    });
}
