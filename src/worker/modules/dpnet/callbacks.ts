import type { Process } from "../../core/process";
import { DirectPlayCallbackExecutor, type DirectPlayCallbackChannel, type DirectPlayCallbackTask } from "./executor";
import { Mem } from "../../core/memory/mem-accessor";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { nodeToIpv4 } from "../../net/lan-network";
import { DirectPlayGuestMemory } from "./guest-memory";
import { DirectPlayAddress } from "./address";
import type { DirectPlayAddressApi } from "./address-api";
import type { DirectPlay8Session, DirectPlay8Event } from "./peer";
import type { JoinRequest, JoinDecision } from "../dplayx/session";
import { DPN } from "./constants";

interface ReceiveBuffer { pointer: number; size: number; active: boolean; returned: boolean; release(): void; }
export class DirectPlay8Callbacks {
    readonly queue: DirectPlayCallbackChannel;
    private waiting: DirectPlayCallbackTask[] = [];
    private waitingBytes = 0;
    private retry?: ReturnType<typeof setTimeout>;
    private closed = false;
    private closing = false;
    onSpace?: () => void;
    private buffers = new Map<number, ReceiveBuffer>();
    private nextBuffer = 1;
    private reservedReceiveCount = 0;
    private reservedReceiveBytes = 0;
    private guest: DirectPlayGuestMemory;
    constructor(readonly process: Process, readonly session: DirectPlay8Session, readonly addresses: DirectPlayAddressApi,
        readonly routine: number, readonly userContext: number) {
        this.queue = DirectPlayCallbackExecutor.forProcess(process).channel();
        this.guest = new DirectPlayGuestMemory(process);
        this.queue.onSpace = () => { this.promote(); if (!this.closed) { this.onSpace?.(); this.session.resumeCallbacks(); } };
    }
    get pending(): number { return this.queue.size + this.waiting.length; }
    native(type: number, size: number, fill: (ptr: number) => void = () => {}, onReturn?: (hr: number, ptr: number) => boolean | void, onDiscard?: () => void, key?: object): boolean {
        if (this.closed) return false;
        const task: DirectPlayCallbackTask = {
            storageBytes: size + 64, message: type, key,
            prepare: () => {
                const ptr = size ? this.process.memory.alloc(size) : 0;
                if (size && !ptr) { onDiscard?.(); throw new Error("DirectPlay callback allocation failed"); }
                if (size) { Mem.writeBytes(ptr, new Uint8Array(size)); Mem.writeUint32(ptr, size); fill(ptr); }
                let released = false;
                const free = () => { if (!released && ptr) { released = true; this.process.memory.free(ptr); } };
                return { routine: this.routine, args: [this.userContext, (0xffff0000 | type) >>> 0, ptr],
                    onReturn: hr => {
                        if (this.closed) { free(); onDiscard?.(); return; }
                        let retained = false;
                        try { retained = !!onReturn?.(hr, ptr); } finally { if (!retained) free(); }
                    },
                    onDiscard: () => { free(); onDiscard?.(); } };
            }, onDiscard,
        };
        if (!this.waiting.length && this.queue.enqueue(task)) return true;
        if (this.waiting.length >= 2048 || this.waitingBytes + size + 64 > 8 * 1024 * 1024) return false;
        this.waitingBytes += size + 64; this.waiting.push(task); this.kick(); return true;
    }
    private promote(): void {
        if (this.closed) return;
        while (this.waiting.length && this.queue.enqueue(this.waiting[0])) this.waitingBytes -= this.waiting.shift()!.storageBytes!;
    }
    private kick(): void {
        if (this.retry || this.closed) return;
        this.retry = setTimeout(() => {
            this.retry = undefined;
            this.promote();
            if (this.waiting.length) this.kick();
        }, 4);
        (this.retry as unknown as { unref?(): void }).unref?.();
    }
    beginClose(): void {
        this.closing = true;
        const resume = this.queue.pause();
        const retained: DirectPlayCallbackTask[] = [];
        for (const task of this.waiting) {
            if (task.message === 0x11) { this.waitingBytes -= task.storageBytes!; task.onDiscard?.(); }
            else retained.push(task);
        }
        this.waiting = retained;
        this.queue.cancelPending(task => task.message === 0x11);
        resume();
    }
    async flush(): Promise<void> { while (!this.closed && this.pending) await new Promise(resolve => setTimeout(resolve, 4)); }
    close(): void {
        if (this.closed) return; this.closed = true;
        if (this.retry) clearTimeout(this.retry); this.retry = undefined;
        for (const task of this.waiting.splice(0)) task.onDiscard?.(); this.waitingBytes = 0;
        this.queue.close();
        for (const buffer of this.buffers.values()) if (!buffer.active) { this.process.memory.free(buffer.pointer); buffer.release(); }
        this.buffers.clear();
    }
    returnBuffer(handle: number): number {
        const buffer = this.buffers.get(handle); if (!buffer || buffer.returned) return DPN.INVALIDHANDLE;
        buffer.returned = true;
        if (!buffer.active) { this.process.memory.free(buffer.pointer); this.buffers.delete(handle); buffer.release(); this.session.resumeCallbacks(); }
        return DPN.OK;
    }
    emit(event: DirectPlay8Event): boolean {
        if (this.closing && event.type === 0x11) return true;
        const id = event.id ?? 0, context = event.context ?? 0;
        if (event.type === 2) return this.native(2, 0);
        if (event.type === 7 || event.type === 6) {
            const group = event.type === 6, size = group ? 20 : 12, contextOffset = group ? 12 : 8;
            return this.native(event.type, size, ptr => {
                Mem.writeUint32(ptr + 4, id);
                if (group) { Mem.writeUint32(ptr + 8, event.owner ?? 0); Mem.writeUint32(ptr + 16, this.session.contexts.get(event.owner ?? 0) ?? 0); }
                Mem.writeUint32(ptr + contextOffset, (group ? this.session.groupContexts : this.session.contexts).get(id) ?? context);
            }, (_hr, ptr) => { (group ? this.session.groupContexts : this.session.contexts).set(id, Mem.readUint32(ptr + contextOffset)!); });
        }
        if (event.type === 8 || event.type === 9) return this.native(event.type, 16, ptr => {
            Mem.writeUint32(ptr + 4, id); Mem.writeUint32(ptr + 8, context); Mem.writeUint32(ptr + 12, event.reason ?? 1);
        }, () => { (event.type === 8 ? this.session.groupContexts : this.session.contexts).delete(id); });
        if (event.type === 1 || event.type === 0x12) return this.native(event.type, 20, ptr => {
            [id, event.groupContext ?? 0, event.player ?? 0, event.playerContext ?? 0].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n));
        });
        if ([4, 0xc, 0xd, 0x10, 0x15].includes(event.type)) return this.native(event.type, 12, ptr => { Mem.writeUint32(ptr + 4, id); Mem.writeUint32(ptr + 8, context); });
        if (event.type === 0x16) {
            const data = event.data ?? new Uint8Array();
            return this.native(0x16, 16 + data.length, ptr => {
                Mem.writeUint32(ptr, 16); Mem.writeUint32(ptr + 4, event.result ?? DPN.CONNECTIONLOST);
                Mem.writeUint32(ptr + 8, data.length ? ptr + 16 : 0); Mem.writeUint32(ptr + 12, data.length); Mem.writeBytes(ptr + 16, data);
            });
        }
        if (event.type === 0x11) {
            const data = event.data ?? new Uint8Array(), handle = this.nextBuffer++ >>> 0 || this.nextBuffer++ >>> 0;
            if (this.reservedReceiveCount >= 4096 || this.reservedReceiveBytes + data.length > 16 * 1024 * 1024) return false;
            this.reservedReceiveCount++; this.reservedReceiveBytes += data.length; let released = false;
            const release = () => { if (!released) { released = true; this.reservedReceiveCount--; this.reservedReceiveBytes -= data.length; } };
            const queued = this.native(0x11, 28 + data.length, ptr => {
                Mem.writeUint32(ptr, 28);
                [id, context, ptr + 28, data.length, handle, event.flags ?? 0].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n));
                Mem.writeBytes(ptr + 28, data); this.buffers.set(handle, { pointer: ptr, size: data.length, active: true, returned: false, release });
            }, (hr, ptr) => {
                const buffer = this.buffers.get(handle);
                if (!buffer) return;
                buffer.active = false;
                // NT5 acknowledges COMPLETEONPROCESS after the handler returns,
                // including PENDING; ReturnBuffer controls storage lifetime separately.
                event.processed?.();
                if (hr === DPN.PENDING && !buffer.returned && !this.closed) return true;
                this.buffers.delete(handle); release();
            }, () => { this.buffers.delete(handle); release(); });
            if (!queued) release(); return queued;
        }
        return false;
    }
    query(request: { address: import("../dplayx/session").Address; data: Uint8Array }): Promise<JoinDecision> {
        return new Promise(resolve => {
            let sender = 0, device = 0, resolved = false;
            const done = (result: JoinDecision) => { if (!resolved) { resolved = true; resolve(result); } };
            const release = () => { for (const pointer of [sender, device]) if (pointer) SystemResourceProvider.getInstance().getComObjectByAddress(pointer)?.release(); sender = device = 0; };
            const queued = this.native(0xa, 36 + request.data.length, ptr => {
                const remote = new DirectPlayAddress(), local = new DirectPlayAddress();
                remote.buildHost(Array.from(nodeToIpv4(new Uint8Array(request.address.node))).join("."), request.address.port);
                local.buildHost(Array.from(this.session.network.ipv4).join("."), this.session.engine.localAddress.port);
                sender = this.addresses.create(remote); device = this.addresses.create(local);
                Mem.writeUint32(ptr, 36); Mem.writeUint32(ptr + 4, sender); Mem.writeUint32(ptr + 8, device);
                Mem.writeUint32(ptr + 12, request.data.length ? ptr + 36 : 0); Mem.writeUint32(ptr + 16, request.data.length);
                Mem.writeUint32(ptr + 20, 1024); Mem.writeBytes(ptr + 36, request.data);
            }, (hr, ptr) => {
                const data = Mem.readUint32(ptr + 24)!, size = Mem.readUint32(ptr + 28)!, context = Mem.readUint32(ptr + 32)!;
                const valid = size <= 1024 && (!size || this.guest.valid(data, size));
                const reply = size && valid ? Mem.readBytes(data, size)!.slice() : new Uint8Array();
                release(); done({ hr: !valid || (hr & 0x80000000) ? DPN.GENERIC : DPN.OK, data: reply });
                if (data) this.native(0x13, 16, out => { Mem.writeUint32(out + 8, data); Mem.writeUint32(out + 12, context); });
            }, () => { release(); done({ hr: DPN.GENERIC }); });
            if (!queued) done({ hr: DPN.GENERIC });
        });
    }
    indicate(request: JoinRequest): Promise<JoinDecision> {
        return new Promise(resolve => {
            let playerAddress = 0, deviceAddress = 0, finished = false;
            const finish = (decision: JoinDecision) => { if (!finished) { finished = true; resolve(decision); } };
            const releaseAddresses = () => {
                const resource = SystemResourceProvider.getInstance();
                for (const ptr of [playerAddress, deviceAddress]) if (ptr) resource.getComObjectByAddress(ptr)?.release();
                playerAddress = deviceAddress = 0;
            };
            const queued = this.native(0xe, 36 + request.data.length, ptr => {
                const remote = new DirectPlayAddress(), device = new DirectPlayAddress();
                remote.buildHost(Array.from(nodeToIpv4(new Uint8Array(request.address.node))).join("."), request.address.port);
                device.buildHost(Array.from(this.session.network.ipv4).join("."), this.session.engine.localAddress.port);
                playerAddress = this.addresses.create(remote); deviceAddress = this.addresses.create(device);
                Mem.writeUint32(ptr, 36); Mem.writeUint32(ptr + 4, request.data.length ? ptr + 36 : 0);
                Mem.writeUint32(ptr + 8, request.data.length); Mem.writeUint32(ptr + 28, playerAddress); Mem.writeUint32(ptr + 32, deviceAddress);
                Mem.writeBytes(ptr + 36, request.data);
            }, (hr, ptr) => {
                const reply = Mem.readUint32(ptr + 12)!, size = Mem.readUint32(ptr + 16)!, replyContext = Mem.readUint32(ptr + 20)!, context = Mem.readUint32(ptr + 24)!;
                const valid = size <= 60000 && (!size || this.guest.valid(reply, size)), data = valid && size ? Mem.readBytes(reply, size)!.slice() : new Uint8Array();
                releaseAddresses();
                finish({ hr: !valid || (hr & 0x80000000) ? DPN.HOSTREJECTEDCONNECTION : DPN.OK, data, context });
                if (reply) this.native(0x13, 16, out => { Mem.writeUint32(out + 4, 0); Mem.writeUint32(out + 8, reply); Mem.writeUint32(out + 12, replyContext); });
            }, () => { releaseAddresses(); finish({ hr: DPN.HOSTREJECTEDCONNECTION }); });
            if (!queued) finish({ hr: DPN.HOSTREJECTEDCONNECTION });
        });
    }
}
