import type { Address, Entity, Message, Reply, SessionDesc } from "../dplayx/session";

export type DirectPlay8Message = Message & { processed?: () => void };
export type NativeGroupState = "live" | "disconnecting" | "deleted" | "missing";
/** Owner created before Client handshake completion; only the actual notification return releases its receives. */
export interface DirectPlay8ConnectCompletionLease {
    readonly entered: boolean;
    enter(): void;
    current(): boolean;
    complete(): void;
    cancel(result?: number): void;
}
export interface DirectPlay8NativeTerminationLease {
    current(): boolean;
    returned(): number;
    cancel(): void;
}
export interface DirectPlay8HostRequest {
    localPort: number; bindingGeneration: number; localAddress: Address; signal: AbortSignal;
}
/** Created only after the provider has acknowledged its actual listening binding. */
export interface DirectPlay8HostReady {
    address: Address;
    isLive?(): boolean;
    closed?: Promise<{ code: number; message: string }>;
    allowIncoming(address: Address): boolean;
    url(address: Address): string;
    release(): void;
}
export interface DirectPlay8HostProvider { prepare(request: DirectPlay8HostRequest): Promise<DirectPlay8HostReady>; }
export type DirectPlay8NativeSend = (to: number, flags: number, data: Uint8Array, signal?: AbortSignal,
    acceptedLocal?: () => void, completedLocal?: (result: number) => void) => number | Promise<number>;

/** Shared DP8 session state. Provider discovery and host admission belong to their provider. */
export interface DirectPlay8Backend {
    readonly kind?: "native";
    readonly advertisedAddress?: Address;
    readonly pendingLocalProcessing?: number;
    connectCompletionLease?(): DirectPlay8ConnectCompletionLease | undefined;
    beginNativeTermination?(data: Uint8Array): number | DirectPlay8NativeTerminationLease;
    sendDpn?: DirectPlay8NativeSend;
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
    onInfo?: (id: number, returned: (result?: number) => void, notify?: boolean) => void;
    onPlayerCreated?: (id: number, returned: (result?: number) => void) => void;
    onGroupCreated?: (id: number, returned: (result?: number) => void, context?: number) => void;
    onGroupDestroyed?: (id: number, returned: (result?: number) => void) => void;
    onGroupMember?: (group: number, player: number, add: boolean, returned: (result?: number) => void) => void;
    queryGroup?(id: number): Entity | undefined;
    groupState?(id: number): NativeGroupState;
    onChange?: () => void;
    onTermination?: (data: Uint8Array, reason?: number) => void;
    onLocalTermination?: (reason: number) => void;
    onNativeTermination?: (data: Uint8Array, reason: number, returned: (result?: number) => void) => void;
    onPlayerDestroyReason?: (id: number, reason: number) => void;
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
