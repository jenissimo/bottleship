import { expect, test } from "bun:test";
import { createLanServer } from "../../packages/lan/src/server";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address } from "../../src/worker/modules/wsa-network";
import { DirectPlaySession, DP, type SessionDesc } from "../../src/worker/modules/dplayx/session";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out: " + description);
        await pause(5);
    }
}
function failure(operation: () => unknown, code: number): void {
    try { operation(); throw new Error("Expected Winsock failure " + code); }
    catch (error) {
        expect(error).toBeInstanceOf(WsaFailure);
        expect((error as WsaFailure).code).toBe(code);
    }
}
async function sendWhenWritable(operation: () => number): Promise<number> {
    let result = 0;
    await until(() => {
        try { result = operation(); return true; }
        catch (error) {
            if (error instanceof WsaFailure && error.code === WSA.EWOULDBLOCK) return false;
            throw error;
        }
    }, "socket writable");
    return result;
}
const desc: SessionDesc = {
    instance: "0".repeat(32), application: "a".repeat(32), flags: 0,
    maxPlayers: 8, name: "Polling composition match", password: "", user: [0, 0, 0, 0],
};

test("Winsock UDP/IPX/TCP and DirectPlay compose through a real polling relay, including peer failure", async () => {
    const server = createLanServer({ port: 0, transports: ["polling"] });
    const port = await server.listen(), url = "http://127.0.0.1:" + port;
    const na = new LanNetwork(Uint8Array.of(2, 0, 0, 3, 0, 1));
    const nb = new LanNetwork(Uint8Array.of(2, 0, 0, 3, 0, 2));
    const la = new RelayLink(url, "composition", na, { transports: ["polling"] });
    const lb = new RelayLink(url, "composition", nb, { transports: ["polling"] });
    na.attach(la); nb.attach(lb);
    const a = new WsaSocketTable(na), b = new WsaSocketTable(nb);
    const host = new DirectPlaySession(nb, 5000), client = new DirectPlaySession(na, 5000);
    try {
        await Promise.all([la.ready, lb.ready]);
        expect(la.socket.io.engine.transport.name).toBe("polling");
        expect(lb.socket.io.engine.transport.name).toBe("polling");

        const udpSender = a.socket(2), udpReceiver = b.socket(2);
        b.bind(udpReceiver, ipv4Address(nb.ipv4, 7000));
        expect(await sendWhenWritable(() => a.send(udpSender, Uint8Array.of(0, 8, 255), ipv4Address(nb.ipv4, 7000)))).toBe(3);
        await until(() => b.readable(udpReceiver), "UDP delivery");
        const datagram = b.receive(udpReceiver, 20);
        expect(Array.from(datagram.data)).toEqual([0, 8, 255]);
        expect(datagram.from.ip).toEqual(na.ipv4);
        expect(datagram.from.port).toBe(a.get(udpSender).local!.port);
        await sendWhenWritable(() => a.send(udpSender, new Uint8Array(), ipv4Address(nb.ipv4, 7000)));
        await until(() => b.readable(udpReceiver), "empty UDP delivery");
        expect(b.receive(udpReceiver, 20).data.length).toBe(0);

        const ipxSender = a.socket(2, 6, 1034), ipxReceiver = b.socket(2, 6, 1000);
        b.bind(ipxReceiver, { family: 6, node: nb.node, port: 7000 });
        b.get(ipxReceiver).filterPacketType = 34;
        const ipxPayload = new Uint8Array(546).fill(77);
        expect(await sendWhenWritable(() => a.send(ipxSender, ipxPayload, { family: 6, node: nb.node, port: 7000 }))).toBe(546);
        await until(() => b.readable(ipxReceiver), "typed maximum IPX delivery");
        expect(b.receive(ipxReceiver, 1000).data).toEqual(ipxPayload);
        expect(b.readable(udpReceiver)).toBe(false);

        const listener = b.socket(), tcpClient = a.socket();
        b.bind(listener, ipv4Address(nb.ipv4, 23456));
        b.listen(listener);
        failure(() => a.connect(tcpClient, ipv4Address(nb.ipv4, 23456)), WSA.EWOULDBLOCK);
        await until(() => a.isConnected(tcpClient) && b.readable(listener), "TCP handshake");
        const tcpServer = b.accept(listener);
        expect(b.isConnected(tcpServer)).toBe(true);
        expect(a.send(tcpClient, Uint8Array.of(1, 2, 3))).toBe(3);
        expect(a.send(tcpClient, Uint8Array.of(4, 5))).toBe(2);
        await until(() => b.bytesAvailable(tcpServer) === 5, "TCP stream data");
        expect(Array.from(b.receive(tcpServer, 4).data)).toEqual([1, 2, 3, 4]);
        expect(a.shutdown(tcpClient, 1)).toBe(0);
        expect(Array.from(b.receive(tcpServer, 4).data)).toEqual([5]);
        await until(() => b.get(tcpServer).eof, "TCP FIN");
        expect(b.receive(tcpServer, 4).data.length).toBe(0);
        expect(b.send(tcpServer, Uint8Array.of(9))).toBe(1);
        await until(() => a.bytesAvailable(tcpClient) === 1, "TCP half-close reverse data");
        expect(Array.from(a.receive(tcpClient, 4).data)).toEqual([9]);
        failure(() => a.send(tcpClient, Uint8Array.of(1)), WSA.ESHUTDOWN);

        expect(host.initialize()).toBe(DP.OK);
        expect(client.initialize()).toBe(DP.OK);
        expect(host.create(desc)).toBe(DP.OK);
        const hostPlayer = await host.mutate({ op: "mutate", action: "create", group: false, parent: 0,
            flags: 0, name: { short: "host", long: "" }, data: [] });
        expect(hostPlayer.hr).toBe(DP.OK);
        expect(client.discover(desc.application)).toBe(DP.OK);
        await until(() => client.discovered.has(host.desc!.instance), "DirectPlay discovery");
        expect(await client.join(host.desc!)).toBe(DP.OK);
        const clientPlayer = await client.mutate({ op: "mutate", action: "create", group: false, parent: 0,
            flags: 0, name: { short: "client", long: "" }, data: [] });
        expect(clientPlayer.hr).toBe(DP.OK);
        await until(() => host.entities.size === 2 && client.entities.size === 2, "DirectPlay player replication");
        while (host.queue.length) host.removeMessage(0);
        while (client.queue.length) client.removeMessage(0);
        const message = new Uint8Array(60000);
        message[0] = 31; message[message.length - 1] = 73;
        expect(await client.send(clientPlayer.id!, hostPlayer.id!, 1, message)).toBe(DP.OK);
        await until(() => host.queue.some(item => !item.system), "fragmented DirectPlay message");
        const delivered = host.queue.find(item => !item.system)!;
        expect(delivered.from).toBe(clientPlayer.id!);
        expect(delivered.to).toBe(hostPlayer.id!);
        expect(delivered.data).toEqual(message);

        nb.attach(null);
        await until(() => a.exceptional(tcpClient), "TCP peer disconnect notification");
        failure(() => a.receive(tcpClient, 8), WSA.ECONNRESET);
        await until(() => client.lost, "DirectPlay host loss notification");
        expect(client.readyError).toBe(DP.SESSIONLOST);
        expect(client.queue.some(item => item.system?.type === 0x31)).toBe(true);
        expect(na.connected).toBe(true);
    } finally {
        host.dispose(); client.dispose(); a.reset(); b.reset();
        na.attach(null); nb.attach(null);
        await server.close();
    }
}, 30_000);
