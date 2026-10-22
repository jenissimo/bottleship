import type { Address, Entity, Message, Reply, SessionDesc } from "../dplayx/session";

export type DirectPlay8Message = Message & { processed?: () => void };

/** Shared DP8 session state. Provider discovery and host admission belong to their provider. */
export interface DirectPlay8Backend {
    readonly kind?: "native";
    readonly entities: Map<number, Entity>;
    readonly queue: DirectPlay8Message[];
    readonly localAddress: Address;
    readonly hostAddress: Address | null;
    readonly ownKey: string;
    readonly currentPlayers: number;
    readonly isHost: boolean;
    readonly openError: number;
    readonly lost: boolean;
    readonly desc: SessionDesc | null;
    readonly joinReply: Reply | null;
    onMessage?: (id: number) => void;
    onChange?: () => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    playerAddress(id: number): Address | null;
    removeMessage(index: number): void;
    send(from: number, to: number, flags: number, data: Uint8Array): number | Promise<number>;
    mutate(change: Record<string, unknown> & { op: string }): Reply | Promise<Reply>;
    kick(id: number, data: Uint8Array): number;
    terminate(data: Uint8Array, reason?: number): number;
    shutdown?(): Promise<number>;
    close(): number;
    dispose(): void;
}
