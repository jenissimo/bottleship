import { afterEach, beforeEach, expect, test } from "bun:test";
import { RootNetworkNamespace } from "../../src/worker/core/network-namespace";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { createWsaActorTable, type WsaActorTable } from "../../src/worker/modules/wsa-actor-table";
import { WsaFailure, WSA, ipv4Address } from "../../src/worker/modules/wsa-network";
import { createWsaApiFixture } from "./fixtures/wsa-api-context";

// SAME native PE TCP destination97 n1759551511: initial NB error35 at
// observations16/47/78; eventual SO_ERROR49. The actor must not collapse the
// committed pending result into a later completion merely because it is fast.
const address = 0x20000, arg = 0x22000, optlen = 0x22010;
const group = Uint8Array.of(239, 255, 44, 29), port = 48449;
let sequence = 0, namespace: RootNetworkNamespace, table: WsaActorTable;
let fixture: ReturnType<typeof createWsaApiFixture>, socket: number;
function pending(operation: () => unknown): number {
    try { operation(); throw Error("Expected pending connect"); }
    catch (error) { if (!(error instanceof WsaFailure)) throw error; return error.code; }
}
beforeEach(async () => {
    const network = new LanNetwork();
    namespace = new RootNetworkNamespace(network, 8, 30100 + (++sequence));
    await namespace.barrier();
    table = createWsaActorTable(network, () => namespace.socketActorClient());
    fixture = createWsaApiFixture(table, 0x1234); socket = table.socket();
    fixture.ram[address] = 2; fixture.ram[address + 2] = port >>> 8; fixture.ram[address + 3] = port & 255;
    fixture.ram.set(group, address + 4);
});
afterEach(async () => {
    try { fixture?.dispose(); } finally { await namespace?.close(); }
});
test("actual actor provider commits pending35 before exposing final49", () => {
    table.setNonBlocking(socket, true);
    expect(pending(() => table.connect(socket, ipv4Address(group, port)))).toBe(WSA.EWOULDBLOCK);
    expect(table.get(socket).state).toBe("failed"); expect(table.get(socket).error).toBe(WSA.EADDRNOTAVAIL);
    expect(table.get(socket).local?.port).toBeGreaterThan(0);
});
for (const mode of ["unbound", "any", "loopback"] as const)
    test("nonblocking ABI connect preserves actor pending result for " + mode, () => {
        if (mode !== "unbound")
            table.bind(socket, ipv4Address(mode === "any" ? Uint8Array.of(0, 0, 0, 0) : Uint8Array.of(127, 0, 0, 1), 0));
        table.setNonBlocking(socket, true);
        expect(fixture.api.connect({} as never, fixture.ram, [socket, address, 16])).toBe(-1);
        const connectError = fixture.error();
        expect(table.get(socket).state).toBe("failed"); expect(table.get(socket).error).toBe(WSA.EADDRNOTAVAIL);
        expect(table.get(socket).local?.port).toBeGreaterThan(0);
        expect(connectError).toBe(WSA.EWOULDBLOCK); expect(fixture.error(2)).toBe(0x2222);
    });
test("blocking ABI connect still reports the completed provider failure", async () => {
    const result = await fixture.api.connect({} as never, fixture.ram, [socket, address, 16]);
    expect(typeof result === "number" ? result : result.value).toBe(-1);
    expect(fixture.error()).toBe(WSA.EADDRNOTAVAIL); expect(fixture.error(2)).toBe(0x2222);
    expect(table.get(socket).local?.port).toBeGreaterThan(0);
});
test("connect parses the original address before validating the socket", () => {
    expect(fixture.api.connect({} as never, fixture.ram, [0x12345678, 0, 16])).toBe(-1);
    expect(fixture.error()).toBe(WSA.EFAULT);
    expect(fixture.api.connect({} as never, fixture.ram, [0x12345678, address, 16])).toBe(-1);
    expect(fixture.error()).toBe(WSA.ENOTSOCK);
    expect(table.get(socket).local).toBeNull();
});
test("FIONBIO success clears LastError after changing the actual actor socket", () => {
    fixture.put(arg, 1);
    expect(fixture.api.ioctlsocket({} as never, fixture.ram, [socket, 0x8004667e, arg])).toBe(0);
    expect(table.get(socket).nonBlocking).toBe(true); expect(fixture.get(arg)).toBe(1);
    expect(fixture.error()).toBe(0); expect(fixture.error(2)).toBe(0x2222);
    fixture.put(arg, 0); fixture.seed(0x1234);
    expect(fixture.api.ioctlsocket({} as never, fixture.ram, [socket, 0x8004667e, arg])).toBe(0);
    expect(table.get(socket).nonBlocking).toBe(false); expect(fixture.error()).toBe(0);
});
test("SO_ERROR success clears LastError while consuming the physical pending error once", () => {
    expect(pending(() => table.connect(socket, ipv4Address(group, port)))).toBe(WSA.EWOULDBLOCK);
    expect(table.get(socket).pendingError).toBe(WSA.EADDRNOTAVAIL);
    fixture.put(optlen, 4); fixture.put(arg, 0xa5a5a5a5);
    expect(fixture.api.getsockopt({} as never, fixture.ram, [socket, 0xffff, 0x1007, arg, optlen])).toBe(0);
    expect(fixture.get(arg)).toBe(WSA.EADDRNOTAVAIL); expect(fixture.get(optlen)).toBe(4);
    expect(table.get(socket).pendingError).toBe(0);
    expect(fixture.error()).toBe(0); expect(fixture.error(2)).toBe(0x2222);
    fixture.seed(0x1234);
    expect(fixture.api.getsockopt({} as never, fixture.ram, [socket, 0xffff, 0x1007, arg, optlen])).toBe(0);
    expect(fixture.get(arg)).toBe(0); expect(fixture.error()).toBe(0);
});
test("invalid FIONBIO and SO_ERROR preserve exact pointer errors and state", () => {
    expect(fixture.api.ioctlsocket({} as never, fixture.ram, [socket, 0x8004667e, 0])).toBe(-1);
    expect(fixture.error()).toBe(WSA.EFAULT); expect(table.get(socket).nonBlocking).toBe(false);
    fixture.put(optlen, 3); fixture.put(arg, 0xa5a5a5a5); fixture.seed(0x1234);
    expect(fixture.api.getsockopt({} as never, fixture.ram, [socket, 0xffff, 0x1007, arg, optlen])).toBe(-1);
    expect(fixture.error()).toBe(WSA.EFAULT); expect(fixture.get(arg)).toBe(0xa5a5a5a5); expect(fixture.get(optlen)).toBe(3);
});
