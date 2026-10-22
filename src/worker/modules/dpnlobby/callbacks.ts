import type { Process } from "../../core/process";
import { ModuleCallbackQueue } from "../../core/module-callback-queue";
import { Mem } from "../../core/memory/mem-accessor";
import { DPN } from "../dpnet/constants";
import type { DirectPlayAddressApi } from "../dpnet/address-api";
import { packSettings, releaseAddresses, settingsSize, type Lobby8Event } from "./structures";
export class Lobby8Callbacks {
    readonly queue: ModuleCallbackQueue;
    private closed = false;
    constructor(readonly process: Process, readonly addresses: DirectPlayAddressApi, readonly routine: number, readonly user: number,
        readonly contexts: Map<number, number>, readonly connected: (id: number, result: number) => void,
        readonly disconnected: (id: number) => void = () => {}) {
        this.queue = new ModuleCallbackQueue(process);
    }
    enqueue(event: Lobby8Event): boolean {
        if (this.closed) return false;
        return this.queue.enqueue({ prepare: () => {
            const header = event.type === 2 ? 24 : event.type === 1 ? 20 : 16;
            const extra = (event.settings ? settingsSize(event.settings) : 0) + (event.data?.length ?? 0);
            const pointer = this.process.memory.alloc(header + extra);
            if (!pointer) throw new Error("Lobby callback allocation failed");
            const addressPointers: number[] = [];
            let disposed = false;
            const free = () => {
                if (disposed) return; disposed = true;
                releaseAddresses(addressPointers, this.addresses); this.process.memory.free(pointer);
            };
            try {
                Mem.writeBytes(pointer, new Uint8Array(header + extra)); Mem.writeUint32(pointer, header);
                Mem.writeUint32(pointer + 4, event.connection);
                let tail = pointer + header;
                if (event.settings) {
                    const packed = packSettings(event.settings, tail, this.addresses); addressPointers.push(...packed.pointers);
                    Mem.writeBytes(tail, packed.bytes); Mem.writeUint32(pointer + 8, tail); tail += packed.bytes.length;
                }
                if (event.type === 1) {
                    Mem.writeUint32(pointer + 8, tail); Mem.writeUint32(pointer + 12, event.data?.length ?? 0);
                } else if (event.type === 2) {
                    Mem.writeUint32(pointer + 12, event.data?.length ? tail : 0); Mem.writeUint32(pointer + 16, event.data?.length ?? 0);
                } else if (event.type === 3) Mem.writeUint32(pointer + 8, event.result ?? DPN.CONNECTIONLOST);
                else if (event.type === 4) Mem.writeUint32(pointer + 8, event.status ?? 0);
                if (event.data) Mem.writeBytes(tail, event.data);
                const contextOffset = header - 4;
                Mem.writeUint32(pointer + contextOffset, this.contexts.get(event.connection) ?? 0);
                return { routine: this.routine, args: [this.user, 0x8000 | event.type, pointer],
                    onReturn: result => {
                        if (this.closed) { free(); return; }
                        if (event.type === 2) {
                            this.contexts.set(event.connection, Mem.readUint32(pointer + contextOffset)!);
                            this.connected(event.connection, result);
                        } else if (event.type === 3) { this.contexts.delete(event.connection); this.disconnected(event.connection); }
                        free();
                    }, onDiscard: () => { if (event.type === 2) this.connected(event.connection, DPN.CONNECTIONLOST); free(); } };
            } catch (error) { free(); if (event.type === 2) this.connected(event.connection, DPN.OUTOFMEMORY); throw error; }
        }, onDiscard: () => { if (event.type === 2) this.connected(event.connection, DPN.CONNECTIONLOST); } });
    }
    close(): void { this.closed = true; this.queue.close(); }
}
