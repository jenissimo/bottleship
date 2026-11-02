import { beforeEach, afterEach, expect, test } from "bun:test";
import { Process } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, FD_WRITE } from "../../src/worker/modules/wsa-network";
import { WsaActorKernel } from "../../src/worker/modules/wsa-actor-kernel";
import { makeSocketExports, makeSelect, WsaStartupCount } from "../../src/worker/modules/wsa-stub-shared";

// Independent native contracts: immutable692 n1738877145; stage29 pointer4882
// n1757525950 and alias365 n1757340870. These tests exercise real AddressSpace
// protections and shared physical actor state, rather than mocked option handlers.
const system = System.getInstance(), savedProcess = system.process;
const savedMem = Object.getOwnPropertyDescriptors(Mem);
const option = 0x20000, length = 0x22000, request = 0x24000;
const group = Uint8Array.of(239, 255, 42, 17), loop = Uint8Array.of(127, 0, 0, 1);
let ram: Uint8Array, space: AddressSpace, table: WsaSocketTable, api: ReturnType<typeof makeSocketExports>, socket: number, error: number;
const put = (p: number, value: number) => new DataView(ram.buffer).setUint32(p, value, true);
const get = (p: number) => new DataView(ram.buffer).getUint32(p, true);
const call = (name: string, args: number[]) => api[name]({} as never, ram, args);
const gets = (opt: number, cap = 4, ptr = option, lenPtr = length) => {
    ram.fill(0xa5, option, option + 8); put(length, cap);
    return call("getsockopt", [socket, 0, opt, ptr, lenPtr]);
};
const sets = (opt: number, value: number, count = 4) => { put(option, value); return call("setsockopt", [socket, 0, opt, option, count]); };
const member = (opt: number, count = 8) => call("setsockopt", [socket, 0, opt, request, count]);
beforeEach(() => {
    ram = new Uint8Array(2 << 20); space = new AddressSpace(() => ram);
    const owner = Object.create(Process.prototype) as Process;
    Object.assign(owner, { resetGeneration: 0, addressSpace: space, getMemory: () => ram, getCurrentMemory: () => ram, memory: {} });
    system.process = owner; Mem.bind(() => ram, (p, n, perms) => space.validateRange(p, n, perms));
    table = new WsaSocketTable(new LanNetwork()); const counter = new WsaStartupCount(); counter.startup();
    api = makeSocketExports(table, value => { error = value; }, counter);
    socket = table.socket(2, 2, 17); error = 0x1234; ram.set(group, request); ram.set(loop, request + 4);
});
afterEach(() => {
    table.reset(); system.process = savedProcess;
    for (const key of ["memoryGetter", "validateRange", "getRegion"]) Object.defineProperty(Mem, key, savedMem[key]!);
});
test("multicast defaults and short getsockopt preserve native byte capacities", () => {
    for (const [opt, value] of [[9, 0], [10, 1], [11, 1]]) {
        expect(gets(opt)).toBe(0); expect(error).toBe(0); expect(get(length)).toBe(4);
        expect(get(option)).toBe(value); expect(get(option + 4)).toBe(0xa5a5a5a5);
    }
    for (const cap of [1, 2, 3]) {
        expect(gets(10, cap)).toBe(0); expect(get(length)).toBe(1); expect(get(option)).toBe(0xa5a5a501);
    }
    expect(gets(9, 1)).toBe(-1); expect(error).toBe(WSA.EFAULT); expect(get(length)).toBe(0);
});
test("multicast TTL and LOOP normalize independently and interface retains the selected IPv4", () => {
    expect(sets(10, -1)).toBe(0); expect(gets(10)).toBe(0); expect(get(option)).toBe(255);
    for (const value of [-2, 256]) { expect(sets(10, value)).toBe(-1); expect(error).toBe(WSA.EINVAL); }
    expect(sets(11, 256)).toBe(0); expect(gets(11)).toBe(0); expect(get(option)).toBe(1);
    expect(sets(9, 0x0200007f)).toBe(0); expect(gets(9)).toBe(0); expect(get(option)).toBe(0x0200007f);
    expect(sets(9, 0x017100cb)).toBe(-1); expect(error).toBe(WSA.EADDRNOTAVAIL);
    expect(gets(9)).toBe(0); expect(get(option)).toBe(0x0200007f);
});
test("membership errors and canonical loopback interfaces match native physical keys", () => {
    expect(member(13)).toBe(-1); expect(error).toBe(WSA.EADDRNOTAVAIL);
    expect(member(12, 7)).toBe(-1); expect(error).toBe(WSA.EFAULT);
    expect(member(12)).toBe(0); ram.set([127, 0, 0, 2], request + 4);
    expect(member(12)).toBe(-1); expect(error).toBe(WSA.EINVAL);
    expect(member(13)).toBe(0); expect(member(13)).toBe(-1); expect(error).toBe(WSA.EADDRNOTAVAIL);
    expect(gets(12)).toBe(-1); expect(error).toBe(WSA.ENOPROTOOPT); expect(get(length)).toBe(0); expect(get(option)).toBe(0xa5a5a5a5);
});
test("bad multicast output zeroes writable length but NULL output preserves it", () => {
    expect(space.protect(option, 4096, "r", 2)).toBe(true);
    expect(gets(10)).toBe(-1); expect(error).toBe(WSA.EFAULT); expect(get(length)).toBe(0); expect(get(option)).toBe(0xa5a5a5a5);
    expect(space.protect(option, 4096, "rw", 4)).toBe(true);
    expect(gets(10, 4, 0)).toBe(-1); expect(error).toBe(WSA.EFAULT); expect(get(length)).toBe(4);
});
test("multicast output is published before a readonly length copyback failure", () => {
    put(length, 4); expect(space.protect(length, 4096, "r", 2)).toBe(true);
    ram.fill(0xa5, option, option + 8);
    expect(call("getsockopt", [socket, 0, 10, option, length])).toBe(-1);
    expect(error).toBe(WSA.EFAULT); expect(get(length)).toBe(4);
    expect(get(option)).toBe(1); expect(get(option + 4)).toBe(0xa5a5a5a5);
});
test("multicast pointer probing precedes TCP option rejection, invalid socket precedes all pointers", () => {
    table.closesocket(socket); socket = table.socket(1, 2, 6);
    expect(gets(10)).toBe(-1); expect(error).toBe(WSA.EINVAL); expect(get(length)).toBe(0);
    put(length, 4); expect(call("getsockopt", [socket, 0, 10, 0, length])).toBe(-1); expect(error).toBe(WSA.EFAULT); expect(get(length)).toBe(4);
    expect(call("setsockopt", [socket, 0, 10, 0, 4])).toBe(-1); expect(error).toBe(WSA.EFAULT);
    expect(call("getsockopt", [0x12345678, 0, 10, 0, 0])).toBe(-1); expect(error).toBe(WSA.ENOTSOCK);
});
test("duplicated aliases share physical multicast options and membership, including reserved cleanup", () => {
    const kernel = new WsaActorKernel(table), owner = { pid: 201, slot: 0, epoch: 1 };
    kernel.register(owner);
    const source = kernel.execute(owner, "socket", [2, 2, 17]) as number;
    kernel.execute(owner, "setMulticastOption", [source, 10, 19]);
    kernel.execute(owner, "setMulticastOption", [source, 11, 0]);
    kernel.execute(owner, "changeMulticastMembership", [source, group, loop, true]);
    const alias = kernel.execute(owner, "duplicate", [source, owner.pid]) as number;
    kernel.execute(owner, "reset", []); // The reserved OS alias is not yet Winsock-imported.
    kernel.execute(owner, "import", [alias]);
    expect(kernel.execute(owner, "getMulticastOption", [alias, 10])).toBe(19);
    expect(kernel.execute(owner, "getMulticastOption", [alias, 11])).toBe(0);
    expect(() => kernel.execute(owner, "changeMulticastMembership", [alias, group, loop, true])).toThrow(WsaFailure);
    kernel.execute(owner, "changeMulticastMembership", [alias, group, loop, false]);
    kernel.execute(owner, "closesocket", [alias]);
    const fresh = kernel.execute(owner, "socket", [2, 2, 17]) as number;
    expect(kernel.execute(owner, "getMulticastOption", [fresh, 10])).toBe(1);
    expect(() => kernel.execute(owner, "changeMulticastMembership", [fresh, group, loop, false])).toThrow(WsaFailure);
    kernel.drop(owner, false);
});

test("membership getsockopt is unsupported even on TCP after valid buffer probing", () => {
    table.closesocket(socket); socket = table.socket(1, 2, 6);
    expect(gets(12)).toBe(-1); expect(error).toBe(WSA.ENOPROTOOPT); expect(get(length)).toBe(0);
});
test("TCP zero-length multicast input still reaches provider rejection for non-NULL buffers", () => {
    table.closesocket(socket); socket = table.socket(1, 2, 6);
    put(option, 1);
    expect(call("setsockopt", [socket, 0, 10, option, 0])).toBe(-1); expect(error).toBe(WSA.EINVAL);
    expect(call("setsockopt", [socket, 0, 10, 0, 0])).toBe(-1); expect(error).toBe(WSA.EFAULT);
});
test("multicast probes the entire caller capacity, including unused trailing bytes", () => {
    const tail = option + 4092; put(tail, 0xa5a5a5a5); put(length, 8);
    expect(space.protect(option + 4096, 4096, "r", 2)).toBe(true);
    expect(call("getsockopt", [socket, 0, 10, tail, length])).toBe(-1); expect(error).toBe(WSA.EFAULT);
    expect(get(tail)).toBe(0xa5a5a5a5); expect(get(length)).toBe(0);
    expect(space.protect(option + 4096, 4096, "noaccess", 1)).toBe(true);
    put(tail, 7); expect(call("setsockopt", [socket, 0, 10, tail, 8])).toBe(-1); expect(error).toBe(WSA.EFAULT);
    expect(gets(10)).toBe(0); expect(get(option)).toBe(1);
});
test("wsock32 legacy IP options map to the shared Winsock2 provider without changing its namespace", () => {
    const counter = new WsaStartupCount(); counter.startup();
    const legacy = makeSocketExports(table, value => { error = value; }, counter, undefined, true);
    put(option, 7);
    expect(legacy.setsockopt({} as never, ram, [socket, 0, 3, option, 4])).toBe(0);
    expect(gets(10)).toBe(0); expect(get(option)).toBe(7);
    expect(legacy.setsockopt({} as never, ram, [socket, 0, 5, request, 8])).toBe(0);
    expect(member(12)).toBe(-1); expect(error).toBe(WSA.EINVAL);
    expect(legacy.setsockopt({} as never, ram, [socket, 0, 6, request, 8])).toBe(0);
});

test("native local receive phases filter group/interface and LOOP before queue admission", () => {
    const port = 48431, groupH = Uint8Array.of(239, 255, 42, 18), receivers: number[] = [];
    for (let i = 0; i < 3; i++) { const sid = table.socket(2); table.get(sid).reuse = true; table.bind(sid, ipv4Address(new Uint8Array(4), port)); receivers.push(sid); }
    const [a, b, c] = receivers;
    table.setMulticastOption(socket, 9, 0x0100007f); table.setMulticastOption(socket, 10, 0);
    table.changeMulticastMembership(a, group, loop, true); table.changeMulticastMembership(b, groupH, loop, true);
    const phase = (marker: number, destination: Uint8Array, expected: number[]) => {
        expect(table.send(socket, Uint8Array.of(marker), ipv4Address(destination, port))).toBe(1);
        for (const receiver of receivers) {
            expect(table.readable(receiver)).toBe(expected.includes(receiver));
            if (expected.includes(receiver)) { const packet = table.receive(receiver, 8); expect([...packet.data]).toEqual([marker]); expect(packet.from.ip).toEqual(loop); }
        }
    };
    phase(65, group, [a]); phase(66, groupH, [b]);
    table.changeMulticastMembership(b, group, loop, true); phase(67, group, [a, b]);
    table.setMulticastOption(a, 11, 0); phase(68, group, [b]);
    table.setMulticastOption(socket, 11, 0); phase(69, group, [b]);
    table.setMulticastOption(a, 11, 1); table.setMulticastOption(socket, 11, 1);
    table.changeMulticastMembership(a, group, loop, false); phase(70, group, [b]);
    table.changeMulticastMembership(b, group, loop, false); phase(71, group, []);
    expect(table.readable(c)).toBe(false);
});
test("connected multicast keeps local interface and TTL0 delivery after relay loss", () => {
    for (const localInterface of [true, false]) {
        const network = new LanNetwork(), sockets = new WsaSocketTable(network);
        const receiver = sockets.socket(2), sender = sockets.socket(2), port = 48433;
        sockets.bind(receiver, ipv4Address(new Uint8Array(4), port));
        sockets.changeMulticastMembership(receiver, group, localInterface ? loop : new Uint8Array(4), true);
        if (localInterface) sockets.setMulticastOption(sender, 9, 0x0100007f);
        else sockets.setMulticastOption(sender, 10, 0);
        network.setConnected(true); sockets.connect(sender, ipv4Address(group, port));
        network.setConnected(false, "relay lost");
        try {
            expect(sockets.send(sender, Uint8Array.of(29))).toBe(1);
            expect(sockets.receive(receiver, 1).data).toEqual(Uint8Array.of(29));
            expect(sockets.get(sender).error).toBe(0);
        } finally { sockets.reset(); }
    }
});
test("relay loss retires a refused datagram write latch and publishes local FD_WRITE", () => {
    const destination = ipv4Address(group, 48434), callbacks: number[] = [];
    table.network.attach({ send() { return false; }, close() {} });
    table.network.configureMulticast4(true);
    table.connect(socket, destination);
    table.configureEvents(socket, FD_WRITE, bit => callbacks.push(bit));
    expect(table.enumEvents(socket).mask).toBe(FD_WRITE); callbacks.length = 0;
    let code = 0;
    try { table.send(socket, Uint8Array.of(30)); } catch (e) { if (!(e instanceof WsaFailure)) throw e; code = e.code; }
    expect(code).toBe(WSA.EWOULDBLOCK); expect(table.writable(socket)).toBe(false);
    expect(table.enumEvents(socket).mask).toBe(0);
    table.network.setConnected(false, "relay refused then disconnected");
    expect(table.writable(socket)).toBe(true);
    expect(table.enumEvents(socket).mask).toBe(FD_WRITE); expect(callbacks).toEqual([FD_WRITE]);
    put(request, 1); put(request + 4, socket);
    expect(makeSelect(table, value => { error = value; })({} as never, ram, [0, 0, request, 0, 0])).toBe(1);
    expect(get(request)).toBe(1); expect(get(request + 4)).toBe(socket);
    const receiver = table.socket(2); table.bind(receiver, ipv4Address(new Uint8Array(4), destination.port));
    table.changeMulticastMembership(receiver, group, new Uint8Array(4), true);
    expect(table.send(socket, Uint8Array.of(31))).toBe(1);
    expect(table.receive(receiver, 1).data).toEqual(Uint8Array.of(31));
});
test("unconnected multicast and broadcast retire old relay backpressure on disconnect", () => {
    for (const multicast of [true, false]) {
        const network = new LanNetwork(), sockets = new WsaSocketTable(network);
        const sid = sockets.socket(2), receiver = sockets.socket(2), port = 48435;
        const destination = ipv4Address(multicast ? group : new Uint8Array(4).fill(255), port);
        network.attach({ send() { return false; }, close() {} }); network.configureMulticast4(true);
        sockets.bind(receiver, ipv4Address(new Uint8Array(4), port)); sockets.get(sid).broadcast = true;
        if (multicast) sockets.changeMulticastMembership(receiver, group, new Uint8Array(4), true);
        sockets.configureEvents(sid, FD_WRITE); sockets.enumEvents(sid);
        let code = 0;
        try { sockets.send(sid, Uint8Array.of(32), destination); } catch (e) { if (!(e instanceof WsaFailure)) throw e; code = e.code; }
        expect(code).toBe(WSA.EWOULDBLOCK); expect(sockets.writable(sid)).toBe(false);
        try {
            network.setConnected(false, "relay lost"); expect(sockets.writable(sid)).toBe(true);
            expect(sockets.enumEvents(sid).mask).toBe(FD_WRITE);
            expect(sockets.send(sid, Uint8Array.of(33), destination)).toBe(1);
            expect(sockets.receive(receiver, 1).data).toEqual(Uint8Array.of(33));
        } finally { sockets.reset(); }
    }
});
test("unimplemented RAW multicast is terminal rather than waiting for a transport drain", () => {
    const raw = table.socket(3, 2, 1); table.network.setConnected(true);
    const code = () => { try { table.send(raw, Uint8Array.of(8, 0, 0, 0), ipv4Address(group, 0)); return 0; } catch (e) { if (!(e instanceof WsaFailure)) throw e; return e.code; } };
    expect(code()).toBe(WSA.EOPNOTSUPP); expect(table.get(raw).writeBlocked).toBe(false);
    expect(table.get(raw).local).toBeNull();
});
test("native TCP class-D connect auto-binds then signals asynchronous address failure", async () => {
    const tcp = table.socket(1, 2, 6); table.setNonBlocking(tcp, true);
    table.network.setConnected(true);
    let code = 0; try { table.connect(tcp, ipv4Address(group, 48449)); } catch (e) { if (!(e instanceof WsaFailure)) throw e; code = e.code; }
    expect(code).toBe(WSA.EWOULDBLOCK); expect(table.get(tcp).local?.port).toBeGreaterThan(0);
    expect(table.get(tcp).local?.ip).toEqual(new Uint8Array(4));
    await Promise.resolve();
    expect(table.get(tcp).state).toBe("failed"); expect(table.get(tcp).error).toBe(WSA.EADDRNOTAVAIL);
    expect(table.get(tcp).local?.ip).toEqual(new Uint8Array(4)); expect(table.writable(tcp)).toBe(false);
});
test("unsupported online multicast capability returns immediately without a local copy", () => {
    const receiver = table.socket(2), port = 48432; table.bind(receiver, ipv4Address(new Uint8Array(4), port));
    table.changeMulticastMembership(receiver, group, new Uint8Array(4), true);
    let sends = 0; table.network.attach({ send() { sends++; return true; }, close() {} });
    ram.fill(0, request, request + 16); ram[request] = 2; ram[request + 2] = port >>> 8; ram[request + 3] = port & 255; ram.set(group, request + 4); ram[option] = 1;
    for (const nonblocking of [false, true]) {
        table.setNonBlocking(socket, nonblocking);
        const result = call("sendto", [socket, option, 1, 0, request, 16]);
        expect(result).toBe(-1); expect(result).not.toBeInstanceOf(Promise); expect(error).toBe(WSA.EOPNOTSUPP);
        expect(table.readable(receiver)).toBe(false); expect(sends).toBe(0);
    }
    table.setMulticastOption(socket, 10, 0);
    expect(call("sendto", [socket, option, 1, 0, request, 16])).toBe(1);
    expect(table.receive(receiver, 1).data).toEqual(Uint8Array.of(1)); expect(sends).toBe(0);
    table.setMulticastOption(socket, 10, 1); table.network.attach(null);
    expect(call("sendto", [socket, option, 1, 0, request, 16])).toBe(1);
    expect(table.receive(receiver, 1).data).toEqual(Uint8Array.of(1));
});
