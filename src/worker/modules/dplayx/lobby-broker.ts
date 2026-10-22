import { ProcessIpc, getProcessIpc } from "../../core/process-ipc";
import { DP, type SessionDesc, type PlayerName } from "./session";
export interface LobbySettings { desc: SessionDesc; create: boolean; player: PlayerName | null; provider: string; address: Uint8Array; }
export interface LobbyReply { hr: number; settings?: LobbySettings; pid?: number; flags?: number; size?: number; data?: Uint8Array; }
interface LobbyMessage { flags: number; data: Uint8Array; }
interface Game {
    pid: number; lobby: number; application: string; settings?: LobbySettings; wait: boolean; pending: boolean; dead: boolean;
    queues: Map<number, LobbyMessage[]>; subscribers: Set<number>; bytes: Map<number, number>;
}
interface Request { op: string; game?: number; pid?: number; settings?: LobbySettings; application?: string;
    flags?: number; data?: Uint8Array; capacity?: number; output?: boolean; type?: number; }
export const LOBBY_TOPIC = "directplay-lobby";
export const LOBBY_NOTIFY = "directplay-lobby-notification";
export const DPERR_NOTLOBBIED = 0x8877042e;
const clone = <T>(value: T): T => structuredClone(value);
const system = (type: number, instance?: string): Uint8Array => {
    const data = new Uint8Array(20); new DataView(data.buffer).setUint32(0, type, true);
    if (instance && /^[0-9a-f]{32}$/i.test(instance)) data.set(Uint8Array.from(instance.match(/../g)!, n => parseInt(n, 16)), 4);
    return data;
};
/** Canonical same-machine lobby state: payloads never contain guest pointers or handles. */
export class DirectPlayLobbyBroker {
    private games = new Map<number, Game>();
    private unsubscribe: (() => void)[];
    constructor(private ipc: ProcessIpc) {
        this.unsubscribe = [ipc.registerSystem(LOBBY_TOPIC, (payload, pid) => this.dispatch(payload as Request, pid)),
            ipc.onProcessExit(pid => this.exited(pid))];
    }
    close(): void { for (const off of this.unsubscribe) off(); this.unsubscribe = []; this.games.clear(); }
    private game(pid: number, create = false): Game | undefined {
        let game = this.games.get(pid);
        if (!game && create && this.games.size < 1024) {
            game = { pid, lobby: 0, application: "", wait: false, pending: false, dead: false,
                queues: new Map(), subscribers: new Set(), bytes: new Map() };
            this.games.set(pid, game);
        }
        return game;
    }
    private access(id: number | undefined, source: number, create = false): Game | undefined {
        const game = this.game(id || source, create && !id);
        return game && (!id || game.lobby === source) ? game : undefined;
    }
    private enqueue(game: Game, receiver: number, message: LobbyMessage, terminal = false): number {
        if (!receiver) return DP.INVALIDPARAMS;
        const queue = game.queues.get(receiver) ?? [], bytes = game.bytes.get(receiver) ?? 0;
        if (!terminal && (queue.length >= 1024 || bytes + message.data.length > 4 * 1024 * 1024)) return 0x8877010e; // DPERR_BUSY (270)
        queue.push({ flags: message.flags, data: message.data.slice() });
        game.queues.set(receiver, queue); game.bytes.set(receiver, bytes + message.data.length);
        this.notify(game, receiver); return DP.OK;
    }
    private notify(game: Game, receiver: number): void {
        if (game.subscribers.has(receiver)) this.ipc.postSystem(receiver, LOBBY_NOTIFY, { game: game.pid });
    }
    private sys(game: Game, receiver: number, type: number, terminal = false): number {
        return this.enqueue(game, receiver, { flags: terminal ? 1 : 3, data: system(type, game.settings?.desc.instance) }, terminal);
    }
    dispatch(request: Request, source: number): LobbyReply {
        if (!request || typeof request.op !== "string") return { hr: DP.INVALIDPARAMS };
        if (request.op === "resetOwner") {
            this.games.delete(source);
            for (const game of this.games.values()) game.subscribers.delete(source);
            return { hr: DP.OK };
        }
        if (request.op === "findWaiting") {
            const game = [...this.games.values()].find(g => !g.dead && g.wait && g.application === request.application);
            return { hr: game ? DP.OK : DP.UNAVAILABLE, pid: game?.pid };
        }
        if (request.op === "launch") {
            if (!Number.isInteger(request.pid) || !request.pid || !request.settings) return { hr: DP.INVALIDPARAMS };
            const previous = this.game(request.pid), game = this.game(request.pid, true);
            if (!game || game.dead || (game.lobby && game.lobby !== source && !game.wait)) return { hr: DP.INVALIDPARAMS };
            const reuse = !!previous?.wait;
            if (reuse) { const hr = this.sys(game, game.pid, 10); if (hr) return { hr }; }
            game.lobby = source; game.application = request.settings.desc.application;
            game.settings = clone(request.settings); game.wait = false; game.pending = false;
            game.queues.delete(source); game.bytes.delete(source);
            return { hr: DP.OK, pid: game.pid };
        }
        const canCreate = ["set", "wait", "subscribe"].includes(request.op);
        const game = this.access(request.game, source, canCreate);
        if (!game) return { hr: request.op === "get" && !request.game ? DPERR_NOTLOBBIED : DP.INVALIDPARAMS };
        switch (request.op) {
            case "set":
                if (!request.settings) return { hr: DP.INVALIDPARAMS };
                if (game.wait) return { hr: DP.UNAVAILABLE };
                game.settings = clone(request.settings); game.application = request.settings.desc.application;
                return { hr: DP.OK };
            case "get":
                if (game.wait && !game.pending) return { hr: DP.UNAVAILABLE };
                if (!game.settings) return { hr: DPERR_NOTLOBBIED };
                game.wait = false; game.pending = false;
                return { hr: DP.OK, settings: clone(game.settings) };
            case "read":
                return { hr: source === game.pid && game.lobby ? this.sys(game, game.lobby, 1) : DP.OK };
            case "wait":
                if (request.flags! & ~1) return { hr: DP.INVALIDFLAGS };
                if (request.flags) {
                    if (!game.wait) return { hr: DP.UNAVAILABLE };
                    game.wait = false; game.pending = false; return { hr: DP.OK };
                }
                if (!game.wait) {
                    if (game.lobby) { const hr = this.sys(game, game.lobby, 4); if (hr) return { hr }; }
                    game.wait = true; game.pending = false;
                    game.queues.delete(source); game.bytes.delete(source);
                }
                if (request.application) game.application = request.application;
                return { hr: DP.OK };
            case "subscribe":
                if (request.flags) {
                    game.subscribers.add(source);
                    if (game.queues.get(source)?.length) this.notify(game, source);
                } else game.subscribers.delete(source);
                return { hr: DP.OK };
            case "send": {
                if (game.wait || game.dead) return { hr: DP.UNAVAILABLE };
                const data = request.data;
                if (!(data instanceof Uint8Array) || data.length > 65536) return { hr: DP.INVALIDPARAMS };
                if (request.flags! & ~2) return { hr: DP.INVALIDFLAGS };
                if (request.flags && (data.length < 4 || ![5, 7].includes(new DataView(data.buffer, data.byteOffset).getUint32(0, true)))) return { hr: DP.INVALIDPARAMS };
                return { hr: this.enqueue(game, source === game.pid ? game.lobby : game.pid, { flags: request.flags ?? 0, data }) };
            }
            case "receive": {
                const queue = game.queues.get(source), message = queue?.[0];
                if (!message) return { hr: DP.NOMESSAGES };
                const size = message.data.length;
                if (!request.output || request.capacity! < size) return { hr: DP.BUFFERTOOSMALL, size };
                queue!.shift(); game.bytes.set(source, game.bytes.get(source)! - size);
                const reply = { hr: DP.OK, size, flags: message.flags, data: message.data.slice() };
                if (game.dead && !queue!.length) this.games.delete(game.pid);
                return reply;
            }
            case "connected":
                if (source !== game.pid) return { hr: DP.INVALIDPARAMS };
                return { hr: game.lobby ? this.sys(game, game.lobby, request.flags ? 2 : 3) : DP.OK };
            case "detach":
                game.subscribers.delete(source); return { hr: DP.OK };
            default: return { hr: DP.INVALIDPARAMS };
        }
    }
    private exited(pid: number): void {
        const game = this.games.get(pid);
        if (game) {
            game.dead = true; game.subscribers.delete(pid); game.queues.delete(pid); game.bytes.delete(pid);
            if (game.lobby) this.sys(game, game.lobby, 4, true); else this.games.delete(pid);
        }
        for (const record of this.games.values()) if (record.lobby === pid) {
            record.lobby = 0; record.subscribers.delete(pid); record.queues.delete(pid); record.bytes.delete(pid);
            if (record.dead) this.games.delete(record.pid);
        }
    }
}
const brokers = new WeakMap<ProcessIpc, DirectPlayLobbyBroker>();
export function ensureLobbyBroker(ipc = getProcessIpc()): void {
    if (ipc.pid === ipc.rootPid && !brokers.has(ipc)) brokers.set(ipc, new DirectPlayLobbyBroker(ipc));
}
export class DirectPlayLobbyEndpoint {
    private off: () => void;
    private closed = false;
    private readonly generation: number;
    onMessage?: (game: number) => void;
    constructor(readonly ipc = getProcessIpc()) {
        this.generation = ipc.guestGeneration;
        ensureLobbyBroker(ipc);
        this.off = ipc.register(LOBBY_NOTIFY, payload => {
            if (!this.closed && payload && typeof payload === "object") this.onMessage?.(Number((payload as { game: number }).game));
        });
    }
    call(request: Request): LobbyReply | Promise<LobbyReply> {
        if (this.closed || !this.ipc.isGuestLifetimeCurrent(this.generation)) return { hr: DP.UNAVAILABLE };
        const local = brokers.get(this.ipc);
        if (local) return local.dispatch(clone(request), this.ipc.pid);
        return this.ipc.request(0, LOBBY_TOPIC, request).then(value => value as LobbyReply, () => ({ hr: DP.UNAVAILABLE }));
    }
    close(): void {
        if (!this.closed) { void this.call({ op: "resetOwner" }); this.closed = true; this.off(); }
    }
}
