import type { Process } from "../../core/process";
import { DirectPlayCallbackExecutor, type DirectPlayCallbackChannel, type DirectPlayCallbackTask, type DirectPlayCallbackReservation } from "./executor";
import { Mem } from "../../core/memory/mem-accessor";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { nodeToIpv4 } from "../../net/lan-network";
import { DirectPlayGuestMemory } from "./guest-memory";
import { DirectPlayAddress } from "./address";
import type { DirectPlayAddressApi } from "./address-api";
import type { DirectPlay8Session, DirectPlay8Event } from "./peer";
import type { JoinRequest, JoinDecision } from "../dplayx/session";
import { DPN } from "./constants";
import type { NativeHostJoin, NativeHostDecision } from "./native-wire/host";

interface ReceiveBuffer { pointer: number; size: number; active: boolean; returned: boolean; release(): void; }
export class DirectPlay8Callbacks {
    readonly queue: DirectPlayCallbackChannel;
    private waiting: DirectPlayCallbackTask[] = [];
    private waitingBytes = 0;
    private inlineReservation?: DirectPlayCallbackReservation;
    private inlineMessages?: readonly number[];
    private inlineKey?: object;
    private retry?: ReturnType<typeof setTimeout>;
    private closed = false;
    private closing = false;
    onSpace?: () => void;
    private buffers = new Map<number, ReceiveBuffer>();
    private nextBuffer = 1;
    private reservedReceiveCount = 0;
    private reservedReceiveBytes = 0;
    private nativeAdmissions = new Set<{ cancel(): void }>();
    private nativeTerminations = new Set<object>();
    private nativeAdmissionBytes = 0;
    private guest: DirectPlayGuestMemory;
    constructor(readonly process: Process, readonly session: DirectPlay8Session, readonly addresses: DirectPlayAddressApi,
        readonly routine: number, readonly userContext: number) {
        this.queue = DirectPlayCallbackExecutor.forProcess(process).channel();
        this.guest = new DirectPlayGuestMemory(process);
        session.onCancelNativeTermination = this.cancelNativeTerminations;
        this.queue.onSpace = () => { this.promote(); if (!this.closed) { this.onSpace?.(); this.session.resumeCallbacks(); } };
    }
    get pending(): number { return this.queue.size + this.waiting.length; }
    reserveNative(count: number, storageBytes: number): DirectPlayCallbackReservation | undefined {
        if (this.closed || this.waiting.length) return;
        return this.queue.executor.reserve(this.queue, count, storageBytes);
    }
    usingNative<T>(reservation: DirectPlayCallbackReservation, run: () => T, messages?: readonly number[]): T {
        const previous = this.inlineReservation, priorMessages = this.inlineMessages;
        this.inlineReservation = reservation; this.inlineMessages = messages;
        try { return run(); } finally { this.inlineReservation = previous; this.inlineMessages = priorMessages; }
    }
    /** Select only callbacks released by this synchronous owner continuation. */
    usingNativeKey<T>(key: object, run: () => T): T {
        const previous = this.inlineKey; this.inlineKey = key;
        try { return run(); } finally { this.inlineKey = previous; }
    }
    native(type: number, size: number, fill: (ptr: number) => void = () => {}, onReturn?: (hr: number, ptr: number) => boolean | void, onDiscard?: () => void, key?: object, reservation = this.inlineMessages && !this.inlineMessages.includes(type) ? undefined : this.inlineReservation): boolean {
        if (this.closed) return false;
        const task: DirectPlayCallbackTask = {
            storageBytes: size + 64, message: type, key: key ?? reservation ?? this.inlineKey,
            prepare: () => {
                const ptr = size ? this.process.memory.alloc(size) : 0;
                if (size && !ptr) { onDiscard?.(); throw new Error("DirectPlay callback allocation failed"); }
                try { if (size) { Mem.writeBytes(ptr, new Uint8Array(size)); Mem.writeUint32(ptr, size); fill(ptr); } }
                catch (error) { if (ptr) this.process.memory.free(ptr); onDiscard?.(); throw error; }
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
        if (reservation) return reservation.enqueue(task);
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
    private cancelNativeTerminations = (): void => {
        for (const key of [...this.nativeTerminations]) this.cancelNative(key);
    };
    beginClose(): void {
        this.closing = true;
        this.cancelNativeTerminations();
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
        if (this.session.onCancelNativeTermination === this.cancelNativeTerminations) this.session.onCancelNativeTermination = undefined;
        if (this.retry) clearTimeout(this.retry); this.retry = undefined;
        for (const admission of [...this.nativeAdmissions]) admission.cancel();
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
        const messages = this.inlineMessages, ownerKey = this.inlineKey;
        const reservation = messages && !messages.includes(event.type) ? undefined : this.inlineReservation;
        const processed = (result?: number) => {
            const run = () => ownerKey ? this.usingNativeKey(ownerKey, () => event.processed?.(result)) : event.processed?.(result);
            if (reservation) this.usingNative(reservation, run, messages);
            else run();
        };
        if (event.type === 2) return this.native(2, 0);
        if (event.type === 0xf) return this.native(0xf, 8, ptr => { Mem.writeUint32(ptr + 4, context); });
        if (event.type === 7 || event.type === 6) {
            const group = event.type === 6, size = group ? 20 : 12, contextOffset = group ? 12 : 8;
            return this.native(event.type, size, ptr => {
                Mem.writeUint32(ptr + 4, id);
                if (group) { Mem.writeUint32(ptr + 8, event.owner ?? 0); Mem.writeUint32(ptr + 16, this.session.contexts.get(event.owner ?? 0) ?? 0); }
                Mem.writeUint32(ptr + contextOffset, (group ? this.session.groupContexts : this.session.contexts).get(id) ?? context);
            }, (_hr, ptr) => {
                if (event.isCurrent?.() !== false)
                    (group ? this.session.groupContexts : this.session.contexts).set(id, Mem.readUint32(ptr + contextOffset)!);
                // CREATE_GROUP ignores the handler HRESULT; its context writeback precedes publication.
                processed();
            }, () => { processed(DPN.USERCANCEL); });
        }
        if (event.type === 8 || event.type === 9) return this.native(event.type, 16, ptr => {
            Mem.writeUint32(ptr + 4, id); Mem.writeUint32(ptr + 8, context); Mem.writeUint32(ptr + 12, event.reason ?? 1);
        }, () => {
            if (event.isCurrent?.() !== false) (event.type === 8 ? this.session.groupContexts : this.session.contexts).delete(id);
            processed();
        }, () => { processed(DPN.USERCANCEL); });
        if (event.type === 1 || event.type === 0x12) return this.native(event.type, 20, ptr => {
            [id, event.groupContext ?? 0, event.player ?? 0, event.playerContext ?? 0].forEach((n, i) => Mem.writeUint32(ptr + 4 + i * 4, n));
        }, () => processed(), () => processed(DPN.USERCANCEL));
        if ([4, 0xc, 0xd, 0x10, 0x15].includes(event.type)) return this.native(event.type, 12, ptr => { Mem.writeUint32(ptr + 4, id); Mem.writeUint32(ptr + 8, context); }, () => { processed(); }, () => { processed(DPN.USERCANCEL); });
        if (event.type === 0x16) {
            const data = event.data ?? new Uint8Array();
            const fill = (ptr: number) => {
                Mem.writeUint32(ptr, 16); Mem.writeUint32(ptr + 4, event.result ?? DPN.CONNECTIONLOST);
                Mem.writeUint32(ptr + 8, data.length ? ptr + 16 : 0); Mem.writeUint32(ptr + 12, data.length); Mem.writeBytes(ptr + 16, data);
            };
            if (!event.isCurrent) return this.native(0x16, 16 + data.length, fill);
            if (!event.isCurrent()) { processed(DPN.USERCANCEL); return true; }
            const key = {}; this.nativeTerminations.add(key);
            const completed = () => {
                this.nativeTerminations.delete(key);
                processed(event.isCurrent?.() === false ? DPN.USERCANCEL : DPN.OK);
            };
            const discarded = () => { this.nativeTerminations.delete(key); processed(DPN.USERCANCEL); };
            const accepted = this.native(0x16, 16 + data.length, fill, completed, discarded, key);
            if (!accepted) this.nativeTerminations.delete(key);
            return accepted;
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
                processed();
                if (hr === DPN.PENDING && !buffer.returned && !this.closed) return true;
                this.buffers.delete(handle); release();
            }, () => { this.buffers.delete(handle); release(); });
            if (!queued) release(); return queued;
        }
        return false;
    }
    cancelNativeOwner(key: object): void { this.cancelNative(key); }
    private cancelNative(key: object): void {
        const removed = this.waiting.filter(task => task.key === key);
        this.waiting = this.waiting.filter(task => task.key !== key);
        for (const task of removed) { this.waitingBytes -= task.storageBytes!; task.onDiscard?.(); }
        this.queue.cancelPending(task => task.key === key);
    }
    /** All guest outputs are copied at owner callback return; no RAM crosses a Promise. */
    indicateNative(request: NativeHostJoin): Promise<NativeHostDecision> {
        const input = request.info.connectData, info = request.info;
        const bytes = 64 + input.length + info.data.length + info.alternate.length + 2 * ((info.name?.length ?? 0) + (info.password?.length ?? 0) + (info.url?.length ?? 0));
        if (this.closed || this.closing || request.signal.aborted) return Promise.resolve({ hr: DPN.USERCANCEL });
        if (this.nativeAdmissions.size >= 16 || bytes > 4 * 1024 * 1024 - this.nativeAdmissionBytes) return Promise.resolve({ hr: DPN.TABLEFULL });
        return new Promise(resolve => {
            const epoch = this.process.resetGeneration, indication = {}, returned = {};
            let resolved = false, finished = false, prepared = false, reply = 0, replyContext = 0;
            let returnPromise: Promise<void> | undefined, settleReturn: (() => void) | undefined, rejectReturn: (() => void) | undefined;
            let retry: ReturnType<typeof setTimeout> | undefined;
            const objects: { release(): number }[] = [];
            const owner = () => !this.closed && epoch === this.process.resetGeneration;
            const releaseAddresses = () => { for (const object of objects.splice(0)) object.release(); };
            const finish = (decision: NativeHostDecision) => { if (!resolved) { resolved = true; resolve(decision); } };
            const cleanup = () => {
                if (finished) return; finished = true;
                if (retry) clearTimeout(retry); retry = undefined;
                request.signal.removeEventListener("abort", abort); releaseAddresses();
                if (this.nativeAdmissions.delete(admission)) this.nativeAdmissionBytes -= bytes;
            };
            const failReturn = () => { cleanup(); rejectReturn?.(); };
            const returnOnce = (): Promise<void> => {
                if (returnPromise) return returnPromise;
                returnPromise = new Promise<void>((done, reject) => { settleReturn = done; rejectReturn = () => reject(Error("Native reply callback discarded")); });
                if (!reply) { cleanup(); settleReturn!(); return returnPromise; }
                const enqueue = () => {
                    retry = undefined;
                    if (!owner()) { failReturn(); return; }
                    const queued = this.native(0x13, 16, ptr => {
                        Mem.writeUint32(ptr + 4, 0); Mem.writeUint32(ptr + 8, reply); Mem.writeUint32(ptr + 12, replyContext);
                    }, () => { cleanup(); settleReturn?.(); }, failReturn, returned);
                    if (!queued) { retry = setTimeout(enqueue, 4); (retry as unknown as { unref?(): void }).unref?.(); }
                };
                enqueue(); return returnPromise;
            };
            const abort = () => {
                if (!owner()) {
                    this.cancelNative(indication); this.cancelNative(returned); cleanup();
                    finish({ hr: DPN.USERCANCEL }); rejectReturn?.(); return;
                }
                if (!resolved) {
                    this.cancelNative(indication); finish({ hr: DPN.USERCANCEL });
                    if (!prepared) cleanup();
                } else { void returnOnce().catch(() => {}); }
            };
            const admission = { cancel: abort };
            this.nativeAdmissions.add(admission); this.nativeAdmissionBytes += bytes;
            request.signal.addEventListener("abort", abort, { once: true });
            const queued = this.native(0xe, 36 + input.length, ptr => {
                prepared = true; Mem.writeUint32(ptr, 36);
                const remote = new DirectPlayAddress(), device = new DirectPlayAddress();
                const local = this.session.engine.advertisedAddress ?? this.session.engine.localAddress;
                remote.buildHost(Array.from(nodeToIpv4(Uint8Array.from(request.address.node))).join("."), request.address.port);
                device.buildHost(Array.from(nodeToIpv4(Uint8Array.from(local.node))).join("."), local.port);
                const player = this.addresses.create(remote), localDevice = this.addresses.create(device);
                for (const pointer of [player, localDevice]) {
                    const object = SystemResourceProvider.getInstance().getComObjectByAddress(pointer);
                    if (object) objects.push(object);
                }
                if (!player || !localDevice) throw Error("Native admission address allocation failed");
                Mem.writeUint32(ptr + 4, input.length ? ptr + 36 : 0); Mem.writeUint32(ptr + 8, input.length);
                Mem.writeUint32(ptr + 28, player); Mem.writeUint32(ptr + 32, localDevice); Mem.writeBytes(ptr + 36, input);
            }, (hr, ptr) => {
                if (!owner()) { cleanup(); finish({ hr: DPN.USERCANCEL }); return; }
                try {
                    reply = Mem.readUint32(ptr + 12)!; const size = Mem.readUint32(ptr + 16)!;
                    replyContext = Mem.readUint32(ptr + 20)!; const context = Mem.readUint32(ptr + 24)!;
                    const valid = size <= 60000 && (!size || this.guest.valid(reply, size));
                    const data = valid && size ? Mem.readBytes(reply, size)!.slice() : new Uint8Array();
                    releaseAddresses();
                    const decision: NativeHostDecision = { hr: valid ? hr : DPN.HOSTREJECTEDCONNECTION, data, context,
                        returnBuffer: returnOnce, release: () => { void returnOnce().catch(() => {}); } };
                    if (request.signal.aborted || resolved) { void returnOnce().catch(() => {}); finish({ hr: DPN.USERCANCEL }); }
                    else { finish(decision); if (!reply) cleanup(); }
                } catch { cleanup(); finish({ hr: DPN.HOSTREJECTEDCONNECTION }); }
            }, () => { cleanup(); finish({ hr: DPN.USERCANCEL }); }, indication);
            if (!queued) { cleanup(); finish({ hr: DPN.TABLEFULL }); }
        });
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
