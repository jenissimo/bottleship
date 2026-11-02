import { ChildProcessNetworkNamespace } from "../../../src/worker/core/network-namespace";
import { LanNetwork } from "../../../src/worker/net/lan-network";
import { createWsaActorTable, type WsaActorTable } from "../../../src/worker/modules/wsa-actor-table";
import { ipv4Address, WsaFailure } from "../../../src/worker/modules/wsa-network";
import { Mem } from "../../../src/worker/core/memory/mem-accessor";
import { makeSocketExports, makeWsaCleanup, WsaStartupCount } from "../../../src/worker/modules/wsa-stub-shared";
let table: WsaActorTable, namespace: ChildProcessNetworkNamespace, counter: WsaStartupCount;
let api: ReturnType<typeof makeSocketExports>, cleanup: ReturnType<typeof makeWsaCleanup>, error = 0;
const ram = new Uint8Array(1 << 20), data = 0x20000, length = 0x22000, protocol = 0x24000;
const put = (p: number, v: number) => new DataView(ram.buffer).setUint32(p, v, true);
const get = (p: number) => new DataView(ram.buffer).getUint32(p, true);
function invoke(name: string, args: number[]): number {
    const result = api[name]({} as never, ram, args);
    if (typeof result !== "number") throw Error("Unexpected asynchronous worker option operation");
    if (result === -1 || result === 0xffffffff) throw new WsaFailure(error);
    return result;
}
self.onmessage = async ({ data: message }) => {
    try {
        if (message.boot) {
            const network = new LanNetwork(); namespace = new ChildProcessNetworkNamespace(network, message.boot);
            await namespace.barrier(); table = createWsaActorTable(network, () => namespace.socketActorClient());
            Mem.bind(() => ram); counter = new WsaStartupCount(() => table.reset()); counter.startup();
            api = makeSocketExports(table, value => { error = value; }, counter); cleanup = makeWsaCleanup(counter, value => { error = value; });
            self.postMessage({ id: message.id, result: true }); return;
        }
        const args = message.args ?? {}; let result: unknown;
        switch (message.command) {
            case "create": {
                const socket = invoke("socket", [2, 2, 17]);
                put(data, 1); invoke("setsockopt", [socket, 0xffff, 4, data, 4]);
                table.bind(socket, ipv4Address(new Uint8Array(4), args.port)); result = socket; break;
            }
            case "set": put(data, args.value); result = invoke("setsockopt", [args.socket, 0, args.option, data, 4]); break;
            case "get": put(length, 4); invoke("getsockopt", [args.socket, 0, args.option, data, length]); result = get(data); break;
            case "member":
                ram.set(args.group, data); ram.set(args.interface ?? [127, 0, 0, 1], data + 4);
                result = invoke("setsockopt", [args.socket, 0, args.join ? 12 : 13, data, 8]); break;
            case "duplicate":
                invoke("WSADuplicateSocketA", [args.socket, args.pid, protocol]);
                result = { handle: get(protocol + 112), descriptor: ram.slice(protocol, protocol + 372) }; break;
            case "import":
                ram.set(args.descriptor, protocol);
                result = invoke("WSASocketA", [-1, -1, -1, protocol, 0, 1]); break;
            case "close": result = invoke("closesocket", [args.socket]); break;
            case "readable": result = table.readable(args.socket); break;
            case "receive": {
                const packet = table.receive(args.socket, 65535);
                result = { data: packet.data, ip: packet.from.ip }; break;
            }
            case "cleanup": result = cleanup({} as never, ram, []); break;
            case "startup": counter.startup(); result = true; break;
            default: throw Error("Unknown multicast actor test command");
        }
        self.postMessage({ id: message.id, result });
    } catch (failure) { self.postMessage({ id: message.id, error: failure instanceof WsaFailure ? failure.code : String(failure) }); }
};
