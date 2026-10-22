import { createSocket } from "node:dgram";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createLanServer } from "../../packages/lan/src/server";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { NativeDirectPlayDiscovery } from "../../src/worker/modules/dpnet/native-wire/discovery";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { encodeNativePlayerConnect, decodeNativeCoreConnectInfo, type NativeCoreConnectInfo } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { PROTO_UDP } from "../../src/worker/net/netplay-wire";
if (process.platform !== "win32") throw new Error("Windows native DirectPlay provider capture required");
const output = resolve("logs/lan-conformance/directplay8-wire");
mkdirSync(output, { recursive: true });
const nonce = Date.now() >>> 0, compiler = "C:/msys64/mingw32/bin/gcc.exe", executable = join(output, "wire-" + nonce + ".exe");
const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
env.Path = dirname(compiler) + ";" + (process.env.Path ?? process.env.PATH ?? "");
const build = Bun.spawnSync([compiler, "-O1", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-DORACLE_NONCE=" + nonce,
    ...(process.argv.includes("--groups") ? ["-DORACLE_GROUPS=1"] : []), "-Wl,--entry,_entry", "-Wl,--subsystem,console", "-o", executable, "tools/lan-conformance/directplay8-wire.c",
    "-lkernel32", "-lole32", "-ldxguid", "-luuid"], { env, stdout: "pipe", stderr: "pipe" });
if (build.exitCode) throw new Error(new TextDecoder().decode(build.stderr));
const capture = createSocket("udp4"), probe = createSocket("udp4");
await new Promise<void>(resolve => capture.bind(0, "0.0.0.0", resolve));
await new Promise<void>(resolve => probe.bind(0, "127.0.0.1", resolve));
const capturePort = capture.address().port, hostPort = probe.address().port;
await new Promise<void>(resolve => probe.close(resolve));
const directory = join(output, String(nonce)); mkdirSync(directory);
const raw: Array<{ name: string; address: string; port: number; data: Uint8Array }> = [];
const nextMessage = (socket: ReturnType<typeof createSocket>, name: string, timeout = 5000) => new Promise<{ data: Uint8Array; address: string; port: number }>((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", message); reject(new Error("Native packet timeout " + name)); }, timeout);
    const message = (data: Buffer, remote: { address: string; port: number }) => {
        clearTimeout(timer); const item = { data: Uint8Array.from(data), address: remote.address, port: remote.port };
        raw.push({ name, ...item }); resolve(item);
    };
    socket.once("message", message);
});
let host: ReturnType<typeof Bun.spawn> | undefined;
const verifyNativeJoin = async () => {
    const bytes = await Bun.file(join(directory, "wire-connect.bin")).arrayBuffer(), view = new DataView(bytes);
    if (view.getUint32(0, true) !== 0x42534c4e || view.getUint32(8, true) !== nonce || bytes.byteLength !== view.getUint32(4, true) * 4) throw new Error("Invalid native join record");
    const values = Array.from({ length: bytes.byteLength / 4 - 3 }, (_, i) => view.getUint32(12 + i * 4, true));
    const checks: [number, number][] = [[18,0],[19,0],[20,2],[21,1],[24,0],[25,2],[27,1],[28,1],[32,0],[35,1],[37,1],[38,0],[39,1],[40,0],[41,1],[42,4097],[43,1],[45,1],[46,0],[48,0],[49,0],[50,1],[52,1],[55,0],[57,4],[58,1],[59,0],[60,1],[61,0],[62,2],[63,3]];
    const groupCount = process.argv.includes("--groups") ? 45 : 0;
    if (groupCount) for (const check of checks) if (check[0] >= 61) check[0] += groupCount;
    if (values.length !== 64 + groupCount || checks.some(([i, expected]) => values[i] !== expected)) throw new Error("Native join/echo/lifetime scenario failed: " + JSON.stringify(values));
    return values;
};
try {
    const queryPromise = nextMessage(capture, "query");
    const client = Bun.spawn([executable, "client", String(capturePort)], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const query = await queryPromise; if (await client.exited) throw new Error("Native EnumHosts query failed");
    for (const mode of ["all", "data"]) {
        const next = nextMessage(capture, mode + "-query");
        const process = Bun.spawn([executable, mode, String(capturePort)], { cwd: directory, stdout: "pipe", stderr: "pipe" });
        await next; if (await process.exited) throw new Error("Native EnumHosts " + mode + " failed");
    }
    rmSync(join(directory, "wire-host.ready"), { force: true });
    host = Bun.spawn([executable, "host", String(hostPort)], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 15000;
    while (!await Bun.file(join(directory, "wire-host.ready")).exists()) {
        if (Date.now() > deadline) throw new Error("Native Host readiness timeout");
        await Bun.sleep(10);
    }
    const ready = new DataView(await Bun.file(join(directory, "wire-host.ready")).arrayBuffer()).getUint32(0, true);
    if (ready) throw new Error("Native Host failed " + ready.toString(16));
    const responsePromise = nextMessage(capture, "response");
    capture.send(query.data, hostPort, query.address); const response = await responsePromise;
    // Route the provider's actual response to a second Windows client. Its unique
    // enum correlation key must be echoed rather than substituted with old data.
    const secondQuery = nextMessage(capture, "verification-query");
    const verify = Bun.spawn([executable, "client", String(capturePort)], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const current = await secondQuery, rewritten = response.data.slice(); rewritten.set(current.data.subarray(2, 4), 2);
    capture.send(rewritten, current.port, current.address);
    if (await verify.exited) throw new Error("Native response decode verification failed");
    const result = new DataView(await Bun.file(join(directory, "wire-client.bin")).arrayBuffer());
    const observations = Array.from({ length: result.byteLength / 4 - 3 }, (_, n) => result.getUint32(12 + n * 4, true));
    const expected = [0,0,0,0,0,0,0,0,0,7,1,3,1,3,1,1,0,1,0];
    if (observations.length !== expected.length || observations.some((value, index) => value !== expected[index])) throw new Error("Native response callback mismatch: " + observations);
    if (process.argv.includes("--guest-connect")) {
        const native = Bun.spawn([executable, "join", String(hostPort)], { cwd: directory, stdout: "pipe", stderr: "pipe" });
        if (await native.exited) throw new Error("Native Connect reference failed");
        await verifyNativeJoin();
    }
    const interop: Array<{ transport: string; hr: number; name: string | null; players: number; data: number[] }> = [];
    const guestProofs: Array<{ transport: string; comparison: string; observations: number; guestSha256: string }> = [];
    const nativeLinks: Array<{ transport: string; version: number; handshake: number; reliableAck: number; shutdown: number; core?: { localId: number; version: number; players: number }; packets: string[] }> = [];
    for (const transport of ["websocket", "polling"] as const) {
        const address = "198.18.0.61";
        const server = createLanServer({ port: 0, transports: transport === "websocket" ? ["polling", "websocket"] : ["polling"],
            gateway: { routes: [{ host: query.address, address, protocols: ["udp"], ports: [hostPort] }] } });
        const port = await server.listen(), network = new LanNetwork(), link = new RelayLink("http://127.0.0.1:" + port, "native-dp8", network, { transports: [transport] });
        network.attach(link);
        let discovery: NativeDirectPlayDiscovery | undefined;
        try {
            await link.ready; discovery = new NativeDirectPlayDiscovery(network);
            let seen = 0;
            const operation = discovery.discover({ node: network.routeIpv4(Uint8Array.from(address.split(".").map(Number))), port: hostPort,
                application: Buffer.from(query.data.subarray(5, 21)).toString("hex"), count: 1, timeout: 500,
                onResponse: response => {
                    if (response.name !== "WireЖ" || response.maxPlayers !== 7 || response.players !== 1 ||
                        Buffer.from(response.applicationData).toString("hex") !== "030507" || Buffer.from(response.data).toString("hex") !== "aa00bb") throw new Error("Native metadata mismatch");
                    seen++; interop.push({ transport, hr: 0, name: response.name, players: response.players, data: [...response.data] });
                } });
            const hr = await operation.done;
            if (hr || seen !== 1) throw new Error("Native host through " + transport + ": hr=" + hr.toString(16) + " responses=" + seen);
            if (process.argv.includes("--link") || process.argv.includes("--core")) {
                const node = network.routeIpv4(Uint8Array.from(address.split(".").map(Number))), packets: string[] = [];
                const trace = (value: string) => { if (packets.length < 256) packets.push(Math.round(performance.now()) + ":" + value); };
                let localPort = 0, binding = 0, handshake = -1, reliableAck = -1, shutdown = -1, failure: string | undefined;
                let core: NativeCoreConnectInfo | null = null, coreVersion = 0, resolveCore!: (result: number) => void;
                const coreReady = new Promise<number>(resolve => { resolveCore = resolve; });
                const application = Buffer.from(query.data.subarray(5, 21)).toString("hex");
                const internal = (command: number, ...values: number[]) => { const bytes = new Uint8Array(4 + values.length * 4), view = new DataView(bytes.buffer); view.setUint32(0, command, true); values.forEach((value, i) => view.setUint32(4 + i * 4, value, true)); return bytes; };
                const removeState = network.onStateChange(state => trace("network:" + JSON.stringify(state)));
                const link = new NativeReliableLink({ timeout: 3000,
                    onState: (state, hr) => trace("state:" + state + ":" + hr.toString(16)),
                    onMessage(message) {
                        if (!process.argv.includes("--core")) return;
                        trace("core:" + Buffer.from(message.payload).toString("hex"));
                        const view = new DataView(message.payload.buffer, message.payload.byteOffset, message.payload.byteLength);
                        try {
                            const command = view.getUint32(0, true);
                            const send = (bytes: Uint8Array) => { void link.sendReliable(bytes).then(hr => { if (hr) resolveCore(hr); }); };
                            if (command === 0xc2) {
                                core = decodeNativeCoreConnectInfo(message.payload);
                                const self = core?.entries.find(entry => entry.id === core!.localId);
                                if (!core || core.application.application !== application || core.application.name !== "WireЖ" || core.application.players !== 2 ||
                                    !self || self.name !== "GuestЖ" || Buffer.from(self.data).toString("hex") !== "0100ff") throw new Error("Native core metadata mismatch");
                                send(internal(0xc3));
                            } else if (command === 0xc6) {
                                if (!core || message.payload.length < 16 || view.getUint32(4, true) !== core.localId) throw new Error("Unexpected native peer graph");
                                coreVersion = view.getUint32(8, true); send(internal(0xc9, coreVersion, 0));
                            } else if (command === 0xca) {
                                if (!core || !coreVersion || message.payload.length < 12 || view.getUint32(4, true) !== coreVersion) throw new Error("Native name-table confirmation mismatch");
                                resolveCore(0);
                            } else if (command === 0xc5) resolveCore(message.payload.length >= 8 ? view.getUint32(4, true) : 0x80004005);
                        } catch (error) { trace("core-error:" + String(error)); resolveCore(0x80004005); }
                    },
                    send(bytes) {
                        const live = binding !== 0 && network.bindingGeneration(localPort, PROTO_UDP) === binding;
                        const sent = live && network.send(localPort, node, hostPort, bytes, PROTO_UDP, binding);
                        trace("send:" + sent + ":" + Buffer.from(bytes).toString("hex"));
                        // Carrier congestion is UDP loss. DNET retains the reliable frame until native ACK.
                        return sent || (live && network.connected && network.bindingGeneration(localPort, PROTO_UDP) === binding);
                    } });
                const endpoint = { deliver(datagram: { srcNode: Uint8Array; srcPort: number; data: Uint8Array }) {
                    trace("receive:" + Buffer.from(datagram.data).toString("hex"));
                    if (datagram.srcPort !== hostPort || !node.every((value, i) => value === datagram.srcNode[i])) { trace("wrong endpoint"); return; }
                    link.receive(datagram.data);
                } };
                localPort = network.bindEphemeral(endpoint, PROTO_UDP); if (!localPort) throw new Error("Native DNET bind failed");
                binding = network.bindingGeneration(localPort, PROTO_UDP);
                const timer = setInterval(() => link.tick(), 10);
                let deadline: ReturnType<typeof setTimeout> | undefined;
                const bounded = (promise: Promise<number>) => Promise.race([promise, new Promise<number>((_, reject) => {
                    deadline = setTimeout(() => reject(new Error("Native DNET phase deadline")), 5000);
                })]).finally(() => clearTimeout(deadline));
                try {
                    handshake = await bounded(link.connect()); if (handshake) throw new Error("Native DNET handshake failed " + handshake.toString(16));
                    reliableAck = await bounded(link.sendReliable(new Uint8Array(), 0));
                    if (reliableAck) throw new Error("Native DNET reliable ACK failed " + reliableAck.toString(16));
                    if (process.argv.includes("--core")) {
                        const info = encodeNativePlayerConnect({ flags: 4, version: 2, instance: "0".repeat(32), application, name: "GuestЖ", data: Uint8Array.of(1, 0, 255),
                            password: null, connectData: Uint8Array.of(8, 9), url: null, alternate: new Uint8Array() });
                        const submitted = link.sendReliable(info);
                        const result = await bounded(coreReady); if (result) throw new Error("Native core Connect failed " + result.toString(16));
                        if (await submitted) throw new Error("Native core initial packet was not ACKed");
                    }
                    const waitNativePlayers = async (players: number) => {
                        const deadline = Date.now() + 5000, file = Bun.file(join(directory, "wire-host.players"));
                        while (Date.now() < deadline) {
                            if (await file.exists()) { const bytes = await file.arrayBuffer(); if (bytes.byteLength === 4 && new DataView(bytes).getUint32(0, true) === players) return; }
                            await Bun.sleep(10);
                        }
                        throw new Error("Native host player callback count did not reach " + players);
                    };
                    if (core) await waitNativePlayers(2);
                    shutdown = await bounded(link.shutdown()); if (shutdown) throw new Error("Native DNET graceful shutdown failed " + shutdown.toString(16));
                    if (core) await waitNativePlayers(1);
                    nativeLinks.push({ transport, version: link.remoteVersion, handshake, reliableAck, shutdown,
                        core: core ? { localId: core.localId, version: coreVersion, players: core.application.players } : undefined, packets });
                } catch (error) { failure = String(error); throw error; }
                finally {
                    clearInterval(timer); removeState(); link.close(); network.unbind(localPort, endpoint, PROTO_UDP);
                    await Bun.write(join(directory, "native-link-" + transport + ".json"), JSON.stringify({ transport, handshake, reliableAck, shutdown, failure, core,
                        version: link.remoteVersion, nativeHostPort: hostPort, localPort, packets }, null, 2) + "\n");
                }
            }
            if (process.argv.includes("--backend")) {
                const core = new NativeDirectPlayCore(network, "peer", 5000), transcript: Array<{ operation: string; hr?: number; value?: unknown }> = [];
                let failure: string | undefined;
                const check = (operation: string, condition: boolean, value?: unknown) => { transcript.push({ operation, value }); if (!condition) throw Error("Native backend check failed: " + operation + " " + JSON.stringify(value)); };
                const result = (operation: string, hr: number) => { transcript.push({ operation, hr }); if (hr) throw Error("Native backend operation failed: " + operation + " 0x" + hr.toString(16)); };
                const received: Uint8Array[] = [];
                core.onMessage = () => { while (core.queue.length) { const message = core.queue[0]; received.push(message.data.slice()); message.processed?.(); core.removeMessage(0); } };
                const echo = async (index: number, data: Uint8Array) => {
                    const deadline = Date.now() + 5000; while (received.length <= index && Date.now() < deadline) await Bun.sleep(10);
                    check("echo-" + index, received[index]?.length === data.length && received[index].every((b, i) => b === data[i]), received[index]?.length);
                };
                try {
                    result("connect", await core.connect({ node: Array.from(network.routeIpv4(Uint8Array.from(address.split(".").map(Number)))), port: hostPort },
                        { instance: "0".repeat(32), application: Buffer.from(query.data.subarray(5, 21)).toString("hex"), name: "", password: "", maxPlayers: 0, flags: 0, user: [0, 0, 0, 0] },
                        { name: { short: "GuestЖ", long: "" }, data: [1, 0, 255], flags: 0 }, Uint8Array.of(1, 0, 255)));
                    check("players", core.currentPlayers === 2, core.currentPlayers);
                    if (process.argv.includes("--groups")) {
                        const groups = [...core.entities.values()].filter(entity => entity.group);
                        check("auto-group", groups.length === 1 && groups[0].flags === 1 && groups[0].members.includes(core.hostId), groups);
                        const created = await core.mutate({ op: "mutate", action: "create", group: true, name: { short: "NewЖ" }, flags: 0, data: [7, 0, 9] }); result("create-group", created.hr);
                        check("created-name", core.entities.get(created.id!)?.name.short === "NewЖ", created);
                        result("add-member", (await core.mutate({ op: "mutate", action: "member", id: created.id, member: core.localId, add: true })).hr);
                        check("member-added", core.entities.get(created.id!)?.members.includes(core.localId) ?? false);
                        result("set-group-data", (await core.mutate({ op: "mutate", action: "info", id: created.id, data: [1, 0, 255] })).hr);
                        check("updated-group", core.entities.get(created.id!)?.data.join(",") === "1,0,255" && core.entities.get(created.id!)?.name.short === "NewЖ");
                        result("remove-member", (await core.mutate({ op: "mutate", action: "member", id: created.id, member: core.localId, add: false })).hr);
                        check("member-removed", core.entities.get(created.id!)?.members.length === 0);
                        result("destroy-group", (await core.mutate({ op: "mutate", action: "destroy", group: true, id: created.id })).hr);
                        check("destroyed-group", !core.entities.has(created.id!));
                    }
                    const data = Uint8Array.from({ length: 4097 }, (_, i) => i * 17 & 255);
                    result("send-guaranteed", await core.sendDpn(core.hostId, 8, data)); await echo(0, data);
                    result("send-complete-on-process", await core.sendDpn(core.hostId, 12, Uint8Array.of(1, 0, 9))); await echo(1, Uint8Array.of(1, 0, 9));
                    result("send-unreliable", await core.sendDpn(core.hostId, 0, Uint8Array.of(9, 0, 1))); await echo(2, Uint8Array.of(9, 0, 1));
                    result("close", await core.shutdown());
                } catch (error) { failure = String(error); throw error; }
                finally { core.dispose(); await Bun.write(join(directory, "native-backend-" + transport + ".json"), JSON.stringify({ transport, nonce, failure, transcript }, null, 2) + "\n"); }
            }
            if (process.argv.includes("--guest") || process.argv.includes("--guest-connect")) {
                const game = join(directory, "guest-" + transport), guestExe = join(game, "lan-oracle.exe");
                mkdirSync(game);
                const compileGuest = Bun.spawnSync([compiler, "-O1", "-nostdlib", "-fno-builtin", "-fno-stack-protector",
                    "-DORACLE_NONCE=" + nonce, "-DORACLE_GUEST_PORT=" + hostPort, ...(process.argv.includes("--guest-connect") ? ["-DORACLE_GUEST_JOIN=1"] : []), ...(process.argv.includes("--groups") ? ["-DORACLE_GROUPS=1"] : []), "-Wl,--entry,_entry", "-Wl,--subsystem,console",
                    "-o", guestExe, "tools/lan-conformance/directplay8-wire.c", "-lkernel32", "-lole32", "-ldxguid", "-luuid"], { env, stdout: "pipe", stderr: "pipe" });
                if (compileGuest.exitCode) throw new Error(new TextDecoder().decode(compileGuest.stderr));
                const bundle = join(directory, "native-discovery-" + transport + ".wgb");
                for (const command of [
                    [process.execPath, "tools/make-wgb.ts", game, bundle, "--exe", "lan-oracle.exe", "--name", "Native DP8 " + transport, "--game-id", "app:lan-conformance", "--ram", "128"],
                    [process.execPath, "tools/wgb.ts", "patch-manifest", bundle, "emulator.deleteOnBoot", JSON.stringify(["C:\\\\lan-oracle.bin"])],
                ]) { const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" }); if (result.exitCode) throw new Error("Native discovery guest bundle failed"); }
                const buildPath = join(game, "build.json"), reference = join(directory, process.argv.includes("--guest-connect") ? "wire-connect.bin" : "wire-client.bin");
                await Bun.write(buildPath, JSON.stringify({ fixture: "directplay8-native-discovery-" + transport, bundle, reference,
                    executableSha256: createHash("sha256").update(new Uint8Array(await Bun.file(guestExe).arrayBuffer())).digest("hex"),
                    referenceSha256: createHash("sha256").update(new Uint8Array(await Bun.file(reference).arrayBuffer())).digest("hex") }));
                const devUrl = new URL("http://localhost:5175/?game=dev"); devUrl.searchParams.set("lanServer", "http://127.0.0.1:" + port); devUrl.searchParams.set("room", "native-dp8");
                const guest = Bun.spawn([process.execPath, "tools/harness.ts", "run", "tools/lan-conformance/compare.harness.ts"],
                    { env: { ...process.env, BS_TAB: "lan-oracle", BS_DEV_URL: devUrl.href, BS_SIDECAR_PORT: "3003", BS_CDP_PORT: "9334", BS_ORACLE_BUILD: buildPath, BS_LAN_SERVER: "http://127.0.0.1:" + port, BS_LAN_ROOM: "native-dp8" }, stdout: "inherit", stderr: "inherit" });
                if (await guest.exited) throw new Error("Guest EXE native " + transport + " discovery comparison failed");
                const comparison = join(game, "comparison-" + nonce + ".json"), proof = await Bun.file(comparison).json();
                const referenceObservations = new DataView(await Bun.file(reference).arrayBuffer()).getUint32(4, true) - 3;
                if (proof.differences.length || proof.observations !== referenceObservations) throw new Error("Incomplete native guest proof");
                guestProofs.push({ transport, comparison, observations: proof.observations, guestSha256: proof.guestSha256 });
            }
        } finally { discovery?.close(); network.attach(null); await server.close(); }
    }
    const protocolPackets: Array<{ direction: string; address: string; port: number; hex: string }> = [];
    if (process.argv.includes("--connection")) {
        let clientEndpoint: { address: string; port: number } | undefined, bytes = 0;
        const proxy = (data: Buffer, remote: { address: string; port: number }) => {
            if (protocolPackets.length >= 4096 || (bytes += data.length) > 8 * 1024 * 1024) throw new Error("Native protocol capture bound exceeded");
            const fromHost = remote.port === hostPort;
            protocolPackets.push({ direction: fromHost ? "host" : "client", address: remote.address, port: remote.port, hex: data.toString("hex") });
            if (fromHost) { if (clientEndpoint) capture.send(data, clientEndpoint.port, clientEndpoint.address); }
            else { clientEndpoint = remote; capture.send(data, hostPort, query.address); }
        };
        capture.on("message", proxy);
        const joiner = Bun.spawn([executable, "join", String(capturePort)], { cwd: directory, stdout: "pipe", stderr: "pipe" });
        const timeout = setTimeout(() => joiner.kill(), 15000);
        let failure: string | undefined;
        try {
            if (await joiner.exited) throw new Error("Native connection proxy failed");
            await verifyNativeJoin();
        } catch (error) { failure = String(error); throw error; }
        finally {
            clearTimeout(timeout); capture.off("message", proxy);
            await Bun.write(join(directory, "protocol.json"), JSON.stringify(protocolPackets, null, 2) + "\n");
            await Bun.write(join(directory, "protocol-result.json"), JSON.stringify({ failure, nonce, packets: protocolPackets.length }, null, 2) + "\n");
        }
    }
    for (const packet of raw) await Bun.write(join(directory, packet.name + ".bin"), packet.data);
    const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    const report = { nonce, interop, guestProofs, nativeLinks, protocolPackets, capturedAt: new Date().toISOString(), executableSha256: sha256(new Uint8Array(await Bun.file(executable).arrayBuffer())), observations,
        packets: raw.map(packet => ({ ...packet, data: undefined, bytes: packet.data.length, hex: Buffer.from(packet.data).toString("hex"), sha256: sha256(packet.data) })) };
    await Bun.write(join(output, "capture.json"), JSON.stringify({ ...report, directory }, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, directory }, null, 2));
} finally {
    if (host) { await Bun.write(join(directory, "wire-host.stop"), "stop"); await host.exited; }
    await new Promise<void>(resolve => capture.close(resolve));
}
