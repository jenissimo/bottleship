import { expect, test } from "bun:test";
import { createServer, type Socket as NativeSocket } from "node:net";
import { createSocket } from "node:dgram";
import { createLanServer } from "../../packages/lan/src/server";
import { LanNetwork, NetResolveError } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { parseIpv6 } from "../../packages/lan/src/ip-address";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, ipv6Address } from "../../src/worker/modules/wsa-network";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Timed out: " + description); await pause(5); }
}
function code(operation: () => unknown): number {
    try { operation(); return 0; } catch (error) { if (error instanceof WsaFailure) return error.code; throw error; }
}
async function send(operation: () => number): Promise<number> {
    let count = 0;
    await until(() => {
        try { count = operation(); return true; }
        catch (error) { if (error instanceof WsaFailure && error.code === WSA.EWOULDBLOCK) return false; throw error; }
    }, "gateway socket writable");
    return count;
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try { await promise; throw new Error("Expected resolver failure"); } catch (error) { return error; }
}
for (const transport of ["websocket", "polling"] as const) test("native UDP/TCP gateway, scoped DNS and failure semantics over " + transport, async () => {
    const nativeSockets = new Set<NativeSocket>();
    const nativeTcp = createServer({ allowHalfOpen: true }, socket => {
        nativeSockets.add(socket);
        socket.on("data", data => socket.write(data));
        socket.on("end", () => socket.end());
        socket.on("error", () => {});
        socket.on("close", () => nativeSockets.delete(socket));
    });
    await new Promise<void>(resolve => nativeTcp.listen(0, "127.0.0.1", resolve));
    const tcpPort = (nativeTcp.address() as { port: number }).port;
    const nativeUdp = createSocket("udp4");
    nativeUdp.on("message", (data, peer) => nativeUdp.send(data, peer.port, peer.address));
    await new Promise<void>(resolve => nativeUdp.bind(0, "127.0.0.1", resolve));
    const udpPort = nativeUdp.address().port;
    const unused = createServer();
    await new Promise<void>(resolve => unused.listen(0, "127.0.0.1", resolve));
    const refusedPort = (unused.address() as { port: number }).port;
    await new Promise<void>(resolve => unused.close(() => resolve()));
    const udpIp = Uint8Array.of(203, 0, 113, 10), tcpIp = Uint8Array.of(203, 0, 113, 11), refusedIp = Uint8Array.of(203, 0, 113, 13);
    const server = createLanServer({ port: 0, gateway: { routes: [
        { host: "127.0.0.1", address: udpIp.join("."), names: ["udp.game.test"], ports: [udpPort], protocols: ["udp"] },
        { host: "127.0.0.1", address: tcpIp.join("."), names: ["tcp.game.test"], ports: [tcpPort], protocols: ["tcp"] },
        { host: "127.0.0.1", address: refusedIp.join("."), names: ["refused.game.test"], ports: [refusedPort], protocols: ["tcp"] },
        { host: "localhost", names: ["native-loopback.test"], ports: [tcpPort], protocols: ["tcp"] },
    ] } });
    const port = await server.listen();
    const net = new LanNetwork(Uint8Array.of(2, 0, 0, 7, 0, 1));
    const link = new RelayLink("http://127.0.0.1:" + port, "gateway", net, { transports: [transport] });
    net.attach(link);
    const table = new WsaSocketTable(net);
    try {
        await link.ready;
        const dns = await net.resolve("tcp.game.test", 4);
        expect(dns.canonicalName).toBe("tcp.game.test");
        expect(dns.addresses).toEqual([{ address: "203.0.113.11", family: 4 }]);
        const localhost = await net.resolve("native-loopback.test", 4);
        expect(localhost.addresses.some(address => address.address === "127.0.0.1")).toBe(true);
        expect(await rejection(net.resolve("unconfigured.game.test", 4))).toMatchObject({ code: "ACCESS_DENIED" });
        expect(await rejection(net.resolve("tcp.game.test", 6))).toMatchObject({ code: "NO_DATA" });
        const abort = new AbortController();
        const cancelled = net.resolve("tcp.game.test", 4, abort.signal);
        abort.abort();
        expect(await rejection(cancelled)).toMatchObject({ code: "CANCELLED" });

        const udp = table.socket(2);
        const payload = Uint8Array.of(0, 255, 33);
        expect(await send(() => table.send(udp, payload, ipv4Address(udpIp, udpPort)))).toBe(3);
        await until(() => table.readable(udp), "native UDP echo");
        const reply = table.receive(udp, 100);
        expect(reply.data).toEqual(payload);
        expect(reply.from.ip).toEqual(udpIp);
        expect(reply.from.port).toBe(udpPort);
        await send(() => table.send(udp, new Uint8Array(), ipv4Address(udpIp, udpPort)));
        await until(() => table.readable(udp), "native zero-byte UDP echo");
        expect(table.receive(udp, 100).data.length).toBe(0);

        const mapped = new Uint8Array(16); mapped[10] = mapped[11] = 255; mapped.set(udpIp, 12);
        const mappedUdp = table.socket(2, 23);
        table.setV6Only(mappedUdp, false); // Explicit dual mode; modern AF23 defaults to IPv6-only.
        expect(await send(() => table.send(mappedUdp, payload, ipv6Address(mapped, udpPort)))).toBe(payload.length);
        await until(() => table.readable(mappedUdp), "IPv4-mapped IPv6 native UDP");
        const mappedReply = table.receive(mappedUdp, 100);
        expect(mappedReply.data).toEqual(payload);
        expect(mappedReply.from.ip6).toEqual(mapped);

        const tcp = table.socket();
        expect(code(() => table.connect(tcp, ipv4Address(tcpIp, tcpPort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.isConnected(tcp) || table.exceptional(tcp), "native TCP handshake");
        expect(table.isConnected(tcp)).toBe(true);
        const stream = new Uint8Array(400_000);
        for (let i = 0; i < stream.length; i++) stream[i] = i % 251;
        const received = new Uint8Array(stream.length);
        let written = 0, read = 0;
        const deadline = Date.now() + 8000;
        while (read < stream.length) {
            if (Date.now() > deadline) throw new Error("Native TCP stream stalled");
            if (written < stream.length) {
                try { written += table.send(tcp, stream.subarray(written)); }
                catch (error) { if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK) throw error; }
            }
            while (table.bytesAvailable(tcp)) {
                const chunk = table.receive(tcp, 7777).data;
                received.set(chunk, read); read += chunk.length;
            }
            await pause(1);
        }
        expect(written).toBe(stream.length);
        expect(received).toEqual(stream);
        table.shutdown(tcp, 1);
        await until(() => table.get(tcp).eof, "native FIN/EOF");
        expect(table.receive(tcp, 10).data.length).toBe(0);

        mapped.set(tcpIp, 12);
        const mappedTcp = table.socket(1, 23);
        table.setV6Only(mappedTcp, false);
        expect(code(() => table.connect(mappedTcp, ipv6Address(mapped, tcpPort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.isConnected(mappedTcp), "IPv4-mapped IPv6 native TCP");
        expect(await send(() => table.send(mappedTcp, payload))).toBe(payload.length);
        await until(() => table.bytesAvailable(mappedTcp) === payload.length, "IPv4-mapped IPv6 native TCP echo");
        expect(table.receive(mappedTcp, 100).data).toEqual(payload);
        table.shutdown(mappedTcp, 1);
        await until(() => table.get(mappedTcp).eof, "IPv4-mapped IPv6 native EOF");

        const denied = table.socket();
        expect(code(() => table.connect(denied, ipv4Address(Uint8Array.of(203, 0, 113, 99), tcpPort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.exceptional(denied), "unconfigured TCP route rejection");
        expect(code(() => table.receive(denied, 1))).toBe(WSA.EACCES);
        const refused = table.socket();
        expect(code(() => table.connect(refused, ipv4Address(refusedIp, refusedPort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.exceptional(refused), "native connection refusal");
        expect(code(() => table.receive(refused, 1))).toBe(WSA.ECONNREFUSED);

        const live = table.socket();
        expect(code(() => table.connect(live, ipv4Address(tcpIp, tcpPort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.isConnected(live), "live native connection");
        const pendingDns = net.resolve("tcp.game.test", 4);
        net.attach(null);
        expect(await rejection(pendingDns)).toBeInstanceOf(NetResolveError);
        await until(() => nativeSockets.size === 0, "disconnect closes native gateway sockets");
    } finally {
        table.reset(); net.attach(null); await server.close();
        for (const socket of nativeSockets) socket.destroy();
        await new Promise<void>(resolve => nativeTcp.close(() => resolve()));
        await new Promise<void>(resolve => nativeUdp.close(() => resolve()));
    }
}, 30_000);

for (const transport of ["websocket", "polling"] as const) test("native IPv6 UDP/TCP gateway and AAAA token mapping over " + transport, async () => {
    const nativeSockets = new Set<NativeSocket>();
    const nativeTcp = createServer({ allowHalfOpen: true }, socket => {
        nativeSockets.add(socket);
        socket.on("data", data => socket.write(data));
        socket.on("end", () => socket.end());
        socket.on("error", () => {});
        socket.on("close", () => nativeSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => { nativeTcp.once("error", reject); nativeTcp.listen(0, "::1", resolve); });
    const tcpPort = (nativeTcp.address() as { port: number }).port;
    const nativeUdp = createSocket("udp6");
    nativeUdp.on("message", (data, peer) => nativeUdp.send(data, peer.port, peer.address));
    await new Promise<void>((resolve, reject) => { nativeUdp.once("error", reject); nativeUdp.bind(0, "::1", resolve); });
    const udpPort = nativeUdp.address().port;
    const udpIp = parseIpv6("2001:db8::10")!, tcpIp = parseIpv6("2001:db8::11")!;
    const server = createLanServer({ port: 0, gateway: { routes: [
        { host: "::1", address: "2001:db8::10", names: ["udp6.game.test"], ports: [udpPort], protocols: ["udp"] },
        { host: "::1", address: "2001:db8::11", names: ["tcp6.game.test"], ports: [tcpPort], protocols: ["tcp"] },
    ] } });
    const port = await server.listen();
    const net = new LanNetwork(Uint8Array.of(2, 0, 0, 7, 0, 6));
    const link = new RelayLink("http://127.0.0.1:" + port, "gateway6", net, { transports: [transport] });
    net.attach(link);
    const table = new WsaSocketTable(net);
    try {
        await link.ready;
        // Numeric destinations must work from the ready snapshot, before any DNS request.
        expect(net.routeIpv6(udpIp).slice(0, 2)).toEqual(Uint8Array.of(2, 2));
        expect(net.nodeToIpv6(net.routeIpv6(udpIp))).toEqual(udpIp);
        const dns = await net.resolve("tcp6.game.test", 6);
        expect(dns.addresses).toEqual([{ address: "2001:db8::11", family: 6, node: [...net.routeIpv6(tcpIp)] }]);
        expect(await rejection(net.resolve("tcp6.game.test", 4))).toMatchObject({ code: "NO_DATA" });

        const udp = table.socket(2, 23);
        const bytes = new Uint8Array(65527);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
        expect(await send(() => table.send(udp, bytes, ipv6Address(udpIp, udpPort)))).toBe(bytes.length);
        await until(() => table.readable(udp), "native IPv6 maximum UDP echo");
        const reply = table.receive(udp, 65535);
        expect(reply.data).toEqual(bytes);
        expect(reply.from.ip6).toEqual(udpIp);
        expect(reply.from.port).toBe(udpPort);
        expect(code(() => table.send(udp, new Uint8Array(65528), ipv6Address(udpIp, udpPort)))).toBe(WSA.EMSGSIZE);
        expect(code(() => table.send(udp, Uint8Array.of(1), ipv6Address(parseIpv6("2001:db8::dead")!, udpPort)))).toBe(WSA.EACCES);

        const tcp = table.socket(1, 23);
        expect(code(() => table.connect(tcp, ipv6Address(tcpIp, tcpPort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.isConnected(tcp) || table.exceptional(tcp), "native IPv6 TCP handshake");
        expect(table.isConnected(tcp)).toBe(true);
        const stream = Uint8Array.from({ length: 60000 }, (_, i) => i % 253);
        const received = new Uint8Array(stream.length);
        let written = 0, read = 0;
        await until(() => {
            if (written < stream.length) {
                try { written += table.send(tcp, stream.subarray(written)); }
                catch (error) { if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK) throw error; }
            }
            while (table.bytesAvailable(tcp)) { const chunk = table.receive(tcp, 4093).data; received.set(chunk, read); read += chunk.length; }
            return read === stream.length;
        }, "native IPv6 TCP stream");
        expect(written).toBe(stream.length);
        expect(received).toEqual(stream);
        table.shutdown(tcp, 1);
        await until(() => table.get(tcp).eof, "native IPv6 FIN/EOF");
        expect(table.receive(tcp, 1).data.length).toBe(0);
    } finally {
        table.reset(); net.attach(null); await server.close();
        for (const socket of nativeSockets) socket.destroy();
        await new Promise<void>(resolve => nativeTcp.close(() => resolve()));
        await new Promise<void>(resolve => nativeUdp.close(() => resolve()));
    }
}, 30_000);
