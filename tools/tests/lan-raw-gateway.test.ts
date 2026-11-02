import { beforeAll, expect, test } from "bun:test";
import { createLanServer } from "../../packages/lan/src/server";
import { internetChecksum } from "../../packages/lan/src/icmp-nat";
import { parseIpv6 } from "../../packages/lan/src/ip-address";
import { buildNativeForTests, nativeTestHelper } from "../../packages/lan/native/testing";
import { ipv4RawPacket } from "../../src/worker/modules/wsa-raw";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { RelayLink } from "../../src/worker/net/relay-link";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, ipv6Address } from "../../src/worker/modules/wsa-network";

// Compiling the native helper can exceed the default 5 s hook budget under full-gate load.
beforeAll(buildNativeForTests, 120_000);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Timeout: " + label); await pause(5); }
}
function echo(id: number, sequence: number, family: 4 | 6): Uint8Array {
    const bytes = Uint8Array.of(family === 4 ? 8 : 128,0,0,0,id >>> 8,id & 255,sequence >>> 8,sequence & 255,11,22,33,44);
    if (family === 4) { const checksum = internetChecksum(bytes); bytes[2] = checksum >>> 8; bytes[3] = checksum; }
    return bytes;
}
function errorCode(fn: () => unknown): number {
    try { fn(); return 0; } catch (error) { if (error instanceof WsaFailure) return error.code; throw error; }
}
for (const transport of ["websocket", "polling"] as const) for (const family of [4,6] as const)
test("native raw ICMP" + family + " echo NAT preserves identifiers and isolates rooms over " + transport, async () => {
    const server = createLanServer({ port: 0, gateway: { nativeHelperPath: nativeTestHelper, routes: [
        { host: family === 4 ? "127.0.0.1" : "::1", address: family === 4 ? "203.0.113.80" : "2001:db8::80",
            protocols: ["raw"], ipProtocols: [family === 4 ? 1 : 58] },
    ] } });
    const port = await server.listen(), url = "http://127.0.0.1:" + port;
    const networks = [new LanNetwork(Uint8Array.of(2,0,0,8,0,1)), new LanNetwork(Uint8Array.of(2,0,0,8,0,2))];
    const links = networks.map((network, index) => new RelayLink(url, "raw" + index, network, { transports: [transport] }));
    networks.forEach((network, index) => network.attach(links[index]));
    const tables = networks.map(network => new WsaSocketTable(network));
    try {
        await Promise.all(links.map(link => link.ready));
        const destination = family === 4 ? ipv4Address(Uint8Array.of(203,0,113,80),0) : ipv6Address(parseIpv6("2001:db8::80")!,0);
        const sockets = tables.map(table => table.socket(3, family === 4 ? 2 : 23, family === 4 ? 1 : 58));
        // Exercise optional native per-packet TTL/TOS without forcing HDRINCL.
        tables.forEach((table,index) => { table.get(sockets[index]).ipOptionsChanged = true; table.get(sockets[index]).ipTtl = 17; table.get(sockets[index]).ipTos = 16; });
        tables.forEach((table,index) => expect(table.send(sockets[index], echo(0x1234,index + 1,family), destination)).toBe(12));
        await Promise.all(tables.map((table,index) => until(() => table.readable(sockets[index]), "native echo or explicit permission error")));
        // On a host that denies raw sockets, errors must surface through Winsock.
        const denied = tables.map((table,index) => table.get(sockets[index]).error);
        if (denied.some(Boolean)) {
            expect(denied.every(value => value === WSA.EACCES)).toBe(true);
            return;
        }
        for (let index=0;index<tables.length;index++) {
            const reply = tables[index].receive(sockets[index], 65535);
            const offset = family === 4 ? (reply.data[0] & 15) * 4 : 0;
            expect(reply.data[offset]).toBe(family === 4 ? 0 : 129);
            expect([...reply.data.subarray(offset + 4,offset + 8)]).toEqual([0x12,0x34,0,index + 1]);
            expect([...reply.data.subarray(offset + 8)]).toEqual([11,22,33,44]);
            expect(reply.from.port).toBe(0);
            if (family === 4) {
                expect(reply.data.slice(12,16)).toEqual(Uint8Array.of(203,0,113,80));
                expect(reply.data.slice(16,20)).toEqual(networks[index].ipv4);
                expect(internetChecksum(reply.data.subarray(0,offset))).toBe(0);
                expect(internetChecksum(reply.data.subarray(offset))).toBe(0);
            } else expect(reply.from.ip6).toEqual(parseIpv6("2001:db8::80")!);
        }
        await pause(100);
        expect(tables.map((table,index) => table.bytesAvailable(sockets[index]))).toEqual([0,0]);
        if (family === 4) {
            const headerSocket = tables[0].socket(3,2,1); tables[0].get(headerSocket).headerInclude = true;
            const packet = ipv4RawPacket(echo(0x7777,9,4),1,networks[0].ipv4,Uint8Array.of(203,0,113,80),123);
            expect(tables[0].send(headerSocket,packet,destination)).toBe(packet.length);
            await until(() => tables[0].readable(headerSocket), "native HDRINCL reply or explicit permission denial");
            if (tables[0].get(headerSocket).error) expect(tables[0].get(headerSocket).error).toBe(WSA.EACCES);
            else expect(tables[0].receive(headerSocket,65535).data.subarray(24,28)).toEqual(Uint8Array.of(0x77,0x77,0,9));
            tables[0].closesocket(headerSocket);
        }
        const deniedRoute = tables[0].socket(3, family === 4 ? 2 : 23, family === 4 ? 1 : 58);
        const deniedAddress = family === 4 ? ipv4Address(Uint8Array.of(203,0,113,81),0) : ipv6Address(parseIpv6("2001:db8::81")!,0);
        const immediate = errorCode(() => tables[0].send(deniedRoute, echo(2,3,family), deniedAddress));
        if (immediate) expect(immediate).toBe(WSA.EACCES);
        else { await until(() => !!tables[0].get(deniedRoute).error, "unconfigured raw destination denied"); expect(tables[0].get(deniedRoute).error).toBe(WSA.EACCES); }
    } finally { tables.forEach(table => table.reset()); networks.forEach(network => network.attach(null)); await server.close(); }
}, 25_000);
