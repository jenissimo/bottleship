import type { Process } from "../../core/process";
import { DPN } from "../dpnet/constants";
import { settingsStorage, type Lobby8Settings } from "./structures";
export interface LobbyPeerProvider {
    retain(pointer: number): (() => void) | null;
    post(pointer: number, connection: number, status: number, settings?: Lobby8Settings): number | Promise<number>;
}
const providers = new WeakMap<Process, LobbyPeerProvider>();
export function registerLobbyPeerProvider(process: Process, provider: LobbyPeerProvider): void { providers.set(process, provider); }
interface Update { status: number; settings?: Lobby8Settings; bytes: number; done(): void; }
/** Retained COM registration, with ordered, bounded, lossless settings/status publication. */
export class LobbyPeerRegistration {
    private queue: Update[] = [];
    private bytes = 0;
    private pumping = false;
    private stopped = false;
    private released = false;
    private idle: (() => void)[] = [];
    private space: (() => void)[] = [];
    private constructor(readonly pointer: number, readonly connection: number, private provider: LobbyPeerProvider, private drop: () => void) {}
    static create(process: Process, pointer: number, connection: number): LobbyPeerRegistration | null {
        const provider = providers.get(process), drop = provider?.retain(pointer);
        return provider && drop ? new LobbyPeerRegistration(pointer, connection, provider, drop) : null;
    }
    get pending(): number { return this.queue.length; }
    tryPublish(status: number, settings?: Lobby8Settings): boolean { return this.enqueue(status, settings, () => {}); }
    private enqueue(status: number, settings: Lobby8Settings | undefined, done: () => void): boolean {
        if (this.stopped) return false;
        const bytes = 32 + settingsStorage(settings);
        if (this.queue.length >= 64 || this.bytes + bytes > 4 * 1024 * 1024) return false;
        this.queue.push({ status, settings: settings ? structuredClone(settings) : undefined, bytes, done }); this.bytes += bytes;
        this.pump(); return true;
    }
    async publish(status: number, settings?: Lobby8Settings): Promise<void> {
        const bytes = 32 + settingsStorage(settings);
        // Native updates the status even if producing the optional settings snapshot fails.
        if (bytes > 4 * 1024 * 1024) settings = undefined;
        while (!this.stopped) {
            let complete!: () => void;
            const completed = new Promise<void>(resolve => { complete = resolve; });
            if (this.enqueue(status, settings, complete)) { await completed; return; }
            await new Promise<void>(resolve => { this.space.push(resolve); });
        }
    }
    private pump(): void {
        if (this.pumping || this.stopped) return;
        this.pumping = true;
        void (async () => {
            while (!this.stopped && this.queue.length) {
                const update = this.queue[0];
                let hr: number;
                try { hr = await this.provider.post(this.pointer, this.connection, update.status, update.settings); }
                catch { hr = DPN.CONNECTIONLOST; }
                if (this.stopped || this.queue[0] !== update) return;
                if (hr === DPN.TABLEFULL) { await new Promise(resolve => setTimeout(resolve, 4)); continue; }
                this.queue.shift(); this.bytes -= update.bytes; update.done();
                for (const wake of this.space.splice(0)) wake();
            }
        })().finally(() => {
            this.pumping = false;
            if (!this.queue.length || this.stopped) for (const wake of this.idle.splice(0)) wake();
            else this.pump();
        });
    }
    flush(): Promise<void> { return !this.queue.length || this.stopped ? Promise.resolve() : new Promise(resolve => { this.idle.push(resolve); }); }
    release(): void {
        if (this.released) return; this.released = true; this.stopped = true;
        for (const update of this.queue) update.done();
        this.queue = []; this.bytes = 0;
        for (const wake of [...this.idle.splice(0), ...this.space.splice(0)]) wake();
        this.drop();
    }
}
