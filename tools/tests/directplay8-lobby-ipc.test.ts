import { afterEach, expect, test } from "bun:test";
import { ProcessIpc } from "../../src/worker/core/process-ipc";
import { DirectPlay8LobbyEndpoint, type Lobby8Request } from "../../src/worker/modules/dpnlobby/broker";
import type { Lobby8Settings, Lobby8Program } from "../../src/worker/modules/dpnlobby/structures";
import { DPN } from "../../src/worker/modules/dpnet/constants";
const nodes: ProcessIpc[] = [], links: DirectPlay8LobbyEndpoint[] = [];
afterEach(() => { for (const link of links) link.close(); links.length = 0; for (const node of nodes) node.close(); nodes.length = 0; });
function endpoint(ipc: ProcessIpc) { nodes.push(ipc); const link = new DirectPlay8LobbyEndpoint(ipc); links.push(link); return link; }
function root() { return endpoint(new ProcessIpc(1234)); }
function child(parent: DirectPlay8LobbyEndpoint, pid: number) {
    const node = new ProcessIpc(pid, 1234), channel = new MessageChannel();
    parent.ipc.connectChild(pid, channel.port1); node.adoptParent(channel.port2); return endpoint(node);
}
const settings = (): Lobby8Settings => ({ flags: 1, players: 0,
    desc: { application: "a".repeat(32), instance: "b".repeat(32), name: "Сессия", password: "", maxPlayers: 8, flags: 0, user: [0, 0, 0, 0] },
    host: null, devices: [{ components: [], userData: new Uint8Array([7]) }], player: "Игрок" });
const program: Lobby8Program = { guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", strings: ["Игра", "", null, null, "game.exe", "C:\\", null, null] };
const request = (endpoint: DirectPlay8LobbyEndpoint, value: Lobby8Request, kind: "app" | "client" = "client", token = 1) => endpoint.call({ ...value, kind, token });

test("DP8 lobby singleton registration, owned catalog and application availability span processes", async () => {
    const lobby = root(), game = child(lobby, 5000);
    expect(await request(game, { op: "register", program }, "app")).toMatchObject({ hr: 0 }); // allowed before Initialize
    expect(await request(lobby, { op: "enum" })).toMatchObject({ hr: DPN.UNINITIALIZED });
    expect(await request(lobby, { op: "initialize", image: "lobby.exe" })).toMatchObject({ hr: 0 });
    expect(await request(lobby, { op: "initialize" }, "client", 2)).toMatchObject({ hr: DPN.NOTALLOWED });
    expect(await request(game, { op: "initialize", image: "C:\\game.exe" }, "app")).toMatchObject({ hr: 0, connection: 0 });
    const result = await request(lobby, { op: "enum", guid: program.guid });
    expect(result.programs).toHaveLength(1); expect(result.programs![0]).toMatchObject({ running: 1, waiting: 1 });
    expect(await request(game, { op: "available", available: false }, "app")).toMatchObject({ hr: 0 });
    expect((await request(lobby, { op: "find", guid: program.guid })).app).toBeUndefined();
    expect((await request(lobby, { op: "enum" })).programs![0].waiting).toBe(0);
    expect(await request(lobby, { op: "close" })).toMatchObject({ hr: 0 });
    expect(await request(lobby, { op: "initialize" }, "client", 2)).toMatchObject({ hr: 0 });
});

test("DP8 lobby launches publish settings before app Initialize, callback approval completes the client, and outsiders cannot read", async () => {
    const lobby = root(), game = child(lobby, 5000), stranger = child(lobby, 5001);
    await request(lobby, { op: "initialize" });
    const own = settings(), attached = await request(lobby, { op: "attach", app: 5000, settings: own, data: new Uint8Array([1, 2]) });
    const connection = attached.connection!; own.desc.name = "mutated"; own.devices[0].userData[0] = 9;
    const waiter = request(lobby, { op: "wait", connection, timeout: 1000 });
    const initialized = await request(game, { op: "initialize", image: "game.exe" }, "app");
    expect(initialized).toMatchObject({ hr: 0, connection });
    const event = (await request(game, { op: "peek" }, "app")).event!;
    expect(event.type).toBe(2); expect(event.settings!.desc.name).toBe("Сессия"); expect(event.settings!.devices[0].userData[0]).toBe(7);
    await request(game, { op: "ack", serial: event.serial }, "app");
    await request(game, { op: "accept", connection, result: 0 }, "app");
    expect(await waiter).toMatchObject({ hr: 0, connection });
    await request(stranger, { op: "initialize" }, "app");
    expect(await request(stranger, { op: "get", connection }, "app")).toMatchObject({ hr: DPN.INVALIDHANDLE });
    expect((await request(lobby, { op: "get", connection })).settings!.player).toBe("Игрок");
});

test("DP8 lobby receive/settings/status FIFOs retain messages until ack and disconnect on peer exit", async () => {
    const lobby = root(), game = child(lobby, 5000);
    await request(lobby, { op: "initialize" }); await request(game, { op: "initialize", image: "game.exe" }, "app");
    const { connection } = await request(lobby, { op: "attach", app: 5000, settings: settings() });
    const connect = (await request(game, { op: "peek" }, "app")).event!;
    await request(game, { op: "ack", serial: connect.serial }, "app"); await request(game, { op: "accept", connection }, "app");
    for (let i = 0; i < 1024; i++) expect(await request(lobby, { op: "send", connection, data: new Uint8Array([i & 255]) })).toMatchObject({ hr: 0 });
    expect(await request(lobby, { op: "send", connection, data: new Uint8Array([77]) })).toMatchObject({ hr: DPN.TABLEFULL });
    const first = (await request(game, { op: "peek" }, "app")).event!;
    expect((await request(game, { op: "peek" }, "app")).event!.serial).toBe(first.serial);
    for (let i = 0; i < 1024; i++) {
        const message = (await request(game, { op: "peek" }, "app")).event!;
        expect(message.data![0]).toBe(i & 255); await request(game, { op: "ack", serial: message.serial }, "app");
    }
    const changed = settings(); changed.player = "新";
    expect(await request(lobby, { op: "set", connection, settings: changed })).toMatchObject({ hr: 0 });
    const change = (await request(game, { op: "peek" }, "app")).event!;
    expect(change.type).toBe(5); expect(change.settings!.player).toBe("新"); await request(game, { op: "ack", serial: change.serial }, "app");
    expect(await request(game, { op: "status", connection, status: 1 }, "app")).toMatchObject({ hr: 0 });
    expect((await request(lobby, { op: "peek" })).event).toMatchObject({ type: 4, status: 1 });
    const status = (await request(lobby, { op: "peek" })).event!;
    await request(lobby, { op: "ack", serial: status.serial });
    game.ipc.close(); await new Promise(resolve => setTimeout(resolve, 5));
    expect((await request(lobby, { op: "peek" })).event).toMatchObject({ type: 3, connection, result: DPN.CONNECTIONLOST });
    expect(await request(lobby, { op: "get", connection })).toMatchObject({ hr: DPN.INVALIDHANDLE });
});

test("DP8 ALLCONNECTIONS broadcasts and clears optional settings with lossless byte quotas", async () => {
    const lobby = root(), game = child(lobby, 5000);
    await request(lobby, { op: "initialize" }); await request(game, { op: "initialize", image: "game.exe" }, "app");
    const { connection } = await request(lobby, { op: "attach", app: 5000 });
    const connect = (await request(game, { op: "peek" }, "app")).event!;
    expect(connect.settings).toBeUndefined(); await request(game, { op: "ack", serial: connect.serial }, "app");
    await request(game, { op: "accept", connection }, "app");
    expect(await request(lobby, { op: "get", connection })).toMatchObject({ hr: DPN.DOESNOTEXIST });
    expect(await request(lobby, { op: "send", connection: 0xffffffff, data: new Uint8Array([9]) })).toMatchObject({ hr: 0 });
    const message = (await request(game, { op: "peek" }, "app")).event!;
    expect(message.data).toEqual(new Uint8Array([9])); await request(game, { op: "ack", serial: message.serial }, "app");
    const large = settings(); large.devices[0].userData = new Uint8Array(700000);
    for (let i = 0; i < 5; i++) expect(await request(lobby, { op: "set", connection, settings: large })).toMatchObject({ hr: 0 });
    expect(await request(lobby, { op: "set", connection, settings: large })).toMatchObject({ hr: DPN.TABLEFULL });
    for (let i = 0; i < 5; i++) {
        const event = (await request(game, { op: "peek" }, "app")).event!;
        expect(event.settings!.devices[0].userData).toHaveLength(700000);
        await request(game, { op: "ack", serial: event.serial }, "app");
    }
    expect(await request(lobby, { op: "set", connection: 0xffffffff })).toMatchObject({ hr: 0 });
    expect(await request(lobby, { op: "get", connection })).toMatchObject({ hr: DPN.DOESNOTEXIST });
    expect(await request(lobby, { op: "release", connection: 0xffffffff })).toMatchObject({ hr: 0 });
    expect(await request(lobby, { op: "send", connection: 0xffffffff, data: new Uint8Array([1]) })).toMatchObject({ hr: 0 });
});
test("DP8 peer publication reserves settings and status together under a full remote callback queue", async () => {
    const lobby = root(), game = child(lobby, 5000);
    await request(lobby, { op: "initialize" }); await request(game, { op: "initialize" }, "app");
    const { connection } = await request(lobby, { op: "attach", app: 5000, settings: settings() });
    const connect = (await request(game, { op: "peek" }, "app")).event!;
    await request(game, { op: "ack", serial: connect.serial }, "app"); await request(game, { op: "accept", connection }, "app");
    for (let i = 0; i < 1023; i++) await request(game, { op: "send", connection, data: new Uint8Array([i & 255]) }, "app");
    const changed = settings(); changed.player = "Changed";
    expect(await request(game, { op: "publish", connection, settings: changed, status: 1 }, "app")).toMatchObject({ hr: DPN.TABLEFULL });
    expect((await request(lobby, { op: "get", connection })).settings!.player).toBe("Игрок");
    const first = (await request(lobby, { op: "peek" })).event!;
    await request(lobby, { op: "ack", serial: first.serial });
    expect(await request(game, { op: "publish", connection, settings: changed, status: 1 }, "app")).toMatchObject({ hr: 0 });
    for (let i = 0; i < 1022; i++) {
        const event = (await request(lobby, { op: "peek" })).event!;
        expect(event.type).toBe(1); await request(lobby, { op: "ack", serial: event.serial });
    }
    const update = (await request(lobby, { op: "peek" })).event!;
    expect(update).toMatchObject({ type: 5, settings: { player: "Changed" } }); await request(lobby, { op: "ack", serial: update.serial });
    const status = (await request(lobby, { op: "peek" })).event!;
    expect(status).toMatchObject({ type: 4, status: 1 }); await request(lobby, { op: "ack", serial: status.serial });
    expect((await request(lobby, { op: "peek" })).event).toBeUndefined();
});
test("DP8 lobby close cancels pending approval immediately and a stale token cannot close a new endpoint", async () => {
    const lobby = root(), game = child(lobby, 5000);
    await request(lobby, { op: "initialize" }); await request(game, { op: "initialize" }, "app");
    const { connection } = await request(lobby, { op: "attach", app: 5000, settings: settings() });
    const waiting = request(lobby, { op: "wait", connection, timeout: 1000 });
    await request(game, { op: "close" }, "app");
    expect(await waiting).toMatchObject({ hr: DPN.CONNECTIONLOST });
    await request(game, { op: "initialize" }, "app", 2);
    expect(await request(game, { op: "close" }, "app", 1)).toMatchObject({ hr: DPN.UNINITIALIZED });
    expect(await request(game, { op: "available", available: true }, "app", 2)).toMatchObject({ hr: 0 });
});
