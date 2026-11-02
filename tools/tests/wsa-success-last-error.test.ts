import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ThunkResult } from "../../src/worker/core/thunking/thunk-dispatcher";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { WsaSocketTable, WSA, ipv4Address } from "../../src/worker/modules/wsa-network";
import { createWsaApiFixture } from "./fixtures/wsa-api-context";

// SAME native PE multicast692 n1738877145: successful bind observations373/377/379/382;
// tags4000..4062 record select success with both readiness and timeout.
const address = 0x20000, fdset = 0x22000, timeout = 0x24000, port = 48436;
let fixture: ReturnType<typeof createWsaApiFixture>, socket: number;
beforeEach(() => {
    fixture = createWsaApiFixture(new WsaSocketTable(new LanNetwork()));
    socket = fixture.table.socket(2);
    fixture.ram[address] = 2; fixture.ram[address + 2] = port >>> 8; fixture.ram[address + 3] = port & 255;
    fixture.put(timeout, 0); fixture.put(timeout + 4, 0);
    fixture.put(fdset, 1); fixture.put(fdset + 4, socket);
});
afterEach(() => { fixture.dispose(); });
test("successful bind clears the issuing thread error after real address validation", () => {
    expect(fixture.api.bind({} as never, fixture.ram, [socket, address, 16])).toBe(0);
    expect(fixture.table.get(socket).local?.port).toBe(port); expect(fixture.error(2)).toBe(0x2222);
    expect(fixture.error(1)).toBe(0);
});
test("select immediate readiness clears LastError without consuming data", () => {
    const { table } = fixture; table.bind(socket, ipv4Address(table.network.ipv4, port));
    const sender = table.socket(2); table.send(sender, Uint8Array.of(7), ipv4Address(table.network.ipv4, port));
    expect(fixture.select({} as never, fixture.ram, [0, fdset, 0, 0, timeout])).toBe(1);
    expect(fixture.get(fdset)).toBe(1); expect(fixture.get(fdset + 4)).toBe(socket);
    expect(table.receive(socket, 1).data).toEqual(Uint8Array.of(7)); expect(fixture.error(2)).toBe(0x2222);
    expect(fixture.error(1)).toBe(0);
});
test("select zero timeout clears LastError and publishes an empty fd_set", () => {
    expect(fixture.select({} as never, fixture.ram, [0, fdset, 0, 0, timeout])).toBe(0);
    expect(fixture.get(fdset)).toBe(0); expect(fixture.error(2)).toBe(0x2222); expect(fixture.error(1)).toBe(0);
});
test("parked select readiness clears only the captured owner error", async () => {
    const { table } = fixture; table.bind(socket, ipv4Address(table.network.ipv4, port));
    const pending = fixture.select({} as never, fixture.ram, [0, fdset, 0, 0, 0]);
    expect(pending).toBeInstanceOf(Promise);
    fixture.thread(2);
    const sender = table.socket(2); table.send(sender, Uint8Array.of(8), ipv4Address(table.network.ipv4, port));
    const result = await pending as ThunkResult; expect(result.value).toBe(1); fixture.apply(result);
    expect(fixture.get(fdset)).toBe(1); expect(fixture.get(fdset + 4)).toBe(socket); expect(fixture.error(2)).toBe(0x2222);
    expect(fixture.error(1)).toBe(0);
});
test("parked select timeout clears only the captured owner error", async () => {
    fixture.put(timeout + 4, 1000);
    const pending = fixture.select({} as never, fixture.ram, [0, fdset, 0, 0, timeout]);
    expect(pending).toBeInstanceOf(Promise);
    fixture.thread(2);
    const result = await pending as ThunkResult; expect(result.value).toBe(0); fixture.apply(result);
    expect(fixture.get(fdset)).toBe(0); expect(fixture.error(2)).toBe(0x2222); expect(fixture.error(1)).toBe(0);
});
test("invalid socket failures still publish the exact Winsock error", () => {
    expect(fixture.api.bind({} as never, fixture.ram, [0x12345678, address, 16])).toBe(-1);
    expect(fixture.error()).toBe(WSA.ENOTSOCK);
    fixture.seed(12345); fixture.put(fdset + 4, 0x12345678);
    expect(fixture.select({} as never, fixture.ram, [0, fdset, 0, 0, timeout])).toBe(-1);
    expect(fixture.error()).toBe(WSA.ENOTSOCK); expect(fixture.error(2)).toBe(0x2222);
});
test("parked select cancellation keeps its failure and foreign thread isolation", async () => {
    const pending = fixture.select({} as never, fixture.ram, [0, fdset, 0, 0, 0]);
    expect(pending).toBeInstanceOf(Promise);
    fixture.thread(2); fixture.table.reset();
    const result = await pending as ThunkResult;
    expect(result.value).toBe(-1); expect(fixture.error(1)).toBe(WSA.EINTR); expect(fixture.error(2)).toBe(0x2222);
});
