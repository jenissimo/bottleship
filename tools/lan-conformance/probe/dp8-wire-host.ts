/**
 * Real UDP carrier for NativeDirectPlayHost. This is an implementation under
 * test, not a native-Windows oracle; record goldens with the native probe.
 *
 * bun dp8-wire-host.ts --port 23913 --addr-file <run>/addr-host.txt
 */
import { createSocket } from "node:dgram";
import { writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { LanNetwork } from "../../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram, ipv4ToNode, nodeToIpv4, parseIpv4, isExternalIpv4Node } from "../../../src/worker/net/netplay-wire";
import { NativeDirectPlayHost } from "../../../src/worker/modules/dpnet/native-wire/host";
import { decodeNativeEnumQuery, encodeNativeEnumResponse } from "../../../src/worker/modules/dpnet/native-wire/discovery-codec";

import { DP8_PEER, guidBytes } from "../../../src/worker/modules/dpnet/constants";

export const WIRE_APP_GUID = Buffer.from(guidBytes(DP8_PEER)).toString("hex");
export interface WireHostOptions {
    port?: number;
    advertisedIp?: string;
    bindIp?: string;
    onMessage?(data: Uint8Array): void;
    onError?(error: Error): void;
}

export async function startWireHost(options: WireHostOptions = {}) {
    const advertisedIp = options.advertisedIp ?? "127.0.0.1";
    if (!parseIpv4(advertisedIp)) throw new Error("Invalid advertised IPv4 address");
    const requestedPort = options.port ?? 23913;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Invalid UDP port");
    const socket = createSocket("udp4"), network = new LanNetwork(), host = new NativeDirectPlayHost(network);
    let closed = false;
    socket.on("error", error => options.onError?.(error));
    const close = async () => {
        if (closed) return;
        closed = true;
        host.dispose(); network.attach(null);
        await new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } });
    };
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.bind(requestedPort, options.bindIp ?? "0.0.0.0", () => {
                socket.removeListener("error", reject); resolve();
            });
        });
        const port = socket.address().port;
        const send = (data: Uint8Array, remotePort: number, ip: string) => {
            if (closed) return false;
            socket.send(data, remotePort, ip, error => { if (error && !closed) options.onError?.(error); });
            return true;
        };
        network.attach({
            connected: true, routeLocal: true,
            send(frame) {
                const dg = decodeDatagram(frame);
                if (!dg || dg.proto !== PROTO_UDP || dg.srcPort !== port || !isExternalIpv4Node(dg.node)) return false;
                return send(dg.payload, dg.dstPort, [...nodeToIpv4(dg.node)].join("."));
            },
            close() {},
        });
        const hr = host.start({
            port,
            application: { flags: 0, maxPlayers: 8, players: 1, instance: "5102dacf".repeat(4), application: WIRE_APP_GUID,
                name: "session", password: null, reserved: new Uint8Array(), applicationData: new Uint8Array() },
            player: { name: "host", data: new Uint8Array() },
            url: address => {
                const ip = network.isSelf(Uint8Array.from(address.node)) ? advertisedIp : [...nodeToIpv4(Uint8Array.from(address.node))].join(".");
                return "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=" + ip + ";port=" + address.port;
            },
            allowIncoming: () => true,
            admit: () => ({ hr: 0, data: new Uint8Array() }),
            timeout: 10000, retryInterval: 100,
        });
        if (hr) throw new Error("Wire host start failed: " + hr);
        host.onMessage = () => {
            while (host.queue.length) {
                const data = host.queue[0].data.slice();
                host.removeMessage(0);
                options.onMessage?.(data);
            }
        };
        socket.on("message", (data, source) => {
            if (closed) return;
            const query = decodeNativeEnumQuery(data);
            if (query) {
                if (query.application !== null && query.application !== WIRE_APP_GUID) return;
                send(encodeNativeEnumResponse({
                    token: query.token, instance: host.desc!.instance, application: WIRE_APP_GUID,
                    flags: 0, maxPlayers: 8, players: host.currentPlayers, name: "session", password: "",
                    reserved: new Uint8Array(), applicationData: new Uint8Array(), data: query.data,
                }), source.port, source.address);
                return;
            }
            const ip = parseIpv4(source.address);
            if (ip) network.receiveFrame(encodeDatagram(PROTO_UDP, ipv4ToNode(ip, true), port, source.port, data));
        });
        return { host, port, address: advertisedIp + ":" + port, close };
    } catch (error) { await close(); throw error; }
}

function publish(path: string, body: string) {
    const target = resolve(path), temporary = target + "." + process.pid + ".tmp";
    writeFileSync(temporary, body); renameSync(temporary, target);
}

if (import.meta.main) {
    const cli = new Map<string, string>(), argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        if (!["--port", "--ready", "--addr-file", "--receive-file"].includes(argv[i]) || !argv[i + 1]) throw new Error("Invalid wire-host option");
        cli.set(argv[i], argv[i + 1]);
    }
    if (!cli.has("--ready") && !cli.has("--addr-file")) throw new Error("Provide --addr-file or --ready");
    let running: Awaited<ReturnType<typeof startWireHost>> | undefined;
    const server = running = await startWireHost({
        port: cli.has("--port") ? Number(cli.get("--port")) : 23913,
        advertisedIp: process.env.BS_WIRE_HOST_IP,
        onError: error => { console.error(error); process.exitCode = 1; void running?.close(); },
        onMessage: data => {
            console.log("[wire-host] received " + data.length + " bytes");
            if (cli.has("--receive-file")) publish(cli.get("--receive-file")!, Buffer.from(data).toString("base64") + "\n");
        },
    });
    for (const key of ["--ready", "--addr-file"]) if (cli.has(key)) publish(cli.get(key)!, server.address + "\n");
    console.log("[wire-host] ready " + server.address);
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void server.close(); });
}
