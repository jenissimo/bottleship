import { beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Socket as NativeSocket } from "node:net";
import { createLanServer } from "../../packages/lan/src/server";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { buildNativeForTests } from "../../packages/lan/native/testing";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address } from "../../src/worker/modules/wsa-network";

const nativePath = fileURLToPath(new URL("../../packages/lan/native/", import.meta.url));
const executable = nativePath + "build/socket-helper" + (process.platform === "win32" ? ".exe" : "");
const peerExecutable = nativePath + "build/test-peer" + (process.platform === "win32" ? ".exe" : "");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Timeout: " + label); await pause(5); }
}
function code(fn: () => unknown): number {
    try { fn(); return 0; } catch (error) { if (error instanceof WsaFailure) return error.code; throw error; }
}
beforeAll(buildNativeForTests);

for (const initialInline of [false, true]) for (const transport of ["websocket", "polling"] as const) test("real TCP MSG_OOB and native inline=" + initialInline + " survive the helper, relay and Winsock over " + transport, async () => {
    const peer: ChildProcessWithoutNullStreams = spawn(peerExecutable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let text = ""; peer.stdout.on("data", bytes => { text += String(bytes); }); peer.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => { peer.on("exit", resolve); peer.on("error", reject); });
    await until(() => text.includes("\n"), "native urgent oracle listening");
    const nativePort = Number(text.split("\n")[0]);
    const server = createLanServer({ port: 0, gateway: { nativeHelperPath: executable, routes: [
        { host: "127.0.0.1", address: "203.0.113.70", ports: [nativePort], protocols: ["tcp"] },
    ] } });
    const port = await server.listen(), network = new LanNetwork(Uint8Array.of(2,0,0,7,7,1));
    const link = new RelayLink("http://127.0.0.1:" + port, "urgent", network, { transports: [transport] });
    network.attach(link); const table = new WsaSocketTable(network);
    try {
        await link.ready;
        const tcp = table.socket(); table.setOobInline(tcp, initialInline);
        expect(code(() => table.connect(tcp, ipv4Address(Uint8Array.of(203,0,113,70), nativePort)))).toBe(WSA.EWOULDBLOCK);
        await until(() => table.isConnected(tcp) || table.exceptional(tcp), "native urgent connect");
        expect(table.get(tcp).error).toBe(0);
        expect(table.isConnected(tcp)).toBe(true);
        expect(table.send(tcp, Uint8Array.of(11,12,42), undefined, 1)).toBe(3);
        expect(table.send(tcp, Uint8Array.of(13,14))).toBe(2);
        await until(() => table.bytesAvailable(tcp) === (initialInline ? 5 : 4) && (initialInline || table.exceptional(tcp)), "normal and urgent bytes echoed");
        expect(table.receive(tcp, 100).data).toEqual(Uint8Array.from(initialInline ? [11,12,42,13,14] : [11,12,13,14]));
        if (!initialInline) expect(table.receive(tcp, 1, 1).data).toEqual(Uint8Array.of(42));
        else expect(table.exceptional(tcp)).toBe(false);
        for (const byte of [43,44]) {
            expect(table.send(tcp, Uint8Array.of(byte), undefined, 1)).toBe(1);
            await until(() => initialInline ? table.bytesAvailable(tcp) === 1 : table.exceptional(tcp), "urgent-only byte echoed");
            expect(table.receive(tcp, 1, initialInline ? 0 : 1).data).toEqual(Uint8Array.of(byte));
        }
        table.setOobInline(tcp, true);
        expect(table.send(tcp, Uint8Array.of(45), undefined, 1)).toBe(1);
        await until(() => table.bytesAvailable(tcp) === 1, "live native inline enabled");
        expect(table.receive(tcp, 1).data).toEqual(Uint8Array.of(45));
        expect(table.exceptional(tcp)).toBe(false);
        table.setOobInline(tcp, false);
        expect(table.send(tcp, Uint8Array.of(46), undefined, 1)).toBe(1);
        await until(() => table.exceptional(tcp), "live native inline disabled");
        expect(table.receive(tcp, 1, 1).data).toEqual(Uint8Array.of(46));
        table.shutdown(tcp, 1);
        await until(() => table.get(tcp).eof, "urgent native peer FIN");
        expect(table.receive(tcp, 1).data.length).toBe(0);
        expect(await exited).toBe(0);
        expect(JSON.parse(text.trim().split("\n")[1])).toEqual({ normal: 4, urgent: 5, byte: 46 });
    } finally { table.reset(); network.attach(null); await server.close(); peer.kill(); }
}, 25_000);

test("helper TCP uses bounded credit for large streams and closes native flows on disconnect", async () => {
    const sockets = new Set<NativeSocket>();
    const native = createServer({ allowHalfOpen: true }, socket => {
        sockets.add(socket); socket.on("data", bytes => socket.write(bytes)); socket.on("end", () => socket.end());
        socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => native.listen(0, "127.0.0.1", resolve));
    const nativePort = (native.address() as { port: number }).port;
    const server = createLanServer({ port: 0, gateway: { nativeHelperPath: executable, routes: [
        { host: "127.0.0.1", address: "203.0.113.71", ports: [nativePort], protocols: ["tcp"] },
    ] } });
    const port = await server.listen(), network = new LanNetwork();
    const link = new RelayLink("http://127.0.0.1:" + port, "helper-stream", network, { transports: ["polling"] });
    network.attach(link); const table = new WsaSocketTable(network);
    try {
        await link.ready;
        const tcp = table.socket(); code(() => table.connect(tcp, ipv4Address(Uint8Array.of(203,0,113,71), nativePort)));
        await until(() => table.isConnected(tcp), "helper stream connected");
        const bytes = Uint8Array.from({ length: 400000 }, (_, index) => index % 251), echoed = new Uint8Array(bytes.length);
        let written = 0, read = 0;
        await until(() => {
            if (written < bytes.length) {
                try { written += table.send(tcp, bytes.subarray(written)); }
                catch (error) { if (!(error instanceof WsaFailure) || error.code !== WSA.EWOULDBLOCK) throw error; }
            }
            while (table.bytesAvailable(tcp)) { const part = table.receive(tcp, 7777).data; echoed.set(part, read); read += part.length; }
            return read === bytes.length;
        }, "400KB helper credit stream");
        expect(written).toBe(bytes.length); expect(echoed).toEqual(bytes);
        network.attach(null);
        await until(() => sockets.size === 0, "disconnect terminates helper and native connection");
    } finally {
        table.reset(); network.attach(null); await server.close(); for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => native.close(() => resolve()));
    }
}, 25_000);
