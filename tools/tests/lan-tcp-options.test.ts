import { beforeAll, expect, spyOn, test } from "bun:test";
import { createServer, Socket } from "node:net";
import { buildNativeForTests, nativeTestHelper } from "../../packages/lan/native/testing";
import { createLanServer } from "../../packages/lan/src/server";
import { NativeHelperSocket } from "../../packages/lan/src/native-helper";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { PROTO_TCP, SYN, SYNACK, DATA, RST, TCP_OPTION, TCP_WINDOW, SYN_KEEPALIVE_FLAG, SYN_NODELAY_FLAG,
    TCP_OPTION_KEEPALIVE, TCP_OPTION_NODELAY, encodeTcpFrame, decodeTcpFrame, type TcpFrame } from "../../src/worker/net/netplay-wire";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 8000;
    while (!check()) { if (Date.now() >= deadline) throw Error("Timeout: " + label); await pause(5); }
}
// Compiling the native helper can exceed the default 5 s hook budget under full-gate load.
beforeAll(buildNativeForTests, 120_000);
for (const transport of ["websocket", "polling"] as const) for (const helper of [false, true])
for (const scenario of ["defaults", "initial", "connecting"] as const)
test("native TCP option bridge " + scenario + ", helper=" + helper + ", " + transport, async () => {
    const active = new Set<Socket>(), observed: { socket: object; option: number; enabled: boolean }[] = [];
    const native = createServer({ allowHalfOpen: true }, socket => {
        active.add(socket); socket.on("data", bytes => socket.write(bytes)); socket.on("end", () => socket.end());
        socket.on("error", () => {}); socket.on("close", () => active.delete(socket));
    });
    await new Promise<void>(resolve => native.listen(0, "127.0.0.1", resolve));
    const nativePort = (native.address() as { port: number }).port;
    const restore: (() => void)[] = [];
    if (helper) {
        const original = NativeHelperSocket.prototype.emit;
        const spy = spyOn(NativeHelperSocket.prototype, "emit").mockImplementation(function(this: NativeHelperSocket, name: string | symbol, ...args: unknown[]) {
            if (name === "option") observed.push({ socket: this, ...(args[0] as { option: number; enabled: boolean }) });
            return original.call(this, name, ...args);
        });
        restore.push(() => spy.mockRestore());
    } else {
        const noDelay = Socket.prototype.setNoDelay, keepAlive = Socket.prototype.setKeepAlive;
        const one = spyOn(Socket.prototype, "setNoDelay").mockImplementation(function(this: Socket, enabled = true) {
            observed.push({ socket: this, option: 2, enabled }); return noDelay.call(this, enabled);
        });
        const two = spyOn(Socket.prototype, "setKeepAlive").mockImplementation(function(this: Socket, enabled = false, delay = 0) {
            observed.push({ socket: this, option: 1, enabled }); return keepAlive.call(this, enabled, delay);
        });
        restore.push(() => one.mockRestore(), () => two.mockRestore());
    }
    const server = createLanServer({ port: 0, gateway: { ...(helper ? { nativeHelperPath: nativeTestHelper } : {}),
        routes: [{ host: "127.0.0.1", address: "203.0.113.123", ports: [nativePort], protocols: ["tcp"] }] } });
    const port = await server.listen(), network = new LanNetwork();
    const link = new RelayLink("http://127.0.0.1:" + port, "tcp-options", network, { transports: [transport] });
    network.attach(link);
    const frames: TcpFrame[] = [], endpoint = { deliver(packet: { data: Uint8Array }) { const frame = decodeTcpFrame(packet.data); if (frame) frames.push(frame); } };
    const localPort = network.bindEphemeral(endpoint, PROTO_TCP), node = network.routeIpv4(Uint8Array.of(203, 0, 113, 123)), clientId = 77;
    let selected: object | undefined;
    const values = () => observed.filter(item => item.socket === selected);
    const last = (option: number) => values().findLast(item => item.option === option)?.enabled;
    const send = (kind: number, serverId: number, value = 0, bytes?: Uint8Array) =>
        network.send(localPort, node, nativePort, encodeTcpFrame(kind, clientId, serverId, value, bytes), PROTO_TCP);
    try {
        await link.ready;
        const initial = scenario !== "defaults";
        expect(send(SYN, 0, TCP_WINDOW | (initial ? SYN_KEEPALIVE_FLAG | SYN_NODELAY_FLAG : 0))).toBe(true);
        if (scenario === "connecting") {
            // Queued before SYNACK: the guest does not know the server's id.
            expect(send(TCP_OPTION, 0, TCP_OPTION_NODELAY)).toBe(true);
            expect(send(TCP_OPTION, 0, TCP_OPTION_KEEPALIVE)).toBe(true);
        }
        await until(() => frames.some(frame => frame.kind === SYNACK), "native SYNACK");
        selected = helper ? observed[0]?.socket : observed.find(item => (item.socket as Socket).remotePort === nativePort)?.socket;
        expect(selected).toBeDefined();
        const serverId = frames.find(frame => frame.kind === SYNACK)!.srcId;
        await until(() => last(1) === (scenario === "initial") && last(2) === (scenario === "initial"), "measured initial/connect-time option values");
        const source = values();
        expect(source.find(item => item.option === 1)?.enabled).toBe(initial);
        expect(source.find(item => item.option === 2)?.enabled).toBe(initial);

        for (const [option, enabled] of [[TCP_OPTION_KEEPALIVE, true], [TCP_OPTION_NODELAY, true],
            [TCP_OPTION_KEEPALIVE, false], [TCP_OPTION_NODELAY, false]] as const) {
            expect(send(TCP_OPTION, serverId, option | +enabled)).toBe(true);
            await until(() => last(option === TCP_OPTION_KEEPALIVE ? 1 : 2) === enabled, "live native option update");
        }
        expect(send(DATA, serverId, 0, Uint8Array.of(8, 9, 10))).toBe(true);
        await until(() => frames.some(frame => frame.kind === DATA), "option changes preserve native data");
        expect([...frames.find(frame => frame.kind === DATA)!.data]).toEqual([8, 9, 10]);

        expect(send(TCP_OPTION, serverId, 0x102)).toBe(true);
        await until(() => frames.some(frame => frame.kind === RST), "unknown option fails visibly");
        expect(frames.find(frame => frame.kind === RST)!.value).toBe(10022);
        expect(link.connected).toBe(true);
    } finally {
        network.unbind(localPort, endpoint, PROTO_TCP); network.attach(null); await server.close();
        for (const socket of active) socket.destroy(); await new Promise<void>(resolve => native.close(() => resolve()));
        for (const undo of restore.reverse()) undo();
    }
}, 20000);
