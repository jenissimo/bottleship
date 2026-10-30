/**
 * dp8-wire-host — a DP8 native-wire host oracle for lan-diff mixed runs.
 *
 * Hosts a session on a real UDP socket (default 127.0.0.1:23913) speaking the
 * native DNET wire protocol via NativeDirectPlayHost, so an EMULATED role can
 * connect to it through the relay gateway exactly as it would to a native
 * Windows host. The driver publishes readiness by writing a coordinator file;
 * the gateway route address is what clients must be told to dial.
 *
 *   bun dp8-wire-host.ts --port 23913 --ready <coord>/wire-host.ready
 */
import { createSocket, type Socket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LanNetwork } from "../../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../../src/worker/net/netplay-wire";
import { NativeDirectPlayHost } from "../../../src/worker/modules/dpnet/native-wire/host";

const cli = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!["--port", "--ready"].includes(name) || !value) throw new Error(`usage: dp8-wire-host.ts --port <n> --ready <file>`);
    cli.set(name, value);
}
const port = Number(cli.get("--port"));
const readyFile = resolve(cli.get("--ready")!);
if (!Number.isInteger(port) || port <= 0) throw new Error("bad --port");

// Announce the address clients must dial: the gateway route address (this
// machine's LAN IP), not the socket's own 127.0.0.1 binding.
const gatewayIp = (process.env.BS_WIRE_HOST_IP ?? "").trim() || "127.0.0.1";
const octets = gatewayIp.split(".").map(Number);
if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`bad BS_WIRE_HOST_IP "${gatewayIp}"`);

const node = Uint8Array.of(2, 0, 0, octets[0], octets[1], octets[2]);
const network = new LanNetwork(node);
const host = new NativeDirectPlayHost(network);
const socket: Socket = createSocket("udp4");

const errors: string[] = [];
socket.on("error", error => errors.push(String(error)));
socket.on("message", (data, source) => {
    if (source.address !== "127.0.0.1") return; // carrier is loopback; the gateway owns external reach
    // Feed the datagram into the host session as if it arrived on this network.
    network.receiveFrame(encodeDatagram(PROTO_UDP, node, port, source.port, data), true);
});
network.attach({
    routeLocal: true,
    send(frame) {
        const dg = decodeDatagram(frame);
        if (!dg || dg.proto !== PROTO_UDP || dg.srcPort !== port) return false;
        socket.send(dg.payload, dg.dstPort, "127.0.0.1", error => { if (error) errors.push(String(error)); });
        return true;
    },
    close() {},
});

socket.bind(port, "127.0.0.1", () => {
    const hr = host.start({
        port,
        application: { instance: "0".repeat(32), application: "5102dacf241b11d3aea7006097b01411", flags: 0, maxPlayers: 0, name: "session", password: "", user: [0, 0, 0, 0] },
        player: { name: "host", data: new Uint8Array(0) },
        url: a => `x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=${gatewayIp};port=${a.port}`,
        allowIncoming: () => true,
        admit: () => ({ hr: 0, data: new Uint8Array(0) }),
        timeout: 1000,
        retryInterval: 20,
    });
    if (hr !== 0) throw new Error(`wire host start failed: ${hr}`);
    writeFileSync(readyFile, `${gatewayIp}:${port}\n`);
    console.log(`[wire-host] ready on 127.0.0.1:${port} (advertised ${gatewayIp}:${port})`);
});
setInterval(() => { if (errors.length) { console.error(`[wire-host] errors: ${errors.splice(0).join("; ")}`); } }, 5000).unref();
