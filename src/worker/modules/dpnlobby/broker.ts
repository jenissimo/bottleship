import { ProcessIpc, getProcessIpc } from "../../core/process-ipc";
import { DPN } from "../dpnet/constants";
import { LOBBY8_TOPIC, LOBBY8_NOTIFY } from "./constants";
import { settingsStorage, type Lobby8Event, type Lobby8Program, type Lobby8Settings } from "./structures";
export type Lobby8Kind = "client" | "app";
interface Participant { pid: number; token: number; kind: Lobby8Kind; image: string; available: boolean; multiple: boolean; events: Lobby8Event[]; bytes: number; }
interface Connection { id: number; client: number; app: number; settings?: Lobby8Settings; bytes: number; data: Uint8Array; accepted: boolean; result: number; waiters: Set<(reply: Lobby8Reply) => void>; }
export interface Lobby8Request {
    op: string; kind?: Lobby8Kind; token?: number; image?: string; guid?: string; program?: Lobby8Program;
    connection?: number; app?: number; available?: boolean; multiple?: boolean; settings?: Lobby8Settings;
    data?: Uint8Array; result?: number; status?: number; serial?: number; timeout?: number;
}
export interface Lobby8Reply { hr: number; connection?: number; app?: number; program?: Lobby8Program; programs?: Lobby8Program[]; settings?: Lobby8Settings; event?: Lobby8Event; }
const clone = <T>(value: T): T => structuredClone(value);
const imageKey = (value: string) => value.replace(/\\/g, "/").toLowerCase();
/** Per-machine DirectPlay8 lobby service. Only canonical owned data crosses worker boundaries. */
export class DirectPlay8LobbyBroker {
    private participants = new Map<string, Participant>();
    private connections = new Map<number, Connection>();
    private programs = new Map<string, Lobby8Program>();
    private nextConnection = 1;
    private connectionBytes = 0;
    private nextSerial = 1;
    private off: (() => void)[];
    constructor(readonly ipc: ProcessIpc, programs: Lobby8Program[] = [],
        private registration?: (program: Lobby8Program | string) => void,
        private catalog?: () => Lobby8Program[]) {
        for (const program of programs) this.programs.set(program.guid, clone(program));
        this.off = [ipc.registerSystem(LOBBY8_TOPIC, (request, source) => this.dispatch(request as Lobby8Request, source)),
            ipc.onProcessExit(pid => this.exited(pid))];
    }
    close(): void {
        for (const off of this.off) off(); this.off = [];
        for (const connection of [...this.connections.values()]) this.disconnect(connection, DPN.CONNECTIONLOST);
        this.participants.clear(); this.programs.clear();
    }
    private participant(pid: number, kind: Lobby8Kind): Participant | undefined { return this.participants.get(pid + ":" + kind); }
    private member(connection: Connection, source: number, kind: Lobby8Kind): boolean { return (kind === "client" ? connection.client : connection.app) === source; }
    private queue(participant: Participant | undefined, event: Omit<Lobby8Event, "serial">, terminal = false): boolean {
        if (!participant) return false;
        const bytes = (event.data?.length ?? 0) + settingsStorage(event.settings);
        if (!terminal && (participant.events.length >= 1024 || participant.bytes + bytes > 4 * 1024 * 1024)) return false;
        participant.events.push(clone({ ...event, serial: this.nextSerial++ })); participant.bytes += bytes;
        this.ipc.postSystem(participant.pid, LOBBY8_NOTIFY, { kind: participant.kind, token: participant.token });
        return true;
    }
    private disconnect(connection: Connection, reason: number, caller?: number): void {
        if (!this.connections.delete(connection.id)) return;
        this.connectionBytes -= connection.bytes;
        for (const wait of connection.waiters) wait({ hr: reason }); connection.waiters.clear();
        for (const [pid, kind] of [[connection.client, "client"], [connection.app, "app"]] as const) {
            if (pid !== caller) this.queue(this.participant(pid, kind), { type: 3, connection: connection.id, result: reason }, true);
        }
    }
    private exited(pid: number): void {
        this.participants.delete(pid + ":client"); this.participants.delete(pid + ":app");
        for (const connection of [...this.connections.values()]) if (connection.app === pid || connection.client === pid) this.disconnect(connection, DPN.CONNECTIONLOST, pid);
    }
    dispatch(request: Lobby8Request, source: number): Lobby8Reply | Promise<Lobby8Reply> {
        if (!request || typeof request.op !== "string") return { hr: DPN.INVALIDPARAM };
        if (this.catalog && ["register", "unregister", "enum", "find"].includes(request.op)) {
            this.programs = new Map(this.catalog().map(program => [program.guid, clone(program)]));
        }
        if (request.op === "register") {
            if (!request.program) return { hr: DPN.INVALIDPARAM };
            const bytes = (program: Lobby8Program) => program.strings.reduce((n, text) => n + (text?.length ?? 0) * 2, 64);
            const used = [...this.programs.values()].reduce((n, program) => n + bytes(program), 0);
            if ((!this.programs.has(request.program.guid) && this.programs.size >= 4096) || used - (this.programs.has(request.program.guid) ? bytes(this.programs.get(request.program.guid)!) : 0) + bytes(request.program) > 4 * 1024 * 1024) return { hr: DPN.TABLEFULL };
            this.programs.set(request.program.guid, clone(request.program)); this.registration?.(request.program);
            return { hr: DPN.OK };
        }
        if (request.op === "unregister") {
            if (!request.guid) return { hr: DPN.INVALIDPARAM };
            this.programs.delete(request.guid); this.registration?.(request.guid); return { hr: DPN.OK };
        }
        const kind = request.kind ?? "client", key = source + ":" + kind;
        let participant = this.participants.get(key);
        if (request.op === "initialize") {
            if (participant) return { hr: participant.token === request.token ? DPN.ALREADYINITIALIZED : DPN.NOTALLOWED };
            if (this.participants.size >= 1024) return { hr: DPN.TABLEFULL };
            participant = { pid: source, kind, token: request.token!, image: request.image ?? "", available: true, multiple: false, events: [], bytes: 0 };
            this.participants.set(key, participant);
            const pending = kind === "app" ? [...this.connections.values()].find(c => c.app === source && !c.accepted) : undefined;
            if (pending) this.queue(participant, { type: 2, connection: pending.id, settings: pending.settings, data: pending.data });
            return { hr: DPN.OK, connection: pending?.id ?? 0 };
        }
        if (!participant || participant.token !== request.token) return { hr: DPN.UNINITIALIZED };
        if (request.op === "close") {
            this.participants.delete(key);
            for (const connection of [...this.connections.values()]) if (this.member(connection, source, kind)) this.disconnect(connection, DPN.CONNECTIONLOST, source);
            return { hr: DPN.OK };
        }
        if (request.op === "enum") {
            const programs = [...this.programs.values()].filter(p => !request.guid || p.guid === request.guid).map(program => {
                const filename = imageKey(program.strings[4] ?? "");
                const running = [...this.participants.values()].filter(p => p.kind === "app" && imageKey(p.image).split("/").pop() === filename);
                return { ...clone(program), running: running.length, waiting: running.filter(p => p.available && (p.multiple || ![...this.connections.values()].some(c => c.app === p.pid))).length };
            });
            return { hr: DPN.OK, programs };
        }
        if (request.op === "find") {
            const program = request.guid ? this.programs.get(request.guid) : undefined;
            if (!program) return { hr: DPN.DOESNOTEXIST };
            const file = imageKey(program.strings[4] ?? "");
            const app = [...this.participants.values()].find(p => p.kind === "app" && p.available &&
                imageKey(p.image).split("/").pop() === file && (p.multiple || ![...this.connections.values()].some(c => c.app === p.pid)));
            return { hr: DPN.OK, program: clone(program), app: app?.pid };
        }
        if (request.op === "available") { participant.available = !!request.available; participant.multiple = !!request.multiple; return { hr: DPN.OK }; }
        if (request.op === "peek") return { hr: DPN.OK, event: participant.events[0] ? clone(participant.events[0]) : undefined };
        if (request.op === "ack") {
            if (participant.events[0]?.serial === request.serial) {
                const event = participant.events.shift()!;
                participant.bytes -= (event.data?.length ?? 0) + settingsStorage(event.settings);
            }
            return { hr: DPN.OK };
        }
        if (request.op === "attach") {
            if (kind !== "client" || !request.app || this.connections.size >= 1024) return { hr: DPN.INVALIDPARAM };
            const app = this.participant(request.app, "app");
            if (participant.events.length >= 1024 || (app && app.events.length >= 1024)) return { hr: DPN.TABLEFULL };
            if (app && (!app.available || (!app.multiple && [...this.connections.values()].some(c => c.app === app.pid)))) return { hr: DPN.NOTREADY };
            const bytes = settingsStorage(request.settings) + (request.data?.length ?? 0);
            if (this.connectionBytes + bytes > 16 * 1024 * 1024) return { hr: DPN.TABLEFULL };
            const id = this.nextConnection++ >>> 0;
            const connection: Connection = { id, client: source, app: request.app, settings: clone(request.settings), bytes,
                data: request.data?.slice() ?? new Uint8Array(), accepted: false, result: DPN.OK, waiters: new Set() };
            if (app && !this.queue(app, { type: 2, connection: id, settings: connection.settings, data: connection.data })) return { hr: DPN.TABLEFULL };
            this.connections.set(id, connection); this.connectionBytes += bytes; return { hr: DPN.OK, connection: id };
        }
        if (request.connection === 0xffffffff && ["send", "release", "set", "status", "publish"].includes(request.op)) {
            const targets = [...this.connections.values()].filter(connection => this.member(connection, source, kind));
            for (const target of targets) {
                const result = this.dispatch({ ...request, connection: target.id }, source) as Lobby8Reply;
                if (result.hr) return result;
            }
            return { hr: DPN.OK };
        }
        const connection = this.connections.get(request.connection ?? 0);
        if (!connection || !this.member(connection, source, kind)) return { hr: DPN.INVALIDHANDLE };
        const remote = this.participant(kind === "client" ? connection.app : connection.client, kind === "client" ? "app" : "client");
        if (request.op === "accept") {
            if (kind !== "app") return { hr: DPN.NOTALLOWED };
            connection.accepted = true; connection.result = request.result ?? DPN.OK;
            for (const wait of connection.waiters) wait({ hr: connection.result, connection: connection.id }); connection.waiters.clear();
            if (connection.result & 0x80000000) this.disconnect(connection, connection.result, source);
            return { hr: DPN.OK };
        }
        if (request.op === "wait") {
            if (connection.accepted) return { hr: connection.result, connection: connection.id };
            return new Promise(resolve => {
                const done = (reply: Lobby8Reply) => { clearTimeout(timer); connection.waiters.delete(done); resolve(reply); };
                // Connection approval is an NT-style indefinite wait; endpoint close/process death cancels it.
                const timer = undefined; connection.waiters.add(done);
            });
        }
        if (request.op === "release") { this.disconnect(connection, DPN.OK, source); return { hr: DPN.OK }; }
        if (request.op === "publish") {
            if (!remote) return { hr: DPN.INVALIDHANDLE };
            const extra = request.settings ? settingsStorage(request.settings) : 0;
            const count = request.settings ? 2 : 1;
            if (remote.events.length + count > 1024 || remote.bytes + extra > 4 * 1024 * 1024) return { hr: DPN.TABLEFULL };
            if (request.settings) {
                const bytes = settingsStorage(request.settings) + connection.data.length;
                if (this.connectionBytes - connection.bytes + bytes > 16 * 1024 * 1024) return { hr: DPN.TABLEFULL };
                this.connectionBytes += bytes - connection.bytes; connection.bytes = bytes; connection.settings = clone(request.settings);
                this.queue(remote, { type: 5, connection: connection.id, settings: request.settings });
            }
            this.queue(remote, { type: 4, connection: connection.id, status: request.status });
            return { hr: DPN.OK };
        }
        if (request.op === "get") return { hr: connection.settings ? DPN.OK : DPN.DOESNOTEXIST, settings: clone(connection.settings) };
        if (request.op === "set") {
            const bytes = settingsStorage(request.settings) + connection.data.length;
            if (this.connectionBytes - connection.bytes + bytes > 16 * 1024 * 1024) return { hr: DPN.TABLEFULL };
            if (!this.queue(remote, { type: 5, connection: connection.id, settings: request.settings })) return { hr: DPN.TABLEFULL };
            this.connectionBytes += bytes - connection.bytes; connection.bytes = bytes;
            connection.settings = clone(request.settings); return { hr: DPN.OK };
        }
        if (request.op === "send") {
            if (!request.data?.length || request.data.length > 65536) return { hr: DPN.INVALIDPARAM };
            return { hr: this.queue(remote, { type: 1, connection: connection.id, data: request.data }) ? DPN.OK : DPN.TABLEFULL };
        }
        if (request.op === "status") return { hr: this.queue(remote, { type: 4, connection: connection.id, status: request.status }) ? DPN.OK : DPN.TABLEFULL };
        return { hr: DPN.INVALIDPARAM };
    }
}
const brokers = new WeakMap<ProcessIpc, DirectPlay8LobbyBroker>();
export function ensureLobby8Broker(ipc = getProcessIpc(), programs: Lobby8Program[] = [], registration?: (program: Lobby8Program | string) => void, catalog?: () => Lobby8Program[]): void {
    if (ipc.pid === ipc.rootPid && !brokers.has(ipc)) brokers.set(ipc, new DirectPlay8LobbyBroker(ipc, programs, registration, catalog));
}
export class DirectPlay8LobbyEndpoint {
    private off: () => void;
    private readonly generation: number;
    onMessage?: (kind: Lobby8Kind, token: number) => void;
    constructor(readonly ipc = getProcessIpc()) {
        this.generation = ipc.guestGeneration;
        ensureLobby8Broker(ipc);
        this.off = ipc.register(LOBBY8_NOTIFY, payload => {
            const message = payload as { kind?: Lobby8Kind; token?: number };
            if (message && (message.kind === "app" || message.kind === "client")) this.onMessage?.(message.kind, message.token ?? 0);
        });
    }
    call(request: Lobby8Request): Lobby8Reply | Promise<Lobby8Reply> {
        if (!this.ipc.isGuestLifetimeCurrent(this.generation)) return { hr: DPN.CONNECTIONLOST };
        const local = brokers.get(this.ipc);
        return local ? local.dispatch(clone(request), this.ipc.pid) :
            this.ipc.request(0, LOBBY8_TOPIC, request, request.op === "wait" ? null : 10000).then(reply => reply as Lobby8Reply, () => ({ hr: DPN.CONNECTIONLOST }));
    }
    close(): void { this.off(); }
}
