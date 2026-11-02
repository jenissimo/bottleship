import { getProcessIdentity, type ProcessIdentityBoot } from "./process-identity";
export type ProcessIpcErrorCode = "NO_PROCESS" | "NO_HANDLER" | "CLOSED" | "TIMEOUT" | "QUEUE_FULL";
export class ProcessIpcError extends Error {
    constructor(readonly code: ProcessIpcErrorCode) { super(code); this.name = "ProcessIpcError"; }
}
type Handler = (payload: unknown, sourcePid: number) => unknown | Promise<unknown>;
type Packet = { kind: string; from?: number; to?: number; id?: number; topic?: string; payload?: unknown;
    value?: unknown; error?: ProcessIpcErrorCode; pids?: number[] };
interface Link { port: MessagePort; pids: Set<number>; closed: boolean; }
const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0 && (pid as number) <= 0x7fffffff;
/** Same-host IPC routing is independent of network sockets and guest address spaces. */
export class ProcessIpc {
    private handlers = new Map<string, Handler>();
    private systemHandlers = new Map<string, Handler>();
    private routes = new Map<number, Link>();
    private links = new Set<Link>();
    private parent?: Link;
    private pending = new Map<number, { target: number; resolve(value: unknown): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> | undefined }>();
    private exits = new Set<(pid: number) => void>();
    private deadPids = new Set<number>();
    private nextRequest = 1;
    private closed = false;
    private exited = false;
    private lifecycle = 0;
    constructor(readonly pid: number, readonly rootPid = pid) {
        if (!validPid(pid) || !validPid(rootPid)) throw new Error("Invalid process IPC identity");
    }
    get guestGeneration(): number { return this.lifecycle; }
    snapshot() {
        return { pid: this.pid, rootPid: this.rootPid, generation: this.lifecycle,
            alive: !this.closed && !this.exited, closed: this.closed,
            pending: this.pending.size, children: this.routes.size,
            handlers: this.handlers.size, services: this.systemHandlers.size };
    }
    isGuestLifetimeCurrent(generation: number): boolean {
        return !this.closed && !this.exited && generation === this.lifecycle;
    }
    /** A new root image may start only after every old child route is retired. */
    beginGuestLifetime(): void {
        if (this.closed) throw new ProcessIpcError("CLOSED");
        if (!this.exited) return;
        if (this.pid !== this.rootPid || this.links.size) throw new Error("Previous IPC guest routes are still active");
        ++this.lifecycle;
        this.exited = false;
        this.deadPids.delete(this.pid);
    }
    register(topic: string, handler: Handler): () => void {
        if (this.closed || this.exited) throw new ProcessIpcError("CLOSED");
        if (this.handlers.has(topic)) throw new Error("IPC topic already has an owner: " + topic);
        this.handlers.set(topic, handler); return () => { if (this.handlers.get(topic) === handler) this.handlers.delete(topic); };
    }
    /** PID zero addresses a host service, whose lifetime can outlast the root guest. */
    registerSystem(topic: string, handler: Handler): () => void {
        if (this.pid !== this.rootPid) throw new Error("Only the IPC root may own a system service");
        if (this.systemHandlers.has(topic)) throw new Error("IPC service already has an owner: " + topic);
        this.systemHandlers.set(topic, handler); return () => { if (this.systemHandlers.get(topic) === handler) this.systemHandlers.delete(topic); };
    }
    onProcessExit(listener: (pid: number) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
    request(targetPid: number, topic: string, payload: unknown, timeout: number | null = 10000): Promise<unknown> {
        if (this.closed || this.exited) return Promise.reject(new ProcessIpcError("CLOSED"));
        if (targetPid !== 0 && this.deadPids.has(targetPid)) return Promise.reject(new ProcessIpcError("NO_PROCESS"));
        if (this.pending.size >= 1024) return Promise.reject(new ProcessIpcError("QUEUE_FULL"));
        const id = this.nextRequest++ >>> 0 || this.nextRequest++ >>> 0;
        return new Promise((resolve, reject) => {
            // null means an NT-style indefinite wait; close/reset/peer death still reject it.
            const timer = timeout === null ? undefined : setTimeout(() => { this.pending.delete(id); reject(new ProcessIpcError("TIMEOUT")); }, timeout);
            this.pending.set(id, { target: targetPid, resolve, reject, timer });
            if (!this.route({ kind: "request", from: this.pid, to: targetPid, id, topic, payload })) {
                clearTimeout(timer); this.pending.delete(id); reject(new ProcessIpcError("NO_PROCESS"));
            }
        });
    }
    post(targetPid: number, topic: string, payload: unknown): boolean {
        return !this.closed && !this.exited && this.route({ kind: "post", from: this.pid, to: targetPid, topic, payload });
    }
    /** A root service may publish lifecycle notifications after the root guest has exited. */
    postSystem(targetPid: number, topic: string, payload: unknown): boolean {
        return this.pid === this.rootPid && !this.closed && this.route({ kind: "post", from: this.pid, to: targetPid, topic, payload });
    }
    connectChild(pid: number, port: MessagePort): () => void {
        if (this.closed || !validPid(pid) || this.routes.has(pid) || pid === this.pid) throw new Error("Duplicate or invalid child IPC identity");
        const link = this.attach(port); link.pids.add(pid); this.routes.set(pid, link);
        this.send(this.parent, { kind: "presence", pids: [pid] });
        return () => this.disconnect(link);
    }
    adoptParent(port: MessagePort): void {
        if (this.parent || this.closed || this.pid === this.rootPid) throw new Error("Invalid parent IPC adoption");
        this.parent = this.attach(port);
    }
    markProcessExited(pid: number): void {
        this.routes.delete(pid);
        if (pid === this.pid) {
            this.exited = true; ++this.lifecycle; this.handlers.clear();
            for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ProcessIpcError("CLOSED")); }
            this.pending.clear();
        }
        this.notifyExited([pid]);
        const message: Packet = { kind: "dead", pids: [pid] };
        this.send(this.parent, message);
        for (const link of this.links) if (link !== this.parent) this.send(link, message);
    }
    close(): void {
        if (this.closed) return;
        this.closed = true; ++this.lifecycle; this.handlers.clear(); this.systemHandlers.clear();
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ProcessIpcError("CLOSED")); }
        this.pending.clear();
        for (const link of this.links) { this.tellClose(link); link.closed = true; link.port.close(); }
        this.links.clear(); this.routes.clear(); this.parent = undefined;
    }
    private attach(port: MessagePort): Link {
        const link: Link = { port, pids: new Set(), closed: false };
        this.links.add(link);
        port.onmessage = event => this.receive(event.data as Packet, link);
        port.onmessageerror = () => this.disconnect(link);
        port.addEventListener("close", () => this.disconnect(link));
        port.start(); return link;
    }
    private send(link: Link | undefined, packet: Packet): boolean {
        if (!link || link.closed) return false;
        try { link.port.postMessage(packet); return true; } catch { this.disconnect(link); return false; }
    }
    private tellClose(link: Link): void { try { link.port.postMessage({ kind: "close" }); } catch {} }
    private disconnect(link: Link): void {
        if (link.closed) return;
        this.tellClose(link); link.closed = true; this.links.delete(link); link.port.close();
        const pids = [...link.pids];
        for (const pid of pids) if (this.routes.get(pid) === link) this.routes.delete(pid);
        if (link === this.parent) {
            this.parent = undefined;
            for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ProcessIpcError("CLOSED")); }
            this.pending.clear();
        } else {
            this.notifyExited(pids);
            const message: Packet = { kind: "dead", pids };
            this.send(this.parent, message);
            for (const child of this.links) if (child !== this.parent) this.send(child, message);
        }
    }
    private notifyExited(pids: number[]): void {
        for (const pid of pids) {
            if (this.deadPids.has(pid)) continue;
            this.deadPids.add(pid);
            if (this.deadPids.size > 4096) this.deadPids.delete(this.deadPids.values().next().value!);
            for (const [id, pending] of this.pending) if (pending.target === pid) {
                clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new ProcessIpcError("NO_PROCESS"));
            }
            for (const listener of this.exits) listener(pid);
        }
    }
    private receive(packet: Packet, link: Link): void {
        if (this.closed || link.closed || !packet || typeof packet !== "object") return;
        if (packet.kind === "close") { this.disconnect(link); return; }
        if (packet.kind === "presence" && link !== this.parent && Array.isArray(packet.pids)) {
            const pids = packet.pids.filter(validPid);
            if (pids.length > 4096 || pids.some(pid => pid === this.pid || (this.routes.has(pid) && this.routes.get(pid) !== link))) { this.disconnect(link); return; }
            for (const pid of pids) { this.routes.set(pid, link); link.pids.add(pid); }
            this.send(this.parent, { kind: "presence", pids }); return;
        }
        if (packet.kind === "dead" && Array.isArray(packet.pids)) {
            const pids = packet.pids.filter(validPid);
            for (const pid of pids) if (this.routes.get(pid) === link) { this.routes.delete(pid); link.pids.delete(pid); }
            this.notifyExited(pids);
            for (const child of this.links) if (child !== link) this.send(child, { kind: "dead", pids });
            return;
        }
        if (!validPid(packet.from) || (!validPid(packet.to) && packet.to !== 0) ||
            (link !== this.parent && !link.pids.has(packet.from))) return;
        if (!this.route(packet, link) && packet.kind === "request") this.route({ kind: "response", from: this.pid, to: packet.from, id: packet.id, error: "NO_PROCESS" });
    }
    private route(packet: Packet, incoming?: Link): boolean {
        if (this.closed) return false;
        // A live root broker still owns PID-zero services after its guest exits.
        // Death notifications are authoritative for guest destinations; do not send
        // a new request into a route that has already announced that PID's exit.
        if (packet.to !== 0 && this.deadPids.has(packet.to!) && (packet.kind === "request" || packet.kind === "post")) return false;
        if (packet.to === this.pid || (packet.to === 0 && this.pid === this.rootPid)) {
            if (packet.kind === "response") {
                const pending = this.pending.get(packet.id!); if (!pending) return true;
                clearTimeout(pending.timer); this.pending.delete(packet.id!);
                if (packet.error) pending.reject(new ProcessIpcError(packet.error)); else pending.resolve(packet.value);
            } else {
                const handler = (packet.to === 0 ? this.systemHandlers : this.handlers).get(packet.topic!);
                if (!handler || (packet.to !== 0 && this.exited)) {
                    if (packet.kind === "request") this.route({ kind: "response", from: this.pid, to: packet.from, id: packet.id, error: this.exited ? "NO_PROCESS" : "NO_HANDLER" });
                    return true;
                }
                const lifecycle = this.lifecycle, system = packet.to === 0;
                const current = () => !this.closed && ((system && packet.from !== this.pid) || lifecycle === this.lifecycle) &&
                    (system ? this.systemHandlers : this.handlers).get(packet.topic!) === handler;
                void Promise.resolve().then(() => {
                    if (!current()) throw new ProcessIpcError("CLOSED");
                    return handler(structuredClone(packet.payload), packet.from!);
                }).then(value => {
                    if (!current()) return;
                    if (packet.kind === "request") this.route({ kind: "response", from: this.pid, to: packet.from, id: packet.id, value });
                }, () => {
                    if (!current()) return;
                    if (packet.kind === "request") this.route({ kind: "response", from: this.pid, to: packet.from, id: packet.id, error: "NO_HANDLER" });
                });
            }
            return true;
        }
        const target = this.routes.get(packet.to!);
        if (target && target !== incoming) return this.send(target, packet);
        return this.parent !== incoming && this.send(this.parent, packet);
    }
}
let ipc: ProcessIpc | undefined;
let guestLifetimeStarted = false;
export function processIpcState() { return ipc?.snapshot() ?? null; }
export function getProcessIpc(): ProcessIpc {
    const identity = getProcessIdentity(); return ipc ??= new ProcessIpc(identity.pid, identity.rootPid);
}
/** Boot/exit boundaries belong to the guest; the root's host services retain their router. */
export function beginProcessIpcLifetime(): void {
    if (guestLifetimeStarted) throw new Error("A guest IPC lifetime is already active");
    getProcessIpc().beginGuestLifetime();
    guestLifetimeStarted = true;
}
export function finishProcessIpcLifetime(): void {
    if (!guestLifetimeStarted) return;
    guestLifetimeStarted = false;
    if (ipc) ipc.markProcessExited(ipc.pid);
}
export function createChildProcessIpc(pid: number): { port: MessagePort; close(): void } {
    const channel = new MessageChannel(), close = getProcessIpc().connectChild(pid, channel.port1);
    return { port: channel.port2, close };
}
export function adoptProcessIpc(identity: ProcessIdentityBoot, port: MessagePort): void {
    if (ipc) throw new Error("Process IPC already initialized");
    ipc = new ProcessIpc(identity.pid, identity.rootPid); ipc.adoptParent(port);
}
