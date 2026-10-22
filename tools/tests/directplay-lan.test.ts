import { afterEach, expect, test } from "bun:test";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { decodeDatagram, encodeDatagram, isBroadcastNode, PROTO_DIRECTPLAY } from "../../src/worker/net/netplay-wire";
import { DirectPlaySession, DP, type SessionDesc, type Reply } from "../../src/worker/modules/dplayx/session";

const sessions: DirectPlaySession[] = [];
const controls = new WeakMap<LanNetwork, { reject: boolean; disconnect: boolean }>();
afterEach(() => { for (const s of sessions) s.dispose(); sessions.length = 0; });
function peers(count = 2) {
    const nets = Array.from({ length: count }, (_, i) => new LanNetwork(new Uint8Array([2, 0, 0, 0, 0, i + 1])));
    for (const net of nets) {
        const control = { reject: false, disconnect: false }; controls.set(net, control);
        net.attach({
        send(frame) {
            if (control.disconnect) { net.setConnected(false, "injected disconnect"); return false; }
            if (control.reject) return false;
            const p = decodeDatagram(frame)!;
            for (const target of nets) if (target !== net && (isBroadcastNode(p.node) || target.isSelf(p.node))) {
                const delivered = encodeDatagram(p.proto, net.node, p.dstPort, p.srcPort, p.payload);
                // A relay round-trip must cross the task boundary; no process-local loopback oracle.
                queueMicrotask(() => target.receiveFrame(delivered));
            }
            return true;
        },
        close() {},
    });
    }
    const result = nets.map(net => new DirectPlaySession(net, 100));
    sessions.push(...result);
    for (const s of result) expect(s.initialize()).toBe(DP.OK);
    return result;
}
const desc = (app = "1".repeat(32), password = ""): SessionDesc => ({
    instance: "0".repeat(32), application: app, flags: 0, maxPlayers: 8, name: "LAN match", password, user: [1, 2, 3, 4],
});
async function join(host: DirectPlaySession, client: DirectPlaySession, password = "") {
    expect(client.discover(host.desc!.application)).toBe(DP.OK);
    await Bun.sleep(1);
    expect(client.discovered.has(host.desc!.instance)).toBe(true);
    expect(await client.join({ ...host.desc!, password })).toBe(DP.OK);
}
async function create(s: DirectPlaySession, group = false, parent = 0): Promise<number> {
    const r: Reply = await s.mutate({ op: "mutate", action: "create", group, parent, flags: 0,
        name: { short: group ? "team" : "player", long: "full name" }, data: [1, 2, 3] });
    expect(r.hr).toBe(DP.OK);
    return r.id!;
}
function drain(s: DirectPlaySession): void { while (s.queue.length) s.removeMessage(0); }

test("two separate adapters discover, join, replicate players and exchange reliable/broadcast messages", async () => {
    const [host, client] = peers();
    expect(host.create(desc())).toBe(DP.OK);
    const a = await create(host);
    await join(host, client);
    const b = await create(client);
    await Bun.sleep(1);
    expect(a).not.toBe(b);
    expect([...host.entities.keys()]).toEqual([a, b]);
    expect([...client.entities.keys()]).toEqual([a, b]);
    expect(host.queue.some(m => m.system?.type === 3 && m.system.entity?.id === b)).toBe(true);
    drain(host); drain(client);
    expect(await client.send(b, a, 1, new Uint8Array([8, 9]))).toBe(DP.OK);
    expect(host.queue.map(m => [m.from, m.to, [...m.data]])).toEqual([[b, a, [8, 9]]]);
    expect(client.queue).toEqual([]);
    expect(host.send(a, 0, 0, new Uint8Array([4]))).toBe(DP.OK);
    await Bun.sleep(1);
    expect(client.queue.map(m => [m.from, m.to, [...m.data]])).toEqual([[a, b, [4]]]);
    expect(host.send(a, a, 1, new Uint8Array([5]))).toBe(DP.OK);
    expect(host.queue.length).toBe(1);
});
test("group multicast, remote ownership, leave and explicit host close have observable state", async () => {
    const [host, client] = peers();
    host.create(desc()); const a = await create(host); await join(host, client);
    const b = await create(client), c = await create(client), group = await create(host, true);
    expect((await host.mutate({ op: "mutate", action: "member", id: group, member: b, add: true })).hr).toBe(DP.OK);
    await Bun.sleep(1); drain(host); drain(client);
    host.send(a, group, 1, new Uint8Array([7])); await Bun.sleep(1);
    expect(client.queue.map(m => m.to)).toEqual([b]);
    expect((await client.mutate({ op: "mutate", action: "destroy", id: a, group: false })).hr).toBe(DP.ACCESSDENIED);
    client.close(); await Bun.sleep(1);
    expect(host.entities.has(b)).toBe(false); expect(host.entities.has(c)).toBe(false);
    expect(host.queue.some(m => m.system?.type === 5)).toBe(true);
    await join(host, client); await create(client); drain(client);
    host.close(); await Bun.sleep(1);
    expect(client.lost).toBe(true); expect(client.queue.some(m => m.system?.type === 0x31)).toBe(true);
    expect(await client.send(b, a, 1, new Uint8Array([7]))).toBe(DP.SESSIONLOST);
});
test("multiple COM sessions on one adapter share discovery listener without sharing queues", async () => {
    const [host, client] = peers(), second = new DirectPlaySession(host.network);
    sessions.push(second); expect(second.initialize()).toBe(DP.OK);
    expect(host.create(desc())).toBe(DP.OK); expect(second.create(desc("2".repeat(32)))).toBe(DP.OK);
    client.discover("0".repeat(32)); await Bun.sleep(1);
    expect(client.discovered.size).toBe(2);
    expect(await client.join(second.desc!)).toBe(DP.OK);
    await create(client); await Bun.sleep(1);
    expect(host.entities.size).toBe(0); expect(second.entities.size).toBe(1);
});
test("application, password, capacity and invalid migration/server combinations obey error contracts", async () => {
    const [host, client] = peers();
    expect(host.create({ ...desc(), flags: 4 | 0x1000 })).toBe(DP.INVALIDFLAGS);
    host.create({ ...desc("1".repeat(32), "secret"), maxPlayers: 1 });
    client.discover("2".repeat(32)); await Bun.sleep(1); expect(client.discovered.size).toBe(0);
    client.discover(host.desc!.application); await Bun.sleep(1);
    expect(await client.join({ ...host.desc!, password: "wrong" })).toBe(DP.INVALIDPASSWORD);
    await join(host, client, "secret"); await create(host);
    const r = await client.mutate({ op: "mutate", action: "create", group: false, parent: 0, flags: 0, name: { short: "", long: "" }, data: [] });
    expect(r.hr).toBe(DP.CANTCREATEPLAYER);
});
test("malformed and cross-session packets and forged sender IDs cannot deliver game data", async () => {
    const [host, client, attacker] = peers(3); host.create(desc()); const a = await create(host);
    await join(host, client); const b = await create(client); await Bun.sleep(1); drain(host); drain(client);
    expect(await client.send(a, b, 1, new Uint8Array([1]))).toBe(DP.INVALIDPLAYER);
    const targetPort = (host as unknown as { port: number }).port;
    for (const bytes of [new Uint8Array(), new Uint8Array(15), new Uint8Array(100)]) {
        host.deliver({ srcNode: attacker.network.node, srcPort: 49152, data: bytes });
    }
    const json = new TextEncoder().encode(JSON.stringify({ op: "send", session: "f".repeat(32), from: b, to: a, flags: 0 }));
    const frame = new Uint8Array(20 + json.length + 1), v = new DataView(frame.buffer);
    v.setUint32(0, 0x314c5044, true); v.setUint32(12, 1, true); v.setUint32(16, json.length, true); frame.set(json, 20); frame[frame.length - 1] = 77;
    attacker.network.send(49152, host.network.node, targetPort, frame, PROTO_DIRECTPLAY);
    await Bun.sleep(1); expect(host.queue).toEqual([]);
    expect(host.entities.size).toBe(2);
});
test("trusted peer departure destroys owned players for everyone, and host departure fails pending RPC", async () => {
    const [host, client, other] = peers(3); host.create(desc()); const a = await create(host);
    await join(host, client); const b = await create(client);
    await join(host, other); const c = await create(other); await Bun.sleep(1);
    drain(host); drain(client); drain(other);
    host.network.notifyPeerDisconnected(client.network.node);
    await Bun.sleep(1);
    expect(host.entities.has(b)).toBe(false); expect(other.entities.has(b)).toBe(false);
    expect(other.queue.some(m => m.system?.type === 5 && m.system.entity?.id === b)).toBe(true);
    expect(host.entities.has(a)).toBe(true); expect(other.entities.has(c)).toBe(true);
    const pending = other.mutate({ op: "mutate", action: "data", id: c, group: false, data: [9] });
    other.network.notifyPeerDisconnected(host.network.node);
    expect((await pending).hr).toBe(DP.SESSIONLOST);
    expect(other.lost).toBe(true); expect(other.queue.some(m => m.system?.type === 0x31)).toBe(true);
});
test("backpressure and a reentrant disconnect fail sends and mutations without silent success", async () => {
    const [host, client] = peers(); host.create(desc()); const a = await create(host); await join(host, client);
    const b = await create(client); await Bun.sleep(1); drain(host); drain(client);
    controls.get(client.network)!.reject = true;
    expect(await client.send(b, a, 1, new Uint8Array([1]))).toBe(DP.CONNECTIONLOST);
    expect((await client.mutate({ op: "mutate", action: "data", id: b, group: false, data: [1] })).hr).toBe(DP.CONNECTIONLOST);
    controls.get(client.network)!.reject = false;
    controls.get(host.network)!.reject = true;
    expect(await host.send(a, b, 1, new Uint8Array([1]))).toBe(DP.CONNECTIONLOST);
    expect(host.lost).toBe(true);
    const [host2, client2] = peers(); host2.create(desc()); await create(host2); await join(host2, client2); await create(client2);
    controls.get(host2.network)!.disconnect = true;
    const result = await host2.mutate({ op: "mutate", action: "create", group: true, flags: 0, parent: 0, name: { short: "", long: "" }, data: [] });
    expect(result.hr).toBe(DP.CONNECTIONLOST); expect(host2.lost).toBe(true);
});
test("closing a discovery or pending join cannot resurrect or erase a newer hosted session", async () => {
    const [host, client] = peers(); host.create(desc());
    const discovering = client.join(host.desc!);
    client.close(); expect(client.create(desc("3".repeat(32)))).toBe(DP.OK);
    const fresh = client.desc!.instance;
    expect(await discovering).toBe(DP.SESSIONLOST); expect(client.desc!.instance).toBe(fresh); expect(client.isHost).toBe(true);
    client.close(); client.discover(host.desc!.application); await Bun.sleep(1);
    const pending = client.join(host.desc!);
    client.close(); expect(client.create(desc("4".repeat(32)))).toBe(DP.OK);
    const next = client.desc!.instance;
    expect(await pending).toBe(DP.SESSIONLOST); expect(client.desc!.instance).toBe(next);
});
test("large data fragments survive a real adapter round-trip and state disconnect wakes the session", async () => {
    const [host, client] = peers(); host.create(desc()); const a = await create(host); await join(host, client);
    const b = await create(client); drain(host); drain(client);
    const payload = new Uint8Array(60000); payload[59999] = 13;
    expect(await client.send(b, a, 1, payload)).toBe(DP.OK);
    expect(host.queue[0].data).toEqual(payload);
    client.network.setConnected(false, "test disconnect");
    expect(client.lost).toBe(true); expect(client.queue.some(m => m.system?.type === 0x31)).toBe(true);
});

test("host migration elects the lowest surviving player, preserves room and supports subsequent sends", async () => {
    const [host, first, second] = peers(3);
    expect(host.create({ ...desc(), flags: 4 })).toBe(DP.OK); const a = await create(host);
    await join(host, first); const b = await create(first); await join(host, second); const c = await create(second);
    await Bun.sleep(1); drain(first); drain(second);
    host.close(); await Bun.sleep(2);
    expect(first.isHost).toBe(true); expect(second.isHost).toBe(false);
    expect(first.lost).toBe(false); expect(second.lost).toBe(false);
    expect(first.entities.has(a)).toBe(false); expect(second.entities.has(a)).toBe(false);
    expect(first.queue.some(m => m.system?.type === 0x101)).toBe(true);
    drain(first); drain(second);
    expect(await second.send(c, b, 1, new Uint8Array([55]))).toBe(DP.OK);
    expect(first.queue.some(m => m.from === c && m.data[0] === 55)).toBe(true);
    const d = await create(second); expect(d).toBeGreaterThan(c);
});
test("chat messages cross adapters as DPSYS_CHAT with canonical Unicode text", async () => {
    const [host, client] = peers(); host.create(desc()); const a = await create(host); await join(host, client); const b = await create(client);
    await Bun.sleep(1); drain(host); drain(client);
    expect(await client.sendChat(b, a, 1, "Привет漢🙂")).toBe(DP.OK);
    expect(host.queue[0].from).toBe(0); expect(host.queue[0].to).toBe(a);
    expect(host.queue[0].system?.type).toBe(0x109); expect(host.queue[0].system?.chat?.text).toBe("Привет漢🙂");
});
