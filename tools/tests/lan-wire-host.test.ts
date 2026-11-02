import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWireHost, WIRE_APP_GUID } from "../lan-conformance/probe/dp8-wire-host";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { encodeNativePlayerConnect, decodeNativeCoreConnectInfo } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { nativeCoreWords } from "../../src/worker/modules/dpnet/native-wire/core-operations";
import { encodeNativeEnumQuery, decodeNativeEnumResponse } from "../../src/worker/modules/dpnet/native-wire/discovery-codec";

async function until(check: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Wire host deadline"); await Bun.sleep(5); }
}

test("wire host carries raw DNET 1.6 CONNECT and C1/C2 on a real UDP tuple", async () => {
    const received: Uint8Array[] = [], errors: Error[] = [];
    const server = await startWireHost({ port: 0, onMessage: data => received.push(data), onError: error => errors.push(error) });
    const peer = createSocket("udp4"), replies: Uint8Array[] = [];
    await new Promise<void>(resolve => peer.bind(0, "127.0.0.1", resolve));
    const peerPort = peer.address().port;
    const send = (bytes: Uint8Array) => { peer.send(bytes, server.port, "127.0.0.1"); return true; };
    let snapshot: ReturnType<typeof decodeNativeCoreConnectInfo>;
    const link = new NativeReliableLink({ version: 0x10006, sessionId: 123, send,
        onMessage: message => {
            const value = decodeNativeCoreConnectInfo(message.payload);
            if (value) { snapshot = value; void link.sendReliable(nativeCoreWords(0xc3)); }
        },
    });
    peer.on("message", data => { replies.push(data.slice()); link.receive(data); });
    try {
        send(encodeNativeEnumQuery({ token: 9, application: WIRE_APP_GUID, data: new Uint8Array() }));
        await until(() => replies.some(data => decodeNativeEnumResponse(data)?.token === 9));
        expect(await link.connect()).toBe(0);
        expect(replies.some(data => {
            const frame = decodeNativeProtocolFrame(data);
            return frame?.kind === "control" && frame.opcode === 2 && frame.sessionId === 123;
        })).toBe(true);
        expect(await link.sendReliable(encodeNativePlayerConnect({
            flags: 4, version: 2, instance: "0".repeat(32), application: WIRE_APP_GUID, name: "peer",
            data: new Uint8Array(), password: null, connectData: new Uint8Array(),
            url: "x-directplay:/provider=%7BEBFE7BA0-628D-11D2-AE0F-006097B01411%7D;hostname=127.0.0.1;port=" + peerPort,
            alternate: new Uint8Array(),
        }))).toBe(0);
        await until(() => server.host.entities.size === 2);
        expect(snapshot?.application.application).toBe(WIRE_APP_GUID);
        expect(await link.sendReliable(new TextEncoder().encode("ping"), 0)).toBe(0);
        await until(() => received.length === 1);
        expect(new TextDecoder().decode(received[0])).toBe("ping");
        expect(errors).toEqual([]);
    } finally {
        link.close(); await server.close();
        await new Promise<void>(resolve => peer.close(() => resolve()));
    }
}, 5000);

test("wire-host CLI supports addr-file without ready and releases the owned socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lan-wire-host-"));
    const addressFile = join(dir, "addr-host.txt"), readyFile = join(dir, "ready.txt");
    const driver = resolve(import.meta.dir, "../lan-conformance/probe/dp8-wire-host.ts");
    const child = Bun.spawn([process.execPath, "--no-env-file", driver, "--port", "0",
        "--addr-file", addressFile, "--ready", readyFile], {
        env: { ...process.env, BS_WIRE_HOST_IP: "127.0.0.1" }, stdout: "pipe", stderr: "pipe",
    });
    let port = 0;
    try {
        await until(() => existsSync(addressFile) || child.exitCode !== null);
        expect(child.exitCode).toBeNull();
        await until(() => existsSync(readyFile));
        expect(readFileSync(addressFile, "utf8")).toBe(readFileSync(readyFile, "utf8"));
        port = Number(readFileSync(addressFile, "utf8").trim().split(":")[1]);
        expect(port).toBeGreaterThan(0);
    } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
        rmSync(dir, { recursive: true, force: true });
    }
    const probe = createSocket("udp4");
    try { await new Promise<void>((resolve, reject) => {
        probe.once("error", reject); probe.bind(port, "0.0.0.0", resolve);
    }); } finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
}, 5000);
