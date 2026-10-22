import { afterEach, test, expect } from "bun:test";
import { DirectPlay8Session, type DirectPlay8Event } from "../../src/worker/modules/dpnet/peer";
import { DP, type SessionDesc, type JoinDecision } from "../../src/worker/modules/dplayx/session";
import { DPN } from "../../src/worker/modules/dpnet/constants";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { decodeDatagram, encodeDatagram, isBroadcastNode, PROTO_DIRECTPLAY } from "../../src/worker/net/netplay-wire";
const live: DirectPlay8Session[] = [];
afterEach(() => { for (const p of live) p.dispose(); live.length = 0; });
const pause = () => new Promise(resolve => setTimeout(resolve, 1));
function peers(roles: ("peer" | "server" | "client")[] = ["peer", "peer"]) {
    const nets = roles.map((_, i) => new LanNetwork(new Uint8Array([2, 0, 0, 0, 0, i + 1])));
    for (const net of nets) net.attach({ send(frame) {
        const p = decodeDatagram(frame)!;
        for (const target of nets) if (target !== net && (isBroadcastNode(p.node) || target.isSelf(p.node))) {
            const out = encodeDatagram(p.proto, net.node, p.dstPort, p.srcPort, p.payload);
            queueMicrotask(() => target.receiveFrame(out));
        } return true;
    }, close() {} });
    const result = roles.map((role, i) => new DirectPlay8Session(nets[i], role, 100)); live.push(...result);
    for (const p of result) expect(p.initialize()).toBe(DPN.OK);
    return result;
}
function desc(flags = 0): SessionDesc {
    return { instance: "0".repeat(32), application: "1".repeat(32), flags: (flags & 1 ? 0x1000 : 0) | (flags & 4), maxPlayers: 8,
        name: "DP8 room", password: "", user: [0, 0, 0, 0], extended: { flags, reserved: [], application: [1, 2] } };
}
async function discover(host: DirectPlay8Session, client: DirectPlay8Session) {
    expect(client.engine.discover(host.engine.desc!.application)).toBe(DP.OK); await pause();
    expect(client.engine.discovered.size).toBe(1); return { ...host.engine.desc! };
}
test("DirectPlay8 two peers moderate connection data and receive local/remote player creation", async () => {
    const [host, client] = peers(), a: DirectPlay8Event[] = [], b: DirectPlay8Event[] = [];
    host.onEvent = e => a.push(e); client.onEvent = e => b.push(e);
    host.localInfo = { name: "Хост", data: [1], flags: 0 }; client.localInfo = { name: "Клиент", data: [2], flags: 0 };
    expect(host.host(desc(), 123)).toBe(DPN.OK); expect(a.map(e => [e.type, e.id, e.context])).toEqual([[7, host.localId, 123]]);
    host.onIndicate = request => { expect([...request.data]).toEqual([9, 8]); expect(request.player.name.short).toBe("Клиент"); return { hr: 0, context: 456, data: new Uint8Array([7, 6]) }; };
    expect(await client.connect(await discover(host, client), 789, new Uint8Array([9, 8]))).toBe(DPN.OK);
    expect([...client.engine.joinReply!.data!]).toEqual([7, 6]);
    expect(host.contexts.get(client.localId)).toBe(456); expect(client.contexts.get(client.localId)).toBe(789);
    expect(a.filter(e => e.type === 7).length).toBe(2); expect(b.filter(e => e.type === 7).length).toBe(2);
    expect(client.playerFlags(client.localId)).toBe(2); expect(client.playerFlags(host.localId)).toBe(4);
    expect(host.playerFlags(host.localId)).toBe(6);
    a.length = 0; b.length = 0;
    expect(await client.send(0, 8, new Uint8Array([10, 20]))).toBe(DPN.OK);
    expect(a.find(e => e.type === 0x11)?.data).toEqual(new Uint8Array([10, 20]));
    expect(b.find(e => e.type === 0x11)?.data).toEqual(new Uint8Array([10, 20]));
    expect(b.find(e => e.type === 0x11)?.flags).toBe(1);
    b.length = 0; expect(await client.send(0, 8 | 0x20, new Uint8Array([30]))).toBe(DPN.OK); expect(b.some(e => e.type === 0x11)).toBe(false);
});
test("DirectPlay8 rejection and stale connect cancellation create no host-side players", async () => {
    const [host, client] = peers(); expect(host.host(desc())).toBe(DPN.OK);
    let release!: (decision: JoinDecision) => void;
    host.onIndicate = () => new Promise(resolve => { release = resolve; });
    const pending = client.connect(await discover(host, client)); await pause();
    expect(host.engine.currentPlayers).toBe(1);
    release({ hr: DPN.HOSTREJECTEDCONNECTION, data: new Uint8Array([1]) });
    expect(await pending).toBe(DPN.HOSTREJECTEDCONNECTION); expect(host.engine.currentPlayers).toBe(1);
    const old = client.connect(await discover(host, client)); await pause(); client.cancelConnect(); await pause();
    release({ hr: DPN.OK }); expect(await old).toBe(DPN.USERCANCEL); await pause();
    expect(host.engine.currentPlayers).toBe(1); expect(client.engine.desc).toBeNull();
});
test("DirectPlay8 client/server metadata, group membership, updates and peer lifetime are networked", async () => {
    const [host, client] = peers(["server", "client"]), events: DirectPlay8Event[] = []; client.onEvent = e => events.push(e);
    expect(host.host(desc(1))).toBe(DPN.OK);
    expect(await client.connect(await discover(host, client))).toBe(DPN.OK);
    const group = await host.createGroup({ name: "Team", data: [1], flags: 1 }, 321); expect(group.hr).toBe(DPN.OK); await pause();
    expect(client.engine.entities.get(group.id!)?.name.short).toBe("Team");
    expect(await host.member(group.id!, client.localId, true)).toBe(DPN.OK); await pause();
    expect(events.some(e => e.type === 1 && e.player === client.localId)).toBe(true);
    expect(await host.member(group.id!, client.localId, true)).toBe(DPN.PLAYERALREADYINGROUP);
    expect(await host.setInfo(host.localId, { name: "New server", data: [4], flags: 0 }, 3)).toBe(DPN.OK); await pause();
    expect(events.some(e => e.type === 0x15 && e.id === host.localId)).toBe(true);
    expect(client.engine.entities.get(host.localId)?.data).toEqual([4]);
    expect(await host.member(group.id!, client.localId, false)).toBe(DPN.OK); await pause(); expect(events.some(e => e.type === 0x12)).toBe(true);
    expect(await host.destroyGroup(group.id!)).toBe(DPN.OK); await pause(); expect(events.some(e => e.type === 8)).toBe(true);
    expect(host.engine.terminate(new Uint8Array([99]), DPN.HOSTTERMINATEDSESSION)).toBe(DP.OK); await pause();
    expect(events.find(e => e.type === 0x16)?.data).toEqual(new Uint8Array([99]));
    expect(client.error).toBe(DPN.CONNECTIONLOST);
});
test("CREATE_GROUP exposes an owner only for auto-destruct groups and preserves each creator context", async () => {
    const [host, client] = peers(), local: DirectPlay8Event[] = [], remote: DirectPlay8Event[] = [];
    host.onEvent = event => local.push(event); client.onEvent = event => remote.push(event);
    expect(host.host(desc())).toBe(DPN.OK); expect(await client.connect(await discover(host, client))).toBe(DPN.OK);
    const normal = await host.createGroup({ name: "Normal", data: [], flags: 0 }, 0x1111), auto = await host.createGroup({ name: "Auto", data: [], flags: 1 }, 0x2222);
    expect(normal.hr).toBe(0); expect(auto.hr).toBe(0); await pause();
    expect(local.find(e => e.type === 6 && e.id === normal.id)).toMatchObject({ owner: 0, context: 0x1111 });
    expect(remote.find(e => e.type === 6 && e.id === normal.id)).toMatchObject({ owner: 0, context: 0 });
    expect(local.find(e => e.type === 6 && e.id === auto.id)).toMatchObject({ owner: host.localId, context: 0x2222 });
    expect(remote.find(e => e.type === 6 && e.id === auto.id)).toMatchObject({ owner: host.localId, context: 0 });
    expect(host.engine.entities.get(normal.id!)?.groupOwner).toBe(host.localId);
    expect(await host.destroyGroup(normal.id!)).toBe(0); expect(await host.destroyGroup(auto.id!)).toBe(0);
});
test("Close reports normal player/group destruction while host termination keeps the session-terminated reason", async () => {
    for (const terminating of [false, true]) {
        const [host, client] = peers(), events: DirectPlay8Event[] = [];
        expect(host.host(desc())).toBe(0); expect(await client.connect(await discover(host, client))).toBe(0);
        const group = await host.createGroup({ name: "Auto", data: [], flags: 1 }, 0x1111); expect(group.hr).toBe(0); await pause();
        const target = terminating ? client : host; target.onEvent = event => events.push(event);
        if (terminating) host.engine.terminate(new Uint8Array(), DPN.HOSTTERMINATEDSESSION); else expect(host.close()).toBe(0);
        await pause(); const destroyed = events.filter(e => e.type === 8 || e.type === 9);
        expect(destroyed.length).toBe(3); expect(destroyed.map(e => e.reason)).toEqual([terminating ? 3 : 1, terminating ? 3 : 1, terminating ? 3 : 1]);
    }
});
test("DirectPlay8 exact port departure preserves other sessions hosted at the same virtual node", async () => {
    const [host, client] = peers();
    expect(host.host(desc(4))).toBe(DPN.OK); expect(await client.connect(await discover(host, client))).toBe(DPN.OK);
    const address = host.engine.localAddress;
    client.network.notifyPortDisconnected({ node: new Uint8Array(address.node), port: address.port + 1, proto: PROTO_DIRECTPLAY });
    expect(client.engine.isHost).toBe(false); expect(client.engine.entities.has(host.localId)).toBe(true);
    client.network.notifyPortDisconnected({ node: new Uint8Array(address.node), port: address.port, proto: PROTO_DIRECTPLAY });
    expect(client.engine.isHost).toBe(true); expect(client.engine.entities.has(client.localId)).toBe(true);
});

test("DirectPlay8 callback backpressure retries in FIFO order without duplicate receives", async () => {
    const [host, client] = peers(); expect(host.host(desc())).toBe(DPN.OK);
    expect(await client.connect(await discover(host, client))).toBe(DPN.OK);
    const events: DirectPlay8Event[] = []; let ready = false, attempts = 0;
    client.onEvent = event => { attempts++; if (!ready) return false; events.push(event); return true; };
    expect(await host.send(client.localId, 8, new Uint8Array([1]))).toBe(DPN.OK);
    expect(await host.send(client.localId, 8, new Uint8Array([2]))).toBe(DPN.OK);
    await pause(); expect(events.length).toBe(0); expect(client.pendingEventCount).toBe(2);
    ready = true; await Bun.sleep(15);
    expect(events.filter(e => e.type === 0x11).map(e => e.data?.[0])).toEqual([1, 2]);
    expect(client.pendingEventCount).toBe(0); expect(attempts).toBeGreaterThan(2);
    client.network.notifyPeerDisconnected(host.network.node);
    await pause(); expect(events.filter(e => e.type === 0x16).length).toBe(1);
});
