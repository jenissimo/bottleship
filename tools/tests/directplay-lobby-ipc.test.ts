import { afterEach, expect, test } from "bun:test";
import { ProcessIpc } from "../../src/worker/core/process-ipc";
import { DirectPlayLobbyEndpoint, DPERR_NOTLOBBIED, type LobbySettings } from "../../src/worker/modules/dplayx/lobby-broker";
import { DP } from "../../src/worker/modules/dplayx/session";
const nodes: ProcessIpc[] = [], endpoints: DirectPlayLobbyEndpoint[] = [];
afterEach(() => { for (const endpoint of endpoints) endpoint.close(); endpoints.length = 0; for (const node of nodes) node.close(); nodes.length = 0; });
function root() { const ipc = new ProcessIpc(1234); nodes.push(ipc); return endpoint(ipc); }
function endpoint(ipc: ProcessIpc) { const value = new DirectPlayLobbyEndpoint(ipc); endpoints.push(value); return value; }
function child(parent: DirectPlayLobbyEndpoint, pid: number) {
    const ipc = new ProcessIpc(pid, 1234), channel = new MessageChannel(); nodes.push(ipc);
    parent.ipc.connectChild(pid, channel.port1); ipc.adoptParent(channel.port2); return endpoint(ipc);
}
const settings = (): LobbySettings => ({ desc: { application: "a".repeat(32), instance: "b".repeat(32), flags: 0, maxPlayers: 8, name: "Лан", password: "", user: [0, 0, 0, 0] },
    create: true, player: { short: "名", long: "" }, provider: "c".repeat(32), address: new Uint8Array([1, 2, 3]) });
const receive = (endpoint: DirectPlayLobbyEndpoint, game = 0, capacity = 65536, output = true) => endpoint.call({ op: "receive", game, capacity, output });
test("lobby publishes owned connection settings before child startup and rejects unrelated game IDs", async () => {
    const lobby = root(); const own = settings();
    expect(await lobby.call({ op: "launch", pid: 5000, settings: own })).toMatchObject({ hr: 0, pid: 5000 });
    own.desc.name = "mutated"; own.address[0] = 9;
    const game = child(lobby, 5000), stranger = child(lobby, 5001);
    const read = await game.call({ op: "get" }); expect(read.hr).toBe(0); expect(read.settings?.desc.name).toBe("Лан"); expect(read.settings?.address[0]).toBe(1);
    expect(await lobby.call({ op: "get", game: 5000 })).toMatchObject({ hr: 0 });
    expect(await stranger.call({ op: "get", game: 5000 })).toMatchObject({ hr: DP.INVALIDPARAMS });
    expect(await stranger.call({ op: "get" })).toMatchObject({ hr: DPERR_NOTLOBBIED });
});
test("lobby message queues preserve short-buffer messages, flags, direction and event notifications", async () => {
    const lobby = root(); await lobby.call({ op: "launch", pid: 5000, settings: settings() }); const game = child(lobby, 5000);
    const wakes: number[] = []; game.onMessage = id => { wakes.push(id); };
    expect(await game.call({ op: "subscribe", flags: 1 })).toMatchObject({ hr: 0 });
    expect(await lobby.call({ op: "send", game: 5000, flags: 0, data: new Uint8Array([7, 8, 9]) })).toMatchObject({ hr: 0 });
    await new Promise(resolve => setTimeout(resolve, 4)); expect(wakes).toEqual([5000]);
    expect(await receive(game, 0, 0, false)).toEqual({ hr: DP.BUFFERTOOSMALL, size: 3 });
    expect(await receive(game, 0, 2)).toEqual({ hr: DP.BUFFERTOOSMALL, size: 3 });
    expect(await receive(game)).toEqual({ hr: 0, size: 3, flags: 0, data: new Uint8Array([7, 8, 9]) });
    expect(await receive(game)).toEqual({ hr: DP.NOMESSAGES });
    expect(await game.call({ op: "read" })).toMatchObject({ hr: 0 });
    expect(await game.call({ op: "connected" })).toMatchObject({ hr: 0 });
    for (const type of [1, 3]) {
        const message = await receive(lobby, 5000); expect(message.flags).toBe(3); expect(message.size).toBe(20);
        expect(new DataView(message.data!.buffer).getUint32(0, true)).toBe(type);
        expect([...message.data!.slice(4)]).toEqual(new Array(16).fill(0xbb));
    }
});
test("wait mode returns immediately, rejects writes and sends, cancels, and RunApplication reuses a waiting process", async () => {
    const lobby = root(); await lobby.call({ op: "launch", pid: 5000, settings: settings() }); const game = child(lobby, 5000);
    expect(await game.call({ op: "wait", flags: 1 })).toMatchObject({ hr: DP.UNAVAILABLE });
    expect(await game.call({ op: "wait", flags: 0 })).toMatchObject({ hr: 0 });
    expect(await game.call({ op: "wait", flags: 0 })).toMatchObject({ hr: 0 });
    expect(await game.call({ op: "get" })).toMatchObject({ hr: DP.UNAVAILABLE });
    expect(await game.call({ op: "set", settings: settings() })).toMatchObject({ hr: DP.UNAVAILABLE });
    expect(await game.call({ op: "send", data: new Uint8Array([1]) })).toMatchObject({ hr: DP.UNAVAILABLE });
    expect(await lobby.call({ op: "findWaiting", application: "a".repeat(32) })).toEqual({ hr: 0, pid: 5000 });
    const changed = settings(); changed.desc.name = "new";
    expect(await lobby.call({ op: "launch", pid: 5000, settings: changed })).toMatchObject({ hr: 0 });
    expect((await game.call({ op: "get" })).settings?.desc.name).toBe("new");
    const notification = await receive(game); expect(new DataView(notification.data!.buffer).getUint32(0, true)).toBe(10);
    expect(await game.call({ op: "wait", flags: 0 })).toMatchObject({ hr: 0 });
    expect(await game.call({ op: "wait", flags: 1 })).toMatchObject({ hr: 0 });
    expect(await game.call({ op: "get" })).toMatchObject({ hr: 0 });
});
test("child death delivers one APPTERMINATED and bounded send backpressure never consumes existing messages", async () => {
    const lobby = root(); await lobby.call({ op: "launch", pid: 5000, settings: settings() }); const game = child(lobby, 5000);
    for (let i = 0; i < 1024; i++) expect(await game.call({ op: "send", flags: 0, data: new Uint8Array([i & 255]) })).toMatchObject({ hr: 0 });
    expect(await game.call({ op: "send", flags: 0, data: new Uint8Array([99]) })).toMatchObject({ hr: 0x8877010e });
    game.ipc.close(); await new Promise(resolve => setTimeout(resolve, 4));
    for (let i = 0; i < 1024; i++) expect((await receive(lobby, 5000)).data?.[0]).toBe(i & 255);
    const terminal = await receive(lobby, 5000); expect(terminal.flags).toBe(1); expect(new DataView(terminal.data!.buffer).getUint32(0, true)).toBe(4);
    expect(await receive(lobby, 5000)).toMatchObject({ hr: DP.INVALIDPARAMS });
});
