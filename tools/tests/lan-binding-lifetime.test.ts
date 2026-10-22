import { beforeAll, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { createLanServer } from "../../packages/lan/src/server";
import { buildNativeForTests, nativeTestHelper } from "../../packages/lan/native/testing";
import { decodeDatagram, encodeDatagram, ipv4ToNode, PROTO_UDP, PROTO_TCP } from "../../packages/lan/src/protocol";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { encodeTcpFrame, RST } from "../../packages/lan/src/tcp-protocol";
import { RelayLink } from "../../src/worker/net/relay-link";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address } from "../../src/worker/modules/wsa-network";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!await check()) { if (Date.now() >= deadline) throw Error("Timeout: " + label); await pause(5); }
}
async function send(operation: () => number): Promise<number> {
    let count = 0;
    await until(() => {
        try { count = operation(); return true; }
        catch (error) { if (error instanceof WsaFailure && error.code === WSA.EWOULDBLOCK) return false; throw error; }
    }, "writable");
    return count;
}
async function portFree(port: number): Promise<boolean> {
    const socket = createSocket("udp4");
    return new Promise(resolve => {
        socket.once("error", () => { socket.close(); resolve(false); });
        // Wildcard binding conflicts with every existing local-address binding.
        // A second specific-address bind can succeed on Windows while the
        // connected UDP socket is still alive, so it is not a close oracle.
        socket.bind(port, "0.0.0.0", () => socket.close(() => resolve(true)));
    });
}
beforeAll(buildNativeForTests);

for (const transport of ["websocket", "polling"] as const) {
    test("legacy unbound datagrams and reliable control frames omit optional metadata over " + transport, async () => {
        const native = createSocket("udp4");
        native.on("message", (bytes, peer) => native.send(bytes, peer.port, peer.address));
        await new Promise<void>(resolve => native.bind(0, "127.0.0.1", resolve));
        const remotePort = native.address().port, ip = Uint8Array.of(203, 0, 113, 119), localPort = 47119;
        const server = createLanServer({ port: 0, gateway: { routes: [
            { host: "127.0.0.1", address: ip.join("."), ports: [remotePort], protocols: ["udp", "tcp"] },
        ] } });
        const port = await server.listen(), net = new LanNetwork();
        const link = new RelayLink("http://127.0.0.1:" + port, "binding-legacy", net, { transports: [transport] });
        net.attach(link);
        const replies: number[] = [], generations: unknown[] = [];
        link.socket.on("frame", (input, generation) => {
            const packet = decodeDatagram(input);
            if (packet?.proto === PROTO_UDP) { replies.push(packet.payload[0]); generations.push(generation); }
        });
        try {
            await link.ready;
            const node = net.routeIpv4(ip);
            expect(net.bindingGeneration(localPort, PROTO_UDP)).toBe(0);
            await send(() => { if (!net.send(localPort, node, remotePort, Uint8Array.of(1), PROTO_UDP)) throw new WsaFailure(WSA.EWOULDBLOCK); return 1; });
            await until(() => replies.length === 1, "legacy native reply");
            expect(net.send(localPort, node, remotePort, encodeTcpFrame(RST, 1, 0, 10054), PROTO_TCP)).toBe(true);
            await send(() => { if (!net.send(localPort, node, remotePort, Uint8Array.of(2), PROTO_UDP)) throw new WsaFailure(WSA.EWOULDBLOCK); return 1; });
            await until(() => replies.length === 2, "reliable legacy control did not disconnect");
            expect(replies).toEqual([1, 2]); expect(generations).toEqual([undefined, undefined]);
            expect(link.connected).toBe(true);
        } finally { net.attach(null); await server.close(); await new Promise<void>(resolve => native.close(() => resolve())); }
    }, 15000);
    test("native UDP binding generations release the OS port and reject stale frames/errors over " + transport, async () => {
        const native = createSocket("udp4"), seen: { byte: number; port: number }[] = [];
        native.on("message", (data, peer) => {
            seen.push({ byte: data[0], port: peer.port });
            native.send(data, peer.port, peer.address);
        });
        await new Promise<void>(resolve => native.bind(0, "127.0.0.1", resolve));
        const remotePort = native.address().port, ip = Uint8Array.of(203, 0, 113, 120), guestPort = 47120;
        const server = createLanServer({ port: 0, gateway: { routes: [
            { host: "127.0.0.1", address: ip.join("."), names: ["binding.game.test"], ports: [remotePort], protocols: ["udp"] },
        ] } });
        const relayPort = await server.listen(), net = new LanNetwork();
        const link = new RelayLink("http://127.0.0.1:" + relayPort, "binding-lifetime", net, { transports: [transport] });
        net.attach(link); const table = new WsaSocketTable(net), target = ipv4Address(ip, remotePort);
        try {
            await link.ready;
            let socket = table.socket(2); table.bind(socket, ipv4Address(new Uint8Array(4), guestPort));
            const oldGeneration = net.bindingGeneration(guestPort, PROTO_UDP);
            await send(() => table.send(socket, Uint8Array.of(1), target));
            await until(() => table.readable(socket), "first native echo");
            expect(table.receive(socket, 1).data).toEqual(Uint8Array.of(1));
            const oldNativePort = seen[0].port;
            expect(await portFree(oldNativePort)).toBe(false);
            table.closesocket(socket);
            await until(() => portFree(oldNativePort), "close releases actual UDP port without participant disconnect");

            socket = table.socket(2); table.bind(socket, ipv4Address(new Uint8Array(4), guestPort));
            const generation = net.bindingGeneration(guestPort, PROTO_UDP);
            expect(generation).toBeGreaterThan(oldGeneration);
            await send(() => table.send(socket, Uint8Array.of(2), target));
            await until(() => table.readable(socket), "rebound native echo");
            expect(table.receive(socket, 1).data).toEqual(Uint8Array.of(2));
            const nativePort = seen[1].port;

            const recipient = [...server.io.sockets.sockets.values()][0], node = ipv4ToNode(ip, true);
            recipient.emit("frame", encodeDatagram(PROTO_UDP, node, guestPort, remotePort, Uint8Array.of(98)), oldGeneration);
            recipient.emit("socketError", { node: [...node], localPort: guestPort, remotePort, proto: PROTO_UDP, code: 10054, bindingGeneration: oldGeneration });
            link.socket.emit("releasePort", PROTO_UDP, guestPort, oldGeneration);
            link.socket.emit("frame", encodeDatagram(PROTO_UDP, node, remotePort, guestPort, Uint8Array.of(99)), oldGeneration);
            await net.resolve("binding.game.test", 4);
            expect(table.readable(socket)).toBe(false);
            expect(table.get(socket).error).toBe(0);
            expect(await portFree(nativePort)).toBe(false);

            await send(() => table.send(socket, Uint8Array.of(3), target));
            await until(() => table.readable(socket), "late old release leaves new native resource intact");
            expect(table.receive(socket, 1).data).toEqual(Uint8Array.of(3));
            expect(seen.map(item => item.byte)).toEqual([1, 2, 3]);
            expect(seen[2].port).toBe(nativePort);
            table.closesocket(socket);
            await until(() => portFree(nativePort), "second native port released");
            expect(link.connected).toBe(true);
        } finally { table.reset(); net.attach(null); await server.close(); await new Promise<void>(resolve => native.close(() => resolve())); }
    }, 20000);

    test("same guest node and binding generation in different rooms own independent native resources over " + transport, async () => {
        const native = createSocket("udp4"), ports = new Map<number, number>();
        native.on("message", (data, peer) => { ports.set(data[0], peer.port); native.send(data, peer.port, peer.address); });
        await new Promise<void>(resolve => native.bind(0, "127.0.0.1", resolve));
        const remotePort = native.address().port, ip = Uint8Array.of(203, 0, 113, 121), localPort = 47121;
        const server = createLanServer({ port: 0, gateway: { routes: [{ host: "127.0.0.1", address: ip.join("."), ports: [remotePort], protocols: ["udp"] }] } });
        const port = await server.listen(), node = Uint8Array.of(2, 0, 0, 7, 1, 21);
        const networks = [new LanNetwork(node), new LanNetwork(node)];
        const links = networks.map((net, index) => {
            const link = new RelayLink("http://127.0.0.1:" + port, "binding-room-" + index, net, { transports: [transport] });
            net.attach(link); return link;
        });
        const tables = networks.map(net => new WsaSocketTable(net)), sockets = tables.map(table => {
            const socket = table.socket(2); table.bind(socket, ipv4Address(new Uint8Array(4), localPort)); return socket;
        });
        try {
            await Promise.all(links.map(link => link.ready));
            for (let i = 0; i < 2; i++) {
                await send(() => tables[i].send(sockets[i], Uint8Array.of(i + 1), ipv4Address(ip, remotePort)));
                await until(() => tables[i].readable(sockets[i]), "room native echo");
                expect(tables[i].receive(sockets[i], 1).data).toEqual(Uint8Array.of(i + 1));
            }
            expect(ports.get(1)).not.toBe(ports.get(2));
            tables[0].closesocket(sockets[0]);
            await until(() => portFree(ports.get(1)!), "room one resource released");
            expect(await portFree(ports.get(2)!)).toBe(false);
            await send(() => tables[1].send(sockets[1], Uint8Array.of(3), ipv4Address(ip, remotePort)));
            await until(() => tables[1].readable(sockets[1]), "other room still connected");
            expect(tables[1].receive(sockets[1], 1).data).toEqual(Uint8Array.of(3));
            expect(ports.get(3)).toBe(ports.get(2));
        } finally {
            tables.forEach(table => table.reset()); networks.forEach(net => net.attach(null)); await server.close();
            await new Promise<void>(resolve => native.close(() => resolve()));
        }
    }, 20000);

    for (const helper of [false, true]) test("DATA/FIN/close preserves the complete native prefix while immediately rebinding TCP, helper=" + helper + ", " + transport, async () => {
        const active = new Set<Socket>(), completed: Uint8Array[] = [], errors: string[] = [];
        const native = createServer({ allowHalfOpen: true }, socket => {
            active.add(socket); socket.pause();
            const resume = setTimeout(() => socket.resume(), 100), chunks: Buffer[] = [];
            socket.on("data", bytes => chunks.push(Buffer.from(bytes)));
            socket.on("end", () => { completed.push(Buffer.concat(chunks)); socket.end(); });
            socket.on("error", error => errors.push(error.message));
            socket.on("close", () => { clearTimeout(resume); active.delete(socket); });
        });
        await new Promise<void>(resolve => native.listen(0, "127.0.0.1", resolve));
        const remotePort = (native.address() as { port: number }).port, ip = Uint8Array.of(203, 0, 113, 122), localPort = 47122;
        const server = createLanServer({ port: 0, gateway: { ...(helper ? { nativeHelperPath: nativeTestHelper } : {}),
            routes: [{ host: "127.0.0.1", address: ip.join("."), ports: [remotePort], protocols: ["tcp"] }] } });
        const port = await server.listen(), net = new LanNetwork();
        const link = new RelayLink("http://127.0.0.1:" + port, "binding-tcp", net, { transports: [transport] });
        net.attach(link); const table = new WsaSocketTable(net);
        async function connect() {
            const socket = table.socket(); table.bind(socket, ipv4Address(new Uint8Array(4), localPort));
            try { table.connect(socket, ipv4Address(ip, remotePort)); }
            catch (error) { if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK) throw error; }
            await until(() => table.isConnected(socket) || table.exceptional(socket), "native TCP connect");
            expect(table.get(socket).error).toBe(0); expect(table.isConnected(socket)).toBe(true);
            return socket;
        }
        try {
            await link.ready;
            const first = await connect(), oldGeneration = net.bindingGeneration(localPort, PROTO_TCP);
            const prefix = Uint8Array.from({ length: 240000 }, (_, index) => index % 251);
            let written = 0;
            while (written < prefix.length) written += await send(() => table.send(first, prefix.subarray(written)));
            table.shutdown(first, 1); table.closesocket(first);
            const second = await connect();
            expect(net.bindingGeneration(localPort, PROTO_TCP)).toBeGreaterThan(oldGeneration);
            link.socket.emit("releasePort", PROTO_TCP, localPort, oldGeneration);
            const marker = Uint8Array.of(77, 88, 99);
            expect(await send(() => table.send(second, marker))).toBe(marker.length);
            table.shutdown(second, 1); table.closesocket(second);
            await until(() => completed.length === 2 && active.size === 0, "native full prefix and EOF on both connections");
            expect(errors).toEqual([]);
            expect(completed.find(bytes => bytes.length === prefix.length)).toEqual(prefix);
            expect(completed.find(bytes => bytes.length === marker.length)).toEqual(marker);
            expect(link.connected).toBe(true);
        } finally {
            table.reset(); net.attach(null); await server.close(); for (const socket of active) socket.destroy();
            await new Promise<void>(resolve => native.close(() => resolve()));
        }
    }, 20000);
}
