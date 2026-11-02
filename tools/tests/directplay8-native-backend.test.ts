import { afterEach, expect, test } from "bun:test";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { NativeDirectPlayChannel } from "../../src/worker/modules/dpnet/native-wire/channel";
import { decodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { decodeNativePlayerConnect, encodeNativeCoreConnectInfo, decodeNativeCoreConnectInfo } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { nativeCoreWords, decodeNativeCoreOperation, encodeNativeCoreRequest } from "../../src/worker/modules/dpnet/native-wire/core-operations";
import { DirectPlay8Session } from "../../src/worker/modules/dpnet/peer";
import { DPN } from "../../src/worker/modules/dpnet/constants";
import type { SessionDesc } from "../../src/worker/modules/dplayx/session";
const app = "11223344556677889900aabbccddeeff", instance = "1234567890abcdef1234567890abcdef";
const desc: SessionDesc = { instance: "0".repeat(32), application: app, name: "", password: "", maxPlayers: 0, flags: 0, user: [0, 0, 0, 0], extended: { flags: 0, reserved: [], application: [] } };
const cleanup: (() => void)[] = []; afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function pair() {
    const nets = [1, 2].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, n)));
    for (const net of nets) net.attach({ send(frame) { const dg = decodeDatagram(frame)!; const remote = nets.find(n => n !== net && n.isSelf(dg.node)); remote?.receiveFrame(encodeDatagram(dg.proto, net.node, dg.dstPort, dg.srcPort, dg.payload)); return true; }, close() {} });
    cleanup.push(() => nets.forEach(n => n.attach(null)));
    return nets;
}
function host(network: LanNetwork, configure: { badApplication?: boolean; fail?: number; reply?: Uint8Array; groups?: boolean; holdProcessed?: boolean } = {}) {
    let peerNode = new Uint8Array(6), peerPort = 0, requests = 0, raw: Uint8Array[] = [], processed: number[] = [], outboundProcessed: number[] = [];
    const link = new NativeReliableLink({ send(bytes) { return network.send(2308, peerNode, peerPort, bytes, PROTO_UDP); },
        onMessage(message) {
            const view = new DataView(message.payload.buffer, message.payload.byteOffset, message.payload.byteLength);
            if (!(message.command & 0x40)) { raw.push(message.payload.slice()); void link.sendReliable(message.payload, 0); return; }
            const command = view.getUint32(0, true);
            if (command === 0xc1) {
                const player = decodeNativePlayerConnect(message.payload)!; expect(player.name).toBe("Игрок"); expect([...player.data]).toEqual([1, 0, 9]); expect([...player.connectData]).toEqual([3, 0, 7]);
                if (configure.fail) { const bytes = new Uint8Array(16 + (configure.reply?.length ?? 0)); bytes.set(nativeCoreWords(0xc5, configure.fail, configure.reply?.length ? 12 : 0, configure.reply?.length ?? 0)); bytes.set(configure.reply ?? [], 16); void link.sendReliable(bytes); return; }
                const packet = encodeNativeCoreConnectInfo({ localId: 8, version: 3, unused: 0, reply: Uint8Array.of(5, 0, 6),
                    application: { flags: 0, maxPlayers: 7, players: 2, name: "Сессия", password: null, reserved: new Uint8Array(), applicationData: Uint8Array.of(3, 5, 7), application: configure.badApplication ? "f".repeat(32) : app, instance },
                    entries: [{ id: 7, owner: 0, flags: 0x102, version: 2, unused: 0, coreVersion: 7, name: "Хост", data: new Uint8Array(), url: null },
                        { id: 8, owner: 0, flags: 0x100, version: 3, unused: 0, coreVersion: 2, name: player.name, data: player.data, url: null },
                        ...(configure.groups ? [
                            { id: 20, owner: 0, flags: 0x14, version: 1, unused: 0, coreVersion: 2, name: null, data: new Uint8Array(), url: null },
                            { id: 21, owner: 7, flags: 0x10, version: 1, unused: 0, coreVersion: 2, name: "Обычная", data: Uint8Array.of(1), url: null },
                            { id: 22, owner: 7, flags: 0x50, version: 2, unused: 0, coreVersion: 2, name: "Авто", data: Uint8Array.of(2), url: null },
                        ] : [])], members: configure.groups ? [{ group: 20, player: 8, version: 1, unused: 0 }, { group: 22, player: 8, version: 2, unused: 0 }] : [] });
                expect(decodeNativeCoreConnectInfo(packet)?.localId).toBe(8); void link.sendReliable(packet);
            } else if (command === 0xc3) void link.sendReliable(nativeCoreWords(0xc6, 8, 4, 0));
            else if (command === 0xc9) void link.sendReliable(nativeCoreWords(0xca, view.getUint32(4, true), 0));
            else if (command === 0xd6) {
                requests++; const id = view.getUint32(4, true), packet = new Uint8Array(4 + 40 + 4); packet.set(nativeCoreWords(0xdb, 8, 5, 0, 2, 0, 0, 40, 4, 8, id)); packet.set([9, 0, 8, 7], 44);
                void link.sendReliable(packet);
            } else if (command === 0xe1) processed.push(view.getUint32(4, true));
            else if (command === 0xe0) { const id = view.getUint32(4, true); outboundProcessed.push(id); raw.push(message.payload.slice(8)); if (!configure.holdProcessed) void link.sendReliable(nativeCoreWords(0xe1, id)); }
        } });
    network.bind(2308, { deliver(dg) { peerNode = Uint8Array.from(dg.srcNode); peerPort = dg.srcPort; link.receive(dg.data); } }, PROTO_UDP); link.listen();
    cleanup.push(() => link.close()); return { link, raw, processed, outboundProcessed, get requests() { return requests; } };
}
test("native backend joins with a real binary channel, preserves metadata, sends fragmented user data and closes both directions", async () => {
    const [client, server] = pair(), h = host(server), core = new NativeDirectPlayCore(client, "peer", 300, 2);
    cleanup.push(() => core.dispose());
    expect(await core.connect({ node: [...server.node], port: 2308 }, desc, { name: { short: "Игрок", long: "" }, data: [1, 0, 9], flags: 0 }, Uint8Array.of(3, 0, 7))).toBe(0);
    expect(core.localId).toBe(8); expect(core.hostId).toBe(7); expect(core.openError).toBe(0); expect(core.desc?.name).toBe("Сессия");
    expect([...core.entities.keys()]).toEqual([8, 7]); expect([...core.joinReply!.data!]).toEqual([5, 0, 6]);
    const bytes = Uint8Array.from({ length: 4001 }, (_, i) => i & 255), sent = core.sendDpn(7, 8, bytes); bytes.fill(255);
    expect(await sent).toBe(0); expect(h.raw[0]?.length).toBe(4001); expect(h.raw[0][256]).toBe(0); expect(core.queue[0]?.data).toEqual(h.raw[0]); core.removeMessage(0);
    expect((await core.mutate({ op: "mutate", action: "info", id: 8, data: [9, 0, 8, 7] })).hr).toBe(0);
    expect(h.requests).toBe(1); expect(core.entities.get(8)?.data).toEqual([9, 0, 8, 7]);
    expect(await core.sendDpn(7, 0xc, Uint8Array.of(0, 4, 0))).toBe(0); expect([...h.raw[1]]).toEqual([0, 4, 0]);
    expect(await core.shutdown()).toBe(0); expect(core.entities.size).toBe(0); expect(h.link.state).toBe("closed");
});
test("native backend preserves C5 error/reply and does not install a different application snapshot", async () => {
    for (const badApplication of [false, true]) {
        const [client, server] = pair(); host(server, badApplication ? { badApplication } : { fail: DPN.INVALIDPASSWORD, reply: Uint8Array.of(7, 0, 1) });
        const core = new NativeDirectPlayCore(client, "peer", 25, 2); cleanup.push(() => core.dispose());
        expect(await core.connect({ node: [...server.node], port: 2308 }, desc, { name: { short: "Игрок", long: "" }, data: [1, 0, 9], flags: 0 }, Uint8Array.of(3, 0, 7))).toBe(badApplication ? DPN.TIMEDOUT : DPN.INVALIDPASSWORD);
        expect(core.entities.size).toBe(0); expect(core.desc).toBeNull(); expect(client.isBound(2302, PROTO_UDP)).toBe(false);
        if (!badApplication) expect([...core.joinReply!.data!]).toEqual([7, 0, 1]);
    }
});
test("session backend boundary announces local then host with local context; native state never uses custom send", async () => {
    const [client, server] = pair(); const h = host(server), session = new DirectPlay8Session(client);
    cleanup.push(() => session.dispose()); expect(session.initialize()).toBe(0);
    await session.setInfo(0, { name: "Игрок", data: [1, 0, 9], flags: 0 }, 3);
    const events: number[] = []; session.onEvent = event => { if (event.type === 7) { events.push(event.id!); if (event.id === session.localId) expect(event.context).toBe(0x1234); } };
    expect(await session.connectNative({ node: [...server.node], port: 2308 }, desc, 0x1234, Uint8Array.of(3, 0, 7), 0, [20, 0, 2, 14, 300])).toBe(0);
    expect(events).toEqual([8, 7]); expect(session.hostId).toBe(7); expect(session.virtualProvider.desc).toBeNull();
    expect(await session.send(7, 8, Uint8Array.of(0, 1, 0))).toBe(0); expect(h.raw[0]).toEqual(Uint8Array.of(0, 1, 0));
    expect(await session.beginClose()).toBe(0); session.close(); expect(session.engine.entities.size).toBe(0);
});
test("C2 snapshot preserves auto-destruct groups and memberships while keeping the service all-players group private", async () => {
    const [client, server] = pair(); host(server, { groups: true }); const session = new DirectPlay8Session(client);
    cleanup.push(() => session.dispose()); expect(session.initialize()).toBe(0);
    await session.setInfo(0, { name: "Игрок", data: [1, 0, 9], flags: 0 }, 3);
    const created: number[] = []; session.onEvent = event => { if (event.type === 6 || event.type === 7) created.push(event.id!); };
    expect(await session.connectNative({ node: [...server.node], port: 2308 }, desc, 0, Uint8Array.of(3, 0, 7), 0, [20, 0, 2, 14, 300])).toBe(0);
    expect(created).toEqual([21, 22, 8, 7]); expect([...session.engine.entities.keys()]).toEqual([21, 22, 8, 7]);
    expect(session.engine.entities.get(21)).toMatchObject({ group: true, flags: 0, name: { short: "Обычная" }, data: [1] });
    expect(session.engine.entities.get(22)).toMatchObject({ group: true, flags: 1, name: { short: "Авто" }, data: [2], members: [8] });
    expect(session.engine.currentPlayers).toBe(2); expect(await session.beginClose()).toBe(0);
});
test("incoming COMPLETEONPROCESS waits for the application handler completion, independently of retained data", async () => {
    const [client, server] = pair(), h = host(server), core = new NativeDirectPlayCore(client, "peer", 300, 2); cleanup.push(() => core.dispose());
    expect(await core.connect({ node: [...server.node], port: 2308 }, desc, { name: { short: "Игрок", long: "" }, data: [1, 0, 9], flags: 0 }, Uint8Array.of(3, 0, 7))).toBe(0);
    const packet = new Uint8Array(11); packet.set(nativeCoreWords(0xe0, 0x1234)); packet.set([0, 9, 0], 8);
    expect(await h.link.sendReliable(packet)).toBe(0); expect(h.processed).toEqual([]); expect(core.queue[0].data).toEqual(Uint8Array.of(0, 9, 0));
    core.queue[0].processed!(); core.queue[0].processed!(); expect(h.processed).toEqual([0x1234]); expect(core.queue[0].data).toEqual(Uint8Array.of(0, 9, 0));
    core.removeMessage(0); expect(await core.shutdown()).toBe(0);
});

test("active native COP cancellation releases its request and late E1 cannot finish a replacement operation", async () => {
    const [client, server] = pair(), h = host(server, { holdProcessed: true }), core = new NativeDirectPlayCore(client, "peer", 300, 2); cleanup.push(() => core.dispose());
    expect(await core.connect({ node: [...server.node], port: 2308 }, desc, { name: { short: "Игрок", long: "" }, data: [1, 0, 9], flags: 0 }, Uint8Array.of(3, 0, 7))).toBe(0);
    const first = new AbortController(), pending = core.sendDpn(7, 12, Uint8Array.of(1, 0, 2), first.signal);
    expect(h.outboundProcessed.length).toBe(1); first.abort(); expect(await pending).toBe(DPN.USERCANCEL);
    const second = new AbortController(); let finished = false;
    const replacement = core.sendDpn(7, 12, Uint8Array.of(3, 0, 4), second.signal).then(hr => { finished = true; return hr; });
    expect(h.outboundProcessed.length).toBe(2); expect(h.outboundProcessed[0]).not.toBe(h.outboundProcessed[1]);
    expect(await h.link.sendReliable(nativeCoreWords(0xe1, h.outboundProcessed[0]))).toBe(0); await Bun.sleep(2); expect(finished).toBe(false);
    expect(await h.link.sendReliable(nativeCoreWords(0xe1, h.outboundProcessed[1]))).toBe(0); expect(await replacement).toBe(0);
    second.abort(); expect(finished).toBe(true);
    const local = new AbortController(), loopback = core.sendDpn(core.localId, 12, Uint8Array.of(5), local.signal);
    local.abort(); expect(await loopback).toBe(DPN.USERCANCEL); core.queue.at(-1)!.processed!(); expect(await core.shutdown()).toBe(0);
});
test("bounded UDP carrier queue retries on writable and drains final EOS ACKs before releasing its binding", async () => {
    const [client, server] = pair(), h = host(server), original = client.send.bind(client); let busy = true, blockAcks = false;
    client.send = (...args: Parameters<LanNetwork["send"]>) => busy || (blockAcks && decodeNativeProtocolFrame(args[3])?.kind === "ack") ? false : original(...args);
    const channel = new NativeDirectPlayChannel(client, { node: [...server.node], port: 2308 }, { timeout: 300, retryInterval: 2 }); cleanup.push(() => channel.close());
    const ready = channel.link.connect(); expect(channel.stats.queued).toBe(1); expect(channel.stats.carrierAccepted).toBe(0);
    busy = false; client.notifyWritable(); expect(await ready).toBe(0); expect(channel.stats.carrierAccepted).toBeGreaterThan(0);
    blockAcks = true; const ended = channel.link.shutdown(); expect(await ended).toBe(0);
    let released = false; void channel.closed.then(() => { released = true; }); await Promise.resolve();
    expect(released).toBe(false); expect(client.isBound(channel.localPort, PROTO_UDP)).toBe(true);
    blockAcks = false; client.notifyWritable(); expect(await channel.closed).toBe(0); await Promise.resolve(); expect(client.isBound(channel.localPort, PROTO_UDP)).toBe(false); expect(h.link.state).toBe("closed");
});

test("dispose cancels a native handshake and cannot revive a replacement binding with an old completion", async () => {
    const [client, server] = pair(); const core = new NativeDirectPlayCore(client, "peer", 50, 2);
    const result = core.connect({ node: [...server.node], port: 2308 }, desc, { name: { short: "Игрок", long: "" }, data: [1, 0, 9], flags: 0 }, Uint8Array.of(3, 0, 7));
    expect(client.isBound(2302, PROTO_UDP)).toBe(true); core.dispose(); let delivered = 0;
    const endpoint = { deliver() { delivered++; } }; expect(client.bind(2302, endpoint, PROTO_UDP)).toBe(true);
    expect(await result).toBe(DPN.USERCANCEL); expect(core.entities.size).toBe(0); expect(client.isBound(2302, PROTO_UDP)).toBe(true); expect(delivered).toBe(0); client.unbind(2302, endpoint, PROTO_UDP);
});

test("malformed core operations and request extents fail before table access; packet data owns its storage", () => {
    expect(decodeNativeCoreOperation(nativeCoreWords(0xdb, 8))).toBeNull();
    const bytes = nativeCoreWords(0xd9, 9, 8, 7, 0, 8, 55), op = decodeNativeCoreOperation(bytes)!; bytes.fill(0);
    expect(op).toMatchObject({ command: 0xd9, id: 9, player: 8, version: 7, requesting: 8, handle: 55 });
    expect(() => encodeNativeCoreRequest(0xd6, 1, [8, 2], [{ field: 4, data: Uint8Array.of(1) }])).toThrow();
});

test("native self COP reports processing synchronously and only once before its Promise reaction", async () => {
    const [client, server] = pair(); host(server); const session = new DirectPlay8Session(client);
    cleanup.push(() => session.dispose()); expect(session.initialize()).toBe(0);
    await session.setInfo(0, { name: "Игрок", data: [1, 0, 9], flags: 0 }, 3);
    expect(await session.connectNative({ node: [...server.node], port: 2308 }, desc, 0, Uint8Array.of(3, 0, 7), 0, [20, 0, 2, 14, 300])).toBe(0);
    let processed!: () => void, promiseRan = false;
    session.onEvent = event => { if (event.type === 0x11) processed = event.processed!; };
    const results: number[] = [];
    const pending = Promise.resolve(session.send(session.localId, 12, Uint8Array.of(7), undefined, undefined, hr => results.push(hr))).then(hr => { promiseRan = true; return hr; });
    expect(results).toEqual([]); expect(session.pendingLocalProcessing).toBe(1);
    processed(); expect(results).toEqual([0]); expect(promiseRan).toBe(false); expect(session.pendingLocalProcessing).toBe(0);
    processed(); session.close(); expect(results).toEqual([0]); expect(await pending).toBe(0);
});
test("native self delivery acceptance precedes the promise microtask and same-turn Close", async () => {
    const [client, server] = pair(); host(server); const session = new DirectPlay8Session(client);
    cleanup.push(() => session.dispose()); expect(session.initialize()).toBe(0);
    await session.setInfo(0, { name: "Игрок", data: [1, 0, 9], flags: 0 }, 3);
    expect(await session.connectNative({ node: [...server.node], port: 2308 }, desc, 0, Uint8Array.of(3, 0, 7), 0, [20, 0, 2, 14, 300])).toBe(0);
    const events: string[] = [];
    session.onEvent = event => { if (event.type === 0x11) { events.push("receive"); expect(event.data).toEqual(Uint8Array.of(3, 2, 1)); } };
    const pending = session.send(session.localId, 8, Uint8Array.of(3, 2, 1), undefined, metadata => {
        events.push("accepted"); expect(metadata).toEqual({ firstFrameRtt: 0, firstFrameRetries: 0, flags: 1 });
    });
    expect(events).toEqual(["receive", "accepted"]);
    session.close(); events.push("closed"); expect(await pending).toBe(0);
    expect(events).toEqual(["receive", "accepted", "closed"]);
});
